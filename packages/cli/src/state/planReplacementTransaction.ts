import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { entityExactGetMaxBytes } from "./entityStorage.js";
import { FILE_REPLACEMENT_METADATA_NAME, FILE_REPLACEMENT_RECOVERY_VERSION, validateEntityRecoveryDirectory, type EntityPublicationContext, type EntityRecoveryDirectoryIdentity, type PublishedTargetIdentity } from "./entityPublicationContext.js";
import { reject } from "./write/errors.js";

const VERSION = "agentera.planReplacementTransaction.v1";
const DIRECTORY = ".agentera/.entity-recovery/plan-replacement";
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_TARGET_BYTES = 1024 * 1024;
const MAX_TARGETS = 102;
const ID = /^[a-z]{10}$/;
const TARGET = /^\.agentera\/entities\/plan\/(?:plan|plan_task)\/[a-z]{10}\.yaml$/;

export interface PlanReplacementTarget {
  path: string;
  before: Buffer | null;
  after: string;
}

export interface PlanReplacementOperation {
  kind: "existing" | "create";
  predecessor: string;
  successor: string;
  inputSha256: string;
}

export interface PlanReplacementRetry {
  predecessor: string;
  successor?: string;
  inputSha256?: string;
}

export interface PendingPlanReplacement {
  predecessor: string;
  successor: string;
  kind: "existing" | "create";
  inputSha256: string;
  targetCount: number;
}

export interface PlanReplacementTransactionOptions {
  validate: () => void;
}

interface JournalTarget {
  path: string;
  before: string | null;
  after: string;
}

interface JournalOperation {
  kind: "existing" | "create";
  predecessor: string;
  successor: string;
  input_sha256: string;
}

interface Journal {
  schema_version: typeof VERSION;
  id: string;
  operation: JournalOperation;
  targets: JournalTarget[];
}

interface AppliedTarget {
  target: JournalTarget;
  identity: PublishedTargetIdentity;
}

interface FileRecoveryMetadata {
  schema_version: typeof FILE_REPLACEMENT_RECOVERY_VERSION;
  target_path: string;
  before_sha256: string;
  after_sha256: string;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function exactBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return encode(decode(value)) === value;
  } catch {
    return false;
  }
}

