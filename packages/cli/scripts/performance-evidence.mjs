import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

export function validatePerformanceEvidence(stdout, definition, root) {
  const evidenceDefinition = definition.evidence;
  if (evidenceDefinition.stdout_format !== "newline_delimited_json_record_amid_runner_output") {
    return [`unsupported stdout format '${evidenceDefinition.stdout_format}'`];
  }
  const records = performanceEvidenceRecords(stdout, evidenceDefinition.schema_version);
  if (records.length !== 1) return [`expected exactly one ${evidenceDefinition.schema_version} stdout line; observed ${records.length}`];
  const evidence = records[0];
  const bytes = Buffer.byteLength(`${JSON.stringify(evidence)}\n`, "utf8");
  const [authorityFile, authorityPointer] = evidenceDefinition.authority.split("#", 2);
  const authority = YAML.parse(fs.readFileSync(path.join(root, authorityFile), "utf8"));
  const measurement = authorityPointer.split(".").reduce((current, key) => current?.[key], authority);
  const targetNames = Object.keys(measurement.targets);
  const scales = Object.fromEntries(Object.entries(measurement.fixtures).flatMap(([name, fixture]) => {
    const count = String(fixture).match(/^\d+/)?.[0];
    return count === undefined ? [] : [[name, Number(count)]];
  }));
  const errors = [];
  if (bytes > evidenceDefinition.max_utf8_bytes) errors.push(`evidence is ${bytes} UTF-8 bytes; limit ${evidenceDefinition.max_utf8_bytes}`);
  if (evidence.status !== "pass") errors.push("status is not pass");
  if (!evidence.runner || typeof evidence.runner.platform !== "string" || typeof evidence.runner.release !== "string" || typeof evidence.runner.architecture !== "string" || typeof evidence.runner.node !== "string" || !Number.isInteger(evidence.runner.logicalCpus) || evidence.runner.logicalCpus < 1 || evidence.runner.coldProcessPerSample !== true) errors.push("runner conditions are incomplete");
  if (evidence.measurement?.authority !== evidenceDefinition.authority) errors.push("measurement authority does not match policy");
  if (!sameValue(evidence.measurement?.scales, scales) || !sameValue(evidence.measurement?.declaredFixtures, measurement.fixtures)) errors.push("declared scales or fixtures changed");
  if (!["elapsed", "heap", "bytes"].every((field) => evidence.measurement?.[field] === measurement.sampling[field])) errors.push("sampling conditions changed");
  if (evidence.measurement?.repetitions !== measurement.sampling.repetitions || evidence.measurement?.heapSampling?.intervalMs !== 1 || evidence.measurement?.heapSampling?.cadenceChanged !== false) errors.push("repetitions or 1 ms heap cadence changed");
  if (!sameValue(evidence.limits, measurement.targets)) errors.push("declared limits changed");
  if (!Array.isArray(evidence.samples) || evidence.samples.length !== targetNames.length * measurement.sampling.repetitions) {
    errors.push(`expected ${targetNames.length * measurement.sampling.repetitions} samples`);
  } else {
    const expectedRepetitions = Array.from({ length: measurement.sampling.repetitions }, (_, index) => index + 1);
    const targetFor = (sample) => sample.operation === "exact_get" ? "exact_get" : `${sample.operation}_${sample.scale}`;
    const complete = targetNames.every((target) => sameValue(
      evidence.samples.filter((sample) => targetFor(sample) === target).map((sample) => sample.repetition).sort(),
      expectedRepetitions,
    )) && evidence.samples.every((sample) => sample.status === "pass");
    if (!complete) errors.push("samples do not cover every target and repetition");
  }
  const maximaMatch = sameValue(Object.keys(evidence.maxima ?? {}), targetNames) && targetNames.every((target) => {
    const samples = evidence.samples?.filter((sample) => target === "exact_get" ? sample.operation === target : `${sample.operation}_${sample.scale}` === target) ?? [];
    return sameValue(evidence.maxima[target], {
      repetitions: samples.length,
      maxElapsedMs: Math.max(...samples.map((sample) => Number(sample.elapsedMs))),
      maxHeapDeltaBytes: Math.max(...samples.map((sample) => Number(sample.heapDeltaBytes))),
      maxOutputBytes: Math.max(...samples.map((sample) => Number(sample.outputBytes))),
      minInspectorSamples: Math.min(...samples.map((sample) => Number(sample.inspectorSamples))),
    });
  });
  if (!maximaMatch) errors.push("maxima do not match the declared samples");
  return errors;
}
