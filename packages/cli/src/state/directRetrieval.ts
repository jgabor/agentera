import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { canonicalRecordJson, decisionOverlayContract, numberedArchiveArtifacts, numberedArchiveContract, readNumberedArchiveEntry, stateCurrentProjectionPath, validateStateRecord, type DecisionOverlayContract, type NumberedArchiveContract } from "./archiveDiscovery.js";
import { composeDecisionOverlay, decisionOverlayPath, loadDecisionOverlay } from "./decisionOverlay.js";
import { decisionContextEntry } from "../cli/commands/state/decisions.js";
import { assertRealpathBoundary } from "../registries/artifactRegistry.js";
import { legacyEntryNumber, legacyIdentity, type LegacyIdentityKind } from "./legacyIdentity.js";

export type StateFailureClass = "invalid_request" | "unsupported_artifact" | "not_found" | "ambiguous" | "corrupt" | "incomplete" | "immutable_conflict" | "cursor_invalid" | "cursor_snapshot_unavailable" | "unsupported_state";

export interface StateFailureBody {
  schemaVersion: "agentera.stateFailure.v1";
  status: "fail";
  error: {
    class: StateFailureClass;
    message: string;
    syntax: string;
    example: string;
    recovery: string;
    artifact_id?: string;
    entry_number?: number;
    stable_id?: string;
    artifact?: string;
    id?: string;
    valid_values?: string[];
    details?: JsonObject;
  };
}

export class StateRetrievalFailure extends Error {
  constructor(
    public readonly body: StateFailureBody,
    public readonly exitCode: 1 | 2,
  ) {
    super(body.error.message);
  }
}

interface CurrentProjection {
  path: string;
  state: "missing" | "absent" | "full" | "summary";
  identity?: LegacyIdentityKind;
  record?: JsonObject;
}

interface OverlayResult {
  record: JsonObject;
  applied: boolean;
  fields: string[];
  path: string;
}

export interface RetrievedStateEntry {
  stable_id: string;
  artifact_id: string;
  entry_number: number;
  record: JsonObject;
  source: "archive" | "legacy_full" | "legacy_summary";
  detail_availability: "full" | "summary";
  compatibility: "complete" | "degraded";
  provenance: JsonObject;
}

export interface StateGetResponse {
  command: string;
  status: "ok";
  entry: RetrievedStateEntry;
}

function isMapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stateSyntax(artifactId = "<artifact-id>"): string {
  return `agentera state ${artifactId} get --number N`;
}

function stateExample(artifactId: string, entryNumber: number | null = null): string {
  return `agentera state ${artifactId} get --number ${entryNumber ?? 1}`;
}

function failure(
  exitCode: 1 | 2,
  className: StateFailureClass,
  message: string,
  options: {
    artifactId?: string;
    entryNumber?: number;
    recovery: string;
    validValues?: string[];
    details?: JsonObject;
  },
): StateRetrievalFailure {
  const artifactId = options.artifactId;
  const entryNumber = options.entryNumber;
  const stableId = artifactId && entryNumber ? `${artifactId}:${entryNumber}` : undefined;
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: stateSyntax(artifactId),
        example: artifactId ? stateExample(artifactId, entryNumber ?? null) : stateExample("progress"),
        recovery: options.recovery,
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(entryNumber ? { entry_number: entryNumber } : {}),
        ...(stableId ? { stable_id: stableId } : {}),
        ...(options.validValues ? { valid_values: options.validValues } : {}),
        ...(options.details ? { details: options.details } : {}),
      },
    },
    exitCode,
  );
}

