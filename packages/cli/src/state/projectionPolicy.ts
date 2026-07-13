import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import type { JsonObject, JsonValue } from "../core/jsonValue.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";
const AUTHORITY_SCHEMA_VERSION = "agentera.stateStorageAuthority.v1";

export interface ProjectionPolicy {
  activeEntries: number;
  summaryEntries: number;
  totalEntries: number;
  maxUtf8Bytes: number;
}

export interface ProjectionOmissionMetadata extends JsonObject {
  omitted: boolean;
  omitted_count: number;
  omission_reason: string;
  retrieval: JsonObject;
  omission_provenance: JsonValue;
}

export type ProjectionOmissionSource = "archive" | "legacy_summary" | "current_projection";

export interface ProjectionOmissionProvenance extends JsonObject {
  source: ProjectionOmissionSource;
  detail_availability: "full" | "summary" | "unavailable";
  compatibility: "complete" | "degraded";
  archive_verified: boolean;
  omitted_count: number;
}

const NUMBERED_ARTIFACTS = new Set(["progress", "decisions", "health"]);

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`state storage authority field '${field}' must be a positive integer`);
  }
  return value;
}

export function loadProjectionPolicy(sourceRoot: string = resolveSourceRoot()): ProjectionPolicy {
  const authorityPath = path.join(sourceRoot, AUTHORITY_RELATIVE_PATH);
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  if (authority.schema_version !== AUTHORITY_SCHEMA_VERSION) {
    throw new Error(`state storage authority schema_version must be ${AUTHORITY_SCHEMA_VERSION}`);
  }
  const capacity = mapping(mapping(authority.projections).current).default_capacity;
  const activeEntries = positiveInteger(
    mapping(capacity).active_entries,
    "projections.current.default_capacity.active_entries",
  );
  const summaryEntries = positiveInteger(
    mapping(capacity).summary_entries,
    "projections.current.default_capacity.summary_entries",
  );
  const totalEntries = positiveInteger(
    mapping(capacity).total_entries,
    "projections.current.default_capacity.total_entries",
  );
  if (activeEntries + summaryEntries !== totalEntries) {
    throw new Error("state storage authority projection capacity must equal active plus summary entries");
  }
  const maxUtf8Bytes = positiveInteger(
    mapping(mapping(authority.budgets).projection).max_utf8_bytes,
    "budgets.projection.max_utf8_bytes",
  );
  return { activeEntries, summaryEntries, totalEntries, maxUtf8Bytes };
}

export function projectionRetrieval(command: string): JsonObject {
  if (NUMBERED_ARTIFACTS.has(command)) {
    return { available: true, command: `agentera state ${command} get --number N --format json` };
  }
  return {
    available: false,
    reason: "unsupported_numbered_retrieval",
    artifact_id: command,
  };
}

export function projectionOmission(
  command: string,
  count: number,
  reason: string,
  options: { forceOmitted?: boolean; provenance?: ProjectionOmissionProvenance | ProjectionOmissionProvenance[] } = {},
): ProjectionOmissionMetadata {
  return {
    omitted: options.forceOmitted ?? count > 0,
    omitted_count: count,
    omission_reason: reason,
    retrieval: projectionRetrieval(command),
    omission_provenance: options.provenance ?? null,
  };
}

export function serializedProjectionBytes(value: unknown, format: string): number {
  const serialized =
    format === "yaml" ? YAML.stringify(value, { sortMapEntries: false }) : JSON.stringify(value, null, 2) + "\n";
  return Buffer.byteLength(serialized, "utf8");
}

function entryNumber(value: JsonValue, index: number): [number, number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [Number.POSITIVE_INFINITY, index];
  const object = value as JsonObject;
  const candidates = [object.entry_number, object.number];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) return [candidate, index];
    if (typeof candidate === "string" && /^[1-9][0-9]*$/.test(candidate)) return [Number(candidate), index];
  }
  const stableId = object.stable_id;
  if (typeof stableId === "string") {
    const match = /:(\d+)$/.exec(stableId);
    if (match) return [Number(match[1]), index];
  }
  return [Number.POSITIVE_INFINITY, index];
}

