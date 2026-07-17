import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import {
  canonicalRecordJson,
  readNumberedArchiveEntry,
  stateCurrentProjectionPath,
  validateStateRecord,
} from "./archiveDiscovery.js";
import { legacyEntryNumber } from "./legacyIdentity.js";
import { localDate } from "./write/assign.js";
import type { StateMutationTransaction } from "./write/mutation.js";
import { reject } from "./write/errors.js";
// partitionDecisionViolations lives in decisionLegacyValidation.js, which in
// turn imports the coexistence primitives declared below. Both modules
// reference each other only inside functions, so the circular binding is
// resolved by the time either is called (same pattern as the
// decisionRevisionPublication.js re-export at the end of this file).
import { partitionDecisionViolations } from "./decisionLegacyValidation.js";

/**
 * Focused accessor for the decision-content amendment contract declared in
 * references/artifacts/state-storage-authority.yaml (`revisions:` and
 * `compatibility.legacy_label_coexistence:`). It reads the same single
 * authority file as the other focused accessors (e.g. gitBackfillAuthority) and
 * projects only the amendment-relevant sections.
 *
 * The overlay (satisfaction) and revision (content) authorities share an
 * identity prefix but never overlap fields. This module owns the revision
 * contract, the revision document loader, base→revisions composition, and
 * amendment preparation. Amendment publication with recovery is plan task 3.
 */

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";
const EXPECTED_AUTHORITY_SCHEMA = "agentera.stateStorageAuthority.v1";

type Mapping = Record<string, unknown>;

export interface DecisionRevisionContract {
  location: string;
  schemaVersion: string;
  identityKey: string;
  identityPrefix: string;
  amendablePaths: string[];
  identityPaths: string[];
  temporalPaths: string[];
  separationFromOverlay: string;
  immutability: string;
  provenance: string;
  publicationOrder: string[];
  applyState: string;
  applyStateNote: string;
}

export interface LegacyLabelCoexistence {
  dimensions: string[];
  currentVocabulary: string[];
  currentVocabularyRef: string;
  knownLegacyExamples: string[];
  classificationRule: string;
  noSilentNormalization: string;
}

export interface ConfidenceLabelClassification {
  classification: "current" | "explicit_legacy" | "rejected";
  allowed: boolean;
  caveat: string;
}

function mapping(value: unknown): Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`state storage authority field '${field}' must be a non-empty string`);
  }
  return value;
}

function requiredList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`state storage authority field '${field}' must be a list of non-empty strings`);
  }
  return value;
}

function readAuthority(sourceRoot: string): Mapping {
  const authority = loadYamlMapping(
    fs.readFileSync(path.join(sourceRoot, AUTHORITY_RELATIVE_PATH), "utf8"),
  );
  if (authority.schema_version !== EXPECTED_AUTHORITY_SCHEMA) {
    throw new Error("state storage authority schema_version is unsupported");
  }
  if (authority.status !== "active_authority") {
    throw new Error("state storage authority must be active_authority");
  }
  return authority;
}

/**
 * Cross-validation inputs extracted from the same authority: the decision
 * overlay identity prefix and mutable paths. Revisions must share the overlay
 * identity and never overlap an overlay mutable path.
 */
function overlayCrossCheck(authority: Mapping): { identityPrefix: string; mutablePaths: string[] } {
  const overlays = mapping(authority.overlays);
  const identityKey = requiredString(overlays.identity_key, "overlays.identity_key");
  const identityPrefix = identityKey.split(":")[0];
  if (!identityPrefix || identityKey !== `${identityPrefix}:<decision-number>`) {
    throw new Error("state storage authority overlays.identity_key is unsupported");
  }
  return {
    identityPrefix,
    mutablePaths: requiredList(overlays.mutable_paths, "overlays.mutable_paths"),
  };
}

