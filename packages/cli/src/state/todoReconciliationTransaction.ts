import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalRecordJson } from "./archiveDiscovery.js";
import { entityExactGetMaxBytes } from "./entityStorage.js";
import {
  FILE_REPLACEMENT_METADATA_NAME,
  FILE_REPLACEMENT_RECOVERY_VERSION,
  validateEntityRecoveryDirectory,
  type EntityRecoveryDirectoryIdentity,
  type EntityPublicationContext,
  type PublishedTargetIdentity,
} from "./entityPublicationContext.js";
import { ExactReplacementConflictError, FileReplacementError } from "./exactReplacementRecovery.js";
import {
  TODO_RECONCILIATION_ACTIVATION_PATH,
  TODO_RECONCILIATION_ITEM_LIMIT,
} from "./todoReconciliationActivation.js";
import { reject } from "./write/errors.js";

const VERSION = "agentera.todoReconciliationTransaction.v1";
const DIRECTORY = ".agentera/.todo-reconciliation";
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_BYTES = 1024 * 1024;
const MAX_TARGETS = TODO_RECONCILIATION_ITEM_LIMIT + 2;

export interface TodoReconciliationTarget {
  path: string;
  before: Buffer | null;
  after: string;
}

export interface TodoReconciliationBinding {
  publicPath: string;
  mappingSha256: string;
}

interface JournalTarget {
  path: string;
  before: string | null;
  after: string;
}

interface Journal {
  schema_version: typeof VERSION;
  id: string;
  public_path: string;
  mapping_sha256: string;
  targets: JournalTarget[];
}

interface AppliedTarget {
  target: JournalTarget;
  identity: PublishedTargetIdentity;
}

interface RollbackIssue {
  path: string;
  message: string;
  retainedPaths: string[];
}

export class InjectedTodoReconciliationInterruption extends Error {
  constructor(readonly publishedTargets: number) {
    super(`injected TODO reconciliation interruption after ${publishedTargets} target publications`);
    this.name = "InjectedTodoReconciliationInterruption";
  }
}

function encode(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString("base64");
}

function decode(bytes: string): Buffer {
  return Buffer.from(bytes, "base64");
}

function exactBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return encode(decode(value)) === value; } catch { return false; }
}

function bytesAt(root: string, relative: string): Buffer | null {
  const target = path.join(root, relative);
  return fs.existsSync(target) ? fs.readFileSync(target) : null;
}

