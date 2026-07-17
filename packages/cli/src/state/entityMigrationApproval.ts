import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalRecordJson } from "./archiveDiscovery.js";
import { validateRealProjectRoot } from "./projectRoot.js";

const SCHEMA_VERSION = "agentera.entityMigrationApproval.v1";
const SHA256 = /^[a-f0-9]{64}$/;

interface TrackedPath {
  path: string;
  type: "file" | "symlink";
  mode: number;
  sha256: string;
  symlink_target?: string;
}

export interface EntityMigrationApproval {
  schemaVersion: typeof SCHEMA_VERSION;
  project: string;
  head: { commit: string; ref: string | null };
  clean_porcelain: true;
  source_fingerprint: string;
  preview_digest: string;
  git_index_sha256: string;
  tracked_manifest_sha256: string;
  tracked: TrackedPath[];
  ignored_directory_prefixes: string[];
  ignored_paths: string[];
  untracked_baseline: string[];
}

export class EntityMigrationApprovalError extends Error {
  readonly classification = "approval_mismatch";
  constructor(message: string) {
    super(message);
    this.name = "EntityMigrationApprovalError";
  }
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !value.includes("\\") && !path.isAbsolute(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function gitDirectory(project: string): string | null {
  const marker = path.join(project, ".git");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(marker); } catch { return null; }
  if (stat.isSymbolicLink()) throw new EntityMigrationApprovalError("project .git marker must not be a symbolic link");
  if (stat.isDirectory()) return fs.realpathSync(marker);
  if (!stat.isFile()) throw new EntityMigrationApprovalError("project .git marker must be a directory or gitfile");
  const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(marker, "utf8"));
  if (!match) throw new EntityMigrationApprovalError("project gitfile is malformed");
  const candidate = path.resolve(project, match[1]);
  const resolved = fs.realpathSync(candidate);
  if (!fs.statSync(resolved).isDirectory()) throw new EntityMigrationApprovalError("project gitfile does not resolve to a directory");
  return resolved;
}

