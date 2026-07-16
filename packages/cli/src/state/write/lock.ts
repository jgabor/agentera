import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertRealpathBoundary } from "../../registries/artifactRegistry.js";
import { reject } from "./errors.js";

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const INITIALIZATION_GRACE_MS = 250;
const OWNER_NAME = "owner.json";
const CLAIM_NAME = ".reclaim.json";
const MAX_OWNER_BYTES = 8 * 1024;
const MAX_RECOVERY_ENTRIES = 128;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);
const FILE_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
const PRIVATE_NAME = /^\.writer\.(?:(\d+)\.)?([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const LEGACY_CLAIM_NAME = /^\.writer\.[0-9a-f-]{36}\.claim$/;

interface LockRecord {
  pid: number;
  token: string;
  created_at: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface RecordInspection {
  state: "valid" | "malformed";
  stale: boolean;
  fd?: number;
  file: boolean;
  record?: LockRecord;
}

interface DirectoryInspection {
  state: "directory";
  fd: number;
  owner: RecordInspection;
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

interface ReclaimClaim {
  fd: number;
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

function entryAbsent(directoryFd: number, name: string): boolean {
  try {
    fs.lstatSync(fdPath(directoryFd, name));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
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

function inspectRecord(directoryFd: number, name: string): RecordInspection {
  let fd: number | undefined;
  try {
    fd = fs.openSync(fdPath(directoryFd, name), FILE_FLAGS);
    const stat = fs.fstatSync(fd, { bigint: true });
    const file = stat.isFile();
    const record = file ? readRecord(fd) : null;
    return record
      ? { state: "valid", stale: false, fd, file, record }
      : {
          state: "malformed",
          stale: Date.now() - Number(stat.mtimeMs) >= INITIALIZATION_GRACE_MS,
          fd,
          file,
        };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { state: "malformed", stale: false, file: false };
    }
    const stat = fs.fstatSync(directoryFd, { bigint: true });
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
      return { state: "directory", fd, owner: inspectRecord(fd, OWNER_NAME) };
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

function closeRecord(inspection: RecordInspection): void {
  if (inspection.fd !== undefined) fs.closeSync(inspection.fd);
}

function closeInspection(inspection: LockInspection): void {
  if (inspection.state === "directory") {
    closeRecord(inspection.owner);
    fs.closeSync(inspection.fd);
  } else if (inspection.state === "legacy_file") {
    fs.closeSync(inspection.fd);
  }
}

function pidIsDead(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function ownerIsDead(record: LockRecord): boolean {
  return pidIsDead(record.pid);
}

function syncDirectory(directory: string | number): void {
  const fd = typeof directory === "number" ? directory : fs.openSync(directory, DIRECTORY_FLAGS);
  try {
    fs.fsyncSync(fd);
  } finally {
    if (typeof directory !== "number") fs.closeSync(fd);
  }
}

function unlinkPinnedFile(directoryFd: number, name: string, expectedFd: number): boolean {
  if (!fs.fstatSync(expectedFd).isFile()) return false;
  const target = fdPath(directoryFd, name);
  if (!pathMatches(target, expectedFd, FILE_FLAGS)) return false;
  try {
    fs.unlinkSync(target);
    syncDirectory(directoryFd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removePinnedDirectory(parentFd: number, name: string, directoryFd: number): boolean {
  const target = fdPath(parentFd, name);
  if (!pathMatches(target, directoryFd, DIRECTORY_FLAGS)) return false;
  try {
    fs.rmdirSync(target);
    syncDirectory(parentFd);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function recordCanBeRecovered(inspection: RecordInspection, token?: string): boolean {
  if (!inspection.file || inspection.fd === undefined) return false;
  if (inspection.state === "malformed") return inspection.stale;
  return (token === undefined || inspection.record!.token === token) && ownerIsDead(inspection.record!);
}

function recoverPrivateDirectory(
  parentFd: number,
  name: string,
  token: string,
  pid: number | undefined,
  transitionedTokens: ReadonlySet<string>,
): void {
  const privatePath = fdPath(parentFd, name);
  let directoryFd: number | undefined;
  try {
    directoryFd = fs.openSync(privatePath, DIRECTORY_FLAGS);
    const names = fs.readdirSync(fdPath(directoryFd));
    if (names.length === 0) {
      const stat = fs.fstatSync(directoryFd, { bigint: true });
      if (
        transitionedTokens.has(token)
        || (pid !== undefined && pidIsDead(pid))
        || Date.now() - Number(stat.mtimeMs) >= INITIALIZATION_GRACE_MS
      ) {
        removePinnedDirectory(parentFd, name, directoryFd);
      }
      return;
    }
    if (
      names.length > MAX_RECOVERY_ENTRIES
      || names.some((entry) => entry !== OWNER_NAME && !LEGACY_CLAIM_NAME.test(entry))
    ) return;

    const records = names.map((entry) => ({ entry, inspection: inspectRecord(directoryFd!, entry) }));
    try {
      if (records.some(({ inspection }) => !inspection.file || inspection.fd === undefined)) return;
      if (records.some(({ inspection }) => inspection.state === "valid" && inspection.record!.token !== token)) {
        return;
      }
      if (
        pid !== undefined
        && records.some(({ inspection }) => inspection.state === "valid" && inspection.record!.pid !== pid)
      ) return;
      if (records.some(({ inspection }) => inspection.state === "valid" && !ownerIsDead(inspection.record!))) {
        return;
      }
      if (
        !transitionedTokens.has(token)
        && (pid === undefined || !pidIsDead(pid))
        && records.some(({ inspection }) => inspection.state === "malformed" && !inspection.stale)
      ) return;
      for (const { entry, inspection } of records) {
        unlinkPinnedFile(directoryFd, entry, inspection.fd!);
      }
      removePinnedDirectory(parentFd, name, directoryFd);
    } finally {
      for (const { inspection } of records) closeRecord(inspection);
    }
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

function staleTransitionTokens(parentFd: number): Set<string> {
  const tokens = new Set<string>();
  let lockFd: number | undefined;
  try {
    lockFd = fs.openSync(fdPath(parentFd, ".writer.lock"), DIRECTORY_FLAGS);
    for (const name of [OWNER_NAME, CLAIM_NAME]) {
      const record = inspectRecord(lockFd, name);
      try {
        if (record.state === "valid" && ownerIsDead(record.record!)) tokens.add(record.record!.token);
      } finally {
        closeRecord(record);
      }
    }
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
  }
  return tokens;
}

function recoverPreparedLocks(parentFd: number, lockPath: string): void {
  const candidates = fs.readdirSync(fdPath(parentFd), { withFileTypes: true })
    .map((entry) => ({ entry, match: PRIVATE_NAME.exec(entry.name) }))
    .filter(({ match }) => match !== null);
  if (candidates.length > MAX_RECOVERY_ENTRIES) {
    unsupportedLock(lockPath, `${candidates.length} private preparation entries`);
  }
  const transitionedTokens = staleTransitionTokens(parentFd);
  for (const { entry, match } of candidates) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    recoverPrivateDirectory(
      parentFd,
      entry.name,
      match![2]!,
      match![1] === undefined ? undefined : Number(match![1]),
      transitionedTokens,
    );
  }
}

function prepareLock(parentFd: number): PreparedLock {
  const record: LockRecord = {
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  const name = `.writer.${record.pid}.${record.token}.tmp`;
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
        unlinkPinnedFile(dirFd, OWNER_NAME, ownerFd);
      } catch {
        // Preserve the acquisition error.
      }
    }
    if (ownerFd !== undefined) fs.closeSync(ownerFd);
    if (dirFd !== undefined) fs.closeSync(dirFd);
    try {
      fs.rmdirSync(preparedPath);
      syncDirectory(parentFd);
    } catch {
      // Preserve the acquisition error.
    }
    throw error;
  }
}

function disposePrepared(prepared: PreparedLock, parentFd: number): void {
  if (prepared.ownerFd >= 0 && prepared.dirFd >= 0) {
    try {
      unlinkPinnedFile(prepared.dirFd, OWNER_NAME, prepared.ownerFd);
    } catch {
      // The owner was moved or the private directory changed identity.
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
      // A non-empty replacement is not this attempt's directory.
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
  if (!unlinkPinnedFile(lockFd, OWNER_NAME, ownerFd)) return false;
  return removePinnedDirectory(parentFd, lockName, lockFd);
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
        // A missing or replaced lock is not this owner's to remove.
      }
      fs.closeSync(ownerFd);
      const exactDirectory = pathMatches(projectDirectory, parentFd, DIRECTORY_FLAGS);
      fs.closeSync(lockFd);
      fs.closeSync(parentFd);
      if (createdDirectory && exactDirectory) {
        try {
          fs.rmdirSync(projectDirectory);
        } catch {
          // A published artifact or peer now owns the directory.
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
  try {
    fs.renameSync(prepared.path, fdPath(parentFd, lockName));
  } catch (error) {
    if (renameConflict(error)) return null;
    throw error;
  }
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
    // Only the exact prepared instance may be cleaned.
  }
  fs.closeSync(prepared.ownerFd);
  prepared.ownerFd = -1;
  fs.closeSync(prepared.dirFd);
  prepared.dirFd = -1;
  return null;
}

function inspectedOwnerMatches(inspection: DirectoryInspection): boolean {
  return inspection.owner.fd === undefined
    ? entryAbsent(inspection.fd, OWNER_NAME)
    : pathMatches(fdPath(inspection.fd, OWNER_NAME), inspection.owner.fd, FILE_FLAGS);
}

function recoverLegacyClaims(inspection: DirectoryInspection): boolean {
  const names = fs.readdirSync(fdPath(inspection.fd));
  if (names.length > MAX_RECOVERY_ENTRIES) return false;
  for (const name of names.filter((entry) => LEGACY_CLAIM_NAME.test(entry))) {
    const claim = inspectRecord(inspection.fd, name);
    try {
      if (!recordCanBeRecovered(claim)) return false;
      unlinkPinnedFile(inspection.fd, name, claim.fd!);
    } finally {
      closeRecord(claim);
    }
  }
  return fs.readdirSync(fdPath(inspection.fd)).every((name) => name === OWNER_NAME || name === CLAIM_NAME);
}

function removeClaim(inspection: DirectoryInspection, claim: ReclaimClaim): boolean {
  const removed = unlinkPinnedFile(inspection.fd, CLAIM_NAME, claim.fd);
  fs.closeSync(claim.fd);
  claim.fd = -1;
  return removed;
}

function claimInspectedDirectory(
  inspection: DirectoryInspection,
  prepared: PreparedLock,
  parentFd: number,
  lockName: string,
): ReclaimClaim | null {
  const canonicalPath = fdPath(parentFd, lockName);
  if (
    !pathMatches(canonicalPath, inspection.fd, DIRECTORY_FLAGS)
    || !inspectedOwnerMatches(inspection)
    || !recoverLegacyClaims(inspection)
  ) return null;

  const claimPath = fdPath(inspection.fd, CLAIM_NAME);
  try {
    // One fixed O_EXCL entry elects one reclaimer inside the exact directory inspected above.
    fs.linkSync(fdPath(prepared.dirFd, OWNER_NAME), claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = inspectRecord(inspection.fd, CLAIM_NAME);
    try {
      if (recordCanBeRecovered(existing)) unlinkPinnedFile(inspection.fd, CLAIM_NAME, existing.fd!);
    } finally {
      closeRecord(existing);
    }
    return null;
  }

  let claimFd: number | undefined;
  try {
    claimFd = fs.openSync(claimPath, FILE_FLAGS);
    if (
      !sameIdentity(identity(claimFd), identity(prepared.ownerFd))
      || fs.fstatSync(claimFd, { bigint: true }).nlink !== 2n
    ) {
      fs.closeSync(claimFd);
      unlinkPinnedFile(inspection.fd, CLAIM_NAME, prepared.ownerFd);
      return null;
    }
    const claim = { fd: claimFd };
    syncDirectory(inspection.fd);
    if (
      pathMatches(canonicalPath, inspection.fd, DIRECTORY_FLAGS)
      && pathMatches(claimPath, claimFd, FILE_FLAGS)
      && inspectedOwnerMatches(inspection)
    ) return claim;
    removeClaim(inspection, claim);
    return null;
  } catch (error) {
    if (claimFd !== undefined) fs.closeSync(claimFd);
    try {
      unlinkPinnedFile(inspection.fd, CLAIM_NAME, prepared.ownerFd);
    } catch {
      // Preserve the claim-publication error.
    }
    throw error;
  }
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
  const claim = claimInspectedDirectory(inspection, prepared, parentFd, lockName);
  if (!claim) return null;

  let transitioned = false;
  try {
    if (!inspectedOwnerMatches(inspection)) {
      removeClaim(inspection, claim);
      return null;
    }
    fs.renameSync(fdPath(prepared.dirFd, OWNER_NAME), fdPath(inspection.fd, OWNER_NAME));
    transitioned = true;
    syncDirectory(inspection.fd);
    syncDirectory(parentFd);
    if (!verifyCanonicalLock(projectDirectory, parentFd, lockPath, inspection.fd, prepared.ownerFd, prepared.record)) {
      unlinkPinnedFile(inspection.fd, OWNER_NAME, prepared.ownerFd);
      removeClaim(inspection, claim);
      return null;
    }

    closeRecord(inspection.owner);
    inspection.owner.fd = undefined;
    const exactPrivateDirectory = pathMatches(prepared.path, prepared.dirFd, DIRECTORY_FLAGS);
    if (!exactPrivateDirectory || !removePinnedDirectory(parentFd, path.basename(prepared.path), prepared.dirFd)) {
      unlinkPinnedFile(inspection.fd, OWNER_NAME, prepared.ownerFd);
      removeClaim(inspection, claim);
      return null;
    }
    fs.closeSync(prepared.dirFd);
    prepared.dirFd = -1;

    if (!removeClaim(inspection, claim)) {
      unlinkPinnedFile(inspection.fd, OWNER_NAME, prepared.ownerFd);
      return null;
    }
    if (!verifyCanonicalLock(projectDirectory, parentFd, lockPath, inspection.fd, prepared.ownerFd, prepared.record)) {
      unlinkPinnedFile(inspection.fd, OWNER_NAME, prepared.ownerFd);
      return null;
    }
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
  } catch (error) {
    if (transitioned) {
      try {
        unlinkPinnedFile(inspection.fd, OWNER_NAME, prepared.ownerFd);
      } catch {
        // The exact transitioned owner is already absent.
      }
    }
    if (claim.fd >= 0) {
      try {
        removeClaim(inspection, claim);
      } catch {
        if (claim.fd >= 0) fs.closeSync(claim.fd);
      }
    }
    throw error;
  }
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

function cleanupCreatedDirectory(projectDirectory: string, createdDirectory: boolean): void {
  if (!createdDirectory) return;
  try {
    fs.rmdirSync(projectDirectory);
  } catch {
    // A peer or project artifact now owns the directory.
  }
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
  let prepared: PreparedLock | undefined;

  try {
    recoverPreparedLocks(parentFd, lockPath);
    prepared = prepareLock(parentFd);
    while (true) {
      const published = publishPrepared(
        prepared,
        projectDirectory,
        parentFd,
        lockPath,
        lockName,
        createdDirectory,
      );
      if (published) return published;
      if (prepared.dirFd < 0 || prepared.ownerFd < 0) {
        prepared = prepareLock(parentFd);
      }

      const existing = inspectLock(anchoredLockPath);
      if (existing.state === "legacy_file") {
        closeInspection(existing);
        unsupportedLock(lockPath, "legacy file");
      }
      if (existing.state === "unsupported") unsupportedLock(lockPath, existing.kind);
      if (existing.state === "directory") {
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
          if (lock) return lock;
        }
      }
      closeInspection(existing);

      if (Date.now() >= deadline) timeout(lockPath);
      Atomics.wait(sleepArray, 0, 0, Math.min(25, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    if (prepared !== undefined) disposePrepared(prepared, parentFd);
    fs.closeSync(parentFd);
    cleanupCreatedDirectory(projectDirectory, createdDirectory);
    throw error;
  }
}
