import fs from "node:fs";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { doctorRoots } from "./appModel.js";
import type { MigrationContext, MigrationPhaseItem, MigrationStatus } from "./migrateArtifactsV2ToV3.js";

export const INSTALLED_HOOKS_SURFACE_LABEL = "hooks/";
export const RETIRE_INSTALLED_HOOKS_ACTION = "retire-installed-hooks";

const V2_HOOK_INVOCATION_PATTERNS = [
  /\buv run\b[^"'\n]*hooks\/[^"'\n]*\.py/,
  /\$\{AGENTERA_HOME\}\/hooks\/[^"'\n]*\.py/,
  /\$\{AGENTERA_HOME\}\/app\/hooks\/[^"'\n]*\.py/,
  /\$\{PLUGIN_ROOT\}\/hooks\/[^"'\n]*\.py/,
] as const;

const SKIP_HOOK_SCAN_PARTS = new Set([".agentera", "sessions", "benchmarks", "intermediate", "backup"]);

function hooksDirHasPythonFiles(hooksDir: string): boolean {
  if (!pathExists(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
    return false;
  }
  return fs.readdirSync(hooksDir).some((name: string) => name.endsWith(".py"));
}

function listInstalledHookDirs(appHome: string): string[] {
  const resolved = resolvePath(appHome);
  const roots = doctorRoots(resolved);
  const candidates = [
    path.join(resolved, "hooks"),
    path.join(roots.managedAppRoot, "hooks"),
    path.join(roots.activeBundleRoot, "hooks"),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hooksDir of candidates) {
    const normalized = path.resolve(hooksDir);
    if (seen.has(normalized) || !hooksDirHasPythonFiles(hooksDir)) {
      continue;
    }
    seen.add(normalized);
    out.push(hooksDir);
  }
  return out;
}

export function installedBundleUsesV2PythonHooks(appHome: string): boolean {
  return listInstalledHookDirs(appHome).length > 0;
}

export function textReferencesV2InstalledHooks(text: string): boolean {
  return V2_HOOK_INVOCATION_PATTERNS.some((pattern) => pattern.test(text));
}

function shouldScanInstalledHookFile(name: string): boolean {
  return (
    name.endsWith(".json") ||
    name.endsWith(".toml") ||
    name.endsWith(".js") ||
    name.endsWith(".md") ||
    name.endsWith(".yaml") ||
    name.endsWith(".yml")
  );
}

/** Scan installed hook manifests for shipped v2 hook command invocations. */
export function scanInstalledBundleForV2HookInvocations(appHome: string): string[] {
  const resolved = resolvePath(appHome);
  const hits: string[] = [];
  for (const hooksDir of listInstalledHookDirs(resolved)) {
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!shouldScanInstalledHookFile(entry.name)) {
          continue;
        }
        const rel = path.relative(resolved, full);
        const text = fs.readFileSync(full, "utf8");
        if (textReferencesV2InstalledHooks(text)) {
          hits.push(rel);
        }
      }
    };
    walk(hooksDir);
  }
  return hits;
}

export function detectStaleInstalledHooksSurface(appHome: string): boolean {
  return (
    installedBundleUsesV2PythonHooks(appHome) ||
    scanInstalledBundleForV2HookInvocations(appHome).length > 0
  );
}

export function retireInstalledV2Hooks(appHome: string): string[] {
  const removed: string[] = [];
  for (const hooksDir of listInstalledHookDirs(appHome)) {
    fs.rmSync(hooksDir, { recursive: true, force: true });
    removed.push(path.relative(resolvePath(appHome), hooksDir) || "hooks");
  }
  return removed;
}

function retireItemStatus(stale: boolean): MigrationStatus {
  return stale ? "pending" : "noop";
}

export function planInstalledHooksRetirementItems(ctx: MigrationContext): MigrationPhaseItem[] {
  const appHome = resolvePath(ctx.appHome);
  const hookDirs = listInstalledHookDirs(appHome);
  const invocationHits = scanInstalledBundleForV2HookInvocations(appHome);
  const stale = hookDirs.length > 0 || invocationHits.length > 0;
  if (!stale) {
    return [
      {
        status: "noop",
        action: RETIRE_INSTALLED_HOOKS_ACTION,
        runtime: "installed-app",
        source: appHome,
        message: "installed app home has no v2 Python hooks surface",
      },
    ];
  }

  const items: MigrationPhaseItem[] = [];
  for (const hooksDir of hookDirs) {
    items.push({
      status: "pending",
      action: RETIRE_INSTALLED_HOOKS_ACTION,
      runtime: "installed-app",
      source: hooksDir,
      target: appHome,
      message: `will retire v2 Python hooks at ${path.relative(appHome, hooksDir) || "hooks"}`,
      removedPreview: fs.readdirSync(hooksDir).filter((name: string) => name.endsWith(".py")),
    });
  }
  if (invocationHits.length > 0) {
    items.push({
      status: retireItemStatus(true),
      action: RETIRE_INSTALLED_HOOKS_ACTION,
      runtime: "installed-app",
      source: appHome,
      message: `will remove installed bundle files still invoking uv run hooks/*.py (${invocationHits.join(", ")})`,
      removedPreview: invocationHits,
    });
  }
  return items;
}

export function applyInstalledHooksRetirementItems(items: MigrationPhaseItem[], ctx: MigrationContext): void {
  const pending = items.filter(
    (item) => item.action === RETIRE_INSTALLED_HOOKS_ACTION && item.status === "pending",
  );
  if (pending.length === 0) {
    return;
  }
  try {
    const removed = retireInstalledV2Hooks(ctx.appHome);
    for (const item of pending) {
      item.status = "applied";
      item.message =
        removed.length > 0
          ? `retired v2 Python hooks (${removed.join(", ")})`
          : "retired v2 Python hook invocations from installed bundle";
    }
  } catch (exc) {
    for (const item of pending) {
      item.status = "failed";
      item.message = `${RETIRE_INSTALLED_HOOKS_ACTION} failed: ${(exc as Error).message}`;
    }
  }
}

export function installedHookPathsAfterMigration(appHome: string): string[] {
  const resolved = resolvePath(appHome);
  const out: string[] = [];
  const walk = (current: string): void => {
    if (!pathExists(current)) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_HOOK_SCAN_PARTS.has(entry.name)) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "hooks") {
          for (const hookEntry of fs.readdirSync(full)) {
            if (hookEntry.endsWith(".py")) {
              out.push(path.relative(resolved, path.join(full, hookEntry)));
            }
          }
        }
        walk(full);
      }
    }
  };
  walk(resolved);
  return out;
}

export function installedBundleHasV2HookInvocationText(appHome: string): boolean {
  return scanInstalledBundleForV2HookInvocations(appHome).length > 0;
}

export function isV2HookScript(filePath: string): boolean {
  return isFile(filePath) && filePath.endsWith(".py") && filePath.includes(`${path.sep}hooks${path.sep}`);
}
