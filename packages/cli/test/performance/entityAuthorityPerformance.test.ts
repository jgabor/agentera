import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { measureColdCli } from "../helpers/coldCliMeasurement.js";
import { createEntityAuthorityFixture } from "../helpers/entityAuthorityFixture.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const POLICY_PATH = path.join(REPO_ROOT, "references/analysis/verification-policy.yaml");

let tmp: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

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
      ["small", "large"].map((scale) => [
        scale,
        Number(String(measurementContract.fixtures[scale]).match(/^\d+/)?.[0]),
      ]),
    ) as Record<"small" | "large", number>;
    const samples: Array<Record<string, number | string>> = [];
    const fixtures: Record<string, unknown> = {};

    expect(measurementContract.environment).toContain("one cold CLI process per sample");
    expect(repetitions).toBe(5);
    expect(scales).toEqual({ small: 100, large: 1000 });

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
          const outputBytes = Buffer.byteLength(measured.stdout, "utf8");
          const maxOutputBytes =
            operation === "startup"
              ? authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes
              : limits.max_utf8_bytes;
          expect(
            measured.elapsedMs,
            `${operation} ${scale} repetition ${repetition}`,
          ).toBeLessThanOrEqual(limits.max_latency_ms);
          expect(
            measured.heapDeltaBytes,
            `${operation} ${scale} repetition ${repetition}`,
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
          const outputBytes = Buffer.byteLength(measured.stdout, "utf8");
          expect(measured.elapsedMs, `exact_get repetition ${repetition}`).toBeLessThanOrEqual(
            targets.exact_get.max_latency_ms,
          );
          expect(measured.heapDeltaBytes, `exact_get repetition ${repetition}`).toBeLessThanOrEqual(
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

    const targetNames = [
      "exact_get",
      "bounded_list_small",
      "bounded_list_large",
      "startup_small",
      "startup_large",
    ];
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
            maxOutputBytes: Math.max(...targetSamples.map((sample) => Number(sample.outputBytes))),
            minInspectorSamples: Math.min(
              ...targetSamples.map((sample) => Number(sample.inspectorSamples)),
            ),
          },
        ];
      }),
    );
    expect(Object.values(maxima).every(({ repetitions }: any) => repetitions === 5)).toBe(true);
    expect(samples).toHaveLength(25);

    const evidence = {
      schemaVersion: "agentera.entityAuthorityPerformanceEvidence.v1",
      status: "pass",
      runner: {
        platform: process.platform,
        release: os.release(),
        architecture: process.arch,
        node: process.version,
        logicalCpus: os.cpus().length,
        coldProcessPerSample: true,
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