export function decisionRevisionContract(
  sourceRoot: string = resolveSourceRoot(),
): DecisionRevisionContract {
  const authority = readAuthority(sourceRoot);
  const revisions = mapping(authority.revisions);
  if (Object.keys(revisions).length === 0) {
    throw new Error("state storage authority revisions section is required");
  }
  const location = requiredString(revisions.location, "revisions.location");
  if (path.isAbsolute(location) || location.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error("state storage authority revisions location must be project-relative");
  }
  const identityKey = requiredString(revisions.identity_key, "revisions.identity_key");
  const identityPrefix = identityKey.split(":")[0];
  if (!identityPrefix || identityKey !== `${identityPrefix}:<decision-number>`) {
    throw new Error("state storage authority revisions identity_key is unsupported");
  }
  const overlay = overlayCrossCheck(authority);
  if (identityPrefix !== overlay.identityPrefix) {
    throw new Error("state storage authority revisions identity_key prefix must match the overlay identity");
  }
  const amendablePaths = requiredList(revisions.amendable_paths, "revisions.amendable_paths");
  const identityPaths = requiredList(revisions.identity_paths, "revisions.identity_paths");
  const temporalPaths = requiredList(revisions.temporal_paths, "revisions.temporal_paths");
  const reserved = new Set([...identityPaths, ...temporalPaths]);
  for (const amendable of amendablePaths) {
    if (reserved.has(amendable)) {
      throw new Error(
        `state storage authority revisions.amendable_paths must not include identity or temporal path '${amendable}'`,
      );
    }
    if (overlay.mutablePaths.some((mutable) => amendable === mutable || amendable.startsWith(`${mutable}.`))) {
      throw new Error(
        `state storage authority revisions.amendable_paths must not overlap overlay mutable path '${amendable}'`,
      );
    }
  }
  return {
    location,
    schemaVersion: requiredString(revisions.schema_version, "revisions.schema_version"),
    identityKey,
    identityPrefix,
    amendablePaths,
    identityPaths,
    temporalPaths,
    separationFromOverlay: requiredString(revisions.separation_from_overlay, "revisions.separation_from_overlay"),
    immutability: requiredString(revisions.immutability, "revisions.immutability"),
    provenance: requiredString(revisions.provenance, "revisions.provenance"),
    publicationOrder: requiredList(revisions.publication_order, "revisions.publication_order"),
    applyState: requiredString(revisions.apply_state, "revisions.apply_state"),
    applyStateNote: requiredString(revisions.apply_state_note, "revisions.apply_state_note"),
  };
}

export function legacyLabelCoexistence(
  sourceRoot: string = resolveSourceRoot(),
): LegacyLabelCoexistence {
  const authority = readAuthority(sourceRoot);
  const compatibility = mapping(authority.compatibility);
  const coexistence = mapping(compatibility.legacy_label_coexistence);
  if (Object.keys(coexistence).length === 0) {
    throw new Error("state storage authority compatibility.legacy_label_coexistence section is required");
  }
  const currentVocabulary = requiredList(
    coexistence.current_vocabulary,
    "compatibility.legacy_label_coexistence.current_vocabulary",
  );
  if (currentVocabulary.length === 0) {
    throw new Error("state storage authority legacy_label_coexistence.current_vocabulary must be non-empty");
  }
  return {
    dimensions: requiredList(coexistence.dimensions, "compatibility.legacy_label_coexistence.dimensions"),
    currentVocabulary,
    currentVocabularyRef: requiredString(
      coexistence.current_vocabulary_ref,
      "compatibility.legacy_label_coexistence.current_vocabulary_ref",
    ),
    knownLegacyExamples: requiredList(
      coexistence.known_legacy_examples,
      "compatibility.legacy_label_coexistence.known_legacy_examples",
    ),
    classificationRule: requiredString(
      coexistence.classification_rule,
      "compatibility.legacy_label_coexistence.classification_rule",
    ),
    noSilentNormalization: requiredString(
      coexistence.no_silent_normalization,
      "compatibility.legacy_label_coexistence.no_silent_normalization",
    ),
  };
}

/**
 * Evaluate the legacy-label coexistence rule for one confidence value.
 * `touched=true` marks the value as new or amended content supplied by append
 * or amend; `touched=false` marks an untouched inherited value on an existing
 * record. The current vocabulary always passes. An untouched unsupported
 * value is explicit legacy state (preserved, caveated, allowed). A touched
 * unsupported value is rejected and requires the current vocabulary.
 */
