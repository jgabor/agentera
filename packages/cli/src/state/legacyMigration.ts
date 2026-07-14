import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { compactYamlBytes } from "../hooks/compaction/apply.js";
import { ArtifactSchemaValidator } from "../hooks/validateArtifact/index.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import type { JsonObject } from "../core/jsonValue.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import {
  canonicalRecordJson,
  discoverNumberedArchives,
  numberedArchiveContract,
  stateCurrentProjectionPath,
} from "./archiveDiscovery.js";
import type { MigrationInventory } from "../cli/commands/migrate.js";
import type { StateMigrationContract } from "./migrationAuthority.js";
import {
  metadataRejectedCandidate,
  parseCandidate,
  type ArtifactId,
  type ParsedCandidate,
  type ParsedLegacyRecord,
} from "./legacyMigrationParser.js";
import {
  StateMutationTransaction,
  withStateMutation,
  type MutationFailureBoundary,
} from "./write/mutation.js";
import {
  migrationEnrichmentFollowUp,
} from "./migrationEnrichment.js";

interface CandidateIdentityGroup {
  artifactId: ArtifactId;
  number: number;
  records: Array<{ candidate: ParsedCandidate; record: ParsedLegacyRecord }>;
  classification?: "mirrored" | "duplicate" | "conflict";
}

export interface LegacyMigrationInspection {
  project: string;
  candidates: ParsedCandidate[];
  entries: Array<Record<string, unknown>>;
  diagnostics: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
  status: string;
}

export interface LegacyMigrationApplyOptions {
  sourceRoot: string;
  failAfter?: MutationFailureBoundary;
  throwOnInjectedFailure?: boolean;
}

export interface LegacyMigrationApplyResult {
  status: string;
  mutationPerformed: boolean;
  diagnostics: Array<Record<string, unknown>>;
  operations: Array<Record<string, unknown>>;
}

export class LegacyMigrationFailure extends Error {
  readonly failureClass: string;