function same(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function journalPath(id: string): string {
  return `${DIRECTORY}/${id}.json`;
}

function invalid(message: string): never {
  throw new Error(`plan replacement journal ${message}`);
}

function conflict(message: string): never {
  reject({
    class: "conflict",
    message,
    recovery: "Preserve the pending plan replacement journal, canonical target bytes, and retained recovery roles. Retry only the exact original state plan replace request after reconciling any reported concurrent bytes; no competing bytes were overwritten.",
  });
}

function targetPath(boundary: "plan" | "plan_task", id: string): string {
  return `.agentera/entities/plan/${boundary}/${id}.yaml`;
}

function parseEnvelope(bytes: Buffer, label: string): Record<string, unknown> {
  try {
    const value = loadYamlMapping(bytes.toString("utf8"));
    if (!mapping(value)) throw new Error("not a mapping");
    return value;
  } catch {
    invalid(`${label} is not a valid canonical entity envelope`);
  }
}

function parseJournal(bytes: Buffer, fileName?: string): Journal {
  if (bytes.length > MAX_JOURNAL_BYTES) invalid("exceeds its byte bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("is not valid bounded UTF-8 JSON");
  }
  if (!mapping(parsed)) invalid("is not a mapping");
  const value = parsed as Partial<Journal>;
  if (Object.keys(value).sort().join(",") !== "id,operation,schema_version,targets" || value.schema_version !== VERSION || typeof value.id !== "string" || !/^[a-f0-9]{24}$/.test(value.id) || !mapping(value.operation) || !Array.isArray(value.targets) || value.targets.length < 2 || value.targets.length > MAX_TARGETS)
    invalid("is malformed");
  const operation = value.operation as Partial<JournalOperation>;
  if (
    Object.keys(operation).sort().join(",") !== "input_sha256,kind,predecessor,successor" ||
    !["existing", "create"].includes(String(operation.kind)) ||
    typeof operation.predecessor !== "string" ||
    typeof operation.successor !== "string" ||
    !ID.test(operation.predecessor) ||
    !ID.test(operation.successor) ||
    operation.predecessor === operation.successor ||
    typeof operation.input_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(operation.input_sha256)
  )
    invalid("has an invalid operation identity");
  const paths = new Set<string>();
  for (const target of value.targets) {
    if (
      !mapping(target) ||
      Object.keys(target).sort().join(",") !== "after,before,path" ||
      typeof target.path !== "string" ||
      !TARGET.test(target.path) ||
      paths.has(target.path) ||
      (target.before !== null && !exactBase64(target.before)) ||
      !exactBase64(target.after) ||
      decode(target.after).length > MAX_TARGET_BYTES ||
      (target.before !== null && decode(target.before).length > MAX_TARGET_BYTES)
    )
      invalid("has an invalid target");
    paths.add(target.path);
  }
  const body = value.targets as JournalTarget[];
  const identity = { operation, targets: body };
  const expectedId = sha256(canonicalRecordJson(identity)).slice(0, 24);
  if (value.id !== expectedId || (fileName !== undefined && fileName !== `${value.id}.json`)) {
    invalid("identity does not match its operation and complete target set");
  }
  const predecessor = body.find((target) => target.path === targetPath("plan", operation.predecessor!));
  const successor = body.find((target) => target.path === targetPath("plan", operation.successor!));
  if (!predecessor || predecessor.before === null || !successor) invalid("does not include both canonical plan targets");
  if (operation.kind === "create" && successor.before !== null) invalid("create target has a predecessor byte baseline");
  if (operation.kind === "existing" && successor.before === null) invalid("existing successor target lacks a byte baseline");
  const predecessorEnvelope = parseEnvelope(decode(predecessor.after), "predecessor after target");
  const successorEnvelope = parseEnvelope(decode(successor.after), "successor after target");
  const predecessorHeader = mapping((predecessorEnvelope.record as Record<string, unknown> | undefined)?.header) ? ((predecessorEnvelope.record as Record<string, unknown>).header as Record<string, unknown>) : {};
  const successorRecord = mapping(successorEnvelope.record) ? successorEnvelope.record : {};
  if (
    predecessorEnvelope.id !== operation.predecessor ||
    predecessorEnvelope.artifact !== "plan" ||
    predecessorHeader.status !== "archived" ||
    successorEnvelope.id !== operation.successor ||
    successorEnvelope.artifact !== "plan" ||
    successorRecord.previous_plan_archived !== operation.predecessor ||
    successorRecord.replacement_input_sha256 !== operation.input_sha256
  )
    invalid("does not encode the declared predecessor archive and immutable successor identity");
  const taskTargets = body.filter((target) => target.path.includes("/plan_task/"));
  if (operation.kind === "existing" && taskTargets.length) invalid("existing-successor operation includes unexpected task targets");
  if (operation.kind === "create") {
    for (const target of taskTargets) {
      if (target.before !== null) invalid("create task target has a predecessor byte baseline");
      const envelope = parseEnvelope(decode(target.after), "created task after target");
      if (!mapping(envelope.record) || envelope.artifact !== "plan" || envelope.record.plan !== operation.successor) {
        invalid("created task target does not belong to the declared successor");
      }
    }
  }
  return {
    schema_version: VERSION,
    id: value.id,
    operation: operation as JournalOperation,
    targets: body,
  };
}

function readJournal(root: string, name: string): Journal {
  const file = path.join(root, DIRECTORY, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) invalid("file is not a safe bounded regular file");
  return parseJournal(fs.readFileSync(file), name);
}

function pendingJournalNames(root: string): string[] {
  const directory = path.join(root, DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid("directory is not a safe real directory");
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) invalid("directory contains an unsafe journal entry");
      return entry.name;
    })
    .sort();
  if (names.length > 1) invalid("has multiple pending operations");
  return names;
}

export function inspectPendingPlanReplacement(root: string): PendingPlanReplacement | null {
  const name = pendingJournalNames(root)[0];
  if (!name) return null;
  const journal = readJournal(root, name);
  return {
    predecessor: journal.operation.predecessor,
    successor: journal.operation.successor,
    kind: journal.operation.kind,
    inputSha256: journal.operation.input_sha256,
    targetCount: journal.targets.length,
  };
}

