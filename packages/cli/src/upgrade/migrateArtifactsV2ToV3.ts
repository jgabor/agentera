import fs from "node:fs";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { BUNDLE_MARKER } from "../state/installRoot.js";
import { doctorRoots } from "./appModel.js";
import {
  AGENTERA_USER_STATE_NAMES,
  ROOT_USER_STATE_DIR_NAMES,
  ROOT_USER_STATE_FILE_NAMES,
} from "./doctor.js";
import {
  applyRuntimeMigrationItems,
  planRuntimeMigrationItems,
  resolveNpxHookCommands,
  rewireRuntimeText,
} from "./runtimeMigration.js";

/**
 * v2→v3 migration phases: artifacts (noop for YAML), runtime rewire, cleanup.
 * v1 Markdown→YAML migration stays separate (prime.ts V1_ARTIFACT_PAIRS).
 */

export const MIGRATION_STATUSES = ["pending", "applied", "noop", "blocked", "failed", "skipped"] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

export const V1_ARTIFACT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [".agentera/PROGRESS.md", ".agentera/progress.yaml"],
  [".agentera/PLAN.md", ".agentera/plan.yaml"],
  [".agentera/DECISIONS.md", ".agentera/decisions.yaml"],
  [".agentera/HEALTH.md", ".agentera/health.yaml"],
  [".agentera/DOCS.md", ".agentera/docs.yaml"],
  ["VISION.md", ".agentera/vision.yaml"],
];

/** Default development-channel npm entrypoint for tests and legacy imports. */
export const NPX_CLI_ENTRYPOINT = "npx -y agentera@next";
export const NPX_HOOK_VALIDATE = `${NPX_CLI_ENTRYPOINT} hook validate-artifact`;
export const NPX_HOOK_CURSOR_SESSION_START = `${NPX_CLI_ENTRYPOINT} hook cursor-session-start`;
export const NPX_HOOK_CURSOR_SESSION_STOP = `${NPX_CLI_ENTRYPOINT} hook session-stop`;
export const NPX_HOOK_CURSOR_PRE_TOOL = `${NPX_CLI_ENTRYPOINT} hook cursor-pre-tool-use`;

export { rewireRuntimeText, resolveNpxHookCommands };

export interface MigrationPhaseItem {
  status: MigrationStatus;
  action: string;
  message: string;
  source?: string;
  target?: string;
  runtime?: string;
  preserved?: string[];
  removedPreview?: string[];
  newText?: string;
}

export interface MigrationPhaseSummary {
  pending: number;
  applied: number;
  noop: number;
  blocked: number;
  failed: number;
  skipped: number;
}

export interface MigrationPhase {
  name: "artifacts" | "runtime" | "cleanup";
  status: MigrationStatus;
  summary: MigrationPhaseSummary;
  items: MigrationPhaseItem[];
  message: string;
}

export interface MigrationContext {
  appHome: string;
  project: string;
  home: string;
  force?: boolean;
  sourceRoot?: string;
  channel?: string | null;
  env?: Record<string, string | undefined>;
}

export interface DryRunMigrationResult {
  artifacts: MigrationPhase;
  runtime: MigrationPhase;
  cleanup: MigrationPhase;
}

function emptySummary(): MigrationPhaseSummary {
  return { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0, skipped: 0 };
}

export function summarizePhase(
  name: MigrationPhase["name"],
  items: MigrationPhaseItem[],
  message = "",
): MigrationPhase {
  const summary = emptySummary();
  for (const item of items) {
    summary[item.status] += 1;
  }
  let status: MigrationStatus;
  if (summary.blocked > 0) {
    status = "blocked";
  } else if (summary.failed > 0) {
    status = "failed";
  } else if (summary.pending > 0) {
    status = "pending";
  } else if (summary.applied > 0) {
    status = "applied";
  } else if (summary.skipped > 0 && summary.noop === 0 && summary.applied === 0) {
    status = "skipped";
  } else {
    status = "noop";
  }
  return { name, status, summary, items, message };
}

export function detectV1ArtifactPairs(project: string): string[] {
  const root = resolvePath(project);
  const found: string[] = [];
  for (const [md, yaml] of V1_ARTIFACT_PAIRS) {
    if (isFile(path.join(root, md)) && !isFile(path.join(root, yaml))) {
      found.push(md);
    }
  }
  return found;
}