export function classifyConfidenceLabel(
  contract: LegacyLabelCoexistence,
  value: string,
  touched: boolean,
): ConfidenceLabelClassification {
  const vocabulary = contract.currentVocabulary.join(", ");
  if (contract.currentVocabulary.includes(value)) {
    return { classification: "current", allowed: true, caveat: "" };
  }
  if (!touched) {
    return {
      classification: "explicit_legacy",
      allowed: true,
      caveat: `inherited unsupported confidence label '${value}' is explicit legacy state; current vocabulary is ${vocabulary}`,
    };
  }
  return {
    classification: "rejected",
    allowed: false,
    caveat: `confidence label '${value}' requires current vocabulary (${vocabulary}) for new or amended content`,
  };
}

/**
 * Revision provenance vocabulary (state-storage-authority `revisions.provenance`).
 * A revision carries revision provenance only and is never labeled as
 * historical archive provenance. A revision whose base was bootstrapped from a
 * complete legacy projection may carry degraded_projection provenance.
 */
export const REVISION_PROVENANCE_VALUES = ["historical_revision", "degraded_projection"] as const;
export type RevisionProvenanceValue = (typeof REVISION_PROVENANCE_VALUES)[number];
const REVISION_META_KEYS = new Set(["date", "provenance", "base_sha256"]);
const FORBIDDEN_REVISION_PROVENANCE = "historical_archive";

/**
 * One immutable revision record. Carries only authority-declared amendable
 * content paths plus revision provenance metadata (`date`, `provenance`,
 * `base_sha256`). Identity and temporal paths are never amendable.
 */
export interface DecisionRevisionRecord {
  date?: string;
  provenance?: RevisionProvenanceValue;
  base_sha256?: string;
  [amendable: string]: unknown;
}

/** Ordered list of revision records for one decision. */
export type DecisionRevisionList = DecisionRevisionRecord[];

/** Revision document keyed by stable decision ID (`decisions:<number>`). */
export type DecisionRevisionDocument = Record<string, DecisionRevisionList>;

/** Provenance summary for one revision in the ordered list. */
export interface RevisionProvenance {
  index: number;
  date?: string;
  provenance: RevisionProvenanceValue;
  fields: string[];
  base_sha256?: string;
}

