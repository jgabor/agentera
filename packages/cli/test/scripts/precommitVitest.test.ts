import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PRECOMMIT_SCRIPT = path.join(REPO_ROOT, "scripts", "precommit-vitest.sh");

type Route = { mode: "policy" | "targeted"; policy?: string; targets: string[] };

function runPrecommitVitest(stagedPath: string): Route {
  const result = spawnSync("bash", [PRECOMMIT_SCRIPT, stagedPath], {
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

describe("scripts/precommit-vitest.sh staged routing", () => {
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
      "packages/cli/scripts/verify-lane.mjs",
      "packages/cli/test/packaging/**",
      "scripts/precommit-vitest.sh",
    ]) expect(lefthook, surface).toContain(`- \"${surface}\"`);
  });

  it("routes central contracts and schemas through every owner", () => {
    for (const path of ["skills/agentera/SKILL.md", "references/artifacts/state-storage-authority.yaml", ".github/workflows/verify.yml"]) {
      expect(runPrecommitVitest(path)).toEqual({ mode: "policy", policy: "release", targets: [] });
    }
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