function listV2YamlArtifacts(project: string): string[] {
  const root = resolvePath(project);
  const agenteraDir = path.join(root, ".agentera");
  if (!pathExists(agenteraDir)) {
    return [];
  }
  const out: string[] = [];
  for (const name of AGENTERA_USER_STATE_NAMES) {
    const rel = path.join(".agentera", name);
    if (isFile(path.join(root, rel))) {
      out.push(rel);
    }
  }
  const vision = path.join(root, ".agentera", "vision.yaml");
  if (isFile(vision)) {
    out.push(".agentera/vision.yaml");
  }
  return out;
}

export function planArtifactsPhase(project: string): MigrationPhase {
  const root = resolvePath(project);
  if (!pathExists(root) || !fs.statSync(root).isDirectory()) {
    return summarizePhase("artifacts", [
      {
        status: "blocked",
        action: "validate",
        message: `project is not a directory: ${root}`,
      },
    ]);
  }

  const v1Pairs = detectV1ArtifactPairs(root);
  if (v1Pairs.length > 0) {
    const items: MigrationPhaseItem[] = v1Pairs.map((source) => ({
      status: "blocked",
      action: "validate",
      source,
      message:
        "v1 Markdown artifacts require separate v1→v2 migration; v2→v3 preserves existing YAML only",
    }));
    return summarizePhase("artifacts", items);
  }

  const yamlArtifacts = listV2YamlArtifacts(root);
  if (yamlArtifacts.length === 0) {
    return summarizePhase("artifacts", [], "no project artifacts found");
  }

  const items: MigrationPhaseItem[] = yamlArtifacts.map((source) => ({
    status: "noop",
    action: "preserve",
    source,
    message: "v2 YAML artifact preserved; no v2→v3 schema migration required",
  }));
  return summarizePhase("artifacts", items);
}

export function applyArtifactsPhase(phase: MigrationPhase, _project: string): void {
  phase.status = summarizePhase("artifacts", phase.items, phase.message).status;
}

export function planRuntimeRewirePhase(ctx: MigrationContext): MigrationPhase {
  const items = planRuntimeMigrationItems(ctx);
  return summarizePhase(
    "runtime",
    items,
    items.length === 0 ? "no runtime configs with Python managed app-home references found" : "",
  );
}

export function applyRuntimeRewirePhase(phase: MigrationPhase, ctx?: MigrationContext): void {
  if (ctx) {
    applyRuntimeMigrationItems(phase.items, ctx);
  } else {
    applyRuntimeMigrationItems(phase.items, {
      appHome: "",
      project: "",
      home: "",
    });
  }
  const updated = summarizePhase("runtime", phase.items, phase.message);
  phase.status = updated.status;
  phase.summary = updated.summary;
}

function agenteraUserStateDirIsRecognized(dir: string): boolean {
  if (!pathExists(dir) || !fs.statSync(dir).isDirectory()) {
    return false;
  }
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (AGENTERA_USER_STATE_NAMES.has(entry) && st.isFile()) {
      continue;
    }
    if (entry === "optimera" && st.isDirectory()) {
      continue;
    }
    return false;
  }
  return true;
}

function isPreservedUserStateEntry(appHome: string, entry: string): boolean {
  const full = path.join(appHome, entry);
  if (!pathExists(full)) {
    return false;
  }
  const st = fs.statSync(full);
  if (ROOT_USER_STATE_FILE_NAMES.has(entry) && st.isFile()) {
    return true;
  }
  if (ROOT_USER_STATE_DIR_NAMES.has(entry) && st.isDirectory()) {
    return true;
  }
  if (entry === ".agentera" && agenteraUserStateDirIsRecognized(full)) {
    return true;
  }
  return false;
}

function listPreservedUserStatePaths(appHome: string): string[] {
  const preserved: string[] = [];
  for (const entry of listPreservedUserState(appHome)) {
    const full = path.join(appHome, entry);
    preserved.push(full);
    if (entry === ".agentera" && pathExists(full) && fs.statSync(full).isDirectory()) {
      for (const name of AGENTERA_USER_STATE_NAMES) {
        const nested = path.join(full, name);
        if (isFile(nested)) {
          preserved.push(nested);
        }
      }
    }
  }
  return preserved.sort();
}

function hasManagedBundleEvidence(managedAppRoot: string): boolean {
  return (
    isFile(path.join(managedAppRoot, BUNDLE_MARKER)) ||
    (isFile(path.join(managedAppRoot, "scripts", "agentera")) &&
      isFile(path.join(managedAppRoot, "skills", "agentera", "SKILL.md")))
  );
}

