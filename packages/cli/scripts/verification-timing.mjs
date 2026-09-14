import fs from "node:fs";
import { isUtf8 } from "node:buffer";
import path from "node:path";

// Match the reporter's serialized-byte and array limits in overlap-pending.mjs.
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 10_000;
const ASSERTION_STATUSES = new Set(["passed", "failed", "skipped", "todo"]);

function duration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

/** Preserve diagnostic timings separately from normalized verification evidence. */
export function writeVerificationTimingProfile({ resultFile, owner, wallMs, files, repoRoot }) {
  if (!resultFile || !["source", "package"].includes(owner)) return false;
  try {
    if (!Number.isSafeInteger(wallMs) || wallMs < 0 || !Array.isArray(files) || files.length > MAX_RESULTS) return false;
    const stat = fs.statSync(resultFile);
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return false;
    const bytes = fs.readFileSync(resultFile);
    if (bytes.length > MAX_REPORT_BYTES || !isUtf8(bytes)) return false;
    const report = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(report?.testResults) || report.testResults.length > MAX_RESULTS) return false;

    // Emit only trusted inventory paths, never reporter-supplied names/paths.
    const allowed = new Map();
    for (const file of files) {
      if (typeof file !== "string" || path.isAbsolute(file) || file.includes("\\") || path.posix.normalize(file) !== file || file.split("/").includes("..")) continue;
      allowed.set(file, file);
      allowed.set(path.join(repoRoot, file), file);
    }
    const suites = [];
    for (const suite of report.testResults) {
      const file = allowed.get(suite?.name);
      if (!file || !Array.isArray(suite.assertionResults) || suite.assertionResults.length > MAX_RESULTS) continue;
      const start = duration(suite.startTime);
      const end = duration(suite.endTime);
      suites.push({
        file,
        elapsedMs: start !== null && end !== null && end >= start ? end - start : null,
        assertions: suite.assertionResults.flatMap((assertion, index) => (ASSERTION_STATUSES.has(assertion?.status) ? [{ index, durationMs: duration(assertion.duration), status: assertion.status }] : [])),
      });
    }
    const serialized = JSON.stringify({ schemaVersion: "agentera.verificationTimingProfile.v1", diagnosticOnly: true, owner, wallMs, suites });
    if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) return false;
    fs.writeFileSync(`${resultFile}.profile.json`, serialized, { mode: 0o600 });
    return true;
  } catch {
    // Missing, malformed or unwritable diagnostics never replace a gate result.
    return false;
  }
}
