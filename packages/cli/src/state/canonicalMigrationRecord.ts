import type { JsonObject } from "../core/jsonValue.js";

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Apply the authority-owned legacy-to-canonical field removal and relationship mapping. */
export function canonicalMigrationRecord(
  boundary: string,
  source: JsonObject,
  forbiddenAliases: readonly string[],
  relationships: Array<{ field: string; target_id: string | null }> = [],
): JsonObject {
  const record = structuredClone(source);
  for (const field of ["id", "artifact", "number", ...forbiddenAliases]) delete record[field];
  if (boundary === "decision") delete record.satisfaction;
  if (boundary === "plan" || boundary === "objective") {
    const header = record.header;
    if (mapping(header)) delete header.id;
  }
  if (boundary === "plan") {
    delete record.tasks;
    delete record.previous_plan_archived;
    const header = record.header;
    if (mapping(header)) {
      if (header.status === "active") header.status = "open";
      if (header.status === "completed") header.status = "complete";
    }
  }
  for (const relationship of relationships) {
    if (relationship.field === "depends_on") {
      record.depends_on = relationships.filter(({ field }) => field === "depends_on").map(({ target_id }) => target_id as string);
    } else {
      record[relationship.field] = relationship.target_id as string;
    }
  }
  return record;
}
