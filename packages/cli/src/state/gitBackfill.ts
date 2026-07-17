import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  canonicalRecordJson,
  numberedArchiveArtifacts,
  numberedArchiveContract,
  stateCurrentProjectionPath,
  validateStateRecord,
} from "./archiveDiscovery.js";
import {
  stateGitBackfillContract,
  type StateGitBackfillContract,
} from "./gitBackfillAuthority.js";
import {
  archiveState,
  buildEntryOutput,
  buildResponse,
  provenanceFor,
  selectedOccurrence,
  sortedGroups,
} from "./gitBackfillOutput.js";
import {
  publishNumberedArchive,
} from "./archivePublication.js";
import { collectGitHistory } from "./gitBackfillHistory.js";

const GIT_TIMEOUT_MS = 1_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

export type BackfillFormat = "text" | "json" | "yaml";
export type BackfillMode = "inventory" | "preview" | "apply";
export type BackfillStatus = "complete" | "degraded" | "blocked" | "unavailable";
export type BackfillReason =
  | "none"
  | "conflicting_versions"
  | "shallow_history"
  | "history_rewritten"
  | "missing_history"
  | "corrupt_history"
  | "changed_head"
  | "scan_bounded"
  | "git_unavailable"
  | "immutable_conflict"
  | "candidate_changed"
  | "no_matching_pin";

export interface GitBackfillArgs {
  project?: string | null;
  artifact?: string | null;
  number?: number;
  commit?: string | null;
  path?: string | null;
  limit?: number;
  dryRun?: boolean;
  apply?: boolean;
  force?: boolean;
  format?: BackfillFormat;
  recoverProjections?: boolean;
}

export interface GitBackfillCommandOptions {
  sourceRoot?: string;
  runGit?: GitCommandRunner;
}

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  error?: string;
}

export type GitCommandRunner = (args: string[], cwd: string) => GitCommandResult;

interface ProjectionTarget {
  artifactId: string;
  entryNumber: number;
  entryId: string;
}

export interface Occurrence {
  commit: string;
  path: string;
  gitPath: string;
  blobId: string;
  entryId: string;
  artifactId: string;
  entryNumber: number;
  contentHash: string;
  record: JsonObject;
  reachable: boolean;
}

export interface CandidateGroup {
  artifactId: string;
  entryNumber: number;
  entryId: string;
  versions: Map<string, Occurrence[]>;
}

export interface HistoricalIssue {
  commit: string;
  path: string;
  gitPath: string;
  blobId: string;
  entryId: string;
  contentHash: null;
  reachable: boolean;
  message: string;
}

export interface ScanResult {
  projectRoot: string;
  sourceRoot: string;
  contract: StateGitBackfillContract;
  beforeHead?: string;
  afterHead?: string;
  headStatus: "stable" | "changed" | "unavailable";
  gitRoot?: string;
  refs: string[];
  shallow: boolean;
  gitReason?: string;
  bounded: boolean;
  boundedReasons: string[];
  historyWork: number;
  historyBytes: number;
  targets: Map<string, ProjectionTarget>;
  groups: Map<string, CandidateGroup>;
  rewritten: Map<string, Occurrence[]>;
  invalid: Map<string, HistoricalIssue[]>;
  reachableCommits: Set<string>;
  diagnostics: string[];
  projectionHashes: Record<string, string>;
}

export interface GitContext {
  root?: string;
  before?: string;
  refs: string[];
  shallow: boolean;
  reason?: string;
}

interface ParsedProjection {
  records: Array<{ entryNumber?: number; record?: JsonObject }>;
  error?: string;
}

export interface EntryOutput {
  entry_id: string;
  artifact_id: string;
  entry_number: number;
  commit: string | null;
  path: string | null;
  blob_id: string | null;
  content_hash: string | null;
  ambiguity_reason: BackfillReason;
  eligible: boolean;
  reachable: boolean;
  provenance: Array<{
    commit: string;
    path: string;
    blob_id: string;
    entry_id: string;
    content_hash: string | null;
    reachable: boolean;
  }>;
  proposed_archive_bytes?: string;
  record_sha256?: string;
  operation?: "candidate" | "already_archived" | "applied" | "replayed" | "refused";
  refusal?: string;
}

