/**
 * `state progress` query (PROGRESS.md / progress.yaml cycles).
 *
 * Reports the most recent N cycles (default 5), filtered by topic or
 * type, with a structured envelope that downstream prime callers
 * use to surface progress_verification without raw artifact reads.
 */

import {
  emitStateStructured,
  extractEntries,
  filterByFieldValue,
  filterByTopic,
  formatEntry,
  loadArtifact,
  missingSchemaError,
  progressEntriesForOutput,
  recentCycles,
  sourceMetadata,
  structuredState,
  truncate,
} from "../../stateQuery.js";
import { SchemaInfo, artifactPath } from "../../appContext.js";
import { out, err, StateArgs, Io } from "./shared.js";

export function queryProgress(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.progress;
  if (!info) {
    e(missingSchemaError("progress") + "\n");
    return 1;
  }
  const p = artifactPath(info, "progress");
  const data = loadArtifact(p);
  let entries = extractEntries(data);
  const topic = args.topic ?? null;
  if (topic) entries = filterByTopic(entries, topic, info.fields);
  const statusFilter = args.status ?? null;
  if (statusFilter) entries = filterByFieldValue(entries, "type", statusFilter);
  const effectiveLimit = (args.limit ?? 5) || 5;
  entries = recentCycles(entries, effectiveLimit);

  if ((args.format ?? "text") !== "text") {
    return emitStateStructured(
      "progress",
      structuredState("progress", progressEntriesForOutput(entries), sourceMetadata("progress", p), {
        filters: { topic, status: statusFilter, limit: effectiveLimit },
      }),
      args.format ?? "text",
      args.fields,
      o,
      e,
    );
  }
  if (entries.length === 0) return 0;
  for (const entry of entries) {
    o(formatEntry(entry, ["number", "timestamp", "type", "phase"]) + "\n");
    for (const key of ["what", "verified", "next"]) {
      const value = entry[key];
      if (value) o(`  ${key}: ${truncate(value)}\n`);
    }
  }
  return 0;
}
