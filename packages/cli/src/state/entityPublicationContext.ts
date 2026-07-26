import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertValidatedProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { reject } from "./write/errors.js";

const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const RECOVERY_IGNORE_BYTES = "*\n!.gitignore\n";

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
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

function samePublished(left: PublishedTargetIdentity, right: PublishedTargetIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.type === right.type
    && left.size === right.size
    && left.sha256 === right.sha256;
}

export type ExactRemovalResult = "removed" | "absent" | "identity_mismatch";

interface DirectoryEntry {
  parentFd: number;
  name: string;
  fd: number;
  created: boolean;
}

interface RecoveryAttempt {
  agenteraFd: number;
  rootFd: number;
  attemptFd: number;
  ignoreFd: number;
  attemptName: string;
  relativePath: string;
}

function fdPath(fd: number, name?: string): string {
  return name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`;
}

function identity(stat: fs.BigIntStats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    nlink: stat.nlink,
  };
}

function sameObject(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentity(left: FileIdentity, right: fs.BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink;
}

function readDescriptor(fd: number): Buffer {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("state mode marker descriptor is not a readable regular file");
  }
  const bytes = Buffer.alloc(Number(stat.size));
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== bytes.length) throw new Error("state mode marker changed while its exact bytes were read");
  return bytes;
}

function publishedIdentity(fd: number): PublishedTargetIdentity {
  const stat = fs.fstatSync(fd, { bigint: true });
  const bytes = readDescriptor(fd);
  return {
    dev: stat.dev,
    ino: stat.ino,
    type: stat.mode & BigInt(fs.constants.S_IFMT),
    size: stat.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function matchesPublished(fd: number, expected: PublishedTargetIdentity): boolean {
  const stat = fs.fstatSync(fd, { bigint: true });
  if (
    stat.dev !== expected.dev
    || stat.ino !== expected.ino
    || (stat.mode & BigInt(fs.constants.S_IFMT)) !== expected.type
    || stat.size !== expected.size
  ) return false;
  return createHash("sha256").update(readDescriptor(fd)).digest("hex") === expected.sha256;
}

function matchesExpected(fd: number, expected: Buffer | PublishedTargetIdentity): boolean {
  return Buffer.isBuffer(expected) ? readDescriptor(fd).equals(expected) : matchesPublished(fd, expected);
}

function openMatches(parentFd: number, name: string, expectedFd: number, flags: number): boolean {
  let observed: number | undefined;
  try {
    observed = fs.openSync(fdPath(parentFd, name), flags);
    return sameObject(
      fs.fstatSync(observed, { bigint: true }),
      fs.fstatSync(expectedFd, { bigint: true }),
    );
  } catch {
    return false;
  } finally {
    if (observed !== undefined) fs.closeSync(observed);
  }
}

function entryExists(parentFd: number, name: string): boolean {
  let fd: number | undefined;
  try { fd = fs.openSync(fdPath(parentFd, name), FILE_FLAGS); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function pathBytesEqual(parentFd: number, name: string, expected: Buffer): boolean {
  let fd: number | undefined;
  try { fd = fs.openSync(fdPath(parentFd, name), FILE_FLAGS); return readDescriptor(fd).equals(expected); }
  catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function syncDirectory(fd: number): void {
  fs.fsyncSync(fd);
}

function publicationConflict(markerPath: string): never {
  reject({
    class: "conflict",
    message: `state mode marker '${markerPath}' changed after entity mode detection; this is a conflict and cannot fall back to legacy state`,
    syntax: "agentera state <artifact-id> <verb> ... --format json",
    example: `restore the exact '${markerPath}' marker selected at command start and retry`,
  });
}

/**
 * Pins one entity write to the root and exact valid marker selected by mode
 * detection. Node cannot combine pathname validation and mutation atomically,
 * so publication uses held directory descriptors, validates before and after
 * every observable boundary, and rolls back only links and empty directories
 * whose descriptor identities still match this attempt. Success linearizes at
 * the final root, marker, directory-chain, and target validation.
 */
export class EntityPublicationContext {
  readonly projectRoot: string;
  readonly validatedRoot: ValidatedProjectRoot;
  readonly markerPath: string;

  private readonly rootFd: number;
  private readonly markerParentEntries: DirectoryEntry[];
  private readonly markerFd: number;
  private readonly markerIdentity: FileIdentity;
  private readonly markerBytes: Buffer;
  private readonly createdDirectories = new Map<string, FileIdentity>();
  private closed = false;

  private constructor(
    root: ValidatedProjectRoot,
    markerPath: string,
    expectedBytes: Buffer,
  ) {
    this.projectRoot = root.path;
    this.validatedRoot = root;
    this.markerPath = markerPath;
    this.markerBytes = Buffer.from(expectedBytes);
    this.rootFd = fs.openSync(root.path, DIRECTORY_FLAGS);
    this.markerParentEntries = [];
    let markerFd: number | undefined;
    try {
      const rootStat = fs.fstatSync(this.rootFd, { bigint: true });
      const rootIdentity = root.identities.at(-1)!;
      if (rootStat.dev !== rootIdentity.dev || rootStat.ino !== rootIdentity.ino) {
        throw new Error(`project root '${root.path}' changed while its publication context was opened`);
      }
      const segments = markerPath.split("/").filter(Boolean);
      let parentFd = this.rootFd;
      for (const name of segments.slice(0, -1)) {
        const fd = fs.openSync(fdPath(parentFd, name), DIRECTORY_FLAGS);
        this.markerParentEntries.push({ parentFd, name, fd, created: false });
        parentFd = fd;
      }
      markerFd = fs.openSync(fdPath(parentFd, segments.at(-1)!), FILE_FLAGS);
      const before = fs.fstatSync(markerFd, { bigint: true });
      const bytes = readDescriptor(markerFd);
      const after = fs.fstatSync(markerFd, { bigint: true });
      if (!before.isFile() || !sameIdentity(identity(before), after) || !bytes.equals(expectedBytes)) {
        publicationConflict(markerPath);
      }
      this.markerFd = markerFd;
      this.markerIdentity = identity(after);
      this.assertValid();
      markerFd = undefined;
    } catch (error) {
      if (markerFd !== undefined) fs.closeSync(markerFd);
      for (const entry of this.markerParentEntries.reverse()) fs.closeSync(entry.fd);
      fs.closeSync(this.rootFd);
      throw error;
    }
  }

  static open(
    root: ValidatedProjectRoot,
    markerPath: string,
    expectedBytes: Buffer,
  ): EntityPublicationContext {
    return new EntityPublicationContext(root, markerPath, expectedBytes);
  }

  pinnedPath(relativePath = ""): string {
    if (this.closed) throw new Error("entity publication context is closed");
    return relativePath ? path.join(fdPath(this.rootFd), relativePath) : fdPath(this.rootFd);
  }

  assertValid(): void {
    if (this.closed) throw new Error("entity publication context is closed");
    assertValidatedProjectRoot(this.validatedRoot);
    const currentRoot = fs.fstatSync(this.rootFd, { bigint: true });
    const expectedRoot = this.validatedRoot.identities.at(-1)!;
    if (currentRoot.dev !== expectedRoot.dev || currentRoot.ino !== expectedRoot.ino) {
      throw new Error(`project root '${this.projectRoot}' changed after validation; restore the exact real directory and retry`);
    }
    for (const entry of this.markerParentEntries) {
      if (!openMatches(entry.parentFd, entry.name, entry.fd, DIRECTORY_FLAGS)) {
        publicationConflict(this.markerPath);
      }
    }
    const parentFd = this.markerParentEntries.at(-1)?.fd ?? this.rootFd;
    const markerName = this.markerPath.split("/").filter(Boolean).at(-1)!;
    if (
      !openMatches(parentFd, markerName, this.markerFd, FILE_FLAGS)
      || !sameIdentity(this.markerIdentity, fs.fstatSync(this.markerFd, { bigint: true }))
      || !readDescriptor(this.markerFd).equals(this.markerBytes)
    ) publicationConflict(this.markerPath);
  }

  publishImmutable(relativeTarget: string, bytes: string): PublishedTargetIdentity | null {
    const normalized = relativeTarget.split(path.sep).join("/");
    const segments = normalized.split("/").filter(Boolean);
    if (
      segments.length < 2
      || path.isAbsolute(relativeTarget)
      || segments.includes("..")
      || segments.includes(".")
    ) throw new Error(`unsafe entity publication target '${relativeTarget}'`);
    this.assertValid();

    const directories: DirectoryEntry[] = [];
    const createdPaths: Array<{ relativePath: string; fd: number }> = [];
    let stageFd: number | undefined;
    let stageName: string | undefined;
    let targetLinked = false;
    try {
      let parentFd = this.rootFd;
      for (const name of segments.slice(0, -1)) {
        this.assertBoundary(directories);
        const entryParentFd = parentFd;
        let fd: number;
        let created = false;
        try {
          fd = fs.openSync(fdPath(entryParentFd, name), DIRECTORY_FLAGS);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          this.assertBoundary(directories);
          fs.mkdirSync(fdPath(entryParentFd, name));
          created = true;
          fd = fs.openSync(fdPath(entryParentFd, name), DIRECTORY_FLAGS);
        }
        const entry = { parentFd: entryParentFd, name, fd, created };
        directories.push(entry);
        if (created) createdPaths.push({ relativePath: segments.slice(0, directories.length).join("/"), fd });
        parentFd = fd;
        if (created) syncDirectory(entryParentFd);
        this.assertBoundary(directories);
      }

      const directoryFd = directories.at(-1)!.fd;
      const targetName = segments.at(-1)!;
      stageName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
      this.assertBoundary(directories);
      stageFd = fs.openSync(
        fdPath(directoryFd, stageName),
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      this.assertBoundary(directories, { name: stageName, fd: stageFd });
      fs.writeFileSync(stageFd, bytes, "utf8");
      fs.fsyncSync(stageFd);
      this.assertBoundary(directories, { name: stageName, fd: stageFd });

      try {
        this.assertBoundary(directories, { name: stageName, fd: stageFd });
        fs.linkSync(fdPath(directoryFd, stageName), fdPath(directoryFd, targetName));
        targetLinked = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.removeOwnedFile(directoryFd, stageName, stageFd);
        stageName = undefined;
        syncDirectory(directoryFd);
        this.assertBoundary(directories);
        this.removeCreatedDirectories(directories);
        return null;
      }

      syncDirectory(directoryFd);
      this.assertBoundary(
        directories,
        { name: stageName, fd: stageFd },
        { name: targetName, fd: stageFd },
      );
      this.removeOwnedFile(directoryFd, stageName, stageFd);
      stageName = undefined;
      syncDirectory(directoryFd);
      this.assertBoundary(directories, undefined, { name: targetName, fd: stageFd });
      for (const createdPath of createdPaths)
        this.createdDirectories.set(createdPath.relativePath, identity(fs.fstatSync(createdPath.fd, { bigint: true })));
      return publishedIdentity(stageFd);
    } catch (error) {
      const directoryFd = directories.at(-1)?.fd;
      const targetName = segments.at(-1)!;
      const cleanupFailures: string[] = [];
      if (directoryFd !== undefined && stageFd !== undefined && targetLinked) {
        try { this.removeOwnedFile(directoryFd, targetName, stageFd); } catch { cleanupFailures.push("entity"); }
      }
      if (directoryFd !== undefined && stageFd !== undefined && stageName !== undefined) {
        try { this.removeOwnedFile(directoryFd, stageName, stageFd); } catch { cleanupFailures.push("stage"); }
      }
      if (directoryFd !== undefined) {
        try { syncDirectory(directoryFd); } catch { cleanupFailures.push("directory sync"); }
      }
      try { this.removeCreatedDirectories(directories); } catch { cleanupFailures.push("directory"); }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `entity publication failed and exact rollback could not remove its ${cleanupFailures.join(", ")}; inspect the pinned project state before retrying`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (stageFd !== undefined) fs.closeSync(stageFd);
      for (const entry of directories.reverse()) fs.closeSync(entry.fd);
    }
  }

  publishPreowned(
    relativeTarget: string,
    relativeReceipt: string,
    expected: PublishedTargetIdentity,
  ): PublishedTargetIdentity {
    const targetSegments = relativeTarget.split(path.sep).filter(Boolean);
    const receiptSegments = relativeReceipt.split(path.sep).filter(Boolean);
    if ([targetSegments, receiptSegments].some((segments) => segments.length < 2 || segments.includes("..") || segments.includes("."))
      || path.isAbsolute(relativeTarget) || path.isAbsolute(relativeReceipt)) throw new Error("unsafe preowned publication path");
    this.assertValid();
    const receiptDirectories: DirectoryEntry[] = [];
    const targetDirectories: DirectoryEntry[] = [];
    const createdPaths: Array<{ relativePath: string; fd: number }> = [];
    let receiptFd: number | undefined;
    let targetFd: number | undefined;
    let linked = false;
    try {
      let receiptParent = this.rootFd;
      for (const name of receiptSegments.slice(0, -1)) {
        const fd = fs.openSync(fdPath(receiptParent, name), DIRECTORY_FLAGS);
        receiptDirectories.push({ parentFd: receiptParent, name, fd, created: false });
        receiptParent = fd;
      }
      receiptFd = fs.openSync(fdPath(receiptParent, receiptSegments.at(-1)!), FILE_FLAGS);
      const receiptIdentity = publishedIdentity(receiptFd);
      if (!samePublished(receiptIdentity, expected)) throw new Error(`migration ownership receipt '${relativeReceipt}' changed`);

      let targetParent = this.rootFd;
      for (const [index, name] of targetSegments.slice(0, -1).entries()) {
        this.assertBoundary(targetDirectories);
        const parentFd = targetParent;
        let fd: number;
        let created = false;
        try { fd = fs.openSync(fdPath(parentFd, name), DIRECTORY_FLAGS); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          fs.mkdirSync(fdPath(parentFd, name)); created = true;
          fd = fs.openSync(fdPath(parentFd, name), DIRECTORY_FLAGS); syncDirectory(parentFd);
        }
        targetDirectories.push({ parentFd, name, fd, created });
        if (created) createdPaths.push({ relativePath: targetSegments.slice(0, index + 1).join("/"), fd });
        targetParent = fd;
      }
      const targetName = targetSegments.at(-1)!;
      try {
        fs.linkSync(fdPath(receiptParent, receiptSegments.at(-1)!), fdPath(targetParent, targetName));
        linked = true; syncDirectory(targetParent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      targetFd = fs.openSync(fdPath(targetParent, targetName), FILE_FLAGS);
      const targetIdentity = publishedIdentity(targetFd);
      if (!sameObject(fs.fstatSync(receiptFd, { bigint: true }), fs.fstatSync(targetFd, { bigint: true })) || !samePublished(targetIdentity, expected)) {
        throw new Error(`canonical target '${relativeTarget}' collides with migration ownership receipt; byte-identical replacement inodes are never adopted`);
      }
      this.assertBoundary(targetDirectories, undefined, { name: targetName, fd: targetFd });
      for (const createdPath of createdPaths) this.createdDirectories.set(createdPath.relativePath, identity(fs.fstatSync(createdPath.fd, { bigint: true })));
      return targetIdentity;
    } catch (error) {
      const targetParent = targetDirectories.at(-1)?.fd;
      if (linked && targetParent !== undefined && receiptFd !== undefined) this.removeOwnedFile(targetParent, targetSegments.at(-1)!, receiptFd);
      this.removeCreatedDirectories(targetDirectories);
      throw error;
    } finally {
      if (targetFd !== undefined) fs.closeSync(targetFd);
      if (receiptFd !== undefined) fs.closeSync(receiptFd);
      for (const entry of targetDirectories.reverse()) fs.closeSync(entry.fd);
      for (const entry of receiptDirectories.reverse()) fs.closeSync(entry.fd);
    }
  }

  removeExact(relativeTarget: string, expected: PublishedTargetIdentity): ExactRemovalResult {
    const segments = relativeTarget.split(path.sep).filter(Boolean);
    if (segments.length < 2 || path.isAbsolute(relativeTarget) || segments.includes("..") || segments.includes("."))
      throw new Error(`unsafe entity rollback target '${relativeTarget}'`);
    const directories: DirectoryEntry[] = [];
    let targetFd: number | undefined;
    try {
      let parentFd = this.rootFd;
      for (const name of segments.slice(0, -1)) {
        let fd: number;
        try { fd = fs.openSync(fdPath(parentFd, name), DIRECTORY_FLAGS); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
        directories.push({ parentFd, name, fd, created: false });
        parentFd = fd;
      }
      const directoryFd = directories.at(-1)!.fd;
      const targetName = segments.at(-1)!;
      try { targetFd = fs.openSync(fdPath(directoryFd, targetName), FILE_FLAGS); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent"; throw error; }
      if (!matchesPublished(targetFd, expected)) return "identity_mismatch";
      const rollbackName = `.${targetName}.${process.pid}.${randomUUID()}.rollback`;
      fs.renameSync(fdPath(directoryFd, targetName), fdPath(directoryFd, rollbackName));
      if (openMatches(directoryFd, rollbackName, targetFd, FILE_FLAGS)) {
        this.removeOwnedFile(directoryFd, rollbackName, targetFd);
      } else {
        try {
          fs.linkSync(fdPath(directoryFd, rollbackName), fdPath(directoryFd, targetName));
          fs.unlinkSync(fdPath(directoryFd, rollbackName));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        syncDirectory(directoryFd);
        return "identity_mismatch";
      }
      syncDirectory(directoryFd);
      return "removed";
    } finally {
      if (targetFd !== undefined) fs.closeSync(targetFd);
      for (const entry of directories.reverse()) fs.closeSync(entry.fd);
      this.removeAttemptDirectories();
    }
  }

  private removeAttemptDirectories(): void {
    const paths = [...this.createdDirectories.keys()].sort((left, right) => right.split("/").length - left.split("/").length);
    for (const relativePath of paths) {
      const segments = relativePath.split("/");
      const descriptors: number[] = [];
      let targetFd: number | undefined;
      let parentFd = this.rootFd;
      try {
        for (const name of segments.slice(0, -1)) {
          const fd = fs.openSync(fdPath(parentFd, name), DIRECTORY_FLAGS);
          descriptors.push(fd); parentFd = fd;
        }
        targetFd = fs.openSync(fdPath(parentFd, segments.at(-1)!), DIRECTORY_FLAGS);
        const expected = this.createdDirectories.get(relativePath)!;
        const observed = fs.fstatSync(targetFd, { bigint: true });
        if (observed.dev !== expected.dev || observed.ino !== expected.ino) {
          this.createdDirectories.delete(relativePath);
          continue;
        }
        fs.rmdirSync(fdPath(parentFd, segments.at(-1)!));
        syncDirectory(parentFd);
        this.createdDirectories.delete(relativePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (code === "ENOENT") this.createdDirectories.delete(relativePath);
        else if (!["ENOTEMPTY", "EEXIST"].includes(code)) throw error;
      } finally {
        if (targetFd !== undefined) fs.closeSync(targetFd);
        for (const fd of descriptors.reverse()) fs.closeSync(fd);
      }
    }
  }

  replaceExisting(relativeTarget: string, expectedBytes: Buffer, bytes: string, maxEntityBytes: number): ExactReplacementResult {
    return this.replaceOwned(relativeTarget, expectedBytes, bytes, maxEntityBytes);
  }

  restoreExact(relativeTarget: string, expected: PublishedTargetIdentity, bytes: string, maxEntityBytes: number): ExactReplacementResult {
    // Recovery stays bound to the pinned root and exact archived target even when context invalidation caused the primary failure.
    return this.replaceOwned(relativeTarget, expected, bytes, maxEntityBytes, false);
  }

  private replaceOwned(relativeTarget: string, expected: Buffer | PublishedTargetIdentity, bytes: string, maxEntityBytes: number, verifyContext = true): ExactReplacementResult {
    const segments = relativeTarget.split(path.sep).filter(Boolean);
    if (segments.length < 2 || path.isAbsolute(relativeTarget) || segments.includes("..") || segments.includes("."))
      throw new Error(`unsafe entity replacement target '${relativeTarget}'`);
    const directories: DirectoryEntry[] = [];
    let targetFd: number | undefined;
    let stageFd: number | undefined;
    let backupFd: number | undefined;
    let stageName: string | undefined;
    let backupName: string | undefined;
    let displacedName: string | undefined;
    let displacedFd: number | undefined;
    let displacementActive = false;
    let committedResult: ExactReplacementResult | undefined;
    let recovery: RecoveryAttempt | undefined;
    let baselineBytes: Buffer | undefined;
    try {
      let parentFd = this.rootFd;
      for (const name of segments.slice(0, -1)) {
        const fd = fs.openSync(fdPath(parentFd, name), DIRECTORY_FLAGS);
        directories.push({ parentFd, name, fd, created: false });
        parentFd = fd;
      }
      const directoryFd = directories.at(-1)!.fd;
      const targetName = segments.at(-1)!;
      targetFd = fs.openSync(fdPath(directoryFd, targetName), FILE_FLAGS);
      this.assertBoundary(directories, undefined, { name: targetName, fd: targetFd }, verifyContext);
      const previousBytes = readDescriptor(targetFd);
      baselineBytes = previousBytes;
      if (!matchesExpected(targetFd, expected))
        throw new Error(`entity '${relativeTarget}' ownership changed before replacement; preserve both changes and retry explicitly`);
      if (!Number.isSafeInteger(maxEntityBytes) || maxEntityBytes < 1 || previousBytes.length > maxEntityBytes)
        throw new Error(`entity '${relativeTarget}' exact ${previousBytes.length}-byte baseline exceeds the authority-owned ${maxEntityBytes}-byte recovery limit`);
      recovery = this.createRecoveryAttempt(directoryFd);
      backupName = "original.previous";
      backupFd = fs.openSync(fdPath(recovery.attemptFd, backupName), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(backupFd, previousBytes); fs.fsyncSync(backupFd);
      const backupStat = fs.fstatSync(backupFd, { bigint: true });
      const attemptStat = fs.fstatSync(recovery.attemptFd, { bigint: true });
      if (!backupStat.isFile() || backupStat.dev !== attemptStat.dev || backupStat.uid !== attemptStat.uid || backupStat.nlink !== 1n || (backupStat.mode & 0o077n) !== 0n || !openMatches(recovery.attemptFd, backupName, backupFd, FILE_FLAGS) || !readDescriptor(backupFd).equals(previousBytes))
        throw new Error(`entity '${relativeTarget}' exact prior-byte snapshot could not be verified before replacement`);
      stageName = "replacement.tmp";
      stageFd = fs.openSync(fdPath(recovery.attemptFd, stageName), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(stageFd, bytes, "utf8");
      fs.fsyncSync(stageFd);
      this.assertBoundary(directories, undefined, { name: targetName, fd: targetFd }, verifyContext);
      if (!openMatches(recovery.attemptFd, stageName, stageFd, FILE_FLAGS) || !openMatches(recovery.attemptFd, backupName, backupFd, FILE_FLAGS) || !readDescriptor(backupFd).equals(previousBytes))
        throw new Error(`entity '${relativeTarget}' private recovery attempt changed before displacement`);
      displacedName = "original.displaced";
      fs.renameSync(fdPath(directoryFd, targetName), fdPath(recovery.attemptFd, displacedName));
      displacementActive = true;
      displacedFd = fs.openSync(fdPath(recovery.attemptFd, displacedName), FILE_FLAGS);
      if (!openMatches(recovery.attemptFd, displacedName, targetFd, FILE_FLAGS) || !matchesExpected(displacedFd, expected))
        throw new Error(`entity '${relativeTarget}' ownership changed after staging; competing bytes were preserved at the target`);
      try { fs.linkSync(fdPath(recovery.attemptFd, stageName), fdPath(directoryFd, targetName)); }
      catch (publishError) {
        if ((publishError as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`entity '${relativeTarget}' ownership changed during no-clobber publication; competing target bytes were preserved`, { cause: publishError });
        throw publishError;
      }
      if (!this.removeOwnedFile(recovery.attemptFd, stageName, stageFd)) throw new Error(`entity '${relativeTarget}' replacement stage changed before cleanup`);
      stageName = undefined;
      syncDirectory(directoryFd);
      syncDirectory(recovery.attemptFd);
      this.assertBoundary(directories, undefined, { name: targetName, fd: stageFd }, verifyContext);
      if (!openMatches(recovery.attemptFd, displacedName, targetFd, FILE_FLAGS) || !matchesExpected(displacedFd, expected))
        throw new Error(`entity '${relativeTarget}' ownership changed through the publication boundary; competing bytes remain recoverable`);
      committedResult = { previousBytes: previousBytes.toString("utf8"), publishedIdentity: publishedIdentity(stageFd) };
      this.cleanupCommittedReplacement(recovery.attemptFd, [[displacedName, targetFd], [backupName, backupFd]]);
      displacementActive = false;
      return committedResult;
    } catch (error) {
      if (committedResult) return committedResult;
      const directoryFd = directories.at(-1)?.fd;
      if (displacementActive && directoryFd !== undefined && targetFd !== undefined && recovery) {
        throw this.recoverDisplacedReplacement({ directoryFd, recoveryFd: recovery.attemptFd, recoveryPath: recovery.relativePath, relativeTarget, baselineBytes: baselineBytes!, backupFd, stageFd, stageName, backupName, displacedFd, displacedName, retainStage: !verifyContext, primary: error });
      }
      const cleanupFailures: string[] = [];
      for (const [name, fd, label] of [[stageName, stageFd, "stage"], [backupName, backupFd, "backup"]] as const) if (name && fd !== undefined) {
        try { if (!recovery || !this.removeOwnedFile(recovery.attemptFd, name, fd)) cleanupFailures.push(`${label} '${recovery ? path.join(recovery.relativePath, name) : name}' changed`); }
        catch (cleanupError) { cleanupFailures.push(`${label} '${recovery ? path.join(recovery.relativePath, name) : name}': ${(cleanupError as Error).message}`); }
      }
      if (cleanupFailures.length) throw new Error(`${(error as Error).message}; cleanup retained attempt state: ${cleanupFailures.join("; ")}`, { cause: error });
      throw error;
    } finally {
      if (displacedFd !== undefined) fs.closeSync(displacedFd);
      if (backupFd !== undefined) fs.closeSync(backupFd);
      if (stageFd !== undefined) fs.closeSync(stageFd);
      if (targetFd !== undefined) fs.closeSync(targetFd);
      for (const entry of directories.reverse()) fs.closeSync(entry.fd);
      if (recovery) this.closeRecoveryAttempt(recovery);
    }
  }

  private createRecoveryAttempt(targetDirectoryFd: number): RecoveryAttempt {
    const rootName = ".entity-recovery"; const agenteraFd = fs.openSync(fdPath(this.rootFd, ".agentera"), DIRECTORY_FLAGS);
    let rootFd: number | undefined; let ignoreFd: number | undefined; let ignoreCreated = false; let attemptFd: number | undefined; let attemptName: string | undefined; let rootCreated = false;
    try {
      try { rootFd = fs.openSync(fdPath(agenteraFd, rootName), DIRECTORY_FLAGS); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`private entity recovery root '.agentera/${rootName}' cannot be opened safely: ${(error as Error).message}`, { cause: error });
        fs.mkdirSync(fdPath(agenteraFd, rootName), 0o700); rootCreated = true; syncDirectory(agenteraFd);
        rootFd = fs.openSync(fdPath(agenteraFd, rootName), DIRECTORY_FLAGS);
      }
      const rootStat = fs.fstatSync(rootFd, { bigint: true });
      if ((rootStat.mode & 0o022n) !== 0n || (typeof process.getuid === "function" && rootStat.uid !== BigInt(process.getuid())))
        throw new Error(`private entity recovery root '.agentera/${rootName}' must be owned by the current user and not group/world-writable`);
      if (rootStat.dev !== fs.fstatSync(targetDirectoryFd, { bigint: true }).dev)
        throw new Error("private entity recovery root must share the canonical entity target filesystem");
      try { ignoreFd = fs.openSync(fdPath(rootFd, ".gitignore"), FILE_FLAGS); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`private entity recovery ignore marker cannot be opened safely: ${(error as Error).message}`, { cause: error });
        ignoreFd = fs.openSync(fdPath(rootFd, ".gitignore"), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); ignoreCreated = true;
        fs.writeFileSync(ignoreFd, RECOVERY_IGNORE_BYTES, "utf8"); fs.fsyncSync(ignoreFd);
      }
      const ignoreStat = fs.fstatSync(ignoreFd, { bigint: true });
      if (!ignoreStat.isFile() || (ignoreStat.mode & 0o022n) !== 0n || (typeof process.getuid === "function" && ignoreStat.uid !== BigInt(process.getuid())) || !readDescriptor(ignoreFd).equals(Buffer.from(RECOVERY_IGNORE_BYTES)))
        throw new Error("private entity recovery ignore marker must be an owner-controlled regular file with the authoritative rules");
      syncDirectory(rootFd);
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `entity-${process.pid}-${randomUUID()}`;
        try { fs.mkdirSync(fdPath(rootFd, candidate), 0o700); attemptName = candidate; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (!attemptName) throw new Error("could not allocate a unique private entity recovery attempt after 8 tries");
      attemptFd = fs.openSync(fdPath(rootFd, attemptName), DIRECTORY_FLAGS);
      const attemptStat = fs.fstatSync(attemptFd, { bigint: true });
      if ((attemptStat.mode & 0o077n) !== 0n || attemptStat.uid !== rootStat.uid || attemptStat.dev !== rootStat.dev)
        throw new Error("private entity recovery attempt must be owner-only, owner-controlled, and on the recovery-root filesystem");
      syncDirectory(rootFd);
      return { agenteraFd, rootFd, attemptFd, ignoreFd, attemptName, relativePath: `.agentera/${rootName}/${attemptName}` };
    } catch (error) {
      if (attemptFd !== undefined) fs.closeSync(attemptFd);
      if (rootFd !== undefined && attemptName) { try { fs.rmdirSync(fdPath(rootFd, attemptName)); } catch { /* preserve unexpected contents */ } }
      if (rootFd !== undefined && ignoreFd !== undefined && ignoreCreated) { try { this.removeOwnedFile(rootFd, ".gitignore", ignoreFd); } catch { /* preserve changed marker */ } }
      if (ignoreFd !== undefined) fs.closeSync(ignoreFd);
      if (rootFd !== undefined) fs.closeSync(rootFd);
      if (rootCreated) { try { fs.rmdirSync(fdPath(agenteraFd, rootName)); } catch { /* preserve non-empty or changed root */ } }
      fs.closeSync(agenteraFd); throw error;
    }
  }

  private closeRecoveryAttempt(recovery: RecoveryAttempt): void {
    try {
      if (openMatches(recovery.rootFd, recovery.attemptName, recovery.attemptFd, DIRECTORY_FLAGS)) {
        try { fs.rmdirSync(fdPath(recovery.rootFd, recovery.attemptName)); syncDirectory(recovery.rootFd); }
        catch { /* best-effort private cleanup retains non-empty or changed attempt */ }
      }
      const remaining = fs.readdirSync(fdPath(recovery.rootFd));
      if (remaining.length === 1 && remaining[0] === ".gitignore" && openMatches(recovery.rootFd, ".gitignore", recovery.ignoreFd, FILE_FLAGS)) {
        try { this.removeOwnedFile(recovery.rootFd, ".gitignore", recovery.ignoreFd); syncDirectory(recovery.rootFd); } catch { /* preserve marker on cleanup failure */ }
      }
      if (openMatches(recovery.agenteraFd, ".entity-recovery", recovery.rootFd, DIRECTORY_FLAGS)) {
        try { fs.rmdirSync(fdPath(recovery.agenteraFd, ".entity-recovery")); syncDirectory(recovery.agenteraFd); }
        catch { /* best-effort private cleanup retains non-empty or changed root */ }
      }
    } catch {
      /* committed or already-recovered state must not be reclassified by private cleanup */
    } finally {
      for (const fd of [recovery.attemptFd, recovery.ignoreFd, recovery.rootFd, recovery.agenteraFd]) { try { fs.closeSync(fd); } catch { /* best-effort descriptor close */ } }
    }
  }

  private cleanupCommittedReplacement(directoryFd: number, links: Array<[string, number]>): void {
    for (const [name, fd] of links) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try { this.removeOwnedFile(directoryFd, name, fd); break; }
        catch { /* committed publication remains authoritative; retry once and otherwise retain recovery link */ }
      }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { syncDirectory(directoryFd); break; }
      catch { /* cleanup durability is best-effort after the durable commit boundary */ }
    }
  }

  private recoverDisplacedReplacement(state: {
    directoryFd: number; recoveryFd: number; recoveryPath: string; relativeTarget: string; stageFd?: number;
    baselineBytes: Buffer; backupFd?: number; stageName?: string; backupName?: string; displacedFd?: number; displacedName?: string; retainStage: boolean; primary: unknown;
  }): Error {
    const { directoryFd, recoveryFd, recoveryPath, relativeTarget, baselineBytes, backupFd, stageFd, displacedFd, retainStage, primary } = state;
    const targetName = path.basename(relativeTarget); const failures: string[] = []; const retained = new Set<string>();
    let { stageName, backupName, displacedName } = state;
    const publicPath = (name: string): string => path.join(recoveryPath, name).split(path.sep).join("/");
    const exactBaseline = (): boolean => Boolean(backupName && backupFd !== undefined && openMatches(recoveryFd, backupName, backupFd, FILE_FLAGS) && readDescriptor(backupFd).equals(baselineBytes));
    const exactDisplaced = (): boolean => Boolean(displacedName && displacedFd !== undefined && openMatches(recoveryFd, displacedName, displacedFd, FILE_FLAGS));
    const exactStage = (): boolean => Boolean(stageName && stageFd !== undefined && openMatches(recoveryFd, stageName, stageFd, FILE_FLAGS));
    const remove = (name: string, fd: number, label: string): boolean => {
      try { if (this.removeOwnedFile(recoveryFd, name, fd)) return true; failures.push(`${label} '${publicPath(name)}' changed before cleanup`); }
      catch (error) { failures.push(`${label} '${publicPath(name)}' cleanup failed: ${(error as Error).message}`); }
      retained.add(publicPath(name)); return false;
    };
    const sync = (label: string): boolean => { try { syncDirectory(directoryFd); syncDirectory(recoveryFd); return true; } catch (error) { failures.push(`${label} directory fsync failed: ${(error as Error).message}`); return false; } };
    const displacedBytes = exactDisplaced() ? readDescriptor(displacedFd!) : undefined;
    const displacedCompetitor = Boolean(displacedBytes && !displacedBytes.equals(baselineBytes));
    const source = displacedCompetitor ? displacedName : exactBaseline() ? backupName : exactDisplaced() && displacedBytes?.equals(baselineBytes) ? displacedName : undefined;
    const sourceFd = source === backupName ? backupFd : source === displacedName ? displacedFd : undefined;
    if (stageFd !== undefined && openMatches(directoryFd, targetName, stageFd, FILE_FLAGS) && source && sourceFd !== undefined) {
      try { if (this.removeOwnedFile(directoryFd, targetName, stageFd)) sync("replacement removal"); else failures.push(`published replacement '${relativeTarget}' changed before cleanup`); }
      catch (error) { failures.push(`published replacement '${relativeTarget}' cleanup failed: ${(error as Error).message}`); }
    }
    let restoredBaseline = pathBytesEqual(directoryFd, targetName, baselineBytes);
    let restoredCompetitor = Boolean(displacedCompetitor && displacedFd !== undefined && openMatches(directoryFd, targetName, displacedFd, FILE_FLAGS));
    let occupied = !restoredBaseline && !restoredCompetitor && entryExists(directoryFd, targetName);
    if (!restoredBaseline && !restoredCompetitor && !occupied && source && sourceFd !== undefined) {
      try { fs.linkSync(fdPath(recoveryFd, source), fdPath(directoryFd, targetName)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") failures.push(`restoration from '${publicPath(source)}' failed: ${(error as Error).message}`);
      }
      restoredBaseline = pathBytesEqual(directoryFd, targetName, baselineBytes);
      restoredCompetitor = Boolean(displacedCompetitor && displacedFd !== undefined && openMatches(directoryFd, targetName, displacedFd, FILE_FLAGS));
      occupied = !restoredBaseline && !restoredCompetitor && entryExists(directoryFd, targetName);
    }
    if (restoredBaseline || restoredCompetitor) {
      const durable = sync(restoredBaseline ? "exact baseline restoration" : "competitor restoration");
      if (durable) {
        if (retainStage && exactStage()) retained.add(publicPath(stageName!));
        else if (exactStage() && remove(stageName!, stageFd!, "replacement stage")) stageName = undefined;
        if (restoredCompetitor) {
          if (exactBaseline()) retained.add(publicPath(backupName!)); else failures.push("exact baseline snapshot is unavailable");
          if (exactDisplaced() && remove(displacedName!, displacedFd!, "canonicalized competitor duplicate")) displacedName = undefined;
        } else {
          if (displacedCompetitor && exactDisplaced()) retained.add(publicPath(displacedName!));
          else if (exactDisplaced() && remove(displacedName!, displacedFd!, "displaced baseline duplicate")) displacedName = undefined;
          if (exactBaseline() && remove(backupName!, backupFd!, "baseline snapshot duplicate")) backupName = undefined;
        }
        sync("restoration cleanup");
      }
      for (const name of [backupName, displacedName, stageName]) if (name && entryExists(recoveryFd, name)) retained.add(publicPath(name));
      const outcome = restoredCompetitor
        ? `recovery restored concurrent competitor bytes at '${relativeTarget}' and retained the exact discovered baseline snapshot at ${exactBaseline() ? `'${publicPath(backupName!)}'` : "an unavailable path"}`
        : `recovery restored byte-verified exact prior bytes at '${relativeTarget}'`;
      return new Error(`${(primary as Error).message}; ${outcome}${retained.size ? `; retained recovery files: ${[...retained].join(", ")}` : ""}${failures.length ? `; recovery issues: ${failures.join("; ")}` : ""}`, { cause: primary });
    }
    if (occupied) {
      if (exactBaseline()) retained.add(publicPath(backupName!)); else failures.push("exact baseline snapshot is unavailable");
      if (displacedCompetitor && exactDisplaced()) retained.add(publicPath(displacedName!));
      if (sync("competing-target retention")) {
        if (retainStage && exactStage()) retained.add(publicPath(stageName!));
        else if (exactStage() && remove(stageName!, stageFd!, "replacement stage")) stageName = undefined;
        if (!displacedCompetitor && exactDisplaced() && remove(displacedName!, displacedFd!, "displaced baseline duplicate")) displacedName = undefined;
        sync("retention cleanup");
      }
      for (const name of [backupName, displacedName, stageName]) if (name && entryExists(recoveryFd, name)) retained.add(publicPath(name));
      return new Error(`${(primary as Error).message}; recovery preserved the competing canonical target and retained the exact discovered baseline snapshot and any displaced competitor at ${[...retained].join(", ") || "unavailable paths"}; preserve each role and resolve ownership explicitly${failures.length ? `; recovery issues: ${failures.join("; ")}` : ""}`, { cause: primary });
    }
    if (exactBaseline()) retained.add(publicPath(backupName!));
    if (exactDisplaced()) retained.add(publicPath(displacedName!));
    if (exactStage()) retained.add(publicPath(stageName!));
    return new Error(`${(primary as Error).message}; recovery could not restore the absent canonical target; retained role-labeled recovery files: ${[...retained].join(", ") || "none"}; restore the exact baseline or competitor explicitly before retrying${failures.length ? `; recovery issues: ${failures.join("; ")}` : ""}`, { cause: primary });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.markerFd);
    for (const entry of this.markerParentEntries.reverse()) fs.closeSync(entry.fd);
    fs.closeSync(this.rootFd);
  }

  private assertBoundary(
    directories: DirectoryEntry[],
    stage?: { name: string; fd: number },
    target?: { name: string; fd: number },
    verifyContext = true,
  ): void {
    if (verifyContext) this.assertValid();
    for (const entry of directories) {
      if (!openMatches(entry.parentFd, entry.name, entry.fd, DIRECTORY_FLAGS)) {
        throw new Error(`entity publication directory '${entry.name}' changed during publication`);
      }
    }
    const directoryFd = directories.at(-1)?.fd;
    if (directoryFd !== undefined && stage && !openMatches(directoryFd, stage.name, stage.fd, FILE_FLAGS)) {
      throw new Error("entity publication stage changed during publication");
    }
    if (directoryFd !== undefined && target && !openMatches(directoryFd, target.name, target.fd, FILE_FLAGS)) {
      throw new Error("entity publication target changed during publication");
    }
  }

  private removeOwnedFile(parentFd: number, name: string, expectedFd: number): boolean {
    if (!openMatches(parentFd, name, expectedFd, FILE_FLAGS)) return false;
    fs.unlinkSync(fdPath(parentFd, name));
    return true;
  }

  private removeCreatedDirectories(directories: DirectoryEntry[]): void {
    for (const entry of [...directories].reverse()) {
      if (!entry.created || !openMatches(entry.parentFd, entry.name, entry.fd, DIRECTORY_FLAGS)) continue;
      try {
        fs.rmdirSync(fdPath(entry.parentFd, entry.name));
        syncDirectory(entry.parentFd);
      } catch (error) {
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }
}
