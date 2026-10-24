import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { loadVerificationPolicy } from "../../scripts/overlap-pending.mjs";
import { assembleDevelopmentConjunction, issueSourceReceipt, qualificationGates, runSourceConjunction, sourceQualificationGateIdentity } from "../../scripts/release-qualification.mjs";
import { parseSourcePartition, sourcePartitionFiles } from "../../scripts/source-partition.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const POLICY = loadVerificationPolicy(fs.readFileSync(path.join(REPO_ROOT, "references/analysis/verification-policy.yaml")));
const PARTITIONS = POLICY.source_partitions;
const PENDING = POLICY.overlap.allowed_pending_assertion;
const SOURCE_FILES = [
  ...PARTITIONS.core,
  "packages/cli/test/cli/prime.test.ts",
  "packages/cli/test/cli/validate.test.ts",
  "packages/cli/test/state/planEntities.test.ts",
  "packages/cli/test/config/taskCache.test.ts",
  "packages/cli/test/cli/productV1Eol.test.ts",
  "packages/cli/test/cli/routeWorkerDetail.test.ts",
].sort();
const IDENTITY = { identitySha256: "a".repeat(64) };
const NAMES = ["core", ...Array.from({ length: PARTITIONS.shards }, (_, index) => `shard-${index + 1}`)];

function partitionFiles(name: string) {
  return sourcePartitionFiles(SOURCE_FILES, PARTITIONS, parseSourcePartition(name === "core" ? "core" : `shard:${name.slice("shard-".length)}/${PARTITIONS.shards}`, PARTITIONS));
}

function report(files: string[]) {
  const testResults = files.map((name) => ({
    name,
    status: "passed",
    assertionResults: [{ fullName: `${name} passes`, status: "passed" }, ...(name === PENDING.path ? [{ fullName: `${PENDING.suite} ${PENDING.title}`, status: "skipped" }] : [])],
  }));
  const assertions = testResults.flatMap((suite) => suite.assertionResults);
  return {
    success: true,
    numTotalTestSuites: testResults.length,
    numPassedTestSuites: testResults.length,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: assertions.length,
    numPassedTests: assertions.filter(({ status }) => status === "passed").length,
    numFailedTests: 0,
    numPendingTests: assertions.filter(({ status }) => status === "skipped").length,
    numTodoTests: 0,
    testResults,
  };
}

function partsDirectory(mutate: (parts: Record<string, any>) => void = () => undefined) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-assembly-test-"));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  const gates = qualificationGates("development");
  const parts: Record<string, any> = {
    "core.json": {
      schemaVersion: "agentera.developmentConjunction.v1",
      profile: "development",
      gate_identity: sourceQualificationGateIdentity("development"),
      status: "partial",
      gate_count: gates.length,
      gates: gates.map(({ name }: { name: string }) => ({ name, phase: "batch-a", outcome: "passed", elapsedMs: 1, origin: name })),
      execution: { elapsedMs: 600_000, generation: IDENTITY.identitySha256, sourceScope: { partition: "core", files: PARTITIONS.core.length } },
      side_effects: { receipt: false, candidate: false, registry: false, activation: false, publication: false },
    },
  };
  for (const name of NAMES) {
    parts[`${name}-source.json`] = report(partitionFiles(name));
    if (name === "core") continue;
    parts[`${name}.json`] = {
      schemaVersion: "agentera.developmentSourceShard.v1",
      gate_identity: sourceQualificationGateIdentity("development"),
      status: "pass",
      partition: { name, index: Number(name.slice("shard-".length)), count: PARTITIONS.shards, files: partitionFiles(name).length },
      source_identity: IDENTITY,
      source: { files: partitionFiles(name).length, tests: partitionFiles(name).length, elapsedMs: 1 },
      execution: { elapsedMs: 200_000 },
    };
  }
  mutate(parts);
  for (const [file, value] of Object.entries(parts)) if (value !== undefined) fs.writeFileSync(path.join(directory, file), JSON.stringify(value));
  return directory;
}

function assemble(directory: string) {
  return assembleDevelopmentConjunction({ repo: REPO_ROOT, directory, sourceIdentity: IDENTITY, sourceFiles: SOURCE_FILES, platform: "linux" });
}

