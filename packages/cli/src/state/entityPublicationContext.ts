import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertValidatedProjectRoot, type ValidatedProjectRoot } from "./projectRoot.js";
import { reject } from "./write/errors.js";

const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
}

interface DirectoryEntry {
  parentFd: number;
  name: string;
  fd: number;
  created: boolean;
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

  publishImmutable(relativeTarget: string, bytes: string): boolean {
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
        return false;
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
      return true;
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

  removeExact(relativeTarget: string, expectedBytes: string): void {
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
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        directories.push({ parentFd, name, fd, created: false });
        parentFd = fd;
      }
      const directoryFd = directories.at(-1)!.fd;
      const targetName = segments.at(-1)!;
      try { targetFd = fs.openSync(fdPath(directoryFd, targetName), FILE_FLAGS); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!readDescriptor(targetFd).equals(Buffer.from(expectedBytes))) return;
      this.removeOwnedFile(directoryFd, targetName, targetFd);
      syncDirectory(directoryFd);
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

  replaceExisting(relativeTarget: string, expectedBytes: string, bytes: string): void {
    const segments = relativeTarget.split(path.sep).filter(Boolean);
    if (segments.length < 2 || path.isAbsolute(relativeTarget) || segments.includes("..") || segments.includes("."))
      throw new Error(`unsafe entity replacement target '${relativeTarget}'`);
    const directories: DirectoryEntry[] = [];
    let targetFd: number | undefined;
    let stageFd: number | undefined;
    let stageName: string | undefined;
    let backupName: string | undefined;
    let replacementVisible = false;
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
      this.assertBoundary(directories, undefined, { name: targetName, fd: targetFd });
      if (!readDescriptor(targetFd).equals(Buffer.from(expectedBytes)))
        throw new Error(`entity '${relativeTarget}' changed before replacement; preserve both changes and retry explicitly`);
      backupName = `.${targetName}.${process.pid}.${randomUUID()}.previous`;
      fs.linkSync(fdPath(directoryFd, targetName), fdPath(directoryFd, backupName));
      if (!openMatches(directoryFd, backupName, targetFd, FILE_FLAGS))
        throw new Error(`entity '${relativeTarget}' prior value could not be pinned for replacement`);
      stageName = `.${targetName}.${process.pid}.${randomUUID()}.tmp`;
      stageFd = fs.openSync(fdPath(directoryFd, stageName), fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(stageFd, bytes, "utf8");
      fs.fsyncSync(stageFd);
      this.assertBoundary(directories, { name: stageName, fd: stageFd }, { name: targetName, fd: targetFd });
      fs.renameSync(fdPath(directoryFd, stageName), fdPath(directoryFd, targetName));
      replacementVisible = true;
      stageName = undefined;
      syncDirectory(directoryFd);
      this.assertBoundary(directories, undefined, { name: targetName, fd: stageFd });
      this.removeOwnedFile(directoryFd, backupName, targetFd);
      backupName = undefined;
    } catch (error) {
      const directoryFd = directories.at(-1)?.fd;
      if (replacementVisible && directoryFd !== undefined && stageFd !== undefined && targetFd !== undefined) {
        const ownsReplacement = openMatches(directoryFd, segments.at(-1)!, stageFd, FILE_FLAGS);
        const ownsPrior = backupName !== undefined && openMatches(directoryFd, backupName, targetFd, FILE_FLAGS);
        if (ownsReplacement && ownsPrior) {
          fs.renameSync(fdPath(directoryFd, backupName!), fdPath(directoryFd, segments.at(-1)!));
          backupName = undefined;
          syncDirectory(directoryFd);
        } else if (ownsReplacement) {
          throw new Error(`entity '${relativeTarget}' replacement failed and its descriptor-pinned prior value could not be restored`, { cause: error });
        }
      }
      throw error;
    } finally {
      const directoryFd = directories.at(-1)?.fd;
      if (directoryFd !== undefined && stageFd !== undefined && stageName !== undefined)
        this.removeOwnedFile(directoryFd, stageName, stageFd);
      if (directoryFd !== undefined && targetFd !== undefined && backupName !== undefined)
        this.removeOwnedFile(directoryFd, backupName, targetFd);
      if (stageFd !== undefined) fs.closeSync(stageFd);
      if (targetFd !== undefined) fs.closeSync(targetFd);
      for (const entry of directories.reverse()) fs.closeSync(entry.fd);
    }
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
  ): void {
    this.assertValid();
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

  private removeOwnedFile(parentFd: number, name: string, expectedFd: number): void {
    if (!openMatches(parentFd, name, expectedFd, FILE_FLAGS)) return;
    fs.unlinkSync(fdPath(parentFd, name));
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
