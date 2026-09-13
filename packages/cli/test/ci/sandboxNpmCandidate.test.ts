// The staged package migration smoke is a package barrier, not an ordinary push effect.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requireShellTools } from "../helpers/shellCommand.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const benchmark = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/scripts/release-benchmark.mjs"), "utf8");
const harness = fs.readFileSync(path.join(REPO_ROOT, "scripts/sandbox/v2v3-upgrade-harness.sh"), "utf8");
const assertions = fs.readFileSync(path.join(REPO_ROOT, "scripts/sandbox/assert-v2v3-migration.sh"), "utf8");
const scannerPath = path.join(REPO_ROOT, "scripts/sandbox/scan-python-leftovers.sh");

describe("staged package migration contract", () => {
  it.each(["grep", "head", "mkdir", "cp", "rm", "find"])("names unavailable %s only when its shell fixture requires it", (tool) => {
    expect(() => requireShellTools([tool], { PATH: "" })).toThrow(`Shell fixture requires ${tool} on PATH`);
  });

  it.each(["grep", "find"])("does not report a clean scan when %s is unavailable", (missing) => {
    requireShellTools(["bash", "grep", "find"]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-scan-prerequisite-"));
    try {
      const bin = path.join(root, "bin");
      fs.mkdirSync(bin);
      const available = missing === "grep" ? "find" : "grep";
      const located = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "fixture", available], {
        encoding: "utf8",
      });
      expect(located.status, located.stderr).toBe(0);
      fs.symlinkSync(located.stdout.trim(), path.join(bin, available));
      const result = spawnSync("/bin/bash", [scannerPath, root], {
        encoding: "utf8",
        env: { PATH: bin },
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(`required tool unavailable on PATH: ${missing}`);
      expect(result.stdout).not.toContain("scan-python-leftovers: ok");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the exact package pin only after staging", () => {
    expect(benchmark).toContain("AGENTERA_NPM_PIN: `${candidate.package}@${candidate.version}`");
    expect(benchmark).toMatch(/const candidateMigrationSmoke\s*=\s*adapterName === "development"/);
    expect(benchmark).toContain("candidateMigrationSmoke,");
  });

  it("keeps the staged package migration smoke in the publication coordinator", () => {
    expect(benchmark).toContain('AGENTERA_SANDBOX_TIER: "L2"');
    expect(benchmark).toContain("candidateMigrationSmoke");
  });

  it("gives the npm candidate npx smoke sandbox-owned user and global npm configuration", () => {
    expect(benchmark).toContain('isolatedNpmState("agentera-qualified-candidate-"');
    expect(benchmark).toContain("registryInGlobalConfig: true");
    expect(harness).toContain('NPM_CONFIG_USERCONFIG="$SANDBOX/npm-user.npmrc"');
    expect(harness).toContain('NPM_CONFIG_GLOBALCONFIG="$SANDBOX/npm-global.npmrc"');
    expect(harness).toContain("unset NPM_TOKEN NODE_AUTH_TOKEN");
    expect(harness.match(/registry=https:\/\/registry\.npmjs\.org\//g)).toHaveLength(2);
  });

  it("tracks the copied v2 source and keeps every npm candidate assertion on the exact package", () => {
    expect(harness).toContain('git -C "$PROJECT" init -q');
    expect(harness).toContain("-c commit.gpgsign=false");
    expect(harness).toMatch(/if \[\[ "\$TIER" == "L2" \]\]; then\s+unset AGENTERA_BOOTSTRAP_SOURCE_ROOT/);
    expect(assertions).toContain('PIN="${AGENTERA_NPM_PIN:?npm package assertions require AGENTERA_NPM_PIN}"');
    expect(assertions).toContain('CLI=(npx -y "$PIN")');
    expect(assertions).toContain('env -i "${prime_env[@]}" "${CLI[@]}" prime');
    expect(assertions).toContain('"${CLI[@]}" report profile-grounding');
    expect(assertions).toContain("unset AGENTERA_BOOTSTRAP_SOURCE_ROOT");
  });

  it("expects source-build execution for source migration and npm-package execution for staged package migration", () => {
    expect(assertions).toContain('expected_install_track="source"');
    expect(assertions).toMatch(/if \[\[ "\$TIER" == "L2" \]\]; then\s+expected_install_track="v3"/);
    expect(assertions).toContain('app_home.get("install_track") != expected_install_track');
  });

  it("distinguishes successful migration from expected refusal and does not skip noisy postchecks", () => {
    expect(assertions).toContain("apply.get('phase') == 'complete' and apply.get('status') == 'success'");
    expect(assertions).toContain("apply.get('startup_validation', {}).get('status') == 'passed'");
    expect(assertions).toContain("apply.get('state_validation', {}).get('status') == 'passed'");
    expect(assertions).toContain("check('expected_apply_failure'");
    expect(assertions).toContain("check('foreign_noise_present_and_preserved'");
    expect(harness).toContain('if [[ "$SCENARIO" != "partial-only-runtime" ]]; then');
    expect(harness).toContain("apply_rc=skipped");
    expect(harness).not.toContain('overall="pass"');
    expect(harness).toContain('"$SCRIPT_DIR/assert-v2v3-migration.sh" "$SANDBOX" "$SCENARIO" || overall=fail');
    expect(assertions).toContain("observations['startup'] = {key: startup[key] for key in ('outcome', 'state_cutover')}");
  });

  it("ignores canonical retirement authorities but still rejects user-owned Python leftovers", () => {
    requireShellTools(["bash", "grep", "find"]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-leftover-scan-"));
    const authority = path.join(root, "home/.local/share/agentera/references/adapters/runtime-retired-resources.yaml");
    const runtime = path.join(root, "home/.config/opencode/runtime.yaml");
    fs.mkdirSync(path.dirname(authority), { recursive: true });
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(authority, "retired: validate_artifact.py\n");
    fs.writeFileSync(runtime, "command: validate_artifact.py\n");
    try {
      const rejected = spawnSync("bash", [scannerPath, root], { encoding: "utf8" });
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toContain(runtime);
      expect(rejected.stdout).not.toContain(authority);
      fs.rmSync(runtime);
      const accepted = spawnSync("bash", [scannerPath, root], { encoding: "utf8" });
      expect(accepted.status, accepted.stderr || accepted.stdout).toBe(0);
      expect(accepted.stdout).toContain("scan-python-leftovers: ok");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes unowned shared Codex registration only from the clean fixture, retaining copied hooks", () => {
    requireShellTools(["bash", "dirname", "mkdir", "cp", "rm"]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-migration-seed-"));
    try {
      for (const scenario of ["happy-path-clean", "stable-safety", "codex-plugin-vs-copied", "partial-only-runtime"]) {
        const sandbox = path.join(root, scenario);
        const seeded = spawnSync("bash", [path.join(REPO_ROOT, "scripts/sandbox/seed-v2-fixture.sh"), sandbox, scenario], { encoding: "utf8", env: { ...process.env, REPO_ROOT } });
        expect(seeded.status, seeded.stderr).toBe(0);
        expect(fs.existsSync(path.join(sandbox, "home/.codex/config.toml"))).toBe(scenario !== "happy-path-clean");
        const fixture = scenario === "codex-plugin-vs-copied" ? "v2-runtime-codex-full" : "v2-runtime-python";
        expect(fs.readFileSync(path.join(sandbox, "home/.codex/hooks/codex-hooks.json"), "utf8")).toBe(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/test/upgrade/fixtures", fixture, ".codex/hooks/codex-hooks.json"), "utf8"));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["stable-safety", "partial-only-runtime"])("accepts only the expected %s refusal and unchanged files", (scenario) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-migration-assert-"));
    const stable = scenario === "stable-safety";
    const manifest = { "home/.codex/config.toml": "preserved-config-digest" };
    const preview = {
      lifecycleStatus: "manual_review_needed",
      channel: { channel: stable ? "stable" : "development" },
      crossMajorBoundary: true,
      phases: [
        {
          name: "entities",
          items: [{ action: stable ? "major-boundary" : "entity-cutover-required", status: "blocked" }],
        },
        {
          name: "runtime",
          status: "pending",
          summary: { pending: 1 },
          items: [{ action: "retire-hooks", status: "pending", runtime: "codex" }],
        },
      ],
    };
    const run = () => spawnSync("bash", [path.join(REPO_ROOT, "scripts/sandbox/assert-v2v3-migration.sh"), root, scenario], { encoding: "utf8", env: { ...process.env, REPO_ROOT, AGENTERA_SANDBOX_TIER: "L1" } });
    try {
      for (const label of ["before", "preview", "after"]) fs.writeFileSync(path.join(root, `manifest-${label}.json`), JSON.stringify(manifest));
      fs.writeFileSync(path.join(root, "preview.json"), JSON.stringify(preview));
      fs.writeFileSync(path.join(root, "exit-codes.json"), JSON.stringify({ preview: 1, apply: stable ? 1 : null }));
      fs.writeFileSync(path.join(root, "apply.json"), "");
      fs.writeFileSync(path.join(root, "apply.stderr"), "upgrade error: v2-to-v3 apply requires the development channel; preview there, then retry with --yes.\n");
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      fs.writeFileSync(path.join(root, "exit-codes.json"), JSON.stringify({ preview: 0, apply: stable ? 0 : null }));
      const wrongExit = run();
      expect(wrongExit.status).toBe(1);
      expect(wrongExit.stderr).toContain("preview_exit");
      fs.writeFileSync(path.join(root, "exit-codes.json"), JSON.stringify({ preview: 1, apply: stable ? 1 : null }));
      fs.writeFileSync(path.join(root, "manifest-after.json"), JSON.stringify({ ...manifest, "project/unauthorized": "mutation" }));
      const mutated = run();
      expect(mutated.status).toBe(1);
      expect(mutated.stderr).toContain(stable ? "no_mutation" : "preview_only");
      fs.writeFileSync(path.join(root, "manifest-after.json"), JSON.stringify(manifest));
      preview.phases[0].items[0].status = "noop";
      fs.writeFileSync(path.join(root, "preview.json"), JSON.stringify(preview));
      expect(run().status).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