/** Result of composing ordered revisions over an immutable base record. */
export interface RevisionComposition {
  record: JsonObject;
  applied: boolean;
  fields: string[];
  revisions: RevisionProvenance[];
  broken_hash: boolean;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decisionNumberFromId(id: string, contract: DecisionRevisionContract): number | null {
  const prefix = `${contract.identityPrefix}:`;
  if (!id.startsWith(prefix)) return null;
  const number = id.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(number)) return null;
  const parsed = Number(number);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve the revision document path for a project. Mirrors
 * {@link decisionOverlayPath}: project-relative, realpath-bounded.
 */
export function decisionRevisionPath(
  projectRoot: string,
  sourceRoot: string = resolveSourceRoot(),
): string {
  const contract = decisionRevisionContract(sourceRoot);
  const target = path.resolve(projectRoot, contract.location);
  assertRealpathBoundary(projectRoot, target, "decision revision");
  return target;
}

/**
 * Validate a revision document against the amendment contract. Returns a list of
 * human-readable violations (empty when valid). The document must be a mapping
 * keyed by stable decision ID; each value is an ordered list of revision
 * records carrying only amendment-meta keys and amendable content paths.
 */
export function decisionRevisionViolations(
  document: unknown,
  contract: DecisionRevisionContract = decisionRevisionContract(),
): string[] {
  if (!isRecord(document)) {
    return ["decision revision root must be a mapping keyed by stable decision ID"];
  }
  const amendable = new Set(contract.amendablePaths);
  const allowed = new Set([...REVISION_META_KEYS, ...contract.amendablePaths]);
  const violations: string[] = [];
  for (const [stableId, value] of Object.entries(document)) {
    if (decisionNumberFromId(stableId, contract) === null) {
      violations.push(`${stableId} is not a valid ${contract.identityKey} key`);
      continue;
    }
    if (!Array.isArray(value)) {
      violations.push(`${stableId} must be an ordered list of revision records`);
      continue;
    }
    value.forEach((revision, index) => {
      violations.push(...decisionRevisionRecordViolations(revision, `${stableId}[${index}]`, contract, allowed, amendable));
    });
  }
  return violations;
}

function decisionRevisionRecordViolations(
  revision: unknown,
  label: string,
  contract: DecisionRevisionContract,
  allowed = new Set([...REVISION_META_KEYS, ...contract.amendablePaths]),
  amendable = new Set(contract.amendablePaths),
): string[] {
  if (!isRecord(revision)) return [`${label} must be a mapping of amendable fields and revision provenance`];
  const violations: string[] = [];
  for (const key of Object.keys(revision)) {
    if (!allowed.has(key)) violations.push(`${label} carries '${key}' which is not an amendable content path or revision meta key`);
  }
  const provenance = revision.provenance;
  if (provenance !== undefined) {
    if (typeof provenance !== "string") violations.push(`${label}.provenance must be a string`);
    else if (provenance === FORBIDDEN_REVISION_PROVENANCE) violations.push(`${label}.provenance must never claim historical_archive provenance`);
    else if (!REVISION_PROVENANCE_VALUES.includes(provenance as RevisionProvenanceValue))
      violations.push(`${label}.provenance '${provenance}' is not one of: ${REVISION_PROVENANCE_VALUES.join(", ")}`);
  }
  const baseSha = revision.base_sha256;
  if (baseSha !== undefined && (typeof baseSha !== "string" || !/^[0-9a-f]{64}$/.test(baseSha)))
    violations.push(`${label}.base_sha256 must be a 64-character sha256 hex digest`);
  const date = revision.date;
  if (date !== undefined && (typeof date !== "string" || date.length === 0))
    violations.push(`${label}.date must be a non-empty string`);
  if (!Object.keys(revision).some((key) => amendable.has(key)))
    violations.push(`${label} must amend at least one content field (${contract.amendablePaths.join(", ")})`);
  return violations;
}

/** Validate one canonical entity revision through the same revision contract as legacy revisions. */
export function decisionRevisionEntityViolations(
  record: JsonObject,
  contract: DecisionRevisionContract = decisionRevisionContract(),
): string[] {
  if (!isRecord(record.changes)) return ["decision revision changes must be a mapping of amendable fields"];
  const amendable = new Set(contract.amendablePaths);
  const violations = Object.keys(record.changes)
    .filter((key) => !amendable.has(key))
    .map((key) => `decision revision changes carries '${key}' which is not an amendable content path`);
  violations.push(...decisionRevisionRecordViolations({
    ...record.changes,
    date: record.date,
    provenance: record.provenance,
    base_sha256: record.base_sha256,
  }, "decision revision", contract));
  return violations;
}

export function loadDecisionRevision(
  projectRoot: string = process.cwd(),
  sourceRoot: string = resolveSourceRoot(),
): DecisionRevisionDocument {
  const target = decisionRevisionPath(projectRoot, sourceRoot);
  if (!fs.existsSync(target)) return {};
  const bytes = fs.readFileSync(target, "utf8");
  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(bytes);
  } catch (error) {
    throw new Error(`cannot parse decision revision document '${target}': ${(error as Error).message}`);
  }
  const violations = decisionRevisionViolations(document, decisionRevisionContract(sourceRoot));
  if (violations.length > 0) {
    throw new Error(`decision revision document '${target}' is invalid: ${violations.join("; ")}`);
  }
  return document as unknown as DecisionRevisionDocument;
}

/**
 * Compose ordered revisions over an immutable base record. Each revision
 * applies only its authority-declared amendable content paths, in declared
 * order; no revision overwrites, reorders, or deletes a prior revision. The
 * overlay (satisfaction) authority composes its own evidence separately and is
 * not touched here.
 *
 * When `baseSha256` is supplied, the first revision that carries a
 * `base_sha256` is checked against it; a mismatch marks `broken_hash` so the
 * caller degrades rather than reconstructing inconsistent detail.
 */
