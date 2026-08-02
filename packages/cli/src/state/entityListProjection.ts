import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure } from "./directRetrieval.js";
import { serializedProjectionBytes } from "./projectionPolicy.js";
import { shellQuoteArgument } from "../core/shell.js";
import { entityListFamily, entityListValidValues } from "./entityRetrievalHelp.js";
import type { EntityListRuntimeFamilyKey } from "./entityListRuntimeRegistry.js";

export interface EntityListSelectorInput {
  idsOnly?: boolean;
  fields?: string;
}

export interface EntityListProjectionOptions {
  family: EntityListRuntimeFamilyKey;
  artifact: string;
  boundary: string;
  format: string;
  maxUtf8Bytes: number;
  selector?: EntityListSelectorInput;
}

export interface ResolvedEntityListSelector {
  mode: "default" | "ids_only" | "fields";
  fields: string[];
}

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(options: EntityListProjectionOptions, message: string, recovery: string, exitCode: 1 | 2, validValues?: string[]): never {
  const family = entityListFamily(options.family);
  throw new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: exitCode === 2 ? "invalid_request" : "unsupported_state",
      message,
      syntax: family.syntax,
      example: family.example,
      recovery: exitCode === 2 ? `Run \`${family.example}\`; no state was changed.` : recovery,
      artifact: options.artifact,
      ...(validValues ? { valid_values: validValues } : exitCode === 2 ? { valid_values: entityListValidValues(family) } : {}),
    },
  }, exitCode);
}

function fieldPaths(value: unknown, prefix = ""): string[] {
  if (!mapping(value)) return [];
  return Object.entries(value).flatMap(([name, child]) => {
    const field = prefix ? `${prefix}.${name}` : name;
    return mapping(child) ? [field, ...fieldPaths(child, field)] : [field];
  });
}

function selectedValue(record: JsonObject, field: string): JsonValue | undefined {
  let value: JsonValue | undefined = record;
  for (const part of field.split(".")) {
    if (!mapping(value) || !(part in value)) return undefined;
    value = value[part];
  }
  return value;
}

function assignSelected(target: JsonObject, field: string, value: JsonValue): void {
  const parts = field.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!mapping(current[part])) current[part] = {};
    current = current[part] as JsonObject;
  }
  current[parts.at(-1)!] = structuredClone(value);
}

export function resolveEntityListSelector(
  input: EntityListSelectorInput | undefined,
  entries: JsonObject[],
  options: EntityListProjectionOptions,
): ResolvedEntityListSelector {
  if (input?.idsOnly && input.fields !== undefined) {
    fail(options, "--ids-only and --fields cannot be combined", "Choose one bounded selector and retry; no state was changed.", 2);
  }
  if (input?.idsOnly) return { mode: "ids_only", fields: [] };
  if (input?.fields === undefined) return { mode: "default", fields: [] };
  const requested = input.fields.split(",").map((field) => field.trim());
  if (!requested.length || requested.some((field) => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(field))) {
    fail(options, "--fields must be a comma-separated list of record field paths", "Use lowercase record paths such as status or header.title; no state was changed.", 2);
  }
  if (new Set(requested).size !== requested.length) {
    fail(options, "--fields contains a duplicate field path", "Remove duplicate field paths and retry; no state was changed.", 2);
  }
  const fields = [...requested].sort();
  const available = [...new Set(entries.flatMap((entry) => fieldPaths(entry.record)))].sort();
  const unsupported = fields.find((field) => !available.includes(field));
  if (unsupported) {
    fail(options, `unsupported record field '${unsupported}' for this filtered ${options.artifact} snapshot; available fields: ${available.join(", ") || "none"}`, "Choose a listed field or change the filters, then restart without --cursor; no state was changed.", 2, available);
  }
  return { mode: "fields", fields };
}

export function entityListSelectorKey(selector: ResolvedEntityListSelector): string {
  return canonicalRecordJson({ mode: selector.mode, fields: selector.fields });
}

export function entityListSelectorFlags(selector: ResolvedEntityListSelector): string {
  if (selector.mode === "ids_only") return " --ids-only";
  if (selector.mode === "fields") return ` --fields ${shellQuoteArgument(selector.fields.join(","))}`;
  return "";
}

function identityEntry(
  entry: JsonObject,
  family: ReturnType<typeof entityListFamily>,
  fields: readonly string[],
): JsonObject {
  const id = String(entry.id);
  const result: JsonObject = { id, artifact: String(entry.artifact) };
  for (const field of fields) {
    if (field === "id" || field === "artifact") continue;
    if (field === "retrieval.get") {
      result.retrieval = { get: family.get.replace("ID", id) };
      continue;
    }
    const value = selectedValue(entry, field);
    if (value !== undefined) assignSelected(result, field, value);
  }
  return result;
}