export interface BackfillOmission {
  omitted_count: number;
  omission_reason: "none" | "result_limit";
  continuation: {
    available: boolean;
    guidance: string;
  };
}

export interface GitBackfillResponse {
  command: string;
  mode: BackfillMode;
  status: BackfillStatus;
  project: string;
  read_only: boolean;
  remote_contact: false;
  head: {
    before: string | null;
    after: string | null;
    status: "stable" | "changed" | "unavailable";
  };
  scan: {
    reachable_refs: string[];
    shallow: boolean;
    bounded: boolean;
    commits_limit: number;
    commits_used: number;
    history_bytes_limit: number;
    history_bytes_used: number;
    bounded_reasons: string[];
  };
  counts: {
    targets: number;
    occurrences: number;
    unique_candidates: number;
    conflicting: number;
    missing: number;
    previewed: number;
    applied: number;
    replayed: number;
    refused: number;
  };
  active_projections_unchanged: boolean;
  active_projection_hashes: Record<string, string>;
  omitted: boolean;
  omitted_count: number;
  omission_reason: "none" | "result_limit";
  continuation: {
    available: boolean;
    guidance: string;
  };
  entries: EntryOutput[];
  diagnostics: string[];
  source_contract: {
    syntax: string;
    authority: string;
    read_only: boolean;
    remote_contact: false;
    reachable_refs: string[];
    excluded_refs: string[];
    supported_artifacts: string[];
    limits: {
      results: number;
      history_units: number;
      history_bytes: number;
    };
    status_values: string[];
    ambiguity_reasons: string[];
    response: {
      required_fields: string[];
      entry_fields: string[];
    };
    apply_requires: string[];
    consent: {
      inventory: string;
      preview: string;
      apply: string;
    };
    revalidation: string;
    failure_projection: string;
    recovery: {
      operation: string;
      retry: string;
      omission: string;
    };
    traceability: {
      provenance_fields: string[];
      archive_record_forbids: string[];
    };
    archive_record_forbids: string[];
  };
}

function defaultGitRunner(args: string[], cwd: string): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    shell: false,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      result.signal === "SIGTERM",
    ...((result.error as NodeJS.ErrnoException | undefined)?.code
      ? { error: (result.error as NodeJS.ErrnoException).code }
      : {}),
  };
}

function successful(result: GitCommandResult): boolean {
  return result.status === 0 && !result.timedOut && !result.error;
}

function failureReason(result: GitCommandResult, fallback = "git_probe_error"): string {
  if (result.timedOut) return "git_probe_timeout";
  if (result.error || result.status === null) return "git_probe_error";
  return fallback;
}

function textResult(
  run: GitCommandRunner,
  args: string[],
  cwd: string,
  fallback = "git_probe_error",
): { value?: string; reason: string } {
  const result = run(args, cwd);
  if (successful(result)) return { value: result.stdout.trim(), reason: "available" };
  return { reason: failureReason(result, fallback) };
}

function readHead(run: GitCommandRunner, root: string): { value?: string; reason: string } {
  return textResult(run, ["rev-parse", "--verify", "HEAD^{commit}"], root, "missing_commit");
}

function safePath(relative: string): boolean {
  const normalized = path.posix.normalize(relative);
  return (
    normalized === relative &&
    !path.posix.isAbsolute(relative) &&
    relative !== "" &&
    !relative.split("/").includes("..")
  );
}

function projectGitPath(projectRoot: string, gitRoot: string, relative: string): string | undefined {
  const selected = path.relative(gitRoot, path.resolve(projectRoot, relative));
  const normalized = selected.split(path.sep).join("/");
  if (!safePath(normalized)) return undefined;
  return normalized;
}

function displayPath(projectRoot: string, gitRoot: string, gitPath: string): string | undefined {
  const absolute = path.resolve(gitRoot, gitPath);
  const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
  return safePath(relative) ? relative : undefined;
}

