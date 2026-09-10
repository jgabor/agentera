import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/publish.yml"), "utf8"));
const developmentPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
const publicationContract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"));
const verificationPolicy = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"));

const RELEASE_COMMAND = "vp run verify:development";
const PARITY_TEST = "packages/cli/test/cli/npmParityMatrix.test.ts";
const REMOVED_DUPLICATES = [
  {
    owner: "source",
    gate: "source",
    command: "pnpm -C packages/cli run test:source",
    forbidden: ["pnpm -C packages/cli test", "pnpm -C packages/cli run test:source"],
  },
  {
    owner: "package",
    gate: "package",
    command: "pnpm -C packages/cli run verify:package",
    forbidden: ["pnpm -C packages/cli run verify:package"],
  },
  {
    owner: "build",
    gate: "build",
    command: "pnpm -C packages/cli build",
    forbidden: ["pnpm -C packages/cli build"],
  },
] as const;

function runLines(candidate: any): string[] {
  return candidate.jobs["verify-development"].steps.flatMap((step: { run?: string }) =>
    typeof step.run === "string"
      ? step.run
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  );
}

function invokes(line: string, command: string): boolean {
  return line === command || line.startsWith(`${command} `);
}

function validateRoutineCiOwnership(candidate: any): void {
  const lines = runLines(candidate);
  if (lines.filter((line) => invokes(line, RELEASE_COMMAND)).length !== 1) {
    throw new Error("routine CI must invoke the check-only release verification exactly once");
  }
  for (const entry of REMOVED_DUPLICATES) {
    if (entry.forbidden.some((command) => lines.some((line) => invokes(line, command)))) {
      throw new Error(`routine CI must not invoke ${entry.owner} outside generated overlap`);
    }
  }
  const job = candidate.jobs["verify-development"];
  const buildIndex = job.steps.findIndex((step: { run?: string }) => step.run === "vp run build");
  const verifyIndex = job.steps.findIndex((step: { run?: string }) => step.run === RELEASE_COMMAND);
  const migration = job.steps[buildIndex + 1];
  expect(buildIndex).toBe(verifyIndex + 1);
  expect(lines.filter((line) => invokes(line, "vp run build"))).toHaveLength(1);
  expect(migration.env).toEqual({
    REPO_ROOT: "${{ github.workspace }}",
    AGENTERA_SANDBOX_TIER: "L1",
  });
  expect(migration.run).toBe('set -euo pipefail\nfor scenario in happy-path-clean stable-safety noisy-app-home codex-plugin-vs-copied partial-only-runtime; do\n  bash scripts/sandbox/v2v3-upgrade-harness.sh "$scenario"\ndone\n');
  for (const step of job.steps) {
    expect(step).not.toHaveProperty("continue-on-error");
    expect(step).not.toHaveProperty("if");
  }
  expect(job).not.toHaveProperty("continue-on-error");
  expect(candidate.jobs["build-development"].needs).toBe("verify-development");
  expect(candidate.jobs["build-development"]).not.toHaveProperty("if");
  expect(candidate.jobs["publish-development"].needs).toBe("build-development");
}

