import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";

const AUTHORITY_RELATIVE_PATH = "references/artifacts/state-storage-authority.yaml";
const EXPECTED_AUTHORITY_SCHEMA = "agentera.stateStorageAuthority.v1";

type Mapping = Record<string, unknown>;

export interface DecisionRevisionContract {
  location: string;
  legacySourceState: string;
  schemaVersion: string;
  identityKey: string;
  identityPrefix: string;
  amendablePaths: string[];
  legacyAmendablePaths: string[];
  migrationAmendablePaths: string[];
  currentConfidenceVocabulary: string[];
  knownLegacyConfidenceValues: string[];
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
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
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
    throw new Error(
      "state storage authority revisions identity_key prefix must match the overlay identity",
    );
  }
  const amendablePaths = requiredList(revisions.amendable_paths, "revisions.amendable_paths");
  const legacyAmendablePaths = requiredList(
    revisions.legacy_amendable_paths,
    "revisions.legacy_amendable_paths",
  );
  const migrationAmendablePaths = requiredList(
    revisions.migration_amendable_paths,
    "revisions.migration_amendable_paths",
  );
  const identityPaths = requiredList(revisions.identity_paths, "revisions.identity_paths");
  const temporalPaths = requiredList(revisions.temporal_paths, "revisions.temporal_paths");
  const reserved = new Set([...identityPaths, ...temporalPaths]);
  for (const [field, paths] of [["amendable_paths", amendablePaths], ["legacy_amendable_paths", legacyAmendablePaths], ["migration_amendable_paths", migrationAmendablePaths]] as const) {
    for (const amendable of paths) {
      if (reserved.has(amendable)) {
        throw new Error(
          `state storage authority revisions.${field} must not include identity or temporal path '${amendable}'`,
        );
      }
      if (overlay.mutablePaths.some((mutable) => amendable === mutable || amendable.startsWith(`${mutable}.`))) {
        throw new Error(
          `state storage authority revisions.${field} must not overlap overlay mutable path '${amendable}'`,
        );
      }
    }
  }
  return {
    location,
    legacySourceState: requiredString(
      revisions.legacy_source_state,
      "revisions.legacy_source_state",
    ),
    schemaVersion: requiredString(revisions.schema_version, "revisions.schema_version"),
    identityKey,
    identityPrefix,
    amendablePaths,
    legacyAmendablePaths,
    migrationAmendablePaths,
    currentConfidenceVocabulary: requiredList(
      mapping(mapping(authority.compatibility).legacy_label_coexistence).current_vocabulary,
      "compatibility.legacy_label_coexistence.current_vocabulary",
    ),
    knownLegacyConfidenceValues: requiredList(
      mapping(mapping(authority.compatibility).legacy_label_coexistence).known_legacy_examples,
      "compatibility.legacy_label_coexistence.known_legacy_examples",
    ),
    identityPaths,
    temporalPaths,
    separationFromOverlay: requiredString(
      revisions.separation_from_overlay,
      "revisions.separation_from_overlay",
    ),
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
    throw new Error(
      "state storage authority compatibility.legacy_label_coexistence section is required",
    );
  }
  const currentVocabulary = requiredList(
    coexistence.current_vocabulary,
    "compatibility.legacy_label_coexistence.current_vocabulary",
  );
  if (currentVocabulary.length === 0) {
    throw new Error(
      "state storage authority legacy_label_coexistence.current_vocabulary must be non-empty",
    );
  }
  return {
    dimensions: requiredList(
      coexistence.dimensions,
      "compatibility.legacy_label_coexistence.dimensions",
    ),
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

export const REVISION_PROVENANCE_VALUES = ["historical_revision", "degraded_projection"] as const;
export type RevisionProvenanceValue = (typeof REVISION_PROVENANCE_VALUES)[number];
const REVISION_META_KEYS = new Set(["date", "provenance", "base_sha256"]);
const FORBIDDEN_REVISION_PROVENANCE = "historical_archive";

export interface DecisionRevisionRecord {
  date?: string;
  provenance?: RevisionProvenanceValue;
  base_sha256?: string;
  [amendable: string]: unknown;
}

export type DecisionRevisionList = DecisionRevisionRecord[];
export type DecisionRevisionDocument = Record<string, DecisionRevisionList>;

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

export function decisionRevisionViolations(
  document: unknown,
  contract: DecisionRevisionContract = decisionRevisionContract(),
): string[] {
  if (!isRecord(document)) {
    return ["decision revision root must be a mapping keyed by stable decision ID"];
  }
  const amendable = new Set(contract.legacyAmendablePaths);
  const allowed = new Set([...REVISION_META_KEYS, ...contract.legacyAmendablePaths]);
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
      violations.push(
        ...decisionRevisionRecordViolations(
          revision,
          `${stableId}[${index}]`,
          contract,
          allowed,
          amendable,
          contract.legacyAmendablePaths,
          true,
        ),
      );
    });
  }
  return violations;
}