function gitContext(projectRoot: string, run: GitCommandRunner): GitContext {
  const inside = textResult(run, ["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (inside.value !== "true") return { refs: [], shallow: false, reason: inside.reason };
  const rootValue = textResult(run, ["rev-parse", "--show-toplevel"], projectRoot);
  if (!rootValue.value) return { refs: [], shallow: false, reason: rootValue.reason };
  const root = path.resolve(rootValue.value);
  const head = readHead(run, root);
  const refsResult = run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], root);
  if (!successful(refsResult)) return { refs: [], shallow: false, reason: failureReason(refsResult) };
  const refs = ["HEAD"];
  for (const ref of refsResult.stdout.split(/\r?\n/).map((value) => value.trim())) {
    if ((ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) && !refs.includes(ref)) refs.push(ref);
  }
  const shallow = textResult(run, ["rev-parse", "--is-shallow-repository"], root);
  return {
    root,
    ...(head.value ? { before: head.value } : {}),
    refs,
    shallow: shallow.value === "true",
    ...(head.value ? {} : { reason: head.reason }),
  };
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseProjection(
  bytes: string,
  artifactId: string,
  sourceRoot: string,
): ParsedProjection {
  try {
    const contract = numberedArchiveContract(artifactId, sourceRoot);
    const root = loadYamlMapping(bytes);
    const values = root[contract.entryCollection];
    if (!Array.isArray(values)) return { records: [] };
    const records: ParsedProjection["records"] = [];
    for (const value of values) {
      if (!isObject(value)) {
        records.push({});
        continue;
      }
      const entryNumber = positiveNumber(value[contract.entryNumberField]);
      if (entryNumber === undefined) {
        records.push({ record: value });
        continue;
      }
      records.push({ entryNumber, record: value });
    }
    return { records };
  } catch (error) {
    return { records: [], error: `cannot parse ${artifactId} projection: ${(error as Error).message}` };
  }
}

function projectionTargets(
  projectRoot: string,
  sourceRoot: string,
  artifact: string | null | undefined,
  number: number | undefined,
): { targets: Map<string, ProjectionTarget>; diagnostics: string[] } {
  const targets = new Map<string, ProjectionTarget>();
  const diagnostics: string[] = [];
  const artifacts = artifact ? [artifact] : numberedArchiveArtifacts(sourceRoot);
  for (const artifactId of artifacts) {
    const projection = stateCurrentProjectionPath(projectRoot, artifactId, sourceRoot);
    if (!fs.existsSync(projection)) {
      if (number !== undefined) {
        const entryId = `${artifactId}:${number}`;
        targets.set(entryId, { artifactId, entryNumber: number, entryId });
      }
      continue;
    }
    let bytes: string;
    try {
      bytes = fs.readFileSync(projection, "utf8");
    } catch (error) {
      diagnostics.push(`cannot read ${artifactId} projection: ${(error as Error).message}`);
      continue;
    }
    const parsed = parseProjection(bytes, artifactId, sourceRoot);
    if (parsed.error) diagnostics.push(parsed.error);
    for (const item of parsed.records) {
      if (item.entryNumber === undefined || (number !== undefined && item.entryNumber !== number)) continue;
      const entryId = `${artifactId}:${item.entryNumber}`;
      targets.set(entryId, { artifactId, entryNumber: item.entryNumber, entryId });
    }
    if (number !== undefined) {
      const entryId = `${artifactId}:${number}`;
      targets.set(entryId, { artifactId, entryNumber: number, entryId });
    }
  }
  return { targets, diagnostics };
}

function projectionHashes(projectRoot: string, sourceRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const artifactId of numberedArchiveArtifacts(sourceRoot)) {
    const projection = stateCurrentProjectionPath(projectRoot, artifactId, sourceRoot);
    let bytes = "<missing>";
    try {
      bytes = fs.readFileSync(projection, "utf8");
    } catch {
      // A missing projection is part of the deterministic byte snapshot.
    }
    hashes[artifactId] = createHash("sha256").update(bytes, "utf8").digest("hex");
  }
  return hashes;
}

function parseTreeEntries(stdout: string): Array<{ blobId: string; path: string }> {
  const entries: Array<{ blobId: string; path: string }> = [];
  for (const item of stdout.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    if (tab < 0) continue;
    const metadata = item.slice(0, tab).trim().split(/\s+/);
    const treePath = item.slice(tab + 1);
    if (metadata[1] === "blob" && /^[0-9a-f]+$/.test(metadata[2] ?? "") && safePath(treePath)) {
      entries.push({ blobId: metadata[2], path: treePath });
    }
  }
  return entries;
}