function same(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function validTarget(relative: string, publicPath: string): boolean {
  return relative === publicPath
    || relative === TODO_RECONCILIATION_ACTIVATION_PATH
    || /^\.agentera\/entities\/todo\/todo_item\/[a-z]{10}\.yaml$/.test(relative);
}

function invalidJournal(message: string): never {
  reject({
    class: "conflict",
    message,
    recovery: `Preserve '${DIRECTORY}', restore its last valid committed journal bytes, and retry the exact non-dry-run TODO mutation; no target bytes were changed.`,
  });
}

function parseJournal(bytes: Buffer, fileName?: string): Journal {
  if (bytes.length > MAX_JOURNAL_BYTES) invalidJournal("TODO reconciliation journal exceeds its byte bound");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalidJournal("TODO reconciliation journal is not valid bounded UTF-8 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidJournal("TODO reconciliation journal is not a mapping");
  const value = parsed as Partial<Journal>;
  if (
    Object.keys(value).sort().join(",") !== "id,mapping_sha256,public_path,schema_version,targets"
    || value.schema_version !== VERSION
    || typeof value.id !== "string"
    || !/^[a-f0-9]{24}$/.test(value.id)
    || typeof value.public_path !== "string"
    || typeof value.mapping_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.mapping_sha256)
    || !Array.isArray(value.targets)
    || value.targets.length < 1
    || value.targets.length > MAX_TARGETS
  ) invalidJournal("TODO reconciliation journal is malformed");
  const paths = new Set<string>();
  for (const target of value.targets) {
    if (
      !target
      || typeof target !== "object"
      || Array.isArray(target)
      || Object.keys(target).sort().join(",") !== "after,before,path"
      || typeof target.path !== "string"
      || !validTarget(target.path, value.public_path)
      || paths.has(target.path)
      || (target.before !== null && !exactBase64(target.before))
      || !exactBase64(target.after)
      || decode(target.after).length > MAX_TARGET_BYTES
      || (target.before !== null && decode(target.before).length > MAX_TARGET_BYTES)
    ) invalidJournal("TODO reconciliation journal has an invalid target");
    paths.add(target.path);
  }
  const body = value.targets as JournalTarget[];
  const expectedId = createHash("sha256").update(canonicalRecordJson(body)).digest("hex").slice(0, 24);
  if (value.id !== expectedId || (fileName !== undefined && fileName !== `${value.id}.json`)) {
    invalidJournal("TODO reconciliation journal identity does not match its canonical targets");
  }
  return value as Journal;
}

function targetLimit(target: JournalTarget, sourceRoot: string): number {
  return target.path.startsWith(".agentera/entities/todo/todo_item/") ? entityExactGetMaxBytes(sourceRoot) : MAX_TARGET_BYTES;
}

function assertBinding(journal: Journal, binding: TodoReconciliationBinding): void {
  if (journal.public_path !== binding.publicPath || journal.mapping_sha256 !== binding.mappingSha256) reject({
    class: "conflict",
    message: "TODO reconciliation mapping changed while a transaction is pending",
    recovery: `Restore the docs mapping that resolves TODO.md to '${journal.public_path}', then retry the exact non-dry-run mutation once; no state was changed.`,
  });
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function removeExactRole(file: string, expected: Buffer): void {
  if (!fs.readFileSync(file).equals(expected)) throw new Error(`exact replacement recovery role '${file}' changed`);
  fs.unlinkSync(file);
}

interface FileRecoveryMetadata {
  schema_version: typeof FILE_REPLACEMENT_RECOVERY_VERSION;
  target_path: string;
  before_sha256: string;
  after_sha256: string;
}

function parseFileRecoveryMetadata(file: string): FileRecoveryMetadata {
  let parsed: unknown;
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > 1024) throw new Error("over bound");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalidJournal(`file replacement recovery metadata '${file}' is invalid`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalidJournal(`file replacement recovery metadata '${file}' is not a mapping`);
  }
  const value = parsed as Partial<FileRecoveryMetadata>;
  if (
    Object.keys(value).sort().join(",") !== "after_sha256,before_sha256,schema_version,target_path"
    || value.schema_version !== FILE_REPLACEMENT_RECOVERY_VERSION
    || typeof value.target_path !== "string"
    || typeof value.before_sha256 !== "string"
    || typeof value.after_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.before_sha256)
    || !/^[a-f0-9]{64}$/.test(value.after_sha256)
  ) invalidJournal(`file replacement recovery metadata '${file}' has an invalid canonical record`);
  return value as FileRecoveryMetadata;
}

function recoveryConflict(target: JournalTarget, paths: string[], detail: string): never {
  const boundedPaths = paths.slice(0, 4).map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"));
  reject({
    class: "conflict",
    message: `TODO reconciliation target '${target.path}' conflicts with retained recovery roles: ${detail}`,
    violations: boundedPaths.length ? boundedPaths.map((file) => `preserved recovery role: ${file}`) : undefined,
    recovery: `Preserve the pending journal, canonical competitor, and every listed recovery role. Choose the intended canonical bytes, restore '${target.path}' to the journal's recorded before or after bytes without deleting the competitor copy, then retry the exact non-dry-run mutation once; this rejection changed no bytes.`,
  });
}

