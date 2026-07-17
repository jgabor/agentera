import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  discoverNumberedArchives,
  numberedArchiveContract,
  stateDurabilityContract,
  type ArchiveRejection,
  type NumberedArchiveContract,
  type StateDurabilityContract,
} from "./archiveDiscovery.js";
import { detectStateMode } from "./stateMode.js";
import { canonicalEntityEnvelope, discoverEntities, entityBoundariesForArtifact } from "./entityStorage.js";

const GIT_TIMEOUT_MS = 1_000;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const REFLOG_LIMIT = "32";

export type DurabilityStatus = "complete" | "degraded" | "unavailable";
export type LocalDurabilityStatus = "verified" | "unavailable" | "corrupt";
export type GitDurabilityStatus = "verified" | "degraded" | "unavailable";

export interface DurabilityArgs {
  project?: string | null;
  artifact?: string | null;
  number?: number;
  id?: string | null;
  limit?: number;
  format?: "text" | "json" | "yaml";
}

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  error?: string;
}

export type GitCommandRunner = (args: string[], cwd: string) => GitCommandResult;

export interface DurabilityOptions {
  sourceRoot?: string;
  runGit?: GitCommandRunner;
}

interface Candidate {
  path: string;
  stableId: string;
  artifactId: string;
  entryNumber: number;
  local: LocalDurabilityStatus;
  bytes?: string;
  localMessage?: string;
}

interface GitContext {
  available: boolean;
  reason: string;
  root?: string;
  before?: string;
  beforeReason: string;
  probeIssue?: string;
  shallow: boolean;
  run: GitCommandRunner;
}

interface HeadProbe {
  value?: string;
  reason: string;
}

interface GitEvidence {
  status: GitDurabilityStatus;
  reason: string;
  reachableRecovery: boolean;
}

interface DurabilityEntry {
  stable_id: string;
  artifact_id: string;
  entry_number: number;
  status: DurabilityStatus;
  local: {
    status: LocalDurabilityStatus;
    detail_availability: "full" | "unavailable";
    message?: string;
  };
  git: {
    status: GitDurabilityStatus;
    reason: string;
    reachable_recovery: boolean;
  };
}

interface EntityDurabilityEntry {
  id: string;
  artifact: string;
  status: DurabilityStatus;
  local: DurabilityEntry["local"] & { path?: string };
  git: DurabilityEntry["git"];
  retrieval: { get: string };
}

export interface DurabilityResponse {
  command: string;
  status: DurabilityStatus;
  project: string;
  read_only: true;
  remote_contact: false;
  head: {
    status: "stable" | "changed" | "unavailable";
  };
  counts: {
    discovered: number;
    returned: number;
    local_verified: number;
    local_unavailable: number;
    local_corrupt: number;
    reachable_recovery: number;
  };
  entries: Array<DurabilityEntry | EntityDurabilityEntry>;
  diagnostics: Array<{
    class: string;
    message: string;
    recovery: string;
  }>;
  source_contract: {
    syntax: string;
    status_values: string[];
    local_values: string[];
    git_values: string[];
    read_only: true;
    remote_contact: false;
    writes_independent: true;
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
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    ...((result.error as NodeJS.ErrnoException | undefined)?.code
      ? { error: (result.error as NodeJS.ErrnoException).code }
      : {}),
  };
}

function successful(result: GitCommandResult): boolean {
  return result.status === 0 && !result.timedOut && !result.error;
}

function probeFailure(result: GitCommandResult, fallback: string): string {
  if (result.timedOut) return "git_probe_timeout";
  if (result.error || result.status === null) return "git_probe_error";
  return fallback;
}

function commandOutput(
  run: GitCommandRunner,
  args: string[],
  cwd: string,
): { value?: string; reason: string } {
  const result = run(args, cwd);
  if (successful(result) && result.stdout.trim()) return { value: result.stdout.trim(), reason: "available" };
  return { reason: probeFailure(result, "git_probe_error") };
}

