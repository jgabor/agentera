import fs from "node:fs";
import path from "node:path";

import { isFile } from "../core/paths.js";

const HEAD_READ_BYTES = 2048;

export function readScriptHead(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const bytes = fs.readSync(fd, buf, 0, HEAD_READ_BYTES, 0);
    return buf.slice(0, bytes).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function hasBundleRootEvidence(root: string): boolean {
  if (!isFile(path.join(root, "scripts", "agentera"))) {
    return false;
  }
  if (!isFile(path.join(root, "skills", "agentera", "SKILL.md"))) {
    return false;
  }
  return readScriptHead(path.join(root, "scripts", "agentera")) !== null;
}
