import fs from "node:fs";

const phases = ["barrier_ms", "prepare_ms", "build_first_ms", "build_second_ms", "identity_ms", "pack_first_ms", "pack_second_ms", "compare_ms", "extract_ms", "scan_ms", "fixture_ms", "evidence_ms"];
const fields = [...phases, "setup_ms", "setup_incomplete_ms", "wall_ms", "outside_setup_residual_ms"];

// Diagnostics only: fixed labels and integer milliseconds, never file contents,
// errors, paths, arguments or environment values. Missing phases stay missing.
export function readPackageTimings(file) {
  try {
    if (!file || fs.statSync(file).size > 4096) return {};
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(fields.filter((key) => Number.isSafeInteger(data?.[key]) && data[key] >= 0).map((key) => [key, data[key]]));
  } catch {
    return {};
  }
}

export function writePackageTimings(file, timings) {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(timings), { mode: 0o600 });
  } catch {
    // Unavailable diagnostics must not replace the verification result.
  }
}

export function createPackageTimingRecorder(file, now = () => process.hrtime.bigint()) {
  const started = now();
  const timings = {};
  let previous = 0;
  let phase;
  function checkpoint() {
    const elapsed = Math.floor(Number(now() - started) / 1_000_000);
    if (phase) timings[phase] = elapsed - previous;
    previous = elapsed;
    return elapsed;
  }
  return {
    start(next) {
      checkpoint();
      phase = next;
      writePackageTimings(file, timings);
    },
    finish(complete) {
      timings[complete ? "setup_ms" : "setup_incomplete_ms"] = checkpoint();
      writePackageTimings(file, timings);
    },
  };
}

export function completePackageTimings(file, wallMs) {
  const timings = { ...readPackageTimings(file), wall_ms: wallMs };
  // Includes runner startup, test execution and teardown; it is NOT measured
  // test time, and setup_ms already includes every disjoint setup phase.
  if (timings.setup_ms !== undefined) timings.outside_setup_residual_ms = Math.max(0, wallMs - timings.setup_ms);
  writePackageTimings(file, timings);
  return timings;
}

export function packageTimingSummary(timings) {
  return `package timings ms: ${JSON.stringify(timings)}`;
}
