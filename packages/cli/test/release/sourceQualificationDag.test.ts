import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  RELEASE_CONTRACT,
  runSourceQualificationDag,
} from "../../scripts/release-qualification.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const GATES = RELEASE_CONTRACT.qualification.source.gates;
const gate = (name: string) => GATES.find((entry: { name: string }) => entry.name === name)!;

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
  it("uses one overlap origin for four gates, isolated batch owners, then a parallel reader barrier", async () => {
    const started: Array<{ name: string; environment: NodeJS.ProcessEnv; reportFile: string }> = [];
    const cleaned: string[] = [];
    let stateReads = 0;
    const qualification = await runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
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
        started.push(specification);
        return {
          name: specification.name,
          cancellable: specification.cancellable,
          promise: Promise.resolve(result(specification.name)),
          cancel: () => undefined,
        };
      },
      readGeneratedState: () => {
        stateReads += 1;
        return { generation: "generation-a", leases: [] };
      },
    });

    expect(started.map(({ name }) => name)).toEqual([
      "generated-overlap", "stress", "performance", "typecheck",
      "compact", "capability-contract",
    ]);
    expect(started.map(({ name }) => name)).not.toEqual(expect.arrayContaining(["source", "package", "build"]));
    expect(started.slice(0, 4).every(({ name }) => !["compact", "capability-contract"].includes(name))).toBe(true);
    expect(new Set(started.map(({ environment }) => environment.HOME)).size).toBe(6);
    expect(new Set(started.map(({ environment }) => environment.NPM_CONFIG_CACHE)).size).toBe(6);
    expect(new Set(started.map(({ environment }) => environment.NPM_CONFIG_USERCONFIG)).size).toBe(6);
    expect(new Set(started.map(({ environment }) => environment.NPM_CONFIG_GLOBALCONFIG)).size).toBe(6);
    expect(new Set(started.map(({ reportFile }) => reportFile)).size).toBe(6);
    expect(cleaned).toHaveLength(6);
    expect(stateReads).toBe(2);
    expect(qualification.gates.map((entry: any) => entry.name)).toEqual(GATES.map((entry: any) => entry.name));
    expect(qualification.gates.filter((entry: any) => entry.origin === "generated-overlap").map((entry: any) => entry.name))
      .toEqual(["source", "package", "generated-overlap", "build"]);
    expect(qualification.gates.find((entry: any) => entry.name === "source").observation)
      .toMatchObject({ command: gate("source").command, files: 10, tests: 40, pending: [] });
    expect(qualification.gates.find((entry: any) => entry.name === "performance").observation)
      .toMatchObject({ inventoryFiles: 3, evidence: { status: "pass", samples: 1 } });
    expect(qualification.gates.filter((entry: any) => entry.phase === "barrier-b").map((entry: any) => entry.name))
      .toEqual(["compact", "capability-contract"]);
    expect(qualification.execution).toMatchObject({
      strategy: "parallel-overlap-dag",
      generation: "generation-a",
      leasesAfterBarrier: 0,
    });
  });

  it("preserves the first peer failure, cancels cancellable groups, settles overlap, and blocks barrier B", async () => {
    const started: string[] = [];
    const cancelled: string[] = [];
    let overlapSettled = false;
    const pending = new Map<string, (error: Error) => void>();
    const promiseFor = (name: string) => {
      if (name === "generated-overlap") {
        return new Promise((resolve) => setTimeout(() => {
          overlapSettled = true;
          resolve(result(name));
        }, 10));
      }
      if (name === "stress") return Promise.reject(ownerError("stress", "stress failed first"));
      return new Promise((_resolve, reject) => pending.set(name, reject));
    };

    await expect(runSourceQualificationDag({
      repo: REPO_ROOT,
      gates: GATES,
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
        expect.objectContaining({ name: "performance", status: "cancelled" }),
        expect.objectContaining({ name: "typecheck", status: "cancelled" }),
      ]),
      completed: ["generated-overlap"],
    });
    expect(overlapSettled).toBe(true);
    expect(cancelled).toEqual(expect.arrayContaining(["performance", "typecheck"]));
    expect(cancelled).not.toContain("generated-overlap");
    expect(started).not.toEqual(expect.arrayContaining(["compact", "capability-contract"]));
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
    expect(started.slice(-2)).toEqual(["compact", "capability-contract"]);
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
      readGeneratedState: () => reads++ === 0
        ? { generation: "generation-a", leases: [] }
        : { generation: "generation-b", leases: ["reader.lease"] },
    })).rejects.toMatchObject({
      owner: "reader-barrier",
      message: "barrier B changed the selected generation or retained leases",
    });
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
    expect(RELEASE_CONTRACT.qualification.source.dag).toMatchObject({
      batchA: policy.release_qualification.batch_a,
      generatedOverlapOrigins: policy.release_qualification.generated_overlap_origins,
      barrierB: policy.release_qualification.barrier_b,
    });
  });
});
