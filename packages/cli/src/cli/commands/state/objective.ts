/**
 * `state objective` query (OBJECTIVE.md / objective.yaml).
 *
 * Reports the single current objective plus its closure block (when
 * status is "closed"), with the same envelope shape used by prime.
 */

import {
  asList,
  emitStateStructured,
  filterByFieldValue,
  formatEntry,
  loadArtifact,
  missingSchemaError,
  sourceMetadata,
  structuredState,
  truncate,
} from "../../stateQuery.js";
import { SchemaInfo, artifactPath } from "../../appContext.js";
import { firstPresent } from "../../stateQuery.js";
import { out, err, StateArgs, Io } from "./shared.js";
import type { JsonObject } from "../../../core/jsonValue.js";
import { detectStateMode } from "../../../state/stateMode.js";
import { currentObjectiveEntity } from "../../../state/objectiveExperimentEntities.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { emitStructured } from "../../structured.js";

export function queryObjective(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const o = out(io);
  const e = err(io);
  if (detectStateMode(process.cwd()) === "entities") {
    try {
      const response = currentObjectiveEntity(process.cwd());
      if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, o);
      else o(formatEntry((response.entries as JsonObject[])[0], ["id", "artifact"]) + "\n");
      return 0;
    } catch (error) {
      if (error instanceof StateRetrievalFailure) {
        if (args.format === "json" || args.format === "yaml") emitStructured(error.body, args.format, o);
        else e(`Error: ${error.body.error.message}\nRecovery: ${error.body.error.recovery}\n`);
        return error.exitCode;
      }
      throw error;
    }
  }
  const info = schemas.objective;
  if (!info) {
    e(missingSchemaError("objective") + "\n");
    return 1;
  }
  const p = artifactPath(info, "objective");
  const data = loadArtifact(p);
  const format = args.format ?? "text";
  const isDict = data !== null && typeof data === "object" && !Array.isArray(data);
  if (!isDict) {
    if (format !== "text") {
      return emitStateStructured(
        "objective",
        structuredState("objective", [], sourceMetadata("objective", p), { filters: { status: args.status ?? null } }),
        format,
        args.fields,
        o,
        e,
      );
    }
    return 0;
  }
  // cast: data is the parsed objective artifact from loadArtifact (YAML/MD IO boundary)
  const d = data as JsonObject;
  const legacyEntries = asList(d.entries);
  if (legacyEntries.length > 0) {
    let entries = legacyEntries;
    const statusFilter = args.status ?? null;
    if (statusFilter) entries = filterByFieldValue(entries, "status", statusFilter);
    if (format !== "text") {
      return emitStateStructured(
        "objective",
        structuredState("objective", entries, sourceMetadata("objective", p), { filters: { status: statusFilter } }),
        format,
        args.fields,
        o,
        e,
      );
    }
    for (const entry of entries) {
      const line = formatEntry(entry, ["title", "status", "target", "reason"]);
      if (line) o(line + "\n");
    }
    return 0;
  }
  const header = d.header && typeof d.header === "object" && !Array.isArray(d.header) ? d.header : {};
  const objective = d.objective && typeof d.objective === "object" && !Array.isArray(d.objective) ? d.objective : d;
  const title = firstPresent(header, ["title"], objective.title ?? "");
  const status = firstPresent(header, ["status"], objective.status ?? "");
  const closure = d.closure && typeof d.closure === "object" && !Array.isArray(d.closure) ? d.closure : {};
  if (format !== "text") {
    return emitStateStructured(
      "objective",
      structuredState("objective", objective ? [objective] : [], sourceMetadata("objective", p), {
        filters: { status: args.status ?? null },
        summary: { title, status, header, closure },
      }),
      format,
      args.fields,
      o,
      e,
    );
  }
  o(`Objective: title=${truncate(title)} | status=${status || "unknown"}\n`);
  for (const key of ["description", "target", "measurement", "direction", "unit"]) {
    const value = objective[key] ?? d[key];
    if (value) o(`${key}: ${truncate(value)}\n`);
  }
  if (Object.keys(closure).length > 0) {
    o(formatEntry(closure, ["final_value", "target", "reason"]) + "\n");
  }
  return 0;
}
