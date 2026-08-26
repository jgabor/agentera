import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  maxWorkersFor,
  MEASURED_LOCAL_WORKER_POLICY,
  testTimeoutFor,
  UNMEASURED_WORKER_POLICY,
  workerPolicyFor,
} from "../../vitest.shared.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("source worker policy", () => {
  it("uses eight workers only for the explicitly selected measured runner", () => {
    expect(workerPolicyFor({ AGENTERA_VITEST_RUNNER_POLICY: MEASURED_LOCAL_WORKER_POLICY })).toEqual({
      name: MEASURED_LOCAL_WORKER_POLICY,
      workers: 8,
    });
  });

  it("keeps unmeasured runners at the conservative fallback", () => {
    expect(workerPolicyFor({})).toEqual({ name: UNMEASURED_WORKER_POLICY, workers: 4 });
    expect(workerPolicyFor({ AGENTERA_VITEST_RUNNER_POLICY: "unknown-runner" })).toEqual({
      name: UNMEASURED_WORKER_POLICY,
      workers: 4,
    });
  });

  it("uses the explicit override before any runner policy", () => {
    expect(workerPolicyFor({
      VITEST_MAX_WORKERS: "6",
      AGENTERA_VITEST_RUNNER_POLICY: MEASURED_LOCAL_WORKER_POLICY,
    })).toEqual({ name: "explicit-override", workers: 6 });
    expect(maxWorkersFor({ VITEST_MAX_WORKERS: "6" })).toBe(6);
  });

  it("keeps the local test ceiling at 30 seconds unless the runner overrides it", () => {
    expect(testTimeoutFor({})).toBe(30_000);
    expect(testTimeoutFor({ VITEST_TEST_TIMEOUT_MS: "120000" })).toBe(120_000);
  });

  it("keeps GitHub Actions explicitly unmeasured", () => {
    const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"), "utf8"));
    const sourceOwnerStep = workflow.jobs.cli.steps.find(
      (step: { name?: string }) => step.name === "Run check-only release verification",
    );
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