function omissionCount(value: JsonObject): number {
  const count = value.omitted_count;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function boundedValue(
  value: JsonObject,
  itemKey: "entries" | "operations",
  items: JsonValue[],
  omittedCount: number,
  command: string,
): JsonObject {
  const result: JsonObject = { ...value, [itemKey]: items };
  const existingCounts = result.counts;
  if (itemKey === "entries" && existingCounts && typeof existingCounts === "object" && !Array.isArray(existingCounts)) {
    result.counts = {
      ...(existingCounts as JsonObject),
      entries: items.length + omittedCount,
      returned_entries: items.length,
    };
  }
  return {
    ...result,
    ...projectionOmission(command, omittedCount, "projection_byte_budget", { forceOmitted: true }),
  };
}

function minimalBudgetedProjection(
  command: string,
  omittedCount: number,
  policy: ProjectionPolicy,
  format: string,
): JsonObject {
  const omission = projectionOmission(command, omittedCount, "projection_required_fields_exceed_budget", {
    forceOmitted: true,
    provenance: {
      source: "current_projection",
      detail_availability: "unavailable",
      compatibility: "degraded",
      archive_verified: false,
      omitted_count: omittedCount,
    },
  });
  const fallback: JsonObject = {
    command,
    status: "degraded",
    entries: [],
    counts: { entries: omittedCount, returned_entries: 0 },
    source: { artifact: command, detail_availability: "unavailable", source: "current_projection" },
    ...omission,
    error: {
      class: "projection_output_budget",
      message: "optional projection detail was omitted because required output fields exceeded the authority byte budget",
      syntax: `agentera state ${command} --format json`,
      example: `agentera state ${command} --format json`,
      recovery: omission.retrieval.available === true
        ? String(omission.retrieval.command)
        : "No direct retrieval route is declared for this artifact; use its supported state command.",
    },
  };
  if (serializedProjectionBytes(fallback, format) <= policy.maxUtf8Bytes) return fallback;

  const minimal: JsonObject = {
    command,
    status: "degraded",
    omitted: true,
    omitted_count: omittedCount,
    omission_reason: "projection_output_budget",
    retrieval: omission.retrieval,
  };
  if (serializedProjectionBytes(minimal, format) > policy.maxUtf8Bytes) {
    throw new Error(`projection output budget ${policy.maxUtf8Bytes} bytes is too small for required omission metadata`);
  }
  return minimal;
}

/**
 * Bound a structured projection without truncating strings or splitting UTF-8.
 * Entries are removed oldest-first by numeric identity; every removal is
 * declared in the response and points at the future direct-get surface.
 */
export function boundStructuredProjection(
  value: JsonObject,
  command: string,
  format: string,
  policy: ProjectionPolicy = loadProjectionPolicy(),
): JsonObject {
  if (serializedProjectionBytes(value, format) <= policy.maxUtf8Bytes) return value;

  const itemKey = Array.isArray(value.entries)
    ? "entries"
    : Array.isArray(value.operations)
      ? "operations"
      : null;
  if (itemKey === null) return minimalBudgetedProjection(command, 0, policy, format);

  const items = value[itemKey] as JsonValue[];
  const removalOrder = items
    .map((item, index) => ({ index, key: entryNumber(item, index) }))
    .sort((left, right) => left.key[0] - right.key[0] || left.key[1] - right.key[1]);
  let omitted = omissionCount(value);
  let retained = [...items];
  for (const candidate of removalOrder) {
    if (serializedProjectionBytes(boundedValue(value, itemKey, retained, omitted, command), format) <= policy.maxUtf8Bytes) {
      return boundedValue(value, itemKey, retained, omitted, command);
    }
    const retainedIndex = retained.indexOf(items[candidate.index]);
    if (retainedIndex >= 0) retained.splice(retainedIndex, 1);
    omitted += 1;
  }

  let result = boundedValue(value, itemKey, retained, omitted, command);
  if (serializedProjectionBytes(result, format) <= policy.maxUtf8Bytes) return result;
  return minimalBudgetedProjection(command, omitted, policy, format);
}
