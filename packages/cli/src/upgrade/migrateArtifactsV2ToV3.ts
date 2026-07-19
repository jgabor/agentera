import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { loadYamlMapping } from "../core/yaml.js";
import { loadArtifactRecord, resolveArtifactPath } from "../registries/artifactRegistry.js";
import { BUNDLE_MARKER } from "../state/installRoot.js";
import { doctorRoots } from "./appModel.js";
import {
  AGENTERA_USER_STATE_NAMES,
} from "./doctor.js";
import {
  appHomeHasUnrecognizedEntriesWithPreflight,
  handoffCatalogMessage,
  resolveMigrationUserStatePreflight,
} from "../migrate/v2HandoffManifest.js";
import {
  applyAppContentRefreshItems,
  planAppContentRefreshItems,
} from "./appContentRefresh.js";
import {
  applyLegacyAgentCleanupItems,
  planLegacyAgentCleanupItems,
  planLegacyCapabilityAgentCleanupItems,
} from "./legacyAgentCleanup.js";
import {
  applyRuntimeMigrationItems,
  planRuntimeMigrationItems,
  resolveNpxHookCommands,
  rewireRuntimeText,
} from "./runtimeMigration.js";
import { writeFileAtomic } from "./atomicWriter.js";

/**
 * v2→v3 migration phases: artifacts (noop for YAML), runtime rewire, cleanup.
 */

export const MIGRATION_STATUSES = ["pending", "applied", "noop", "blocked", "failed"] as const;
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
  collisions?: string[];
  removedPreview?: string[];
  newText?: string;
}

export interface MigrationPhaseSummary {
  pending: number;
  applied: number;
  noop: number;
  blocked: number;
  failed: number;
}

export interface MigrationPhase {
  name: "artifacts" | "runtime" | "cleanup";
  status: MigrationStatus;
  summary: MigrationPhaseSummary;
  items: MigrationPhaseItem[];
  message: string;
}

const PLAN_ARCHIVE_FILE = /^PLAN-.+\.ya?ml$/i;
const PLAN_LIFECYCLE_ACTION = "normalize-plan-lifecycle";

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function relativeToProject(project: string, artifactPath: string): string {
  return path.relative(project, artifactPath);
}

function planTaskList(data: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(data.tasks)) return data.tasks;
  if (Array.isArray(data.entries)) return data.entries;
  return null;
}

function completedTasksOnly(tasks: unknown[]): boolean {
  return tasks.every(
    (task) => isMapping(task) && (task.status === "complete" || task.status === "completed"),
  );
}

function rewritePlanStatus(text: string, status: "open" | "complete"): string {
  const document = YAML.parseDocument(text);
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }
  document.setIn(["header", "status"], status);
  return document.toString();
}

function lifecycleMigrationItem(project: string, artifactPath: string): MigrationPhaseItem {
  const source = relativeToProject(project, artifactPath);
  try {
    const text = fs.readFileSync(artifactPath, "utf8");
    const data = loadYamlMapping(text);
    const header = isMapping(data.header) ? data.header : null;
    const tasks = planTaskList(data);
    if (!header || tasks === null) {
      return {
        status: "blocked",
        action: PLAN_LIFECYCLE_ACTION,
        source,
        target: source,
        message: "plan requires a header mapping and a tasks or entries array before lifecycle migration",
      };
    }
    const status = typeof header.status === "string" ? header.status : "";
    if (status === "open" || status === "complete") {
      return {
        status: "noop",
        action: PLAN_LIFECYCLE_ACTION,
        source,
        target: source,
        preserved: ["all plan fields"],
        message: "plan lifecycle is already canonical",
      };
    }
    if (status !== "active" && status !== "completed") {
      return {
        status: "blocked",
        action: PLAN_LIFECYCLE_ACTION,
        source,
        target: source,
        message: `plan header.status must be active, completed, open, or complete; received ${status || "missing"}`,
      };
    }

    const collisions: string[] = [];
    const targetStatus: "open" | "complete" = status === "active" || !completedTasksOnly(tasks)
      ? "open"
      : "complete";
    if (status === "completed" && targetStatus === "open") {
      collisions.push("header.status=completed conflicts with unfinished task evidence; preserving task evidence and migrating status to open");
    }
    return {
      status: "pending",
      action: PLAN_LIFECYCLE_ACTION,
      source,
      target: source,
      preserved: ["all plan fields except header.status"],
      ...(collisions.length > 0 ? { collisions } : {}),
      newText: rewritePlanStatus(text, targetStatus),
      message: `will migrate plan lifecycle ${status} to ${targetStatus}`,
    };
  } catch (error) {
    return {
      status: "blocked",
      action: PLAN_LIFECYCLE_ACTION,
      source,
      target: source,
      message: `cannot migrate plan lifecycle: ${(error as Error).message}`,
    };
  }
}