function hasGitMetadata(projectRoot: string): boolean {
  let current = path.resolve(projectRoot);
  for (;;) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readHead(run: GitCommandRunner, root: string): HeadProbe {
  const result = run(["rev-parse", "--verify", "HEAD^{commit}"], root);
  if (successful(result) && result.stdout.trim()) return { value: result.stdout.trim(), reason: "stable" };
  return { reason: probeFailure(result, "missing_commit") };
}

function gitContext(projectRoot: string, run: GitCommandRunner): GitContext {
  if (!hasGitMetadata(projectRoot)) {
    return { available: false, reason: "non_git", beforeReason: "non_git", shallow: false, run };
  }
  const inside = commandOutput(run, ["rev-parse", "--is-inside-work-tree"], projectRoot);
  if (!inside.value || inside.value !== "true") {
    const reason = inside.value ? "git_unavailable" : inside.reason;
    return {
      available: false,
      reason,
      beforeReason: reason,
      shallow: false,
      run,
    };
  }
  const rootValue = commandOutput(run, ["rev-parse", "--show-toplevel"], projectRoot);
  if (!rootValue.value) {
    return {
      available: false,
      reason: rootValue.reason,
      beforeReason: rootValue.reason,
      shallow: false,
      run,
    };
  }
  const root = resolvePath(rootValue.value);
  const beforeProbe = readHead(run, root);
  const shallowProbe = commandOutput(run, ["rev-parse", "--is-shallow-repository"], root);
  const probeIssue = shallowProbe.reason === "available" ? undefined : shallowProbe.reason;
  return {
    available: true,
    reason: beforeProbe.value ? "available" : beforeProbe.reason,
    root,
    ...(beforeProbe.value ? { before: beforeProbe.value } : {}),
    beforeReason: beforeProbe.reason,
    ...(probeIssue ? { probeIssue } : {}),
    shallow: shallowProbe.value === "true",
    run,
  };
}

function gitRelativePath(target: string, root: string): string | undefined {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function statusForPath(context: GitContext, relative: string): string | undefined {
  if (!context.root) return undefined;
  const result = context.run(
    ["status", "--porcelain=v1", "--untracked-files=all", "--", relative],
    context.root,
  );
  return successful(result) ? result.stdout.trim() : undefined;
}

function blobAtHead(context: GitContext, relative: string, head: string): string | undefined {
  if (!context.root) return undefined;
  const result = context.run(["cat-file", "-p", `${head}:${relative}`], context.root);
  return successful(result) ? result.stdout : undefined;
}

function historyWasRewritten(
  context: GitContext,
  relative: string,
  bytes: string,
  head: string,
): boolean {
  if (!context.root) return false;
  const reflog = context.run(
    ["reflog", "show", `--format=%H%x09%gs`, "--max-count", REFLOG_LIMIT, "HEAD"],
    context.root,
  );
  if (!successful(reflog)) return false;
  for (const line of reflog.stdout.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40})\t/.exec(line);
    if (!match || match[1] === head) continue;
    const prior = blobAtHead(context, relative, match[1]);
    if (prior !== bytes) continue;
    const ancestor = context.run(["merge-base", "--is-ancestor", match[1], head], context.root);
    if (ancestor.status === 1 && !ancestor.timedOut) return true;
  }
  return false;
}

function archiveTarget(
  projectRoot: string,
  contract: NumberedArchiveContract,
  artifactId: string,
  entryNumber: number,
): string {
  return path.resolve(
    projectRoot,
    contract.archiveRoot,
    artifactId,
    `${entryNumber}${contract.archiveExtension}`,
  );
}

function selectedCandidate(
  projectRoot: string,
  contract: NumberedArchiveContract,
  artifactId: string,
  entryNumber: number,
  discovery: ReturnType<typeof discoverNumberedArchives>,
): Candidate {
  const target = archiveTarget(projectRoot, contract, artifactId, entryNumber);
  const entry = discovery.entries.find((candidate) => candidate.path === target);
  if (entry) {
    try {
      return {
        path: target,
        stableId: entry.stableId,
        artifactId,
        entryNumber,
        local: "verified",
        bytes: fs.readFileSync(target, "utf8"),
      };
    } catch (error) {
      return {
        path: target,
        stableId: `${artifactId}:${entryNumber}`,
        artifactId,
        entryNumber,
        local: "corrupt",
        localMessage: `cannot read validated archive: ${(error as Error).message}`,
      };
    }
  }
  const rejection = discovery.rejected.find((candidate) => path.resolve(candidate.path) === target);
  if (rejection) {
    return {
      path: target,
      stableId: `${artifactId}:${entryNumber}`,
      artifactId,
      entryNumber,
      local: "corrupt",
      localMessage: rejection.message,
    };
  }
  return {
    path: target,
    stableId: `${artifactId}:${entryNumber}`,
    artifactId,
    entryNumber,
    local: "unavailable",
  };
}

