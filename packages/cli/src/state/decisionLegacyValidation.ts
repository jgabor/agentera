/**
 * Task 4: enforce legacy coexistence across decision mutations.
 *
 * The whole-artifact validation gate validates the entire decisions artifact
 * bytes. An untouched inherited record carrying a legacy confidence label
 * (e.g. `high`) is unsupported by the decisions schema, so the strict gate
 * blocked append, satisfaction update, and amend even when the operation never
 * touched the legacy record.
 *
 * The authority's `compatibility.legacy_label_coexistence` rule (read through
 * `legacyLabelCoexistence`) classifies an unsupported inherited label on a
 * record the caller did not touch as explicit legacy state: it is preserved
 * byte- and value-semantically, reported as a caveat, never coerced to the
 * current vocabulary, and never blocks an operation on a different target. A
 * confidence label supplied by append or amend is new/amended content and
 * remains strict — it must be current vocabulary or the operation rejects
 * before side effects.
 *
 * This module partitions schema violations into `blocking` (which still fail
 * the operation) and `legacy_caveats` (untouched inherited legacy confidence
 * labels that are preserved and reported). It never coerces a value and never
 * broadens tolerance beyond the authority-declared confidence dimension: a
 * missing required field, a type error, an invalid satisfaction state, or any
 * other non-confidence violation stays blocking. (Touched confidence violations
 * — a new/amended record whose confidence is unsupported — also stay blocking:
 * the target/new content path remains strict.)
 */

import { classifyConfidenceLabel, legacyLabelCoexistence, type LegacyLabelCoexistence } from "./decisionRevision.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

export type { LegacyLabelCoexistence } from "./decisionRevision.js";

export interface DecisionConfidenceCaveat {
  /** Decision number carrying the untouched inherited legacy label. */
  number: number;
  /** The legacy confidence value, preserved unchanged (e.g. `high`). */
  label: string;
  /** Whether the legacy record was in the active projection or the archive list. */
  source: "active" | "archive";
  /** Truthful compatibility caveat text derived from the authority rule. */
  caveat: string;
}

export interface DecisionLegacyPartition {
  /** Violations that remain blocking (everything but tolerated legacy confidence labels). */
  blocking: string[];
  /** Untouched inherited legacy confidence labels, preserved and reported as caveats. */
  legacy_caveats: DecisionConfidenceCaveat[];
}

export interface CompleteDecisionConfidenceClassification {
  status: "current" | "inherited" | "invalid";
  violations: string[];
  caveat: DecisionConfidenceCaveat | null;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Matches: `decisions: invalid value 'high' for 'decisions[0].confidence' (expected one of: ...)`.
const CONFIDENCE_VIOLATION = /^decisions: invalid value '(?<value>[^']*)' for '(?<list>decisions|archive)\[(?<idx>\d+)\]\.confidence' \(expected one of:/;

function recordAt(doc: Record<string, unknown>, list: string, idx: number): Record<string, unknown> {
  const arr = doc[list];
  if (!Array.isArray(arr)) return {};
  const entry = arr[idx];
  return isMapping(entry) ? entry : {};
}

/**
 * Partition decisions schema violations. Each confidence-label violation maps
 * to the record it names; when that record was not touched by the current
 * operation, the unsupported label is explicit legacy state (tolerated,
 * caveated). When the record WAS touched (new or amended content), the
 * unsupported label is rejected — target/new content must be current
 * vocabulary. Every other violation stays blocking, so tolerance never extends
 * beyond the authority-declared confidence dimension.
 *
 * `touchedNumbers` carries the decision numbers the caller touched (new or
 * amended targets). For whole-artifact prevalidation of the existing artifact
 * nothing is touched yet, so callers pass an empty set.
 */
export function partitionDecisionViolations(violations: string[], doc: Record<string, unknown>, coexistence: LegacyLabelCoexistence, touchedNumbers: ReadonlySet<number> = new Set()): DecisionLegacyPartition {
  const blocking: string[] = [];
  const legacy_caveats: DecisionConfidenceCaveat[] = [];
  for (const violation of violations) {
    const match = CONFIDENCE_VIOLATION.exec(violation);
    if (!match || !match.groups) {
      blocking.push(violation);
      continue;
    }
    const { value, list, idx } = match.groups;
    const source: "active" | "archive" = list === "archive" ? "archive" : "active";
    const record = recordAt(doc, list, Number(idx));
    const number = Number(record.number);
    const classification = classifyConfidenceLabel(coexistence, value, touchedNumbers.has(number));
    if (classification.classification === "explicit_legacy") {
      legacy_caveats.push({ number, label: value, source, caveat: classification.caveat });
    } else {
      // Touched unsupported (rejected) or current-but-flagged: keep strict.
      blocking.push(violation);
    }
  }
  return { blocking, legacy_caveats };
}

/**
 * Classify one record's confidence for amendment/read composition. An
 * untouched inherited unsupported label is explicit legacy state and surfaces
 * as a single caveat (never coerced, never promoted). `touched=true` marks
 * the confidence as new or amended content; such a value can only be current
 * vocabulary (enforced elsewhere), so no caveat is produced. Returns `null`
 * when the confidence is current vocabulary or absent.
 */
export function legacyConfidenceCaveat(record: Record<string, unknown>, coexistence: LegacyLabelCoexistence, touched: boolean, source: "active" | "archive" = "active"): DecisionConfidenceCaveat | null {
  const confidence = record.confidence;
  if (typeof confidence !== "string") return null;
  const classification = classifyConfidenceLabel(coexistence, confidence, touched);
  if (classification.classification !== "explicit_legacy") return null;
  return {
    number: Number(record.number),
    label: confidence,
    source,
    caveat: classification.caveat,
  };
}

