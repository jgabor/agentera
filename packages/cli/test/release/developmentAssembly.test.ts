import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { loadVerificationPolicy } from "../../scripts/overlap-pending.mjs";
import { assembleDevelopmentConjunction, issueSourceReceipt, qualificationGates, runIsolatedOwners, runIsolatedOwnersCommand, runNoReceiptVerificationCommand, runSourceConjunction, runSourceShard, sourceQualificationGateIdentity } from "../../scripts/release-qualification.mjs";
import { parseSourcePartition, sourcePartitionFiles } from "../../scripts/source-partition.mjs";
import { sealGeneratedSourceIdentity } from "../../scripts/generated-output.mjs";
import { performanceEvidence } from "../helpers/performanceEvidence.js";

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
const ISOLATED = ["stress", "performance", "capacity"];
const ADVISORY = { prime: { targetMs: 1, maxObservedMs: 2, exceededRepetitions: 1 } };
// The assembler's own owner inventory counts for the fixture source identity.
const OWNER_COUNTS = { stress: 1, performance: 1, capacity: 1 };

// Command entries print their result and set the exit code; keep both local.
async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const exitCode = process.exitCode;
  try {
    return await run();
  } finally {
    write.mockRestore();
    process.exitCode = exitCode;
  }
}

function temporaryDirectory(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

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

// A core that delegated the isolated owners, plus the isolated-owner part.
function delegate(parts: Record<string, any>) {
  const core = parts["core.json"];
  core.delegated_gates = ISOLATED;
  core.gates = core.gates.filter(({ name }: { name: string }) => !ISOLATED.includes(name));
  core.performance = null;
  Object.assign(core.execution, { batchAElapsedMs: 500_000, barrierBElapsedMs: 90_000, unattributedElapsedMs: 10_000, reconciled: true, delegatedGates: ISOLATED });
  parts["isolated.json"] = {
    schemaVersion: "agentera.developmentIsolatedOwners.v1",
    profile: "development",
    gate_identity: sourceQualificationGateIdentity("development"),
    status: "pass",
    source_identity: IDENTITY,
    gates: ISOLATED.map((name) => ({ name, phase: "isolated-owners", outcome: "passed", elapsedMs: 2, origin: name, inventoryFiles: 1 })),
    performance: { latencyAdvisory: ADVISORY },
    execution: { strategy: "serial-isolated-owners", deadlineMs: 2_400_000, elapsedMs: 200_000, stressElapsedMs: 100_000, performanceElapsedMs: 15_000, capacityElapsedMs: 80_000, unattributedElapsedMs: 5_000, reconciled: true },
  };
}

function assemble(directory: string, inventoryCounts: Record<string, unknown> = OWNER_COUNTS) {
  return assembleDevelopmentConjunction({ repo: REPO_ROOT, directory, sourceIdentity: IDENTITY, sourceFiles: SOURCE_FILES, inventoryCounts, platform: "linux" });
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

  it("ignores an isolated-owner part when the core delegated nothing", () => {
    const result = assemble(partsDirectory((parts) => (parts["isolated.json"] = { status: "fail" })));
    expect(result.status).toBe("pass");
    expect(result.gates.map(({ name }: { name: string }) => name)).toEqual(qualificationGates("development").map(({ name }: { name: string }) => name));
  });

  it("assembles a delegating core with the isolated-owner part into every governed gate once", () => {
    const result = assemble(partsDirectory(delegate));
    expect(result.status).toBe("pass");
    expect(result).not.toHaveProperty("delegated_gates");
    expect(result.gates.map(({ name }: { name: string }) => name)).toEqual(qualificationGates("development").map(({ name }: { name: string }) => name));
    expect(result.gates.filter(({ phase }: { phase: string }) => phase === "isolated-owners").map(({ name }: { name: string }) => name)).toEqual(ISOLATED);
    expect(result.gates.find(({ name }: { name: string }) => name === "stress")).toEqual({ name: "stress", phase: "isolated-owners", outcome: "passed", elapsedMs: 2, origin: "stress" });
    expect(result.performance).toEqual({ latencyAdvisory: ADVISORY });
    expect(result.execution).toMatchObject({ elapsedMs: 600_000, batchAElapsedMs: 500_000, barrierBElapsedMs: 90_000, unattributedElapsedMs: 10_000, reconciled: true, reconciliation: "per-partition" });
    // Each partition reconciles to its own elapsed time; no isolated term sits
    // beside the core's terms, so the top-level sum stays the core's.
    const { batchAElapsedMs, barrierBElapsedMs, unattributedElapsedMs, elapsedMs } = result.execution;
    expect(batchAElapsedMs + barrierBElapsedMs + unattributedElapsedMs).toBe(elapsedMs);
    expect(result.execution).not.toHaveProperty("performanceElapsedMs");
    expect(result.execution).not.toHaveProperty("capacityElapsedMs");
    expect(result.execution.isolated).toEqual({ elapsedMs: 200_000, stressElapsedMs: 100_000, performanceElapsedMs: 15_000, capacityElapsedMs: 80_000, unattributedElapsedMs: 5_000 });
    expect(result.execution).not.toHaveProperty("delegatedGates");
  });

  it.each([
    ["a missing isolated-owner part", (parts: Record<string, any>) => delete parts["isolated.json"], "isolated-owner result is missing: isolated.json"],
    ["a failed isolated-owner part", (parts: Record<string, any>) => (parts["isolated.json"].status = "fail"), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated-owner part from another commit", (parts: Record<string, any>) => (parts["isolated.json"].source_identity = { identitySha256: "b".repeat(64) }), "isolated owners are not a passing isolated-owner partition"],
    ["isolated timings that do not reconcile", (parts: Record<string, any>) => (parts["isolated.json"].execution.unattributedElapsedMs = 6_000), "timings do not each reconcile"],
    ["core timings that do not reconcile", (parts: Record<string, any>) => (parts["core.json"].execution.unattributedElapsedMs = 11_000), "timings do not each reconcile"],
    ["an isolated-owner part with another schema", (parts: Record<string, any>) => (parts["isolated.json"].schemaVersion = "agentera.developmentSourceShard.v1"), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated-owner part from another profile", (parts: Record<string, any>) => (parts["isolated.json"].profile = "full"), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated-owner part for another gate identity", (parts: Record<string, any>) => (parts["isolated.json"].gate_identity = sourceQualificationGateIdentity("full")), "isolated owners are not a passing isolated-owner partition"],
    ["isolated gates out of order", (parts: Record<string, any>) => parts["isolated.json"].gates.reverse(), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated-owner part missing a gate", (parts: Record<string, any>) => parts["isolated.json"].gates.pop(), "isolated owners are not a passing isolated-owner partition"],
    ["a failed isolated gate", (parts: Record<string, any>) => (parts["isolated.json"].gates[1].outcome = "failed"), "isolated owners are not a passing isolated-owner partition"],
    ["an empty isolated inventory", (parts: Record<string, any>) => (parts["isolated.json"].gates[0].inventoryFiles = 0), "isolated owners are not a passing isolated-owner partition"],
    ["a negative isolated inventory", (parts: Record<string, any>) => (parts["isolated.json"].gates[0].inventoryFiles = -1), "isolated owners are not a passing isolated-owner partition"],
    ["a non-integer isolated inventory", (parts: Record<string, any>) => (parts["isolated.json"].gates[1].inventoryFiles = "1"), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated inventory other than this host's", (parts: Record<string, any>) => (parts["isolated.json"].gates[2].inventoryFiles = 2), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated gate from another phase", (parts: Record<string, any>) => (parts["isolated.json"].gates[0].phase = "batch-a"), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated gate from another origin", (parts: Record<string, any>) => (parts["isolated.json"].gates[0].origin = "performance"), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated gate with negative elapsed time", (parts: Record<string, any>) => (parts["isolated.json"].gates[1].elapsedMs = -1), "isolated owners are not a passing isolated-owner partition"],
    ["an isolated gate without elapsed time", (parts: Record<string, any>) => delete parts["isolated.json"].gates[2].elapsedMs, "isolated owners are not a passing isolated-owner partition"],
    ["an isolated-owner part without a latency advisory", (parts: Record<string, any>) => delete parts["isolated.json"].performance, "isolated owners are not a passing isolated-owner partition"],
    ["an empty array isolated latency advisory", (parts: Record<string, any>) => (parts["isolated.json"].performance.latencyAdvisory = []), "isolated owners are not a passing isolated-owner partition"],
    ["a nonempty array isolated latency advisory", (parts: Record<string, any>) => (parts["isolated.json"].performance.latencyAdvisory = [ADVISORY.prime]), "isolated owners are not a passing isolated-owner partition"],
    ["an empty isolated latency advisory", (parts: Record<string, any>) => (parts["isolated.json"].performance.latencyAdvisory = {}), "isolated owners are not a passing isolated-owner partition"],
    ["a delegating core that reports performance time", (parts: Record<string, any>) => (parts["core.json"].execution.performanceElapsedMs = 0), "a delegating core reports timings for delegated owners"],
    ["a delegating core that reports capacity time", (parts: Record<string, any>) => (parts["core.json"].execution.capacityElapsedMs = 0), "a delegating core reports timings for delegated owners"],
    ["a non-object isolated latency advisory", (parts: Record<string, any>) => (parts["isolated.json"].performance.latencyAdvisory = "advisory"), "isolated owners are not a passing isolated-owner partition"],
    ["a core that delegates another gate set", (parts: Record<string, any>) => (parts["core.json"].delegated_gates = ["stress"]), "delegates gates other than verification-policy.yaml#isolated_owners"],
  ])("fails a delegating core on %s", (_label, mutate, violation) => {
    const result = assemble(
      partsDirectory((parts) => {
        delegate(parts);
        mutate(parts);
      }),
    );
    expect(result).toMatchObject({ status: "fail", gates: [] });
    expect(result.violation).toContain(violation);
  });

  // The assembler's own count agrees with each bad value, so only the
  // integer or the nonempty clause can refuse it.
  it.each([
    ["a zero inventory that the assembler also counts", 0],
    ["a fractional inventory that the assembler also counts", 1.5],
  ])("fails a delegating core on %s", (_label, files) => {
    const result = assemble(
      partsDirectory((parts) => {
        delegate(parts);
        parts["isolated.json"].gates[0].inventoryFiles = files;
      }),
      { ...OWNER_COUNTS, stress: files },
    );
    expect(result).toMatchObject({ status: "fail", gates: [] });
    expect(result.violation).toContain("isolated owners are not a passing isolated-owner partition");
  });

  it("requires an absolute partition directory", () => {
    expect(assembleDevelopmentConjunction({ repo: REPO_ROOT, directory: "relative", sourceIdentity: IDENTITY, sourceFiles: SOURCE_FILES }).violation).toContain("assemble requires an absolute AGENTERA_SOURCE_PARTITION_DIRECTORY");
  });
});

describe("partitioned development verification", () => {
  const core = { partition: { kind: "core", label: "core" }, resultFile: "/unused/core.json", sourceReportFile: "/unused/core-source.json" };

  it("keeps the full and development gate identities unchanged", () => {
    expect(sourceQualificationGateIdentity("full")).toBe("bd8c1ab86389d44e6bfecf6dd1d2b03230583f99837b725c772c916b644a753a");
    expect(sourceQualificationGateIdentity("development")).toBe("cb6611ee5f74788767d0322c423039c67284e507ac86c7bcd27ec1293fa80176");
  });

  it("reports a delegating core as partial and names the delegated gates", async () => {
    let observed: Record<string, unknown> | undefined;
    const result = await runSourceConjunction({
      profile: "development",
      sourcePartitionRequest: core,
      delegatedGates: ISOLATED,
      runDag: async (options: Record<string, unknown>) => {
        observed = options;
        return {
          gates: qualificationGates("development")
            .filter(({ name }: { name: string }) => !ISOLATED.includes(name))
            .map(({ name }: { name: string }) => ({ name, phase: "batch-a", outcome: "passed", elapsedMs: 1, origin: name, observation: {} })),
          execution: { generation: "g".repeat(64), sourceScope: { partition: "core", files: 2 }, delegatedGates: ISOLATED },
        };
      },
    });
    expect(result).toMatchObject({ status: "partial", delegated_gates: ISOLATED, gate_count: 11, performance: null });
    expect(result.gates).toHaveLength(8);
    expect(observed).toMatchObject({ delegatedGates: ISOLATED });
  });

  it.each([
    ["set", { AGENTERA_ISOLATED_OWNERS: "delegate" }, ISOLATED],
    ["unset", {}, undefined],
  ])("carries AGENTERA_ISOLATED_OWNERS %s from the verify command environment to the DAG", async (_label, delegation, expected) => {
    const directory = temporaryDirectory("agentera-delegation-test-");
    let observed: Record<string, any> | undefined;
    const result = await quietly(() =>
      runNoReceiptVerificationCommand(
        new Map<string, unknown>([
          ["--profile", "development"],
          ["--json", true],
        ]),
        {
          environment: { AGENTERA_SOURCE_PARTITION: "core", AGENTERA_SOURCE_PARTITION_DIRECTORY: directory, ...delegation },
          runDag: async (options: Record<string, any>) => {
            observed = options;
            return {
              gates: qualificationGates("development")
                .filter(({ name }: { name: string }) => !expected?.includes(name))
                .map(({ name }: { name: string }) => ({ name, phase: "batch-a", outcome: "passed", elapsedMs: 1, origin: name, observation: name === "performance" ? { evidence: { latencyAdvisory: {} } } : {} })),
              execution: { generation: "g".repeat(64), sourceScope: { partition: "core", files: 2 } },
            };
          },
        },
      ),
    );
    expect(observed?.delegatedGates).toEqual(expected);
    expect(result.status).toBe("partial");
    expect(result.delegated_gates).toEqual(expected);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "core.json"), "utf8")).delegated_gates).toEqual(expected);
  });

  it("refuses owner delegation outside the development core and on receipt and shard paths", async () => {
    const runDag = async () => {
      throw new Error("must not run");
    };
    await expect(runSourceConjunction({ profile: "full", delegatedGates: ISOLATED, runDag })).rejects.toThrow("AGENTERA_ISOLATED_OWNERS in verify requires the development profile with AGENTERA_SOURCE_PARTITION=core");
    await expect(runSourceConjunction({ profile: "development", delegatedGates: ISOLATED, runDag })).rejects.toThrow("AGENTERA_ISOLATED_OWNERS in verify requires the development profile with AGENTERA_SOURCE_PARTITION=core");
    await expect(issueSourceReceipt({ environment: { AGENTERA_ISOLATED_OWNERS: "delegate" }, runDag })).rejects.toThrow("source receipts require every owner on one host");
    const shard = await runSourceShard({
      environment: { AGENTERA_ISOLATED_OWNERS: "delegate" },
      sourcePartitionRequest: { partition: { kind: "shard", label: "shard-1", index: 1, count: 3 }, resultFile: "/unused/shard-1.json", sourceReportFile: "/unused/shard-1-source.json" },
      runConcurrent: async () => {
        throw new Error("must not run");
      },
    });
    expect(shard).toMatchObject({ status: "fail" });
    expect(shard.violation).toContain("verify-shard runs source files only and cannot delegate owners");
  });

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

describe("isolated-owner partition", () => {
  const inventoryCounts = { stress: 1, performance: 1, capacity: 3 };
  const checkout = sealGeneratedSourceIdentity({ schemaVersion: "agentera.generatedBuildSource.v1", commit: "1".repeat(40), tree: "2".repeat(40), files: 10, workingTreeSha256: "3".repeat(64) });

  // Each owner run advances the fixture clock by advance[owner] milliseconds.
  function isolatedOptions(fail?: string, overrides: Record<string, unknown> = {}, advance: Record<string, number> = {}) {
    const started: Array<{ names: string[]; command: string[]; deadline: string }> = [];
    const time = { now: 0 };
    const options = {
      repo: REPO_ROOT,
      clock: () => time.now,
      inventoryCounts,
      readSourceIdentity: () => checkout,
      runConcurrent: async (specifications: any[]) => {
        started.push({ names: specifications.map(({ name }) => name), command: specifications[0].command, deadline: specifications[0].environment.AGENTERA_SOURCE_DEADLINE_EPOCH_MS });
        const [{ name }] = specifications;
        time.now += advance[name] ?? 0;
        if (name === fail) throw Object.assign(new Error(`${name} failed`), { owner: name, sourceStatus: "failed" });
        return { [name]: { name, elapsedMs: 3, stdout: name === "performance" ? `${JSON.stringify(performanceEvidence("development"))}\n` : `${name} passed\n`, stderr: "" } };
      },
      ...overrides,
    };
    return { started, options, time };
  }

  function isolatedRun(fail?: string, overrides: Record<string, unknown> = {}, advance: Record<string, number> = {}) {
    const { started, options } = isolatedOptions(fail, overrides, advance);
    return { started, run: runIsolatedOwners(options) };
  }

  it("runs stress, then performance alone, then capacity against this host's complete inventories", async () => {
    const { started, run } = isolatedRun();
    const result = await run;
    expect(started.map(({ names }) => names)).toEqual([["stress"], ["performance"], ["capacity"]]);
    expect(started[1].command).toEqual(["pnpm", "-C", "packages/cli", "run", "test:development-resource"]);
    expect(result).toMatchObject({
      schemaVersion: "agentera.developmentIsolatedOwners.v1",
      status: "pass",
      gate_identity: sourceQualificationGateIdentity("development"),
      source_identity: checkout,
      gates: ISOLATED.map((name) => ({ name, outcome: "passed", inventoryFiles: inventoryCounts[name as keyof typeof inventoryCounts] })),
      execution: { elapsedMs: 0, stressElapsedMs: 0, performanceElapsedMs: 0, capacityElapsedMs: 0, unattributedElapsedMs: 0, reconciled: true },
    });
    expect(result.performance.latencyAdvisory).toBeTypeOf("object");
  });

  it("stops at the first failed owner and refuses a source partition", async () => {
    const { started, run } = isolatedRun("stress");
    expect(await run).toMatchObject({ status: "fail", first_failure: "stress", gates: [] });
    expect(started.map(({ names }) => names)).toEqual([["stress"]]);
    const partitioned = await runIsolatedOwners({
      environment: { AGENTERA_SOURCE_PARTITION: "core" },
      inventoryCounts,
      readSourceIdentity: () => checkout,
      runConcurrent: async () => {
        throw new Error("must not run");
      },
    });
    expect(partitioned.violation).toContain("verify-isolated runs complete owner inventories");
  });

  it.each([
    [
      "a source identity that changes during the run",
      () => {
        let reads = 0;
        const changed = sealGeneratedSourceIdentity({ schemaVersion: "agentera.generatedBuildSource.v1", commit: "1".repeat(40), tree: "2".repeat(40), files: 10, workingTreeSha256: "4".repeat(64) });
        return { readSourceIdentity: () => (reads++ === 0 ? checkout : changed) };
      },
      "isolated owner source identity changed during verification",
      3,
    ],
    [
      // Phases advance the clock; the final read rewinds it, so the phases
      // sum past the elapsed time.
      "phase timings that exceed the elapsed time",
      () => {
        let now = 0;
        let reads = 0;
        let rewound = false;
        return {
          clock: () => (rewound ? 0 : (now += 10)),
          readSourceIdentity: () => {
            if (reads++ > 0) rewound = true;
            return checkout;
          },
        };
      },
      "isolated owner phase timings do not reconcile",
      3,
    ],
    ["an inventory without capacity", () => ({ inventoryCounts: { stress: 1, performance: 1 } }), "isolated owner inventory is incomplete", 0],
    ["an empty stress inventory", () => ({ inventoryCounts: { ...inventoryCounts, stress: 0 } }), "isolated owner inventory is incomplete", 0],
  ])("fails the isolated owners on %s", async (_label, overrides, violation, owners) => {
    const { started, run } = isolatedRun(undefined, overrides());
    const result = await run;
    expect(result).toMatchObject({ status: "fail", first_failure: "isolated-owners", gates: [] });
    expect(result.violation).toContain(violation);
    expect(started).toHaveLength(owners);
  });

  it.each([
    ["stops before the next owner when no safe window remains", { stress: 1_000_000_000 }, "performance", "isolated owners have no safe performance execution window before reconciliation", 1],
    ["fails a run that exceeds the source verification budget", { capacity: 1_000_000_000 }, "isolated-owners", "isolated owners exceeded the", 3],
  ])("%s", async (_label, advance, owner, violation, owners) => {
    const { started, run } = isolatedRun(undefined, {}, advance);
    const result = await run;
    expect(result).toMatchObject({ status: "fail", first_failure: owner, gates: [] });
    expect(result.violation).toContain(violation);
    expect(started).toHaveLength(owners);
  });

  it("gives owners the deadline that remains after setup, not a fresh budget", async () => {
    const { started, options, time } = isolatedOptions();
    let reads = 0;
    const result = await runIsolatedOwners({
      ...options,
      wallClock: () => 1_000_000,
      // Setup before the first owner takes 5s of the budget.
      readSourceIdentity: () => {
        if (reads++ === 0) time.now += 5_000;
        return checkout;
      },
    });
    expect(result.status).toBe("pass");
    expect(started.map(({ deadline }) => Number(deadline))).toEqual(ISOLATED.map(() => 1_000_000 + result.execution.deadlineMs - 5_000));
  });

  it("refuses to overwrite an existing isolated-owner result", async () => {
    const directory = temporaryDirectory("agentera-isolated-test-");
    fs.writeFileSync(path.join(directory, "isolated.json"), "earlier\n");
    const { options } = isolatedOptions(undefined, { environment: { AGENTERA_SOURCE_PARTITION_DIRECTORY: directory } });
    await expect(quietly(() => runIsolatedOwnersCommand(new Map([["--json", true]]), options))).rejects.toThrow("EEXIST");
    expect(fs.readFileSync(path.join(directory, "isolated.json"), "utf8")).toBe("earlier\n");
  });

  it("writes the isolated-owner result into an absolute partition directory", async () => {
    const directory = temporaryDirectory("agentera-isolated-test-");
    const { options } = isolatedOptions(undefined, { environment: { AGENTERA_SOURCE_PARTITION_DIRECTORY: directory } });
    const result = await quietly(() => runIsolatedOwnersCommand(new Map([["--json", true]]), options));
    expect(result.status).toBe("pass");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "isolated.json"), "utf8"))).toEqual(result);
  });

  it.each([
    ["no", {}],
    ["a relative", { AGENTERA_SOURCE_PARTITION_DIRECTORY: "relative/isolated" }],
  ])("refuses verify-isolated with %s partition directory before any owner runs", async (_label, environment) => {
    const { started, options } = isolatedOptions(undefined, { environment });
    await expect(runIsolatedOwnersCommand(new Map(), options)).rejects.toThrow("verify-isolated requires an absolute AGENTERA_SOURCE_PARTITION_DIRECTORY");
    expect(started).toHaveLength(0);
  });
});
