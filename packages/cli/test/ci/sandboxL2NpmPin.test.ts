// The exact-version L2 scenario is a candidate barrier, not an ordinary push effect.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = fs.readFileSync(
  path.join(REPO_ROOT, ".github/workflows/publish-qualified-candidate.yml"),
  "utf8",
);
const benchmark = fs.readFileSync(
  path.join(REPO_ROOT, "packages/cli/scripts/release-benchmark.mjs"),
  "utf8",
);
const harness = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/sandbox/v2v3-upgrade-harness.sh"),
  "utf8",
);
const assertions = fs.readFileSync(
  path.join(REPO_ROOT, "scripts/sandbox/assert-v2v3-migration.sh"),
  "utf8",
);
const scannerPath = path.join(REPO_ROOT, "scripts/sandbox/scan-python-leftovers.sh");

describe("candidate L2 npm pin contract", () => {
  it("derives the exact package pin only after staging", () => {
    expect(workflow).not.toMatch(/AGENTERA_NPM_PIN:\s*agentera@/);
    expect(benchmark).toContain("AGENTERA_NPM_PIN: `${candidate.package}@${candidate.version}`");
    expect(benchmark).toMatch(/transaction\("stage", "stage"\),\s+exactVersionL2,\s+transaction\("promote", "promote"\)/);
  });

  it("keeps the public tag unchanged until exact-version L2 succeeds", () => {
    expect(workflow).toContain("release-benchmark.mjs publication");
    expect(benchmark).toContain("AGENTERA_SANDBOX_TIER: \"L2\"");
    expect(workflow).toContain("candidate_receipt_sha256");
    expect(workflow).toContain("environment: npm-publish");
  });

  it("gives L2 npx sandbox-owned user and global npm configuration", () => {
    expect(benchmark).toContain('isolatedNpmState("agentera-qualified-l2-"');
    expect(benchmark).toContain("registryInGlobalConfig: true");
    expect(harness).toContain('NPM_CONFIG_USERCONFIG="$SANDBOX/npm-user.npmrc"');
    expect(harness).toContain('NPM_CONFIG_GLOBALCONFIG="$SANDBOX/npm-global.npmrc"');
    expect(harness).toContain("unset NPM_TOKEN NODE_AUTH_TOKEN");
    expect(harness.match(/registry=https:\/\/registry\.npmjs\.org\//g)).toHaveLength(2);
  });

  it("tracks the copied v2 source and keeps every L2 assertion on the exact npm package", () => {
    expect(harness).toContain('git -C "$PROJECT" init -q');
    expect(harness).toContain("-c commit.gpgsign=false");
    expect(harness).toMatch(/if \[\[ "\$TIER" == "L2" \]\]; then\s+unset AGENTERA_BOOTSTRAP_SOURCE_ROOT/);
    expect(assertions).toContain('PIN="${AGENTERA_NPM_PIN:?L2 assertions require AGENTERA_NPM_PIN}"');
    expect(assertions).toContain('CLI=(npx -y "$PIN")');
    expect(assertions).toContain('env -i "${prime_env[@]}" "${CLI[@]}" prime --format json');
    expect(assertions).toContain('"${CLI[@]}" report profile-grounding --format json');
    expect(assertions).toContain("unset AGENTERA_BOOTSTRAP_SOURCE_ROOT");
  });

  it("ignores canonical retirement authorities but still rejects user-owned Python leftovers", () => {
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
});
