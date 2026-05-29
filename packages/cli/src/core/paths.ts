import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Expand a leading `~` / `~/...` to the user's home directory, mirroring
 * Python's `Path.expanduser()` for the common cases Agentera relies on.
 */
export function expanduser(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Absolute, symlink-resolved path that approximates Python's
 * `Path(...).expanduser().resolve()` (strict=False): resolve symlinks for the
 * portion that exists, otherwise return the normalized absolute path.
 */
export function resolvePath(p: string): string {
  const abs = path.resolve(expanduser(p));
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

/** True when `p` exists on disk (file, dir, or symlink target). */
export function pathExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** True when `p` exists and is a regular file. */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