function assertExactRetry(journal: Journal, retry: PlanReplacementRetry): void {
  const operation = journal.operation;
  const matches = operation.predecessor === retry.predecessor && (operation.kind === "existing" ? retry.successor === operation.successor && retry.inputSha256 === undefined : retry.successor === undefined && retry.inputSha256 === operation.input_sha256);
  if (!matches) {
    conflict(operation.kind === "existing" ? `pending plan replacement for predecessor '${operation.predecessor}' requires successor '${operation.successor}', not this request` : `pending plan replacement for predecessor '${operation.predecessor}' requires the exact original successor input`);
  }
}

function bytesAt(root: string, relative: string): Buffer | null {
  const file = path.join(root, relative);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("is not a safe regular file");
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`plan replacement target '${relative}' ${(error as Error).message}`);
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseFileRecoveryMetadata(file: string): FileRecoveryMetadata {
  let parsed: unknown;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("is unsafe or over bound");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)));
  } catch {
    conflict(`plan replacement retained recovery metadata '${file}' is invalid`);
  }
  if (!mapping(parsed)) conflict(`plan replacement retained recovery metadata '${file}' is not a mapping`);
  const value = parsed as Partial<FileRecoveryMetadata>;
  if (
    Object.keys(value).sort().join(",") !== "after_sha256,before_sha256,schema_version,target_path" ||
    value.schema_version !== FILE_REPLACEMENT_RECOVERY_VERSION ||
    typeof value.target_path !== "string" ||
    typeof value.before_sha256 !== "string" ||
    typeof value.after_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.before_sha256) ||
    !/^[a-f0-9]{64}$/.test(value.after_sha256)
  )
    conflict(`plan replacement retained recovery metadata '${file}' has an invalid canonical record`);
  return value as FileRecoveryMetadata;
}

function roleBytes(file: string, label: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) conflict(`plan replacement ${label} '${file}' is unsafe`);
  return fs.readFileSync(file);
}

function removeExactRole(file: string, expected: Buffer): void {
  if (!roleBytes(file, "recovery role").equals(expected)) conflict(`plan replacement recovery role '${file}' changed`);
  fs.unlinkSync(file);
}