export function composeDecisionRevision(
  entry: JsonObject,
  revisions: DecisionRevisionList | undefined,
  options: { contract?: DecisionRevisionContract; baseSha256?: string } = {},
): RevisionComposition {
  const contract = options.contract ?? decisionRevisionContract();
  if (!revisions || revisions.length === 0) {
    return { record: structuredClone(entry), applied: false, fields: [], revisions: [], broken_hash: false };
  }
  const effective = structuredClone(entry);
  const touched = new Set<string>();
  const provenance: RevisionProvenance[] = [];
  let brokenHash = false;
  const expectedBase = options.baseSha256;
  for (let index = 0; index < revisions.length; index++) {
    const revision = revisions[index];
    const fields: string[] = [];
    for (const amendablePath of contract.amendablePaths) {
      if (amendablePath in revision && revision[amendablePath] !== undefined) {
        effective[amendablePath] = structuredClone(revision[amendablePath] as JsonValue);
        touched.add(amendablePath);
        fields.push(amendablePath);
      }
    }
    // The first revision establishes the base lineage; a base_sha256 mismatch
    // there means the immutable base drifted after the revision was published.
    if (index === 0 && expectedBase !== undefined && typeof revision.base_sha256 === "string" && revision.base_sha256 !== expectedBase) {
      brokenHash = true;
    }
    provenance.push({
      index,
      ...(typeof revision.date === "string" ? { date: revision.date } : {}),
      provenance: (typeof revision.provenance === "string" ? revision.provenance : "historical_revision") as RevisionProvenanceValue,
      fields,
      ...(typeof revision.base_sha256 === "string" ? { base_sha256: revision.base_sha256 } : {}),
    });
  }
  return {
    record: effective,
    applied: touched.size > 0,
    fields: [...touched],
    revisions: provenance,
    broken_hash: brokenHash,
  };
}

/**
 * One-time loaded revision snapshot for a project. The snapshot carries the
 * resolution path, the parsed document, and the contract so list and bounded
 * consumers compose effective content without reloading the authority.
 */
export interface DecisionRevisionSnapshot {
  path: string;
  document: DecisionRevisionDocument;
  amendablePaths: string[];
  contract: DecisionRevisionContract;
}

/**
 * Load the revision snapshot once for a project. Returns `null` when no
 * revision document exists. Throws a plain `Error` (with a descriptive
 * message) when the document is unreadable or violates the contract, so
 * callers can wrap the failure in their own retrieval envelope.
 */
export function loadDecisionRevisionSnapshot(
  projectRoot: string,
  sourceRoot: string = resolveSourceRoot(),
): DecisionRevisionSnapshot | null {
  const contract = decisionRevisionContract(sourceRoot);
  const revisionPath = decisionRevisionPath(projectRoot, sourceRoot);
  let document: DecisionRevisionDocument;
  try {
    document = loadDecisionRevision(projectRoot, sourceRoot);
    // loadDecisionRevision returns {} when the document is absent; normalize to null
    // so callers short-circuit the snapshot path entirely.
    document = Object.keys(document).length > 0 ? document : {};
  } catch (error) {
    throw new Error(`cannot read decision revision document: ${(error as Error).message}`);
  }
  if (Object.keys(document).length === 0) return null;
  return { path: revisionPath, document, amendablePaths: contract.amendablePaths, contract };
}

/**
 * Bounded composition metadata for one stable ID in a list snapshot. Does not
 * hash-verify lineage (that is the exact/get path's responsibility); it reports
 * whether any amendable content field is amended and which, for truthful list
 * provenance without reconstructing full detail.
 */
export function decisionRevisionFields(
  snapshot: DecisionRevisionSnapshot | null,
  stableId: string,
): { applied: boolean; fields: string[]; count: number } {
  if (!snapshot || !stableId || !snapshot.document[stableId]) {
    return { applied: false, fields: [], count: 0 };
  }
  const revisions = snapshot.document[stableId];
  const fields = new Set<string>();
  for (const entry of revisions) {
    for (const amendable of snapshot.amendablePaths) {
      if (amendable in entry && entry[amendable] !== undefined) fields.add(amendable);
    }
  }
  return { applied: fields.size > 0, fields: [...fields], count: revisions.length };
}