function lifecyclePlanArtifacts(project: string): MigrationPhaseItem[] {
  const root = resolvePath(project);
  let activePath: string;
  try {
    const record = loadArtifactRecord("plan");
    if (!record) throw new Error("plan artifact is not registered");
    activePath = resolveArtifactPath(record, root, { strictWrite: true });
  } catch (error) {
    return [{
      status: "blocked",
      action: PLAN_LIFECYCLE_ACTION,
      message: `cannot resolve docs-mapped plan path: ${(error as Error).message}`,
    }];
  }

  const artifacts = isFile(activePath) ? [activePath] : [];
  const archiveDirectory = path.join(path.dirname(activePath), "archive");
  try {
    for (const name of fs.readdirSync(archiveDirectory).sort()) {
      if (!PLAN_ARCHIVE_FILE.test(name)) continue;
      const archivePath = path.join(archiveDirectory, name);
      if (isFile(archivePath)) artifacts.push(archivePath);
    }
  } catch {
    // A missing archive directory is normal before the first archive.
  }
  return artifacts.map((artifactPath) => lifecycleMigrationItem(root, artifactPath));
}

export function hasPendingPlanLifecycleMigration(project: string): boolean {
  return lifecyclePlanArtifacts(project).some((item) => item.status === "pending");
}

export interface MigrationContext {
  appHome: string;
  project: string;
  home: string;
  force?: boolean;
  sourceRoot?: string;
  channel?: string | null;
  env?: Record<string, string | undefined>;
  installAppContentIfMissing?: boolean;
}

export interface DryRunMigrationResult {
  artifacts: MigrationPhase;
  runtime: MigrationPhase;
  cleanup: MigrationPhase;
}

function emptySummary(): MigrationPhaseSummary {
  return { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0 };
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
  const v1Items = v1Pairs.map((source) => ({
    status: "blocked" as const,
    action: "manual-v1-handoff",
    source,
    message: "v1 Markdown state is unsupported; convert it with a v2 CLI before running the v2-to-v3 upgrade",
  }));

  const yamlArtifacts = listV2YamlArtifacts(root);
  const lifecycleItems = lifecyclePlanArtifacts(root);
  if (yamlArtifacts.length === 0 && v1Items.length === 0 && lifecycleItems.length === 0) {
    return summarizePhase("artifacts", [], "no project artifacts found");
  }

  const lifecycleSources = new Set(
    lifecycleItems.flatMap((item) => item.source ? [item.source] : []),
  );
  const items: MigrationPhaseItem[] = [
    ...v1Items,
    ...yamlArtifacts.filter((source) => !lifecycleSources.has(source)).map((source) => ({
      status: "noop" as const,
      action: "preserve",
      source,
      message: "v2 YAML artifact preserved; no v2→v3 schema migration required",
    })),
    ...lifecycleItems,
  ];
  return summarizePhase("artifacts", items);
}

export function applyArtifactsPhase(phase: MigrationPhase, project: string, _force = false): void {
  const root = resolvePath(project);
  for (const item of phase.items) {
    if (item.status !== "pending" || item.action !== PLAN_LIFECYCLE_ACTION || !item.source) continue;
    const sourcePath = path.join(root, item.source);
    const current = lifecycleMigrationItem(root, sourcePath);
    if (current.status !== "pending") {
      item.status = current.status;
      item.message = current.message;
      item.collisions = current.collisions;
      continue;
    }
    if (current.newText !== item.newText) {
      item.status = "blocked";
      item.message = "plan changed after migration preview; rerun dry-run before applying";
      continue;
    }
    try {
      writeFileAtomic(sourcePath, current.newText!, "utf8");
      item.status = "applied";
      item.message = "migrated plan lifecycle without changing retained evidence";
    } catch (error) {
      item.status = "failed";
      item.message = `plan lifecycle migration failed: ${(error as Error).message}`;
    }
  }
  const updated = summarizePhase("artifacts", phase.items, phase.message);
  phase.status = updated.status;
  phase.summary = updated.summary;
}

