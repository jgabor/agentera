import { createHash } from "node:crypto";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson, validateStateRecord } from "./archiveDiscovery.js";
import { classifyCompleteDecisionConfidence, decisionLegacyCoexistence } from "./decisionLegacyValidation.js";
import type { ValidatedProjectRoot } from "./projectRoot.js";
import { classifyProjectState } from "./stateMode.js";
import { readProjectFileSnapshot, type ProjectDescriptorPathResolver as DescriptorPathResolver } from "./safeProjectFile.js";

export type EntityCutoverProjectState = "v3" | "fresh_uninitialized" | "legacy" | "partial" | "corrupt" | "unknown";

export function classifyEntityCutoverProject(project: string, sourceRoot?: string): EntityCutoverProjectState {
  const state = classifyProjectState(project, sourceRoot).state;
  return state === "entities" ? "v3" : state;
}

import type { EntityMigrationClassification } from "./entityMigrationContracts.js";
export type { DurableEntityMigrationEntry, DurableEntityMigrationPlan, DurableEntityMigrationSource, EntityMigrationClassification, EntityMigrationEntry, EntityMigrationPreview, EntityMigrationRelationship } from "./entityMigrationContracts.js";

export interface Observation {
  key: string;
  artifact: string;
  boundary: string;
  path: string;
  provenance: string;
  record: JsonObject | null;
  detail: "full" | "summary" | "corrupt";
  relationships: Array<{ field: string; target: string | null }>;
  message?: string;
  migrationProvenance?: JsonObject;
  inheritedConfidenceProvenance?: JsonObject;
  sourceRecordSha256?: string;
  explicitId?: string;
}

export type SourceFile =
  | {
      relative: string;
      bytes: Buffer;
      kind: "file";
      dev: bigint;
      ino: bigint;
      type: "file";
      mode: number;
    }
  | { relative: string; bytes: null; kind: "missing" | "unsafe" };

export const ENTITY_MIGRATION_PREVIEW_MAX_OUTPUT_BYTES = 32_768;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const NUMBERED = {
  progress: { file: ".agentera/progress.yaml", collection: "cycles", boundary: "progress_cycle" },
  decisions: { file: ".agentera/decisions.yaml", collection: "decisions", boundary: "decision" },
  health: { file: ".agentera/health.yaml", collection: "audits", boundary: "health_audit" },
} as const;
export const COMPACTED_SUMMARY_ARTIFACTS = new Set(["progress", "decisions", "health"]);
export const BLOCKING = new Set<EntityMigrationClassification>(["duplicate", "conflict", "corrupt", "unsupported"]);
export const INVENTORY_ORDER = "artifact_then_boundary_then_source_identity_then_source_path";
export const INVENTORY_FILTER = "complete_declared_inventory";
export const AUTHORITY_PATH = "references/artifacts/state-storage-authority.yaml";
export const PLAN_ARCHIVE_SOURCE = /^\.agentera\/archive\/PLAN-[^/]+\.ya?ml$/i;

export function mapping(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function completeRecordAssessment(sourceRoot: string, artifact: string, record: JsonObject, source: "active" | "archive", sourcePath: string): { valid: boolean; violations: string[]; inheritedConfidenceProvenance?: JsonObject } {
  if (artifact !== "decisions") {
    const violations = validateStateRecord(sourceRoot, artifact, record);
    return { valid: violations.length === 0, violations };
  }
  const assessment = classifyCompleteDecisionConfidence(record, decisionLegacyCoexistence(sourceRoot), (candidate) => validateStateRecord(sourceRoot, artifact, candidate as JsonObject), source);
  return {
    valid: assessment.status !== "invalid",
    violations: assessment.violations,
    ...(assessment.status === "inherited"
      ? {
          inheritedConfidenceProvenance: {
            kind: "inherited_decision_confidence",
            source: source === "active" ? "current_projection" : "verified_archive",
            source_path: sourcePath,
            source_record_sha256: hash(canonicalRecordJson(record)),
            confidence: record.confidence as string,
          },
        }
      : {}),
  };
}

export function relative(root: string, target: string): string {
  return path.relative(root, target).replaceAll(path.sep, "/");
}

/** Migration-only source seam: pin one project file to a verified descriptor. */
export function readMigrationSource(root: string | ValidatedProjectRoot, relativePath: string, descriptorPathResolver: DescriptorPathResolver): SourceFile {
  return {
    relative: relativePath,
    ...readProjectFileSnapshot(root, relativePath, descriptorPathResolver),
  };
}
