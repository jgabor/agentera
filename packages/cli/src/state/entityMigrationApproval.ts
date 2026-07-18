import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { canonicalRecordJson } from "./archiveDiscovery.js";
import {
  inspectEntityMigrationPreparation,
  type EntityMigrationPreparationInspection,
  EntityMigrationPreparationInspectionError,
} from "./entityMigrationPreparation.js";
import type { DurableEntityMigrationPlan } from "./entityMigrationPreview.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { inspectRolledBackEntityMigrationEvidence, type RolledBackEntityMigrationEvidenceInspection } from "./entityMigrationApply.js";

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
  transient_preparation?: {
    relative_path: string;
    operation_id: string;
    directory: { dev: string; ino: string };
    receipt_count: number;
    inventory_sha256: string;
    expected_classification: "stale" | "same_operation";
  };
  prior_rolled_back_operations?: RolledBackEntityMigrationEvidenceInspection[];
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

interface GitLayout { gitDir: string; commonDir: string }

function regularMetadata(file: string, label: string): Buffer {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) { throw new EntityMigrationApprovalError(`${label} is missing or unreadable: ${(error as Error).message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EntityMigrationApprovalError(`${label} must be a regular file and must not be a symbolic link`);
  try { return fs.readFileSync(file); } catch (error) { throw new EntityMigrationApprovalError(`${label} is unreadable: ${(error as Error).message}`); }
}

function gitLayout(project: string): GitLayout | null {
  const marker = path.join(project, ".git");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(marker); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new EntityMigrationApprovalError(`project .git marker is unreadable: ${(error as Error).message}`);
  }
  if (stat.isSymbolicLink()) throw new EntityMigrationApprovalError("project .git marker must not be a symbolic link");
  if (stat.isDirectory()) { const gitDir = fs.realpathSync(marker); return { gitDir, commonDir: gitDir }; }
  if (!stat.isFile()) throw new EntityMigrationApprovalError("project .git marker must be a directory or gitfile");
  const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/.exec(regularMetadata(marker, "project gitfile").toString("utf8"));
  if (!match) throw new EntityMigrationApprovalError("project gitfile is malformed");
  const candidate = path.resolve(project, match[1]);
  let gitDir: string;
  try { gitDir = fs.realpathSync(candidate); } catch (error) { throw new EntityMigrationApprovalError(`project gitfile target is missing or unsafe: ${(error as Error).message}`); }
  if (gitDir !== candidate) throw new EntityMigrationApprovalError("project gitfile target traverses a symbolic link and is unsafe for approval");
  if (!fs.statSync(gitDir).isDirectory()) throw new EntityMigrationApprovalError("project gitfile does not resolve to a directory");
  const commonFile = path.join(gitDir, "commondir");
  let commonStat: fs.Stats;
  try { commonStat = fs.lstatSync(commonFile); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { gitDir, commonDir: gitDir };
    throw new EntityMigrationApprovalError(`Git commondir is unreadable: ${(error as Error).message}`);
  }
  if (!commonStat.isFile() || commonStat.isSymbolicLink()) throw new EntityMigrationApprovalError("Git commondir must be a regular file and must not be a symbolic link");
  const relative = fs.readFileSync(commonFile, "utf8").replace(/\r?\n$/, "");
  if (!relative || relative.includes("\0") || relative.includes("\n") || path.isAbsolute(relative)) throw new EntityMigrationApprovalError("Git commondir is malformed; standard relative commondir metadata is required");
  let commonDir: string;
  try { commonDir = fs.realpathSync(path.resolve(gitDir, relative)); } catch (error) { throw new EntityMigrationApprovalError(`Git commondir target is missing or unsafe: ${(error as Error).message}`); }
  const expected = fs.realpathSync(path.dirname(path.dirname(gitDir)));
  if (commonDir !== expected) throw new EntityMigrationApprovalError(`Git commondir escapes the standard linked-worktree layout: '${relative}'`);
  if (!fs.statSync(commonDir).isDirectory()) throw new EntityMigrationApprovalError("Git commondir does not resolve to a directory");
  return { gitDir, commonDir };
}

function packedRef(directory: string, ref: string): string | undefined {
  const file = path.join(directory, "packed-refs");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new EntityMigrationApprovalError(`Git packed-refs is unreadable: ${(error as Error).message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EntityMigrationApprovalError("Git packed-refs must be a regular file and must not be a symbolic link");
  let found: string | undefined;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const match = /^([a-f0-9]{40}) (refs\/[\x21-\x7e]+)$/.exec(line);
    if (!match || !safeRelative(match[2])) throw new EntityMigrationApprovalError("Git packed-refs is malformed; only the standard files format is supported");
    if (match[2] === ref) found = match[1];
  }
  return found;
}

function looseRef(directory: string, ref: string): string | undefined {
  const file = path.join(directory, ...ref.split("/"));
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new EntityMigrationApprovalError(`Git loose ref '${ref}' is unreadable: ${(error as Error).message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EntityMigrationApprovalError(`Git loose ref '${ref}' must be a regular file and must not be a symbolic link`);
  if (fs.realpathSync(file) !== file) throw new EntityMigrationApprovalError(`Git loose ref '${ref}' traverses a symbolic link and is unsafe for approval`);
  const commit = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new EntityMigrationApprovalError(`Git loose ref '${ref}' is malformed`);
  return commit;
}

function currentHead(layout: GitLayout): { commit: string; ref: string | null } {
  const head = regularMetadata(path.join(layout.gitDir, "HEAD"), "Git HEAD").toString("utf8").trim();
  if (/^[a-f0-9]{40}$/.test(head)) return { commit: head, ref: null };
  const match = /^ref: (refs\/.+)$/.exec(head);
  if (!match || !safeRelative(match[1])) throw new EntityMigrationApprovalError("Git HEAD is malformed");
  const ref = match[1];
  const directories = layout.gitDir === layout.commonDir ? [layout.gitDir] : [layout.gitDir, layout.commonDir];
  let commit: string | undefined;
  for (const directory of directories) {
    commit = looseRef(directory, ref) ?? packedRef(directory, ref);
    if (commit) break;
  }
  if (!commit) throw new EntityMigrationApprovalError(`Git HEAD ref '${ref}' cannot be resolved from standard loose refs or packed-refs; unsupported ref storage requires a different approval checkout`);
  return { commit, ref };
}

function indexHash(gitDir: string): string {
  const index = path.join(gitDir, "index");
  return hash(regularMetadata(index, "Git index"));
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
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const result = spawnSync("git", args, { cwd: project, encoding: null, shell: false, maxBuffer: 64 * 1024 * 1024, env });
  if (result.error || result.status !== 0) throw new EntityMigrationApprovalError(`Git approval inspection failed: ${result.error?.message ?? String(result.stderr)}`);
  return result.stdout;
}

function zeroSeparated(bytes: Buffer): string[] {
  return bytes.toString("utf8").split("\0").filter(Boolean);
}

function inspectPreparation(project: string, current: Pick<DurableEntityMigrationPlan, "project" | "source_fingerprint" | "preview_digest" | "entries"> | { project: string; source_fingerprint: string; preview_digest: string }): EntityMigrationPreparationInspection | undefined {
  try { return inspectEntityMigrationPreparation(project, current); }
  catch (error) {
    if (error instanceof EntityMigrationPreparationInspectionError) throw new EntityMigrationApprovalError(error.message);
    throw error;
  }
}

function approvalTransient(value: EntityMigrationPreparationInspection): NonNullable<EntityMigrationApproval["transient_preparation"]> {
  return {
    relative_path: value.relative_path,
    operation_id: value.id,
    directory: value.directory,
    receipt_count: value.receipt_count,
    inventory_sha256: value.inventory_sha256,
    expected_classification: value.classification,
  };
}

function porcelainUntracked(bytes: Buffer): string[] {
  return zeroSeparated(bytes).map((entry) => {
    if (!entry.startsWith("?? ")) throw new EntityMigrationApprovalError(`approval generation requires a clean tracked worktree; porcelain reported '${entry}'`);
    const relative = entry.slice(3);
    if (!safeRelative(relative)) throw new EntityMigrationApprovalError(`porcelain reported unsafe untracked path '${relative}'`);
    return relative;
  }).sort();
}

function coversPath(prefix: string, value: string): boolean {
  return prefix === value || value.startsWith(`${prefix}/`);
}

/** Maintainer-only approval generation. Apply validation never calls Git. */
export function generateEntityMigrationApproval(projectRoot: string, sourceFingerprint: string, previewDigest: string): EntityMigrationApproval {
  const project = validateRealProjectRoot(projectRoot).path;
  if (!SHA256.test(sourceFingerprint) || !SHA256.test(previewDigest)) throw new EntityMigrationApprovalError("source fingerprint and preview digest must be lowercase SHA-256 values");
  const layout = gitLayout(project);
  if (!layout) throw new EntityMigrationApprovalError("approval generation requires a Git checkout");
  const binding = { project, source_fingerprint: sourceFingerprint, preview_digest: previewDigest };
  const priorEvidence = inspectRolledBackEntityMigrationEvidence(project);
  const preparation = inspectPreparation(project, binding);
  const head = currentHead(layout);
  const gitIndexSha256 = indexHash(layout.gitDir);
  const porcelain = runGit(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const untracked = porcelainUntracked(porcelain);
  const expectedUntracked = [...priorEvidence.flatMap(({ untracked_paths }) => untracked_paths), ...(preparation?.untracked_paths ?? [])].sort();
  if (canonicalRecordJson(untracked) !== canonicalRecordJson(expectedUntracked)) throw new EntityMigrationApprovalError(`approval generation found unvalidated untracked path '${untracked.find((value) => !expectedUntracked.includes(value)) ?? expectedUntracked.find((value) => !untracked.includes(value)) ?? "unknown"}'`);
  const tracked = zeroSeparated(runGit(project, ["ls-files", "-z"])).sort().map((relative) => trackedPath(project, relative));
  const ignored = zeroSeparated(runGit(project, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"]));
  const ignoredValues = ignored.flatMap((entry) => {
    if (entry.startsWith("!! ")) return [entry.slice(3)];
    if (entry.startsWith("?? ") && expectedUntracked.includes(entry.slice(3))) return [];
    throw new EntityMigrationApprovalError(`unexpected porcelain entry while collecting ignored paths: '${entry}'`);
  });
  const ignoredDirectoryPrefixes = ignoredValues.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)).filter(safeRelative).sort();
  const ignoredPaths = ignoredValues.filter((entry) => !entry.endsWith("/")).filter(safeRelative).sort();
  const admittedDirectories = [...priorEvidence.map(({ relative_path }) => relative_path), ...(preparation ? [preparation.relative_path] : [])];
  if ([...ignoredDirectoryPrefixes, ...ignoredPaths].some((value) => admittedDirectories.some((directory) => coversPath(value, directory) || coversPath(directory, value)))) throw new EntityMigrationApprovalError("approval generation cannot admit migration evidence hidden by Git ignore rules");
  const confirmedPriorEvidence = inspectRolledBackEntityMigrationEvidence(project);
  const confirmed = inspectPreparation(project, binding);
  if (canonicalRecordJson(confirmedPriorEvidence) !== canonicalRecordJson(priorEvidence)) throw new EntityMigrationApprovalError("retained rolled-back migration evidence changed during approval generation");
  if (canonicalRecordJson(confirmed ?? null) !== canonicalRecordJson(preparation ?? null)) throw new EntityMigrationApprovalError("migration preparation changed during approval generation");
  return {
    schemaVersion: SCHEMA_VERSION,
    project,
    head,
    clean_porcelain: true,
    source_fingerprint: sourceFingerprint,
    preview_digest: previewDigest,
    git_index_sha256: gitIndexSha256,
    tracked_manifest_sha256: hash(canonicalRecordJson(tracked)),
    tracked,
    ignored_directory_prefixes: ignoredDirectoryPrefixes,
    ignored_paths: ignoredPaths,
    untracked_baseline: [],
    ...(priorEvidence.length ? { prior_rolled_back_operations: priorEvidence } : {}),
    ...(preparation ? { transient_preparation: approvalTransient(preparation) } : {}),
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

function assertApproval(
  projectRoot: string,
  approval: EntityMigrationApproval,
  sourceFingerprint: string,
  previewDigest: string,
  writerLockHeld = false,
  currentPlan?: Pick<DurableEntityMigrationPlan, "project" | "source_fingerprint" | "preview_digest" | "entries">,
): EntityMigrationApproval {
  const project = validateRealProjectRoot(projectRoot).path;
  const layout = gitLayout(project);
  if (!layout) throw new EntityMigrationApprovalError("this project is not a Git checkout and does not accept a Git approval envelope");
  if (approval.project !== project) throw new EntityMigrationApprovalError(`approval root '${approval.project}' does not match project '${project}'`);
  if (approval.source_fingerprint !== sourceFingerprint || approval.preview_digest !== previewDigest) throw new EntityMigrationApprovalError("approval source fingerprint or preview digest does not match the requested migration");
  const preparation = inspectPreparation(project, currentPlan ?? { project, source_fingerprint: sourceFingerprint, preview_digest: previewDigest });
  const priorEvidence = inspectRolledBackEntityMigrationEvidence(project);
  if (canonicalRecordJson(approval.prior_rolled_back_operations ?? []) !== canonicalRecordJson(priorEvidence)) throw new EntityMigrationApprovalError("approved retained rolled-back migration evidence identity, digest, phase, operation, or inventory changed");
  const expectedTransient = preparation ? approvalTransient(preparation) : undefined;
  if (canonicalRecordJson(approval.transient_preparation ?? null) !== canonicalRecordJson(expectedTransient ?? null)) throw new EntityMigrationApprovalError("approved migration preparation path, operation, identity, inventory, count, or classification changed");
  const head = currentHead(layout);
  if (canonicalRecordJson(head) !== canonicalRecordJson(approval.head)) throw new EntityMigrationApprovalError("Git HEAD/ref changed after migration approval");
  if (indexHash(layout.gitDir) !== approval.git_index_sha256) throw new EntityMigrationApprovalError("Git index changed after migration approval");
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
  if (preparation) ignoredDirectories.add(preparation.relative_path);
  for (const operation of priorEvidence) ignoredDirectories.add(operation.relative_path);
  const extras = inventoryWorktree(project, ignoredDirectories).filter((relative) => !allowed.has(relative));
  if (extras.length) throw new EntityMigrationApprovalError(`worktree has unapproved non-ignored path '${extras[0]}'`);
  const confirmed = inspectPreparation(project, currentPlan ?? { project, source_fingerprint: sourceFingerprint, preview_digest: previewDigest });
  const confirmedPriorEvidence = inspectRolledBackEntityMigrationEvidence(project);
  if (canonicalRecordJson(confirmedPriorEvidence) !== canonicalRecordJson(priorEvidence)) throw new EntityMigrationApprovalError("retained rolled-back migration evidence changed during approval validation");
  if (canonicalRecordJson(confirmed ?? null) !== canonicalRecordJson(preparation ?? null)) throw new EntityMigrationApprovalError("migration preparation changed during approval validation");
  return approval;
}

export function assertEntityMigrationApprovalEnvelope(projectRoot: string, approval: EntityMigrationApproval, sourceFingerprint: string, previewDigest: string, writerLockHeld = false, currentPlan?: Pick<DurableEntityMigrationPlan, "project" | "source_fingerprint" | "preview_digest" | "entries">): EntityMigrationApproval {
  return assertApproval(projectRoot, approval, sourceFingerprint, previewDigest, writerLockHeld, currentPlan);
}

export function assertEntityMigrationApproval(projectRoot: string, approvalFile: string, sourceFingerprint: string, previewDigest: string, writerLockHeld = false, currentPlan?: Pick<DurableEntityMigrationPlan, "project" | "source_fingerprint" | "preview_digest" | "entries">): EntityMigrationApproval {
  const project = validateRealProjectRoot(projectRoot).path;
  const approvalPath = path.resolve(approvalFile);
  if (approvalPath === project || approvalPath.startsWith(`${project}${path.sep}`)) throw new EntityMigrationApprovalError("approval file must be outside the project mutation set");
  return assertApproval(project, readApproval(approvalPath), sourceFingerprint, previewDigest, writerLockHeld, currentPlan);
}

export function projectIsGitCheckout(projectRoot: string): boolean {
  return gitLayout(validateRealProjectRoot(projectRoot).path) !== null;
}
