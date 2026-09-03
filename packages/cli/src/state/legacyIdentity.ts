export type LegacyIdentityKind = "canonical_number" | "explicit_decision_shorthand" | "unaddressable" | "ambiguous";

export interface LegacyIdentity {
  number: number | null;
  kind: LegacyIdentityKind;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function mapping(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A shorthand is an identity only when it is the leading token of a decision
 * summary. References later in the prose are evidence, not identity.
 */
const LEADING_DECISION_SHORTHAND = /^D([1-9][0-9]*)(?=$|[\s:([,.;])/;
const LEADING_DECISION_COMPOUND = /^D[1-9][0-9]*\s*\+\s*D[1-9][0-9]*/;

export function legacyIdentity(value: unknown, artifactId: string, entryNumberField: string): LegacyIdentity {
  const object = mapping(value);
  if (object) {
    const explicit = positiveNumber(object[entryNumberField]);
    if (explicit !== null) return { number: explicit, kind: "canonical_number" };
    if (typeof object.summary === "string") return legacyIdentity(object.summary, artifactId, entryNumberField);
    return { number: null, kind: "unaddressable" };
  }
  if (typeof value !== "string") return { number: null, kind: "unaddressable" };
  const text = value.trim();
  if (artifactId === "decisions") {
    if (LEADING_DECISION_COMPOUND.test(text)) return { number: null, kind: "ambiguous" };
    const shorthand = LEADING_DECISION_SHORTHAND.exec(text);
    if (shorthand) return { number: positiveNumber(shorthand[1]), kind: "explicit_decision_shorthand" };
  }
  const label = artifactId === "progress" ? "Cycle" : artifactId === "decisions" ? "Decision" : "Audit";
  const match = new RegExp(`^${label}\\s+([1-9][0-9]*)\\b`).exec(text);
  return match ? { number: positiveNumber(match[1]), kind: "canonical_number" } : { number: null, kind: "unaddressable" };
}

export function legacyEntryNumber(value: unknown, artifactId: string, entryNumberField: string): number | null {
  return legacyIdentity(value, artifactId, entryNumberField).number;
}
