import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";

/**
 * Focused accessor for the decision-content amendment contract declared in
 * references/artifacts/state-storage-authority.yaml (`revisions:` and
 * `compatibility.legacy_label_coexistence:`). It reads the same single
 * authority file as the other focused accessors (e.g. gitBackfillAuthority) and
 * projects only the amendment-relevant sections. Revision-backed reads and
 * amendment publication are not implemented here; this module owns the contract
 * and the legacy-label coexistence rule only.
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