function diagnosticsFor(
  candidate: Candidate,
  git: GitEvidence,
): Array<{ class: string; message: string; recovery: string }> {
  const diagnostics: Array<{ class: string; message: string; recovery: string }> = [];
  if (candidate.local === "unavailable") {
    diagnostics.push({
      class: "local_recovery_unavailable",
      message: `${candidate.stableId} has no validated local archive record`,
      recovery: "Restore or publish the numbered archive locally; committed recovery is reported separately.",
    });
  } else if (candidate.local === "corrupt") {
    diagnostics.push({
      class: "local_archive_corrupt",
      message: candidate.localMessage ?? `${candidate.stableId} is not a valid local archive record`,
      recovery: "Preserve the archive bytes, repair the numbered record, and rerun the read-only check.",
    });
  }
  if (git.status !== "verified") {
    diagnostics.push({
      class: git.reason,
      message: `${candidate.stableId} has no verified committed recovery (${git.reason})`,
      recovery: "Treat local archive evidence as authoritative and do not require Git for state writes.",
    });
  }
  return diagnostics;
}

function entryStatus(local: LocalDurabilityStatus, git: GitEvidence): DurabilityStatus {
  if (local === "verified" && (git.status === "verified" || git.reason === "non_git")) return "complete";
  if (local === "unavailable" && git.status === "unavailable") return "unavailable";
  if (local === "corrupt" && git.status === "unavailable") return "unavailable";
  return "degraded";
}

function buildGitEvidence(
  candidate: Candidate,
  context: GitContext,
  afterHead: string | undefined,
  headChanged: boolean,
): GitEvidence {
  if (!context.available) {
    return { status: "unavailable", reason: context.reason, reachableRecovery: false };
  }
  if (context.probeIssue) {
    return { status: "unavailable", reason: context.probeIssue, reachableRecovery: false };
  }
  if (!context.before || !afterHead) {
    return { status: "unavailable", reason: context.beforeReason, reachableRecovery: false };
  }
  if (headChanged) return { status: "degraded", reason: "changed_head", reachableRecovery: false };
  const relative = context.root ? gitRelativePath(candidate.path, context.root) : undefined;
  if (!relative) return { status: "unavailable", reason: "project_boundary", reachableRecovery: false };
  const workingTreeStatus = statusForPath(context, relative);
  if (workingTreeStatus === undefined) {
    return { status: "unavailable", reason: "git_unavailable", reachableRecovery: false };
  }
  const committedBytes = blobAtHead(context, relative, context.before);
  const reachable = committedBytes !== undefined;
  if (candidate.local !== "unavailable" && candidate.bytes !== undefined && committedBytes === candidate.bytes) {
    if (workingTreeStatus !== "") {
      return { status: "degraded", reason: "dirty_archive", reachableRecovery: true };
    }
    if (context.shallow) return { status: "degraded", reason: "shallow_history", reachableRecovery: true };
    return { status: "verified", reason: "reachable_head", reachableRecovery: true };
  }
  if (candidate.local === "unavailable" && reachable) {
    return { status: "verified", reason: "reachable_head", reachableRecovery: true };
  }
  if (
    candidate.bytes !== undefined &&
    historyWasRewritten(context, relative, candidate.bytes, context.before)
  ) {
    return { status: "degraded", reason: "history_rewritten", reachableRecovery: false };
  }
  if (context.shallow) return { status: "degraded", reason: "shallow_history", reachableRecovery: reachable };
  if (workingTreeStatus !== "") return { status: "degraded", reason: "dirty_archive", reachableRecovery: reachable };
  return { status: "unavailable", reason: reachable ? "committed_content_mismatch" : "not_committed", reachableRecovery: reachable };
}