function decisionRevisionRecordViolations(
  revision: unknown,
  label: string,
  contract: DecisionRevisionContract,
  allowed = new Set([...REVISION_META_KEYS, ...contract.amendablePaths, ...contract.migrationAmendablePaths]),
  amendable = new Set([...contract.amendablePaths, ...contract.migrationAmendablePaths]),
  amendablePaths = [...contract.amendablePaths, ...contract.migrationAmendablePaths],
  legacy = false,
  allowLegacyConfidence = false,
): string[] {
  if (!isRecord(revision))
    return [`${label} must be a mapping of amendable fields and revision provenance`];
  const violations: string[] = [];
  for (const key of Object.keys(revision)) {
    if (!allowed.has(key))
      violations.push(
        `${label} carries '${key}' which is not an amendable content path or revision meta key`,
      );
  }
  if ("alternatives" in revision && ("alternatives.chosen" in revision || "alternatives.rejected" in revision)) {
    violations.push(`${label} must not mix migration-only alternatives replacement with granular alternative changes`);
  }
  for (const key of amendable) {
    if (!(key in revision)) continue;
    const value = revision[key];
    if (key === "alternatives") {
      const alternatives = Array.isArray(value) ? value : [];
      const malformed = !Array.isArray(value)
        || alternatives.length === 0
        || alternatives.some((entry) => {
          const candidate = isRecord(entry) ? entry : {};
          return typeof candidate.name !== "string"
            || candidate.name.length === 0
            || !["chosen", "rejected"].includes(String(candidate.status));
        })
        || alternatives.filter((entry) => isRecord(entry) && entry.status === "chosen").length !== 1;
      if (malformed) {
        violations.push(`${label}.alternatives must be a non-empty list with exactly one named chosen alternative and zero or more named rejected alternatives`);
      }
    } else if (key === "alternatives.rejected") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
        violations.push(`${label}.alternatives.rejected must be a list of non-empty strings`);
      }
    } else if (typeof value !== "string" || value.length === 0) {
      violations.push(`${label}.${key} must be a non-empty string`);
    } else if (key === "confidence" && !legacy && !contract.currentConfidenceVocabulary.includes(value) && !(allowLegacyConfidence && contract.knownLegacyConfidenceValues.includes(value))) {
      violations.push(`${label}.confidence '${value}' is not one of: ${contract.currentConfidenceVocabulary.join(", ")}`);
    }
  }
  const provenance = revision.provenance;
  if (provenance !== undefined) {
    if (typeof provenance !== "string") violations.push(`${label}.provenance must be a string`);
    else if (provenance === FORBIDDEN_REVISION_PROVENANCE)
      violations.push(`${label}.provenance must never claim historical_archive provenance`);
    else if (!REVISION_PROVENANCE_VALUES.includes(provenance as RevisionProvenanceValue)) {
      violations.push(
        `${label}.provenance '${provenance}' is not one of: ${REVISION_PROVENANCE_VALUES.join(", ")}`,
      );
    }
  }
  const baseSha = revision.base_sha256;
  if (baseSha !== undefined && (typeof baseSha !== "string" || !/^[0-9a-f]{64}$/.test(baseSha))) {
    violations.push(`${label}.base_sha256 must be a 64-character sha256 hex digest`);
  }
  const date = revision.date;
  if (date !== undefined && (typeof date !== "string" || date.length === 0)) {
    violations.push(`${label}.date must be a non-empty string`);
  }
  if (!Object.keys(revision).some((key) => amendable.has(key))) {
    violations.push(
      `${label} must amend at least one content field (${amendablePaths.join(", ")})`,
    );
  }
  return violations;
}

export function decisionRevisionEntityViolations(
  record: JsonObject,
  contract: DecisionRevisionContract = decisionRevisionContract(),
  allowLegacyConfidence = false,
): string[] {
  if (!isRecord(record.changes))
    return ["decision revision changes must be a mapping of amendable fields"];
  const amendable = new Set([...contract.amendablePaths, ...contract.migrationAmendablePaths]);
  const violations = Object.keys(record.changes)
    .filter((key) => !amendable.has(key))
    .map(
      (key) => `decision revision changes carries '${key}' which is not an amendable content path`,
    );
  violations.push(
    ...decisionRevisionRecordViolations(
      {
        ...record.changes,
        date: record.date,
        provenance: record.provenance,
        base_sha256: record.base_sha256,
      },
      "decision revision",
      contract,
      undefined,
      undefined,
      undefined,
      false,
      allowLegacyConfidence,
    ),
  );
  return violations;
}
