import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PRECOMMIT_SCRIPT = path.join(REPO_ROOT, "scripts", "precommit-vitest.sh");

type RouteMode = "full" | "targeted";

function runPrecommitVitest(stagedPath: string): RouteMode {
  const result = spawnSync("bash", [PRECOMMIT_SCRIPT, stagedPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PRECOMMIT_VITEST_PRINT_ROUTE: "1",
    },
    encoding: "utf8",
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  const route = result.stdout.trim();
  if (route === "run_full") return "full";
  if (route === "run_targeted") return "targeted";
  throw new Error(`unexpected route: ${route}`);
}

describe("scripts/precommit-vitest.sh staged routing", () => {
  it("routes scripts/sandbox/* to the full vitest suite", () => {
    expect(runPrecommitVitest("scripts/sandbox/v2v3-upgrade-harness.sh")).toBe("full");
  });

  it("has an explicit scripts/sandbox case in the routing script", () => {
    const script = fs.readFileSync(PRECOMMIT_SCRIPT, "utf8");
    expect(script).toMatch(/scripts\/sandbox\/\*\)\s*\n\s*RUN_FULL=true/);
  });

  it("preserves full-suite routing for packages/cli/src changes", () => {
    expect(runPrecommitVitest("packages/cli/src/cli/prime.ts")).toBe("full");
  });

  it("preserves full-suite routing for skills/* changes", () => {
    expect(runPrecommitVitest("skills/agentera/SKILL.md")).toBe("full");
  });

  it("falls back to targeted smoke tests for unrelated staged paths", () => {
    expect(runPrecommitVitest("README.md")).toBe("targeted");
  });
});
