import fs from "node:fs";
import path from "node:path";

import { CAPABILITY_INSTRUCTIONS } from "../capabilities/index.js";
import { isFile, pathExists, resolvePath } from "../core/paths.js";
import type { LifecyclePublicationBoundaryHook } from "../runtime/lifecyclePublication.js";
import { doctorRoots } from "./appModel.js";
import { hasBundleRootEvidence } from "./bundleEvidence.js";
import {
  INSTALLED_HOOKS_SURFACE_LABEL,
  applyInstalledHooksRetirementItems,
  detectStaleInstalledHooksSurface,
  planInstalledHooksRetirementItems,
} from "./installedHooksRetirement.js";
import type { MigrationContext, MigrationPhaseItem, MigrationStatus } from "./migrateArtifactsV2ToV3.js";
import { bindMigrationResource, withBoundMigrationDirectory } from "./migrationPublication.js";

export const APP_CONTENT_REFRESH_ACTION = "refresh-app-content";

/**
 * Top-level app-home entry names written and refreshed by {@link applyAppContentRefresh}.
 * The cleanup gate treats these as refreshable managed app content (not user state,
 * not genuinely unrecognized) so v3's own content surface is never flagged as a
 * false-positive "unrecognized entries" block. Sourced here as the single authority;
 * do not mirror this list in the gate or doctor.
 */
export const MANAGED_APP_CONTENT_ROOT_ENTRIES = new Set([
  "skills",
  "references",
  "registry.json",
  "dist",
]);

/** Stale-surface labels surfaced in upgrade dry-run (B6 / defect #11). */
export const APP_CONTENT_SURFACE_LABELS = [
  "SKILL.md",
  "protocol.yaml",
  "capability_schema_contract.yaml",
  "capabilities/*/schemas/*",
  "references/",
  "registry.json",
  "dist/capabilities",
  INSTALLED_HOOKS_SURFACE_LABEL,
] as const;

const V2_CAPABILITY_VERBS = [
  "hej",
  "visionera",
  "resonera",
  "inspirera",
  "planera",
  "realisera",
  "optimera",
  "inspektera",
  "dokumentera",
  "profilera",
  "visualisera",
  "orkestrera",
] as const;

const SKIP_COPY_PARTS = new Set(["__pycache__", ".pytest_cache", "node_modules"]);
const SKIP_COPY_SUFFIXES = [".pyc", ".pyo"] as const;

export interface AppContentSources {
  skillsDir: string;
  referencesDir: string;
  registryJson: string;
  distCapabilities: string | null;
}

