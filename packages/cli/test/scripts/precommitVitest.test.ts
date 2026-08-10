import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PRECOMMIT_SCRIPT = path.join(REPO_ROOT, "scripts", "precommit-vitest.sh");

type Route = { mode: "policy" | "targeted" | "reused"; policy?: string; targets: string[] };

function runPrecommitVitestWithEnvironment(environment: NodeJS.ProcessEnv, ...stagedPaths: string[]): Route {
  const result = spawnSync("bash", [PRECOMMIT_SCRIPT, ...stagedPaths], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENTERA_PRECOMMIT_SOURCE_CANDIDATE_DIR: "",
      ...environment,
      PRECOMMIT_VITEST_PRINT_ROUTE: "1",
      PRECOMMIT_VITEST_PRINT_TARGETS: "1",
    },
    encoding: "utf8",
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  const [route, ...targetLines] = result.stdout.trim().split("\n");
  const targets = targetLines.map((line) => line.replace(/^target /, ""));
  if (route.startsWith("run_policy ")) return { mode: "policy", policy: route.slice(11), targets };
  if (route === "run_targeted") return { mode: "targeted", targets };
  if (route === "reuse_source_receipt") return { mode: "reused", targets };
  throw new Error(`unexpected route: ${result.stdout.trim()}`);
}

function runPrecommitVitest(...stagedPaths: string[]): Route {
  return runPrecommitVitestWithEnvironment({}, ...stagedPaths);
}

