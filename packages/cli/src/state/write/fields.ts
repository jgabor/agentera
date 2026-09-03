import type { JsonObject } from "../../core/jsonValue.js";
import { ArtifactSchemaValidator } from "../../hooks/validateArtifact/index.js";
import type { OperationField, OperationSpec } from "./operations.js";

function schemaEntry(schema: JsonObject, fieldPath: string): JsonObject | null {
  const leaf = fieldPath.split(".").at(-1);
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const entry of Object.values(value as JsonObject)) {
      if (entry && typeof entry === "object" && !Array.isArray(entry) && String(entry.field ?? "") === leaf) {
        return entry as JsonObject;
      }
    }
  }
  return null;
}

function valuesFromValidation(entry: JsonObject | null): string[] | undefined {
  if (!entry || !Array.isArray(entry.validation)) return undefined;
  for (const raw of entry.validation) {
    const match = /Must be one of:\s*(.+)$/i.exec(String(raw));
    if (match)
      return match[1]
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
  }
  return undefined;
}

export function projectedFields(spec: OperationSpec, validator = new ArtifactSchemaValidator()): OperationField[] {
  const schema = validator.loadSchema(spec.artifact);
  if (!schema) return spec.fields;
  return spec.fields.map((field) => {
    const entry = schemaEntry(schema, field.field);
    return {
      ...field,
      required: field.required ?? Boolean(entry?.required),
      validValues: field.validValues ?? valuesFromValidation(entry),
      description: field.description ?? (entry?.description ? String(entry.description) : undefined),
    };
  });
}

export function schemaBudget(artifact: string, validator = new ArtifactSchemaValidator()): Record<string, number | null> {
  const schema = validator.loadSchema(artifact);
  const result: Record<string, number | null> = {};
  if (!schema || !schema.BUDGET || typeof schema.BUDGET !== "object" || Array.isArray(schema.BUDGET)) return result;
  for (const entry of Object.values(schema.BUDGET as JsonObject)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const scope = String(entry.scope ?? "");
    const key = scope.includes("full_file") ? "full_file_max_words" : "per_entry_max_words";
    result[key] = typeof entry.max_words === "number" ? entry.max_words : null;
  }
  return result;
}