function parseTreeEntry(stdout: string): { blobId: string; path: string } | undefined {
  return parseTreeEntries(stdout)[0];
}

export type OccurrenceBase = Omit<Occurrence, "entryId" | "artifactId" | "entryNumber" | "contentHash" | "record">;

function addHistoricalIssue(
  invalid: Map<string, HistoricalIssue[]>,
  base: OccurrenceBase,
  artifactId: string,
  entryId: string,
  message: string,
): void {
  const values = invalid.get(entryId) ?? [];
  if (!values.some((value) => value.commit === base.commit && value.path === base.path && value.blobId === base.blobId)) {
    values.push({
      ...base,
      artifactId,
      entryId,
      contentHash: null,
      message,
    } as HistoricalIssue);
  }
  invalid.set(entryId, values);
}

function targetIdsForArtifact(targetIds: Set<string>, artifactId: string): string[] {
  return [...targetIds].filter((entryId) => entryId.startsWith(`${artifactId}:`));
}

function occurrenceFromProjection(
  bytes: string,
  occurrence: OccurrenceBase,
  artifactId: string,
  sourceRoot: string,
  targetIds: Set<string>,
  invalid: Map<string, HistoricalIssue[]>,
  add: (item: Occurrence) => void,
): void {
  const parsed = parseProjection(bytes, artifactId, sourceRoot);
  if (parsed.error) {
    for (const entryId of targetIdsForArtifact(targetIds, artifactId)) {
      addHistoricalIssue(invalid, occurrence, artifactId, entryId, parsed.error);
    }
    return;
  }
  for (const item of parsed.records) {
    if (item.entryNumber === undefined) {
      for (const entryId of targetIdsForArtifact(targetIds, artifactId)) {
        addHistoricalIssue(invalid, occurrence, artifactId, entryId, "historical record has no valid entry number");
      }
      continue;
    }
    const entryId = `${artifactId}:${item.entryNumber}`;
    if (!targetIds.has(entryId) && targetIds.size > 0) continue;
    if (!item.record) {
      addHistoricalIssue(invalid, occurrence, artifactId, entryId, "historical record is not a mapping");
      continue;
    }
    try {
      const violations = validateStateRecord(sourceRoot, artifactId, item.record);
      if (violations.length > 0) {
        addHistoricalIssue(invalid, occurrence, artifactId, entryId, violations.join("; "));
        continue;
      }
      const contentHash = createHash("sha256")
        .update(canonicalRecordJson(item.record), "utf8")
        .digest("hex");
      add({
        ...occurrence,
        entryId,
        artifactId,
        entryNumber: item.entryNumber,
        contentHash,
        record: item.record,
      });
    } catch (error) {
      addHistoricalIssue(invalid, occurrence, artifactId, entryId, (error as Error).message);
    }
  }
}

function addGroup(groups: Map<string, CandidateGroup>, occurrence: Occurrence): void {
  let group = groups.get(occurrence.entryId);
  if (!group) {
    group = {
      artifactId: occurrence.artifactId,
      entryNumber: occurrence.entryNumber,
      entryId: occurrence.entryId,
      versions: new Map(),
    };
    groups.set(occurrence.entryId, group);
  }
  const version = group.versions.get(occurrence.contentHash) ?? [];
  const duplicate = version.some(
    (item) => item.commit === occurrence.commit && item.path === occurrence.path && item.blobId === occurrence.blobId,
  );
  if (!duplicate) version.push(occurrence);
  group.versions.set(occurrence.contentHash, version);
}

function markBounded(scan: ScanResult, reason: string): void {
  scan.bounded = true;
  if (!scan.boundedReasons.includes(reason)) scan.boundedReasons.push(reason);
}

function consumeHistoryWork(scan: ScanResult): boolean {
  if (scan.historyWork >= scan.contract.maximumCommits) {
    markBounded(scan, "commit_count");
    const diagnostic = "history commit/probe budget exhausted; remaining Git history was not inspected";
    if (!scan.diagnostics.includes(diagnostic)) scan.diagnostics.push(diagnostic);
    return false;
  }
  scan.historyWork += 1;
  return true;
}

