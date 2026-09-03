import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { deriveLegacyPlanIdentity } from "./retrievalAuthority.js";

// These identities are accepted only while reading legacy aggregate plan
// sources. Canonical entity plans use the bare envelope ID assigned by the
// writer; neither composite form is a public selector.
export const PERSISTED_PLAN_ID = /^plan:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LEGACY_PLAN_ID = /^legacy-plan:[0-9a-f]{64}$/;
export const PLAN_ID = /^(plan:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|legacy-plan:[0-9a-f]{64})$/;

function mapping(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function normalizeStatus(value: JsonValue): JsonValue {
  if (value === "active") return "open";
  if (value === "completed") return "complete";
  return value;
}

/** Canonical read-compatible plan shape used only for identity comparison and legacy derivation. */
export function canonicalPlanIdentityDocument(document: JsonObject): JsonObject {
  const normalized = structuredClone(document);
  const header = mapping(normalized.header);
  normalized.header = header.status === undefined ? { ...header } : { ...header, status: normalizeStatus(header.status) };
  if (Array.isArray(normalized.entries)) {
    normalized.tasks = normalized.entries;
    delete normalized.entries;
  }
  return normalized;
}

export interface PlanIdentity {
  stableId: string;
  persisted: boolean;
  canonicalJson: string;
}

export function resolvePlanIdentity(document: JsonObject): PlanIdentity {
  const canonicalDocument = canonicalPlanIdentityDocument(document);
  const persisted = mapping(canonicalDocument.header).id;
  const canonicalJson = canonicalRecordJson(canonicalDocument);
  if (persisted !== undefined) {
    if (typeof persisted !== "string" || !PERSISTED_PLAN_ID.test(persisted)) {
      throw new Error("legacy plan header.id is not a valid migration-only identity");
    }
    return { stableId: persisted, persisted: true, canonicalJson };
  }
  return {
    stableId: deriveLegacyPlanIdentity(canonicalJson),
    persisted: false,
    canonicalJson,
  };
}
