/**
 * `state experiments` query (experiments.yaml).
 *
 * Returns the most recent N experiments (default 5) filtered by
 * topic or status, including per-entry metric and conclusion.
 */

import {
  asList,
  emitStateStructured,
  filterByFieldValue,
  filterByTopic,
  formatEntry,
  loadArtifact,
  missingSchemaError,
  printStatusCounts,
  sourceMetadata,
  statusCounts,
  structuredState,
  truncate,
} from "../../stateQuery.js";
import { SchemaInfo, artifactPath } from "../../appContext.js";
import { out, err, StateArgs, Io } from "./shared.js";

type Dict = Record<string, any>;

export function queryExperiments(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.experiments;
  if (!info) {
    e(missingSchemaError("experiments") + "\n");
    return 1;
  }
  const p = artifactPath(info, "experiments");
  const data = loadArtifact(p);
  const format = args.format ?? "text";
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isDict) {
    if (format !== "text") {
      return emitStateStructured(
        "experiments",
        structuredState("experiments", [], sourceMetadata("experiments", p), {
          filters: { topic: args.topic ?? null, status: args.status ?? null, limit: args.limit ?? 5 },
        }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  const d = data as Dict;
  let entries = asList(d.experiments);
  const statusFilter = args.status ?? null;
  if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
  const topic = args.topic ?? null;
  if (topic) entries = filterByTopic(entries, topic, info.fields);
  const limit = (args.limit ?? 5) || 5;
  entries = entries.slice(-limit);
  const closure = d.closure && typeof d.closure === "object" && !Array.isArray(d.closure) ? d.closure : {};
  if (format !== "text") {
    return emitStateStructured(
      "experiments",
      structuredState("experiments", entries, sourceMetadata("experiments", p), {
        filters: { topic, status: statusFilter, limit },
        summary: { closure },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  printStatusCounts("Experiment status", statusCounts(entries), o);
  for (const entry of entries) {
    o(formatEntry(entry, ["number", "date", "label", "status"]) + "\n");
    const metric = entry.metric;
    if (metric && typeof metric === "object" && !Array.isArray(metric)) {
      const metricLine = formatEntry(metric, ["primary_value", "delta_vs_baseline"]);
      if (metricLine) o(`  metric: ${metricLine}\n`);
    }
    for (const key of ["conclusion", "next"]) {
      const value = entry[key];
      if (value) o(`  ${key}: ${truncate(value)}\n`);
    }
  }
  if (Object.keys(closure).length > 0) {
    o("Closure: " + formatEntry(closure, ["final_value", "target", "reason"]) + "\n");
  }
  return 0;
}