function chargeHistoryBytes(scan: ScanResult, bytes: string): boolean {
  const size = Buffer.byteLength(bytes, "utf8");
  if (scan.historyBytes + size > scan.contract.maximumHistoryBytes) {
    markBounded(scan, "history_bytes");
    scan.diagnostics.push("history byte budget exhausted; remaining Git history was not inspected");
    return false;
  }
  scan.historyBytes += size;
  return true;
}

function scanBackfill(
  project: string,
  args: GitBackfillArgs,
  options: GitBackfillCommandOptions,
): ScanResult {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = stateGitBackfillContract(sourceRoot);
  const projectRoot = path.resolve(project);
  const run = options.runGit ?? defaultGitRunner;
  const targetState = projectionTargets(projectRoot, sourceRoot, args.artifact, args.number);
  const context = gitContext(projectRoot, run);
  const hashes = projectionHashes(projectRoot, sourceRoot);
  const scan: ScanResult = {
    projectRoot,
    sourceRoot,
    contract,
    ...(context.before ? { beforeHead: context.before } : {}),
    afterHead: undefined,
    headStatus: context.before ? "stable" : "unavailable",
    ...(context.root ? { gitRoot: context.root } : {}),
    ...(context.reason ? { gitReason: context.reason } : {}),
    refs: context.refs,
    shallow: context.shallow,
    bounded: false,
    boundedReasons: [],
    historyWork: 0,
    historyBytes: 0,
    targets: targetState.targets,
    groups: new Map(),
    rewritten: new Map(),
    invalid: new Map(),
    reachableCommits: new Set(),
    diagnostics: [...targetState.diagnostics, ...(context.reason ? [`Git unavailable: ${context.reason}`] : [])],
    projectionHashes: hashes,
  };
  if (context.root && context.before) {
    collectGitHistory(scan, run, context, {
      projectionGitPath: (currentScan, gitRoot, artifactId) =>
        projectGitPath(
          currentScan.projectRoot,
          gitRoot,
          path.relative(
            currentScan.projectRoot,
            stateCurrentProjectionPath(currentScan.projectRoot, artifactId, currentScan.sourceRoot),
          ),
        ),
      displayPath,
      parseTreeEntry,
      occurrenceFromProjection,
      addGroup,
      markBounded,
      consumeHistoryWork,
      chargeHistoryBytes,
    });
  }
  const after = context.root ? readHead(run, context.root) : undefined;
  if (after?.value) scan.afterHead = after.value;
  if (scan.beforeHead && !scan.afterHead) {
    scan.headStatus = "unavailable";
    scan.diagnostics.push(`Git HEAD could not be captured after the scan: ${after?.reason ?? "missing_commit"}`);
  } else if (scan.beforeHead && scan.afterHead && scan.beforeHead !== scan.afterHead) {
    scan.headStatus = "changed";
    scan.diagnostics.push("Git HEAD changed during the read-only history scan");
  }
  return scan;
}