  constructor(failureClass: string, message: string) {
    super(message);
    this.name = "LegacyMigrationFailure";
    this.failureClass = failureClass;
  }
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function entryClassification(failureClass: string): string {
  if (failureClass === "ambiguous_candidate") return "ambiguous";
  if (failureClass === "corrupt_candidate") return "corrupt";
  if (failureClass === "unsupported_candidate") return "unsupported";
  if (failureClass === "project_boundary") return "project_boundary";
  return "unaddressable";
}

function rejectionFailureClass(rejection: string): string {
  if (
    [
      "ambiguous_candidate",
      "corrupt_candidate",
      "project_boundary",
      "unsupported_candidate",
      "changed_candidate",
      "backup_conflict",
      "immutable_conflict",
      "projection_failure",
      "interrupted",
      "invalid_selector",
    ].includes(rejection)
  )
    return rejection;
  if (rejection === "conflicting_identity") return "immutable_conflict";
  if (rejection === "shorthand_collision" || rejection === "multiple_explicit_identities")
    return "ambiguous_candidate";
  if (rejection === "corrupt_record" || rejection === "record_schema") return "corrupt_candidate";
  if (rejection === "symlink_escape" || rejection === "outside_project") return "project_boundary";
  if (rejection === "unsupported_candidate" || rejection === "unsupported_artifact_shape")
    return "unsupported_candidate";
  if (rejection === "no_matching_identity") return "invalid_selector";
  if (rejection === "custom_requires_path_artifact_number") return "invalid_selector";
  return "unsupported_candidate";
}

function rejectionProvenance(
  candidate: ParsedCandidate,
  artifactId: unknown,
  entryNumber: unknown,
  failureClass: string,
  reason: string,
): Record<string, unknown> {
  return {
    failure_class: failureClass,
    reason,
    source: candidate.source,
    candidate_id: candidate.path,
    path: candidate.path,
    artifact_id: artifactId,
    entry_number: entryNumber,
  };
}

function groupRecords(candidates: ParsedCandidate[]): Map<string, CandidateIdentityGroup> {
  const groups = new Map<string, CandidateIdentityGroup>();
  for (const candidate of candidates) {
    for (const record of candidate.records) {
      if (record.detail !== "full" || record.number === null) continue;
      const key = `${record.artifactId}:${record.number}`;
      const group = groups.get(key) ?? {
        artifactId: record.artifactId,
        number: record.number,
        records: [],
      };
      group.records.push({ candidate, record });
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const hashes = new Set(group.records.map(({ record }) => record.hash));
    const candidateCount = new Set(group.records.map(({ candidate }) => candidate.path)).size;
    group.classification =
      hashes.size > 1
        ? "conflict"
        : group.records.length > 1 && candidateCount === 1
          ? "duplicate"
          : group.records.length > 1
            ? "mirrored"
            : undefined;
  }
  return groups;
}

function candidateEntry(
  candidate: ParsedCandidate,
  inventoryEntry: Record<string, unknown>,
  args: { artifact: string | null; number?: number; path?: string | null },
  groups: Map<string, CandidateIdentityGroup>,
  contract: StateMigrationContract,
): Record<string, unknown> {
  const fixedArtifact = contract.fixedNames[candidate.path] as ArtifactId | undefined;
  const matching = candidate.records.filter(
    (record) =>
      (!args.artifact || record.artifactId === args.artifact) &&
      (args.number === undefined || record.number === args.number),
  );
  const artifactIds = [...new Set(candidate.records.map((record) => record.artifactId))];
  const result: Record<string, unknown> = {
    ...inventoryEntry,
    artifact_id: matching[0]?.artifactId ?? fixedArtifact ?? null,
    entry_number: matching.length === 1 ? matching[0].number : null,
    classification: "unaddressable",
    detail_availability: matching[0]?.detail ?? "unavailable",
    compatibility:
      candidate.source === "current_projection"
        ? "complete"
        : candidate.source === "unavailable"
          ? "blocked"
          : "degraded",
    source: matching[0]?.source ?? candidate.source,
    addressable: false,
  };
  if (candidate.rejection) {
    const failureClass = candidate.rejection.classification;
    result.classification = entryClassification(failureClass);
    result.rejection = candidate.rejection.reason;
    result.detail_availability = "unavailable";
    result.provenance = rejectionProvenance(
      candidate,
      result.artifact_id,
      result.entry_number,
      failureClass,
      candidate.rejection.reason,
    );
    return result;
  }
  if (candidate.requiresPin && !(args.path && args.artifact && args.number !== undefined)) {
    result.rejection = "custom_requires_path_artifact_number";
    result.provenance = rejectionProvenance(
      candidate,
      result.artifact_id,
      result.entry_number,
      "invalid_selector",
      "custom_requires_path_artifact_number",
    );
    return result;
  }
  if (matching.length === 0) {
    if (args.path && candidate.path === args.path && args.artifact && args.number !== undefined) {
      result.rejection = "no_matching_identity";
    } else if (candidate.records.length === 0) {
      result.classification = fixedArtifact ? "corrupt" : "unsupported";
      result.rejection = fixedArtifact ? "corrupt_candidate" : "unsupported_candidate";
    } else if (artifactIds.length > 1) {
      result.classification = "ambiguous";
      result.rejection = "multiple_artifact_identities";
    } else {
      result.rejection = "multiple_identities_require_number";
    }
    result.provenance = rejectionProvenance(
      candidate,
      result.artifact_id,
      result.entry_number,
      rejectionFailureClass(String(result.rejection)),
      String(result.rejection),
    );
    return result;
  }
  const selectedGroup =
    matching[0]?.number === null
      ? undefined
      : groups.get(`${matching[0].artifactId}:${matching[0].number}`);
  if (
    matching.length > 1 &&
    selectedGroup?.classification === "duplicate" &&
    matching.every((record) => record.detail === "full" && record.hash === matching[0].hash)
  ) {
    result.entry_number = matching[0].number;
    result.detail_availability = matching[0].detail;
    result.source = matching[0].source;
    result.classification = "duplicate";
    result.addressable = true;
    return result;
  }
  if (matching.length > 1 || matching.some((record) => record.number === null)) {
    result.classification = "ambiguous";
    result.rejection = "ambiguous_identity";
    result.entry_number = null;
    result.provenance = rejectionProvenance(
      candidate,
      result.artifact_id,
      result.entry_number,
      "ambiguous_candidate",
      "ambiguous_identity",
    );
    return result;
  }
  const selected = matching[0];
  result.entry_number = selected.number;
  result.detail_availability = selected.detail;
  result.source = selected.source;
  if (selected.detail !== "full" || !selected.record || selected.number === null) {
    result.classification = selected.number === null ? "ambiguous" : "unaddressable";
    result.rejection = selected.detail === "summary" ? "summary_only" : "corrupt_record";
    result.provenance = rejectionProvenance(
      candidate,
      result.artifact_id,
      result.entry_number,
      selected.number === null
        ? "ambiguous_candidate"
        : selected.detail === "summary"
          ? "unsupported_candidate"
          : "corrupt_candidate",
      String(result.rejection),
    );
    return result;
  }
  const group = groups.get(`${selected.artifactId}:${selected.number}`);
  result.classification = group?.classification ?? "canonical";
  result.addressable = true;
  if (group?.classification === "conflict") {
    result.rejection = "conflicting_identity";
    result.provenance = rejectionProvenance(
      candidate,
      result.artifact_id,
      result.entry_number,
      "immutable_conflict",
      "conflicting_identity",
    );
  }
  return result;
}

function statusFor(entries: Array<Record<string, unknown>>, omittedCount: number): string {
  if (omittedCount > 0) return "degraded";
  if (
    entries.some((entry) =>
      ["blocked", "project_boundary", "corrupt", "ambiguous", "conflict", "unsupported"].includes(
        String(entry.classification),
      ),
    )
  )
    return "blocked";
  if (entries.some((entry) => entry.detail_availability === "summary")) return "degraded";
  return "complete";
}

function relativeTarget(project: string, target: string): string {
  return path.relative(project, target).replaceAll(path.sep, "/");
}

function backupPath(project: string, relativeSource: string, sourceBytes: Buffer): string {
  const identity = createHash("sha256")
    .update(relativeSource, "utf8")
    .update("\0", "utf8")
    .update(sourceBytes)
    .digest("hex");
  return path.join(project, ".agentera", "migration-backups", `${identity}.bak`);
}

function assertSafeProjectPath(project: string, target: string, label: string): void {
  try {
    assertRealpathBoundary(project, target, label);
  } catch (error) {
    throw new LegacyMigrationFailure("project_boundary", (error as Error).message);
  }
  let cursor = path.resolve(project);
  for (const segment of path.relative(cursor, target).split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new LegacyMigrationFailure(
          "project_boundary",
          `${label} path contains a symbolic link`,
        );
    } catch (error) {
      if (error instanceof LegacyMigrationFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function archiveTarget(
  project: string,
  artifactId: ArtifactId,
  entryNumber: number,
  sourceRoot: string,
): string {
  const contract = numberedArchiveContract(artifactId, sourceRoot);
  return path.join(
    project,
    contract.archiveRoot,
    artifactId,
    `${entryNumber}${contract.archiveExtension}`,
  );
}

function validateExistingArchive(
  project: string,
  artifactId: ArtifactId,
  entryNumber: number,
  record: JsonObject,
  sourceRoot: string,
): void {
  const target = archiveTarget(project, artifactId, entryNumber, sourceRoot);
  assertSafeProjectPath(project, target, "numbered archive");
  const discovery = discoverNumberedArchives(project, { sourceRoot, artifactId });
  const existing = discovery.entries.find((entry) => entry.path === target);
  if (existing && canonicalRecordJson(existing.record) !== canonicalRecordJson(record))
    throw new LegacyMigrationFailure(
      "immutable_conflict",
      `immutable archive '${relativeTarget(project, target)}' already contains different canonical content; existing bytes were preserved`,
    );
  if (discovery.rejected.some((entry) => entry.path === target))
    throw new LegacyMigrationFailure(
      "immutable_conflict",
      `immutable archive '${relativeTarget(project, target)}' is corrupt; existing bytes were preserved`,
    );
}

function validateExistingBackup(target: string, project: string, sourceBytes: Buffer): void {
  assertSafeProjectPath(project, target, "migration backup");
  if (!fs.existsSync(target)) return;
  try {
    if (!fs.readFileSync(target).equals(sourceBytes))
      throw new LegacyMigrationFailure(
        "backup_conflict",
        `immutable backup '${relativeTarget(project, target)}' already contains different source bytes; existing bytes were preserved`,
      );
  } catch (error) {
    if (error instanceof LegacyMigrationFailure) throw error;
    throw new LegacyMigrationFailure(
      "backup_conflict",
      `immutable backup '${relativeTarget(project, target)}' cannot be read; existing bytes were preserved`,
    );
  }
}

function projectionDocument(
  project: string,
  artifactId: ArtifactId,
  record: JsonObject,
  sourceRoot: string,
): { target: string; before: string; after: string } {
  const target = stateCurrentProjectionPath(project, artifactId, sourceRoot);
  assertSafeProjectPath(project, target, "current projection");
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const contract = numberedArchiveContract(artifactId, sourceRoot);
  const validator = new ArtifactSchemaValidator(
    path.join(sourceRoot, "skills", "agentera", "schemas", "artifacts"),
  );
  let document: Record<string, unknown> = {};
  if (before) {
    try {
      document = loadYamlMapping(before);
    } catch (error) {
      throw new LegacyMigrationFailure(
        "corrupt_candidate",
        `current projection '${relativeTarget(project, target)}' cannot be parsed: ${(error as Error).message}`,
      );
    }
    const violations = validator.validateYaml(
      before,
      validator.loadSchema(artifactId)!,
      artifactId,
    );
    if (violations.length > 0)
      throw new LegacyMigrationFailure(
        "corrupt_candidate",
        `current projection '${relativeTarget(project, target)}' is invalid: ${violations.join("; ")}`,
      );
  }
  const current = Array.isArray(document[contract.entryCollection])
    ? (document[contract.entryCollection] as unknown[])
    : [];
  const entryNumber = number(record[contract.entryNumberField]);
  const same = current.find(
    (value) => mapping(value) && number(value[contract.entryNumberField]) === entryNumber,
  ) as JsonObject | undefined;
  if (same && canonicalRecordJson(same) !== canonicalRecordJson(record))
    throw new LegacyMigrationFailure(
      "immutable_conflict",
      `current projection '${relativeTarget(project, target)}' already contains a different record for ${artifactId}:${entryNumber}; projection was preserved`,
    );
  if (same) return { target, before, after: before };
  const direction = artifactId === "progress" ? -1 : 1;
  const updated = [...current, record].sort((left, right) => {
    const leftNumber = number(mapping(left) ? left[contract.entryNumberField] : null) ?? 0;
    const rightNumber = number(mapping(right) ? right[contract.entryNumberField] : null) ?? 0;
    return direction * (leftNumber - rightNumber);
  });
  document[contract.entryCollection] = updated;
  const candidate = dumpYamlMapping(document);
  const violations = validator.validateYaml(
    candidate,
    validator.loadSchema(artifactId)!,
    artifactId,
  );
  if (violations.length > 0)
    throw new LegacyMigrationFailure(
      "corrupt_candidate",
      `projection candidate is invalid: ${violations.join("; ")}`,
    );
  let after: string;
  try {
    after = compactYamlBytes(candidate, artifactId, project).bytes;
  } catch (error) {
    throw new LegacyMigrationFailure(
      "projection_failure",
      `current projection could not be bounded: ${(error as Error).message}`,
    );
  }
  const boundedViolations = validator.validateYaml(
    after,
    validator.loadSchema(artifactId)!,
    artifactId,
  );
  if (boundedViolations.length > 0)
    throw new LegacyMigrationFailure(
      "projection_failure",
      `bounded projection is invalid: ${boundedViolations.join("; ")}`,
    );
  return { target, before, after };
}

function findSelectedRecord(
  inspection: LegacyMigrationInspection,
  args: { artifact: string | null; number?: number; path?: string | null },
): { candidate: ParsedCandidate; record: ParsedLegacyRecord } {
  const candidates = inspection.candidates.filter(
    (candidate) => !args.path || candidate.path === args.path,
  );
  const selectedEntries = inspection.entries.filter(
    (entry) => !args.path || entry.path === args.path,
  );
  const rejectedCandidate = candidates.find((candidate) => candidate.rejection);
  if (rejectedCandidate?.rejection)
    throw new LegacyMigrationFailure(
      rejectedCandidate.rejection.classification,
      `${rejectedCandidate.rejection.message}; no state was changed`,
    );
  if (selectedEntries.some((entry) => entry.classification === "conflict"))
    throw new LegacyMigrationFailure(
      "immutable_conflict",
      "multiple candidates provide conflicting canonical records; no state was changed",
    );
  if (selectedEntries.some((entry) => entry.classification === "ambiguous"))
    throw new LegacyMigrationFailure(
      "ambiguous_candidate",
      "candidate has multiple or conflicting supported identities; no state was changed",
    );
  const matches = candidates.flatMap((candidate) =>
    candidate.records
      .filter(
        (record) =>
          record.detail === "full" &&
          record.record &&
          record.artifactId === args.artifact &&
          record.number === args.number,
      )
      .map((record) => ({ candidate, record })),
  );
  if (!args.path && matches.some(({ candidate }) => candidate.requiresPin))
    throw new LegacyMigrationFailure(
      "invalid_selector",
      "custom candidates require an exact --path together with --artifact and --number; no state was changed",
    );
  if (matches.length === 0) {
    const summaries = candidates.flatMap((candidate) =>
      candidate.records.filter(
        (record) =>
          record.artifactId === args.artifact &&
          record.number === args.number &&
          record.detail !== "full",
      ),
    );
    if (summaries.some((record) => record.source === "unavailable" && record.summary === undefined))
      throw new LegacyMigrationFailure(
        "corrupt_candidate",
        "a selected legacy record failed artifact parsing; source bytes were preserved",
      );
    if (summaries.length > 0)
      throw new LegacyMigrationFailure(
        "unsupported_candidate",
        "summary-only or unavailable legacy state cannot be archived; source bytes were preserved",
      );
    if (candidates.some((candidate) => candidate.rejection?.classification === "ambiguous"))
      throw new LegacyMigrationFailure(
        "ambiguous_candidate",
        "candidate has multiple or conflicting supported identities; no state was changed",
      );
    throw new LegacyMigrationFailure(
      "changed_candidate",
      "the selected candidate is unavailable or no longer has the requested identity; rerun inventory and preview",
    );
  }
  if (new Set(matches.map(({ record }) => record.hash)).size > 1)
    throw new LegacyMigrationFailure(
      "immutable_conflict",
      "multiple candidates provide conflicting canonical records; no state was changed",
    );
  matches.sort((left, right) => left.candidate.path.localeCompare(right.candidate.path));
  return matches[0];
}

export function inspectLegacyMigration(
  inventory: MigrationInventory,
  contract: StateMigrationContract,
  sourceRoot: string,
  args: { artifact: string | null; number?: number; path?: string | null },
): LegacyMigrationInspection {
  const candidates = inventory.entries.map((entry) =>
    typeof entry.rejection === "string"
      ? metadataRejectedCandidate(inventory.project, entry)
      : parseCandidate(
          inventory.project,
          String(entry.path),
          contract,
          sourceRoot,
          args.artifact as ArtifactId | undefined,
        ),
  );
  const groups = groupRecords(candidates);
  const entries = candidates.map((candidate, index) =>
    candidateEntry(candidate, inventory.entries[index], args, groups, contract),
  );
  const diagnostics: Array<Record<string, unknown>> = entries
    .filter((entry) => entry.rejection)
    .map((entry) => ({
      class:
        (entry.provenance as Record<string, unknown> | undefined)?.failure_class ??
        rejectionFailureClass(String(entry.rejection)),
      candidate_id: entry.candidate_id,
      provenance: entry.provenance ?? {
        candidate_id: entry.candidate_id,
        path: entry.path,
        reason: entry.rejection,
      },
      message: `candidate '${entry.path}' is not apply-eligible: ${entry.rejection}`,
    }));
  const operations: Array<Record<string, unknown>> = [];
  if (args.artifact && args.number !== undefined) {
    try {
      const selected = findSelectedRecord(
        {
          project: inventory.project,
          candidates,
          entries,
          diagnostics,
          operations,
          status: "complete",
        },
        args,
      );
      operations.push({
        candidate_id: selected.candidate.path,
        artifact_id: args.artifact,
        entry_number: args.number,
        archive: relativeTarget(
          inventory.project,
          archiveTarget(inventory.project, args.artifact as ArtifactId, args.number, sourceRoot),
        ),
        backup: relativeTarget(
          inventory.project,
          backupPath(inventory.project, selected.candidate.path, selected.candidate.sourceBytes),
        ),
        projection: relativeTarget(
          inventory.project,
          stateCurrentProjectionPath(inventory.project, args.artifact as ArtifactId, sourceRoot),
        ),
        follow_up: migrationEnrichmentFollowUp(args.artifact, args.number),
      });
    } catch (error) {
      diagnostics.push({
        class:
          error instanceof LegacyMigrationFailure ? error.failureClass : "unsupported_candidate",
        message: (error as Error).message,
      });
    }
  }
  return {
    project: inventory.project,
    candidates,
    entries,
    diagnostics,
    operations,
    status: statusFor(entries, inventory.omittedCount),
  };
}

export function applyLegacyMigration(
  inspection: LegacyMigrationInspection,
  args: { artifact: string; number: number; path?: string | null },
  options: LegacyMigrationApplyOptions,
): LegacyMigrationApplyResult {
  let archivePublished = false;
  let backupPublished = false;
  let projectionPublished = false;
  let operation: Record<string, unknown> | undefined;
  let selectedCandidate: ParsedCandidate | undefined = inspection.candidates.find(
    (candidate) => candidate.path === args.path,
  );
  try {
    const selected = findSelectedRecord(inspection, args);
    selectedCandidate = selected.candidate;
    if (!selected.record.record || selected.record.number === null)
      throw new LegacyMigrationFailure(
        "corrupt_candidate",
        "selected candidate has no complete record; no state was changed",
      );
    assertSafeProjectPath(inspection.project, selected.candidate.absolutePath, "candidate");
    const sourceBefore = fs.readFileSync(selected.candidate.absolutePath);
    if (!sourceBefore.equals(selected.candidate.sourceBytes))
      throw new LegacyMigrationFailure(
        "changed_candidate",
        "candidate changed between inventory and apply; rerun inventory and preview",
      );
    const record = selected.record.record;
    validateExistingArchive(
      inspection.project,
      args.artifact as ArtifactId,
      args.number,
      record,
      options.sourceRoot,
    );
    const backup = backupPath(
      inspection.project,
      selected.candidate.path,
      selected.candidate.sourceBytes,
    );
    validateExistingBackup(backup, inspection.project, selected.candidate.sourceBytes);
    const projection = projectionDocument(
      inspection.project,
      args.artifact as ArtifactId,
      record,
      options.sourceRoot,
    );
    operation = {
      candidate_id: selected.candidate.path,
      artifact_id: args.artifact,
      entry_number: args.number,
      archive: relativeTarget(
        inspection.project,
        archiveTarget(
          inspection.project,
          args.artifact as ArtifactId,
          args.number,
          options.sourceRoot,
        ),
      ),
      backup: relativeTarget(inspection.project, backup),
      projection: relativeTarget(inspection.project, projection.target),
      follow_up: migrationEnrichmentFollowUp(args.artifact, args.number),
    };
    withStateMutation(
      inspection.project,
      (transaction: StateMutationTransaction) => {
        transaction.publishArchive(args.artifact as ArtifactId, args.number, record);
        archivePublished = true;
        transaction.publishBackup(backup, selected.candidate.sourceBytes.toString("utf8"), () => {
          backupPublished = true;
          try {
            if (!fs.readFileSync(backup).equals(selected.candidate.sourceBytes))
              throw new LegacyMigrationFailure(
                "backup_conflict",
                `immutable backup '${relativeTarget(inspection.project, backup)}' already contains different source bytes; existing bytes were preserved`,
              );
          } catch (error) {
            if (error instanceof LegacyMigrationFailure) throw error;
            throw new LegacyMigrationFailure(
              "backup_conflict",
              `immutable backup '${relativeTarget(inspection.project, backup)}' cannot be read; existing bytes were preserved`,
            );
          }
        });
        backupPublished = true;
        if (projection.after !== projection.before) {
          const stage = transaction.stageProjection(projection.target, projection.after);
          try {
            transaction.syncStaged(stage);
            transaction.publishProjection(stage, projection.target, projection.before);
            projectionPublished = true;
          } finally {
            transaction.removeStage(stage);
          }
        }
      },
      { failAfter: options.failAfter },
    );
    return {
      status: "complete",
      mutationPerformed: true,
      diagnostics: [],
      operations: operation ? [operation] : [],
    };
  } catch (error) {
    if (
      options.throwOnInjectedFailure &&
      error instanceof Error &&
      error.name === "InjectedMutationFailure"
    )
      throw error;
    const failureClass =
      error instanceof LegacyMigrationFailure
        ? error.failureClass
        : error instanceof Error && error.name === "InjectedMutationFailure"
          ? "interrupted"
          : "projection_failure";
    const failureMessage = error instanceof Error ? error.message : String(error);
    return {
      status: "blocked",
      mutationPerformed:
        archivePublished || backupPublished || projectionPublished || Boolean(operation),
      diagnostics: [
        {
          class: failureClass,
          message: failureMessage,
          provenance: {
            failure_class: failureClass,
            reason: failureMessage,
            candidate_id: selectedCandidate?.path ?? args.path ?? null,
            path: selectedCandidate?.path ?? args.path ?? null,
            artifact_id: args.artifact,
            entry_number: args.number,
            source: selectedCandidate?.source ?? "unavailable",
          },
        },
      ],
      operations: operation ? [operation] : [],
    };
  }
}
