import fs from "node:fs";
import path from "node:path";

import { assertRealpathBoundary } from "../../registries/artifactRegistry.js";

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const INITIALIZATION_GRACE_MS = 250;

function malformedLockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs >= INITIALIZATION_GRACE_MS;
  } catch {
    return true;
  }
}

function ownerIsDead(lockPath: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: number };
    if (!Number.isInteger(parsed.pid)) return malformedLockIsStale(lockPath);
    if (parsed.pid === process.pid) return false;
    try {
      process.kill(parsed.pid as number, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return malformedLockIsStale(lockPath);
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
    let fd: number | undefined;
    let createdLock = false;
    try {
      fd = fs.openSync(lockPath, "wx");
      createdLock = true;
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }) + "\n",
      );
      fs.closeSync(fd);
      fd = undefined;
      let released = false;
      return {
        path: lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* already released */
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
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* acquisition already failed */
        }
      }
      if (createdLock) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* acquisition already failed */
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (ownerIsDead(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* raced with another writer */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `writer lock timeout at '${lockPath}'; retry the command after the active writer finishes`,
        );
      }
      Atomics.wait(sleepArray, 0, 0, 25);
    }
  }
}
