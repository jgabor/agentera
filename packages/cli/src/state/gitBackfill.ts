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

const GIT_TIMEOUT_MS = 1_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const REFLOG_LIMIT = 32;

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
  | "candidate_changed";

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
  targets: Map<string, ProjectionTarget>;
  groups: Map<string, CandidateGroup>;
  rewritten: Map<string, Occurrence[]>;
  invalid: Set<string>;
  diagnostics: string[];
  projectionHashes: Record<string, string>;
}

interface GitContext {
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
    content_hash: string;
    reachable: boolean;
  }>;
  proposed_archive_bytes?: string;
  record_sha256?: string;
  operation?: "candidate" | "already_archived" | "applied" | "replayed" | "refused";
  refusal?: string;
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
    history_bytes_limit: number;
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
  entries: EntryOutput[];
  diagnostics: string[];
  source_contract: {
    syntax: string;
    authority: string;
    read_only: boolean;
    remote_contact: false;
    reachable_refs: string[];
    excluded_refs: string[];
    apply_requires: string[];
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

function parseTreeEntry(stdout: string): { blobId: string; path: string } | undefined {
  for (const item of stdout.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    if (tab < 0) continue;
    const metadata = item.slice(0, tab).trim().split(/\s+/);
    const treePath = item.slice(tab + 1);
    if (metadata[1] === "blob" && /^[0-9a-f]+$/.test(metadata[2] ?? "") && safePath(treePath)) {
      return { blobId: metadata[2], path: treePath };
    }
  }
  return undefined;
}

function logPaths(chunk: string, fallback: string): string[] {
  const lines = chunk.split(/\r?\n/).filter((line) => line.length > 0);
  const paths: string[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const status = fields[0] ?? "";
    const candidate = status.startsWith("R") || status.startsWith("C")
      ? fields[fields.length - 1]
      : fields[1];
    if (candidate && safePath(candidate) && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths.length > 0 ? paths : [fallback];
}

function occurrenceFromProjection(
  bytes: string,
  occurrence: Omit<Occurrence, "entryId" | "artifactId" | "entryNumber" | "contentHash" | "record">,
  artifactId: string,
  sourceRoot: string,
  targetIds: Set<string>,
  invalid: Set<string>,
  add: (item: Occurrence) => void,
): void {
  const parsed = parseProjection(bytes, artifactId, sourceRoot);
  for (const item of parsed.records) {
    if (item.entryNumber === undefined) continue;
    const entryId = `${artifactId}:${item.entryNumber}`;
    if (!targetIds.has(entryId) && targetIds.size > 0) continue;
    if (!item.record) {
      invalid.add(entryId);
      continue;
    }
    try {
      const violations = validateStateRecord(sourceRoot, artifactId, item.record);
      if (violations.length > 0) {
        invalid.add(entryId);
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
    } catch {
      invalid.add(entryId);
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

function historyLog(
  run: GitCommandRunner,
  context: GitContext,
  gitPath: string,
  maxCommits: number,
): { commits: Array<{ commit: string; paths: string[] }>; bounded: boolean; reason?: string } {
  if (!context.root) return { commits: [], bounded: false, reason: context.reason ?? "git_unavailable" };
  const result = run(
    [
      "log",
      "--date-order",
      "--format=%H",
      "--name-status",
      `--max-count=${maxCommits + 1}`,
      ...context.refs,
      "--",
      path.posix.dirname(gitPath),
    ],
    context.root,
  );
  if (!successful(result)) return { commits: [], bounded: false, reason: failureReason(result) };
  const commits: Array<{ commit: string; paths: string[] }> = [];
  const seen = new Set<string>();
  let currentCommit: string | undefined;
  let currentLines: string[] = [];
  const flush = (): void => {
    if (!currentCommit || seen.has(currentCommit)) return;
    seen.add(currentCommit);
    commits.push({ commit: currentCommit, paths: logPaths([currentCommit, ...currentLines].join("\n"), gitPath) });
  };
  for (const line of result.stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (/^[0-9a-f]{40,64}$/.test(value)) {
      flush();
      currentCommit = value;
      currentLines = [];
    } else if (currentCommit) {
      currentLines.push(line);
    }
  }
  flush();
  return { commits: commits.slice(0, maxCommits), bounded: commits.length > maxCommits };
}

function projectionPathFamily(gitPath: string, candidate: string): boolean {
  const directory = path.posix.dirname(gitPath);
  const stem = path.posix.basename(gitPath, ".yaml");
  return (
    safePath(candidate) &&
    path.posix.dirname(candidate) === directory &&
    path.posix.basename(candidate).startsWith(`${stem}`) &&
    candidate.endsWith(".yaml")
  );
}

function changedProjectionPaths(
  run: GitCommandRunner,
  root: string,
  commit: string,
  gitPath: string,
): string[] {
  const result = run(["diff-tree", "--root", "-r", "-M", "--name-status", commit], root);
  if (!successful(result)) return [];
  const paths: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const status = fields[0] ?? "";
    const candidates = status.startsWith("R") || status.startsWith("C")
      ? fields.slice(1)
      : [fields[1]];
    for (const candidate of candidates) {
      if (candidate && projectionPathFamily(gitPath, candidate) && !paths.includes(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

function collectReachable(
  scan: ScanResult,
  run: GitCommandRunner,
  context: GitContext,
): void {
  if (!context.root) return;
  const targetIds = new Set(scan.targets.keys());
  const artifactPaths = scan.contract.supportedArtifacts.map((artifactId) => ({
    artifactId,
    gitPath: projectGitPath(
      scan.projectRoot,
      context.root as string,
      path.relative(scan.projectRoot, stateCurrentProjectionPath(scan.projectRoot, artifactId, scan.sourceRoot)),
    ),
  }));
  const seenOccurrences = new Set<string>();
  let commitsSeen = 0;
  let historyBytes = 0;
  for (const item of artifactPaths) {
    if (!item.gitPath) {
      scan.diagnostics.push(`${item.artifactId} projection is outside the selected Git project`);
      continue;
    }
    const projectionGitPath = item.gitPath;
    const log = historyLog(run, context, projectionGitPath, scan.contract.maximumCommits);
    if (log.reason) {
      scan.diagnostics.push(`${item.artifactId} history scan failed: ${log.reason}`);
      continue;
    }
    if (log.bounded) scan.bounded = true;
    for (const commit of log.commits) {
      if (commitsSeen >= scan.contract.maximumCommits) {
        scan.bounded = true;
        break;
      }
      commitsSeen += 1;
      const paths = [...new Set([
        ...commit.paths,
        ...changedProjectionPaths(run, context.root, commit.commit, projectionGitPath),
      ])].filter((candidate) => projectionPathFamily(projectionGitPath, candidate));
      for (const gitPath of paths) {
        const tree = run(["ls-tree", "-r", "-z", commit.commit, "--", gitPath], context.root);
        if (!successful(tree)) {
          scan.diagnostics.push(`cannot inspect ${commit.commit}:${gitPath}: ${failureReason(tree)}`);
          continue;
        }
        const treeEntry = parseTreeEntry(tree.stdout);
        if (!treeEntry) continue;
        const display = displayPath(scan.projectRoot, context.root, treeEntry.path);
        if (!display) continue;
        const occurrenceKey = `${commit.commit}:${display}:${treeEntry.blobId}:${item.artifactId}`;
        if (seenOccurrences.has(occurrenceKey)) continue;
        seenOccurrences.add(occurrenceKey);
        const content = run(["cat-file", "-p", treeEntry.blobId], context.root);
        if (!successful(content)) {
          scan.diagnostics.push(`cannot read ${commit.commit}:${treeEntry.path}: ${failureReason(content)}`);
          continue;
        }
        historyBytes += Buffer.byteLength(content.stdout, "utf8");
        if (historyBytes > scan.contract.maximumHistoryBytes) {
          scan.bounded = true;
          break;
        }
        occurrenceFromProjection(
          content.stdout,
          {
            commit: commit.commit,
            path: display,
            gitPath: treeEntry.path,
            blobId: treeEntry.blobId,
            reachable: true,
          },
          item.artifactId,
          scan.sourceRoot,
          targetIds,
          scan.invalid,
          (occurrence) => addGroup(scan.groups, occurrence),
        );
      }
      if (historyBytes > scan.contract.maximumHistoryBytes) break;
    }
    if (historyBytes > scan.contract.maximumHistoryBytes) break;
  }
}

function collectRewritten(
  scan: ScanResult,
  run: GitCommandRunner,
  context: GitContext,
): void {
  if (!context.root || scan.targets.size === 0) return;
  const reflog = run(
    ["reflog", "show", "--format=%H", "--max-count", String(REFLOG_LIMIT), "HEAD"],
    context.root,
  );
  if (!successful(reflog)) return;
  const reachableCommits = new Set<string>();
  for (const group of scan.groups.values()) {
    for (const occurrences of group.versions.values()) {
      for (const occurrence of occurrences) reachableCommits.add(occurrence.commit);
    }
  }
  const paths = scan.contract.supportedArtifacts.map((artifactId) => ({
    artifactId,
    gitPath: projectGitPath(
      scan.projectRoot,
      context.root as string,
      path.relative(scan.projectRoot, stateCurrentProjectionPath(scan.projectRoot, artifactId, scan.sourceRoot)),
    ),
  }));
  for (const commit of reflog.stdout.split(/\r?\n/).map((value) => value.trim())) {
    if (!/^[0-9a-f]{40,64}$/.test(commit) || reachableCommits.has(commit)) continue;
    for (const item of paths) {
      if (!item.gitPath) continue;
      const tree = run(["ls-tree", "-r", "-z", commit, "--", item.gitPath], context.root);
      const treeEntry = successful(tree) ? parseTreeEntry(tree.stdout) : undefined;
      if (!treeEntry) continue;
      const display = displayPath(scan.projectRoot, context.root, treeEntry.path);
      if (!display) continue;
      const content = run(["cat-file", "-p", treeEntry.blobId], context.root);
      if (!successful(content)) continue;
      occurrenceFromProjection(
        content.stdout,
        {
          commit,
          path: display,
          gitPath: treeEntry.path,
          blobId: treeEntry.blobId,
          reachable: false,
        },
        item.artifactId,
        scan.sourceRoot,
        new Set(scan.targets.keys()),
        new Set(),
        (occurrence) => {
          const values = scan.rewritten.get(occurrence.entryId) ?? [];
          if (!values.some((value) => value.commit === occurrence.commit && value.contentHash === occurrence.contentHash)) {
            values.push(occurrence);
          }
          scan.rewritten.set(occurrence.entryId, values);
        },
      );
    }
  }
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
    targets: targetState.targets,
    groups: new Map(),
    rewritten: new Map(),
    invalid: new Set(),
    diagnostics: [...targetState.diagnostics, ...(context.reason ? [`Git unavailable: ${context.reason}`] : [])],
    projectionHashes: hashes,
  };
  if (context.root && context.before) collectReachable(scan, run, context);
  if (context.root && context.before) collectRewritten(scan, run, context);
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
  let matched = false;
  occurrenceFromProjection(
    content.stdout,
    candidate,
    candidate.artifactId,
    scan.sourceRoot,
    new Set([candidate.entryId]),
    new Set(),
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
  const entries: EntryOutput[] = [];
  for (const group of groups.slice(0, args.limit ?? scan.contract.defaultLimit)) {
    entries.push(buildEntryOutput(scan, group, args, false));
    for (const rewritten of scan.rewritten.get(group.entryId) ?? []) {
      if (group.versions.size === 0) {
        entries.push({
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
  const status: BackfillStatus = !scan.gitRoot
    ? "unavailable"
    : scan.headStatus !== "stable" || scan.bounded || entries.some((entry) => entry.ambiguity_reason !== "none")
      ? "degraded"
      : "complete";
  return buildResponse(scan, "inventory", entries, scan.diagnostics, status);
}

export function previewGitBackfill(
  project: string,
  args: Omit<GitBackfillArgs, "project" | "format" | "dryRun" | "apply" | "force"> = {},
  options: GitBackfillCommandOptions = {},
): GitBackfillResponse {
  const scan = scanBackfill(project, args, options);
  const groups = sortedGroups(scan, args);
  const entries = groups
    .slice(0, args.limit ?? scan.contract.defaultLimit)
    .map((group) => buildEntryOutput(scan, group, args, true));
  const status: BackfillStatus = entries.some((entry) => entry.proposed_archive_bytes !== undefined)
    ? entries.some((entry) => !entry.eligible) || scan.headStatus !== "stable" || scan.bounded
      ? "degraded"
      : "complete"
    : scan.gitRoot
      ? entries.some((entry) => entry.ambiguity_reason !== "none")
        ? "degraded"
        : "blocked"
      : "unavailable";
  return buildResponse(scan, "preview", entries, scan.diagnostics, status);
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
  const candidate = selectedOccurrence(group, args);
  const entry = buildEntryOutput(scan, group, args, true);
  if (!candidate || !entry.eligible) {
    entry.operation = "refused";
    entry.refusal = entry.ambiguity_reason;
    entries.push(entry);
    const response = buildResponse(scan, "apply", entries, scan.diagnostics, "blocked");
    response.active_projections_unchanged = true;
    return response;
  }
  const run = options.runGit ?? defaultGitRunner;
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