function listManagedBundlePreview(managedAppRoot: string, limit = 20): string[] {
  if (!pathExists(managedAppRoot)) {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (out.length >= limit) {
      return;
    }
    for (const entry of fs.readdirSync(dir)) {
      if (out.length >= limit) {
        return;
      }
      const rel = prefix ? `${prefix}/${entry}` : entry;
      out.push(`app/${rel}`);
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full, rel);
      }
    }
  };
  walk(managedAppRoot, "");
  return out;
}

function appHomeHasUnrecognizedEntries(appHome: string): string[] {
  if (!pathExists(appHome)) {
    return [];
  }
  const unknown: string[] = [];
  for (const entry of fs.readdirSync(appHome)) {
    if (entry === "app") {
      continue;
    }
    if (!isPreservedUserStateEntry(appHome, entry)) {
      unknown.push(entry);
    }
  }
  return unknown;
}

export function planCleanupPhase(ctx: MigrationContext): MigrationPhase {
  const appHome = resolvePath(ctx.appHome);
  const roots = doctorRoots(appHome);
  const managedAppRoot = roots.managedAppRoot;
  const preserved = listPreservedUserStatePaths(appHome);
  const unknown = appHomeHasUnrecognizedEntries(appHome);

  if (unknown.length > 0 && !ctx.force) {
    return summarizePhase("cleanup", [
      {
        status: "blocked",
        action: "remove-managed-app-home",
        source: appHome,
        preserved,
        message:
          "app home contains unrecognized entries outside preserved user state; cleanup blocked without --force",
      },
    ]);
  }

  if (!hasManagedBundleEvidence(managedAppRoot)) {
    return summarizePhase("cleanup", [], "no managed Python app-home bundle to remove");
  }

  const removedPreview = listManagedBundlePreview(managedAppRoot);
  return summarizePhase("cleanup", [
    {
      status: "pending",
      action: "remove-managed-app-home",
      source: managedAppRoot,
      target: appHome,
      preserved,
      removedPreview,
      message:
        "will remove managed Python app-home bundle under app/ while preserving user state at app-home root",
    },
  ]);
}

function listPreservedUserState(appHome: string): string[] {
  if (!pathExists(appHome)) {
    return [];
  }
  const preserved: string[] = [];
  for (const entry of fs.readdirSync(appHome)) {
    if (entry === "app") {
      continue;
    }
    if (isPreservedUserStateEntry(appHome, entry)) {
      preserved.push(entry);
    }
  }
  return preserved.sort();
}

function removeDirectoryRecursive(dir: string): void {
  if (!pathExists(dir)) {
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function applyCleanupPhase(phase: MigrationPhase): void {
  for (const item of phase.items) {
    if (item.status !== "pending" || !item.source) {
      continue;
    }
    try {
      removeDirectoryRecursive(item.source);
      item.status = "applied";
      item.message = "managed Python app-home bundle removed; user state preserved";
    } catch (exc) {
      item.status = "failed";
      item.message = `cleanup failed: ${(exc as Error).message}`;
    }
  }
  const updated = summarizePhase("cleanup", phase.items, phase.message);
  phase.status = updated.status;
  phase.summary = updated.summary;
}

export function dryRunMigration(ctx: MigrationContext): DryRunMigrationResult {
  return {
    artifacts: planArtifactsPhase(ctx.project),
    runtime: planRuntimeRewirePhase(ctx),
    cleanup: planCleanupPhase(ctx),
  };
}

export type MigrationPhaseName = "artifacts" | "runtime" | "cleanup";

export function applyMigrationPhases(
  ctx: MigrationContext,
  preview: DryRunMigrationResult,
  only: readonly MigrationPhaseName[] = ["artifacts", "runtime", "cleanup"],
): DryRunMigrationResult {
  const result: DryRunMigrationResult = {
    artifacts: { ...preview.artifacts, items: preview.artifacts.items.map((item) => ({ ...item })) },
    runtime: { ...preview.runtime, items: preview.runtime.items.map((item) => ({ ...item })) },
    cleanup: { ...preview.cleanup, items: preview.cleanup.items.map((item) => ({ ...item })) },
  };
  if (only.includes("artifacts")) {
    applyArtifactsPhase(result.artifacts, ctx.project);
  }
  if (only.includes("runtime")) {
    applyRuntimeRewirePhase(result.runtime, ctx);
  }
  if (only.includes("cleanup")) {
    applyCleanupPhase(result.cleanup);
  }
  return result;
}