function shouldSkipCopyEntry(name: string): boolean {
  if (SKIP_COPY_PARTS.has(name)) {
    return true;
  }
  return SKIP_COPY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function shouldSkipCapabilityFile(relFromSkills: string): boolean {
  return /capabilities\/[^/]+\/instructions\.md$/i.test(relFromSkills.replace(/\\/g, "/"));
}

export function resolveAppContentSources(sourceRoot: string): AppContentSources {
  const root = resolvePath(sourceRoot);
  const distCandidates = [
    path.join(root, "packages", "cli", "dist", "capabilities"),
    path.join(root, "dist", "capabilities"),
  ];
  let distCapabilities: string | null = null;
  for (const candidate of distCandidates) {
    if (pathExists(candidate) && fs.statSync(candidate).isDirectory()) {
      distCapabilities = candidate;
      break;
    }
  }
  return {
    skillsDir: path.join(root, "skills"),
    referencesDir: path.join(root, "references"),
    registryJson: path.join(root, "registry.json"),
    distCapabilities,
  };
}

function readInstalledText(installedRoot: string, rel: string): string | null {
  const filePath = path.join(installedRoot, rel);
  if (!isFile(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, "utf8");
}

function filesEqual(left: string, right: string): boolean {
  if (!isFile(left) || !isFile(right)) {
    return false;
  }
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

export function skillMdLooksV2(text: string): boolean {
  if (text.includes("packages/cli/src/capabilities") || text.includes("instructions.ts")) {
    return false;
  }
  return V2_CAPABILITY_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(text));
}

export function contractLooksV2(text: string): boolean {
  return /\binstructions\.md\b/.test(text) && !/\binstructions\.ts\b/.test(text);
}

function installedRootForDetection(appHome: string): string | null {
  const roots = doctorRoots(appHome);
  if (hasBundleRootEvidence(roots.activeBundleRoot)) {
    return roots.activeBundleRoot;
  }
  if (isFile(path.join(roots.activeBundleRoot, "skills", "agentera", "SKILL.md"))) {
    return roots.activeBundleRoot;
  }
  if (isFile(path.join(appHome, "skills", "agentera", "SKILL.md"))) {
    return appHome;
  }
  return null;
}

function walkYamlFiles(dir: string): string[] {
  if (!pathExists(dir)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function capabilitySchemasStale(installedRoot: string, sources: AppContentSources): boolean {
  const sourceSchemasRoot = path.join(sources.skillsDir, "agentera", "capabilities");
  const installedSchemasRoot = path.join(installedRoot, "skills", "agentera", "capabilities");
  if (!pathExists(sourceSchemasRoot)) {
    return false;
  }
  for (const sourceFile of walkYamlFiles(sourceSchemasRoot)) {
    const rel = path.relative(sourceSchemasRoot, sourceFile);
    const installedFile = path.join(installedSchemasRoot, rel);
    if (!filesEqual(sourceFile, installedFile)) {
      return true;
    }
  }
  return false;
}

function referencesStale(installedRoot: string, sources: AppContentSources): boolean {
  if (!pathExists(sources.referencesDir)) {
    return false;
  }
  const installedReferences = path.join(installedRoot, "references");
  if (!pathExists(installedReferences)) {
    return true;
  }
  const walk = (sourceDir: string, installedDir: string): boolean => {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (shouldSkipCopyEntry(entry.name)) {
        continue;
      }
      const sourcePath = path.join(sourceDir, entry.name);
      const installedPath = path.join(installedDir, entry.name);
      if (entry.isDirectory()) {
        if (!pathExists(installedPath) || !fs.statSync(installedPath).isDirectory()) {
          return true;
        }
        if (walk(sourcePath, installedPath)) {
          return true;
        }
        continue;
      }
      if (!filesEqual(sourcePath, installedPath)) {
        return true;
      }
    }
    return false;
  };
  return walk(sources.referencesDir, installedReferences);
}

function distCapabilitiesStale(installedRoot: string, sources: AppContentSources): boolean {
  if (!sources.distCapabilities) {
    return false;
  }
  const installedDist = path.join(installedRoot, "dist", "capabilities");
  for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) {
    const sourceModule = path.join(sources.distCapabilities, capability, "instructions.js");
    const installedModule = path.join(installedDist, capability, "instructions.js");
    if (!filesEqual(sourceModule, installedModule)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns stale v2 app-content surface labels for gap detection during upgrade dry-run.
 */
export function detectStaleAppContentSurfaces(appHome: string, sourceRoot: string): string[] {
  const installedRoot = installedRootForDetection(appHome);
  if (!installedRoot) {
    return [];
  }
  const sources = resolveAppContentSources(sourceRoot);
  const stale: string[] = [];

  const skillRel = path.join("skills", "agentera", "SKILL.md");
  const skillSource = path.join(sources.skillsDir, "agentera", "SKILL.md");
  const skillInstalled = path.join(installedRoot, skillRel);
  const skillText = readInstalledText(installedRoot, skillRel);
  if (!filesEqual(skillSource, skillInstalled) || (skillText !== null && skillMdLooksV2(skillText))) {
    stale.push("SKILL.md");
  }

  const protocolRel = path.join("skills", "agentera", "protocol.yaml");
  if (!filesEqual(path.join(sources.skillsDir, "agentera", "protocol.yaml"), path.join(installedRoot, protocolRel))) {
    stale.push("protocol.yaml");
  }

  const contractRel = path.join("skills", "agentera", "capability_schema_contract.yaml");
  const contractText = readInstalledText(installedRoot, contractRel);
  if (
    !filesEqual(
      path.join(sources.skillsDir, "agentera", "capability_schema_contract.yaml"),
      path.join(installedRoot, contractRel),
    ) ||
    (contractText !== null && contractLooksV2(contractText))
  ) {
    stale.push("capability_schema_contract.yaml");
  }

  if (capabilitySchemasStale(installedRoot, sources)) {
    stale.push("capabilities/*/schemas/*");
  }

  if (referencesStale(installedRoot, sources)) {
    stale.push("references/");
  }

  if (!filesEqual(sources.registryJson, path.join(installedRoot, "registry.json"))) {
    stale.push("registry.json");
  }

  if (distCapabilitiesStale(installedRoot, sources)) {
    stale.push("dist/capabilities");
  }

  if (detectStaleInstalledHooksSurface(appHome)) {
    stale.push(INSTALLED_HOOKS_SURFACE_LABEL);
  }

  return stale;
}

function copyFileEnsuringDir(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyTree(sourceDir: string, targetDir: string, relPrefix = ""): void {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (shouldSkipCopyEntry(entry.name)) {
      continue;
    }
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (shouldSkipCapabilityFile(rel)) {
      continue;
    }
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, rel);
    } else if (entry.isFile()) {
      copyFileEnsuringDir(from, to);
    }
  }
}

export function refreshAppContentTargetRoot(appHome: string): string {
  return resolvePath(appHome);
}

function applyAppContentRefreshToTarget(targetRoot: string, sourceRoot: string): void {
  const sources = resolveAppContentSources(sourceRoot);
  if (!pathExists(sources.skillsDir)) {
    throw new Error(`app content refresh: missing source skills directory at ${sources.skillsDir}`);
  }
  if (!pathExists(sources.referencesDir)) {
    throw new Error(`app content refresh: missing source references directory at ${sources.referencesDir}`);
  }
  if (!isFile(sources.registryJson)) {
    throw new Error(`app content refresh: missing source registry.json at ${sources.registryJson}`);
  }

  copyTree(sources.skillsDir, path.join(targetRoot, "skills"), "skills");
  copyTree(sources.referencesDir, path.join(targetRoot, "references"), "references");
  copyFileEnsuringDir(sources.registryJson, path.join(targetRoot, "registry.json"));

  if (sources.distCapabilities) {
    copyTree(sources.distCapabilities, path.join(targetRoot, "dist", "capabilities"), "dist/capabilities");
  }

}

export function applyAppContentRefresh(appHome: string, sourceRoot: string): void {
  applyAppContentRefreshToTarget(refreshAppContentTargetRoot(appHome), sourceRoot);
}

function refreshItemStatus(staleSurfaces: string[]): MigrationStatus {
  return staleSurfaces.length > 0 ? "pending" : "noop";
}

export function planAppContentRefreshItems(ctx: MigrationContext): MigrationPhaseItem[] {
  const sourceRoot = ctx.sourceRoot;
  if (!sourceRoot) {
    return [];
  }
  const appHome = resolvePath(ctx.appHome);
  const resolvedSourceRoot = resolvePath(sourceRoot);
  const installedRoot = installedRootForDetection(appHome);
  if (!installedRoot) {
    if (!pathExists(appHome)) {
      return ctx.installAppContentIfMissing ? [{
        status: "pending",
        action: APP_CONTENT_REFRESH_ACTION,
        runtime: "installed-app",
        source: resolvedSourceRoot,
        target: refreshAppContentTargetRoot(appHome),
        message: "will install stable app content required by selected lifecycle repair",
      }] : [];
    }
    const target = refreshAppContentTargetRoot(appHome);
    const item: MigrationPhaseItem = {
      status: "pending",
      action: APP_CONTENT_REFRESH_ACTION,
      runtime: "installed-app",
      source: resolvedSourceRoot,
      target,
      message:
        "install root has user data only; will install v3 app content (skills, references, registry, dist/capabilities)",
    };
    const evidenceError = bindMigrationResource(item, "target", target, [path.dirname(target)], "directory");
    if (evidenceError) {
      item.status = "blocked";
      item.message = `app content refresh preserved the target: ${evidenceError}; review the unsafe path manually`;
    }
    return [item];
  }

  const staleSurfaces = detectStaleAppContentSurfaces(appHome, resolvedSourceRoot);
  const hookItems = planInstalledHooksRetirementItems(ctx);
  if (staleSurfaces.length === 0 && hookItems.every((item) => item.status === "noop")) {
    return [
      {
        status: "noop",
        action: APP_CONTENT_REFRESH_ACTION,
        source: installedRoot,
        target: refreshAppContentTargetRoot(appHome),
        message: "installed app content already matches v3 source surfaces",
      },
    ];
  }

  const targetRoot = refreshAppContentTargetRoot(appHome);
  const refreshItems = staleSurfaces.map((surface) => {
    const item: MigrationPhaseItem = {
      status: refreshItemStatus([surface]),
      action: APP_CONTENT_REFRESH_ACTION,
      runtime: "installed-app",
      source: resolvedSourceRoot,
      target: targetRoot,
      message: `will refresh stale v2 surface ${surface} from sourceRoot into managed app home`,
      preserved: [...APP_CONTENT_SURFACE_LABELS],
      removedPreview: staleSurfaces,
    };
    const evidenceError = bindMigrationResource(item, "target", targetRoot, [path.dirname(targetRoot)], "directory");
    if (evidenceError) {
      item.status = "blocked";
      item.message = `app content refresh preserved the target: ${evidenceError}; review the unsafe path manually`;
    }
    return item;
  });
  return [...refreshItems, ...hookItems.filter((item) => item.status !== "noop")];
}

export function applyAppContentRefreshItem(
  item: MigrationPhaseItem,
  ctx: MigrationContext,
  beforePublication?: LifecyclePublicationBoundaryHook,
): void {
  if (item.status !== "pending" || item.action !== APP_CONTENT_REFRESH_ACTION) {
    return;
  }
  try {
    const sourceRoot = resolvePath(ctx.sourceRoot ?? item.source ?? "");
    withBoundMigrationDirectory(
      item,
      "target",
      (targetRoot) => applyAppContentRefreshToTarget(targetRoot, sourceRoot),
      beforePublication,
    );
    item.status = "applied";
    item.message = "refreshed installed app content from v3 sourceRoot";
  } catch (exc) {
    item.status = "blocked";
    item.message = `refresh-app-content preserved the target: ${(exc as Error).message}; rerun and review it manually`;
  }
}

export function applyAppContentRefreshItems(items: MigrationPhaseItem[], ctx: MigrationContext): void {
  applyInstalledHooksRetirementItems(items, ctx);
  const pending = items.filter((item) => item.action === APP_CONTENT_REFRESH_ACTION && item.status === "pending");
  if (pending.length === 0) {
    return;
  }
  applyAppContentRefreshItem(pending[0]!, ctx);
  if (pending[0]?.status === "applied") {
    for (const item of pending.slice(1)) {
      if (item.action === APP_CONTENT_REFRESH_ACTION) {
        item.status = "applied";
        item.message = "refreshed installed app content from v3 sourceRoot";
      }
    }
  }
}
