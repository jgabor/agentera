import { reject } from "./errors.js";

export function schemaViolation(violations: string[]): never {
  reject({ class: "schema_violation", message: violations[0], violations });
}

export function findByNumber(entries: Record<string, unknown>[], number: number): Record<string, unknown> | undefined {
  return entries.find((entry) => Number(entry.number) === number);
}

/** Coerce an unknown value into a plain mapping, returning `{}` for non-objects. */
export function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Return the object-valued elements of `doc[key]`, dropping non-mapping entries. */
export function array(doc: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return Array.isArray(doc[key]) ? (doc[key] as unknown[]).filter((v): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v))) : [];
}

/** Traverse a dotted field path into a nested mapping, returning `undefined` on miss. */
export function mappingPath(entry: Record<string, unknown>, field: string): unknown {
  let value: unknown = entry;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
