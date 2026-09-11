import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

  it("discovers source tests from the package and workspace root with source setup", () => {
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
      expect(result.status, result.stderr).toBe(0);
      expect(tests.length).toBeGreaterThan(0);
      expect(tests.every((test: { file: string; projectName: string }) => test.file === path.join(packageRoot, "test/config/vitestShared.test.ts") && test.projectName === "source")).toBe(true);
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

  it.each([undefined, "", "invalid", "0", "-1", "500", "120000"])("shares the resolved test deadline with hooks for override %s", (override) => {
    const environment = { ...process.env };
    if (override === undefined) delete environment.VITEST_TEST_TIMEOUT_MS;
    else environment.VITEST_TEST_TIMEOUT_MS = override;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import source from "./vite.config.ts"; import packaged from "./vite.package.config.ts"; console.log(JSON.stringify({ source: source.test, packaged: packaged.test }));'], {
      cwd: path.join(REPO_ROOT, "packages/cli"),
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const { source, packaged } = JSON.parse(result.stdout);
    const expected = override === "500" ? 500 : override === "120000" ? 120_000 : 30_000;
    expect(source.testTimeout).toBe(expected);
    expect(source.hookTimeout).toBe(expected);
    expect(packaged.hookTimeout).toBe(expected);
    expect(packaged.testTimeout).toBe(120_000);
    expect(packaged.maxWorkers).toBe(1);
  });

  it("enforces shared deadlines in real Vitest while allowing passing tests and hooks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-deadline-probe-"));
    const packageRoot = path.join(REPO_ROOT, "packages/cli");
    try {
      fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(root, "node_modules"), "dir");
      fs.writeFileSync(path.join(root, "vite.config.mts"), `import { sharedTestConfig } from ${JSON.stringify(pathToFileURL(path.join(packageRoot, "vitest.shared.ts")).href)};\nexport default { test: { ...sharedTestConfig, root: ${JSON.stringify(root)}, include: ["*.test.ts"] } };\n`);
      fs.writeFileSync(path.join(root, "passing.test.ts"), 'import { beforeAll, it, expect } from "vitest"; let ready = false; beforeAll(() => { ready = true; }); it("passes after setup", () => expect(ready).toBe(true));\n');
      fs.writeFileSync(path.join(root, "test-deadline.test.ts"), 'import { it } from "vitest"; it("exceeds test deadline", () => new Promise(() => {}));\n');
      fs.writeFileSync(path.join(root, "hook-deadline.test.ts"), 'import { beforeAll, it } from "vitest"; beforeAll(() => new Promise(() => {})); it("never reaches assertion", () => {});\n');
      const reportFile = path.join(root, "result.json");
      const result = spawnSync("pnpm", ["exec", "vp", "test", "run", "--config", path.join(root, "vite.config.mts"), "--reporter=json", `--outputFile=${reportFile}`], {
        cwd: packageRoot,
        env: { ...process.env, VITEST_TEST_TIMEOUT_MS: "500" },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
      const suite = (name: string) => report.testResults.find((entry: { name: string }) => entry.name.endsWith(`/${name}.test.ts`));
      expect(suite("passing").status).toBe("passed");
      expect(suite("test-deadline").assertionResults[0].status).toBe("failed");
      expect(suite("hook-deadline").status).toBe("failed");
      expect(suite("hook-deadline").message).toContain("Hook timed out in 500ms");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps GitHub Actions explicitly unmeasured", () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/publish.yml"), "utf8"));
    const sourceOwnerStep = workflow.jobs["verify-development"].steps.find((step: { name?: string }) => step.name === "Verify development safety without receipt");
    expect(sourceOwnerStep.env).toEqual({
      AGENTERA_VITEST_RUNNER_POLICY: UNMEASURED_WORKER_POLICY,
      VITEST_TEST_TIMEOUT_MS: "120000",
      AGENTERA_PERFORMANCE_RUNNER_CLASS: "github-hosted-ubuntu-24.04",
      AGENTERA_PERFORMANCE_RUNNER_IDENTITY: "${{ runner.name }}",
    });
    expect(workerPolicyFor(sourceOwnerStep.env)).toEqual({
      name: UNMEASURED_WORKER_POLICY,
      workers: 4,
    });
  });
});
