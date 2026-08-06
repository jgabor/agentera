import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  RELEASE_CONTRACT,
  runSourceQualificationDag,
} from "../../scripts/release-qualification.mjs";
import { runGeneratedOverlap } from "../../scripts/verify-generated-overlap.mjs";
import { observationDigest } from "../../src/validate/activationArtifactEvidence.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const GATES = RELEASE_CONTRACT.qualification.source.gates;
const gate = (name: string) => GATES.find((entry: { name: string }) => entry.name === name)!;

function packageIdentity() {
  const unsigned = {
    schemaVersion: "agentera.activationPackageIdentity.v1",
    packageEvidenceDigest: "c".repeat(64),
    packageArtifact: {
      filename: "agentera-3.0.0-dev.42.tgz",
      integrity: `sha512-${"A".repeat(86)}==`,
      shasum: "1".repeat(40),
      tarballSha256: "2".repeat(64),
    },
    packageArtifactObservationDigest: "3".repeat(64),
    extractedTree: { count: 1, digest: "4".repeat(64) },
    tarballTree: { count: 1, digest: "5".repeat(64) },
  };
  return { ...unsigned, identityDigest: observationDigest(unsigned) };
}

function overlapEvidence() {
  return {
    schemaVersion: "agentera.generatedOverlapEvidence.v1",
    status: "pass",
    inventory: { source: 10, package: 4, stress: 1, performance: 3 },
    participants: {
      source: { command: gate("source").command, elapsedMs: 80, files: 10, tests: 40, pending: [] },
      package: { command: gate("package").command, elapsedMs: 70, files: 4, tests: 12, pending: [] },
      build: { command: gate("build").command, elapsedMs: 30, status: "pass" },
    },
    reader: {
      observed: true,
      all_observations_complete: true,
      identity_mismatches: 0,
      surface_validation_failures: 0,
      generations: ["generation-a"],
    },
    generation: "generation-a",
    activation_evidence: {
      digest: "a".repeat(64),
      checks: 42,
      path: "packages/cli/.agentera-generated/generations/generation-a/activation-evidence.json",
      package_identity: packageIdentity(),
      package_snapshot: {
        schemaVersion: "agentera.activationPackageSnapshot.v1",
        path: ".activation-package-snapshot",
        identityDigest: packageIdentity().identityDigest,
      },
      child_evidence: {
        source: { path: `source-owner-${"b".repeat(64)}.json`, digest: "b".repeat(64) },
        package: { path: `package-owner-${"c".repeat(64)}.json`, digest: "c".repeat(64) },
        packageIdentity: { path: `package-identity-${packageIdentity().identityDigest}.json`, digest: packageIdentity().identityDigest },
        generated: { path: "embedded:generated-owner", digest: "d".repeat(64) },
      },
    },
    invocation: "3.0.0-dev.41",
  };
}

function performanceStdout() {
  return `${JSON.stringify({
    schemaVersion: "agentera.entityAuthorityPerformanceEvidence.v1",
    status: "pass",
    runner: { node: process.version },
    samples: [{ status: "pass" }],
    maxima: { exact_get: { maxElapsedMs: 1 } },
  })}\n`;
}

function result(name: string) {
  return {
    name,
    elapsedMs: 10,
    stdout: name === "generated-overlap"
      ? JSON.stringify(overlapEvidence())
      : name === "performance"
        ? performanceStdout()
        : `${name} passed\n`,
    stderr: "",
  };
}

function ownerError(name: string, detail: string, status = "failed") {
  const error = new Error(detail) as Error & { owner?: string; sourceStatus?: string };
  error.owner = name;
  error.sourceStatus = status;
  return error;
}

