import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/publish.yml"), "utf8"));
const developmentPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages/cli/package.json"), "utf8"));
const publicationContract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "references/adapters/package-publication.json"), "utf8"));
const verificationPolicy = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"), "utf8"));

const RELEASE_COMMAND = "vp run verify:development";
const SHARD_COMMAND = "vp run verify:development:shard";
const ASSEMBLE_COMMAND = "vp run verify:development:assemble";
const VERIFICATION_JOBS = ["verify-development", "verify-source-shard", "assemble-development-verification"];
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

function runLines(candidate: any, job = "verify-development"): string[] {
  return candidate.jobs[job].steps.flatMap((step: { run?: string }) =>
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
  for (const name of VERIFICATION_JOBS) {
    const jobLines = runLines(candidate, name);
    for (const entry of REMOVED_DUPLICATES) {
      if (entry.forbidden.some((command) => jobLines.some((line) => invokes(line, command)))) {
        throw new Error(`routine CI must not invoke ${entry.owner} outside generated overlap`);
      }
    }
  }
  if (runLines(candidate, "verify-source-shard").filter((line) => invokes(line, SHARD_COMMAND)).length !== 1) {
    throw new Error("each source shard must invoke the shard verification exactly once");
  }
  if (runLines(candidate, "assemble-development-verification").filter((line) => invokes(line, ASSEMBLE_COMMAND)).length !== 1) {
    throw new Error("development verification must be assembled exactly once");
  }
  const shards = verificationPolicy.source_partitions.shards;
  const shardJob = candidate.jobs["verify-source-shard"];
  if (JSON.stringify(shardJob.strategy?.matrix) !== JSON.stringify({ shard: Array.from({ length: shards }, (_, index) => index + 1) })) {
    throw new Error("the shard matrix must cover every policy shard exactly once");
  }
  const partitionEnv = (job: any, command: string) => job.steps.find((step: { run?: string }) => step.run === command)?.env?.AGENTERA_SOURCE_PARTITION;
  if (partitionEnv(candidate.jobs["verify-development"], RELEASE_COMMAND) !== "core" || partitionEnv(shardJob, SHARD_COMMAND) !== `shard:\${{ matrix.shard }}/${shards}`) {
    throw new Error("core and shard jobs must select their governed source partitions");
  }
  const assemble = candidate.jobs["assemble-development-verification"];
  // A plain condition keeps the implicit success() check, so any failed,
  // cancelled, or skipped partition skips assembly and publication.
  if (assemble.if !== "needs.publication-state.outputs.mode == 'build'" || JSON.stringify(assemble.needs) !== JSON.stringify(["publication-state", "verify-development", "verify-source-shard"])) {
    throw new Error("assembly must depend on every partition without overriding the success check");
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
  for (const name of VERIFICATION_JOBS) {
    for (const step of candidate.jobs[name].steps) {
      expect(step).not.toHaveProperty("continue-on-error");
      expect(step).not.toHaveProperty("if");
    }
    expect(candidate.jobs[name]).not.toHaveProperty("continue-on-error");
  }
  expect(candidate.jobs["build-development"].needs).toBe("assemble-development-verification");
  expect(candidate.jobs["build-development"]).not.toHaveProperty("if");
  expect(candidate.jobs["publish-development"].needs).toEqual(["publication-state", "build-development"]);
}

describe("routine CI owner DAG", () => {
  it("runs the canonical check-only conjunction once on the authoritative performance runner", () => {
    expect(() => validateRoutineCiOwnership(workflow)).not.toThrow();
    expect(workflow.jobs["verify-development"]["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.jobs["verify-development"].if).toBe("needs.publication-state.outputs.mode == 'build'");
    expect(workflow.on).toEqual({ push: null });
    expect(fs.existsSync(path.join(REPO_ROOT, ".github/workflows/verify-changes.yml"))).toBe(false);
    expect(JSON.stringify(workflow)).not.toMatch(/setup-bun|setup-uv/);
    expect(developmentPackage.scripts["verify:release"]).toBe("node scripts/release-qualification.mjs verify --json");
    const step = workflow.jobs["verify-development"].steps.find((candidate: { run?: string }) => candidate.run === RELEASE_COMMAND);
    expect(step).toMatchObject({
      env: {
        AGENTERA_VITEST_RUNNER_POLICY: "unmeasured",
        AGENTERA_GENERATED_OVERLAP_SOURCE_WORKERS: "2",
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

  it.each(["continue", "dependency", "skip-build", "ignore-scenario", "duplicate-verify", "unassembled", "forced-assembly", "missing-shard", "short-matrix", "full-core", "shard-source-owner"])("rejects broken verification dependency gating: %s", (fault) => {
    const candidate = structuredClone(workflow);
    const steps = candidate.jobs["verify-development"].steps;
    const migration = steps.find((step: { name?: string }) => step.name === "Run v2→v3 migration scenarios");
    if (fault === "continue") migration["continue-on-error"] = true;
    if (fault === "dependency") candidate.jobs["build-development"].needs = "route-development";
    if (fault === "unassembled") candidate.jobs["build-development"].needs = "verify-development";
    if (fault === "forced-assembly") candidate.jobs["assemble-development-verification"].if = "always() && needs.publication-state.outputs.mode == 'build'";
    if (fault === "missing-shard") candidate.jobs["assemble-development-verification"].needs = ["publication-state", "verify-development"];
    if (fault === "short-matrix") candidate.jobs["verify-source-shard"].strategy.matrix.shard = [1, 2];
    if (fault === "full-core") delete candidate.jobs["verify-development"].steps.find((step: { run?: string }) => step.run === RELEASE_COMMAND).env.AGENTERA_SOURCE_PARTITION;
    if (fault === "shard-source-owner") candidate.jobs["verify-source-shard"].steps.push({ run: "pnpm -C packages/cli run test:source" });
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
    expect(verificationPolicy.policies.release).toEqual(["source", "stress", "performance", "capacity", "package"]);
    expect(verificationPolicy.inventory.default_owner).toBe("source");
    // Hermetic parity drift tests stay in routine source verification.
    expect(verificationPolicy.inventory.rules.filter((rule: { path?: string; prefix?: string }) => rule.path === "packages/cli/test/scripts/pyTsParity.test.ts" || "packages/cli/test/scripts/pyTsParity.test.ts".startsWith(rule.prefix ?? "never/"))).toEqual([]);
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
