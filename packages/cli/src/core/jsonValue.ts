/**
 * Canonical JSON/value shapes for CLI structured output and YAML artifact IO.
 * Prefer these types at module export boundaries; narrow with casts only at IO edges.
 */

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

/** @deprecated Import JsonObject at new boundaries; retained for gradual migration. */
export type Dict = JsonObject;