function captureRefs(run: GitCommandRunner, root: string): string[] | undefined {
  const result = run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], root);
  if (!successful(result)) return undefined;
  const refs = ["HEAD"];
  for (const ref of result.stdout.split(/\r?\n/).map((value) => value.trim())) {
    if ((ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")) && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

function candidateReachable(
  run: GitCommandRunner,
  root: string,
  commit: string,
  refs: string[],
): boolean {
  for (const ref of refs) {
    const result = run(["merge-base", "--is-ancestor", commit, ref], root);
    if (result.status === 0 && !result.timedOut && !result.error) return true;
    if (result.timedOut || result.error) return false;
  }
  return false;
}

function revalidate(
  scan: ScanResult,
  run: GitCommandRunner,
  candidate: Occurrence,
): { ok: boolean; reason?: BackfillReason; afterHead?: string } {
  if (!scan.gitRoot || !scan.beforeHead) return { ok: false, reason: "git_unavailable" };
  const before = readHead(run, scan.gitRoot);
  if (before.value !== scan.beforeHead) return { ok: false, reason: "changed_head" };
  const refs = captureRefs(run, scan.gitRoot);
  if (!refs || !candidateReachable(run, scan.gitRoot, candidate.commit, refs)) {
    return { ok: false, reason: "candidate_changed" };
  }
  const tree = run(["ls-tree", "-r", "-z", candidate.commit, "--", candidate.gitPath], scan.gitRoot);
  const treeEntry = successful(tree) ? parseTreeEntry(tree.stdout) : undefined;
  if (!treeEntry || treeEntry.blobId !== candidate.blobId) return { ok: false, reason: "candidate_changed" };
  const content = run(["cat-file", "-p", candidate.blobId], scan.gitRoot);
  if (!successful(content)) return { ok: false, reason: "candidate_changed" };
  if (!chargeHistoryBytes(scan, content.stdout)) return { ok: false, reason: "candidate_changed" };
  let matched = false;
  occurrenceFromProjection(
    content.stdout,
    candidate,
    candidate.artifactId,
    scan.sourceRoot,
    new Set([candidate.entryId]),
    new Map(),
    (value) => {
      if (value.entryId === candidate.entryId && value.contentHash === candidate.contentHash) matched = true;
    },
  );
  if (!matched) return { ok: false, reason: "candidate_changed" };
  const after = readHead(run, scan.gitRoot);
  if (!after.value || after.value !== scan.beforeHead) {
    return { ok: false, reason: after.value ? "changed_head" : "git_unavailable" };
  }
  return { ok: true, afterHead: after.value };
}

export function inspectGitBackfill(
  project: string,
  args: Omit<GitBackfillArgs, "project" | "format" | "dryRun" | "apply" | "force"> = {},
  options: GitBackfillCommandOptions = {},
): GitBackfillResponse {
  const scan = scanBackfill(project, args, options);
  const groups = sortedGroups(scan, args);
  const allEntries: EntryOutput[] = [];
  for (const group of groups) {
    allEntries.push(buildEntryOutput(scan, group, args, false));
    for (const rewritten of scan.rewritten.get(group.entryId) ?? []) {
      if (group.versions.size === 0) {
        allEntries.push({
          entry_id: group.entryId,
          artifact_id: group.artifactId,
          entry_number: group.entryNumber,
          commit: rewritten.commit,
          path: rewritten.path,
          blob_id: rewritten.blobId,
          content_hash: rewritten.contentHash,
          ambiguity_reason: "history_rewritten",
          eligible: false,
          reachable: false,
          provenance: provenanceFor([rewritten]),
          operation: "refused",
        });
      }
    }
  }
  const limit = Math.min(args.limit ?? scan.contract.defaultLimit, scan.contract.maximumLimit);
  const entries = allEntries.slice(0, limit);
  const omittedCount = allEntries.length - entries.length;
  const status: BackfillStatus = !scan.gitRoot
    ? "unavailable"
    : entries.some((entry) => entry.ambiguity_reason === "no_matching_pin")
      ? "blocked"
      : omittedCount > 0 || scan.headStatus !== "stable" || scan.bounded || entries.some((entry) => entry.ambiguity_reason !== "none")
      ? "degraded"
      : "complete";
  return buildResponse(scan, "inventory", entries, scan.diagnostics, status, omittedCount);
}

export function previewGitBackfill(
  project: string,
  args: Omit<GitBackfillArgs, "project" | "format" | "dryRun" | "apply" | "force"> = {},
  options: GitBackfillCommandOptions = {},
): GitBackfillResponse {
  const scan = scanBackfill(project, args, options);
  const groups = sortedGroups(scan, args);
  const allEntries = groups.map((group) => buildEntryOutput(scan, group, args, true));
  const limit = Math.min(args.limit ?? scan.contract.defaultLimit, scan.contract.maximumLimit);
  const entries = allEntries.slice(0, limit);
  const omittedCount = allEntries.length - entries.length;
  const status: BackfillStatus = entries.some((entry) => entry.ambiguity_reason === "no_matching_pin")
    ? "blocked"
    : omittedCount > 0
      ? "degraded"
      : entries.some((entry) => entry.proposed_archive_bytes !== undefined)
      ? entries.some((entry) => !entry.eligible) || scan.headStatus !== "stable" || scan.bounded
        ? "degraded"
        : "complete"
        : scan.gitRoot
          ? entries.some((entry) => entry.ambiguity_reason !== "none")
            ? "degraded"
            : "blocked"
          : "unavailable";
  return buildResponse(scan, "preview", entries, scan.diagnostics, status, omittedCount);
}

export function applyGitBackfill(
  project: string,
  args: Omit<GitBackfillArgs, "project" | "format" | "dryRun" | "apply" | "force">,
  options: GitBackfillCommandOptions = {},
): GitBackfillResponse {
  const scan = scanBackfill(project, args, options);
  const groups = sortedGroups(scan, args);
  const group = groups[0];
  const entries: EntryOutput[] = [];
  const beforeHashes = scan.projectionHashes;
  if (!group || groups.length !== 1 || !args.artifact || args.number === undefined) {
    const response = buildResponse(
      scan,
      "apply",
      group ? [buildEntryOutput(scan, group, args, true)] : [],
      [...scan.diagnostics, "apply requires exactly one --artifact and --number selector"],
      "blocked",
    );
    response.active_projections_unchanged = true;
    return response;
  }
  const candidate = selectedOccurrence(scan, group, args);
  const entry = buildEntryOutput(scan, group, args, true);
  if (!candidate || !entry.eligible) {
    entry.operation = "refused";
    entry.refusal = entry.ambiguity_reason;
    entries.push(entry);
    const response = buildResponse(scan, "apply", entries, scan.diagnostics, "blocked");
    response.active_projections_unchanged = true;
    return response;
  }
  if (!entry.proposed_archive_bytes || !entry.record_sha256) {
    entry.eligible = false;
    entry.operation = "refused";
    entry.refusal = "candidate did not produce immutable archive bytes";
    entries.push(entry);
    const response = buildResponse(scan, "apply", entries, scan.diagnostics, "blocked");
    response.active_projections_unchanged = true;
    return response;
  }
  const run = options.runGit ?? defaultGitRunner;
  const archiveStatus = archiveState(scan.projectRoot, scan.sourceRoot, group);
  if (archiveStatus === "conflict") {
    entry.eligible = false;
    entry.ambiguity_reason = "immutable_conflict";
    entry.operation = "refused";
    entry.refusal = "immutable archive content differs; existing bytes were preserved";
    entries.push(entry);
    const response = buildResponse(scan, "apply", entries, scan.diagnostics, "blocked");
    response.active_projections_unchanged = true;
    return response;
  }
  const valid = revalidate(scan, run, candidate);
  if (!valid.ok) {
    entry.eligible = false;
    entry.operation = "refused";
    entry.ambiguity_reason = valid.reason ?? "candidate_changed";
    entry.refusal = valid.reason ?? "candidate_changed";
    entries.push(entry);
    const response = buildResponse(scan, "apply", entries, scan.diagnostics, "blocked");
    response.active_projections_unchanged = true;
    return response;
  }
  try {
    const result = publishNumberedArchive(
      scan.projectRoot,
      group.artifactId,
      group.entryNumber,
      candidate.record,
      { sourceRoot: scan.sourceRoot },
    );
    entry.operation = result.replay ? "replayed" : "applied";
    entries.push(entry);
    const after = scan.gitRoot ? readHead(run, scan.gitRoot) : undefined;
    if (after?.value) scan.afterHead = after.value;
    if (!after?.value || after.value !== scan.beforeHead) {
      scan.headStatus = after?.value ? "changed" : "unavailable";
      scan.diagnostics.push("Git HEAD changed or became unavailable after archive publication");
    }
    const response = buildResponse(
      scan,
      "apply",
      entries,
      scan.diagnostics,
      scan.headStatus === "stable" ? "complete" : "degraded",
    );
    response.active_projection_hashes = projectionHashes(scan.projectRoot, scan.sourceRoot);
    response.active_projections_unchanged = JSON.stringify(beforeHashes) === JSON.stringify(response.active_projection_hashes);
    return response;
  } catch (error) {
    entry.operation = "refused";
    entry.eligible = false;
    entry.ambiguity_reason = /immutable archive|conflict/i.test((error as Error).message)
      ? "immutable_conflict"
      : "candidate_changed";
    entry.refusal = (error as Error).message;
    entries.push(entry);
    const response = buildResponse(scan, "apply", entries, scan.diagnostics, "blocked");
    response.active_projections_unchanged = JSON.stringify(beforeHashes) === JSON.stringify(projectionHashes(scan.projectRoot, scan.sourceRoot));
    return response;
  }
}
