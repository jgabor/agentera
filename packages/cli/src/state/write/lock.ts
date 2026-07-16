import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { assertRealpathBoundary } from "../../registries/artifactRegistry.js";
import { reject } from "./errors.js";

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const INITIALIZATION_GRACE_MS = 250;
const OWNER_NAME = "owner.json";
const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_DIRECTORY ?? 0)
  | (fs.constants.O_NOFOLLOW ?? 0);

interface LockRecord {
  pid: number;
  token: string;
  created_at: string;
}

type LockRead =
  | { state: "absent" }
  | { state: "valid"; record: LockRecord }
  | { state: "malformed"; stale: boolean };

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

function readLock(lockPath: string): LockRead {
  let lockFd: number | undefined;
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { state: "malformed", stale: Date.now() - stat.mtimeMs >= INITIALIZATION_GRACE_MS };
    }
    lockFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
    const ownerPath = `/proc/self/fd/${lockFd}/${OWNER_NAME}`;
    try {
      const ownerStat = fs.lstatSync(ownerPath);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) {
        return { state: "malformed", stale: Date.now() - ownerStat.mtimeMs >= INITIALIZATION_GRACE_MS };
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
      const record = lockRecord(parsed);
      return record
        ? { state: "valid", record }
        : { state: "malformed", stale: Date.now() - ownerStat.mtimeMs >= INITIALIZATION_GRACE_MS };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "malformed", stale: Date.now() - stat.mtimeMs >= INITIALIZATION_GRACE_MS };
      }
      return { state: "malformed", stale: Date.now() - stat.mtimeMs >= INITIALIZATION_GRACE_MS };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    throw error;
  } finally {
    if (lockFd !== undefined) fs.closeSync(lockFd);
  }
}

function sameLock(left: LockRecord, right: LockRecord): boolean {
  return left.pid === right.pid
    && left.token === right.token
    && left.created_at === right.created_at;
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
  const fd = typeof directory === "number" ? directory : fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    if (typeof directory !== "number") fs.closeSync(fd);
  }
}

function readRecordFromDirectory(lockFd: number): LockRecord | null {
  try {
    const ownerPath = `/proc/self/fd/${lockFd}/${OWNER_NAME}`;
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return lockRecord(JSON.parse(fs.readFileSync(ownerPath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function removeOwnedLock(lockPath: string, parentDir: string, expected: LockRecord): boolean {
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const observed = readRecordFromDirectory(lockFd);
    if (!observed || !sameLock(observed, expected)) return false;
    try {
      fs.unlinkSync(`/proc/self/fd/${lockFd}/${OWNER_NAME}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    syncDirectory(lockFd);
  } finally {
    fs.closeSync(lockFd);
  }
  fs.rmdirSync(lockPath);
  syncDirectory(parentDir);
  return true;
}

function removeMalformedLock(lockPath: string, parentDir: string): boolean {
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const claim: LockRecord = {
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
  };
  try {
    if (readRecordFromDirectory(lockFd)) return false;
    try {
      fs.unlinkSync(`/proc/self/fd/${lockFd}/${OWNER_NAME}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let ownerFd: number;
    try {
      ownerFd = fs.openSync(
        `/proc/self/fd/${lockFd}/${OWNER_NAME}`,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      fs.writeFileSync(ownerFd, `${JSON.stringify(claim)}\n`);
      fs.fsyncSync(ownerFd);
    } finally {
      fs.closeSync(ownerFd);
    }
    syncDirectory(lockFd);
  } finally {
    fs.closeSync(lockFd);
  }
  return removeOwnedLock(lockPath, parentDir, claim);
}

function cleanupFailedAcquisition(lockPath: string, parentDir: string): void {
  try {
    const lockFd = fs.openSync(lockPath, DIRECTORY_FLAGS);
    try {
      try {
        fs.unlinkSync(`/proc/self/fd/${lockFd}/${OWNER_NAME}`);
      } catch {
        /* metadata was not published */
      }
    } finally {
      fs.closeSync(lockFd);
    }
    fs.rmdirSync(lockPath);
    syncDirectory(parentDir);
  } catch {
    /* acquisition already failed */
  }
}

export interface WriterLock {
  path: string;
  release: () => void;
}

export function acquireWriterLock(projectRoot: string, timeoutMs = 2000): WriterLock {
  const dir = path.join(projectRoot, ".agentera");
  assertRealpathBoundary(projectRoot, dir, "writer lock");
  const createdDir = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, ".writer.lock");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const record: LockRecord = {
      pid: process.pid,
      token: randomUUID(),
      created_at: new Date().toISOString(),
    };
    let createdLock = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      createdLock = true;
      const ownerPath = path.join(lockPath, OWNER_NAME);
      const ownerFd = fs.openSync(
        ownerPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        fs.writeFileSync(ownerFd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(ownerFd);
      } finally {
        fs.closeSync(ownerFd);
      }
      syncDirectory(lockPath);
      syncDirectory(dir);
      let released = false;
      return {
        path: lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            removeOwnedLock(lockPath, dir, record);
          } catch {
            /* a missing or replaced lock is not this owner's to remove */
          }
          if (createdDir) {
            try {
              fs.rmdirSync(dir);
            } catch {
              /* a published artifact or peer now owns the directory */
            }
          }
        },
      };
    } catch (error) {
      if (createdLock) cleanupFailedAcquisition(lockPath, dir);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (existing.state === "valid" && ownerIsDead(existing.record)) {
        if (removeOwnedLock(lockPath, dir, existing.record)) continue;
      } else if (existing.state === "malformed" && existing.stale) {
        if (removeMalformedLock(lockPath, dir)) continue;
      } else if (existing.state === "absent") {
        continue;
      }
      if (Date.now() >= deadline) {
        reject({
          class: "conflict",
          message: `writer lock timeout at '${lockPath}'; retry the command after the active writer finishes`,
          syntax: "agentera state <artifact-id> <verb> ... --format json",
          example: "retry the same command after the active writer finishes",
        });
      }
      Atomics.wait(sleepArray, 0, 0, 25);
    }
  }
}
