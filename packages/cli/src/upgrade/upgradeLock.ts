import fs from "node:fs";
import path from "node:path";

import { pathExists } from "../core/paths.js";
import { writeFileAtomic } from "./atomicWriter.js";

const LOCK_NAME = "upgrade.lock";

export function upgradeLockPath(appHome: string): string {
  return path.join(appHome, ".agentera", LOCK_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function acquireUpgradeLock(appHome: string): void {
  const lockDir = path.join(appHome, ".agentera");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = upgradeLockPath(appHome);
  if (pathExists(lockPath)) {
    let existing: { pid?: number } = {};
    try {
      existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      existing = {};
    }
    const pid = typeof existing.pid === "number" ? existing.pid : NaN;
    if (Number.isFinite(pid) && isProcessAlive(pid)) {
      throw new Error(
        `upgrade in progress (pid ${pid}); remove ${lockPath} if stale`,
      );
    }
    fs.rmSync(lockPath, { force: true });
  }
  const payload = JSON.stringify({
    pid: process.pid,
    started: new Date().toISOString(),
  });
  writeFileAtomic(lockPath, payload);
}

export function releaseUpgradeLock(appHome: string): void {
  const lockPath = upgradeLockPath(appHome);
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // already gone
  }
}
