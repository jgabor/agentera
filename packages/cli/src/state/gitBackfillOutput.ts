import fs from "node:fs";
import path from "node:path";

import {
  canonicalRecordJson,
  discoverNumberedArchives,
  numberedArchiveContract,
} from "./archiveDiscovery.js";
import { serializeNumberedArchive } from "./archivePublication.js";
import type {
  BackfillReason,
  CandidateGroup,
  EntryOutput,
  GitBackfillArgs,
  GitBackfillResponse,
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
  if (scan.bounded) return "scan_bounded";
  if (scan.shallow) return "shallow_history";
  if (group.versions.size > 1) return "conflicting_versions";
  if (group.versions.size === 1) return "none";
  if (scan.rewritten.has(group.entryId)) return "history_rewritten";
  if (scan.invalid.has(group.entryId)) return "corrupt_history";
  return "missing_history";
}

export function provenanceFor(values: Occurrence[]): EntryOutput["provenance"] {
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

function occurrenceFor(group: CandidateGroup, args: GitBackfillArgs): Occurrence | undefined {
  return occurrences(group).find(
    (value) =>
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
  const reason = groupReason(scan, group);
  const values = occurrences(group);
  const selected = occurrenceFor(group, args) ?? values[0];
  const eligible = reason === "none" && group.versions.size === 1 && selected !== undefined;
  const output: EntryOutput = {
    entry_id: group.entryId,
    artifact_id: group.artifactId,
    entry_number: group.entryNumber,
    commit: selected?.commit ?? null,
    path: selected?.path ?? null,
    blob_id: selected?.blobId ?? null,
    content_hash: selected?.contentHash ?? null,
    ambiguity_reason: reason,
    eligible,
    reachable: selected?.reachable ?? false,
    provenance: provenanceFor(values),
    operation: eligible ? "candidate" : "refused",
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

export function selectedOccurrence(group: CandidateGroup, args: GitBackfillArgs): Occurrence | undefined {
  return occurrenceFor(group, args);
}

export function buildResponse(
  scan: ScanResult,
  mode: "inventory" | "preview" | "apply",
  entries: EntryOutput[],
  diagnostics: string[],
  status: "complete" | "degraded" | "blocked" | "unavailable",
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
      history_bytes_limit: scan.contract.maximumHistoryBytes,
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
    entries,
    diagnostics,
    source_contract: {
      syntax: scan.contract.command,
      authority: "references/artifacts/state-storage-authority.yaml",
      read_only: mode !== "apply",
      remote_contact: false,
      reachable_refs: scan.contract.reachableRefs,
      excluded_refs: scan.contract.excludedRefs,
      apply_requires: ["--apply", "--force", "--artifact ARTIFACT", "--number N"],
      archive_record_forbids: ["commit", "commit_hash", "git_commit", "git_ref"],
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
  for (const diagnostic of response.diagnostics) out(`diagnostic=${diagnostic}\n`);
}