function recoverImmutableStage(root: string, target: JournalTarget): void {
  if (target.before !== null) return;
  const absolute = path.join(root, target.path);
  const directory = path.dirname(absolute);
  if (!fs.existsSync(directory)) return;
  const name = path.basename(absolute);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${escaped}\\.\\d+\\.[a-f0-9-]+\\.tmp$`);
  const stages = fs.readdirSync(directory).filter((candidate) => pattern.test(candidate));
  if (stages.length > 1) conflict(`plan replacement target '${target.path}' has multiple retained immutable publication stages`);
  if (!stages.length) return;
  const stage = path.join(directory, stages[0]!);
  const after = decode(target.after);
  if (!roleBytes(stage, "immutable publication stage").equals(after)) {
    conflict(`plan replacement target '${target.path}' retained immutable publication stage changed`);
  }
  const current = bytesAt(root, target.path);
  if (current !== null && !current.equals(after)) {
    conflict(`plan replacement target '${target.path}' has concurrent canonical bytes beside its immutable publication stage`);
  }
  removeExactRole(stage, after);
  fsyncDirectory(directory);
}

function recoverReplacementRoles(context: EntityPublicationContext, target: JournalTarget): void {
  if (target.before === null) return;
  const root = context.pinnedPath();
  const recoveryRoot = path.join(root, ".agentera/.entity-recovery");
  if (!fs.existsSync(recoveryRoot)) return;
  const targetDirectory = path.dirname(context.pinnedPath(target.path));
  const recoveryRootIdentity = validateEntityRecoveryDirectory(context.validatedRoot, recoveryRoot, targetDirectory, "private entity recovery root '.agentera/.entity-recovery'");
  const entries = fs.readdirSync(recoveryRoot, { withFileTypes: true });
  if (entries.length > 128) conflict("private entity recovery root exceeds its bounded entry count");
  const before = decode(target.before);
  const after = decode(target.after);
  const matches: Array<{
    directory: string;
    identity: EntityRecoveryDirectoryIdentity;
    metadata: string;
    previous?: string;
    stage?: string;
  }> = [];
  for (const entry of entries) {
    if (entry.name === ".gitignore" || entry.name === "plan-replacement") continue;
    const directory = path.join(recoveryRoot, entry.name);
    const identity = validateEntityRecoveryDirectory(context.validatedRoot, directory, targetDirectory, `private entity recovery attempt '${path.relative(root, directory).split(path.sep).join("/")}'`);
    const metadata = path.join(directory, FILE_REPLACEMENT_METADATA_NAME);
    if (!fs.existsSync(metadata)) continue;
    const value = parseFileRecoveryMetadata(metadata);
    if (value.target_path !== target.path) continue;
    if (value.before_sha256 !== sha256(before) || value.after_sha256 !== sha256(after)) {
      conflict(`plan replacement target '${target.path}' retained recovery role digests do not match its pending journal`);
    }
    const names = fs.readdirSync(directory).sort();
    if (names.some((name) => !["original.previous", "replacement.tmp", FILE_REPLACEMENT_METADATA_NAME].includes(name))) {
      conflict(`plan replacement target '${target.path}' retained recovery attempt contains an unknown role`);
    }
    const previous = path.join(directory, "original.previous");
    const stage = path.join(directory, "replacement.tmp");
    if (fs.existsSync(previous) && !roleBytes(previous, "prior-byte role").equals(before)) {
      conflict(`plan replacement target '${target.path}' retained prior-byte role changed`);
    }
    if (fs.existsSync(stage) && !roleBytes(stage, "replacement stage").equals(after)) {
      conflict(`plan replacement target '${target.path}' retained replacement stage changed`);
    }
    matches.push({
      directory,
      identity,
      metadata,
      ...(fs.existsSync(previous) ? { previous } : {}),
      ...(fs.existsSync(stage) ? { stage } : {}),
    });
  }
  if (matches.length > 1) conflict(`plan replacement target '${target.path}' has multiple retained recovery attempts`);
  const match = matches[0];
  if (!match) return;
  const current = bytesAt(root, target.path);
  if (!same(current, before) && !same(current, after)) {
    conflict(`plan replacement target '${target.path}' has concurrent canonical bytes beside retained recovery roles`);
  }
  validateEntityRecoveryDirectory(context.validatedRoot, recoveryRoot, targetDirectory, "private entity recovery root '.agentera/.entity-recovery'", recoveryRootIdentity);
  validateEntityRecoveryDirectory(context.validatedRoot, match.directory, targetDirectory, `private entity recovery attempt '${path.relative(root, match.directory).split(path.sep).join("/")}'`, match.identity);
  if (match.stage) removeExactRole(match.stage, after);
  if (match.previous) removeExactRole(match.previous, before);
  removeExactRole(match.metadata, roleBytes(match.metadata, "replacement metadata"));
  fs.rmdirSync(match.directory);
  fsyncDirectory(recoveryRoot);
}

function applyTarget(context: EntityPublicationContext, sourceRoot: string, target: JournalTarget): PublishedTargetIdentity | null {
  const root = context.pinnedPath();
  recoverImmutableStage(root, target);
  recoverReplacementRoles(context, target);
  const before = target.before === null ? null : decode(target.before);
  const after = decode(target.after);
  const current = bytesAt(root, target.path);
  if (same(current, after)) return null;
  if (!same(current, before)) {
    conflict(`plan replacement target '${target.path}' changed after journal preparation`);
  }
  if (before === null) {
    const identity = context.publishImmutable(target.path, after.toString("utf8"));
    if (!identity) conflict(`plan replacement target '${target.path}' appeared during publication`);
    return identity;
  }
  return context.replaceExisting(target.path, before, after.toString("utf8"), entityExactGetMaxBytes(sourceRoot)).publishedIdentity;
}

function rollback(context: EntityPublicationContext, sourceRoot: string, applied: AppliedTarget[]): string[] {
  const failures: string[] = [];
  for (const { target, identity } of [...applied].reverse()) {
    try {
      if (target.before === null) {
        const result = context.removeExact(target.path, identity, false);
        if (result !== "removed") throw new Error(`exact removal returned ${result}`);
      } else {
        context.restoreExact(target.path, identity, decode(target.before).toString("utf8"), entityExactGetMaxBytes(sourceRoot));
      }
    } catch (error) {
      failures.push(`${target.path}: ${(error as Error).message}`);
    }
  }
  return failures;
}

function finishJournal(context: EntityPublicationContext, relative: string, bytes: Buffer, knownIdentity?: PublishedTargetIdentity): void {
  const identity = knownIdentity ?? context.replaceExisting(relative, bytes, bytes.toString("utf8"), MAX_JOURNAL_BYTES).publishedIdentity;
  if (context.removeExact(relative, identity) !== "removed") {
    throw new Error(`plan replacement journal '${relative}' changed before cleanup`);
  }
}

function completeJournal(context: EntityPublicationContext, sourceRoot: string, journal: Journal, bytes: Buffer, relative: string, options: PlanReplacementTransactionOptions, knownIdentity?: PublishedTargetIdentity): void {
  const applied: AppliedTarget[] = [];
  try {
    for (const target of journal.targets) {
      const identity = applyTarget(context, sourceRoot, target);
      if (identity) applied.push({ target, identity });
    }
    options.validate();
    context.assertValid();
    finishJournal(context, relative, bytes, knownIdentity);
  } catch (error) {
    const failures = rollback(context, sourceRoot, applied);
    if (failures.length) {
      conflict(`plan replacement could not restore every target after failure: ${failures.join("; ")}`);
    }
    throw error;
  }
}

export function recoverPendingPlanReplacement(context: EntityPublicationContext, sourceRoot: string, retry: PlanReplacementRetry, options: PlanReplacementTransactionOptions): PendingPlanReplacement | null {
  const root = context.pinnedPath();
  let pending: PendingPlanReplacement | null;
  try {
    pending = inspectPendingPlanReplacement(root);
  } catch (error) {
    reject({
      class: "conflict",
      message: `pending plan replacement journal is invalid: ${(error as Error).message}`,
      recovery: "Preserve '.agentera/.entity-recovery/plan-replacement', restore its last valid journal bytes, and retry the exact non-dry-run plan replacement; no journal target bytes were changed.",
    });
  }
  if (!pending) return null;
  const name = pendingJournalNames(root)[0]!;
  const file = path.join(root, DIRECTORY, name);
  const bytes = fs.readFileSync(file);
  const journal = parseJournal(bytes, name);
  assertExactRetry(journal, retry);
  completeJournal(context, sourceRoot, journal, bytes, journalPath(journal.id), options);
  return pending;
}

export function publishPlanReplacement(context: EntityPublicationContext, sourceRoot: string, operation: PlanReplacementOperation, targets: PlanReplacementTarget[], options: PlanReplacementTransactionOptions): void {
  if (
    !ID.test(operation.predecessor) ||
    !ID.test(operation.successor) ||
    operation.predecessor === operation.successor ||
    !/^[a-f0-9]{64}$/.test(operation.inputSha256) ||
    targets.length < 2 ||
    targets.length > MAX_TARGETS ||
    new Set(targets.map((target) => target.path)).size !== targets.length ||
    targets.some((target) => !TARGET.test(target.path) || Buffer.byteLength(target.after) > MAX_TARGET_BYTES || (target.before !== null && target.before.length > MAX_TARGET_BYTES))
  ) {
    reject({
      class: "schema_violation",
      message: "plan replacement transaction has invalid bounded targets",
      recovery: "Recompute the complete plan replacement target set from the locked canonical snapshot and retry; no state was changed.",
    });
  }
  const body = targets.map((target) => ({
    path: target.path,
    before: target.before === null ? null : encode(target.before),
    after: encode(target.after),
  }));
  const journalOperation: JournalOperation = {
    kind: operation.kind,
    predecessor: operation.predecessor,
    successor: operation.successor,
    input_sha256: operation.inputSha256,
  };
  const id = sha256(canonicalRecordJson({ operation: journalOperation, targets: body })).slice(0, 24);
  const journal: Journal = {
    schema_version: VERSION,
    id,
    operation: journalOperation,
    targets: body,
  };
  const bytes = Buffer.from(`${JSON.stringify(journal)}\n`);
  parseJournal(bytes, `${id}.json`);
  const relative = journalPath(id);
  recoverImmutableStage(context.pinnedPath(), {
    path: relative,
    before: null,
    after: bytes.toString("base64"),
  });
  const identity = context.publishImmutable(relative, bytes.toString("utf8"));
  if (!identity) {
    conflict(`plan replacement journal '${id}' already exists; retry the exact operation once so it can be recovered before another target set is prepared`);
  }
  completeJournal(context, sourceRoot, journal, bytes, relative, options, identity);
}
