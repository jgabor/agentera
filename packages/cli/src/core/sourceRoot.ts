import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expanduser } from "./paths.js";

export const BOOTSTRAP_SOURCE_ROOT_ENV = "AGENTERA_BOOTSTRAP_SOURCE_ROOT";

/** Markers that identify an Agentera app source root (repo checkout or bundle). */
const SOURCE_MARKERS = [
  path.join("skills", "agentera", "SKILL.md"),
  path.join("scripts", "agentera"),
];

function hasSourceMarker(dir: string): boolean {
  return SOURCE_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)));
}

function walkUp(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (hasSourceMarker(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Resolve the Agentera "app source root" that holds skills/, scripts/, schemas,
 * references/, etc. Mirrors the bootstrap precedence in src/agentera/__main__.py:
 * AGENTERA_BOOTSTRAP_SOURCE_ROOT wins, then a walk-up from the module location,
 * then a walk-up from the working directory.
 */
export function resolveSourceRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[BOOTSTRAP_SOURCE_ROOT_ENV];
  if (configured) {
    return path.resolve(expanduser(configured));
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = walkUp(moduleDir);
  if (fromModule) {
    return fromModule;
  }
  const fromCwd = walkUp(process.cwd());
  if (fromCwd) {
    return fromCwd;
  }
  // Last resort: package root two levels above dist/core.
  return path.resolve(moduleDir, "..", "..");
}
