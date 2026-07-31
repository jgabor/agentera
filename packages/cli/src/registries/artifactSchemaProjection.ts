import type { JsonObject } from "../core/jsonValue.js";

const FIELD_SKIP = new Set([
  "meta",
  "GROUP_PREFIXES",
  "BUDGET",
  "COMPACTION",
  "VALIDATION",
  "ARCHIVE",
  "CONVENTION",
  "CONVENTIONS",
]);

function mapping(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function artifactSchemaFieldDescription(entry: JsonObject, group: string): JsonObject {
  return {
    id: entry.id ?? null,
    group,
    field: entry.field ?? null,
    ...(typeof entry.path === "string" ? { path: entry.path } : {}),
    type: entry.type ?? "unknown",
    required: "required" in entry ? entry.required : "unknown",
    format: entry.format ?? null,
    validation: entry.validation ?? [],
    ...(entry.accepted_forms !== undefined ? { accepted_forms: structuredClone(entry.accepted_forms) } : {}),
    ...(entry.normalization !== undefined ? { normalization: structuredClone(entry.normalization) } : {}),
    ...(entry.write_operations !== undefined ? { write_operations: structuredClone(entry.write_operations) } : {}),
  };
}

export function describeArtifactSchemaFields(schema: JsonObject): JsonObject[] {
  const fields: JsonObject[] = [];
  for (const [group, value] of Object.entries(schema)) {
    if (FIELD_SKIP.has(group) || !mapping(value)) continue;
    for (const entry of Object.values(value)) {
      if (mapping(entry) && "field" in entry)
        fields.push(artifactSchemaFieldDescription(entry, group));
    }
  }
  return fields;
}

export function artifactSchemaFieldsForOperation(
  schema: JsonObject | null,
  verb: string,
): JsonObject[] {
  if (!schema) return [];
  return describeArtifactSchemaFields(schema).filter((field) =>
    Array.isArray(field.write_operations) && field.write_operations.includes(verb));
}