function orderedCandidates(
  projectRoot: string,
  contract: NumberedArchiveContract,
  artifact: string | null | undefined,
  number: number | undefined,
  limit: number,
  sourceRoot: string,
): { candidates: Candidate[]; rejected: ArchiveRejection[]; discovered: number } {
  const discovery = discoverNumberedArchives(projectRoot, { sourceRoot, artifactId: artifact ?? undefined });
  if (artifact && number !== undefined) {
    return { candidates: [selectedCandidate(projectRoot, contract, artifact, number, discovery)], rejected: [], discovered: 1 };
  }
  const candidates = discovery.entries
    .filter((entry) => !artifact || entry.artifactId === artifact)
    .map((entry) => {
      try {
        return {
          path: entry.path,
          stableId: entry.stableId,
          artifactId: entry.artifactId,
          entryNumber: entry.entryNumber,
          local: "verified" as const,
          bytes: fs.readFileSync(entry.path, "utf8"),
        };
      } catch (error) {
        return {
          path: entry.path,
          stableId: entry.stableId,
          artifactId: entry.artifactId,
          entryNumber: entry.entryNumber,
          local: "corrupt" as const,
          localMessage: `cannot read validated archive: ${(error as Error).message}`,
        };
      }
    });
  candidates.sort((a, b) => a.artifactId.localeCompare(b.artifactId) || b.entryNumber - a.entryNumber);
  return {
    candidates: candidates.slice(0, limit),
    rejected: discovery.rejected,
    discovered: candidates.length,
  };
}

function inspectEntityDurability(
  projectRoot: string,
  artifact: string,
  id: string,
  contract: StateDurabilityContract,
  run: GitCommandRunner,
  sourceRoot: string,
): DurabilityResponse {
  const entityCommand = "agentera check durability --project PATH --artifact ARTIFACT --id ID --format json";
  const git = gitContext(projectRoot, run);
  const discovery = discoverEntities(projectRoot, sourceRoot);
  const boundaries = entityBoundariesForArtifact(artifact, sourceRoot);
  const relativeTargets = boundaries.map((boundary) => `.agentera/entities/${artifact}/${boundary}/${id}.yaml`);
  const targetPaths = new Set(relativeTargets.map((relative) => path.join(projectRoot, ...relative.split("/"))));
  const matches = discovery.entities.filter((entity) => targetPaths.has(entity.path));
  const canonical = matches.length === 1 && matches[0].classification === "valid" ? matches[0] : undefined;
  let local: LocalDurabilityStatus = canonical ? "verified" : matches.length ? "corrupt" : "unavailable";
  let bytes: string | undefined;
  let localMessage: string | undefined;
  if (canonical) {
    try { bytes = fs.readFileSync(canonical.path, "utf8"); }
    catch (error) { local = "corrupt"; localMessage = `cannot read canonical entity: ${(error as Error).message}`; }
  } else if (matches.length > 1) localMessage = `entity ID '${id}' has conflicting ownership for artifact '${artifact}'`;
  else if (matches.length === 1) localMessage = `entity '${matches[0].relativePath}' is not canonical`;
  let committedPath: string | undefined;
  let committedFailure: string | undefined;
  if (git.available && git.root && git.before) {
    const projectPrefix = path.relative(git.root, projectRoot).split(path.sep).join("/");
    const valid: string[] = [];
    let invalid = 0;
    for (let index = 0; index < relativeTargets.length; index += 1) {
      const relative = `${projectPrefix ? `${projectPrefix}/` : ""}${relativeTargets[index]}`;
      const committed = blobAtHead(git, relative, git.before);
      if (committed === undefined) continue;
      try { canonicalEntityEnvelope(committed, { artifact, boundary: boundaries[index], id }, sourceRoot); valid.push(relative); }
      catch { invalid += 1; }
    }
    if (valid.length === 1 && invalid === 0) committedPath = path.join(git.root, ...valid[0].split("/"));
    else if (valid.length > 1) committedFailure = "committed_entity_conflict";
    else if (invalid > 0) committedFailure = "committed_entity_invalid";
  }
  const target = canonical?.path ?? matches[0]?.path ?? committedPath ?? [...targetPaths][0] ?? path.join(projectRoot, ".agentera", "entities", artifact, `${id}.yaml`);
  const candidate: Candidate = { path: target, stableId: id, artifactId: artifact, entryNumber: 0, local, ...(bytes !== undefined ? { bytes } : {}), ...(localMessage ? { localMessage } : {}) };
  let evidence = committedFailure
    ? { status: "unavailable" as const, reason: committedFailure, reachableRecovery: false }
    : buildGitEvidence(candidate, git, git.before, false);
  const ending = git.available && git.root ? readHead(run, git.root) : undefined;
  const after = ending?.value;
  const changed = Boolean(git.before && after && git.before !== after);
  if (git.available && git.before && !after) evidence = { status: "degraded", reason: "final_head_unavailable", reachableRecovery: false };
  else if (changed) evidence = { status: "degraded", reason: "changed_head", reachableRecovery: false };
  const status = entryStatus(local, evidence);
  const get = artifact === "plan" ? `agentera state plan get --id ${id} --format json` : `agentera state ${artifact} get --id ${id} --format json`;
  const diagnostics: DurabilityResponse["diagnostics"] = [];
  if (local !== "verified") diagnostics.push({ class: local === "corrupt" ? "canonical_entity_corrupt" : "canonical_entity_missing", message: localMessage ?? `canonical ${artifact} entity '${id}' was not found`, recovery: `Run agentera check validate state, then recover exact detail with '${get}'; no state was changed.` });
  if (evidence.status !== "verified") diagnostics.push({ class: evidence.reason, message: `${artifact} entity '${id}' has no verified committed recovery (${evidence.reason})`, recovery: `Use '${get}' for local recovery and do not require Git for state writes.` });
  return {
    command: entityCommand,
    status,
    project: projectRoot,
    read_only: true,
    remote_contact: false,
    head: { status: !git.available || !git.before || !after ? "unavailable" : changed ? "changed" : "stable" },
    counts: { discovered: matches.length, returned: 1, local_verified: local === "verified" ? 1 : 0, local_unavailable: local === "unavailable" ? 1 : 0, local_corrupt: local === "corrupt" ? 1 : 0, reachable_recovery: evidence.reachableRecovery ? 1 : 0 },
    entries: [{ id, artifact, status, local: { status: local, detail_availability: local === "verified" ? "full" : "unavailable", path: path.relative(projectRoot, target).split(path.sep).join("/"), ...(localMessage ? { message: localMessage } : {}) }, git: { status: evidence.status, reason: evidence.reason, reachable_recovery: evidence.reachableRecovery }, retrieval: { get } }],
    diagnostics: diagnostics.sort((a, b) => a.class.localeCompare(b.class)),
    source_contract: { syntax: entityCommand, status_values: contract.statusValues, local_values: contract.localValues, git_values: contract.gitValues, read_only: true, remote_contact: false, writes_independent: true },
  };
}

