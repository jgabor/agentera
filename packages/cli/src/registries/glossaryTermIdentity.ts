import { createHash } from "node:crypto";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locale-independent Unicode caseless-exact equality with no normalization.
 *
 * ECMAScript's `iu` matching supplies Unicode simple case folding. Escaping
 * makes the bounded term literal, while the anchors and terminal lookahead
 * prevent regex syntax and final-line-terminator behavior from widening exact
 * matching. NFC/NFD, accent, and compatibility normalization are intentionally
 * absent, so differently encoded strings remain distinct unless Unicode case
 * folding itself relates them.
 */
export function unicodeCaselessExact(left: string, right: string): boolean {
  const literal = escapeRegExp(left);
  return new RegExp(`^(?:${literal})$(?![\\s\\S])`, "iu").test(right);
}

function compareCodePoints(left: string, right: string): number {
  const leftCodePoint = left.codePointAt(0) ?? 0;
  const rightCodePoint = right.codePointAt(0) ?? 0;
  return leftCodePoint - rightCodePoint;
}

export function compareGlossaryUnicodeStrings(left: string, right: string): number {
  const leftScalars = [...left];
  const rightScalars = [...right];
  for (let index = 0; index < Math.min(leftScalars.length, rightScalars.length); index += 1) {
    const comparison = compareCodePoints(leftScalars[index]!, rightScalars[index]!);
    if (comparison !== 0) return comparison;
  }
  return leftScalars.length - rightScalars.length;
}

function singleScalar(value: string): string | null {
  return [...value].length === 1 ? value : null;
}

/**
 * Build the same simple-case equivalence key used by the stable identity.
 * Lowercase mapping is the primary Unicode simple-fold projection. A
 * lowercased uppercase mapping is admitted only when the existing equality
 * matcher confirms it, which avoids transitive casing mistakes such as
 * treating ASCII `I` and dotless `ı` as equal.
 */
function unicodeSimpleCaseFoldKey(value: string): string {
  return [...value]
    .map((character) => {
      const lower = singleScalar(character.toLowerCase()) ?? character;
      const upper = singleScalar(character.toUpperCase());
      const upperLower = upper === null ? null : singleScalar(upper.toLowerCase());
      if (upperLower !== null && unicodeCaselessExact(character, upperLower)) {
        return upperLower;
      }
      return lower;
    })
    .join("");
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Return a content-addressed identity for one Unicode caseless-exact term.
 * The original spelling is not changed or stored in the identity key.
 */
export function stableGlossaryTermIdentity(term: string): string {
  const value = requireNonEmpty(term, "term");
  const key = unicodeSimpleCaseFoldKey(value);
  return sha256Utf8(
    JSON.stringify({
      schema_version: "agentera.personalGlossaryTermIdentity.v1",
      key,
    }),
  );
}

export const GLOSSARY_CANDIDATE_SCOPES = ["personal", "project", "ambiguous"] as const;

export type GlossaryCandidateScope = (typeof GLOSSARY_CANDIDATE_SCOPES)[number];

export function isGlossaryCandidateScope(value: unknown): value is GlossaryCandidateScope {
  return GLOSSARY_CANDIDATE_SCOPES.includes(value as GlossaryCandidateScope);
}

export interface GlossaryCandidateEvidenceIdentity {
  source_id: string;
  evidence_anchor: string;
  [field: string]: unknown;
}

export interface GlossaryCandidateRevisionInput {
  stable_term_identity: string;
  meaning: string;
  scope: GlossaryCandidateScope;
  evidence: readonly GlossaryCandidateEvidenceIdentity[];
  policy_version: string;
  generation: string;
}

export function canonicalGlossaryJson(value: unknown): string {
  if (value === undefined) throw new TypeError("canonical JSON cannot contain undefined");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalGlossaryJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareGlossaryUnicodeStrings)
    .map((key) => `${JSON.stringify(key)}:${canonicalGlossaryJson(record[key])}`)
    .join(",")}}`;
}

export function glossaryCanonicalSha256(value: unknown): string {
  return sha256Utf8(canonicalGlossaryJson(value));
}

/**
 * Return a content-addressed candidate revision without mining or publishing.
 * Evidence order is not semantic, but every evidence identity remains bound.
 */
export function glossaryCandidateRevision(input: GlossaryCandidateRevisionInput): string {
  const stableTermIdentity = requireNonEmpty(input.stable_term_identity, "stable_term_identity");
  const meaning = requireNonEmpty(input.meaning, "meaning");
  const policyVersion = requireNonEmpty(input.policy_version, "policy_version");
  const generation = requireNonEmpty(input.generation, "generation");
  if (!Array.isArray(input.evidence)) throw new TypeError("evidence must be a list");
  if (!isGlossaryCandidateScope(input.scope)) {
    throw new TypeError("scope must be personal, project, or ambiguous");
  }
  const evidence = input.evidence.map((item) => {
    requireNonEmpty(item.source_id, "evidence.source_id");
    requireNonEmpty(item.evidence_anchor, "evidence.evidence_anchor");
    return item;
  });
  const canonicalEvidence = new Set<string>();
  for (const item of evidence) {
    const canonical = canonicalGlossaryJson(item);
    if (canonicalEvidence.has(canonical)) {
      throw new TypeError("evidence must not contain duplicate canonical evidence records");
    }
    canonicalEvidence.add(canonical);
  }
  evidence.sort(
    (left, right) => {
      const leftCanonical = canonicalGlossaryJson(left);
      const rightCanonical = canonicalGlossaryJson(right);
      return compareGlossaryUnicodeStrings(leftCanonical, rightCanonical);
    },
  );
  return sha256Utf8(
    canonicalGlossaryJson({
      schema_version: "agentera.personalGlossaryCandidateRevision.v1",
      stable_term_identity: stableTermIdentity,
      meaning,
      scope: input.scope,
      evidence,
      policy_version: policyVersion,
      generation,
    }),
  );
}
