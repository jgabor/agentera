import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PRECOMMIT_SCRIPT = path.join(REPO_ROOT, "scripts", "precommit-vitest.sh");

type Route = { mode: "policy" | "targeted"; policy?: string; targets: string[] };

function runPrecommitVitest(...stagedPaths: string[]): Route {
  const result = spawnSync("bash", [PRECOMMIT_SCRIPT, ...stagedPaths], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
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
  throw new Error(`unexpected route: ${result.stdout.trim()}`);
}

function gitOutput(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
describe("scripts/precommit-vitest.sh staged routing", () => {
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
      localConfig: gitOutput("config", "--local", "--list"),
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
      localConfig: gitOutput("config", "--local", "--list"),
    }).toEqual(before);
  });
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
    "packages/cli/test/packaging/packageSetup.ts",
    "packages/cli/test/packaging/packageVerification.test.ts",
    "packages/cli/test/packaging/copyBundleSafety.test.ts",
    "scripts/precommit-vitest.sh",
  ])("routes lane-defining surface %s conservatively", (surface) => {
    expect(runPrecommitVitest(surface)).toEqual({
      mode: "policy", policy: "release", targets: [],
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

  it("falls back to targeted smoke tests for unrelated staged paths", () => {
    expect(runPrecommitVitest("README.md")).toEqual({
      mode: "targeted",
      targets: [
        "test/registries/evaluatorHandoffContract.test.ts",
        "test/cli/inspekteraEvaluationReport.test.ts",
      ],
    });
  });
});
