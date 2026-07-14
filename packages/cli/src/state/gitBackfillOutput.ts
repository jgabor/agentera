import fs from "node:fs";
import path from "node:path";

import {
  canonicalRecordJson,
  discoverNumberedArchives,
  numberedArchiveContract,
} from "./archiveDiscovery.js";
import { gitBackfillContractProjection } from "./gitBackfillAuthority.js";
import { serializeNumberedArchive } from "./archivePublication.js";
import type {
  BackfillReason,
  BackfillOmission,
  CandidateGroup,
  EntryOutput,
  GitBackfillArgs,
  GitBackfillResponse,
  HistoricalIssue,
  Occurrence,
  ScanResult,
} from "./gitBackfill.js";

export function sortedGroups(scan: ScanResult, args: GitBackfillArgs): CandidateGroup[] {
  const groups = [...scan.groups.values()].filter(
    (group) =>
      (!args.artifact || group.artifactId === args.artifact) &&
      (args.number === undefined || group.entryNumber === args.number),
  );
  for (const target of scan.targets.values()) {
    if ((!args.artifact || target.artifactId === args.artifact) &&
        (args.number === undefined || target.entryNumber === args.number) &&
        !scan.groups.has(target.entryId)) {
      groups.push({
        artifactId: target.artifactId,
        entryNumber: target.entryNumber,
        entryId: target.entryId,
        versions: new Map(),
      });
    }
  }
  groups.sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.entryNumber - b.entryNumber);
  return groups;
}

export function occurrences(group: CandidateGroup): Occurrence[] {
  return [...group.versions.values()]
    .flat()
    .sort((a, b) => a.commit.localeCompare(b.commit) || a.path.localeCompare(b.path) || a.blobId.localeCompare(b.blobId));
}

export function groupReason(scan: ScanResult, group: CandidateGroup): BackfillReason {
  if (!scan.gitRoot) return "git_unavailable";
  if (scan.headStatus === "changed") return "changed_head";
  if (scan.headStatus === "unavailable") {
    return scan.gitReason === "missing_commit" ? "missing_history" : "git_unavailable";
  }
  const reachableHashes = new Set(group.versions.keys());
  if ((scan.rewritten.get(group.entryId) ?? []).some((value) => !reachableHashes.has(value.contentHash))) {
    return "history_rewritten";
  }
  if (scan.invalid.has(group.entryId)) return "corrupt_history";
  if (scan.bounded) return "scan_bounded";
  if (scan.shallow) return "shallow_history";
  if (group.versions.size > 1) return "conflicting_versions";
  if (group.versions.size === 1) return "none";
  if (scan.rewritten.has(group.entryId)) return "history_rewritten";
  return "missing_history";
}

export function provenanceFor(values: Array<Occurrence | HistoricalIssue>): EntryOutput["provenance"] {
  return values.map((value) => ({
    commit: value.commit,
    path: value.path,
    blob_id: value.blobId,
    entry_id: value.entryId,
    content_hash: value.contentHash,
    reachable: value.reachable,
  }));
}

function existingArchiveState(
  projectRoot: string,
  sourceRoot: string,
  group: CandidateGroup,
): "none" | "same" | "conflict" {
  const contract = numberedArchiveContract(group.artifactId, sourceRoot);
  const archivePath = path.join(
    projectRoot,
    contract.archiveRoot,
    group.artifactId,
    `${group.entryNumber}${contract.archiveExtension}`,
  );
  const discovery = discoverNumberedArchives(projectRoot, {
    sourceRoot,
    artifactId: group.artifactId,
  });
  const existing = discovery.entries.find((entry) => entry.path === archivePath);
  if (existing && group.versions.size === 1) {
    const record = [...group.versions.values()][0]?.[0]?.record;
    if (record && canonicalRecordJson(existing.record) === canonicalRecordJson(record)) return "same";
  }
  if (fs.existsSync(archivePath)) return "conflict";
  return "none";
}

function occurrenceFor(scan: ScanResult, group: CandidateGroup, args: GitBackfillArgs): Occurrence | undefined {
  const values = [
    ...occurrences(group),
    ...(scan.rewritten.get(group.entryId) ?? []),
  ];
  if (!args.commit && !args.path) return values[0];
  return values.find(
    (value) =>
      value.reachable &&
      (!args.commit || value.commit === args.commit) &&
      (!args.path || value.path === args.path),
  );
}