export function delegatePlanLifecycleToEntityCutover(phase: MigrationPhase): void {
  for (const item of phase.items) {
    if (item.status !== "pending" || item.action !== PLAN_LIFECYCLE_ACTION) continue;
    item.status = "noop";
    item.message = "entity cutover normalizes plan lifecycle while retaining the legacy source as recovery evidence";
  }
  const updated = summarizePhase("artifacts", phase.items, phase.message);
  phase.status = updated.status;
  phase.summary = updated.summary;
}

export function planRuntimeRewirePhase(ctx: MigrationContext): MigrationPhase {
  const items = planRuntimeMigrationItems(ctx);
  const blockedPaths = new Set(items
    .filter((item) => item.status === "blocked")
    .flatMap((item) => [item.source, item.target])
    .filter((value): value is string => typeof value === "string"));
  for (const item of items) {
    if (item.status !== "pending" || ![item.source, item.target].some((value) => value && blockedPaths.has(value))) continue;
    item.status = "blocked";
    item.message = "action required before Agentera can modify this runtime resource";
  }
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

/** Whether `app/` under app-home still carries a managed bundle worth removing during v2→v3 cleanup. */
export function hasManagedBundleEvidence(managedAppRoot: string): boolean {
  // v3 npm-managed installs write BUNDLE_MARKER at pack/refresh time.
  if (isFile(path.join(managedAppRoot, BUNDLE_MARKER))) {
    return true;
  }
  // Legacy v2 Python-managed installs lacked the marker but always shipped this pair.
  return (
    isFile(path.join(managedAppRoot, "scripts", "agentera")) &&
    isFile(path.join(managedAppRoot, "skills", "agentera", "SKILL.md"))
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

export function planCleanupPhase(ctx: MigrationContext): MigrationPhase {
  const appHome = resolvePath(ctx.appHome);
  const roots = doctorRoots(appHome);
  const managedAppRoot = roots.managedAppRoot;
  const preflight = resolveMigrationUserStatePreflight(appHome, {
    home: ctx.home,
    env: ctx.env,
  });
  const preserved = preflight.preservedAbsolutePaths;
  const unknown = appHomeHasUnrecognizedEntriesWithPreflight(appHome, preflight);
  const items: MigrationPhaseItem[] = [
    ...preflight.handoffCatalog.map((entry) => ({
      status: "noop" as const,
      action: "catalog-handoff",
      source: entry.root,
      preserved: entry.entries,
      message: handoffCatalogMessage(entry),
    })),
    ...planAppContentRefreshItems(ctx),
    ...planLegacyAgentCleanupItems(ctx),
    ...planLegacyCapabilityAgentCleanupItems(ctx),
  ];

  if (unknown.length > 0 && !ctx.force) {
    items.push({
      status: "blocked" as const,
      action: "remove-managed-app-home",
      source: appHome,
      preserved,
      message: `app home has unrecognized entries (not preserved user state or managed app content): ${unknown.join(", ")}; cleanup blocked without --force`,
    });
    return summarizePhase("cleanup", items);
  }

  if (!hasManagedBundleEvidence(managedAppRoot)) {
    if (items.length === 0) {
      return summarizePhase("cleanup", [], "no managed Python app-home bundle to remove");
    }
    return summarizePhase("cleanup", items);
  }

  const removedPreview = listManagedBundlePreview(managedAppRoot);
  items.push({
    status: "pending",
    action: "remove-managed-app-home",
    source: managedAppRoot,
    target: appHome,
    preserved,
    removedPreview,
    message:
      "will remove managed Python app-home bundle under app/ while preserving user state at app-home root",
  });
  return summarizePhase("cleanup", items);
}

function removeDirectoryRecursive(dir: string): void {
  if (!pathExists(dir)) {
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

export function applyCleanupPhase(phase: MigrationPhase, ctx?: MigrationContext): void {
  if (ctx) {
    applyAppContentRefreshItems(phase.items, ctx);
  }
  applyLegacyAgentCleanupItems(phase.items);
  for (const item of phase.items) {
    if (item.status !== "pending" || item.action !== "remove-managed-app-home" || !item.source) {
      continue;
    }
    try {
      if (process.env.NODE_ENV === "test" && process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE === "1") {
        throw new Error("simulated post-marker cleanup failure");
      }
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
    applyArtifactsPhase(result.artifacts, ctx.project, ctx.force);
  }
  if (only.includes("runtime")) {
    applyRuntimeRewirePhase(result.runtime, ctx);
  }
  if (only.includes("cleanup")) {
    applyCleanupPhase(result.cleanup, ctx);
  }
  return result;
}