describe("routine CI owner DAG", () => {
  it("runs the canonical check-only conjunction once on the authoritative performance runner", () => {
    expect(() => validateRoutineCiOwnership(workflow)).not.toThrow();
    expect(workflow.jobs["verify-development"]["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs["verify-development"].if).toBe("needs.route-development.outputs.selected == 'true'");
    expect(workflow.on).toEqual({ push: null });
    expect(fs.existsSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"))).toBe(false);
    expect(JSON.stringify(workflow)).not.toMatch(/setup-bun|setup-uv/);
    expect(developmentPackage.scripts["verify:release"]).toBe("node scripts/release-qualification.mjs verify --json");
    const step = workflow.jobs["verify-development"].steps.find((candidate: { run?: string }) => candidate.run === RELEASE_COMMAND);
    expect(step).toMatchObject({
      env: {
        AGENTERA_VITEST_RUNNER_POLICY: "unmeasured",
        AGENTERA_PERFORMANCE_RUNNER_CLASS: "github-hosted-ubuntu-24.04",
        AGENTERA_PERFORMANCE_RUNNER_IDENTITY: "${{ runner.name }}",
      },
    });
    expect(step).not.toHaveProperty("continue-on-error");
    const staticIndex = workflow.jobs["verify-development"].steps.findIndex((candidate: { run?: string }) => candidate.run === "vp check");
    const verifyIndex = workflow.jobs["verify-development"].steps.findIndex((candidate: { run?: string }) => candidate.run === RELEASE_COMMAND);
    expect(staticIndex).toBeGreaterThan(-1);
    expect(staticIndex).toBeLessThan(verifyIndex);
    expect(workflow.jobs["verify-development"].steps.some((candidate: { run?: string }) => candidate.run === "vp run typecheck")).toBe(false);
  });

  it.each(REMOVED_DUPLICATES)("retains positive $owner coverage through generated overlap", ({ owner, gate, command }) => {
    const source = publicationContract.qualification.source;
    expect(source.dag.generatedOverlapOrigins).toContain(owner);
    expect(source.gates.find((entry: { name: string }) => entry.name === gate)?.command.join(" ")).toBe(command);
  });

  it.each(REMOVED_DUPLICATES)("rejects a forbidden standalone $owner invocation", ({ owner, forbidden }) => {
    const candidate = structuredClone(workflow);
    candidate.jobs["verify-development"].steps.push({
      name: `Forbidden ${owner}`,
      run: forbidden[0],
    });
    expect(() => validateRoutineCiOwnership(candidate)).toThrow(`routine CI must not invoke ${owner} outside generated overlap`);
  });

  it.each(["continue", "dependency", "skip-build", "ignore-scenario", "duplicate-verify"])("rejects broken migration dependency gating: %s", (fault) => {
    const candidate = structuredClone(workflow);
    const steps = candidate.jobs["verify-development"].steps;
    const migration = steps.find((step: { name?: string }) => step.name === "Run v2→v3 migration scenarios");
    if (fault === "continue") migration["continue-on-error"] = true;
    if (fault === "dependency") candidate.jobs["build-development"].needs = "route-development";
    if (fault === "skip-build")
      steps.splice(
        steps.findIndex((step: { run?: string }) => step.run === "vp run build"),
        1,
      );
    if (fault === "ignore-scenario") migration.run = migration.run.replace('"$scenario"', '"$scenario" || true');
    if (fault === "duplicate-verify") steps.push({ run: RELEASE_COMMAND });
    expect(() => validateRoutineCiOwnership(candidate)).toThrow();
  });

  it("retains typecheck, parity, compact, stress, performance, and capacity coverage", () => {
    const source = publicationContract.qualification.source;
    const gateNames = source.gates.map((entry: { name: string }) => entry.name);
    expect(gateNames).toEqual(expect.arrayContaining(["typecheck", "compact", "stress", "performance", "capacity"]));
    expect(verificationPolicy.policies.release).toEqual(["source", "stress", "performance", "capacity", "package", "certification"]);
    expect(verificationPolicy.inventory.default_owner).toBe("source");
    expect(verificationPolicy.inventory.rules.filter((rule: { path?: string; prefix?: string }) => rule.path === "packages/cli/test/scripts/pyTsParity.test.ts" || "packages/cli/test/scripts/pyTsParity.test.ts".startsWith(rule.prefix ?? "never/"))).toEqual([
      { owner: "certification", path: "packages/cli/test/scripts/pyTsParity.test.ts" },
    ]);
    expect(verificationPolicy.inventory.rules.some((rule: { path?: string; prefix?: string }) => rule.path === PARITY_TEST || PARITY_TEST.startsWith(rule.prefix ?? "never/"))).toBe(false);
    expect(verificationPolicy.owners.performance.execution.authoritative_runner.runs_on).toBe("ubuntu-24.04");

    const lines = runLines(workflow);
    const steps = workflow.jobs["verify-development"].steps;
    const checkoutIndex = steps.findIndex((step: { uses?: string }) => step.uses === "actions/checkout@v5");
    const conjunctionIndex = steps.findIndex((step: { run?: string }) => step.run === RELEASE_COMMAND);
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeLessThan(conjunctionIndex);
    expect(steps[checkoutIndex].with).toEqual({ ref: "${{ github.sha }}", "fetch-depth": 0 });
    expect(lines).not.toContain("bash packages/cli/scripts/py_ts_parity.sh --check --json");
    for (const gate of source.gates) {
      expect(lines.some((line) => invokes(line, gate.command.join(" ")))).toBe(false);
    }
  });
});