function gitOutput(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function runReceiptRoute(candidateDirectory: string, checkStatus: number): { route: Route; calls: string[] } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-receipt-route-"));
  const binDir = path.join(tempDir, "bin");
  const callsFile = path.join(tempDir, "calls");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "node"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${2:-}" == route ]]; then
  printf 'release\n'
  exit 0
fi
if [[ "\${2:-}" == source-check ]]; then
  printf 'source-check\n' >> "$PRECOMMIT_RECEIPT_CALLS"
  exit "$PRECOMMIT_RECEIPT_STATUS"
fi
exit 1
`);
  fs.chmodSync(path.join(binDir, "node"), 0o755);
  try {
    const route = runPrecommitVitestWithEnvironment({
      PATH: `${binDir}:${process.env.PATH}`,
      BASH_ENV: "",
      AGENTERA_PRECOMMIT_SOURCE_CANDIDATE_DIR: candidateDirectory,
      PRECOMMIT_RECEIPT_CALLS: callsFile,
      PRECOMMIT_RECEIPT_STATUS: String(checkStatus),
    }, "packages/cli/package.json");
    return {
      route,
      calls: fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n") : [],
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function normalizeLocalGitConfig(config: string): string {
  return config
    .split("\n")
    .filter((line) => {
      const separator = line.indexOf("=");
      return separator === -1 || !/^worktrunk\.state\..+\.marker$/.test(line.slice(0, separator));
    })
    .join("\n");
}

describe("scripts/precommit-vitest.sh staged routing", () => {
  it("ignores only complete volatile Worktrunk marker records", () => {
    const visibleConfig = [
      "user.name=Test User",
      "core.bare=false",
      "worktrunk.state.feat/test.vars={}",
      "worktrunk.state.feat/test.vars=payload.marker=changed",
      "worktrunk.state.feat/test.marker-extra=keep",
      "worktrunk.state..marker=keep",
      "xworktrunk.state.feat/test.marker=keep",
    ].join("\n");

    expect(normalizeLocalGitConfig([
      visibleConfig,
      'worktrunk.state.feat/test.marker={"marker":"🤖","set_at":100,"status":"active"}',
    ].join("\n"))).toBe(visibleConfig);
    expect(normalizeLocalGitConfig([
      'worktrunk.state.feat/test.marker={"marker":"💬","set_at":200,"status":"idle"}',
      visibleConfig,
    ].join("\n"))).toBe(visibleConfig);
    expect(normalizeLocalGitConfig(visibleConfig)).toBe(visibleConfig);
  });

  it("removes parent-hook repository routing before verification", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-vitest-"));
    const binDir = path.join(tempDir, "bin");
    const envLog = path.join(tempDir, "verification-env");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "node"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$2" == route ]]; then
  printf 'local\\n'
  exit 0
fi
[[ "$2" == policy ]]
for name in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR; do
  if [[ -v "$name" ]]; then
    printf '%s=present\\n' "$name"
  else
    printf '%s=absent\\n' "$name"
  fi
done > "$PRECOMMIT_VITEST_ENV_LOG"
`);
    fs.chmodSync(path.join(binDir, "node"), 0o755);

    try {
      const result = spawnSync("bash", [PRECOMMIT_SCRIPT, "packages/cli/src/cli/prime.ts"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GIT_DIR: gitOutput("rev-parse", "--git-dir"),
          GIT_WORK_TREE: REPO_ROOT,
          GIT_INDEX_FILE: gitOutput("rev-parse", "--git-path", "index"),
          GIT_COMMON_DIR: gitOutput("rev-parse", "--git-common-dir"),
          PATH: `${binDir}:${process.env.PATH}`,
          BASH_ENV: "",
          PRECOMMIT_VITEST_ENV_LOG: envLog,
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(envLog, "utf8")).toBe([
        "GIT_DIR=absent",
        "GIT_WORK_TREE=absent",
        "GIT_INDEX_FILE=absent",
        "GIT_COMMON_DIR=absent",
        "",
      ].join("\n"));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears hook-local Git environment before fixture repositories run", () => {
    const before = {
      head: gitOutput("rev-parse", "HEAD"),
      localConfig: normalizeLocalGitConfig(gitOutput("config", "--local", "--list")),
    };
    const result = spawnSync(
      "bash",
      [PRECOMMIT_SCRIPT, "packages/cli/test/upgrade/upgradeOrchestrator.test.ts"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          GIT_DIR: gitOutput("rev-parse", "--absolute-git-dir"),
          GIT_COMMON_DIR: path.resolve(REPO_ROOT, gitOutput("rev-parse", "--git-common-dir")),
          GIT_INDEX_FILE: gitOutput("rev-parse", "--git-path", "index"),
          GIT_WORK_TREE: REPO_ROOT,
        },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect({
      head: gitOutput("rev-parse", "HEAD"),
      localConfig: normalizeLocalGitConfig(gitOutput("config", "--local", "--list")),
    }).toEqual(before);
  }, 60_000);
  it("routes broad source changes through the local source-owner policy", () => {
    expect(runPrecommitVitest("packages/cli/src/cli/prime.ts")).toEqual({
      mode: "policy", policy: "local", targets: [],
    });
  });

  it.each([
    "packages/cli/package.json",
    "packages/cli/vite.config.ts",
    "packages/cli/vite.package.config.ts",
    "packages/cli/vitest.shared.ts",
    "packages/cli/scripts/verify-lane.mjs",
    "packages/cli/scripts/generated-output.mjs",
    "packages/cli/scripts/build-package.mjs",
    "packages/cli/scripts/verify-generated-overlap.mjs",
    "packages/cli/test/sourceSetup.ts",
    "packages/cli/test/helpers/runtimeBootstrapMatrix.ts",
    "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs",
    "packages/cli/test/helpers/runtimeProofCliBoundary.mjs",
    "packages/cli/test/integration/runtimeBootstrapMatrix.test.ts",
    "packages/cli/test/integration/sourcePackageParity.test.ts",
    "packages/cli/test/packaging/packageSetup.ts",
    "packages/cli/test/packaging/packageVerification.test.ts",
    "packages/cli/test/packaging/copyBundleSafety.test.ts",
    "scripts/precommit-vitest.sh",
  ])("routes lane-defining surface %s conservatively", (surface) => {
    expect(runPrecommitVitest(surface)).toEqual({
      mode: "policy", policy: "release", targets: [],
    });
  });

  it("keeps all runtime-matrix helper changes on the release route together", () => {
    expect(runPrecommitVitest(
      "packages/cli/test/helpers/runtimeBootstrapMatrix.ts",
      "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs",
      "packages/cli/test/helpers/runtimeProofCliBoundary.mjs",
    )).toEqual({ mode: "policy", policy: "release", targets: [] });
  });

  it("does not broaden unrelated test helpers to the release route", () => {
    expect(runPrecommitVitest("packages/cli/test/helpers/entityAuthorityFixture.ts")).toEqual({
      mode: "policy", policy: "local", targets: [],
    });
  });

  it("reuses explicitly supplied source evidence only after the read-only check passes", () => {
    expect(runReceiptRoute("/external/candidate", 0)).toEqual({
      route: { mode: "reused", targets: [] },
      calls: ["source-check"],
    });
  });

  it("falls back to the release policy when an explicit receipt is missing or invalid", () => {
    expect(runReceiptRoute("/external/missing", 1)).toEqual({
      route: { mode: "policy", policy: "release", targets: [] },
      calls: ["source-check"],
    });
  });

  it("preserves release routing and does not check receipts when the opt-in environment is absent", () => {
    expect(runReceiptRoute("", 0)).toEqual({
      route: { mode: "policy", policy: "release", targets: [] },
      calls: [],
    });
  });

  it("declares every non-TypeScript lane surface in the lefthook test glob", () => {
    const lefthook = fs.readFileSync(path.join(REPO_ROOT, ".lefthook.yml"), "utf8");
    for (const surface of [
      "packages/cli/package.json",
      "packages/cli/scripts/*.mjs",
      "packages/cli/test/packaging/**",
      "scripts/precommit-vitest.sh",
    ]) expect(lefthook, surface).toContain(`- \"${surface}\"`);
  });

  it("routes central contracts and schemas through every owner", () => {
    for (const path of ["skills/agentera/SKILL.md", "references/artifacts/state-storage-authority.yaml", ".github/workflows/verify.yml"]) {
      expect(runPrecommitVitest(path)).toEqual({ mode: "policy", policy: "release", targets: [] });
    }
  });

  it.each([
    ["references/analysis/verification-policy.yaml", "packages/cli/src/cli/prime.ts"],
    ["packages/cli/src/cli/prime.ts", "references/analysis/verification-policy.yaml"],
    ["references/analysis/verification-policy.yaml", "references/analysis/verification-policy.yaml", "packages/cli/src/cli/prime.ts"],
    ["packages/cli/test/cli/help.test.ts", "references/analysis/verification-policy.yaml"],
  ])("keeps release routing monotonic for mixed staged paths: %s", (...paths) => {
    expect(runPrecommitVitest(...paths)).toEqual({ mode: "policy", policy: "release", targets: [] });
  });

  it.each([
    ["packages/cli/src/cli/prime.ts", "packages/cli/test/cli/help.test.ts"],
    ["packages/cli/test/cli/help.test.ts", "packages/cli/src/cli/prime.ts"],
  ])("does not retain targeted filters after local policy wins: %s", (...paths) => {
    expect(runPrecommitVitest(...paths)).toEqual({ mode: "policy", policy: "local", targets: [] });
  });

  it("deduplicates filters when targeted routing remains valid", () => {
    expect(runPrecommitVitest(
      "packages/cli/test/cli/help.test.ts",
      "packages/cli/test/cli/help.test.ts",
      "packages/cli/test/cli/schema.test.ts",
    )).toEqual({
      mode: "targeted",
      targets: ["test/cli/help.test.ts", "test/cli/schema.test.ts"],
    });
  });

  it.each([
    ["invalid-input-envelope.json", ["test/cli/invalidInputEnvelope.test.ts"]],
    ["npm-cli-surface.json", ["test/cli/npmParityMatrix.test.ts"]],
    ["parity-remaining-families.json", [
      "test/cli/npmParityMatrix.test.ts",
      "test/cli/validateParity.test.ts",
      "test/cli/compactParity.test.ts",
      "test/cli/doctorUpgradeParity.test.ts",
      "test/scripts/pyTsParity.test.ts",
    ]],
    ["source-contract.json", ["test/cli/sourceContractOracles.test.ts"]],
    ["validate-family.json", ["test/cli/validateVerifyOracles.test.ts", "test/cli/validateParity.test.ts"]],
    ["verify-eval-family.json", ["test/cli/validateVerifyOracles.test.ts"]],
    ["inspektera-evaluation-report.json", ["test/registries/evaluatorHandoffContract.test.ts"]],
  ] as const)("routes oracle %s to its owners", (fixture, targets) => {
    expect(runPrecommitVitest(`packages/cli/test/cli/fixtures/oracle/${fixture}`)).toEqual({
      mode: "targeted",
      targets: [...targets],
    });
  });

  it("falls back to targeted smoke tests for unrelated staged paths", () => {
    expect(runPrecommitVitest("README.md")).toEqual({
      mode: "targeted",
      targets: ["test/registries/evaluatorHandoffContract.test.ts"],
    });
  });
});
