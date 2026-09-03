import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { opencodeConfigDir } from "../setup/opencode.js";
import { loadNativeResourceCleanupContract } from "../runtime/nativeResourceCleanup.js";
import type { MigrationContext, MigrationPhaseItem } from "./migrateArtifactsV2ToV3.js";
import { bindMigrationResource, removeBoundMigrationResource } from "./migrationPublication.js";
import { diagnoseRetiredResources, expandRetiredResourcePath, resolveRetiredResourceRoots } from "./retiredResourceDiagnostics.js";

export const REMOVE_LEGACY_AGENT_ACTION = "remove-legacy-agent";
export const PRUNE_LEGACY_DIRECTORY_ACTION = "prune-legacy-directory";

/** Literal marker v2 wrote into managed per-capability agent files. */
const MANAGED_AGENT_MARKER = "<!-- agentera: managed -->";

/** Closed set of v2 Swedish-verb agent files left orphaned after v3 single-agent copy (#20). */
export const V2_SWEDISH_VERB_AGENT_FILES = ["dokumentera.md", "hej.md", "inspektera.md", "inspirera.md", "optimera.md", "orkestrera.md", "planera.md", "profilera.md", "realisera.md", "resonera.md", "visionera.md", "visualisera.md"] as const;

const V2_SWEDISH_VERB_AGENT_SET = new Set<string>(V2_SWEDISH_VERB_AGENT_FILES);

export function isV2SwedishVerbAgentFile(name: string): boolean {
  return V2_SWEDISH_VERB_AGENT_SET.has(name);
}

/**
 * Closed set of v2 English-named per-capability agent files replaced by the
 * single v3 `agentera.md` primary agent. These shipped under `.cursor/agents`
 * and `.opencode/agents` and must be removed when the managed marker is present.
 */
export const V2_ENGLISH_CAPABILITY_AGENT_FILES = ["audit.md", "build.md", "design.md", "discuss.md", "document.md", "optimize.md", "orchestrate.md", "plan.md", "profile.md", "research.md", "status.md", "vision.md"] as const;

/** Primary runtime-native agent replaced by the shared skill plus CLI. */
export const V2_PRIMARY_AGENT_FILES = ["agentera.md"] as const;

const V2_ENGLISH_CAPABILITY_AGENT_SET = new Set<string>(V2_ENGLISH_CAPABILITY_AGENT_FILES);

export function isV2EnglishCapabilityAgentFile(name: string): boolean {
  return V2_ENGLISH_CAPABILITY_AGENT_SET.has(name);
}

export interface LegacyAgentScanTarget {
  runtime: "cursor" | "opencode";
  agentsDir: string;
}

