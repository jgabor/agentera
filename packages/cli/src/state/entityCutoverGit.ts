import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { DurableEntityMigrationPlan, DurableEntityMigrationSource } from "./entityMigrationPreview.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

export interface EntityCutoverGitBinding {
  head: string;
}

export interface EntityCutoverGitAllowlist {
  paths?: Iterable<string>;
  prefixes?: Iterable<string>;
}

export class EntityCutoverGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityCutoverGitError";
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  return env;
}

function git(project: string, args: string[], encoding: BufferEncoding | null = "utf8"): { status: number; stdout: string | Buffer } {
  const result = spawnSync("git", args, {
    cwd: project,
    env: gitEnvironment(),
    encoding: encoding ?? "buffer",
  });
  if (result.error) throw new EntityCutoverGitError(`Git preflight failed: ${result.error.message}`);
  return {
    status: result.status ?? 2,
    stdout: result.stdout ?? (encoding === null ? Buffer.alloc(0) : ""),
  };
}

function gitText(project: string, args: string[]): string {
  const result = git(project, args);
  if (result.status !== 0) throw new EntityCutoverGitError(`Git preflight command failed: git ${args.join(" ")}`);
  return String(result.stdout).trim();
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !value.includes("\\") && !path.isAbsolute(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function assertCleanTrackedState(project: string): void {
  const working = git(project, ["diff", "--quiet", "--no-ext-diff", "--"]);
  if (working.status === 1) throw new EntityCutoverGitError("Git worktree has modified or renamed tracked paths; commit or restore them before v2-to-v3 upgrade");
  if (working.status !== 0) throw new EntityCutoverGitError("Git could not verify the working tree before v2-to-v3 upgrade");
  const staged = git(project, ["diff", "--cached", "--quiet", "--no-ext-diff", "HEAD", "--"]);
  if (staged.status === 1) throw new EntityCutoverGitError("Git index has staged or renamed paths; commit or restore them before v2-to-v3 upgrade");
  if (staged.status !== 0) throw new EntityCutoverGitError("Git could not verify the index before v2-to-v3 upgrade");
}

function assertNoUnapprovedUntracked(project: string, allowlist: EntityCutoverGitAllowlist): void {
  const result = git(project, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.status !== 0) throw new EntityCutoverGitError("Git could not inventory untracked paths before v2-to-v3 upgrade");
  const paths = new Set(allowlist.paths ?? []);
  const prefixes = [...(allowlist.prefixes ?? [])].map((prefix) => (prefix.endsWith("/") ? prefix : `${prefix}/`));
  const unexpected = String(result.stdout)
    .split("\0")
    .filter(Boolean)
    .find((candidate) => !paths.has(candidate) && !prefixes.some((prefix) => candidate.startsWith(prefix)));
  if (unexpected) throw new EntityCutoverGitError(`Git worktree has untracked path '${unexpected}'; commit, ignore, or remove it before v2-to-v3 upgrade`);
}

interface HeadEntry {
  mode: "100644" | "100755";
  oid: string;
}

function headEntry(project: string, relativePath: string): HeadEntry | null {
  const result = git(project, ["ls-tree", "-z", "HEAD", "--", relativePath]);
  if (result.status !== 0) throw new EntityCutoverGitError(`Git could not inspect HEAD path '${relativePath}'`);
  const records = String(result.stdout).split("\0").filter(Boolean);
  if (records.length === 0) return null;
  if (records.length !== 1) throw new EntityCutoverGitError(`Git HEAD path '${relativePath}' is ambiguous`);
  const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]+)\t(.+)$/.exec(records[0]);
  if (!match || match[4] !== relativePath || match[2] !== "blob" || !["100644", "100755"].includes(match[1])) {
    throw new EntityCutoverGitError(`migration input '${relativePath}' must be a regular tracked file in HEAD`);
  }
  return { mode: match[1] as HeadEntry["mode"], oid: match[3] };
}

function assertSourceMatchesHead(project: string, source: DurableEntityMigrationSource): void {
  const lookupPath = source.path.endsWith("/") ? source.path.slice(0, -1) : source.path;
  if (!safeRelative(lookupPath)) throw new EntityCutoverGitError(`migration input path '${source.path}' is unsafe`);
  if (source.presence === "missing") {
    const tracked = source.path.endsWith("/") ? gitText(project, ["ls-tree", "-r", "--name-only", "HEAD", "--", `${lookupPath}/`]) !== "" : headEntry(project, lookupPath) !== null;
    if (tracked) throw new EntityCutoverGitError(`migration input '${source.path}' is tracked in HEAD but absent from the worktree`);
    const observed = readProjectFileSnapshot(validateRealProjectRoot(project), lookupPath);
    if (observed.kind !== "missing") throw new EntityCutoverGitError(`migration input '${source.path}' is absent from HEAD but present or unsafe in the worktree`);
    return;
  }
  const tracked = headEntry(project, lookupPath);
  if (!tracked) throw new EntityCutoverGitError(`migration input '${source.path}' is ignored or untracked; v2-to-v3 upgrade consumes only HEAD`);
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), lookupPath);
  if (observed.kind !== "file") throw new EntityCutoverGitError(`migration input '${source.path}' must be a safe regular tracked file`);
  const blob = git(project, ["cat-file", "blob", tracked.oid], null);
  if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) throw new EntityCutoverGitError(`Git could not read HEAD bytes for migration input '${source.path}'`);
  const executable = (observed.mode & 0o111) !== 0;
  const expectedMode = executable ? "100755" : "100644";
  if (tracked.mode !== expectedMode || source.mode !== observed.mode || source.type !== "file" || source.sha256 !== hash(observed.bytes) || !observed.bytes.equals(blob.stdout)) {
    throw new EntityCutoverGitError(`migration input '${source.path}' differs from HEAD in bytes, type, mode, or symlink form`);
  }
}

export function verifyEntityCutoverGitSource(projectRoot: string, plan: Pick<DurableEntityMigrationPlan, "sources">, allowlist: EntityCutoverGitAllowlist = {}): EntityCutoverGitBinding {
  const project = validateRealProjectRoot(projectRoot).path;
  const top = fs.realpathSync(gitText(project, ["rev-parse", "--show-toplevel"]));
  if (top !== project) throw new EntityCutoverGitError(`project '${project}' must be the Git worktree root for v2-to-v3 upgrade`);
  const head = gitText(project, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new EntityCutoverGitError("Git HEAD is missing or invalid; commit the v2 project before upgrade");
  assertCleanTrackedState(project);
  assertNoUnapprovedUntracked(project, allowlist);
  for (const source of plan.sources) assertSourceMatchesHead(project, source);
  if (gitText(project, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head) throw new EntityCutoverGitError("Git HEAD changed during v2-to-v3 preflight");
  return { head };
}