function inspectCurrentProjection(projectRoot: string, artifactId: string, entryNumber: number, contract: NumberedArchiveContract, sourceRoot: string): CurrentProjection {
  const projectionPath = stateCurrentProjectionPath(projectRoot, artifactId, sourceRoot);
  try {
    assertRealpathBoundary(projectRoot, projectionPath, `${artifactId} projection`);
  } catch (error) {
    throw failure(1, "corrupt", `current ${artifactId} projection path is unsafe`, {
      artifactId,
      entryNumber,
      recovery: "Preserve the project state, repair the unsafe projection path, then retry the direct get command.",
      details: { path: projectionPath, reason: (error as Error).message },
    });
  }
  let projectionStat: fs.Stats;
  try {
    projectionStat = fs.lstatSync(projectionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: projectionPath, state: "missing" };
    throw failure(1, "corrupt", `cannot read current ${artifactId} projection`, {
      artifactId,
      entryNumber,
      recovery: "Preserve the current projection for diagnostics, repair its file permissions or path, then retry the direct get command.",
      details: { path: projectionPath, reason: (error as Error).message },
    });
  }
  if (projectionStat.isSymbolicLink() || !projectionStat.isFile()) {
    throw failure(1, "corrupt", `current ${artifactId} projection is not a regular file`, {
      artifactId,
      entryNumber,
      recovery: "Restore the declared current projection as a regular project-local file, then retry the direct get command.",
      details: { path: projectionPath },
    });
  }

  let document: Record<string, unknown>;
  try {
    document = loadYamlMapping(fs.readFileSync(projectionPath, "utf8"));
  } catch (error) {
    throw failure(1, "corrupt", `cannot parse current ${artifactId} projection: ${(error as Error).message}`, {
      artifactId,
      entryNumber,
      recovery: "Preserve the current projection for diagnostics, repair its YAML, then retry the direct get command.",
      details: { path: projectionPath },
    });
  }

  const active = document[contract.entryCollection];
  if (!Array.isArray(active)) {
    throw failure(1, "corrupt", `current ${artifactId} projection is missing its '${contract.entryCollection}' collection`, {
      artifactId,
      entryNumber,
      recovery: "Restore a valid current projection with its declared entry collection, then retry the direct get command.",
      details: { path: projectionPath, collection: contract.entryCollection },
    });
  }

  let matchingActive: JsonObject | undefined;
  for (const candidate of active) {
    if (!isMapping(candidate)) continue;
    if (legacyEntryNumber(candidate, artifactId, contract.entryNumberField) !== entryNumber) continue;
    if (matchingActive) {
      throw failure(1, "ambiguous", `current ${artifactId} projection contains duplicate identity ${artifactId}:${entryNumber}`, {
        artifactId,
        entryNumber,
        recovery: "Preserve the duplicate current entries, remove the identity conflict according to the artifact schema, then retry.",
        details: { path: projectionPath, collection: contract.entryCollection },
      });
    }
    matchingActive = candidate;
  }
  if (matchingActive) {
    try {
      const violations = validateStateRecord(sourceRoot, artifactId, matchingActive);
      return {
        path: projectionPath,
        state: violations.length === 0 ? "full" : "summary",
        identity: legacyIdentity(matchingActive, artifactId, contract.entryNumberField).kind,
        record: matchingActive,
      };
    } catch (error) {
      throw failure(1, "unsupported_state", `current ${artifactId} projection could not be validated: ${(error as Error).message}`, {
        artifactId,
        entryNumber,
        recovery: "Use a state schema supported by the storage authority, repair the current projection, then retry.",
        details: { path: projectionPath },
      });
    }
  }

  const archive = document.archive;
  if (Array.isArray(archive)) {
    for (const candidate of archive) {
      if (legacyEntryNumber(candidate, artifactId, contract.entryNumberField) !== entryNumber) continue;
      return {
        path: projectionPath,
        state: "summary",
        identity: legacyIdentity(candidate, artifactId, contract.entryNumberField).kind,
        record: isMapping(candidate) ? candidate : { summary: candidate },
      };
    }
  }
  return { path: projectionPath, state: "absent" };
}

function overlayFor(projectRoot: string, sourceRoot: string, artifactId: string, entryNumber: number, record: JsonObject): OverlayResult {
  if (artifactId !== "decisions") return { record, applied: false, fields: [], path: "" };
  const contract: DecisionOverlayContract = decisionOverlayContract(sourceRoot);
  const overlayPath = decisionOverlayPath(projectRoot, sourceRoot);
  let overlay: Record<string, JsonObject>;
  try {
    overlay = loadDecisionOverlay(projectRoot, sourceRoot);
  } catch (error) {
    throw failure(1, "corrupt", `cannot read decision overlay: ${(error as Error).message}`, {
      artifactId,
      entryNumber,
      recovery: "Preserve the decision overlay for diagnostics, repair its YAML and whitelisted fields, then retry.",
      details: { path: overlayPath },
    });
  }
  const stableId = `decisions:${entryNumber}`;
  const selected = overlay[stableId];
  const fields = selected
    ? contract.mutablePaths.filter((field) => {
        let value: unknown = selected;
        for (const part of field.split(".")) {
          if (!isMapping(value)) return false;
          value = value[part];
        }
        return value !== undefined;
      })
    : [];
  const composed = composeDecisionOverlay(record, selected, contract);
  return {
    record: decisionContextEntry(composed, { inferOutcome: false }),
    applied: fields.length > 0,
    fields,
    path: overlayPath,
  };
}

