import type { JsonObject } from "../core/jsonValue.js";

export const PROGRESS_PUBLICATION_ORDER_FIELD = "publication_order";

export function progressPublicationOrder(record: JsonObject | null): number | null {
  const value = record?.[PROGRESS_PUBLICATION_ORDER_FIELD];
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function progressPublicationOrderViolations(record: JsonObject): string[] {
  if (!(PROGRESS_PUBLICATION_ORDER_FIELD in record)) return [];
  return progressPublicationOrder(record) === null ? ["publication_order must be a positive safe integer when present"] : [];
}

export function nextProgressPublicationOrder(records: JsonObject[]): number {
  const maximum = records.reduce((current, record) => Math.max(current, progressPublicationOrder(record) ?? 0), 0);
  if (maximum >= Number.MAX_SAFE_INTEGER) {
    throw new Error("progress publication order is exhausted; preserve state and request repair before retrying");
  }
  return maximum + 1;
}