/**
 * Compose a bounded list summary's effective record from the base and any
 * revisions for the stable ID. Returns the base (cloned) when no revisions
 * apply, so list summaries never reconstruct missing detail.
 */
export function composedRevisionRecord(
  snapshot: DecisionRevisionSnapshot | null,
  stableId: string,
  base: JsonObject,
): JsonObject {
  if (!snapshot || !stableId || !snapshot.document[stableId]) return structuredClone(base);
  return composeDecisionRevision(base, snapshot.document[stableId], { contract: snapshot.contract }).record;
}

/** Resolved base for an amendment preparation. */
export interface DecisionAmendmentBase {
  record: JsonObject;
  sha256: string;
  /** `historical_archive` for a verified numbered archive; `degraded_projection` for a bootstrapped legacy full projection. */
  provenance: "historical_archive" | "degraded_projection";
  source: "archive" | "legacy_full";
}

/**
 * Outcome of selecting and validating a target decision before staging an
 * amendment. Preparation never reconstructs missing fields, never promotes a
 * summary to full detail, and never claims historical_archive provenance for a
 * bootstrapped legacy base. The effective record is the base composed with
 * existing revisions and the requested amendment fields; `replay` marks an
 * identical re-submission as an idempotent no-op.
 */
export interface DecisionAmendmentPreparation {
  number: number;
  base: DecisionAmendmentBase;
  revisions: DecisionRevisionList;
  requested: DecisionRevisionRecord;
  effective: JsonObject;
  replay: boolean;
  provenance: RevisedTargetProvenance;
}

export interface RevisedTargetProvenance {
  base: "historical_archive" | "degraded_projection";
  archive: { path: string; available: boolean; verified: boolean; record_sha256?: string };
  current_projection: { path: string; representation: "full" | "summary" | "missing" | "absent" };
  revision_path: string;
  existing_revisions: number;
  amended_fields: string[];
}

/**
 * Locate a complete base record for amendment preparation. A verified numbered
 * archive seeds a `historical_archive` base. When the decision has no numbered
 * archive but is represented by a complete legacy full projection record, the
 * exact projection values seed a hash-verified `degraded_projection` base
 * (never historical_archive). Summary-only, conflicting, ambiguous,
 * broken-hash, and incomplete targets are refused with a working correction
 * rather than reconstructed.
 */
