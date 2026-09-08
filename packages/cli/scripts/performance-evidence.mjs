import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

export const EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT = 512;

export function measurementProfile(profile = "full", repetitions = 5) {
  if (!["full", "development"].includes(profile)) throw new Error(`unknown measurement profile '${profile}'`);
  return {
    profile,
    repetitions: profile === "development" ? 1 : repetitions,
    schemaVersion: profile === "development" ? "agentera.developmentResourceEvidence.v1" : "agentera.entityAuthorityPerformanceEvidence.v1",
  };
}

export function performanceRunnerAuthority(environment, definition, runtime) {
  const contract = definition.execution?.authoritative_runner;
  const workers = Number.parseInt(environment.AGENTERA_VERIFICATION_WORKERS ?? "", 10);
  const runnerClass = contract ? (environment[contract.runner_class_environment] ?? null) : null;
  const identity = contract ? (environment[contract.runner_identity_environment] ?? null) : null;
  const actions = contract ? environment[contract.actions_environment] === "true" : false;
  const authoritative = Boolean(contract && actions && runnerClass === contract.runner_class && typeof identity === "string" && identity.length > 0 && runtime.platform === contract.platform && runtime.architecture === contract.architecture);
  return {
    authoritative,
    provider: authoritative ? contract.provider : "unmanaged",
    class: runnerClass,
    identity,
    actions,
    workers,
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function performanceAuthority(root) {
  const authority = YAML.parse(fs.readFileSync(path.join(root, "references/artifacts/state-storage-authority.yaml"), "utf8"));
  const measurement = authority.entity_target.measurement_contract;
  if (
    !sameValue(measurement.enforcement, {
      latency: "advisory",
      heap: "blocking",
      bytes: "blocking",
    })
  )
    throw new Error("invalid canonical performance enforcement policy");
  return authority;
}

const targetFor = (sample) => (sample?.operation === "exact_get" ? "exact_get" : `${sample?.operation}_${sample?.scale}`);

export function deriveLatencyAdvisory(samples, targets) {
  return Object.fromEntries(
    Object.entries(targets).map(([target, limits]) => {
      const timings = samples.filter((sample) => targetFor(sample) === target).map((sample) => sample.elapsedMs);
      return [
        target,
        {
          targetMs: limits.max_latency_ms,
          maxObservedMs: Math.max(...timings),
          exceededRepetitions: timings.filter((elapsed) => elapsed > limits.max_latency_ms).length,
        },
      ];
    }),
  );
}

// Old normalized v1 receipts have no raw samples. Only below-target maxima can
// prove their missing advisory: zero overruns. Never infer an overrun count.
export function normalizedLatencyAdvisory(evidence, authority) {
  const measurement = authority.entity_target.measurement_contract;
  const names = Object.keys(measurement.targets);
  if (evidence.samples !== names.length * measurement.sampling.repetitions || !sameValue(Object.keys(evidence.maxima ?? {}).sort(), [...names].sort())) throw new Error("incomplete performance maxima or sample count");
  const advisory =
    evidence.latencyAdvisory ??
    Object.fromEntries(
      names.map((target) => [
        target,
        {
          targetMs: measurement.targets[target].max_latency_ms,
          maxObservedMs: evidence.maxima[target].maxElapsedMs,
          exceededRepetitions: 0,
        },
      ]),
    );
  if (!sameValue(Object.keys(advisory).sort(), [...names].sort())) throw new Error("incomplete latency advisory");
  for (const target of names) {
    const limits = measurement.targets[target];
    const maximum = evidence.maxima[target];
    const entry = advisory[target];
    const outputLimit = target.startsWith("startup_") ? authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes : limits.max_utf8_bytes;
    if (
      maximum.repetitions !== measurement.sampling.repetitions ||
      !Number.isFinite(maximum.maxElapsedMs) ||
      maximum.maxElapsedMs < 0 ||
      !Number.isFinite(maximum.maxHeapDeltaBytes) ||
      maximum.maxHeapDeltaBytes > limits.max_heap_delta_bytes ||
      !Number.isFinite(maximum.maxOutputBytes) ||
      maximum.maxOutputBytes < 0 ||
      maximum.maxOutputBytes > outputLimit ||
      !entry ||
      !sameValue(Object.keys(entry).sort(), ["exceededRepetitions", "maxObservedMs", "targetMs"]) ||
      entry.targetMs !== limits.max_latency_ms ||
      entry.maxObservedMs !== maximum.maxElapsedMs ||
      !Number.isInteger(entry.exceededRepetitions) ||
      entry.exceededRepetitions < 0 ||
      entry.exceededRepetitions > maximum.repetitions ||
      entry.exceededRepetitions > 0 !== entry.maxObservedMs > entry.targetMs
    )
      throw new Error(`invalid latency advisory or blocking maxima for ${target}`);
  }
  return advisory;
}

export function performanceEvidenceRecords(stdout, schemaVersion) {
  return stdout.split("\n").flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.schemaVersion === schemaVersion ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export function effectiveChildFlagsAreComplete(flags) {
  if (!Array.isArray(flags?.execArgv) || flags.execArgv.length > 16 || flags.execArgv.some((flag) => typeof flag !== "string" || flag.length > 512) || flags.nodeOptionsUtf8Limit !== EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT) return false;
  if (flags.nodeOptions === null) return true;
  const nodeOptions = flags.nodeOptions;
  return typeof nodeOptions?.value === "string" && nodeOptions.truncated === false && Number.isInteger(nodeOptions.utf8Bytes) && nodeOptions.utf8Bytes === Buffer.byteLength(nodeOptions.value, "utf8") && nodeOptions.utf8Bytes <= EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT;
}

export function validatePerformanceEvidence(stdout, definition, root) {
  return validateMeasurementEvidence(stdout, definition, root, "full");
}

export function validateDevelopmentResourceEvidence(stdout, definition, root) {
  return validateMeasurementEvidence(
    stdout,
    {
      ...definition,
      evidence: {
        ...definition.evidence,
        schema_version: measurementProfile("development").schemaVersion,
      },
    },
    root,
    "development",
  );
}

function validateMeasurementEvidence(stdout, definition, root, profile) {
  const evidenceDefinition = definition.evidence;
  if (evidenceDefinition.stdout_format !== "newline_delimited_json_record_amid_runner_output") {
    return [`unsupported stdout format '${evidenceDefinition.stdout_format}'`];
  }
  const records = performanceEvidenceRecords(stdout, evidenceDefinition.schema_version);
  if (records.length !== 1) return [`expected exactly one ${evidenceDefinition.schema_version} stdout line; observed ${records.length}`];
  const evidence = records[0];
  const bytes = Buffer.byteLength(`${JSON.stringify(evidence)}\n`, "utf8");
  const [, authorityPointer] = evidenceDefinition.authority.split("#", 2);
  let authority;
  try {
    authority = performanceAuthority(root);
  } catch (error) {
    return [error.message];
  }
  const measurement = authorityPointer.split(".").reduce((current, key) => current?.[key], authority);
  const repetitions = measurementProfile(profile, measurement.sampling.repetitions).repetitions;
  const targetNames = Object.keys(measurement.targets);
  const scales = Object.fromEntries(
    Object.entries(measurement.fixtures).flatMap(([name, fixture]) => {
      const count = String(fixture).match(/^\d+/)?.[0];
      return count === undefined ? [] : [[name, Number(count)]];
    }),
  );
  const errors = [];
  if (profile === "development" && evidence.profile !== "development") errors.push("development resource provenance is missing");
  if (profile === "full" && evidence.profile !== undefined && evidence.profile !== "full") errors.push("development evidence is not full qualification");
  const heapBaseline = measurement.sampling.heap_baseline;
  const execution = definition.execution;
  const runnerContract = execution?.authoritative_runner;
  if (heapBaseline?.normalization !== "await successful Node inspector HeapProfiler.collectGarbage, then read Runtime.getHeapUsage" || heapBaseline?.measured_operation_collection !== "forbidden" || typeof heapBaseline?.boundary !== "string")
    errors.push("authority does not require pre-baseline inspector GC normalization");
  if (bytes > evidenceDefinition.max_utf8_bytes) errors.push(`evidence is ${bytes} UTF-8 bytes; limit ${evidenceDefinition.max_utf8_bytes}`);
  if (evidence.status !== "pass") errors.push("status is not pass");
  if (
    !evidence.runner ||
    typeof evidence.runner.platform !== "string" ||
    typeof evidence.runner.release !== "string" ||
    typeof evidence.runner.architecture !== "string" ||
    typeof evidence.runner.node !== "string" ||
    typeof evidence.runner.v8 !== "string" ||
    !effectiveChildFlagsAreComplete(evidence.runner.effectiveChildFlags) ||
    !Number.isInteger(evidence.runner.logicalCpus) ||
    evidence.runner.logicalCpus < 1 ||
    evidence.runner.coldProcessPerSample !== true
  )
    errors.push("runner conditions are incomplete or unbounded");
  const runnerAuthority = evidence.runner?.authority;
  if (!Number.isInteger(execution?.workers) || execution.workers !== 1) errors.push("performance policy must require exactly one worker");
  if (!runnerContract || runnerContract.provider !== "github_actions" || runnerContract.runs_on !== "ubuntu-24.04") errors.push("authoritative runner policy is incomplete");
  if (!runnerAuthority || runnerAuthority.workers !== execution?.workers || typeof runnerAuthority.actions !== "boolean") {
    errors.push("runner identity evidence is incomplete or has the wrong worker count");
  } else if (runnerAuthority.authoritative === true) {
    if (
      runnerAuthority.provider !== runnerContract.provider ||
      runnerAuthority.class !== runnerContract.runner_class ||
      typeof runnerAuthority.identity !== "string" ||
      runnerAuthority.identity.length < 1 ||
      runnerAuthority.identity.length > 200 ||
      runnerAuthority.actions !== true ||
      evidence.runner.platform !== runnerContract.platform ||
      evidence.runner.architecture !== runnerContract.architecture
    ) {
      errors.push("authoritative runner identity does not match policy");
    }
  } else if (runnerAuthority.provider !== "unmanaged" || (runnerAuthority.class !== null && typeof runnerAuthority.class !== "string") || (runnerAuthority.identity !== null && typeof runnerAuthority.identity !== "string")) {
    errors.push("non-authoritative runner identity is invalid");
  }
  if (evidence.measurement?.authority !== evidenceDefinition.authority) errors.push("measurement authority does not match policy");
  if (!sameValue(evidence.measurement?.scales, scales) || !sameValue(evidence.measurement?.declaredFixtures, measurement.fixtures)) errors.push("declared scales or fixtures changed");
  if (!["elapsed", "heap", "bytes"].every((field) => evidence.measurement?.[field] === measurement.sampling[field])) errors.push("sampling conditions changed");
  if (!sameValue(evidence.measurement?.heapBaseline, measurement.sampling.heap_baseline)) errors.push("heap baseline normalization changed");
  if (evidence.measurement?.repetitions !== repetitions || evidence.measurement?.heapSampling?.intervalMs !== 1 || evidence.measurement?.heapSampling?.cadenceChanged !== false) errors.push("repetitions or 1 ms heap cadence changed");
  if (!sameValue(evidence.limits, measurement.targets)) errors.push("declared limits changed");
  if (!Array.isArray(evidence.samples) || evidence.samples.some((sample) => !sample || typeof sample !== "object")) return [...errors, "samples must be an array of measurement records"];
  if (evidence.samples.length !== targetNames.length * repetitions) {
    errors.push(`expected ${targetNames.length * repetitions} samples`);
  } else {
    const expectedRepetitions = Array.from({ length: repetitions }, (_, index) => index + 1);
    const complete =
      targetNames.every((target) =>
        sameValue(
          evidence.samples
            .filter((sample) => targetFor(sample) === target)
            .map((sample) => sample.repetition)
            .sort(),
          expectedRepetitions,
        ),
      ) &&
      evidence.samples.every(
        (sample) =>
          sample.status === "pass" &&
          Number.isFinite(sample.elapsedMs) &&
          sample.elapsedMs >= 0 &&
          Number.isFinite(sample.outputBytes) &&
          sample.outputBytes >= 0 &&
          [sample.baselineHeapBytes, sample.peakHeapBytes, sample.heapDeltaBytes, sample.inspectorSamples].every(Number.isFinite) &&
          sample.inspectorSamples >= 2 &&
          (sample.operation !== "archive_list" || sample.entries === scales[`archive_${sample.scale}`]) &&
          sample.peakHeapBytes - sample.baselineHeapBytes === sample.heapDeltaBytes,
      );
    if (!complete) errors.push("samples do not cover every target and repetition");
    for (const sample of evidence.samples) {
      const target = targetFor(sample);
      const limits = measurement.targets[target];
      const outputLimit = sample.operation === "startup" ? authority.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes : limits?.max_utf8_bytes;
      if (!limits || sample.heapDeltaBytes > limits.max_heap_delta_bytes || sample.outputBytes > outputLimit) errors.push(`sample exceeds blocking heap/output limits: ${target}`);
    }
    if (evidence.latencyAdvisory !== undefined && !sameValue(evidence.latencyAdvisory, deriveLatencyAdvisory(evidence.samples, measurement.targets))) errors.push("latency advisory does not match the declared samples and targets");
  }
  const maximaMatch =
    sameValue(Object.keys(evidence.maxima ?? {}), targetNames) &&
    targetNames.every((target) => {
      const samples = Array.isArray(evidence.samples) ? evidence.samples.filter((sample) => targetFor(sample) === target) : [];
      return sameValue(evidence.maxima[target], {
        repetitions: samples.length,
        maxElapsedMs: Math.max(...samples.map((sample) => Number(sample.elapsedMs))),
        maxHeapDeltaBytes: Math.max(...samples.map((sample) => Number(sample.heapDeltaBytes))),
        minHeapDeltaBytes: Math.min(...samples.map((sample) => Number(sample.heapDeltaBytes))),
        minBaselineHeapBytes: Math.min(...samples.map((sample) => Number(sample.baselineHeapBytes))),
        maxBaselineHeapBytes: Math.max(...samples.map((sample) => Number(sample.baselineHeapBytes))),
        maxPeakHeapBytes: Math.max(...samples.map((sample) => Number(sample.peakHeapBytes))),
        maxOutputBytes: Math.max(...samples.map((sample) => Number(sample.outputBytes))),
        minInspectorSamples: Math.min(...samples.map((sample) => Number(sample.inspectorSamples))),
        maxInspectorSamples: Math.max(...samples.map((sample) => Number(sample.inspectorSamples))),
      });
    });
  if (!maximaMatch) errors.push("maxima do not match the declared samples");
  return errors;
}
