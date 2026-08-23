import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PRECOMMIT_SCRIPT = path.join(REPO_ROOT, "scripts", "precommit-vitest.sh");

type Route = {
  mode: "targeted" | "ci_owned";
  targets: string[];
  ciOwners: string[];
  workerLimit: number;
  budgetMs: number;
  typecheck: boolean;
};

function runPrecommitVitestWithEnvironment(environment: NodeJS.ProcessEnv, ...stagedPaths: string[]): Route {
  const result = spawnSync("bash", [PRECOMMIT_SCRIPT, ...stagedPaths], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...environment,
    },
    encoding: "utf8",
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  const lines = result.stdout.trim().split("\n");
  const route = lines[0];
  if (route !== "run_targeted" && route !== "run_ci_owned") {
    throw new Error(`unexpected route: ${result.stdout.trim()}`);
  }
  return {
    mode: route === "run_targeted" ? "targeted" : "ci_owned",
    targets: lines.filter((line) => line.startsWith("target ")).map((line) => line.slice(7)),
    ciOwners: lines.filter((line) => line.startsWith("ci_owner ")).map((line) => line.slice(9)),
    workerLimit: Number(lines.find((line) => line.startsWith("worker_limit "))?.slice(13)),
    budgetMs: Number(lines.find((line) => line.startsWith("budget_ms "))?.slice(10)),
    typecheck: lines.find((line) => line.startsWith("typecheck "))?.slice(10) === "true",
  };
}

function runPrecommitVitest(...stagedPaths: string[]): Route {
  return runPrecommitVitestWithEnvironment({}, "--print-route", "--print-targets", ...stagedPaths);
}

function targeted(...targets: string[]): Route {
  return { mode: "targeted", targets: targets.toSorted(), ciOwners: [], workerLimit: 2, budgetMs: 60_000, typecheck: true };
}

function ciOwned(ciOwners = ["source", "stress", "performance", "capacity", "package"]): Route {
  return {
    mode: "ci_owned",
    targets: ["test/release/routineCiOwnership.test.ts", "test/verification/laneOwnership.test.ts"],
    ciOwners,
    workerLimit: 2,
    budgetMs: 60_000,
    typecheck: true,
  };
}