export function inspectDurability(
  project: string,
  args: Omit<DurabilityArgs, "project" | "format"> = {},
  options: DurabilityOptions = {},
): DurabilityResponse {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = stateDurabilityContract(sourceRoot);
  const projectRoot = resolvePath(project);
  const run = options.runGit ?? defaultGitRunner;
  if (detectStateMode(projectRoot, sourceRoot) === "entities") {
    if (!args.artifact || !args.id) throw new Error("entity-mode durability requires --artifact ARTIFACT --id ID");
    return inspectEntityDurability(projectRoot, args.artifact, args.id, contract, run, sourceRoot);
  }
  const git = gitContext(projectRoot, run);
  const artifact = args.artifact ?? null;
  const number = args.number;
  const limit = args.limit ?? contract.defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > contract.maximumLimit) {
    throw new Error(`durability limit must be between 1 and ${contract.maximumLimit}`);
  }
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) {
    throw new Error("durability number must be a positive integer");
  }
  const archiveContract = artifact
    ? numberedArchiveContract(artifact, sourceRoot)
    : undefined;
  const fallbackContract = archiveContract ?? numberedArchiveContract("progress", sourceRoot);
  const selected = orderedCandidates(projectRoot, fallbackContract, artifact, number, limit, sourceRoot);
  const entries: DurabilityEntry[] = [];
  const diagnostics: DurabilityResponse["diagnostics"] = [];
  for (const candidate of selected.candidates) {
    const evidence = buildGitEvidence(candidate, git, git.before, false);
    const status = entryStatus(candidate.local, evidence);
    entries.push({
      stable_id: candidate.stableId,
      artifact_id: candidate.artifactId,
      entry_number: candidate.entryNumber,
      status,
      local: {
        status: candidate.local,
        detail_availability: candidate.local === "verified" ? "full" : "unavailable",
        ...(candidate.localMessage ? { message: candidate.localMessage } : {}),
      },
      git: {
        status: evidence.status,
        reason: evidence.reason,
        reachable_recovery: evidence.reachableRecovery,
      },
    });
    diagnostics.push(...diagnosticsFor(candidate, evidence));
  }
  const ending = git.available && git.root ? readHead(run, git.root) : undefined;
  const after = ending?.value;
  const headChanged = Boolean(git.before && after && git.before !== after);
  const finalHeadUnavailable = Boolean(git.available && git.before && !after);
  if (finalHeadUnavailable) {
    for (const entry of entries) {
      entry.status = "degraded";
      entry.git = { status: "degraded", reason: "final_head_unavailable", reachable_recovery: false };
    }
    diagnostics.push({
      class: "final_head_unavailable",
      message: "repository HEAD could not be captured after the read-only durability check",
      recovery: "Retry the diagnostic after repository activity stops; no committed recovery was claimed.",
    });
  }
  if (headChanged && !finalHeadUnavailable) {
    for (const entry of entries) {
      entry.status = "degraded";
      entry.git = { status: "degraded", reason: "changed_head", reachable_recovery: false };
    }
    diagnostics.push({
      class: "changed_head",
      message: "repository HEAD changed during the read-only durability check",
      recovery: "Retry the diagnostic after repository activity stops; no state was changed.",
    });
  }
  if (selected.candidates.length === 0) {
    diagnostics.push({
      class: "local_recovery_unavailable",
      message: "no numbered archive records matched the durability selection",
      recovery: "Publish or restore a validated numbered archive, then rerun the check.",
    });
  }
  for (const rejection of selected.rejected) {
    if (!artifact || rejection.path.includes(`${path.sep}${artifact}${path.sep}`)) {
      diagnostics.push({
        class: rejection.reason,
        message: rejection.message,
        recovery: "Preserve the bytes, repair the affected archive record, and rerun the read-only check.",
      });
    }
  }
  diagnostics.sort((a, b) => a.class.localeCompare(b.class) || a.message.localeCompare(b.message));
  const localVerified = entries.filter((entry) => entry.local.status === "verified").length;
  const localUnavailable = entries.filter((entry) => entry.local.status === "unavailable").length;
  const localCorrupt = entries.filter((entry) => entry.local.status === "corrupt").length;
  const reachableRecovery = entries.filter((entry) => entry.git.reachable_recovery).length;
  const statuses = entries.map((entry) => entry.status);
  let status: DurabilityStatus;
  if (entries.length === 0 || statuses.every((value) => value === "unavailable")) status = "unavailable";
  else if (statuses.some((value) => value === "degraded" || value === "unavailable")) status = "degraded";
  else status = "complete";
  const headStatus: DurabilityResponse["head"]["status"] = !git.available || !git.before || !after
    ? "unavailable"
    : headChanged
      ? "changed"
      : "stable";
  return {
    command: contract.command,
    status,
    project: projectRoot,
    read_only: true,
    remote_contact: false,
    head: { status: headStatus },
    counts: {
      discovered: selected.discovered,
      returned: entries.length,
      local_verified: localVerified,
      local_unavailable: localUnavailable,
      local_corrupt: localCorrupt,
      reachable_recovery: reachableRecovery,
    },
    entries,
    diagnostics,
    source_contract: {
      syntax: contract.command,
      status_values: contract.statusValues,
      local_values: contract.localValues,
      git_values: contract.gitValues,
      read_only: true,
      remote_contact: false,
      writes_independent: true,
    },
  };
}

export function renderDurabilityText(response: DurabilityResponse, out: (text: string) => void): void {
  out(`status=${response.status} | project=${response.project} | head=${response.head.status}\n`);
  out(
    `counts=discovered:${response.counts.discovered} returned:${response.counts.returned} ` +
      `local_verified:${response.counts.local_verified} local_unavailable:${response.counts.local_unavailable} ` +
      `local_corrupt:${response.counts.local_corrupt} reachable_recovery:${response.counts.reachable_recovery}\n`,
  );
  for (const entry of response.entries) {
    const identity = "id" in entry ? `${entry.artifact}:${entry.id}` : entry.stable_id;
    out(
      `- ${identity} | status=${entry.status} | local=${entry.local.status} ` +
        `| git=${entry.git.status} | reason=${entry.git.reason} | ` +
        `reachable_recovery=${entry.git.reachable_recovery}\n`,
    );
  }
  for (const diagnostic of response.diagnostics) {
    out(`diagnostic=${diagnostic.class} | ${diagnostic.message}\n`);
  }
}

export function durabilityAuthority(sourceRoot?: string): StateDurabilityContract {
  return stateDurabilityContract(sourceRoot);
}
