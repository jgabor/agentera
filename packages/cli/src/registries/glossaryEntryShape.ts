import { isGlossaryIsoCalendarDate } from "./glossaryEntryTemporal.js";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

export function requiredEntryShape(entry: Mapping, authority: Mapping): string[] {
  const errors: string[] = [];
  const primitive = mapping(authority.shared_primitive);
  const fields = mapping(primitive?.fields);
  const consumer = mapping(authority.consumer_boundary);
  const forbidden = strings(consumer?.forbidden_persisted_entry_fields).filter((field) => field in entry);
  if (forbidden.length > 0) {
    errors.push(`entry contains forbidden persisted fields: ${forbidden.join(", ")}`);
  }
  const requiredFields = strings(primitive?.required_fields);
  const additional = Object.keys(entry).filter((field) => !requiredFields.includes(field));
  if (additional.length > 0) errors.push(`entry contains fields outside the shared primitive: ${additional.join(", ")}`);
  for (const field of requiredFields) {
    if (!(field in entry)) errors.push(`${field} is required`);
  }
  if (typeof entry.term !== "string" || entry.term.trim() === "") errors.push("term must be a non-empty string");
  if (typeof entry.meaning !== "string" || entry.meaning.trim() === "") errors.push("meaning must be a non-empty string");
  if (!Number.isInteger(entry.confidence) || Number(entry.confidence) < 0 || Number(entry.confidence) > 100) {
    errors.push("confidence must be an integer from protocol CS1-CS5");
  }
  if (!strings(mapping(fields?.permanence)?.values).includes(String(entry.permanence))) {
    errors.push("permanence must be an existing profile permanence class");
  }
  const temporal = mapping(entry.temporal);
  for (const field of strings(mapping(fields?.temporal)?.required_fields)) {
    if (!isGlossaryIsoCalendarDate(temporal?.[field])) errors.push(`temporal.${field} must be an ISO date`);
  }
  return errors;
}
