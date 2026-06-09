/**
 * `state docs` query (DOCS.md / docs.yaml).
 *
 * Returns the docs index (document, path, last_updated, status) and
 * a source_contract that asserts
 * `capability_startup_complete` so prime/hej can skip raw
 * `.agentera/docs.yaml` reads.
 */

import {
  asList,
  emitStateStructured,
  filterByFieldValue,
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
import { capabilityStartupComplete } from "../../startupCompletenessContract.js";
import { out, err, StateArgs, Io } from "./shared.js";

export function queryDocs(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  const info = schemas.docs;
  if (!info) {
    e(missingSchemaError("docs") + "\n");
    return 1;
  }
  const p = artifactPath(info, "docs");
  const data = loadArtifact(p);
  const format = args.format ?? "text";
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isDict) {
    if (format !== "text") {
      return emitStateStructured(
        "docs",
        structuredState("docs", [], sourceMetadata("docs", p), {
          filters: { topic: args.topic ?? null, status: args.status ?? null },
        }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  const d = data as any;
  const legacyEntries = asList(d.entries);
  if (legacyEntries.length > 0) {
    let entries = legacyEntries;
    const statusFilter = args.status ?? null;
    if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
    if (format !== "text") {
      return emitStateStructured(
        "docs",
        structuredState("docs", entries, sourceMetadata("docs", p), { filters: { status: statusFilter } }),
        format,
        args.fields,
        o,
        e,
      );
    }
    for (const entry of entries) {
      const line = formatEntry(entry, ["last_audit", "document", "path", "status"]);
      if (line) o(line + "\n");
    }
    return 0;
  }
  const mapping = asList(d.mapping);
  let index = asList(d.index);
  const coverage = d.coverage && typeof d.coverage === "object" && !Array.isArray(d.coverage) ? d.coverage : {};
  const conventions =
    d.conventions && typeof d.conventions === "object" && !Array.isArray(d.conventions) ? d.conventions : {};
  const topic = args.topic ?? null;
  if (topic) {
    const t = topic.toLowerCase();
    index = index.filter(
      (entry) =>
        String(entry.document ?? "").toLowerCase().includes(t) ||
        String(entry.path ?? "").toLowerCase().includes(t) ||
        String(entry.status ?? "").toLowerCase().includes(t),
    );
  }
  const statusFilter = args.status ?? null;
  if (statusFilter) index = filterByFieldValue(index, "status", statusFilter);
  if (format !== "text") {
    return emitStateStructured(
      "docs",
      structuredState("docs", index, sourceMetadata("docs", p), {
        filters: { topic, status: statusFilter },
        summary: {
          last_audit: d.last_audit,
          conventions,
          mapping,
          mapping_entries: mapping.length,
          coverage,
          source_contract: {
            capability_startup_complete: capabilityStartupComplete(),
            raw_artifact_reads_required: false,
          },
        },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  o(`Docs: last_audit=${d.last_audit ?? "-"}\n`);
  o(`Mapping: entries=${mapping.length}\n`);
  if (Object.keys(coverage).length > 0) {
    o("Coverage: " + Object.entries(coverage).map(([k, v]) => `${k}=${truncate(v)}`).join(" | ") + "\n");
  }
  printStatusCounts("Docs status", statusCounts(index), o);
  for (const entry of index.slice(0, 10)) {
    const line = formatEntry(entry, ["document", "path", "last_updated", "status"]);
    if (line) o(line + "\n");
  }
  return 0;
}
