import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertRealpathBoundary } from "../../registries/artifactRegistry.js";
import { reject } from "./errors.js";

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const INITIALIZATION_GRACE_MS = 250;
const OWNER_NAME = "owner.json";
const MAX_OWNER_BYTES = 8 * 1024;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

interface LockRecord {
  pid: number;
  token: string;
  created_at: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnerInspection {
  state: "valid" | "malformed";
  stale: boolean;
  fd?: number;
  file: boolean;
  record?: LockRecord;
}

interface DirectoryInspection {
  state: "directory";
  fd: number;
  owner: OwnerInspection;
}

type LockInspection =
  | { state: "absent" }
  | DirectoryInspection
  | { state: "legacy_file"; fd: number }
  | { state: "unsupported"; kind: string };

interface PreparedLock {
  path: string;
  dirFd: number;
  ownerFd: number;
  record: LockRecord;
}

function lockRecord(value: unknown): LockRecord | null {
  if (
    value === null
    || typeof value !== "object"
    || !Number.isSafeInteger((value as { pid?: unknown }).pid)
    || (value as { pid: number }).pid <= 0
    || typeof (value as { token?: unknown }).token !== "string"
    || (value as { token: string }).token.length === 0
    || typeof (value as { created_at?: unknown }).created_at !== "string"
  ) return null;
  return value as LockRecord;
}

function identity(fd: number): FileIdentity {
  const stat = fs.fstatSync(fd, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameRecord(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid
    && left.token === right.token
    && left.created_at === right.created_at;
}

function fdPath(fd: number, name?: string): string {
  return name ? `/proc/self/fd/${fd}/${name}` : `/proc/self/fd/${fd}`;
}

function pathMatches(pathname: string, expectedFd: number, flags: number): boolean {
  let observedFd: number | undefined;
  try {
    observedFd = fs.openSync(pathname, flags);
    return sameIdentity(identity(observedFd), identity(expectedFd));
  } catch {
    return false;
  } finally {
    if (observedFd !== undefined) fs.closeSync(observedFd);
  }
}

function readRecord(fd: number): LockRecord | null {
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(MAX_OWNER_BYTES)) return null;
    const size = Number(stat.size);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== size) return null;
    return lockRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

function inspectOwner(lockFd: number): OwnerInspection {
  const ownerPath = fdPath(lockFd, OWNER_NAME);
  let ownerFd: number | undefined;
  try {
    ownerFd = fs.openSync(ownerPath, FILE_FLAGS);
    const stat = fs.fstatSync(ownerFd, { bigint: true });
    const file = stat.isFile();
    const record = file ? readRecord(ownerFd) : null;
    return record
      ? { state: "valid", stale: false, fd: ownerFd, file, record }
      : {
          state: "malformed",
          stale: Date.now() - Number(stat.mtimeMs) >= INITIALIZATION_GRACE_MS,
          fd: ownerFd,
          file,
        };
  } catch (error) {
    if (ownerFd !== undefined) fs.closeSync(ownerFd);
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { state: "malformed", stale: false, file: false };
    }
    const stat = fs.fstatSync(lockFd, { bigint: true });
    return {
      state: "malformed",
      stale: Date.now() - Number(stat.mtimeMs) >= INITIALIZATION_GRACE_MS,
      file: false,
    };
  }
}

function inspectLock(lockPath: string): LockInspection {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, DIRECTORY_FLAGS);
      return { state: "directory", fd, owner: inspectOwner(fd) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { state: "absent" };
      if (code !== "ENOTDIR" && code !== "ELOOP") throw error;
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
      throw error;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { state: "unsupported", kind: stat.isSymbolicLink() ? "symbolic link" : "non-file entry" };
    }
    try {
      const fd = fs.openSync(lockPath, FILE_FLAGS);
      const opened = fs.fstatSync(fd);
      if (opened.isFile()) return { state: "legacy_file", fd };
      fs.closeSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") continue;
      throw error;
    }
  }
  return { state: "unsupported", kind: "entry changing during inspection" };
}

function closeInspection(inspection: LockInspection): void {
  if (inspection.state === "directory") {
    if (inspection.owner.fd !== undefined) fs.closeSync(inspection.owner.fd);
    fs.closeSync(inspection.fd);
  } else if (inspection.state === "legacy_file") {
    fs.closeSync(inspection.fd);
  }
}

