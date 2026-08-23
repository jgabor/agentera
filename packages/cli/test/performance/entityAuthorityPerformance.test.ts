import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import { measureColdCli, measureColdStateList } from "../helpers/coldCliMeasurement.js";
import { createEntityAuthorityFixture } from "../helpers/entityAuthorityFixture.js";
import { performanceRunnerAuthority } from "../../scripts/performance-evidence.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const POLICY_PATH = path.join(REPO_ROOT, "references/analysis/verification-policy.yaml");

let tmp: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

function measurementDiagnostic(
  label: string,
  measured: Awaited<ReturnType<typeof measureColdCli>>,
): string {
  return `${label}: ${JSON.stringify({
    baselineHeapBytes: measured.baselineHeapBytes,
    peakHeapBytes: measured.peakHeapBytes,
    heapDeltaBytes: measured.heapDeltaBytes,
    inspectorSamples: measured.inspectorSamples,
    baselineNormalization: measured.baselineNormalization,
    runtime: measured.runtime,
  })}`;
}

function capture(fn: (out: (text: string) => void, err: (text: string) => void) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  return {
    rc: fn(
      (text) => (out += text),
      (text) => (err += text),
    ),
    out,
    err,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "entity-authority-performance-"));
  project = path.join(tmp, "project");
  home = path.join(tmp, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  previousCwd = process.cwd();
  previousEnv = {
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    HOME: process.env.HOME,
  };
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
  process.env.HOME = home;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("entity authority performance", () => {
  it("measures every declared scale and target through five cold processes", async () => {
    const authority = YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
    const policy = YAML.parse(fs.readFileSync(POLICY_PATH, "utf8")) as Record<string, any>;
    const measurementContract = authority.entity_target.measurement_contract;
    const targets = measurementContract.targets;
    const repetitions = measurementContract.sampling.repetitions as number;
    const scales = Object.fromEntries(
      ["small", "large", "archive_small", "archive_large"].map((scale) => [
        scale,
        Number(String(measurementContract.fixtures[scale]).match(/^\d+/)?.[0]),
      ]),
    ) as Record<"small" | "large" | "archive_small" | "archive_large", number>;
    const samples: Array<Record<string, number | string>> = [];
    const fixtures: Record<string, unknown> = {};
    let runtime: Awaited<ReturnType<typeof measureColdCli>>["runtime"] | undefined;

    expect(measurementContract.environment).toContain("one cold CLI process per sample");
    expect(repetitions).toBe(5);
    expect(scales).toEqual({ small: 100, large: 1000, archive_small: 100, archive_large: 1000 });

    for (const scale of ["small", "large"] as const) {
      const entities = scales[scale];
      const fixture = createEntityAuthorityFixture(project, entities, authority);
      const declaredBoundaries = (
        authority.entity_target.entities as Array<Record<string, string>>
      ).map(({ boundary }) => boundary);
      const declaredRelationships = (
        authority.entity_target.relationships.declarations as Array<Record<string, string>>
      ).map(({ source, field, target }) => `${source}.${field}->${target}`);
      expect(Object.keys(fixture.boundaryCounts)).toEqual(declaredBoundaries);
      expect(Object.values(fixture.boundaryCounts).every((count) => count > 0)).toBe(true);
      expect(Object.values(fixture.boundaryCounts).reduce((sum, count) => sum + count, 0)).toBe(
        entities,
      );
      expect(fixture.relationshipEdges).toEqual(declaredRelationships);
      const validated = capture((out, err) =>
        main(["node", "agentera", "check", "validate", "state", "--format", "json"], { out, err }),
      );
      expect(validated.rc, validated.out || validated.err).toBe(0);
      fixtures[scale] = {
        entities,
        boundaryCounts: fixture.boundaryCounts,
        relationshipEdges: fixture.relationshipEdges,
      };

      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const operation of ["startup", "bounded_list"] as const) {
          const args =
            operation === "startup"
              ? ["prime", "--dashboard", "--format", "json"]
              : ["state", "progress", "list", "--limit", "100", "--format", "json"];
          const limits = targets[`${operation}_${scale}`];
          const measured = await measureColdCli({ args, project, home, repoRoot: REPO_ROOT });
          runtime ??= measured.runtime;
          expect(measured.runtime).toEqual(runtime);
          const outputBytes = Buffer.byteLength(measured.stdout, "utf8");
          const maxOutputBytes =
            operation === "startup"
              ? authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes
              : limits.max_utf8_bytes;
          expect(
            measured.elapsedMs,
            measurementDiagnostic(`${operation} ${scale} repetition ${repetition}`, measured),
          ).toBeLessThanOrEqual(limits.max_latency_ms);
          expect(
            measured.heapDeltaBytes,
            measurementDiagnostic(`${operation} ${scale} repetition ${repetition}`, measured),
          ).toBeLessThanOrEqual(limits.max_heap_delta_bytes);
          expect(outputBytes, `${operation} ${scale} repetition ${repetition}`).toBeLessThanOrEqual(
            maxOutputBytes,
          );
          if (operation === "bounded_list")
            expect(JSON.parse(measured.stdout).counts.total).toBe(fixture.progressCount);
          samples.push({
            operation,
            scale,
            entities,
            repetition,
            status: "pass",
            elapsedMs: measured.elapsedMs,
            heapDeltaBytes: measured.heapDeltaBytes,
            peakHeapBytes: measured.peakHeapBytes,
            baselineHeapBytes: measured.baselineHeapBytes,
            outputBytes,
            inspectorSamples: measured.inspectorSamples,
          });
        }
      }
      if (scale === "large") {
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          const measured = await measureColdCli({
            args: ["state", "progress", "get", "--id", fixture.exactId, "--format", "json"],
            project,
            home,
            repoRoot: REPO_ROOT,
          });
          runtime ??= measured.runtime;
          expect(measured.runtime).toEqual(runtime);
          const outputBytes = Buffer.byteLength(measured.stdout, "utf8");
          expect(
            measured.elapsedMs,
            measurementDiagnostic(`exact_get repetition ${repetition}`, measured),
          ).toBeLessThanOrEqual(
            targets.exact_get.max_latency_ms,
          );
          expect(
            measured.heapDeltaBytes,
            measurementDiagnostic(`exact_get repetition ${repetition}`, measured),
          ).toBeLessThanOrEqual(
            targets.exact_get.max_heap_delta_bytes,
          );
          expect(outputBytes, `exact_get repetition ${repetition}`).toBeLessThanOrEqual(
            targets.exact_get.max_utf8_bytes,
          );
          expect(JSON.parse(measured.stdout).entry.id).toBe(fixture.exactId);
          samples.push({
            operation: "exact_get",
            scale,
            entities,
            repetition,
            status: "pass",
            elapsedMs: measured.elapsedMs,
            heapDeltaBytes: measured.heapDeltaBytes,
            peakHeapBytes: measured.peakHeapBytes,
            baselineHeapBytes: measured.baselineHeapBytes,
            outputBytes,
            inspectorSamples: measured.inspectorSamples,
          });
        }
      }
    }

    for (const scale of ["small", "large"] as const) {
      const entries = scales[`archive_${scale}`];
      const archiveProject = path.join(tmp, `archive-${scale}`);
      fs.mkdirSync(archiveProject, { recursive: true });
      for (let number = 1; number <= entries; number += 1) {
        publishNumberedArchive(archiveProject, "progress", number, {
          number,
          timestamp: "2026-07-13 16:00",
          type: "test",
          phase: "build",
          what: `Archive fixture ${number}`,
          context: { intent: "Measure archive enumeration" },
        }, { sourceRoot: REPO_ROOT });
      }
      fixtures[`archive_${scale}`] = { entries };
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const limits = targets[`archive_list_${scale}`];
        const measured = await measureColdStateList({ project: archiveProject, repoRoot: REPO_ROOT });
        runtime ??= measured.runtime;
        expect(measured.runtime).toEqual(runtime);
        const outputBytes = Buffer.byteLength(measured.stdout, "utf8");
        expect(measured.elapsedMs, measurementDiagnostic(`archive_list ${scale} repetition ${repetition}`, measured)).toBeLessThanOrEqual(limits.max_latency_ms);
        expect(measured.heapDeltaBytes, measurementDiagnostic(`archive_list ${scale} repetition ${repetition}`, measured)).toBeLessThanOrEqual(limits.max_heap_delta_bytes);
        expect(outputBytes).toBeLessThanOrEqual(limits.max_utf8_bytes);
        expect(JSON.parse(measured.stdout).counts.total).toBe(entries);
        samples.push({
          operation: "archive_list",
          scale,
          entries,
          repetition,
          status: "pass",
          elapsedMs: measured.elapsedMs,
          heapDeltaBytes: measured.heapDeltaBytes,
          peakHeapBytes: measured.peakHeapBytes,
          baselineHeapBytes: measured.baselineHeapBytes,
          outputBytes,
          inspectorSamples: measured.inspectorSamples,
        });
      }
    }

    const targetNames = Object.keys(targets);
    const maxima = Object.fromEntries(
      targetNames.map((targetName) => {
        const targetSamples = samples.filter((sample) =>
          targetName === "exact_get"
            ? sample.operation === "exact_get"
            : `${sample.operation}_${sample.scale}` === targetName,
        );
        return [
          targetName,
          {
            repetitions: targetSamples.length,
            maxElapsedMs: Math.max(...targetSamples.map((sample) => Number(sample.elapsedMs))),
            maxHeapDeltaBytes: Math.max(
              ...targetSamples.map((sample) => Number(sample.heapDeltaBytes)),
            ),
            minHeapDeltaBytes: Math.min(
              ...targetSamples.map((sample) => Number(sample.heapDeltaBytes)),
            ),
            minBaselineHeapBytes: Math.min(
              ...targetSamples.map((sample) => Number(sample.baselineHeapBytes)),
            ),
            maxBaselineHeapBytes: Math.max(
              ...targetSamples.map((sample) => Number(sample.baselineHeapBytes)),
            ),
            maxPeakHeapBytes: Math.max(
              ...targetSamples.map((sample) => Number(sample.peakHeapBytes)),
            ),
            maxOutputBytes: Math.max(...targetSamples.map((sample) => Number(sample.outputBytes))),
            minInspectorSamples: Math.min(
              ...targetSamples.map((sample) => Number(sample.inspectorSamples)),
            ),
            maxInspectorSamples: Math.max(
              ...targetSamples.map((sample) => Number(sample.inspectorSamples)),
            ),
          },
        ];
      }),
    );
    expect(Object.values(maxima).every(({ repetitions }: any) => repetitions === 5)).toBe(true);
    expect(samples).toHaveLength(35);

    const evidence = {
      schemaVersion: "agentera.entityAuthorityPerformanceEvidence.v1",
      status: "pass",
      runner: {
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
        node: runtime?.node,
        v8: runtime?.v8,
        effectiveChildFlags: runtime?.effectiveChildFlags,
        logicalCpus: os.cpus().length,
        coldProcessPerSample: true,
        authority: performanceRunnerAuthority(process.env, policy.owners.performance, {
          platform: process.platform,
          architecture: process.arch,
        }),
      },
      measurement: {
        authority:
          "references/artifacts/state-storage-authority.yaml#entity_target.measurement_contract",
        scales,
        declaredFixtures: measurementContract.fixtures,
        repetitions,
        elapsed: measurementContract.sampling.elapsed,
        heap: measurementContract.sampling.heap,
        bytes: measurementContract.sampling.bytes,
        heapBaseline: measurementContract.sampling.heap_baseline,
        heapSampling: {
          method: "Node inspector Runtime.getHeapUsage",
          intervalMs: 1,
          cadenceChanged: false,
          changeRule:
            "compare maxima and prove equivalent measurement behavior before reducing overhead",
        },
      },
      fixtures,
      limits: targets,
      samples,
      maxima,
    };
    const serializedEvidence = `${JSON.stringify(evidence)}\n`;
    expect(evidence.schemaVersion).toBe(policy.owners.performance.evidence.schema_version);
    expect(Buffer.byteLength(serializedEvidence, "utf8")).toBeLessThanOrEqual(
      policy.owners.performance.evidence.max_utf8_bytes,
    );
    process.stdout.write(serializedEvidence);
  }, 120_000);
});