describe("development conjunction assembly", () => {
  it("passes when the core conjunction and every shard cover the source inventory exactly", () => {
    const result = assemble(partsDirectory());
    expect(result).toMatchObject({
      status: "pass",
      gate_identity: sourceQualificationGateIdentity("development"),
      execution: {
        generation: IDENTITY.identitySha256,
        distribution: {
          source: {
            files: SOURCE_FILES.length,
            tests: SOURCE_FILES.length + 1,
            pending: [{ path: PENDING.path, name: `${PENDING.suite} ${PENDING.title}`, status: "skipped" }],
          },
          partitions: NAMES.map((name) => ({ name, files: partitionFiles(name).length })),
        },
      },
    });
    expect(result.execution).not.toHaveProperty("sourceScope");
  });

  it.each([
    ["a missing shard", (parts: Record<string, any>) => delete parts["shard-2.json"], "source shard result is missing: shard-2.json"],
    ["a missing shard report", (parts: Record<string, any>) => delete parts["shard-3-source.json"], "source partition report is missing: shard-3-source.json"],
    ["a failed shard", (parts: Record<string, any>) => (parts["shard-1.json"].status = "fail"), "shard-1 is not a passing source shard"],
    ["a shard from another commit", (parts: Record<string, any>) => (parts["shard-1.json"].source_identity = { identitySha256: "b".repeat(64) }), "shard-1 is not a passing source shard"],
    ["a core run from another commit", (parts: Record<string, any>) => (parts["core.json"].execution.generation = "b".repeat(64)), "core conjunction is not a passing partial"],
    ["a core result without partition scope", (parts: Record<string, any>) => delete parts["core.json"].execution.sourceScope, "core conjunction is not a passing partial"],
    ["a complete core result", (parts: Record<string, any>) => (parts["core.json"].status = "pass"), "core conjunction is not a passing partial"],
    ["a failed core gate", (parts: Record<string, any>) => (parts["core.json"].gates[3].outcome = "failed"), "core conjunction is not a passing partial"],
    [
      "a file reported by two partitions",
      (parts: Record<string, any>) => {
        const moved = parts["shard-2-source.json"].testResults[0];
        parts["shard-1-source.json"] = report([...parts["shard-1-source.json"].testResults.map(({ name }: { name: string }) => name), moved.name]);
      },
      "shard-1 source report does not cover exactly its partition files",
    ],
    [
      "a dropped assertion count",
      (parts: Record<string, any>) => {
        parts["shard-1-source.json"].numTotalTests += 1;
      },
      "aggregate mismatch numTotalTests",
    ],
    [
      "an unexpected skipped assertion",
      (parts: Record<string, any>) => {
        const shard = parts["shard-1-source.json"];
        shard.testResults[0].assertionResults.push({ fullName: "skipped elsewhere", status: "skipped" });
        shard.numTotalTests += 1;
        shard.numPendingTests += 1;
      },
      "assertion pending identity mismatch",
    ],
  ])("fails closed on %s", (_label, mutate, violation) => {
    const result = assemble(partsDirectory(mutate));
    expect(result).toMatchObject({ status: "fail", first_failure: "source", gates: [] });
    expect(result.violation).toContain(violation);
  });

  it("requires an absolute partition directory", () => {
    expect(assembleDevelopmentConjunction({ repo: REPO_ROOT, directory: "relative", sourceIdentity: IDENTITY, sourceFiles: SOURCE_FILES }).violation).toContain("assemble requires an absolute AGENTERA_SOURCE_PARTITION_DIRECTORY");
  });
});

describe("partitioned development verification", () => {
  const core = { partition: { kind: "core", label: "core" }, resultFile: "/unused/core.json", sourceReportFile: "/unused/core-source.json" };

  it("reports a core partition as partial, never as a passing development conjunction", async () => {
    let observed: Record<string, unknown> | undefined;
    const result = await runSourceConjunction({
      profile: "development",
      sourcePartitionRequest: core,
      runDag: async (options: Record<string, unknown>) => {
        observed = options;
        return {
          gates: qualificationGates("development").map(({ name }: { name: string }) => ({ name, phase: "batch-a", outcome: "passed", elapsedMs: 1, origin: name, observation: name === "performance" ? { evidence: { latencyAdvisory: {} } } : {} })),
          execution: { generation: "g".repeat(64), sourceScope: { partition: "core", files: 2 } },
        };
      },
    });
    expect(result).toMatchObject({ status: "partial", execution: { sourceScope: { partition: "core", files: 2 } } });
    expect(observed).toMatchObject({ sourcePartition: core.partition, sourceReportFile: core.sourceReportFile });
  });

  it("refuses partitions outside the development core and on receipt paths", async () => {
    const runDag = async () => {
      throw new Error("must not run");
    };
    await expect(runSourceConjunction({ profile: "full", sourcePartitionRequest: core, runDag })).rejects.toThrow("accepts only the core partition of the development profile");
    await expect(runSourceConjunction({ profile: "development", sourcePartitionRequest: { ...core, partition: { kind: "shard", label: "shard-1", index: 1, count: 3 } }, runDag })).rejects.toThrow("shards use verify-shard");
    await expect(issueSourceReceipt({ environment: { AGENTERA_SOURCE_PARTITION: "core" }, runDag })).rejects.toThrow("source receipts require the complete source inventory");
  });
});