function regularFileIdentity(filePath: string): string | null {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

function managedAgentOwnership(filePath: string): MigrationPhaseItem["ownership"] | null {
  const identity = regularFileIdentity(filePath);
  if (!identity) return null;
  let body: string;
  try {
    body = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(body);
  if (
    body
      .slice(frontmatter?.[0].length ?? 0)
      .split(/\r?\n/)
      .find((line) => line.trim() !== "") !== MANAGED_AGENT_MARKER
  )
    return null;
  return {
    kind: "managed-marker-file",
    identity,
    fingerprint: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
}

function planDeclaredAgentItems(ctx: MigrationContext, select: (resourceId: string) => boolean): MigrationPhaseItem[] {
  const diagnosis = diagnoseRetiredResources({
    home: ctx.home,
    project: ctx.project,
    installRoot: ctx.appHome,
    env: ctx.env,
    sourceRoot: ctx.sourceRoot,
  });
  return diagnosis.resources
    .filter((resource) => resource.ownershipMode === "managed_marker_regular_file" && select(resource.id))
    .flatMap((resource) =>
      resource.evidence.paths.map((source) => {
        const ownership = managedAgentOwnership(source);
        let regularFile = false;
        try {
          regularFile = fs.lstatSync(source).isFile();
        } catch {
          /* diagnosis already recorded the path */
        }
        const item: MigrationPhaseItem = {
          resourceId: resource.id,
          status: ownership ? "pending" : "blocked",
          action: REMOVE_LEGACY_AGENT_ACTION,
          runtime: resource.id.startsWith("cursor.") ? "cursor" : "opencode",
          source,
          ...(ownership ? { ownership } : {}),
          message: ownership ? `will remove marker-owned v2 agent ${path.basename(source)}` : regularFile ? `preserved ${source}: the legacy filename does not prove Agentera ownership; the managed marker is required` : `preserved ${source}: unsafe resource; only an exact declared regular file is eligible`,
        };
        if (ownership) {
          const evidenceError = bindMigrationResource(item, "source", source, [path.dirname(source)], "file");
          if (evidenceError) {
            item.status = "blocked";
            item.message = `preserved ${source}: ${evidenceError}; review the unsafe path manually`;
          }
        }
        return item;
      }),
    );
}

export function legacyAgentScanTargets(ctx: MigrationContext): LegacyAgentScanTarget[] {
  const project = resolvePath(ctx.project);
  const home = resolvePath(ctx.home);
  const env = ctx.env ?? { HOME: home };
  const targets: LegacyAgentScanTarget[] = [];
  const seen = new Set<string>();

  const push = (runtime: "cursor" | "opencode", agentsDir: string): void => {
    const normalized = path.resolve(agentsDir);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    targets.push({ runtime, agentsDir: normalized });
  };

  push("cursor", path.join(project, ".cursor", "agents"));
  push("cursor", path.join(home, ".cursor", "agents"));
  const configuredOpenCode = opencodeConfigDir(home, env);
  push("opencode", path.join(configuredOpenCode, "agents"));
  push("opencode", path.join(home, ".config", "opencode", "agents"));
  return targets;
}

export function scanLegacySwedishVerbAgentPaths(agentsDir: string): string[] {
  if (!pathExists(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return [];
  }
  const hits: string[] = [];
  for (const name of fs.readdirSync(agentsDir)) {
    if (!isV2SwedishVerbAgentFile(name)) {
      continue;
    }
    const filePath = path.join(agentsDir, name);
    if (isFile(filePath)) {
      hits.push(filePath);
    }
  }
  return hits.sort();
}

/**
 * Scan an agents directory for v2 English-named per-capability agents that v3
 * superseded with the single `agentera.md` primary agent. Only files carrying
 * the managed marker are returned, so user-owned agents without the marker are
 * preserved.
 */
export function scanLegacyCapabilityAgentPaths(agentsDir: string): string[] {
  if (!pathExists(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return [];
  }
  const hits: string[] = [];
  for (const name of fs.readdirSync(agentsDir)) {
    if (!isV2EnglishCapabilityAgentFile(name)) {
      continue;
    }
    const filePath = path.join(agentsDir, name);
    if (!isFile(filePath)) {
      continue;
    }
    const body = fs.readFileSync(filePath, "utf8");
    if (body.includes(MANAGED_AGENT_MARKER)) {
      hits.push(filePath);
    }
  }
  return hits.sort();
}

/** Scan a tree for reintroduced Swedish-verb agents. */
export function scanLegacySwedishVerbAgentViolations(root: string): string[] {
  const resolved = resolvePath(root);
  const violations: string[] = [];
  const agentDirs = [path.join(resolved, ".cursor", "agents"), path.join(resolved, ".opencode", "agents")];
  for (const agentsDir of agentDirs) {
    for (const filePath of scanLegacySwedishVerbAgentPaths(agentsDir)) {
      violations.push(path.relative(resolved, filePath));
    }
  }
  return violations.sort();
}

export function planLegacyAgentCleanupItems(ctx: MigrationContext): MigrationPhaseItem[] {
  return planDeclaredAgentItems(ctx, (resourceId) => (resourceId.startsWith("cursor.agent.") || resourceId.startsWith("opencode.agent.")) && V2_SWEDISH_VERB_AGENT_SET.has(`${resourceId.split(".").at(-1)}.md`));
}

export function planLegacyCapabilityAgentCleanupItems(ctx: MigrationContext): MigrationPhaseItem[] {
  return planDeclaredAgentItems(ctx, (resourceId) => (resourceId.startsWith("cursor.agent.") || resourceId.startsWith("opencode.agent.")) && !V2_SWEDISH_VERB_AGENT_SET.has(`${resourceId.split(".").at(-1)}.md`));
}

function declaredLegacyDirectories(ctx: MigrationContext): Array<{ resourceId: string; directory: string }> {
  const contract = loadNativeResourceCleanupContract();
  const roots = resolveRetiredResourceRoots({
    home: ctx.home,
    project: ctx.project,
    installRoot: ctx.appHome,
    env: ctx.env,
  });
  const seen = new Set<string>();
  return contract.directoryResources
    .map((resource) => ({
      resourceId: resource.id,
      directory: expandRetiredResourcePath(resource.destination, roots),
    }))
    .filter(({ directory }) => {
      if (seen.has(directory)) return false;
      seen.add(directory);
      return true;
    })
    .sort((a, b) => b.directory.split(path.sep).length - a.directory.split(path.sep).length);
}

export function planLegacyDirectoryCleanupItems(ctx: MigrationContext, leafItems: readonly MigrationPhaseItem[] = [...planLegacyAgentCleanupItems(ctx), ...planLegacyCapabilityAgentCleanupItems(ctx)]): MigrationPhaseItem[] {
  const plannedRemovals = new Set(leafItems.filter((item) => item.status === "pending" && item.source).map((item) => path.resolve(item.source!)));
  return declaredLegacyDirectories(ctx).map(({ resourceId, directory }) => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      return {
        resourceId,
        status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "noop" : "blocked",
        action: PRUNE_LEGACY_DIRECTORY_ACTION,
        source: directory,
        message: (error as NodeJS.ErrnoException).code === "ENOENT" ? `declared legacy directory already absent at ${directory}` : `preserved ${directory}: declared legacy directory could not be inspected`,
      } as MigrationPhaseItem;
    }
    if (!stat.isDirectory()) {
      return {
        resourceId,
        status: "blocked",
        action: PRUNE_LEGACY_DIRECTORY_ACTION,
        source: directory,
        message: `preserved ${directory}: declared legacy directory is not a real directory`,
      } as MigrationPhaseItem;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      return {
        resourceId,
        status: "blocked",
        action: PRUNE_LEGACY_DIRECTORY_ACTION,
        source: directory,
        message: `preserved ${directory}: declared legacy directory could not be read`,
      } as MigrationPhaseItem;
    }
    const remaining = entries.filter((name) => !plannedRemovals.has(path.resolve(directory, name)));
    if (remaining.length > 0) {
      return {
        resourceId,
        status: "noop",
        action: PRUNE_LEGACY_DIRECTORY_ACTION,
        source: directory,
        message: `preserved non-empty declared legacy directory ${directory}`,
      } as MigrationPhaseItem;
    }
    return {
      resourceId,
      status: "pending",
      action: PRUNE_LEGACY_DIRECTORY_ACTION,
      source: directory,
      message: `will remove declared legacy directory when empty: ${directory}`,
    } as MigrationPhaseItem;
  });
}

export function applyLegacyAgentCleanupItems(items: MigrationPhaseItem[], ctx: MigrationContext): void {
  const allowed = new Set(legacyAgentScanTargets(ctx).map(({ agentsDir }) => path.resolve(agentsDir)));
  for (const item of items) {
    if (item.status !== "pending" || item.action !== REMOVE_LEGACY_AGENT_ACTION || !item.source) {
      continue;
    }
    const basename = path.basename(item.source);
    try {
      if (!allowed.has(path.dirname(path.resolve(item.source)))) {
        item.status = "blocked";
        item.message = `preserved ${item.source}: path is outside the legacy agent cleanup allowlist; review it manually`;
        continue;
      }
      const ownership = managedAgentOwnership(item.source);
      if (!ownership) {
        let absent = false;
        try {
          fs.lstatSync(item.source);
        } catch (error) {
          absent = (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        if (absent) {
          item.status = "noop";
          item.message = `legacy agent already absent at ${item.source}`;
        } else {
          item.status = "blocked";
          item.message = `preserved ${item.source}: managed marker ownership is missing or unsafe; review it manually`;
        }
        continue;
      }
      if (item.ownership?.kind !== "managed-marker-file" || item.ownership.identity !== ownership.identity || item.ownership.fingerprint !== ownership.fingerprint) {
        item.status = "blocked";
        item.message = `preserved ${item.source}: ownership identity or fingerprint changed after preview; rerun migration and review the resource`;
        continue;
      }
      if ((!isV2SwedishVerbAgentFile(basename) && !isV2EnglishCapabilityAgentFile(basename) && basename !== "agentera.md") || !regularFileIdentity(item.source)) {
        item.status = "noop";
        item.message = `legacy agent already absent at ${item.source}`;
        continue;
      }
      removeBoundMigrationResource(item, "source");
      item.status = "applied";
      item.message = `removed orphaned v2 legacy agent ${basename}`;
    } catch (exc) {
      item.status = "blocked";
      item.message = `preserved ${item.source}: ${(exc as Error).message}; rerun migration and review it manually`;
    }
  }
  const allowedDirectories = new Set(declaredLegacyDirectories(ctx).map(({ directory }) => directory));
  for (const item of items) {
    if (item.status !== "pending" || item.action !== PRUNE_LEGACY_DIRECTORY_ACTION || !item.source) continue;
    const directory = path.resolve(item.source);
    try {
      const stat = fs.lstatSync(directory);
      if (!allowedDirectories.has(directory) || !stat.isDirectory()) throw new Error("path is not an allowed real directory");
      fs.rmdirSync(directory);
      item.status = "applied";
      item.message = `removed empty declared legacy directory ${directory}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        item.status = "noop";
        item.message = `declared legacy directory already absent at ${directory}`;
      } else {
        item.status = "blocked";
        item.message = `preserved ${directory}: ${(error as Error).message}`;
      }
    }
  }
}