describe("source qualification DAG", () => {
  it("runs performance alone after overlap batch A and before the parallel reader barrier", async () => {
    const started: Array<{ name: string; environment: NodeJS.ProcessEnv; reportFile: string; concurrentWith: string[] }> = [];
    const cleaned: string[] = [];
    const active = new Set<string>();
    let stateReads = 0;
    const qualification = await runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
      clock: () => 0,
      wallClock: () => 1_000,
      createState: (name: string) => ({
        root: `/isolated/${name}`,
        environment: {
          HOME: `/isolated/${name}/home`,
          NPM_CONFIG_CACHE: `/isolated/${name}/cache`,
          NPM_CONFIG_USERCONFIG: `/isolated/${name}/user.npmrc`,
          NPM_CONFIG_GLOBALCONFIG: `/isolated/${name}/global.npmrc`,
        },
        cleanup: () => cleaned.push(name),
      }),
      startOwner: (specification: any) => {
        started.push({ ...specification, concurrentWith: [...active] });
        active.add(specification.name);
        return {
          name: specification.name,
          cancellable: specification.cancellable,
          promise: Promise.resolve(result(specification.name)).finally(() => active.delete(specification.name)),
          cancel: () => undefined,
        };
      },
      readGeneratedState: () => {
        stateReads += 1;
        return { generation: "generation-a", leases: [] };
      },
    });

    expect(started.map(({ name }) => name)).toEqual([
      "generated-overlap", "stress", "typecheck", "performance",
      "compact", "capability-contract", "activation-conjunction",
    ]);
    expect(started.map(({ name }) => name)).not.toEqual(expect.arrayContaining(["source", "package", "build"]));
    expect(started[0]).toMatchObject({
      name: "generated-overlap",
      timeoutMs: 410_000,
      cooperativeStop: true,
      environment: {
        AGENTERA_SOURCE_DEADLINE_EPOCH_MS: "421000",
        AGENTERA_SOURCE_CLEANUP_MARGIN_MS: "10000",
      },
    });
    expect(started.slice(0, 3).every(({ name }) => !["performance", "compact", "capability-contract", "activation-conjunction"].includes(name))).toBe(true);
    expect(started.find(({ name }) => name === "performance")).toMatchObject({
      timeoutMs: 416_000,
      concurrentWith: [],
      environment: { AGENTERA_SOURCE_DEADLINE_EPOCH_MS: "421000" },
    });
    expect(started.filter(({ name }) => ["compact", "capability-contract", "activation-conjunction"].includes(name)).map(({ name, timeoutMs }) => ({ name, timeoutMs }))).toEqual([
      { name: "compact", timeoutMs: 416_000 },
      { name: "capability-contract", timeoutMs: 416_000 },
      { name: "activation-conjunction", timeoutMs: 416_000 },
    ]);
    expect(started.find(({ name }) => name === "activation-conjunction")?.environment).toMatchObject({
      AGENTERA_ACTIVATION_GENERATION_ID: "generation-a",
      AGENTERA_ACTIVATION_EVIDENCE_DIGEST: "a".repeat(64),
      AGENTERA_ACTIVATION_PACKAGE_IDENTITY: JSON.stringify(packageIdentity()),
    });
    expect(new Set(started.map(({ environment }) => environment.HOME)).size).toBe(7);
    expect(new Set(started.map(({ environment }) => environment.NPM_CONFIG_CACHE)).size).toBe(7);
    expect(new Set(started.map(({ environment }) => environment.NPM_CONFIG_USERCONFIG)).size).toBe(7);
    expect(new Set(started.map(({ environment }) => environment.NPM_CONFIG_GLOBALCONFIG)).size).toBe(7);
    expect(new Set(started.map(({ reportFile }) => reportFile)).size).toBe(7);
    expect(cleaned).toHaveLength(7);
    expect(stateReads).toBe(3);
    expect(qualification.gates.map((entry: any) => entry.name)).toEqual(GATES.map((entry: any) => entry.name));
    expect(qualification.gates.every((entry: any) => entry.outcome === "passed")).toBe(true);
    expect(qualification.gates.filter((entry: any) => entry.origin === "generated-overlap").map((entry: any) => entry.name))
      .toEqual(["source", "package", "generated-overlap", "build"]);
    expect(qualification.gates.find((entry: any) => entry.name === "source").observation)
      .toMatchObject({ command: gate("source").command, files: 10, tests: 40, pending: [] });
    expect(qualification.gates.find((entry: any) => entry.name === "performance").observation)
      .toMatchObject({ inventoryFiles: 3, evidence: { status: "pass", samples: 1 } });
    expect(qualification.gates.find((entry: any) => entry.name === "performance").phase)
      .toBe("performance-barrier");
    expect(qualification.gates.filter((entry: any) => entry.phase === "barrier-b").map((entry: any) => entry.name))
      .toEqual(["compact", "capability-contract", "activation-conjunction"]);
    expect(qualification.execution).toMatchObject({
      strategy: "parallel-overlap-dag",
      overlapCleanupMarginMs: 10_000,
      overlapParentReconciliationMarginMs: 4_000,
      generation: "generation-a",
      leasesAfterBarrier: 0,
    });
  });

  it("preserves the first peer failure, cancels cancellable groups, settles overlap, and blocks barrier B", async () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    let overlapSettled = false;
    let now = 0;
    const pending = new Map<string, (error: Error) => void>();
    const stressFailure = Promise.reject(ownerError("stress", "stress failed first"));
    const overlapTimeout = new Promise((_resolve, reject) => {
      stressFailure.catch(() => queueMicrotask(() => {
        now = 291_000;
        overlapSettled = true;
        reject(ownerError("generated-overlap", "overlap cooperatively timed out after cleanup"));
      }));
    });
    const promiseFor = (name: string) => {
      if (name === "generated-overlap") return overlapTimeout;
      if (name === "stress") return stressFailure;
      return new Promise((_resolve, reject) => pending.set(name, reject));
    };

    await expect(runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
      clock: () => now,
      wallClock: () => 1_000,
      createState: (name: string) => ({ root: `/isolated/${name}`, environment: {}, cleanup: () => undefined }),
      startOwner: (specification: any) => {
        started.push(specification.name);
        return {
          name: specification.name,
          cancellable: specification.cancellable,
          promise: promiseFor(specification.name),
          cancel: () => {
            cancelled.push(specification.name);
            pending.get(specification.name)?.(ownerError(specification.name, "cancelled", "cancelled"));
          },
        };
      },
      readGeneratedState: () => {
        throw new Error("barrier state must not be read after batch failure");
      },
    })).rejects.toMatchObject({
      owner: "stress",
      firstFailure: { name: "stress", detail: "stress failed first" },
      failures: expect.arrayContaining([
        expect.objectContaining({ name: "stress", status: "failed" }),
        expect.objectContaining({ name: "generated-overlap", status: "failed" }),
        expect.objectContaining({ name: "typecheck", status: "cancelled" }),
      ]),
      completed: [],
    });
    expect(overlapSettled).toBe(true);
    expect(cancelled).toContain("typecheck");
    expect(cancelled).not.toContain("generated-overlap");
    expect(started).not.toEqual(expect.arrayContaining(["performance", "compact", "capability-contract"]));
  });

  it("blocks readers when the solo performance barrier times out", async () => {
    const started: string[] = [];
    const cleaned: string[] = [];
    let stateReads = 0;
    await expect(runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
      createState: (name: string) => ({
        root: `/isolated/${name}`,
        environment: { HOME: `/isolated/${name}/home` },
        cleanup: () => cleaned.push(name),
      }),
      startOwner: (specification: any) => {
        started.push(specification.name);
        return {
          name: specification.name,
          cancellable: specification.cancellable,
          promise: specification.name === "performance"
            ? Promise.reject(ownerError("performance", "performance exceeded its remaining source deadline"))
            : Promise.resolve(result(specification.name)),
          cancel: () => undefined,
        };
      },
      readGeneratedState: () => {
        stateReads += 1;
        return { generation: "generation-a", leases: [] };
      },
    })).rejects.toMatchObject({
      owner: "performance",
      firstFailure: {
        name: "performance",
        detail: "performance exceeded its remaining source deadline",
      },
    });
    expect(started).toEqual(["generated-overlap", "stress", "typecheck", "performance"]);
    expect(cleaned).toEqual(expect.arrayContaining(["generated-overlap", "stress", "typecheck", "performance"]));
    expect(new Set(cleaned).size).toBe(4);
    expect(stateReads).toBe(1);
  });

  it("blocks receipt completion when a post-build reader fails and cancels its peer", async () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    let rejectCapability: ((error: Error) => void) | undefined;
    await expect(runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
      createState: (name: string) => ({ root: `/isolated/${name}`, environment: {}, cleanup: () => undefined }),
      startOwner: (specification: any) => {
        started.push(specification.name);
        const promise = specification.name === "compact"
          ? Promise.reject(ownerError("compact", "compact reader failed"))
          : specification.name === "capability-contract"
            ? new Promise((_resolve, reject) => { rejectCapability = reject; })
            : Promise.resolve(result(specification.name));
        return {
          name: specification.name,
          cancellable: specification.cancellable,
          promise,
          cancel: () => {
            cancelled.push(specification.name);
            rejectCapability?.(ownerError(specification.name, "cancelled", "cancelled"));
          },
        };
      },
      readGeneratedState: () => ({ generation: "generation-a", leases: [] }),
    })).rejects.toMatchObject({
      owner: "compact",
      firstFailure: { name: "compact", detail: "compact reader failed" },
      failures: expect.arrayContaining([
        expect.objectContaining({ name: "compact", status: "failed" }),
        expect.objectContaining({ name: "capability-contract", status: "cancelled" }),
      ]),
    });
    expect(started.slice(-3)).toEqual(["compact", "capability-contract", "activation-conjunction"]);
    expect(cancelled).toContain("capability-contract");
  });

  it("rejects a reader barrier that changes generation or leaves a lease", async () => {
    let reads = 0;
    await expect(runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
      createState: (name: string) => ({ root: `/isolated/${name}`, environment: {}, cleanup: () => undefined }),
      startOwner: (specification: any) => ({
        name: specification.name,
        cancellable: specification.cancellable,
        promise: Promise.resolve(result(specification.name)),
        cancel: () => undefined,
      }),
      readGeneratedState: () => reads++ < 2
        ? { generation: "generation-a", leases: [] }
        : { generation: "generation-b", leases: ["reader.lease"] },
    })).rejects.toMatchObject({
      owner: "reader-barrier",
      message: "barrier B changed the selected generation or retained leases",
    });
  });

  it.each([
    ["starts at the exact concurrent allocation boundary", 410_000, "pass"],
    ["fails before starting below the allocation boundary", 410_001, "fail"],
  ])("%s", async (_label, afterPerformance, expected) => {
    let now = 0;
    const phases: string[][] = [];
    const runConcurrent = async (specifications: any[]) => {
      phases.push(specifications.map(({ name }) => name));
      const values = Object.fromEntries(specifications.map(({ name, timeoutMs }) => [name, { ...result(name), timeoutMs }]));
      if (specifications[0]?.name === "performance") now = afterPerformance;
      return values;
    };
    const operation = runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
      clock: () => now,
      wallClock: () => 1_000,
      runConcurrent,
      readGeneratedState: () => ({ generation: "generation-a", leases: [] }),
    });
    if (expected === "pass") {
      const qualification = await operation;
      expect(phases.at(-1)).toEqual(["compact", "capability-contract", "activation-conjunction"]);
      expect(qualification.execution.unattributedElapsedMs).toBeGreaterThanOrEqual(0);
    } else {
      await expect(operation).rejects.toMatchObject({
        owner: "reader-barrier",
        message: "source qualification requires 6000ms for barrier B plus 4000ms reconciliation; 9999ms remain",
      });
      expect(phases).toHaveLength(2);
    }
  });

  it("uses a fake deadline to stop starting overlap work and clean owned generated state before handoff", async () => {
    let now = 1_000;
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-deadline-test-"));
    fs.mkdirSync(path.join(workRoot, "barrier"));
    const started: string[] = [];
    const cleanupAt: number[] = [];
    let rejected: ((error: Error) => void) | undefined;
    let cancelled = false;
    try {
      await expect(runGeneratedOverlap({
        contract: RELEASE_CONTRACT,
        environment: {
          AGENTERA_SOURCE_DEADLINE_EPOCH_MS: "301000",
          AGENTERA_SOURCE_CLEANUP_MARGIN_MS: "10000",
        },
        now: () => now,
        workRoot,
        retainFailureArtifacts: false,
        handleSignals: false,
        policyBytes: Buffer.from("policy"),
        loadInventory: () => ({ counts: {}, files: {} }),
        cleanupGenerated: () => cleanupAt.push(now),
        startParticipant: (name: string) => {
          started.push(name);
          now = 291_000;
          return {
            name,
            promise: new Promise((_resolve, reject) => { rejected = reject; }),
            cancel: () => {
              if (cancelled) return;
              cancelled = true;
              now += 100;
              rejected?.(ownerError("generated-overlap", "source cancelled", "cancelled"));
            },
          };
        },
        withDeadline: async (promise: Promise<unknown>) => promise,
      })).rejects.toMatchObject({
        owner: "generated-overlap",
        message: "generated-overlap deadline expired before starting build",
      });
      expect(started).toEqual(["source"]);
      expect(cleanupAt).toEqual([1_000, 291_100]);
      expect(now).toBeLessThan(297_000);
      expect(fs.existsSync(workRoot)).toBe(false);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("bounds blocked overlap settlement, cancels every owned child, and skips later reader evidence", async () => {
    let now = 1_000;
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-blocked-test-"));
    fs.mkdirSync(path.join(workRoot, "barrier"));
    const cancelled: string[] = [];
    const cleanupAt: number[] = [];
    const deferred = new Map<string, (error: Error) => void>();
    let evidenceReads = 0;
    try {
      await expect(runGeneratedOverlap({
        contract: RELEASE_CONTRACT,
        environment: {
          AGENTERA_SOURCE_DEADLINE_EPOCH_MS: "301000",
          AGENTERA_SOURCE_CLEANUP_MARGIN_MS: "10000",
        },
        now: () => now,
        workRoot,
        retainFailureArtifacts: false,
        handleSignals: false,
        policyBytes: Buffer.from("policy"),
        loadInventory: () => ({ counts: {}, files: {} }),
        cleanupGenerated: () => cleanupAt.push(now),
        waitForReady: async () => undefined,
        startReader: () => ({
          stop: () => undefined,
          evidence: () => {
            evidenceReads += 1;
            return { observed: true, identityMismatches: 0, surfaceValidationFailures: 0, generations: [] };
          },
        }),
        startParticipant: (name: string) => ({
          name,
          promise: new Promise((_resolve, reject) => deferred.set(name, reject)),
          cancel: () => {
            if (cancelled.includes(name)) return;
            cancelled.push(name);
            now += 100;
            deferred.get(name)?.(ownerError("generated-overlap", `${name} cancelled`, "cancelled"));
          },
        }),
        withDeadline: async (promise: Promise<unknown>, _deadline: number, label: string) => {
          if (label === "source/build/package settlement") {
            now = 291_000;
            throw ownerError("generated-overlap", "overlap work exceeded its cooperative deadline");
          }
          return promise;
        },
        readOwnerResult: () => {
          evidenceReads += 1;
          throw new Error("late evidence must not run");
        },
      })).rejects.toMatchObject({
        owner: "generated-overlap",
        message: "overlap work exceeded its cooperative deadline",
      });
      expect(cancelled.sort()).toEqual(["build", "package", "source"]);
      expect(cleanupAt).toEqual([1_000, 291_300]);
      expect(evidenceReads).toBe(0);
      expect(now).toBeLessThan(297_000);
      expect(fs.existsSync(workRoot)).toBe(false);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("returns complete overlap evidence through the cooperative runner success path", async () => {
    let now = 1_000;
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlap-success-test-"));
    fs.mkdirSync(path.join(workRoot, "barrier"));
    const started: string[] = [];
    const cleanupAt: number[] = [];
    const inventory = {
      counts: { source: 1, package: 1, stress: 1, performance: 1 },
      files: { source: ["source.test.ts"], package: ["package.test.ts"] },
    };
    try {
      const evidence = await runGeneratedOverlap({
        contract: RELEASE_CONTRACT,
        environment: {
          AGENTERA_SOURCE_DEADLINE_EPOCH_MS: "301000",
          AGENTERA_SOURCE_CLEANUP_MARGIN_MS: "10000",
        },
        now: () => now,
        workRoot,
        handleSignals: false,
        policyBytes: Buffer.from("policy"),
        loadInventory: () => inventory,
        cleanupGenerated: () => cleanupAt.push(now),
        waitForReady: async () => undefined,
        startReader: () => ({
          stop: () => undefined,
          evidence: () => ({
            observed: true,
            identityMismatches: 0,
            surfaceValidationFailures: 0,
            generations: ["generation-a"],
          }),
        }),
        startParticipant: (name: string, command: string[]) => {
          started.push(name);
          now += 10;
          return {
            name,
            promise: Promise.resolve({ command, elapsedMs: 10, stdout: name === "invocation" ? "3.0.0-dev.41" : "" }),
            cancel: () => undefined,
          };
        },
        withDeadline: async (promise: Promise<unknown>) => promise,
        readOwnerResult: () => ({ files: 1, tests: 1, pending: [] }),
        selectGeneration: () => ({ id: "generation-a" }),
        writeActivationEvidence: async () => ({
          path: "activation-evidence.json",
          digest: "a".repeat(64),
          checks: 42,
          packageIdentity: packageIdentity(),
          packageSnapshot: {
            schemaVersion: "agentera.activationPackageSnapshot.v1",
            path: ".activation-package-snapshot",
            identityDigest: packageIdentity().identityDigest,
          },
        }),
      });
      expect(evidence).toMatchObject({
        schemaVersion: "agentera.generatedOverlapEvidence.v1",
        status: "pass",
        generation: "generation-a",
        activation_evidence: {
          digest: "a".repeat(64),
          checks: 42,
          package_identity: packageIdentity(),
          package_snapshot: {
            schemaVersion: "agentera.activationPackageSnapshot.v1",
            path: ".activation-package-snapshot",
            identityDigest: packageIdentity().identityDigest,
          },
        },
        invocation: "3.0.0-dev.41",
        participants: {
          source: { command: gate("source").command, elapsedMs: 10 },
          package: { command: gate("package").command, elapsedMs: 10 },
          build: { command: gate("build").command, elapsedMs: 10, status: "pass" },
        },
      });
      expect(started).toEqual(["source", "build", "package", "invocation"]);
      expect(cleanupAt).toEqual([1_000]);
      expect(fs.existsSync(workRoot)).toBe(false);
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  });

  it("locks generated-overlap to the exact public source, build, and package commands", () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/scripts/verify-generated-overlap.mjs"), "utf8");
    const policy = YAML.parse(fs.readFileSync(
      path.join(REPO_ROOT, "references/analysis/verification-policy.yaml"),
      "utf8",
    ));
    expect(script).toContain('source: ["pnpm", "-C", "packages/cli", "run", "test:source"]');
    expect(script).toContain('build: ["pnpm", "-C", "packages/cli", "build"]');
    expect(script).toContain('package: ["pnpm", "-C", "packages/cli", "run", "verify:package"]');
    expect(script).toContain('schemaVersion: "agentera.generatedOverlapEvidence.v1"');
    expect(RELEASE_CONTRACT.qualification.source.performanceEvidenceSchema)
      .toBe(policy.owners.performance.evidence.schema_version);
    expect(policy.release_qualification).toMatchObject({
      schedule_authority: "references/adapters/package-publication.json#qualification.source.dag",
      deadline_authority: "references/adapters/package-publication.json#benchmark.timeouts.sourceQualificationMs",
    });
    expect(policy.release_qualification).not.toHaveProperty("batch_a");
    expect(policy.release_qualification).not.toHaveProperty("barrier_b");
  });
});