function projectEntry(entry: JsonObject, selector: ResolvedEntityListSelector, family: ReturnType<typeof entityListFamily>): JsonObject {
  const fields = selector.mode === "default" ? family.summaryFields : family.minimumFields;
  const identity = identityEntry(entry, family, fields);
  if (selector.mode === "ids_only" || selector.mode === "default") return identity;
  const record: JsonObject = {};
  for (const field of selector.fields) {
    const value = mapping(entry.record) ? selectedValue(entry.record, field) : undefined;
    if (value !== undefined) assignSelected(record, field, value);
  }
  return { ...identity, record };
}

function omittedTopLevelFields(fullEntries: JsonObject[], retainedEntries: JsonObject[]): string[] {
  const omitted = new Set<string>();
  fullEntries.forEach((entry, index) => {
    const retained = retainedEntries[index] ?? {};
    for (const field of Object.keys(entry)) if (!(field in retained)) omitted.add(field);
  });
  return [...omitted].sort();
}

function degradedProjection(
  response: JsonObject,
  entries: JsonObject[],
  selector: ResolvedEntityListSelector,
  options: EntityListProjectionOptions,
  family: ReturnType<typeof entityListFamily>,
  fullEntries: JsonObject[],
  detail: "summary" | "minimum",
): JsonObject {
  return normalize({
    ...response,
    status: "degraded",
    degradation: {
      reason: "optional_detail_byte_budget",
      detail_omitted_count: entries.length,
      omitted_fields: omittedTopLevelFields(fullEntries, entries),
      recovery: family.get,
    },
  }, entries, selector, options, detail);
}

function normalize(
  response: JsonObject,
  entries: JsonObject[],
  selector: ResolvedEntityListSelector,
  options: EntityListProjectionOptions,
  detail: string,
): JsonObject {
  const family = entityListFamily(options.family);
  const counts = mapping(response.counts) ? response.counts : {};
  const snapshot = mapping(response.snapshot) ? response.snapshot : {};
  const candidate = Number(snapshot.candidate_count ?? counts.total ?? entries.length);
  const remaining = Number(counts.remaining ?? 0);
  const retrieval = mapping(response.retrieval) ? response.retrieval : {};
  return {
    ...response,
    entries,
    counts: {
      ...counts,
      total: candidate,
      candidate,
      returned: entries.length,
      remaining,
      omitted: remaining,
      continuation: remaining,
    },
    snapshot: { ...snapshot, candidate_count: candidate, has_more: remaining > 0 },
    retrieval: { ...retrieval, get: family.get },
    projection: {
      selector: selector.mode,
      detail,
      cardinality: "requested_rows",
      ...(selector.mode === "fields" ? { fields: selector.fields } : {}),
    },
  };
}

export function projectEntityList(
  response: JsonObject,
  selector: ResolvedEntityListSelector,
  options: EntityListProjectionOptions,
): JsonObject {
  const family = entityListFamily(options.family);
  const fullEntries = Array.isArray(response.entries) ? response.entries.filter(mapping) : [];
  const selectedEntries = selector.mode === "default"
    ? fullEntries.map((entry) => ({ ...entry, retrieval: identityEntry(entry, family, family.minimumFields).retrieval }))
    : fullEntries.map((entry) => projectEntry(entry, selector, family));
  const selectedDetail = selector.mode === "default" ? "full" : selector.mode === "fields" ? "selected_fields" : "identity";
  const selected = normalize(response, selectedEntries, selector, options, selectedDetail);
  if (serializedProjectionBytes(selected, options.format === "text" ? "yaml" : options.format) <= options.maxUtf8Bytes) return selected;

  if (selector.mode !== "default") {
    fail(options, `${selector.mode === "fields" ? "selected fields" : "IDs-only rows"} cannot fit the ${options.maxUtf8Bytes}-byte ${options.format} list budget`, "Request fewer rows or fewer fields and retry; no fields or rows were returned partially.", 1);
  }
  const summaries = fullEntries.map((entry) => projectEntry(entry, selector, family));
  const degraded = degradedProjection(response, summaries, selector, options, family, fullEntries, "summary");
  if (serializedProjectionBytes(degraded, options.format === "text" ? "yaml" : options.format) <= options.maxUtf8Bytes) return degraded;
  const minimumEntries = fullEntries.map((entry) => identityEntry(entry, family, family.minimumFields));
  const minimum = degradedProjection(response, minimumEntries, selector, options, family, fullEntries, "minimum");
  if (serializedProjectionBytes(minimum, options.format === "text" ? "yaml" : options.format) <= options.maxUtf8Bytes) return minimum;
  fail(options, `the requested summary rows cannot fit the ${options.maxUtf8Bytes}-byte ${options.format} list budget`, "Request fewer rows and retry; no rows were returned partially.", 1);
}