function ownerIsDead(record: LockRecord): boolean {
  if (record.pid === process.pid) return false;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function syncDirectory(directory: string | number): void {
  const fd = typeof directory === "number" ? directory : fs.openSync(directory, DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(fd);
  } finally {
    if (typeof directory !== "number") fs.closeSync(fd);
  }
}

function unlinkExactFile(
  directoryFd: number,
  name: string,
  expectedFd: number,
  expectedLinksAfterClaim: bigint,
): boolean {
  if (!fs.fstatSync(expectedFd).isFile()) return false;
  const entryPath = fdPath(directoryFd, name);
  const claimName = `.writer.${randomUUID()}.claim`;
  const claimPath = fdPath(directoryFd, claimName);
  let claimFd: number | undefined;
  let removed = false;
  try {
    fs.linkSync(entryPath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let failure: unknown;
  try {
    claimFd = fs.openSync(claimPath, FILE_FLAGS);
    if (
      sameIdentity(identity(claimFd), identity(expectedFd))
      && fs.fstatSync(claimFd, { bigint: true }).nlink === expectedLinksAfterClaim
      && pathMatches(entryPath, expectedFd, FILE_FLAGS)
    ) {
      fs.unlinkSync(entryPath);
      removed = true;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (claimFd !== undefined) {
      const removeClaim = pathMatches(claimPath, claimFd, FILE_FLAGS);
      fs.closeSync(claimFd);
      if (removeClaim) {
        try {
          fs.unlinkSync(claimPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && failure === undefined) failure = error;
        }
      }
    }
  }
  try {
    syncDirectory(directoryFd);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
  return removed;
}

function prepareLock(parentFd: number): PreparedLock {
  const record: LockRecord = {
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  const name = `.writer.${record.token}.tmp`;
  const preparedPath = fdPath(parentFd, name);
  let dirFd: number | undefined;
  let ownerFd: number | undefined;
  try {
    fs.mkdirSync(preparedPath, { mode: 0o700 });
    dirFd = fs.openSync(preparedPath, DIRECTORY_FLAGS);
    ownerFd = fs.openSync(
      fdPath(dirFd, OWNER_NAME),
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(ownerFd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(ownerFd);
    syncDirectory(dirFd);
    return { path: preparedPath, dirFd, ownerFd, record };
  } catch (error) {
    if (dirFd !== undefined && ownerFd !== undefined) {
      try {
        unlinkExactFile(dirFd, OWNER_NAME, ownerFd, 2n);
      } catch {
        /* preserve the acquisition error */
      }
    }
    if (ownerFd !== undefined) fs.closeSync(ownerFd);
    if (dirFd !== undefined) fs.closeSync(dirFd);
    try {
      fs.rmdirSync(preparedPath);
      syncDirectory(parentFd);
    } catch {
      /* preserve the acquisition error */
    }
    throw error;
  }
}

function disposePrepared(prepared: PreparedLock, parentFd: number): void {
  if (prepared.ownerFd >= 0 && prepared.dirFd >= 0) {
    try {
      const links = fs.fstatSync(prepared.ownerFd, { bigint: true }).nlink;
      unlinkExactFile(prepared.dirFd, OWNER_NAME, prepared.ownerFd, links + 1n);
    } catch {
      /* the exact prepared owner was already removed */
    }
  }
  if (prepared.ownerFd >= 0) {
    fs.closeSync(prepared.ownerFd);
    prepared.ownerFd = -1;
  }
  const exactDirectory = prepared.dirFd >= 0
    && pathMatches(prepared.path, prepared.dirFd, DIRECTORY_FLAGS);
  if (prepared.dirFd >= 0) {
    fs.closeSync(prepared.dirFd);
    prepared.dirFd = -1;
  }
  if (exactDirectory) {
    try {
      fs.rmdirSync(prepared.path);
      syncDirectory(parentFd);
    } catch {
      /* a non-empty replacement is not this attempt's directory */
    }
  }
}

function verifyCanonicalLock(
  projectDirectory: string,
  parentFd: number,
  lockPath: string,
  lockFd: number,
  ownerFd: number,
  expected: LockRecord,
): boolean {
  if (!pathMatches(projectDirectory, parentFd, DIRECTORY_FLAGS)) return false;
  let canonicalFd: number | undefined;
  let canonicalOwnerFd: number | undefined;
  try {
    canonicalFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
    if (!sameIdentity(identity(canonicalFd), identity(lockFd))) return false;
    canonicalOwnerFd = fs.openSync(fdPath(canonicalFd, OWNER_NAME), FILE_FLAGS);
    if (!sameIdentity(identity(canonicalOwnerFd), identity(ownerFd))) return false;
    const observed = readRecord(canonicalOwnerFd);
    return observed !== null && sameRecord(observed, expected);
  } catch {
    return false;
  } finally {
    if (canonicalOwnerFd !== undefined) fs.closeSync(canonicalOwnerFd);
    if (canonicalFd !== undefined) fs.closeSync(canonicalFd);
  }
}

function removeOwnedDirectory(parentFd: number, lockName: string, lockFd: number, ownerFd: number): boolean {
  const removedOwner = unlinkExactFile(lockFd, OWNER_NAME, ownerFd, 2n);
  if (!removedOwner) return false;
  const lockPath = fdPath(parentFd, lockName);
  if (!pathMatches(lockPath, lockFd, DIRECTORY_FLAGS)) return false;
  try {
    fs.rmdirSync(lockPath);
    syncDirectory(parentFd);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

function writerLock(
  projectDirectory: string,
  lockPath: string,
  lockName: string,
  parentFd: number,
  lockFd: number,
  ownerFd: number,
  record: LockRecord,
  createdDirectory: boolean,
): WriterLock {
  let released = false;
  return {
    path: lockPath,
    release: () => {
      if (released) return;
      released = true;
      try {
        if (verifyCanonicalLock(projectDirectory, parentFd, lockPath, lockFd, ownerFd, record)) {
          removeOwnedDirectory(parentFd, lockName, lockFd, ownerFd);
        }
      } catch {
        /* a missing or replaced lock is not this owner's to remove */
      }
      fs.closeSync(ownerFd);
      const exactDirectory = pathMatches(projectDirectory, parentFd, DIRECTORY_FLAGS);
      fs.closeSync(lockFd);
      fs.closeSync(parentFd);
      if (createdDirectory && exactDirectory) {
        try {
          fs.rmdirSync(projectDirectory);
        } catch {
          /* a published artifact or peer now owns the directory */
        }
      }
    },
  };
}

function publishPrepared(
  prepared: PreparedLock,
  projectDirectory: string,
  parentFd: number,
  lockPath: string,
  lockName: string,
  createdDirectory: boolean,
): WriterLock | null {
  fs.renameSync(prepared.path, fdPath(parentFd, lockName));
  syncDirectory(parentFd);
  if (verifyCanonicalLock(projectDirectory, parentFd, lockPath, prepared.dirFd, prepared.ownerFd, prepared.record)) {
    return writerLock(
      projectDirectory,
      lockPath,
      lockName,
      parentFd,
      prepared.dirFd,
      prepared.ownerFd,
      prepared.record,
      createdDirectory,
    );
  }
  try {
    removeOwnedDirectory(parentFd, lockName, prepared.dirFd, prepared.ownerFd);
  } catch {
    /* only the exact prepared instance may be cleaned */
  }
  fs.closeSync(prepared.ownerFd);
  prepared.ownerFd = -1;
  fs.closeSync(prepared.dirFd);
  prepared.dirFd = -1;
  return null;
}

function adoptInspectedDirectory(
  inspection: DirectoryInspection,
  prepared: PreparedLock,
  projectDirectory: string,
  parentFd: number,
  lockPath: string,
  lockName: string,
  createdDirectory: boolean,
): WriterLock | null {
  const previousOwnerFd = inspection.owner.fd;
  if (previousOwnerFd !== undefined) {
    if (!inspection.owner.file || !unlinkExactFile(inspection.fd, OWNER_NAME, previousOwnerFd, 2n)) {
      return null;
    }
    fs.closeSync(previousOwnerFd);
    inspection.owner.fd = undefined;
  }

  try {
    fs.linkSync(fdPath(prepared.dirFd, OWNER_NAME), fdPath(inspection.fd, OWNER_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  syncDirectory(inspection.fd);
  syncDirectory(parentFd);
  if (!verifyCanonicalLock(projectDirectory, parentFd, lockPath, inspection.fd, prepared.ownerFd, prepared.record)) {
    unlinkExactFile(inspection.fd, OWNER_NAME, prepared.ownerFd, 3n);
    return null;
  }

  if (!unlinkExactFile(prepared.dirFd, OWNER_NAME, prepared.ownerFd, 3n)) {
    unlinkExactFile(inspection.fd, OWNER_NAME, prepared.ownerFd, 3n);
    return null;
  }
  const exactPreparedDirectory = pathMatches(prepared.path, prepared.dirFd, DIRECTORY_FLAGS);
  if (!exactPreparedDirectory) {
    unlinkExactFile(inspection.fd, OWNER_NAME, prepared.ownerFd, 2n);
    return null;
  }
  fs.rmdirSync(prepared.path);
  syncDirectory(parentFd);
  if (!verifyCanonicalLock(projectDirectory, parentFd, lockPath, inspection.fd, prepared.ownerFd, prepared.record)) {
    unlinkExactFile(inspection.fd, OWNER_NAME, prepared.ownerFd, 2n);
    return null;
  }
  fs.closeSync(prepared.dirFd);
  prepared.dirFd = -1;
  return writerLock(
    projectDirectory,
    lockPath,
    lockName,
    parentFd,
    inspection.fd,
    prepared.ownerFd,
    prepared.record,
    createdDirectory,
  );
}

function renameConflict(error: unknown): boolean {
  return ["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

function timeout(lockPath: string): never {
  reject({
    class: "conflict",
    message: `writer lock timeout at '${lockPath}'; retry the command after the active writer finishes`,
    syntax: "agentera state <artifact-id> <verb> ... --format json",
    example: "retry the same command after the active writer finishes",
  });
}

function unsupportedLock(lockPath: string, kind: string): never {
  const legacy = kind === "legacy file" ? "legacy writer lock file" : `writer lock ${kind}`;
  reject({
    class: "conflict",
    message: `${legacy} at '${lockPath}' cannot be reclaimed safely; verify no Agentera writer is running, remove the entry, and retry`,
    syntax: "agentera state <artifact-id> <verb> ... --format json",
    example: `after verifying no Agentera writer is running, remove '${lockPath}' and retry the same command`,
  });
}

export interface WriterLock {
  path: string;
  release: () => void;
}

export function acquireWriterLock(projectRoot: string, timeoutMs = 2000): WriterLock {
  const projectDirectory = path.join(projectRoot, ".agentera");
  assertRealpathBoundary(projectRoot, projectDirectory, "writer lock");
  const createdDirectory = !fs.existsSync(projectDirectory);
  fs.mkdirSync(projectDirectory, { recursive: true });
  const parentFd = fs.openSync(projectDirectory, DIRECTORY_FLAGS);
  const lockName = ".writer.lock";
  const lockPath = path.join(projectDirectory, lockName);
  const anchoredLockPath = fdPath(parentFd, lockName);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let prepared: PreparedLock;
    try {
      prepared = prepareLock(parentFd);
    } catch (error) {
      fs.closeSync(parentFd);
      if (createdDirectory) {
        try {
          fs.rmdirSync(projectDirectory);
        } catch {
          /* a peer or project artifact now owns the directory */
        }
      }
      throw error;
    }
    try {
      try {
        const lock = publishPrepared(
          prepared,
          projectDirectory,
          parentFd,
          lockPath,
          lockName,
          createdDirectory,
        );
        if (lock) return lock;
        if (Date.now() >= deadline) timeout(lockPath);
        continue;
      } catch (error) {
        if (!renameConflict(error)) throw error;
      }

      const existing = inspectLock(anchoredLockPath);
      if (existing.state === "legacy_file") {
        closeInspection(existing);
        disposePrepared(prepared, parentFd);
        unsupportedLock(lockPath, "legacy file");
      }
      if (existing.state === "unsupported") {
        const kind = existing.kind;
        disposePrepared(prepared, parentFd);
        unsupportedLock(lockPath, kind);
      }
      if (existing.state === "absent") {
        disposePrepared(prepared, parentFd);
        continue;
      }

      const reclaimable = existing.owner.state === "valid"
        ? ownerIsDead(existing.owner.record!)
        : existing.owner.stale;
      if (reclaimable) {
        const lock = adoptInspectedDirectory(
          existing,
          prepared,
          projectDirectory,
          parentFd,
          lockPath,
          lockName,
          createdDirectory,
        );
        if (lock) {
          if (existing.owner.fd !== undefined) fs.closeSync(existing.owner.fd);
          return lock;
        }
      }
      closeInspection(existing);
      disposePrepared(prepared, parentFd);
    } catch (error) {
      disposePrepared(prepared, parentFd);
      fs.closeSync(parentFd);
      throw error;
    }

    if (Date.now() >= deadline) {
      fs.closeSync(parentFd);
      timeout(lockPath);
    }
    Atomics.wait(sleepArray, 0, 0, Math.min(25, Math.max(0, deadline - Date.now())));
  }
}
