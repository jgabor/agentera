import { createHash } from "node:crypto";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson, validateStateRecord } from "./archiveDiscovery.js";
import { canonicalMigrationRecord } from "./canonicalMigrationRecord.js";
import { applyDecisionChanges } from "./decisionEntities.js";
import { classifyCompleteDecisionConfidence, decisionLegacyCoexistence } from "./decisionLegacyValidation.js";
import type { DurableEntityMigrationEntry } from "./entityMigrationPreview.js";

function mapping(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function refuse(entry: DurableEntityMigrationEntry, recovery: string): void {
  entry.classification = "corrupt";
  entry.detail_availability = "unavailable";
  entry.compatibility = "degraded";
  entry.proposed_target = null;
  entry.target_sha256 = null;
  entry.recovery = recovery;
}

function changesFrom(source: JsonObject): JsonObject {
  const changes = mapping(source.changes);
  return structuredClone(changes ?? Object.fromEntries(Object.entries(source).filter(([field]) => !["decision", "date", "provenance", "base_sha256"].includes(field))));
}

export function migrateDecisionRevisionEntries(entries: DurableEntityMigrationEntry[], decisions: Map<string, JsonObject>, legacyDecisions: Map<string, JsonObject>, sourceRoot: string, forbiddenAliases: readonly string[], sourceFingerprint: string): void {
  const coexistence = decisionLegacyCoexistence(sourceRoot);
  const grouped = new Map<string, DurableEntityMigrationEntry[]>();
  for (const entry of entries.filter(({ boundary }) => boundary === "decision_revision")) {
    const decision = entry.relationships.find(({ field }) => field === "decision")?.target_id ?? "";
    grouped.set(decision, [...(grouped.get(decision) ?? []), entry]);
  }
  for (const [decision, revisions] of grouped) {
    let effective = structuredClone(decisions.get(decision) ?? {});
    const legacyBase = legacyDecisions.get(decision);
    let legacyEffective = structuredClone(legacyBase ?? {});
    const legacyBaseSha256 = legacyBase ? hash(canonicalRecordJson(legacyBase)) : null;
    let chainValid = decisions.has(decision) && legacyBaseSha256 !== null;
    for (const entry of revisions.sort((left, right) => left.source_identity.localeCompare(right.source_identity, undefined, { numeric: true }))) {
      if (!entry.proposed_target) {
        chainValid = false;
        continue;
      }
      const source = entry.record;
      const changes = changesFrom(source);
      const expectedBase = hash(canonicalRecordJson(effective));
      const claimedBase = typeof source.base_sha256 === "string" ? source.base_sha256 : null;
      if (!chainValid || (claimedBase !== null && claimedBase !== legacyBaseSha256)) {
        refuse(
          entry,
          claimedBase !== null && claimedBase !== legacyBaseSha256
            ? `Legacy revision '${entry.source_identity}' claims base ${claimedBase}, but the immutable legacy base is ${legacyBaseSha256}; preserve the source and reconcile the stale hash before migration.`
            : `Legacy revision '${entry.source_identity}' follows an invalid or unavailable revision base; preserve the source and repair the ordered chain before migration.`,
        );
        chainValid = false;
        continue;
      }
      const legacyProjected = { ...legacyEffective, ...structuredClone(changes) };
      const assessment = classifyCompleteDecisionConfidence(legacyProjected, coexistence, (candidate) => validateStateRecord(sourceRoot, "decisions", candidate as JsonObject), "active");
      if (assessment.status === "invalid") {
        refuse(entry, `Legacy revision '${entry.source_identity}' produces an invalid effective decision (${assessment.violations.join("; ")}); preserve the source and repair the revision before migration.`);
        chainValid = false;
        continue;
      }
      const projected = applyDecisionChanges(effective, changes);
      const expectedProjection = canonicalMigrationRecord("decision", legacyProjected, forbiddenAliases);
      if (canonicalRecordJson(projected) !== canonicalRecordJson(expectedProjection)) {
        refuse(entry, `Legacy revision '${entry.source_identity}' cannot be represented by canonical decision changes without altering its effective value; preserve the source and repair the revision before migration.`);
        chainValid = false;
        continue;
      }
      entry.record = {
        decision,
        ...(typeof source.date === "string" ? { date: source.date } : {}),
        provenance: typeof source.provenance === "string" ? source.provenance : "historical_revision",
        base_sha256: expectedBase,
        changes,
      };
      if (typeof changes.confidence === "string" && coexistence.knownLegacyExamples.includes(changes.confidence)) {
        entry.canonical_migration_provenance = {
          kind: "inherited_decision_revision_confidence",
          source: "revision_document",
          source_path: entry.source_paths[0],
          source_identity: entry.source_identity,
          source_fingerprint: sourceFingerprint,
          source_record_sha256: entry.content_sha256 ?? hash(canonicalRecordJson(source)),
          confidence: changes.confidence,
        };
      }
      effective = projected;
      legacyEffective = legacyProjected;
    }
  }
}
