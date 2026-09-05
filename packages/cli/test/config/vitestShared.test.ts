import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, inject, it } from "vitest";
import YAML from "yaml";
import { maxWorkersFor, MEASURED_LOCAL_WORKER_POLICY, testTimeoutFor, UNMEASURED_WORKER_POLICY, workerPolicyFor } from "../../vitest.shared.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("source worker policy", () => {
  it("uses eight workers only for the explicitly selected measured runner", () => {
    expect(workerPolicyFor({ AGENTERA_VITEST_RUNNER_POLICY: MEASURED_LOCAL_WORKER_POLICY })).toEqual({
      name: MEASURED_LOCAL_WORKER_POLICY,
      workers: 8,
    });
  });

  it("wires the local source command to the measured runner policy", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
    expect(packageJson.scripts["test:source:local"]).toBe(`AGENTERA_VITEST_RUNNER_POLICY=${MEASURED_LOCAL_WORKER_POLICY} node scripts/verify-lane.mjs source`);
  });

  it("keeps watch discovery in the CLI package with its source setup, not the root no-test config", () => {
    const packageRoot = path.join(REPO_ROOT, "packages/cli");
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    expect(packageJson.scripts["test:watch"]).toBe("pnpm exec vp test watch --config vite.config.ts");
    expect(packageJson.scripts["test:source"]).toBe("node scripts/verify-lane.mjs source");
    expect(fs.existsSync(path.join(inject("sourceBuildRoot"), "bin/agentera.js"))).toBe(true);
    const args = packageJson.scripts["test:watch"]
      .split(" ")
      .slice(1)
      .map((arg: string) => (arg === "watch" ? "list" : arg));
    for (const workspaceRoot of [false, true]) {
      const result = spawnSync("pnpm", [...(workspaceRoot ? ["--workspace-root"] : []), ...args, "test/config/vitestShared.test.ts", "--json"], {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      const tests = JSON.parse(result.stdout);
      if (workspaceRoot) {
        expect(tests).toEqual([]);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(tests.length).toBeGreaterThan(0);
        expect(tests.every((test: { file: string }) => test.file === path.join(packageRoot, "test/config/vitestShared.test.ts"))).toBe(true);
      }
    }
  });

  it("keeps unmeasured runners at the conservative fallback", () => {
    expect(workerPolicyFor({})).toEqual({ name: UNMEASURED_WORKER_POLICY, workers: 4 });
    expect(workerPolicyFor({ AGENTERA_VITEST_RUNNER_POLICY: "unknown-runner" })).toEqual({
      name: UNMEASURED_WORKER_POLICY,
      workers: 4,
    });
  });

  it("uses the explicit override before any runner policy", () => {
    expect(
      workerPolicyFor({
        VITEST_MAX_WORKERS: "6",
        AGENTERA_VITEST_RUNNER_POLICY: MEASURED_LOCAL_WORKER_POLICY,
      }),
    ).toEqual({ name: "explicit-override", workers: 6 });
    expect(maxWorkersFor({ VITEST_MAX_WORKERS: "6" })).toBe(6);
  });

  it("keeps the local test ceiling at 30 seconds unless the runner overrides it", () => {
    expect(testTimeoutFor({})).toBe(30_000);
    expect(testTimeoutFor({ VITEST_TEST_TIMEOUT_MS: "120000" })).toBe(120_000);
  });

  it("keeps GitHub Actions explicitly unmeasured", () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"), "utf8"));
    const sourceOwnerStep = workflow.jobs.cli.steps.find((step: { name?: string }) => step.name === "Run check-only release verification");
    expect(sourceOwnerStep.env).toMatchObject({
      AGENTERA_VITEST_RUNNER_POLICY: UNMEASURED_WORKER_POLICY,
      VITEST_TEST_TIMEOUT_MS: "120000",
    });
    expect(workerPolicyFor(sourceOwnerStep.env)).toEqual({
      name: UNMEASURED_WORKER_POLICY,
      workers: 4,
    });
  });
});