export function buildEntryOutput(
  scan: ScanResult,
  group: CandidateGroup,
  args: GitBackfillArgs,
  includeBytes: boolean,
): EntryOutput {
  const pinRequested = Boolean(args.commit || args.path);
  const selected = occurrenceFor(scan, group, args);
  const reason = pinRequested && !selected ? "no_matching_pin" : groupReason(scan, group);
  const values = occurrences(group);
  const rewritten = scan.rewritten.get(group.entryId) ?? [];
  const invalid = scan.invalid.get(group.entryId) ?? [];
  const eligible = reason === "none" && group.versions.size === 1 && selected?.reachable === true;
  const source = selected ?? invalid[0];
  const output: EntryOutput = {
    entry_id: group.entryId,
    artifact_id: group.artifactId,
    entry_number: group.entryNumber,
    commit: source?.commit ?? null,
    path: source?.path ?? null,
    blob_id: source?.blobId ?? null,
    content_hash: source?.contentHash ?? null,
    ambiguity_reason: reason,
    eligible,
    reachable: source?.reachable ?? false,
    provenance: provenanceFor([...values, ...rewritten, ...invalid]),
    operation: eligible ? "candidate" : "refused",
    ...(reason === "no_matching_pin" ? { refusal: "no reachable occurrence matches the requested --commit/--path pin" } : {}),
  };
  if (includeBytes && eligible && selected) {
    const serialized = serializeNumberedArchive(
      group.artifactId,
      group.entryNumber,
      selected.record,
      scan.sourceRoot,
    );
    output.proposed_archive_bytes = serialized.bytes;
    output.record_sha256 = serialized.recordSha256;
  }
  return output;
}

export function archiveState(
  projectRoot: string,
  sourceRoot: string,
  group: CandidateGroup,
): "none" | "same" | "conflict" {
  return existingArchiveState(projectRoot, sourceRoot, group);
}

export function selectedOccurrence(
  scan: ScanResult,
  group: CandidateGroup,
  args: GitBackfillArgs,
): Occurrence | undefined {
  return occurrenceFor(scan, group, args);
}

export function buildResponse(
  scan: ScanResult,
  mode: "inventory" | "preview" | "apply",
  entries: EntryOutput[],
  diagnostics: string[],
  status: "complete" | "degraded" | "blocked" | "unavailable",
  omittedCount = 0,
): GitBackfillResponse {
  const uniqueCandidates = entries.filter((entry) => entry.ambiguity_reason === "none").length;
  const conflicting = entries.filter((entry) => entry.ambiguity_reason === "conflicting_versions").length;
  const missing = entries.filter((entry) => ["missing_history", "history_rewritten", "corrupt_history"].includes(entry.ambiguity_reason)).length;
  const occurrencesCount = entries.reduce((count, entry) => count + Math.max(entry.provenance.length, entry.commit ? 1 : 0), 0);
  const applied = entries.filter((entry) => entry.operation === "applied").length;
  const replayed = entries.filter((entry) => entry.operation === "replayed" || entry.operation === "already_archived").length;
  const refused = entries.filter((entry) => entry.operation === "refused").length;
  return {
    command: scan.contract.command,
    mode,
    status,
    project: scan.projectRoot,
    read_only: mode !== "apply",
    remote_contact: false,
    head: {
      before: scan.beforeHead ?? null,
      after: scan.afterHead ?? null,
      status: scan.headStatus,
    },
    scan: {
      reachable_refs: scan.refs,
      shallow: scan.shallow,
      bounded: scan.bounded,
      commits_limit: scan.contract.maximumCommits,
      commits_used: scan.historyWork,
      history_bytes_limit: scan.contract.maximumHistoryBytes,
      history_bytes_used: scan.historyBytes,
      bounded_reasons: scan.boundedReasons,
    },
    counts: {
      targets: scan.targets.size,
      occurrences: occurrencesCount,
      unique_candidates: uniqueCandidates,
      conflicting,
      missing,
      previewed: mode === "preview" ? entries.filter((entry) => entry.proposed_archive_bytes !== undefined).length : 0,
      applied,
      replayed,
      refused,
    },
    active_projections_unchanged: true,
    active_projection_hashes: scan.projectionHashes,
    omitted: omittedCount > 0,
    omitted_count: omittedCount,
    omission_reason: omittedCount > 0 ? "result_limit" : "none",
    continuation: {
      available: false,
      guidance: omittedCount > 0
        ? "No cursor is issued; use --artifact ARTIFACT --number N to retrieve an omitted entry because --limit is capped at 100."
        : "No continuation is required.",
    } satisfies BackfillOmission["continuation"],
    entries,
    diagnostics,
    source_contract: {
      ...gitBackfillContractProjection(scan.contract),
      syntax: scan.contract.command,
      read_only: mode !== "apply",
      remote_contact: false,
      archive_record_forbids: scan.contract.archiveRecordForbids,
    },
  };
}

export function renderGitBackfillText(response: GitBackfillResponse, out: (text: string) => void): void {
  out(`status=${response.status} | mode=${response.mode} | project=${response.project} | head=${response.head.status}\n`);
  out(
    `counts=targets:${response.counts.targets} occurrences:${response.counts.occurrences} ` +
      `unique:${response.counts.unique_candidates} conflicting:${response.counts.conflicting} ` +
      `missing:${response.counts.missing} applied:${response.counts.applied} refused:${response.counts.refused}\n`,
  );
  for (const entry of response.entries) {
    out(
      `- ${entry.entry_id} | ${entry.operation ?? "candidate"} | ` +
        `reason=${entry.ambiguity_reason} | commit=${entry.commit ?? "-"} | path=${entry.path ?? "-"}\n`,
    );
  }
  if (response.omitted) {
    out(`omitted=${response.omitted_count} | reason=${response.omission_reason}\n`);
    out(`continuation=${response.continuation.guidance}\n`);
  }
  for (const diagnostic of response.diagnostics) out(`diagnostic=${diagnostic}\n`);
}