export function prepareDecisionAmendment(
  projectRoot: string,
  decisionNumber: number,
  requested: DecisionRevisionRecord,
  options: {
    sourceRoot?: string;
    contract?: DecisionRevisionContract;
  } = {},
): DecisionAmendmentPreparation {
  if (!Number.isSafeInteger(decisionNumber) || decisionNumber <= 0) {
    reject({
      class: "invalid_request",
      message: `decision number must be a positive integer; received ${decisionNumber}`,
      syntax: "agentera state decisions amend --number N [--question ... --choice ... --reasoning ... --confidence firm ...] [--dry-run] --format json",
      example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
      recovery: "Supply an existing numbered decision and retry; no files were changed.",
    });
  }
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = options.contract ?? decisionRevisionContract(sourceRoot);
  const amendableSet = new Set(contract.amendablePaths);
  const requestedFields = Object.keys(requested).filter((key) => amendableSet.has(key) && requested[key] !== undefined);
  if (requestedFields.length === 0) {
    reject({
      class: "missing_argument",
      message: "amend requires at least one amendable content field",
      syntax: "agentera state decisions amend --number N [--question ... --choice ... --reasoning ... --confidence firm ...] [--dry-run] --format json",
      example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
      recovery: `Supply at least one of ${contract.amendablePaths.join(", ")}; no files were changed.`,
    });
  }
  // New/amended confidence must be current vocabulary; legacy labels are never normalized.
  if (requestedFields.includes("confidence")) {
    const value = requested.confidence;
    const coexistence = legacyLabelCoexistence(sourceRoot);
    const classification = classifyConfidenceLabel(coexistence, String(value), true);
    if (!classification.allowed) {
      reject({
        class: "invalid_choice",
        message: classification.caveat,
        valid_values: coexistence.currentVocabulary,
        syntax: "agentera state decisions amend --number N --confidence firm --format json",
        example: "agentera state decisions amend --number 53 --confidence firm --dry-run --format json",
        recovery: "Use a current-vocabulary confidence label for new or amended content; no files were changed.",
      });
    }
  }

  const lookup = readNumberedArchiveEntry(projectRoot, "decisions", decisionNumber, { sourceRoot });
  if (lookup.rejection) {
    const reason = lookup.rejection.reason;
    const brokenHash = reason === "invalid_envelope" || reason === "read_failure" || reason === "unsafe_path";
    reject({
      class: "conflict",
      message: `decision ${decisionNumber} amendment target has a broken numbered archive (${reason}: ${lookup.rejection.message})`,
      syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
      example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
      recovery: brokenHash
        ? "Preserve the affected archive bytes for diagnostics, repair the numbered record, then retry the amend."
        : "Restore or publish the validated numbered archive for this ID before retrying; missing fields are not reconstructed.",
    });
  }
  const projectionPath = stateCurrentProjectionPath(projectRoot, "decisions", sourceRoot);
  let base: DecisionAmendmentBase;
  let currentRepresentation: "full" | "summary" | "missing" | "absent";
  if (lookup.entry) {
    // A verified numbered archive seeds an immutable historical_archive base.
    if (!lookup.entry.record) {
      reject({
        class: "conflict",
        message: `decision ${decisionNumber} amendment target has a numbered archive without a complete record`,
        syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
        example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
        recovery: "Preserve the numbered archive for diagnostics, repair or republish its complete record, then retry the amend.",
      });
    }
    base = {
      record: lookup.entry.record as JsonObject,
      sha256: lookup.entry.recordSha256,
      provenance: "historical_archive",
      source: "archive",
    };
    currentRepresentation = "full";
  } else {
    // No numbered archive: bootstrap a hash-verified base from a complete legacy
    // full projection record. Summary-only targets are refused; missing fields
    // are never reconstructed.
    const projection = legacyFullProjectionFor(projectRoot, decisionNumber, projectionPath, sourceRoot);
    if (projection.kind === "missing" || projection.kind === "absent") {
      reject({
        class: "unsupported_target",
        message: `decision ${decisionNumber} has no numbered archive and is not present in the current projection`,
        syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
        example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
        recovery: "Append or restore the decision with a complete record (and its numbered archive) before amending; missing fields are not reconstructed.",
      });
    } else if (projection.kind === "ambiguous") {
      reject({
        class: "conflict",
        message: `decision ${decisionNumber} is represented by multiple conflicting current projection entries`,
        syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
        example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
        recovery: "Remove the duplicate identity conflict according to the artifact schema, then retry the amend.",
      });
    } else if (projection.kind === "summary") {
      reject({
        class: "unsupported_target",
        message: `decision ${decisionNumber} is represented only by an irrecoverable legacy summary; a base cannot be hash-verified`,
        syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
        example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
        recovery: "Restore or publish the validated numbered archive for this ID before retrying; missing fields are not reconstructed.",
      });
    } else {
      // degraded_projection base: hash-verified from exact legacy projection values, never historical_archive.
      base = {
        record: projection.record,
        sha256: sha256(projection.record),
        provenance: "degraded_projection",
        source: "legacy_full",
      };
      currentRepresentation = "full";
    }
  }

  const revisionPath = decisionRevisionPath(projectRoot, sourceRoot);
  let revisions: DecisionRevisionList = [];
  try {
    const document = loadDecisionRevision(projectRoot, sourceRoot);
    revisions = document[`decisions:${decisionNumber}`] ?? [];
  } catch (error) {
    reject({
      class: "conflict",
      message: `decision ${decisionNumber} amendment target has a broken revision document: ${(error as Error).message}`,
      syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
      example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
      recovery: "Preserve the revision document for diagnostics, repair its YAML and amendable content paths, then retry the amend.",
    });
  }
  const composed = composeDecisionRevision(base.record, revisions, { contract, baseSha256: base.sha256 });
  if (composed.broken_hash) {
    reject({
      class: "conflict",
      message: `decision ${decisionNumber} base hash no longer matches the recorded revision base_sha256; the immutable base drifted after the revision was published`,
      syntax: "agentera state decisions amend --number N [--question ... --confidence firm ...] [--dry-run] --format json",
      example: 'agentera state decisions amend --number 53 --choice "..." --reasoning "..." --confidence firm --dry-run --format json',
      recovery: "Preserve the immutable archive and existing revisions, reconcile the base drift, then retry the amend.",
    });
  }
  const effective = structuredClone(composed.record) as JsonObject;
  for (const field of requestedFields) {
    effective[field] = structuredClone(requested[field] as JsonValue) as JsonValue;
  }
  const replay =
    composed.applied &&
    requestedFields.every((field) => canonicalRecordJson(effective[field]) === canonicalRecordJson(composed.record[field] ?? effective[field])) &&
    requestedFields.length === composed.fields.length &&
    composed.fields.every((field) => requestedFields.includes(field));

  return {
    number: decisionNumber,
    base,
    revisions,
    requested: { ...requested },
    effective,
    replay,
    provenance: {
      base: base.provenance,
      archive: {
        path: lookup.path,
        available: Boolean(lookup.entry),
        verified: Boolean(lookup.entry),
        ...(lookup.entry ? { record_sha256: lookup.entry.recordSha256 } : {}),
      },
      current_projection: { path: projectionPath, representation: currentRepresentation },
      revision_path: revisionPath,
      existing_revisions: revisions.length,
      amended_fields: requestedFields,
    },
  };
}

