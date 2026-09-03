import { createHash } from "node:crypto";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson, discoverNumberedArchives, numberedArchiveContract, type ArchiveRejection, type NumberedArchiveContract, type NumberedArchiveDiscovery } from "./archiveDiscovery.js";

export type ProjectionRecoveryStatus = "complete" | "degraded" | "blocked" | "unsupported";
export type ProjectionRecoveryClass = "not_found" | "corrupt" | "immutable_conflict" | "unsupported_state";

export interface ProjectionRecoveryError {
  schemaVersion: "agentera.stateFailure.v1";
  class: ProjectionRecoveryClass;
  message: string;
  syntax: string;
  example: string;
  recovery: string;
  details: Record<string, unknown>;
}

export interface ProjectionRecovery {
  stable_id: string;
  artifact_id: string;
  entry_number?: number;
  archive_path?: string;
  status: ProjectionRecoveryStatus;
  reason: "verified" | ProjectionRecoveryClass;
  detail_availability: "full";
  source: "archive" | "current_projection";
  error?: ProjectionRecoveryError;
}

export interface ProjectionRecoveryReport {
  status: ProjectionRecoveryStatus;
  attempted: number;
  verified: number;
  retained_full: number;
  refused_count: number;
  refusals: ProjectionRecovery[];
}

export interface ProjectionGateResult {
  verified: JsonObject[];
  refused: Array<{ entry: JsonObject; recovery: ProjectionRecovery }>;
  recovery: ProjectionRecoveryReport;
}

const PROJECTION_COMMAND = "agentera check compact --mode fix";

