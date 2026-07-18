import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type UpgradeMutationDomain = "project" | "runtime";

interface UpgradeLockRecord {
  pid: number;
  token: string;
  started: string;
}

export interface UpgradeLock {
  domain: UpgradeMutationDomain;
  path: string;
  token: string;
}

const MAX_LOCK_BYTES = 4 * 1024;

export class UpgradeLockError extends Error {
  constructor(lockPath: string) {
    super(`upgrade mutation is locked; inspect ${lockPath}, remove that file only if no upgrade owns it, then rerun`);
    this.name = "UpgradeLockError";
  }
}

export function upgradeLockPath(root: string, domain: UpgradeMutationDomain): string {
  return path.join(root, ".agentera", `upgrade-${domain}.lock`);
}

function manualRecovery(lockPath: string): Error {
  return new UpgradeLockError(lockPath);
}

function lockRecord(lockPath: string): UpgradeLockRecord | null {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOCK_BYTES) return null;
    const value: unknown = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (
      value === null
      || typeof value !== "object"
      || !Number.isSafeInteger((value as { pid?: unknown }).pid)
      || (value as { pid: number }).pid <= 0
      || typeof (value as { token?: unknown }).token !== "string"
      || (value as { token: string }).token.length === 0
      || typeof (value as { started?: unknown }).started !== "string"
    ) return null;
    return value as UpgradeLockRecord;
  } catch {
    return null;
  }
}

export function acquireUpgradeLock(root: string, domain: UpgradeMutationDomain): UpgradeLock {
  const lockPath = upgradeLockPath(root, domain);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw manualRecovery(lockPath);
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { domain, path: lockPath, token };
}

export function releaseUpgradeLock(lock: UpgradeLock): void {
  const record = lockRecord(lock.path);
  if (!record || record.token !== lock.token) throw manualRecovery(lock.path);
  fs.unlinkSync(lock.path);
}
