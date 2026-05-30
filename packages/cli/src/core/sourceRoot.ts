import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expanduser } from "./paths.js";

export const BOOTSTRAP_SOURCE_ROOT_ENV = "AGENTERA_BOOTSTRAP_SOURCE_ROOT";

/** Sentinel file marking a self-contained npx app bundle (see scripts/copy-bundle.mjs). */
export const NPX_BUNDLE_SENTINEL = ".agentera-npx-bundle.json";

/**
 * Detect a self-contained npx app bundle: the published `agentera` package
 * stages app data (skills/, references/, registry.json) under <pkg>/bundle and
 * writes the sentinel there. When the CLI's source root is such a bundle, the
 * bundle IS the authoritative, always-current app (no install/upgrade step).
 * The sentinel never exists in a repo checkout or an installed managed app.
 */
export function isNpxBundleRoot(root: string): boolean {
  return (
    fs.existsSync(path.join(root, NPX_BUNDLE_SENTINEL)) &&
    fs.existsSync(path.join(root, "skills", "agentera", "SKILL.md")) &&
    fs.existsSync(path.join(root, "registry.json"))
  );
}

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
  // Self-contained npm package: app data is staged under <packageRoot>/bundle
  // (see scripts/copy-bundle.mjs). This makes `npx agentera` work with no repo
  // checkout and no AGENTERA_HOME. Only reached when no checkout/app-home is
  // found, so it never overrides a real checkout, installed app, or cwd match.
  const bundled = path.resolve(moduleDir, "..", "..", "bundle");
  if (hasSourceMarker(bundled)) {
    return bundled;
  }
  // Last resort: package root two levels above dist/core.
  return path.resolve(moduleDir, "..", "..");
}
