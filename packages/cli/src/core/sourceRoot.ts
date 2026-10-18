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
  return fs.existsSync(path.join(root, NPX_BUNDLE_SENTINEL)) && fs.existsSync(path.join(root, "skills", "agentera", "SKILL.md")) && fs.existsSync(path.join(root, "registry.json"));
}

/** Markers that identify an Agentera app source root (repo checkout or bundle). */
const SOURCE_MARKERS = [path.join("skills", "agentera", "SKILL.md"), "registry.json"];

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
 * references/, etc. AGENTERA_BOOTSTRAP_SOURCE_ROOT wins, followed by a
 * checkout containing the executing module, a self-contained package bundle,
 * and finally a walk-up from the working directory.
 */
export function resolveSourceRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env[BOOTSTRAP_SOURCE_ROOT_ENV];
  if (configured) {
    return path.resolve(expanduser(configured));
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = walkUp(moduleDir);
  if (fromModule) {
    return fromModule;
  }
  // A packaged CLI must keep runtime code and app data on the same version.
  // Otherwise an Agentera checkout used as cwd can override the package bundle.
  const bundled = path.resolve(moduleDir, "..", "..", "bundle");
  if (isNpxBundleRoot(bundled)) {
    return bundled;
  }
  const fromCwd = walkUp(process.cwd());
  if (fromCwd) {
    return fromCwd;
  }
  // Last resort: package root two levels above dist/core.
  return path.resolve(moduleDir, "..", "..");
}

const BOOTSTRAP_SOURCE_EVIDENCE = ["skills", "skills/agentera/SKILL.md", "registry.json"] as const;

/** Required bootstrap source entries absent from root. */
export function bootstrapSourceMissing(root: string): string[] {
  // A self-contained npx bundle ships app data without the Python source
  // surface, so the sentinel plus skill and registry are complete evidence.
  const required = fs.existsSync(path.join(root, NPX_BUNDLE_SENTINEL)) ? BOOTSTRAP_SOURCE_EVIDENCE.slice(1) : BOOTSTRAP_SOURCE_EVIDENCE;
  return required.filter((entry) => !fs.existsSync(path.join(root, entry)));
}

export class BootstrapSourceMissingError extends Error {
  constructor(
    readonly root: string,
    readonly missing: string[],
  ) {
    super(`bootstrap source root ${root} is missing: ${missing.join(", ")}`);
    this.name = "BootstrapSourceMissingError";
  }
}