/**
 * Return a caveat only for a label declared as known v2 legacy state. Migration
 * uses this narrower classifier so an arbitrary unsupported confidence value
 * cannot become publishable merely because it occupies the confidence field.
 */
export function knownLegacyConfidenceCaveat(record: Record<string, unknown>, coexistence: LegacyLabelCoexistence, source: "active" | "archive" = "active"): DecisionConfidenceCaveat | null {
  if (typeof record.confidence !== "string" || !coexistence.knownLegacyExamples.includes(record.confidence)) return null;
  return legacyConfidenceCaveat(record, coexistence, false, source);
}

/**
 * Classify a complete migration source record without interpreting validator
 * error text. A known legacy confidence is inherited only when replacing that
 * one field with an authority-declared current value makes the whole record
 * valid. Projection and verified-archive migration both use this classifier.
 */
export function classifyCompleteDecisionConfidence(record: Record<string, unknown>, coexistence: LegacyLabelCoexistence, validate: (candidate: Record<string, unknown>) => string[], source: "active" | "archive"): CompleteDecisionConfidenceClassification {
  if (coexistence.dimensions.length !== 1 || coexistence.dimensions[0] !== "confidence") {
    throw new Error("decision legacy coexistence must declare confidence as its sole compatibility dimension");
  }
  const violations = validate(record);
  if (violations.length === 0) return { status: "current", violations, caveat: null };
  const caveat = knownLegacyConfidenceCaveat(record, coexistence, source);
  if (!caveat || coexistence.currentVocabulary.length === 0) return { status: "invalid", violations, caveat: null };
  const strictCandidate = { ...record, confidence: coexistence.currentVocabulary[0] };
  return validate(strictCandidate).length === 0 ? { status: "inherited", violations, caveat } : { status: "invalid", violations, caveat: null };
}

/**
 * Scan a parsed decisions artifact mapping for untouched inherited legacy
 * confidence labels. Records whose number is in `touchedNumbers` are new or
 * amended content and are excluded — they remain strict. Used to report
 * truthful compatibility caveats that reflect the published bytes.
 */
export function collectDecisionLegacyCaveats(doc: Record<string, unknown>, coexistence: LegacyLabelCoexistence, touchedNumbers: ReadonlySet<number> = new Set()): DecisionConfidenceCaveat[] {
  const caveats: DecisionConfidenceCaveat[] = [];
  for (const [list, source] of [
    ["decisions", "active"],
    ["archive", "archive"],
  ] as const) {
    const arr = doc[list];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (!isMapping(entry)) continue;
      const caveat = legacyConfidenceCaveat(entry, coexistence, touchedNumbers.has(Number(entry.number)), source);
      if (caveat) caveats.push(caveat);
    }
  }
  return caveats;
}

/** Load the legacy label coexistence authority section for a project. */
export function decisionLegacyCoexistence(sourceRoot: string = resolveSourceRoot()): LegacyLabelCoexistence {
  return legacyLabelCoexistence(sourceRoot);
}

/**
 * Gate 1 — prevalidation of the existing artifact. When coexistence is null
 * (non-decisions artifact), throws the standard schema-invalid error. When
 * coexistence is active, partitions: tolerates untouched inherited legacy
 * confidence labels only; every other violation stays blocking. Returns
 * legacy caveats from the violations.
 */
export function gateExistingDecisions(violations: string[], doc: Record<string, unknown>, coexistence: LegacyLabelCoexistence | null, target: string): DecisionConfidenceCaveat[] {
  if (!coexistence) throw new Error(`existing artifact '${target}' is schema-invalid: ${violations.join("; ")}; repair it before retrying`);
  const partition = partitionDecisionViolations(violations, doc, coexistence, new Set());
  if (partition.blocking.length) throw new Error(`existing artifact '${target}' is schema-invalid: ${partition.blocking.join("; ")}; repair it before retrying`);
  return partition.legacy_caveats;
}

/**
 * Gate 2 — candidate validation. When coexistence is null (non-decisions),
 * calls `reject` with the raw violations if any exist. When active, the
 * new/amended record's number is touched, so unsupported confidence on it
 * stays blocking (calls `reject`). Then re-derives caveats from the candidate
 * doc so the envelope reflects the about-to-be-published bytes.
 */
export function gateCandidateDecisions(violations: string[], candidate: Record<string, unknown>, coexistence: LegacyLabelCoexistence | null, writtenNumber: number, reject: (violations: string[]) => never): DecisionConfidenceCaveat[] {
  if (!coexistence) {
    if (violations.length) reject(violations);
    return [];
  }
  const touched = new Set([writtenNumber]);
  const partition = partitionDecisionViolations(violations, candidate, coexistence, touched);
  if (partition.blocking.length) reject(partition.blocking);
  return collectDecisionLegacyCaveats(candidate, coexistence, touched);
}

/**
 * Gate 3 — post-compaction invariant. When coexistence is null, throws the
 * standard writer/compactor error if violations exist. When active, proves
 * untouched inherited legacy labels survived compaction unchanged:
 * partitions final violations (throws if blocking), then re-derives caveats
 * from the published bytes.
 */
export function gateCompactedDecisions(violations: string[], doc: Record<string, unknown>, coexistence: LegacyLabelCoexistence | null, writtenNumber: number): DecisionConfidenceCaveat[] {
  if (!coexistence) {
    if (violations.length) throw new Error(`writer/compactor invariant failure: ${violations.join("; ")}`);
    return [];
  }
  const touched = new Set([writtenNumber]);
  if (violations.length) {
    const partition = partitionDecisionViolations(violations, doc, coexistence, touched);
    if (partition.blocking.length) throw new Error(`writer/compactor invariant failure: ${partition.blocking.join("; ")}`);
  }
  return collectDecisionLegacyCaveats(doc, coexistence, touched);
}
