import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { reject } from "./write/errors.js";

const ID = /^[a-z]{10}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEVERITIES = new Set(["critical", "degraded", "normal", "annoying"]);

export interface TodoTransitionBatchEntry {
  id: string;
  reason: string;
  date: string;
  severity?: string;
}

export interface TodoTransitionBatch {
  verb: "set-severity" | "resolve";
  entries: TodoTransitionBatchEntry[];
}

export function todoTransitionBatchPostStateSha256(record: JsonObject): string {
  const value = structuredClone(record);
  if (value.reconciliation && typeof value.reconciliation === "object" && !Array.isArray(value.reconciliation)) delete value.reconciliation.transition_batch;
  return createHash("sha256").update(canonicalRecordJson(value)).digest("hex");
}

export function matchesTodoTransitionBatchPostState(record: JsonObject, receipt: JsonObject, entry: TodoTransitionBatchEntry, verb: TodoTransitionBatch["verb"]): boolean {
  const lifecycle = record.lifecycle && typeof record.lifecycle === "object" && !Array.isArray(record.lifecycle) ? record.lifecycle : null;
  return receipt.post_state_sha256 === todoTransitionBatchPostStateSha256(record) && lifecycle !== null && canonicalRecordJson(lifecycle) === canonicalRecordJson({ operation: verb, reason: entry.reason, date: entry.date }) && (verb === "set-severity" ? record.severity === entry.severity : record.status === "resolved");
}

export function parseTodoTransitionBatch(input: JsonObject | null, verb: string): TodoTransitionBatch | null {
  if (verb !== "set-severity" && verb !== "resolve") return null;
  const version = `agentera.todo${verb === "set-severity" ? "SetSeverity" : "Resolve"}Batch.v1`;
  if (!input || input.schema_version !== version) return null;
  const member = verb === "set-severity" ? "transitions" : "resolutions";
  const values = input[member];
  const violations: string[] = [];
  if (Object.keys(input).sort().join(",") !== ["schema_version", member].sort().join(",") || !Array.isArray(values)) violations.push(`batch envelope must contain exactly schema_version and ${member}`);
  if (!Array.isArray(values) || values.length < 1 || values.length > 256) violations.push(`${member} must contain 1 to 256 entries`);
  const expected = verb === "set-severity" ? "date,id,reason,severity" : "date,id,reason";
  const entries = (Array.isArray(values) ? values : []).map((value, index) => {
    const item = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    if (Object.keys(item).sort().join(",") !== expected) violations.push(`${member}[${index}] must contain exactly ${expected.split(",").join(", ")}`);
    const id = String(item.id ?? "");
    const reason = String(item.reason ?? "").trim();
    const date = String(item.date ?? "");
    const severity = item.severity === undefined ? undefined : String(item.severity);
    if (!ID.test(id)) violations.push(`${member}[${index}].id must be a bare ten-letter TODO ID`);
    if (!reason || [...reason].length > 500) violations.push(`${member}[${index}].reason must contain 1 to 500 code points`);
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (!DATE.test(date) || Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) violations.push(`${member}[${index}].date must be a valid YYYY-MM-DD date`);
    if (verb === "set-severity" && !SEVERITIES.has(severity ?? "")) violations.push(`${member}[${index}].severity is invalid`);
    return { id, reason, date, ...(severity === undefined ? {} : { severity }) };
  });
  const seen = new Set<string>();
  for (const { id } of entries) {
    if (id && seen.has(id)) violations.push(`duplicate ${verb} target '${id}'`);
    seen.add(id);
  }
  if (violations.length)
    reject({
      class: "schema_violation",
      message: `todo ${verb} batch input is invalid`,
      violations,
      recovery: `Correct the strict ${version} envelope, then preview it again; no state was changed.`,
    });
  return { verb, entries };
}

export function todoTransitionBatchEffectSha256(input: JsonObject, mappingSha256: string, targets: Array<{ path: string; before_sha256: string | null; after_sha256: string }>): string {
  return createHash("sha256")
    .update(canonicalRecordJson({ input, mapping_sha256: mappingSha256, targets }))
    .digest("hex");
}
