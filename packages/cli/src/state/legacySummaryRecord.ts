import type { JsonObject } from "../core/jsonValue.js";

/** Normalize exactly the legacy summary row shapes accepted by migration preview. */
export function legacySummaryRecord(value: unknown): JsonObject | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return typeof value === "string" ? { summary: value } : null;
}