function currentHead(gitDir: string): { commit: string; ref: string | null } {
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  if (/^[a-f0-9]{40}$/.test(head)) return { commit: head, ref: null };
  const match = /^ref: (refs\/.+)$/.exec(head);
  if (!match || !safeRelative(match[1])) throw new EntityMigrationApprovalError("Git HEAD is malformed");
  const ref = match[1];
  let commit: string | undefined;
  try { commit = fs.readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim(); } catch { /* packed ref fallback */ }
  if (!commit) {
    try {
      const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
      commit = packed.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`))?.split(" ")[0];
    } catch { /* reported below */ }
  }
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new EntityMigrationApprovalError(`Git HEAD ref '${ref}' cannot be resolved directly`);
  return { commit, ref };
}

function indexHash(gitDir: string): string {
  const index = path.join(gitDir, "index");
  const stat = fs.lstatSync(index);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EntityMigrationApprovalError("Git index must be a regular file");
  return hash(fs.readFileSync(index));
}

function trackedPath(project: string, relative: string): TrackedPath {
  if (!safeRelative(relative) || relative === ".git" || relative.startsWith(".git/")) throw new EntityMigrationApprovalError(`tracked path '${relative}' is outside the approval boundary`);
  const absolute = path.join(project, ...relative.split("/"));
  const stat = fs.lstatSync(absolute);
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    return { path: relative, type: "symlink", mode, sha256: hash(target), symlink_target: target };
  }
  if (!stat.isFile()) throw new EntityMigrationApprovalError(`tracked path '${relative}' must be a regular file or symbolic link`);
  return { path: relative, type: "file", mode, sha256: hash(fs.readFileSync(absolute)) };
}

function runGit(project: string, args: string[]): Buffer {
  const result = spawnSync("git", args, { cwd: project, encoding: null, shell: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new EntityMigrationApprovalError(`Git approval inspection failed: ${result.error?.message ?? String(result.stderr)}`);
  return result.stdout;
}

function zeroSeparated(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

/** Maintainer-only approval generation. Apply validation never calls Git. */
export function generateEntityMigrationApproval(projectRoot: string, sourceFingerprint: string, previewDigest: string): EntityMigrationApproval {
  const project = validateRealProjectRoot(projectRoot).path;
  if (!SHA256.test(sourceFingerprint) || !SHA256.test(previewDigest)) throw new EntityMigrationApprovalError("source fingerprint and preview digest must be lowercase SHA-256 values");
  const gitDir = gitDirectory(project);
  if (!gitDir) throw new EntityMigrationApprovalError("approval generation requires a Git checkout");
  const porcelain = runGit(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (porcelain.length !== 0) throw new EntityMigrationApprovalError("approval generation requires a clean Git checkout with an empty porcelain status");
  const tracked = zeroSeparated(runGit(project, ["ls-files", "-z"])).sort().map((relative) => trackedPath(project, relative));
  const ignored = zeroSeparated(runGit(project, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"]));
  const ignoredValues = ignored.map((entry) => {
    if (!entry.startsWith("!! ")) throw new EntityMigrationApprovalError(`unexpected porcelain entry while collecting ignored paths: '${entry}'`);
    return entry.slice(3);
  });
  const ignoredDirectoryPrefixes = ignoredValues.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)).filter(safeRelative).sort();
  const ignoredPaths = ignoredValues.filter((entry) => !entry.endsWith("/")).filter(safeRelative).sort();
  return {
    schemaVersion: SCHEMA_VERSION,
    project,
    head: currentHead(gitDir),
    clean_porcelain: true,
    source_fingerprint: sourceFingerprint,
    preview_digest: previewDigest,
    git_index_sha256: indexHash(gitDir),
    tracked_manifest_sha256: hash(canonicalRecordJson(tracked)),
    tracked,
    ignored_directory_prefixes: ignoredDirectoryPrefixes,
    ignored_paths: ignoredPaths,
    untracked_baseline: [],
  };
}

function readApproval(file: string): EntityMigrationApproval {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EntityMigrationApprovalError("approval file must be a pinned regular file, not a symbolic link");
  const value = JSON.parse(fs.readFileSync(absolute, "utf8")) as EntityMigrationApproval;
  if (value.schemaVersion !== SCHEMA_VERSION || value.clean_porcelain !== true || !Array.isArray(value.tracked)
    || !Array.isArray(value.ignored_directory_prefixes) || !Array.isArray(value.ignored_paths) || !Array.isArray(value.untracked_baseline)) {
    throw new EntityMigrationApprovalError("approval file does not satisfy agentera.entityMigrationApproval.v1");
  }
  return value;
}

function inventoryWorktree(project: string, ignoredDirectories: Set<string>): string[] {
  const result: string[] = [];
  const visit = (directory: string, relativeRoot: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (relative === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!ignoredDirectories.has(relative)) visit(absolute, relative);
      } else result.push(relative);
    }
  };
  visit(project, "");
  return result;
}

export function assertEntityMigrationApproval(projectRoot: string, approvalFile: string, sourceFingerprint: string, previewDigest: string, writerLockHeld = false): EntityMigrationApproval {
  const project = validateRealProjectRoot(projectRoot).path;
  const approvalPath = path.resolve(approvalFile);
  if (approvalPath === project || approvalPath.startsWith(`${project}${path.sep}`)) throw new EntityMigrationApprovalError("approval file must be outside the project mutation set");
  const approval = readApproval(approvalPath);
  const gitDir = gitDirectory(project);
  if (!gitDir) throw new EntityMigrationApprovalError("this project is not a Git checkout and does not accept a Git approval envelope");
  if (approval.project !== project) throw new EntityMigrationApprovalError(`approval root '${approval.project}' does not match project '${project}'`);
  if (approval.source_fingerprint !== sourceFingerprint || approval.preview_digest !== previewDigest) throw new EntityMigrationApprovalError("approval source fingerprint or preview digest does not match the requested migration");
  const head = currentHead(gitDir);
  if (canonicalRecordJson(head) !== canonicalRecordJson(approval.head)) throw new EntityMigrationApprovalError("Git HEAD/ref changed after migration approval");
  if (indexHash(gitDir) !== approval.git_index_sha256) throw new EntityMigrationApprovalError("Git index changed after migration approval");
  const tracked = approval.tracked.map((expected) => {
    if (!safeRelative(expected.path) || !SHA256.test(expected.sha256) || !Number.isInteger(expected.mode)) throw new EntityMigrationApprovalError(`approval tracked entry '${expected.path}' is malformed`);
    let observed: TrackedPath;
    try { observed = trackedPath(project, expected.path); } catch { throw new EntityMigrationApprovalError(`approved tracked path '${expected.path}' is missing or unsafe`); }
    if (canonicalRecordJson(observed) !== canonicalRecordJson(expected)) throw new EntityMigrationApprovalError(`approved tracked path '${expected.path}' changed in bytes, type, mode, or symlink target`);
    return observed;
  });
  if (!SHA256.test(approval.tracked_manifest_sha256) || hash(canonicalRecordJson(tracked)) !== approval.tracked_manifest_sha256) throw new EntityMigrationApprovalError("approved tracked-worktree manifest digest is invalid");
  for (const value of [...approval.ignored_directory_prefixes, ...approval.ignored_paths, ...approval.untracked_baseline]) if (!safeRelative(value)) throw new EntityMigrationApprovalError(`approval inventory path '${value}' is unsafe`);
  const allowed = new Set([...tracked.map((entry) => entry.path), ...approval.ignored_paths, ...approval.untracked_baseline]);
  const ignoredDirectories = new Set(approval.ignored_directory_prefixes);
  if (writerLockHeld) ignoredDirectories.add(".agentera/.writer.lock");
  const extras = inventoryWorktree(project, ignoredDirectories).filter((relative) => !allowed.has(relative));
  if (extras.length) throw new EntityMigrationApprovalError(`worktree has unapproved non-ignored path '${extras[0]}'`);
  return approval;
}

export function projectIsGitCheckout(projectRoot: string): boolean {
  return gitDirectory(validateRealProjectRoot(projectRoot).path) !== null;
}
