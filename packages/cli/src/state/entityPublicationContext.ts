import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ExactReplacementConflictError, FileReplacementError } from "./exactReplacementRecovery.js";
import { assertValidatedProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { reject, StateWriteInputError } from "./write/errors.js";

const RECOVERY_IGNORE_BYTES = "*\n!.gitignore\n";
export const FILE_REPLACEMENT_RECOVERY_VERSION = "agentera.fileReplacementRecovery.v1";
export const FILE_REPLACEMENT_METADATA_NAME = "replacement.json";

interface PathIdentity {
  dev: bigint;
  ino: bigint;
  type: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
  mode: bigint;
}

interface StableFile {
  absolute: string;
  identity: PathIdentity;
  bytes: Buffer;
}

interface StableDirectory {
  absolute: string;
  dev: bigint;
  ino: bigint;
  created: boolean;
}

export interface EntityRecoveryDirectoryIdentity {
  absolute: string;
  dev: bigint;
  ino: bigint;
}

interface RecoveryAttempt {
  root: StableDirectory;
  attempt: StableDirectory;
  ignore: StableFile;
  relativePath: string;
}

export interface PublishedTargetIdentity {
  dev: bigint;
  ino: bigint;
  type: bigint;
  size: bigint;
  sha256: string;
}

export interface ExactReplacementResult {
  previousBytes: string;
  publishedIdentity: PublishedTargetIdentity;
}

export type ExactRemovalResult = "removed" | "absent" | "identity_mismatch";

function identity(stat: fs.BigIntStats): PathIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    type: stat.mode & BigInt(fs.constants.S_IFMT),
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    nlink: stat.nlink,
    mode: stat.mode,
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.type === right.type
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

function sameDirectory(left: StableDirectory, right: fs.BigIntStats): boolean {
  return right.isDirectory()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function publishedIdentity(file: StableFile): PublishedTargetIdentity {
  return {
    dev: file.identity.dev,
    ino: file.identity.ino,
    type: file.identity.type,
    size: file.identity.size,
    sha256: sha256(file.bytes),
  };
}

function matchesPublished(file: StableFile, expected: PublishedTargetIdentity): boolean {
  const observed = publishedIdentity(file);
  return observed.dev === expected.dev
    && observed.ino === expected.ino
    && observed.type === expected.type
    && observed.size === expected.size
    && observed.sha256 === expected.sha256;
}

function matchesExpected(file: StableFile, expected: Buffer | PublishedTargetIdentity): boolean {
  return Buffer.isBuffer(expected) ? file.bytes.equals(expected) : matchesPublished(file, expected);
}

function sameStableFile(left: StableFile, right: StableFile): boolean {
  return sameIdentity(left.identity, right.identity) && left.bytes.equals(right.bytes);
}

function readStableFile(absolute: string, label: string): StableFile {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    throw new Error(`${label} is unavailable: ${(error as Error).message}`, { cause: error });
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a safe regular file`);
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(absolute, { bigint: true });
    const openedIdentity = identity(opened);
    if (
      !sameIdentity(openedIdentity, identity(after))
      || !sameIdentity(openedIdentity, identity(pathname))
      || BigInt(bytes.length) !== opened.size
    ) throw new Error(`${label} changed while its exact bytes were read`);
    return { absolute, identity: identity(after), bytes };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readFileIfPresent(absolute: string, label: string): StableFile | null {
  try {
    fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return readStableFile(absolute, label);
}

function readStableDirectory(absolute: string, created = false): StableDirectory {
  const stat = fs.lstatSync(absolute, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`publication directory '${absolute}' is not a safe real directory`);
  }
  return { absolute, dev: stat.dev, ino: stat.ino, created };
}

function projectLocalPath(root: ValidatedProjectRoot, absolute: string, allowRoot = false): boolean {
  const resolved = path.resolve(absolute);
  const relative = path.relative(root.path, resolved);
  return resolved === absolute
    && (allowRoot || relative.length > 0)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** Validate a recovery directory before listing or mutating anything through it. */
export function validateEntityRecoveryDirectory(
  root: ValidatedProjectRoot,
  absolute: string,
  targetDirectory: string,
  label: string,
  expected?: EntityRecoveryDirectoryIdentity,
): EntityRecoveryDirectoryIdentity {
  assertValidatedProjectRoot(root);
  if (!projectLocalPath(root, absolute) || !projectLocalPath(root, targetDirectory, true)) {
    throw new FileReplacementError(`${label} must be a real project-local directory under the validated project root`);
  }
  let directory: StableDirectory;
  let target: StableDirectory;
  try {
    directory = readStableDirectory(absolute);
    target = readStableDirectory(targetDirectory);
    if (fs.realpathSync(absolute) !== absolute || fs.realpathSync(targetDirectory) !== targetDirectory) {
      throw new Error("a directory path traverses a symbolic link");
    }
  } catch (error) {
    throw new FileReplacementError(`${label} must be a real project-local non-symlink directory: ${(error as Error).message}`, error);
  }
  if (typeof process.getuid === "function") {
    const stat = fs.lstatSync(directory.absolute, { bigint: true });
    if ((stat.mode & 0o022n) !== 0n || stat.uid !== BigInt(process.getuid())) {
      throw new FileReplacementError(`${label} must be owned by the current user and not group/world-writable`);
    }
  }
  if (directory.dev !== target.dev) {
    throw new FileReplacementError(`${label} must share the replacement target filesystem`);
  }
  if (expected && (
    directory.absolute !== expected.absolute
    || directory.dev !== expected.dev
    || directory.ino !== expected.ino
  )) {
    throw new FileReplacementError(`${label} changed after its recovery boundary was validated`);
  }
  return { absolute: directory.absolute, dev: directory.dev, ino: directory.ino };
}

function syncDirectory(absolute: string): void {
  if (process.platform === "win32") return;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function syncDirectoryBestEffort(absolute: string): void {
  try { syncDirectory(absolute); } catch { /* The canonical rename already linearized. */ }
}

function safeSegments(relativeTarget: string, label: string): string[] {
  const segments = relativeTarget.split(/[\\/]/).filter(Boolean);
  if (
    segments.length < 1
    || path.posix.isAbsolute(relativeTarget)
    || path.win32.isAbsolute(relativeTarget)
    || relativeTarget.includes("\0")
    || segments.includes("..")
    || segments.includes(".")
  ) reject({
    class: "unsupported_target",
    message: `${label} '${relativeTarget}' is outside the validated project path grammar`,
    recovery: "Use one project-relative path without symbolic, dot, parent, drive, UNC, or absolute segments; no state was changed.",
  });
  return segments;
}

function relativeDisplay(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function removeExactFile(file: StableFile): boolean {
  const current = readFileIfPresent(file.absolute, `attempt-owned file '${file.absolute}'`);
  if (!current || !sameStableFile(file, current)) return false;
  fs.unlinkSync(file.absolute);
  return true;
}

function createDurableFile(absolute: string, bytes: Buffer | string, mode = 0o600): StableFile {
  let descriptor: number | undefined;
  let opened: PathIdentity | undefined;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      mode,
    );
    opened = identity(fs.fstatSync(descriptor, { bigint: true }));
    fs.writeFileSync(descriptor, bytes);
    if (typeof process.getuid === "function") fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the primary failure. */ }
      descriptor = undefined;
    }
    if (opened) {
      try {
        const current = readFileIfPresent(absolute, `failed stage '${absolute}'`);
        if (current && sameIdentity(opened, current.identity)) fs.unlinkSync(absolute);
      } catch { /* Preserve changed or partially inspectable attempt state. */ }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return readStableFile(absolute, `durable stage '${absolute}'`);
}

function publicationConflict(markerPath: string): never {
  reject({
    class: "conflict",
    message: `state mode marker '${markerPath}' changed after entity mode detection; this is a conflict and cannot fall back to legacy state`,
    syntax: "agentera state <artifact-id> <verb> ... --format json",
    example: `restore the exact '${markerPath}' marker selected at command start and retry`,
  });
}

function initializationConflict(markerPath: string): never {
  reject({
    class: "conflict",
    message: `state mode marker '${markerPath}' appeared during fresh plan initialization`,
    syntax: "agentera state plan create --input PLAN.yaml --format json",
    example: "remove no files; inspect the competing state publication and retry",
  });
}

/**
 * Binds mutations to a validated project and exact entity-mode marker. Every
 * pathname and byte identity is checked at declared boundaries. Publication
 * linearizes through standard complete-file link or rename operations; a
 * non-cooperating writer that races after the final successful check is outside
 * the contract and is not represented as a cross-process compare-and-swap.
 */
export class EntityPublicationContext {
  readonly projectRoot: string;
  readonly validatedRoot: ValidatedProjectRoot;
  readonly markerPath: string;

  private marker: StableFile | null;
  private readonly createdDirectories = new Map<string, StableDirectory>();
  private closed = false;

  private constructor(root: ValidatedProjectRoot, markerPath: string, expectedBytes: Buffer | null) {
    this.projectRoot = root.path;
    this.validatedRoot = root;
    this.markerPath = markerPath;
    const markerAbsolute = path.join(root.path, ...safeSegments(markerPath, "state mode marker"));
    if (expectedBytes === null) {
      if (readFileIfPresent(markerAbsolute, `state mode marker '${markerPath}'`)) initializationConflict(markerPath);
      this.marker = null;
    } else {
      this.marker = readStableFile(markerAbsolute, `state mode marker '${markerPath}'`);
      if (!this.marker.bytes.equals(expectedBytes)) publicationConflict(markerPath);
    }
    this.assertValid();
  }

  static open(root: ValidatedProjectRoot, markerPath: string, expectedBytes: Buffer): EntityPublicationContext {
    return new EntityPublicationContext(root, markerPath, expectedBytes);
  }

  static beginInitialization(root: ValidatedProjectRoot, markerPath: string): EntityPublicationContext {
    return new EntityPublicationContext(root, markerPath, null);
  }

  pinnedPath(relativePath = ""): string {
    if (this.closed) throw new Error("entity publication context is closed");
    if (!relativePath) return this.projectRoot;
    return path.join(this.projectRoot, ...safeSegments(relativePath, "entity publication path"));
  }

  assertValid(): void {
    if (this.closed) throw new Error("entity publication context is closed");
    assertValidatedProjectRoot(this.validatedRoot);
    if (this.marker === null) {
      try {
        if (readFileIfPresent(path.join(this.projectRoot, ...safeSegments(this.markerPath, "state mode marker")), `state mode marker '${this.markerPath}'`)) {
          initializationConflict(this.markerPath);
        }
      } catch {
        initializationConflict(this.markerPath);
      }
      return;
    }
    let current: StableFile;
    try { current = readStableFile(this.marker.absolute, `state mode marker '${this.markerPath}'`); }
    catch { publicationConflict(this.markerPath); }
    if (!sameStableFile(this.marker, current!)) publicationConflict(this.markerPath);
  }

  publishImmutable(relativeTarget: string, bytes: string): PublishedTargetIdentity | null {
    return this.publishImmutableInternal(relativeTarget, bytes, false);
  }

  isInitializing(): boolean {
    return this.marker === null;
  }

  publishStateMarker(bytes: string): PublishedTargetIdentity {
    if (this.marker !== null) throw new Error("entity state marker is already active");
    const published = this.publishImmutableInternal(this.markerPath, bytes, true);
    if (!published) initializationConflict(this.markerPath);
    return published;
  }

  private publishImmutableInternal(
    relativeTarget: string,
    bytes: string,
    activateMarker: boolean,
  ): PublishedTargetIdentity | null {
    const segments = safeSegments(relativeTarget, "immutable entity target");
    if (segments.length < 2) throw new Error(`unsafe immutable entity target '${relativeTarget}'`);
    if (activateMarker && relativeTarget !== this.markerPath) throw new Error("only the state mode marker can activate fresh entity state");
    const directories: StableDirectory[] = [];
    const target = path.join(this.projectRoot, ...segments);
    let stage: StableFile | undefined;
    let published: StableFile | undefined;
    let publicationOwned = false;
    try {
      directories.push(...this.openDirectories(segments.slice(0, -1), true)!);
      const directory = directories.at(-1)?.absolute ?? this.projectRoot;
      const existing = readFileIfPresent(target, `immutable entity target '${relativeTarget}'`);
      if (existing) {
        this.removeCreatedDirectories(directories);
        return null;
      }
      const stagePath = path.join(directory, `.${segments.at(-1)!}.${process.pid}.${randomUUID()}.tmp`);
      stage = createDurableFile(stagePath, bytes);
      this.assertBoundary(directories, undefined, [stage]);
      if (readFileIfPresent(target, `immutable entity target '${relativeTarget}'`)) {
        removeExactFile(stage); stage = undefined;
        this.removeCreatedDirectories(directories);
        return null;
      }
      try { fs.linkSync(stage.absolute, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          removeExactFile(stage); stage = undefined;
          this.removeCreatedDirectories(directories);
          return null;
        }
        throw new FileReplacementError(`immutable publication for '${relativeTarget}' failed before effects`, error);
      }
      syncDirectory(directory);
      stage = readStableFile(stage.absolute, `immutable publication stage '${relativeTarget}'`);
      published = readStableFile(target, `published entity '${relativeTarget}'`);
      if (!published.bytes.equals(Buffer.from(bytes)) || published.identity.ino !== stage.identity.ino || published.identity.dev !== stage.identity.dev) {
        throw new ExactReplacementConflictError(`immutable entity target '${relativeTarget}' changed at its publication boundary`);
      }
      publicationOwned = true;
      if (activateMarker) this.marker = published;
      this.assertBoundary(directories, published, [stage]);
      removeExactFile(stage); stage = undefined;
      syncDirectory(directory);
      published = readStableFile(target, `published entity '${relativeTarget}'`);
      if (activateMarker) this.marker = published;
      this.assertBoundary(directories, published);
      for (const entry of directories.filter(({ created }) => created)) {
        this.createdDirectories.set(relativeDisplay(this.projectRoot, entry.absolute), entry);
      }
      return publishedIdentity(published);
    } catch (error) {
      if (activateMarker) this.marker = null;
      if (publicationOwned && published) {
        if (stage) {
          try { if (removeExactFile(stage)) stage = undefined; } catch { /* Preserve changed attempt bytes. */ }
        }
        if (!stage) {
          try {
            const current = readFileIfPresent(target, `failed immutable publication '${relativeTarget}'`);
            if (current && matchesPublished(current, publishedIdentity(published))) removeExactFile(current);
          } catch { /* Preserve a changed successor. */ }
        }
      }
      if (stage) {
        try { removeExactFile(stage); } catch { /* Preserve changed attempt bytes. */ }
      }
      this.removeCreatedDirectories(directories);
      throw error;
    }
  }

  publishPreowned(relativeTarget: string, relativeReceipt: string, expected: PublishedTargetIdentity): PublishedTargetIdentity {
    const targetSegments = safeSegments(relativeTarget, "preowned target");
    const receiptSegments = safeSegments(relativeReceipt, "preowned receipt");
    if (targetSegments.length < 2 || receiptSegments.length < 2) throw new Error("unsafe preowned publication path");
    this.assertValid();
    const receipt = readStableFile(path.join(this.projectRoot, ...receiptSegments), `preowned receipt '${relativeReceipt}'`);
    if (!matchesPublished(receipt, expected)) throw new Error(`preowned receipt '${relativeReceipt}' changed before publication`);
    const directories = this.openDirectories(targetSegments.slice(0, -1), true)!;
    const directory = directories.at(-1)?.absolute ?? this.projectRoot;
    const target = path.join(directory, targetSegments.at(-1)!);
    try {
      this.assertBoundary(directories, undefined, [receipt]);
      if (!readFileIfPresent(target, `preowned target '${relativeTarget}'`)) {
        try { fs.linkSync(receipt.absolute, target); syncDirectory(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const published = readStableFile(target, `preowned target '${relativeTarget}'`);
      if (!matchesPublished(published, expected) || published.identity.dev !== receipt.identity.dev || published.identity.ino !== receipt.identity.ino) {
        throw new Error(`canonical target '${relativeTarget}' collides with migration ownership receipt; byte-identical replacement inodes are never adopted`);
      }
      this.assertBoundary(directories, published, [receipt]);
      for (const entry of directories.filter(({ created }) => created)) {
        this.createdDirectories.set(relativeDisplay(this.projectRoot, entry.absolute), entry);
      }
      return publishedIdentity(published);
    } catch (error) {
      this.removeCreatedDirectories(directories);
      throw error;
    }
  }

  removeExact(relativeTarget: string, expected: PublishedTargetIdentity, verifyContext = true): ExactRemovalResult {
    const segments = safeSegments(relativeTarget, "exact removal target");
    const directories = this.openDirectories(segments.slice(0, -1), false, true, verifyContext);
    if (!directories) return "absent";
    const directory = directories.at(-1)?.absolute ?? this.projectRoot;
    const target = path.join(directory, segments.at(-1)!);
    const current = readFileIfPresent(target, `exact removal target '${relativeTarget}'`);
    if (!current) return "absent";
    if (!matchesPublished(current, expected)) return "identity_mismatch";
    this.assertBoundary(directories, current, [], verifyContext);
    const confirmed = readStableFile(target, `exact removal target '${relativeTarget}'`);
    if (!sameStableFile(current, confirmed)) return "identity_mismatch";
    fs.unlinkSync(target);
    syncDirectory(directory);
    if (relativeTarget === this.markerPath) this.marker = null;
    this.removeAttemptDirectories();
    return "removed";
  }

  replaceExisting(relativeTarget: string, expectedBytes: Buffer, bytes: string, maxEntityBytes: number): ExactReplacementResult {
    return this.replaceOwned(relativeTarget, expectedBytes, bytes, maxEntityBytes);
  }

  replaceVisible(relativeTarget: string, expectedBytes: Buffer, bytes: string, maxEntityBytes: number): ExactReplacementResult {
    return this.replaceOwned(relativeTarget, expectedBytes, bytes, maxEntityBytes);
  }

  restoreExact(relativeTarget: string, expected: PublishedTargetIdentity, bytes: string, maxEntityBytes: number): ExactReplacementResult {
    return this.replaceOwned(relativeTarget, expected, bytes, maxEntityBytes, false);
  }

  restoreVisible(relativeTarget: string, expected: PublishedTargetIdentity, bytes: string, maxEntityBytes: number): ExactReplacementResult {
    return this.replaceOwned(relativeTarget, expected, bytes, maxEntityBytes, false);
  }

  close(): void {
    this.closed = true;
  }

  private replaceOwned(
    relativeTarget: string,
    expected: Buffer | PublishedTargetIdentity,
    bytes: string,
    maxEntityBytes: number,
    verifyContext = true,
  ): ExactReplacementResult {
    const segments = safeSegments(relativeTarget, "recoverable replacement target");
    const directories = this.openDirectories(segments.slice(0, -1), false, false, verifyContext);
    if (!directories) throw new FileReplacementError(`replacement target '${relativeTarget}' is absent before publication`);
    const directory = directories.at(-1)?.absolute ?? this.projectRoot;
    const target = path.join(directory, segments.at(-1)!);
    const baseline = readStableFile(target, `replacement target '${relativeTarget}'`);
    if (!matchesExpected(baseline, expected)) {
      throw new ExactReplacementConflictError(`target '${relativeTarget}' ownership or bytes changed before replacement; the detected change was preserved`);
    }
    if (!Number.isSafeInteger(maxEntityBytes) || maxEntityBytes < 1 || baseline.bytes.length > maxEntityBytes) {
      throw new FileReplacementError(`target '${relativeTarget}' exact ${baseline.bytes.length}-byte baseline exceeds the authority-owned ${maxEntityBytes}-byte recovery limit`);
    }
    const after = Buffer.from(bytes);
    let recovery: RecoveryAttempt | undefined;
    let backup: StableFile | undefined;
    let stage: StableFile | undefined;
    let metadata: StableFile | undefined;
    let committed: ExactReplacementResult | undefined;
    let renameCompleted = false;
    try {
      recovery = this.createRecoveryAttempt(directory);
      backup = createDurableFile(path.join(recovery.attempt.absolute, "original.previous"), baseline.bytes);
      stage = createDurableFile(
        path.join(recovery.attempt.absolute, "replacement.tmp"),
        after,
        Number(baseline.identity.mode & 0o7777n),
      );
      metadata = createDurableFile(path.join(recovery.attempt.absolute, FILE_REPLACEMENT_METADATA_NAME), `${JSON.stringify({
        schema_version: FILE_REPLACEMENT_RECOVERY_VERSION,
        target_path: segments.join("/"),
        before_sha256: sha256(baseline.bytes),
        after_sha256: sha256(after),
      })}\n`);
      syncDirectory(recovery.attempt.absolute);
      this.assertBoundary(directories, baseline, [backup, stage, metadata], verifyContext);
      const boundaryTarget = readStableFile(target, `replacement target '${relativeTarget}'`);
      if (!sameStableFile(boundaryTarget, baseline)) {
        throw new ExactReplacementConflictError(`target '${relativeTarget}' changed at the final validation boundary; the detected change was preserved`);
      }
      try { fs.renameSync(stage.absolute, target); renameCompleted = true; }
      catch (error) {
        throw new FileReplacementError(`complete-file replacement for '${relativeTarget}' failed before publication${(error as NodeJS.ErrnoException).code ? ` (${(error as NodeJS.ErrnoException).code})` : ""}`, error);
      }
      syncDirectory(directory);
      syncDirectory(recovery.attempt.absolute);
      const published = readStableFile(target, `published replacement '${relativeTarget}'`);
      if (!published.bytes.equals(after)) {
        throw new ExactReplacementConflictError(`target '${relativeTarget}' changed through the publication boundary`);
      }
      this.assertBoundary(directories, published, [backup, metadata], verifyContext);
      committed = { previousBytes: baseline.bytes.toString("utf8"), publishedIdentity: publishedIdentity(published) };
      this.cleanupCommittedReplacement(recovery.attempt.absolute, [backup, metadata]);
      backup = undefined;
      metadata = undefined;
      stage = undefined;
      return committed;
    } catch (error) {
      if (committed) return committed;
      let current: StableFile | null = null;
      try { current = readFileIfPresent(target, `replacement target '${relativeTarget}'`); } catch { /* Preserve all recovery evidence. */ }
      if (!renameCompleted && error instanceof ExactReplacementConflictError) {
        const retained = this.cleanupAttemptFiles([stage, backup, metadata]);
        stage = undefined; backup = undefined; metadata = undefined;
        if (retained.length) {
          throw new ExactReplacementConflictError(`${error.message}; cleanup retained changed recovery roles`, retained);
        }
        throw error;
      }
      if (renameCompleted && current?.bytes.equals(after) && backup) {
        try {
          this.assertBoundary(directories, current, [backup], false);
          fs.renameSync(backup.absolute, target);
          backup = undefined;
          syncDirectory(directory);
          const restored = readStableFile(target, `restored replacement target '${relativeTarget}'`);
          if (!restored.bytes.equals(baseline.bytes)) throw new Error("restored bytes do not match the exact baseline");
          if (stage) { try { removeExactFile(stage); } catch { /* Preserve changed stage. */ } stage = undefined; }
          if (metadata) { try { removeExactFile(metadata); } catch { /* Preserve changed metadata. */ } metadata = undefined; }
          syncDirectoryBestEffort(recovery?.attempt.absolute ?? directory);
          throw new FileReplacementError(`${(error as Error).message}; restored exact prior bytes at '${relativeTarget}'`, error);
        } catch (restoreError) {
          if (restoreError instanceof FileReplacementError && restoreError.cause === error) throw restoreError;
        }
      }
      if (!renameCompleted && current && sameStableFile(current, baseline)) {
        const retained = this.cleanupAttemptFiles([stage, backup, metadata]);
        stage = undefined; backup = undefined; metadata = undefined;
        if (retained.length) {
          throw new ExactReplacementConflictError(`${(error as Error).message}; cleanup retained changed recovery roles`, retained);
        }
        if (error instanceof ExactReplacementConflictError || error instanceof FileReplacementError || error instanceof StateWriteInputError) throw error;
        throw new FileReplacementError(`${(error as Error).message}; target bytes remained unchanged`, error);
      }
      const retained = [backup, stage, metadata]
        .filter((file): file is StableFile => Boolean(file && fs.existsSync(file.absolute)))
        .map((file) => relativeDisplay(this.projectRoot, file.absolute));
      throw new ExactReplacementConflictError(
        `${(error as Error).message}; recoverable publication did not report success and preserved the canonical target plus ${retained.length} bounded recovery role${retained.length === 1 ? "" : "s"}`,
        retained,
      );
    } finally {
      if (recovery) this.closeRecoveryAttempt(recovery);
    }
  }

  private openDirectories(segments: string[], create: boolean, missingIsAbsent = false, verifyContext = true): StableDirectory[] | null {
    const directories: StableDirectory[] = [];
    let parent = this.projectRoot;
    for (const segment of segments) {
      if (verifyContext) this.assertValid();
      else assertValidatedProjectRoot(this.validatedRoot);
      const absolute = path.join(parent, segment);
      let entry: StableDirectory;
      try { entry = readStableDirectory(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message.includes("ENOENT")) {
          if (missingIsAbsent) return null;
          if (!create) throw error;
          this.assertBoundary(directories, undefined, [], verifyContext);
          fs.mkdirSync(absolute, 0o700);
          syncDirectory(parent);
          entry = readStableDirectory(absolute, true);
        } else throw error;
      }
      directories.push(entry);
      parent = absolute;
    }
    return directories;
  }

  private assertBoundary(
    directories: StableDirectory[],
    target?: StableFile,
    roles: StableFile[] = [],
    verifyContext = true,
  ): void {
    if (verifyContext) this.assertValid();
    else assertValidatedProjectRoot(this.validatedRoot);
    for (const directory of directories) {
      let current: fs.BigIntStats;
      try { current = fs.lstatSync(directory.absolute, { bigint: true }); }
      catch { throw new ExactReplacementConflictError(`publication directory '${relativeDisplay(this.projectRoot, directory.absolute)}' changed at a validation boundary`); }
      if (!sameDirectory(directory, current)) {
        throw new ExactReplacementConflictError(`publication directory '${relativeDisplay(this.projectRoot, directory.absolute)}' changed at a validation boundary`);
      }
    }
    if (target) {
      const current = readFileIfPresent(target.absolute, `publication target '${relativeDisplay(this.projectRoot, target.absolute)}'`);
      if (!current || !sameStableFile(target, current)) {
        throw new ExactReplacementConflictError(`publication target '${relativeDisplay(this.projectRoot, target.absolute)}' changed at a validation boundary`);
      }
    }
    for (const role of roles) {
      const current = readFileIfPresent(role.absolute, `publication role '${relativeDisplay(this.projectRoot, role.absolute)}'`);
      if (!current || !sameStableFile(role, current)) {
        throw new ExactReplacementConflictError(`publication recovery role '${relativeDisplay(this.projectRoot, role.absolute)}' changed at a validation boundary`);
      }
    }
  }

  private createRecoveryAttempt(targetDirectory: string): RecoveryAttempt {
    const agentera = readStableDirectory(path.join(this.projectRoot, ".agentera"));
    const rootPath = path.join(agentera.absolute, ".entity-recovery");
    let rootCreated = false;
    let ignoreCreated = false;
    let root: StableDirectory | undefined;
    let ignore: StableFile | undefined;
    let attempt: StableDirectory | undefined;
    try {
      try { root = readStableDirectory(rootPath); }
      catch (error) {
        if (!(error as Error).message.includes("ENOENT")) {
          throw new FileReplacementError(`private entity recovery root '.agentera/.entity-recovery' cannot be opened safely: ${(error as Error).message}`, error);
        }
        fs.mkdirSync(rootPath, 0o700); rootCreated = true; syncDirectory(agentera.absolute);
        root = readStableDirectory(rootPath, true);
      }
      const trustedRoot = validateEntityRecoveryDirectory(
        this.validatedRoot,
        root.absolute,
        targetDirectory,
        "private entity recovery root '.agentera/.entity-recovery'",
        root,
      );
      root = { ...trustedRoot, created: rootCreated };
      const ignorePath = path.join(root.absolute, ".gitignore");
      const existingIgnore = readFileIfPresent(ignorePath, "private entity recovery ignore marker");
      if (existingIgnore) ignore = existingIgnore;
      else { ignore = createDurableFile(ignorePath, RECOVERY_IGNORE_BYTES); ignoreCreated = true; }
      if (!ignore.bytes.equals(Buffer.from(RECOVERY_IGNORE_BYTES))) {
        throw new FileReplacementError("private entity recovery ignore marker must contain the authoritative rules");
      }
      const ignoreStat = fs.lstatSync(ignore.absolute, { bigint: true });
      if (typeof process.getuid === "function" && ((ignoreStat.mode & 0o022n) !== 0n || ignoreStat.uid !== BigInt(process.getuid()))) {
        throw new FileReplacementError("private entity recovery ignore marker must be owner-controlled and not group/world-writable");
      }
      syncDirectory(root.absolute);
      for (let index = 0; index < 8; index += 1) {
        const attemptPath = path.join(root.absolute, `entity-${process.pid}-${randomUUID()}`);
        try {
          fs.mkdirSync(attemptPath, 0o700);
          const opened = readStableDirectory(attemptPath, true);
          attempt = opened;
          const trusted = validateEntityRecoveryDirectory(
            this.validatedRoot,
            attemptPath,
            targetDirectory,
            `private entity recovery attempt '${relativeDisplay(this.projectRoot, attemptPath)}'`,
            opened,
          );
          attempt = { ...trusted, created: true };
          break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (!attempt) throw new FileReplacementError("could not allocate a unique private entity recovery attempt after 8 tries");
      syncDirectory(root.absolute);
      return { root, attempt, ignore, relativePath: relativeDisplay(this.projectRoot, attempt.absolute) };
    } catch (error) {
      if (attempt) { try { fs.rmdirSync(attempt.absolute); } catch { /* Preserve unexpected contents. */ } }
      if (ignore && ignoreCreated) { try { removeExactFile(ignore); } catch { /* Preserve changed marker. */ } }
      if (root && rootCreated) { try { fs.rmdirSync(root.absolute); } catch { /* Preserve non-empty root. */ } }
      throw error;
    }
  }

  private cleanupAttemptFiles(files: Array<StableFile | undefined>): string[] {
    const retained: string[] = [];
    for (const file of files) {
      if (!file) continue;
      try {
        if (!removeExactFile(file) && fs.existsSync(file.absolute)) retained.push(relativeDisplay(this.projectRoot, file.absolute));
      } catch { retained.push(relativeDisplay(this.projectRoot, file.absolute)); }
    }
    return retained;
  }

  private cleanupCommittedReplacement(directory: string, files: StableFile[]): void {
    this.cleanupAttemptFiles(files);
    syncDirectoryBestEffort(directory);
  }

  private closeRecoveryAttempt(recovery: RecoveryAttempt): void {
    try { fs.rmdirSync(recovery.attempt.absolute); syncDirectoryBestEffort(recovery.root.absolute); }
    catch { return; }
    try {
      const names = fs.readdirSync(recovery.root.absolute);
      if (names.length === 1 && names[0] === ".gitignore") {
        removeExactFile(recovery.ignore);
        syncDirectoryBestEffort(recovery.root.absolute);
      }
      if (fs.readdirSync(recovery.root.absolute).length === 0) {
        fs.rmdirSync(recovery.root.absolute);
        syncDirectoryBestEffort(path.dirname(recovery.root.absolute));
      }
    } catch { /* Preserve non-empty or changed recovery authority. */ }
  }

  private removeCreatedDirectories(directories: StableDirectory[]): void {
    for (const directory of [...directories].reverse()) {
      if (!directory.created) continue;
      try {
        const current = fs.lstatSync(directory.absolute, { bigint: true });
        if (!sameDirectory(directory, current)) continue;
        fs.rmdirSync(directory.absolute);
        syncDirectoryBestEffort(path.dirname(directory.absolute));
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }

  private removeAttemptDirectories(): void {
    const paths = [...this.createdDirectories].sort((left, right) => right[0].split("/").length - left[0].split("/").length);
    for (const [relativePath, expected] of paths) {
      try {
        const current = fs.lstatSync(expected.absolute, { bigint: true });
        if (!sameDirectory(expected, current)) { this.createdDirectories.delete(relativePath); continue; }
        fs.rmdirSync(expected.absolute);
        syncDirectoryBestEffort(path.dirname(expected.absolute));
        this.createdDirectories.delete(relativePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (code === "ENOENT") this.createdDirectories.delete(relativePath);
        else if (!["ENOTEMPTY", "EEXIST"].includes(code)) throw error;
      }
    }
  }
}