function recoverImmutablePublicationStage(root: string, target: JournalTarget): void {
  if (target.before !== null) return;
  const absolute = path.join(root, target.path);
  const directory = path.dirname(absolute);
  if (!fs.existsSync(directory)) return;
  const name = path.basename(absolute);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${escaped}\\.\\d+\\.[a-f0-9-]+\\.tmp$`);
  const names = fs.readdirSync(directory).filter((candidate) => pattern.test(candidate));
  if (!names.length) return;
  if (names.length > 1) recoveryConflict(target, names.map((candidate) => path.join(directory, candidate)), "multiple immutable publication stages claim the same target");
  const stage = path.join(directory, names[0]!);
  const stat = fs.lstatSync(stage);
  const after = decode(target.after);
  if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(stage).equals(after)) {
    recoveryConflict(target, [stage], "an immutable publication stage changed");
  }
  const current = bytesAt(root, target.path);
  if (current !== null && !current.equals(after)) {
    recoveryConflict(target, [stage], "the canonical target contains concurrent bytes");
  }
  removeExactRole(stage, after);
  fsyncDirectory(directory);
}

function recoverFileReplacementRoles(
  context: EntityPublicationContext,
  target: JournalTarget,
  entries: fs.Dirent[],
  recoveryRoot: string,
  recoveryRootIdentity: EntityRecoveryDirectoryIdentity,
  targetDirectory: string,
): boolean {
  const before = target.before === null ? null : decode(target.before);
  if (before === null) return false;
  const after = decode(target.after);
  const matches: Array<{ directory: string; identity: EntityRecoveryDirectoryIdentity; metadata: string; previous?: string; stage?: string }> = [];
  for (const entry of entries) {
    if (entry.name === ".gitignore") continue;
    const directory = path.join(recoveryRoot, entry.name);
    const attemptIdentity = validateEntityRecoveryDirectory(
      context.validatedRoot,
      directory,
      targetDirectory,
      `private entity recovery attempt '${path.relative(context.pinnedPath(), directory).split(path.sep).join("/")}'`,
    );
    const metadata = path.join(directory, FILE_REPLACEMENT_METADATA_NAME);
    if (!fs.existsSync(metadata)) continue;
    const value = parseFileRecoveryMetadata(metadata);
    if (value.target_path !== target.path) continue;
    if (
      value.before_sha256 !== createHash("sha256").update(before).digest("hex")
      || value.after_sha256 !== createHash("sha256").update(after).digest("hex")
    ) recoveryConflict(target, [metadata], "the role digest does not match the pending journal");
    const roleNames = fs.readdirSync(directory).sort();
    if (roleNames.some((name) => !["original.previous", "replacement.tmp", FILE_REPLACEMENT_METADATA_NAME].includes(name))) {
      recoveryConflict(target, roleNames.map((name) => path.join(directory, name)), "the recovery attempt contains an unknown role");
    }
    const previous = path.join(directory, "original.previous");
    const stage = path.join(directory, "replacement.tmp");
    if (fs.existsSync(previous)) {
      const stat = fs.lstatSync(previous);
      if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(previous).equals(before)) {
        recoveryConflict(target, [metadata, previous], "the retained baseline role changed");
      }
    }
    if (fs.existsSync(stage)) {
      const stat = fs.lstatSync(stage);
      if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(stage).equals(after)) {
        recoveryConflict(target, [metadata, stage], "the replacement stage changed");
      }
    }
    matches.push({
      directory,
      identity: attemptIdentity,
      metadata,
      ...(fs.existsSync(previous) ? { previous } : {}),
      ...(fs.existsSync(stage) ? { stage } : {}),
    });
  }
  if (matches.length > 1) recoveryConflict(target, matches.map(({ metadata }) => metadata), "multiple recovery attempts claim the same target");
  const match = matches[0];
  if (!match) return false;
  const current = bytesAt(context.pinnedPath(), target.path);
  if (!same(current, before) && !same(current, after)) {
    recoveryConflict(target, [match.metadata, ...(match.previous ? [match.previous] : []), ...(match.stage ? [match.stage] : [])], current === null ? "the canonical target is absent" : "the canonical target contains concurrent bytes");
  }
  validateEntityRecoveryDirectory(
    context.validatedRoot,
    recoveryRoot,
    targetDirectory,
    "private entity recovery root '.agentera/.entity-recovery'",
    recoveryRootIdentity,
  );
  validateEntityRecoveryDirectory(
    context.validatedRoot,
    match.directory,
    targetDirectory,
    `private entity recovery attempt '${path.relative(context.pinnedPath(), match.directory).split(path.sep).join("/")}'`,
    match.identity,
  );
  if (match.stage) removeExactRole(match.stage, after);
  if (match.previous) removeExactRole(match.previous, before);
  removeExactRole(match.metadata, fs.readFileSync(match.metadata));
  fs.rmdirSync(match.directory);
  fsyncDirectory(recoveryRoot);
  return true;
}

function recoverFileReplacement(context: EntityPublicationContext, target: JournalTarget): void {
  if (target.before === null) return;
  const recoveryRoot = path.join(context.pinnedPath(), ".agentera/.entity-recovery");
  if (!fs.existsSync(recoveryRoot)) return;
  const targetDirectory = path.dirname(context.pinnedPath(target.path));
  const recoveryRootIdentity = validateEntityRecoveryDirectory(
    context.validatedRoot,
    recoveryRoot,
    targetDirectory,
    "private entity recovery root '.agentera/.entity-recovery'",
  );
  const entries = fs.readdirSync(recoveryRoot, { withFileTypes: true });
  if (entries.length > 128) invalidJournal("file replacement recovery root exceeds its bounded entry count");
  recoverFileReplacementRoles(context, target, entries, recoveryRoot, recoveryRootIdentity, targetDirectory);
}

function applyTarget(
  context: EntityPublicationContext,
  root: string,
  target: JournalTarget,
  sourceRoot: string,
  publicPath: string,
): PublishedTargetIdentity | null {
  const before = target.before === null ? null : decode(target.before);
  const after = decode(target.after);
  recoverImmutablePublicationStage(root, target);
  recoverFileReplacement(context, target);
  const current = bytesAt(root, target.path);
  if (same(current, after)) return null;
  if (!same(current, before)) reject({
    class: "conflict",
    message: `TODO reconciliation target '${target.path}' changed after transaction preparation`,
    recovery: "Preserve the pending journal and both repository changes, restore every target to either the recorded before or after bytes, then retry once; no additional state was changed.",
  });
  if (before === null) {
    const identity = context.publishImmutable(target.path, after.toString("utf8"));
    if (!identity) reject({
      class: "conflict",
      message: `TODO reconciliation target '${target.path}' appeared during publication`,
      recovery: `Preserve the competing target and retry the exact TODO mutation after reconciling it with the pending transaction; no competing bytes were overwritten.`,
    });
    return identity;
  }
  const replacement = target.path === publicPath
    ? context.replaceVisible(target.path, before, after.toString("utf8"), targetLimit(target, sourceRoot))
    : context.replaceExisting(target.path, before, after.toString("utf8"), targetLimit(target, sourceRoot));
  return replacement.publishedIdentity;
}

function rollback(
  context: EntityPublicationContext,
  applied: AppliedTarget[],
  sourceRoot: string,
  publicPath: string,
): RollbackIssue[] {
  const issues: RollbackIssue[] = [];
  for (const { target, identity } of [...applied].reverse()) {
    try {
      if (target.before === null) {
        const result = context.removeExact(target.path, identity, false);
        if (result !== "removed") throw new Error(`exact removal returned ${result}`);
      } else {
        if (target.path === publicPath) {
          context.restoreVisible(target.path, identity, decode(target.before).toString("utf8"), targetLimit(target, sourceRoot));
        } else {
          context.restoreExact(target.path, identity, decode(target.before).toString("utf8"), targetLimit(target, sourceRoot));
        }
      }
    } catch (error) {
      issues.push({
        path: target.path,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
        retainedPaths: error instanceof ExactReplacementConflictError
          ? error.retainedPaths.slice(0, 8).map((retainedPath) => retainedPath.slice(0, 512))
          : [],
      });
    }
  }
  return issues;
}

function rejectIncompleteRollback(primary: unknown, issues: RollbackIssue[]): never {
  const primaryMessage = (primary instanceof Error ? primary.message : String(primary)).slice(0, 512);
  const violations = issues.slice(0, 8).map(({ path: targetPath, message }) => `rollback target '${targetPath}': ${message}`);
  const retained = [...new Set(issues.flatMap(({ retainedPaths }) => retainedPaths))].slice(0, 8);
  violations.push(...retained.map((role) => `preserved recovery role: ${role}`));
  reject({
    class: "conflict",
    message: `TODO reconciliation attempted rollback for every published target after '${primaryMessage}', but ${issues.length} target${issues.length === 1 ? "" : "s"} could not be restored`,
    violations,
    recovery: "Preserve the pending journal, each listed canonical target, and every listed recovery role. Targets not listed were restored. Reconcile each listed target to the journal's recorded before or after bytes without deleting concurrent bytes, then retry the exact non-dry-run mutation once.",
  });
}

function rejectPublicationFailure(error: FileReplacementError, pendingJournal: boolean): never {
  reject({
    class: "unsupported_target",
    message: `recoverable complete-file replacement is unavailable for this target${error.code ? ` (${error.code})` : ""}`,
    violations: [error.message.slice(0, 512)],
    recovery: `${pendingJournal ? "Preserve the pending journal. " : ""}Use an owner-controlled regular file on the project-state filesystem with standard rename support, correct the reported capability or permission, then retry the exact non-dry-run mutation; all attempted target bytes were restored.`,
  });
}

function rejectReplacementConflict(error: ExactReplacementConflictError): never {
  reject({
    class: "conflict",
    message: `TODO reconciliation retained a concurrent target without overwriting it: ${error.message.slice(0, 1024)}`,
    violations: error.retainedPaths.slice(0, 4).map((role) => `preserved recovery role: ${role.slice(0, 512)}`),
    recovery: "Preserve the pending journal, canonical competitor, and listed recovery roles. Choose the intended canonical bytes, restore the conflicted target to the journal's recorded before or after bytes without deleting the competitor copy, then retry the exact non-dry-run mutation once; no competitor bytes were overwritten.",
  });
}

function journalPath(id: string): string {
  return `${DIRECTORY}/${id}.json`;
}

function finishJournal(context: EntityPublicationContext, relative: string, identity: PublishedTargetIdentity): void {
  if (context.removeExact(relative, identity) !== "removed") throw new Error(`TODO reconciliation journal '${relative}' changed before cleanup`);
}

export function inspectTodoReconciliation(root: string, binding: TodoReconciliationBinding): string[] {
  const directory = path.join(root, DIRECTORY); if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (names.length > 1) reject({ class: "conflict", message: "multiple pending TODO reconciliation journals exist", recovery: "Preserve the journals and reconcile them to one transaction before retrying; no state was changed." });
  return names.map((name) => { const journal = parseJournal(fs.readFileSync(path.join(directory, name)), name); assertBinding(journal, binding); return journal.id; });
}

export function recoverTodoReconciliation(context: EntityPublicationContext, sourceRoot: string, binding: TodoReconciliationBinding, beforeCommit?: () => void): string[] {
  const root = context.pinnedPath();
  const directory = path.join(root, DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  if (names.length > 1) reject({ class: "conflict", message: "multiple pending TODO reconciliation journals exist", recovery: "Preserve the journals and reconcile them to one transaction before retrying; no state was changed." });
  const recovered: string[] = [];
  for (const name of names) {
    const relative = `${DIRECTORY}/${name}`;
    const journalBytes = fs.readFileSync(path.join(root, relative));
    const journal = parseJournal(journalBytes, name);
    assertBinding(journal, binding);
    const applied: AppliedTarget[] = [];
    try {
      for (const target of journal.targets) {
        const identity = applyTarget(context, root, target, sourceRoot, journal.public_path);
        if (identity) applied.push({ target, identity });
      }
      beforeCommit?.();
      context.assertValid();
      const journalIdentity = context.replaceExisting(relative, journalBytes, journalBytes.toString("utf8"), MAX_JOURNAL_BYTES).publishedIdentity;
      finishJournal(context, relative, journalIdentity);
      recovered.push(journal.id);
    } catch (error) {
      const rollbackIssues = applied.length ? rollback(context, applied, sourceRoot, journal.public_path) : [];
      if (rollbackIssues.length) rejectIncompleteRollback(error, rollbackIssues);
      if (error instanceof ExactReplacementConflictError) rejectReplacementConflict(error);
      if (error instanceof FileReplacementError) rejectPublicationFailure(error, true);
      throw error;
    }
  }
  return recovered;
}

export function publishTodoReconciliation(
  context: EntityPublicationContext,
  sourceRoot: string,
  binding: TodoReconciliationBinding,
  targets: TodoReconciliationTarget[],
  interruptAfterTarget?: number,
  beforeCommit?: () => void,
): { id: string; targetCount: number } {
  const normalized = targets
    .filter((target) => !same(target.before, Buffer.from(target.after)))
    .sort((left, right) => Number(left.path === binding.publicPath) - Number(right.path === binding.publicPath) || left.path.localeCompare(right.path));
  const body = normalized.map((target) => ({ path: target.path, before: target.before === null ? null : encode(target.before), after: encode(target.after) }));
  const id = createHash("sha256").update(canonicalRecordJson(body)).digest("hex").slice(0, 24);
  if (!normalized.length) return { id, targetCount: 0 };
  if (
    body.length > MAX_TARGETS
    || new Set(body.map(({ path: targetPath }) => targetPath)).size !== body.length
    || body.some((target) => !validTarget(target.path, binding.publicPath))
  ) reject({
    class: "schema_violation",
    message: "TODO reconciliation transaction has invalid or duplicate bounded targets",
    recovery: `Reduce the managed TODO working set to at most ${TODO_RECONCILIATION_ITEM_LIMIT} items and retry; no state was changed.`,
  });
  const publicTarget = normalized.find((target) => target.path === binding.publicPath && target.before !== null);
  if (publicTarget) {
    const root = context.pinnedPath();
    const publicDevice = fs.statSync(path.dirname(path.join(root, binding.publicPath)), { bigint: true }).dev;
    const recoveryDevice = fs.statSync(path.join(root, ".agentera"), { bigint: true }).dev;
    if (publicDevice !== recoveryDevice) reject({
      class: "unsupported_target",
      message: `mapped TODO target '${binding.publicPath}' is on a different filesystem from its private recovery root`,
      recovery: "Map TODO.md to a regular file on the project-state filesystem, then retry the exact mutation; no journal or target bytes were changed.",
    });
  }
  const journal: Journal = { schema_version: VERSION, id, public_path: binding.publicPath, mapping_sha256: binding.mappingSha256, targets: body };
  const bytes = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(bytes) > MAX_JOURNAL_BYTES) reject({ class: "schema_violation", message: "TODO reconciliation transaction exceeds its byte bound", recovery: "Reduce the managed TODO working set below the declared transaction bound and retry; no state was changed." });
  const relativeJournal = journalPath(id);
  const journalIdentity = context.publishImmutable(relativeJournal, bytes);
  if (!journalIdentity) reject({
    class: "conflict",
    message: `TODO reconciliation journal '${id}' already exists`,
    recovery: "Retry the exact non-dry-run TODO mutation once so the existing journal is inspected and recovered before another transaction is prepared; no target bytes were changed.",
  });
  if (interruptAfterTarget === 0) throw new InjectedTodoReconciliationInterruption(0);
  const applied: AppliedTarget[] = [];
  try {
    for (const target of journal.targets) {
      const identity = applyTarget(context, context.pinnedPath(), target, sourceRoot, journal.public_path);
      if (identity) applied.push({ target, identity });
      if (interruptAfterTarget === applied.length) throw new InjectedTodoReconciliationInterruption(applied.length);
    }
    beforeCommit?.();
    context.assertValid();
    finishJournal(context, relativeJournal, journalIdentity);
    return { id, targetCount: normalized.length };
  } catch (error) {
    if (error instanceof InjectedTodoReconciliationInterruption) throw error;
    const rollbackIssues = rollback(context, applied, sourceRoot, journal.public_path);
    if (rollbackIssues.length) rejectIncompleteRollback(error, rollbackIssues);
    if (error instanceof ExactReplacementConflictError) rejectReplacementConflict(error);
    if (error instanceof FileReplacementError) {
      finishJournal(context, relativeJournal, journalIdentity);
      rejectPublicationFailure(error, false);
    }
    finishJournal(context, relativeJournal, journalIdentity);
    throw error;
  }
}