function entryNumber(record: JsonObject, contract: NumberedArchiveContract): number | null {
  const value = record[contract.entryNumberField];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function stableId(artifactId: string, number: number | null): string {
  return `${artifactId}:${number ?? "?"}`;
}

function archivePath(projectRoot: string, contract: NumberedArchiveContract, artifactId: string, number: number | null): string | undefined {
  if (number === null) return undefined;
  return path.join(path.resolve(projectRoot), contract.archiveRoot, artifactId, `${number}${contract.archiveExtension}`);
}

function rejectionForEntry(rejectionList: ArchiveRejection[], target: string | undefined, contract: NumberedArchiveContract, number: number | null): ArchiveRejection | undefined {
  if (!target || number === null) return undefined;
  const artifactDirectory = path.dirname(target);
  return rejectionList.find((candidate) => {
    const candidatePath = path.resolve(candidate.path);
    const resolvedTarget = path.resolve(target);
    const targetFromCandidate = path.relative(candidatePath, resolvedTarget);
    if (candidatePath === resolvedTarget || candidatePath === path.resolve(artifactDirectory) || (targetFromCandidate !== "" && !targetFromCandidate.startsWith(".." + path.sep) && !path.isAbsolute(targetFromCandidate))) {
      return true;
    }
    const relative = path.relative(artifactDirectory, candidatePath);
    if (!relative || relative.includes(path.sep)) return false;
    const stem = relative.endsWith(contract.archiveExtension) ? relative.slice(0, -contract.archiveExtension.length) : "";
    return /^\+?[0-9]+$/.test(stem) && Number(stem.replace(/^\+/, "")) === number;
  });
}

function errorClassForRejection(rejection: ArchiveRejection): ProjectionRecoveryClass {
  return rejection.class === "unsupported_artifact" || rejection.reason === "unsupported_artifact" || (rejection.reason === "invalid_envelope" && rejection.message.startsWith("schemaVersion must be")) ? "unsupported_state" : "corrupt";
}

function failure(projectRoot: string, artifactId: string, number: number | null, contract: NumberedArchiveContract | undefined, recoveryClass: ProjectionRecoveryClass, message: string, details: Record<string, unknown> = {}): ProjectionRecovery {
  const archive = contract ? archivePath(projectRoot, contract, artifactId, number) : undefined;
  const id = stableId(artifactId, number);
  const recovery =
    recoveryClass === "not_found"
      ? "Keep the current full entry and publish or restore its validated numbered archive before retrying."
      : recoveryClass === "corrupt"
        ? "Keep the current full entry, preserve the archive bytes for diagnostics, repair the archive, then retry."
        : recoveryClass === "immutable_conflict"
          ? "Keep the current full entry, preserve the immutable archive bytes, reconcile the conflicting record, then retry."
          : "Keep the current full entry and use a state format supported by the storage authority before retrying.";
  const status: ProjectionRecoveryStatus = recoveryClass === "not_found" ? "degraded" : recoveryClass === "unsupported_state" ? "unsupported" : "blocked";
  return {
    stable_id: id,
    artifact_id: artifactId,
    ...(number === null ? {} : { entry_number: number }),
    ...(archive ? { archive_path: archive } : {}),
    status,
    reason: recoveryClass,
    detail_availability: "full",
    source: "current_projection",
    error: {
      schemaVersion: "agentera.stateFailure.v1",
      class: recoveryClass,
      message,
      syntax: PROJECTION_COMMAND,
      example: PROJECTION_COMMAND,
      recovery,
      details: {
        artifact_id: artifactId,
        entry_number: number,
        stable_id: id,
        ...(archive ? { archive_path: archive } : {}),
        ...details,
      },
    },
  };
}

function verifyWithDiscovery(projectRoot: string, artifactId: string, record: JsonObject, contract: NumberedArchiveContract, discovery: NumberedArchiveDiscovery): ProjectionRecovery {
  const number = entryNumber(record, contract);
  const target = archivePath(projectRoot, contract, artifactId, number);
  const id = stableId(artifactId, number);
  if (number === null) {
    return failure(projectRoot, artifactId, number, contract, "unsupported_state", `full entry ${id} has no supported positive archive entry number`);
  }

  const candidate = discovery.entries.find((entry) => entry.stableId === id);
  if (candidate) {
    let expectedHash: string;
    try {
      expectedHash = createHash("sha256").update(canonicalRecordJson(record), "utf8").digest("hex");
    } catch (error) {
      return failure(projectRoot, artifactId, number, contract, "unsupported_state", `full entry ${id} cannot be represented as canonical archive content: ${(error as Error).message}`);
    }
    if (candidate.recordSha256 === expectedHash && canonicalRecordJson(candidate.record) === canonicalRecordJson(record)) {
      return {
        stable_id: id,
        artifact_id: artifactId,
        entry_number: number,
        archive_path: candidate.path,
        status: "complete",
        reason: "verified",
        detail_availability: "full",
        source: "archive",
      };
    }
    return failure(projectRoot, artifactId, number, contract, "immutable_conflict", `archive record ${id} is valid but conflicts with the full current entry; summary publication is refused`, {
      archive_record_sha256: candidate.recordSha256,
      expected_record_sha256: expectedHash,
    });
  }

  const rejection = rejectionForEntry(discovery.rejected, target, contract, number);
  if (rejection) {
    const recoveryClass = errorClassForRejection(rejection);
    return failure(projectRoot, artifactId, number, contract, recoveryClass, `archive record ${id} cannot be verified: ${rejection.message}; summary publication is refused`, {
      archive_rejection: rejection.reason,
      archive_rejection_class: rejection.class,
    });
  }
  return failure(projectRoot, artifactId, number, contract, "not_found", `validated archive record ${id} is absent; summary publication is refused`);
}

function aggregateStatus(refusals: ProjectionRecovery[]): ProjectionRecoveryStatus {
  if (refusals.some((entry) => entry.status === "blocked")) return "blocked";
  if (refusals.some((entry) => entry.status === "unsupported")) return "unsupported";
  if (refusals.some((entry) => entry.status === "degraded")) return "degraded";
  return "complete";
}

function unsupportedVerification(projectRoot: string, artifactId: string, record: JsonObject, message: string): ProjectionRecovery {
  const number = typeof record.number === "number" && Number.isSafeInteger(record.number) ? record.number : null;
  return failure(projectRoot, artifactId, number, undefined, "unsupported_state", message);
}

export function verifyArchiveForProjection(projectRoot: string, artifactId: string, record: JsonObject, options: { sourceRoot?: string } = {}): ProjectionRecovery {
  let contract: NumberedArchiveContract;
  try {
    contract = numberedArchiveContract(artifactId, options.sourceRoot);
  } catch (error) {
    return unsupportedVerification(projectRoot, artifactId, record, `artifact '${artifactId}' is outside the numbered archive authority: ${(error as Error).message}`);
  }
  try {
    return verifyWithDiscovery(projectRoot, artifactId, record, contract, discoverNumberedArchives(projectRoot, { sourceRoot: options.sourceRoot }));
  } catch (error) {
    return failure(projectRoot, artifactId, entryNumber(record, contract), contract, "unsupported_state", `archive authority could not verify ${stableId(artifactId, entryNumber(record, contract))}: ${(error as Error).message}`);
  }
}

export function gateProjectionEntries(projectRoot: string, artifactId: string, records: JsonObject[], options: { sourceRoot?: string } = {}): ProjectionGateResult {
  if (records.length === 0) {
    return {
      verified: [],
      refused: [],
      recovery: {
        status: "complete",
        attempted: 0,
        verified: 0,
        retained_full: 0,
        refused_count: 0,
        refusals: [],
      },
    };
  }

  let contract: NumberedArchiveContract | undefined;
  try {
    contract = numberedArchiveContract(artifactId, options.sourceRoot);
  } catch (error) {
    const refused = records.map((entry) => ({
      entry,
      recovery: unsupportedVerification(projectRoot, artifactId, entry, `artifact '${artifactId}' is outside the numbered archive authority: ${(error as Error).message}`),
    }));
    return {
      verified: [],
      refused,
      recovery: {
        status: "unsupported",
        attempted: records.length,
        verified: 0,
        retained_full: records.length,
        refused_count: refused.length,
        refusals: refused.map(({ recovery }) => recovery),
      },
    };
  }

  let discovery: NumberedArchiveDiscovery;
  try {
    discovery = discoverNumberedArchives(projectRoot, { sourceRoot: options.sourceRoot });
  } catch (error) {
    const refused = records.map((entry) => ({
      entry,
      recovery: failure(projectRoot, artifactId, entryNumber(entry, contract), contract, "unsupported_state", `archive authority could not verify ${stableId(artifactId, entryNumber(entry, contract))}: ${(error as Error).message}`),
    }));
    return {
      verified: [],
      refused,
      recovery: {
        status: "unsupported",
        attempted: records.length,
        verified: 0,
        retained_full: records.length,
        refused_count: refused.length,
        refusals: refused.map(({ recovery }) => recovery),
      },
    };
  }

  const verified: JsonObject[] = [];
  const refused: Array<{ entry: JsonObject; recovery: ProjectionRecovery }> = [];
  for (const entry of records) {
    const recovery = verifyWithDiscovery(projectRoot, artifactId, entry, contract, discovery);
    if (recovery.reason === "verified") verified.push(entry);
    else refused.push({ entry, recovery });
  }
  const refusals = refused.map(({ recovery }) => recovery);
  return {
    verified,
    refused,
    recovery: {
      status: aggregateStatus(refusals),
      attempted: records.length,
      verified: verified.length,
      retained_full: refused.length,
      refused_count: refused.length,
      refusals,
    },
  };
}