/** Focused lookup of a complete legacy full projection record for one decision. */
type LegacyProjectionResult =
  | { kind: "missing" }
  | { kind: "absent" }
  | { kind: "ambiguous" }
  | { kind: "summary" }
  | { kind: "full"; record: JsonObject };

export function legacyFullProjectionFor(
  projectRoot: string,
  decisionNumber: number,
  projectionPath: string,
  sourceRoot: string,
): LegacyProjectionResult {
  if (!fs.existsSync(projectionPath)) return { kind: "missing" };
  let bytes: string;
  try {
    bytes = fs.readFileSync(projectionPath, "utf8");
  } catch {
    return { kind: "missing" };
  }
  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(bytes);
  } catch {
    return { kind: "missing" };
  }
  const active = document.decisions;
  if (!Array.isArray(active)) return { kind: "absent" };
  let match: JsonObject | undefined;
  for (const candidate of active) {
    if (!isRecord(candidate)) continue;
    if (legacyEntryNumber(candidate, "decisions", "number") !== decisionNumber) continue;
    if (match) return { kind: "ambiguous" };
    match = candidate;
  }
  if (!match) {
    return { kind: "absent" };
  }
  // A complete legacy projection record validates against the decision schema;
  // otherwise the entry is summary-only and must not be reconstructed. An
  // untouched inherited legacy confidence label is explicit legacy state under
  // the authority's coexistence rule: it does not degrade a complete record to
  // summary, so the base remains hash-verifiable and amend proceeds (the label
  // is reported as a compatibility caveat by the amendment path). Tolerance is
  // confidence-only — every other violation still degrades to summary.
  try {
    const violations = validateStateRecord(sourceRoot, "decisions", match);
    if (violations.length === 0) return { kind: "full", record: match };
    const partition = partitionDecisionViolations(
      violations,
      { decisions: [match] },
      legacyLabelCoexistence(sourceRoot),
      new Set(),
    );
    return partition.blocking.length === 0 ? { kind: "full", record: match } : { kind: "summary" };
  } catch {
    return { kind: "summary" };
  }
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}


// Re-export the publication primitives for backward-compatible imports.
// The implementation lives in decisionRevisionPublication.ts.
export {
  buildPublishedRevisionRecord,
  dispatchDecisionAmendment,
  type DecisionAmendmentPublication,
  type AmendmentProjectionEffect,
  findConflictingRevision,
  findPublishedRevision,
  projectRevisionOverride,
  publishDecisionAmendment,
  type PublishedRevisionRecord,
  type RevisionOverrideProjection,
} from "./decisionRevisionPublication.js";
