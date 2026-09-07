import path from "node:path";
import { deriveLatencyAdvisory, performanceAuthority } from "../../scripts/performance-evidence.mjs";

export function performanceEvidence() {
  const measurement = performanceAuthority(path.resolve(import.meta.dirname, "../../../..")).entity_target.measurement_contract;
  const scales = { small: 100, large: 1000, archive_small: 100, archive_large: 1000 };
  const samples = Object.keys(measurement.targets).flatMap((target) => {
    const scale = target.endsWith("small") ? "small" : "large";
    const operation = target === "exact_get" ? target : target.slice(0, -(scale.length + 1));
    return Array.from({ length: measurement.sampling.repetitions }, (_, i) => ({
      operation,
      scale,
      repetition: i + 1,
      status: "pass",
      elapsedMs: 1,
      baselineHeapBytes: 100,
      peakHeapBytes: 200,
      heapDeltaBytes: 100,
      inspectorSamples: 2,
      outputBytes: 100,
      ...(operation === "archive_list" ? { entries: scales[`archive_${scale}`] } : { entities: scales[scale] }),
    }));
  });
  const evidence = {
    schemaVersion: "agentera.entityAuthorityPerformanceEvidence.v1",
    status: "pass",
    runner: {
      platform: "linux",
      release: "fixture",
      architecture: "x64",
      node: process.version,
      v8: process.versions.v8,
      effectiveChildFlags: { execArgv: [], nodeOptions: null, nodeOptionsUtf8Limit: 512 },
      logicalCpus: 4,
      coldProcessPerSample: true,
      authority: {
        authoritative: true,
        provider: "github_actions",
        class: "github-hosted-ubuntu-24.04",
        identity: "GitHub Actions fixture",
        actions: true,
        workers: 1,
      },
    },
    measurement: {
      authority: "references/artifacts/state-storage-authority.yaml#entity_target.measurement_contract",
      scales,
      declaredFixtures: measurement.fixtures,
      repetitions: measurement.sampling.repetitions,
      elapsed: measurement.sampling.elapsed,
      heap: measurement.sampling.heap,
      bytes: measurement.sampling.bytes,
      heapBaseline: measurement.sampling.heap_baseline,
      heapSampling: { intervalMs: 1, cadenceChanged: false },
    },
    limits: measurement.targets,
    samples,
    maxima: {},
    latencyAdvisory: {},
  };
  refreshPerformanceEvidence(evidence);
  return evidence;
}

export function refreshPerformanceEvidence(evidence: any) {
  evidence.maxima = Object.fromEntries(
    Object.keys(evidence.limits).map((target) => {
      const samples = evidence.samples.filter((sample: any) => (sample.operation === "exact_get" ? sample.operation : `${sample.operation}_${sample.scale}`) === target);
      const max = (field: string) => Math.max(...samples.map((sample: any) => sample[field]));
      const min = (field: string) => Math.min(...samples.map((sample: any) => sample[field]));
      return [
        target,
        {
          repetitions: samples.length,
          maxElapsedMs: max("elapsedMs"),
          maxHeapDeltaBytes: max("heapDeltaBytes"),
          minHeapDeltaBytes: min("heapDeltaBytes"),
          minBaselineHeapBytes: min("baselineHeapBytes"),
          maxBaselineHeapBytes: max("baselineHeapBytes"),
          maxPeakHeapBytes: max("peakHeapBytes"),
          maxOutputBytes: max("outputBytes"),
          minInspectorSamples: min("inspectorSamples"),
          maxInspectorSamples: max("inspectorSamples"),
        },
      ];
    }),
  );
  evidence.latencyAdvisory = deriveLatencyAdvisory(evidence.samples, evidence.limits);
}

export function performanceObservationFixture() {
  const record = performanceEvidence();
  return {
    inventoryFiles: 1,
    evidence: {
      schemaVersion: record.schemaVersion,
      status: record.status,
      sha256: "0".repeat(64),
      bytes: Buffer.byteLength(JSON.stringify(record) + "\n"),
      samples: record.samples.length,
      maxima: record.maxima,
      latencyAdvisory: record.latencyAdvisory,
      runner: record.runner,
    },
  };
}