function gitOutput(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
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
  printf 'precommit\\n'
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
    fs.writeFileSync(path.join(binDir, "pnpm"), "#!/usr/bin/env bash\nexit 0\n");
    fs.chmodSync(path.join(binDir, "pnpm"), 0o755);

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
  it("routes ordinary source changes to one deterministic source test with typecheck", () => {
    expect(runPrecommitVitest("packages/cli/src/cli/commands/prime.ts")).toEqual(
      targeted("test/cli/prime.test.ts"),
    );
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
    "packages/cli/test/state/todoDocsEntities.test.ts",
    "packages/cli/test/upgrade/upgradeEntityCutover.test.ts",
    "packages/cli/test/scripts/precommitVitest.test.ts",
    "packages/cli/test/helpers/runtimeBootstrapMatrix.ts",
    "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs",
    "packages/cli/test/helpers/preCutoverBootstrapMissingSurfaceDispatcher.mjs",
    "packages/cli/test/helpers/runtimeProofCliBoundary.mjs",
    "packages/cli/test/integration/runtimeBootstrapMatrix.test.ts",
    "packages/cli/test/packaging/packageSetup.ts",
    "scripts/precommit-vitest.sh",
  ])("routes lane-defining surface %s conservatively", (surface) => {
    expect(runPrecommitVitest(surface)).toEqual(ciOwned());
  });

  it.each([
    ["packages/cli/test/stress/entityStorageStress.test.ts", "stress"],
    ["packages/cli/test/performance/entityAuthorityPerformance.test.ts", "performance"],
    ["packages/cli/test/capacity/todoDocsEntitiesCapacity.test.ts", "capacity"],
    ["packages/cli/test/packaging/packageVerification.test.ts", "package"],
  ])("defers the specialized %s owner without running a local release lane", (surface, owner) => {
    expect(runPrecommitVitest(surface)).toEqual(ciOwned([owner]));
  });

  it("keeps all runtime-matrix helper changes on the CI-owned route together", () => {
    expect(runPrecommitVitest(
      "packages/cli/test/helpers/runtimeBootstrapMatrix.ts",
      "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs",
      "packages/cli/test/helpers/preCutoverBootstrapMissingSurfaceDispatcher.mjs",
      "packages/cli/test/helpers/runtimeProofCliBoundary.mjs",
    )).toEqual(ciOwned());
  });

  it("keeps unrelated test helpers on targeted source feedback", () => {
    expect(runPrecommitVitest("packages/cli/test/helpers/entityAuthorityFixture.ts")).toEqual(
      targeted("test/registries/evaluatorHandoffContract.test.ts"),
    );
  });

  it("declares every non-TypeScript lane surface in the lefthook test glob", () => {
    const lefthook = fs.readFileSync(path.join(REPO_ROOT, ".lefthook.yml"), "utf8");
    for (const surface of [
      "packages/cli/package.json",
      "packages/cli/scripts/*.mjs",
      "packages/cli/test/packaging/**",
      "scripts/precommit-vitest.sh",
    ]) expect(lefthook, surface).toContain(`- \"${surface}\"`);
    expect(lefthook).toContain("timeout --foreground 10s npx -y agentera@next check compact");
    expect(lefthook).toContain('- ".agentera/**"');
    expect(lefthook).toContain('- "TODO.md"');
    expect(lefthook).not.toContain("pnpm -C packages/cli build && node packages/cli/dist/bin/agentera.js check compact");
  });

  it("routes central contracts and schemas through every owner", () => {
    for (const path of ["skills/agentera/SKILL.md", "references/artifacts/state-storage-authority.yaml", ".github/workflows/verify.yml"]) {
      expect(runPrecommitVitest(path)).toEqual(ciOwned());
    }
  });

  it.each([
    ["references/analysis/verification-policy.yaml", "packages/cli/src/cli/commands/prime.ts"],
    ["packages/cli/src/cli/commands/prime.ts", "references/analysis/verification-policy.yaml"],
    ["references/analysis/verification-policy.yaml", "references/analysis/verification-policy.yaml", "packages/cli/src/cli/commands/prime.ts"],
    ["packages/cli/test/cli/help.test.ts", "references/analysis/verification-policy.yaml"],
  ])("keeps CI-owned routing monotonic for mixed staged paths: %s", (...paths) => {
    expect(runPrecommitVitest(...paths)).toEqual(ciOwned());
  });

  it.each([
    ["packages/cli/src/cli/commands/prime.ts", "packages/cli/test/cli/help.test.ts"],
    ["packages/cli/test/cli/help.test.ts", "packages/cli/src/cli/commands/prime.ts"],
  ])("retains deterministic targeted filters for mixed source paths: %s", (...paths) => {
    expect(runPrecommitVitest(...paths)).toEqual(targeted("test/cli/prime.test.ts", "test/cli/help.test.ts"));
  });

  it("deduplicates filters when targeted routing remains valid", () => {
    expect(runPrecommitVitest(
      "packages/cli/test/cli/help.test.ts",
      "packages/cli/test/cli/help.test.ts",
      "packages/cli/test/cli/schema.test.ts",
    )).toEqual(targeted("test/cli/help.test.ts", "test/cli/schema.test.ts"));
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
    expect(runPrecommitVitest(`packages/cli/test/cli/fixtures/oracle/${fixture}`)).toEqual(targeted(...targets));
  });

  it("falls back to targeted smoke tests for unrelated staged paths", () => {
    expect(runPrecommitVitest("README.md")).toEqual(targeted("test/registries/evaluatorHandoffContract.test.ts"));
  });

  it("rejects malformed route output before tests or typecheck run", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-malformed-route-"));
    const binDir = path.join(tempDir, "bin");
    const calls = path.join(tempDir, "calls");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "node"), "#!/usr/bin/env bash\nprintf 'release\\n'\n");
    fs.writeFileSync(path.join(binDir, "pnpm"), `#!/usr/bin/env bash\nprintf 'pnpm\\n' >> ${JSON.stringify(calls)}\n`);
    fs.chmodSync(path.join(binDir, "node"), 0o755);
    fs.chmodSync(path.join(binDir, "pnpm"), 0o755);
    try {
      const result = spawnSync("bash", [PRECOMMIT_SCRIPT, "packages/cli/src/cli/commands/prime.ts"], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, BASH_ENV: "" },
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid staged route 'release'");
      expect(fs.existsSync(calls)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails a staged-source budget overrun and ignores the retired environment bypass", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-budget-"));
    const binDir = path.join(tempDir, "bin");
    const calls = path.join(tempDir, "calls");
    const clock = path.join(tempDir, "clock");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "node"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${2:-}" == route ]]; then printf 'precommit\\n'; exit 0; fi
printf 'tests\\n' >> ${JSON.stringify(calls)}
`);
    fs.writeFileSync(path.join(binDir, "pnpm"), `#!/usr/bin/env bash\nprintf 'typecheck\\n' >> ${JSON.stringify(calls)}\n`);
    fs.writeFileSync(path.join(binDir, "date"), `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f ${JSON.stringify(clock)} ]]; then read -r count < ${JSON.stringify(clock)}; fi
count=$((count + 1))
printf '%s\\n' "$count" > ${JSON.stringify(clock)}
if [[ "$count" -lt 4 ]]; then printf '1000\\n'; else printf '62001\\n'; fi
`);
    for (const executable of ["node", "pnpm", "date"]) fs.chmodSync(path.join(binDir, executable), 0o755);
    try {
      const result = spawnSync("bash", [PRECOMMIT_SCRIPT, "packages/cli/src/cli/commands/prime.ts"], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          BASH_ENV: "",
          PRECOMMIT_VITEST_PRINT_ROUTE: "1",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("run_targeted");
      expect(result.stderr).toContain("exceeded 60000ms (61001ms)");
      expect(fs.readFileSync(calls, "utf8")).toBe("tests\ntypecheck\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