function compose(projectRoot: string, sourceRoot: string, artifactId: string, entryNumber: number, current: CurrentProjection, archivePath: string, archiveRecord: JsonObject | undefined, archiveHash: string | undefined): RetrievedStateEntry {
  const record = archiveRecord ?? current.record;
  if (!record) {
    throw failure(1, "incomplete", `state ${artifactId}:${entryNumber} has no complete record available`, {
      artifactId,
      entryNumber,
      recovery: "Restore or publish the validated numbered archive for this ID before retrying; missing fields are not reconstructed.",
      details: {
        current_projection_path: current.path,
        archive_path: archivePath,
        current_representation: current.state,
      },
    });
  }
  if (!archiveRecord && current.state === "summary" && current.identity !== "explicit_decision_shorthand") {
    throw failure(1, "incomplete", `state ${artifactId}:${entryNumber} is represented only by an irrecoverable legacy summary`, {
      artifactId,
      entryNumber,
      recovery: "Restore or publish the validated numbered archive for this ID before retrying; missing fields are not reconstructed.",
      details: {
        current_projection_path: current.path,
        archive_path: archivePath,
        current_representation: current.state,
      },
    });
  }
  const complete = archiveRecord !== undefined || current.state === "full";
  const overlay = complete ? overlayFor(projectRoot, sourceRoot, artifactId, entryNumber, record) : { record, applied: false, fields: [], path: "" };
  const source = archiveRecord ? "archive" : current.state === "summary" ? "legacy_summary" : "legacy_full";
  const compatibility = archiveRecord ? "complete" : "degraded";
  return {
    stable_id: `${artifactId}:${entryNumber}`,
    artifact_id: artifactId,
    entry_number: entryNumber,
    record: overlay.record,
    source,
    detail_availability: complete ? "full" : "summary",
    compatibility,
    provenance: {
      archive: {
        path: archivePath,
        available: archiveRecord !== undefined,
        verified: archiveRecord !== undefined,
        ...(archiveHash ? { record_sha256: archiveHash } : {}),
      },
      current_projection: {
        path: current.path,
        present: current.state !== "missing" && current.state !== "absent",
        representation: current.state,
      },
      ...(artifactId === "decisions" && complete
        ? {
            overlay: { path: overlay.path, applied: overlay.applied, fields: overlay.fields },
          }
        : {}),
    },
  };
}

export function retrieveStateEntry(projectRoot: string, artifactId: string, entryNumber: number, options: { sourceRoot?: string } = {}): StateGetResponse {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const artifacts = numberedArchiveArtifacts(sourceRoot);
  if (!artifacts.includes(artifactId)) {
    throw failure(2, "unsupported_artifact", `unsupported state artifact '${artifactId}'`, {
      recovery: "Use a supported numbered state artifact and retry the direct get command.",
      validValues: artifacts,
    });
  }
  const contract = numberedArchiveContract(artifactId, sourceRoot);
  let current: CurrentProjection;
  try {
    current = inspectCurrentProjection(projectRoot, artifactId, entryNumber, contract, sourceRoot);
  } catch (error) {
    if (error instanceof StateRetrievalFailure) throw error;
    throw failure(1, "unsupported_state", `state authority could not read ${artifactId}:${entryNumber}: ${(error as Error).message}`, {
      artifactId,
      entryNumber,
      recovery: "Use a state format supported by the storage authority, then retry the direct get command.",
    });
  }

  const lookup = readNumberedArchiveEntry(projectRoot, artifactId, entryNumber, { sourceRoot });
  if (lookup.rejection) {
    const unsupported = lookup.rejection.class === "unsupported_artifact" || lookup.rejection.reason === "unsupported_artifact" || (lookup.rejection.reason === "invalid_envelope" && lookup.rejection.message.startsWith("schemaVersion must be"));
    throw failure(1, unsupported ? "unsupported_state" : "corrupt", lookup.rejection.message, {
      artifactId,
      entryNumber,
      recovery: unsupported ? "Use a numbered archive schema supported by the storage authority, then retry the direct get command." : "Preserve the affected archive bytes for diagnostics, repair the numbered record, then retry the direct get command.",
      details: { archive_path: lookup.path, rejection: lookup.rejection.reason },
    });
  }
  const archiveRecord = lookup.entry?.record;
  if (!archiveRecord && current.state === "missing") {
    throw failure(1, "not_found", `state ${artifactId}:${entryNumber} was not found in the current projection or numbered archive`, {
      artifactId,
      entryNumber,
      recovery: "Use an existing stable ID or restore/publish this numbered record before retrying.",
      details: { current_projection_path: current.path, archive_path: lookup.path },
    });
  }
  if (!archiveRecord && current.state === "absent") {
    throw failure(1, "not_found", `state ${artifactId}:${entryNumber} was not found in the current projection or numbered archive`, {
      artifactId,
      entryNumber,
      recovery: "Use an existing stable ID or restore/publish this numbered record before retrying.",
      details: { current_projection_path: current.path, archive_path: lookup.path },
    });
  }
  if (archiveRecord && current.record && current.state === "full") {
    try {
      if (canonicalRecordJson(archiveRecord) !== canonicalRecordJson(current.record)) {
        throw failure(1, "immutable_conflict", `state ${artifactId}:${entryNumber} differs between archive and current projection`, {
          artifactId,
          entryNumber,
          recovery: "Preserve the immutable archive bytes and reconcile the conflicting current record before retrying.",
          details: { current_projection_path: current.path, archive_path: lookup.path },
        });
      }
    } catch (error) {
      if (error instanceof StateRetrievalFailure) throw error;
      throw failure(1, "corrupt", `state ${artifactId}:${entryNumber} could not be compared safely`, {
        artifactId,
        entryNumber,
        recovery: "Preserve both records for diagnostics, repair their serialized state, then retry.",
        details: { current_projection_path: current.path, archive_path: lookup.path },
      });
    }
  }

  return {
    command: `state ${artifactId} get`,
    status: "ok",
    entry: compose(projectRoot, sourceRoot, artifactId, entryNumber, current, lookup.path, archiveRecord, lookup.entry?.recordSha256),
  };
}
