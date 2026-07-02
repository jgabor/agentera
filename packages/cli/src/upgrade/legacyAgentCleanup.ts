import fs from "node:fs";
import path from "node:path";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { opencodeConfigDir } from "../setup/opencode.js";
import type { MigrationContext, MigrationPhaseItem } from "./migrateArtifactsV2ToV3.js";

export const REMOVE_LEGACY_AGENT_ACTION = "remove-legacy-agent";

/** Literal marker v2 wrote into managed per-capability agent files. */
const MANAGED_AGENT_MARKER = "<!-- agentera: managed -->";

/** Closed set of v2 Swedish-verb agent files left orphaned after v3 single-agent copy (#20). */
export const V2_SWEDISH_VERB_AGENT_FILES = [
  "dokumentera.md",
  "hej.md",
  "inspektera.md",
  "inspirera.md",
  "optimera.md",
  "orkestrera.md",
  "planera.md",
  "profilera.md",
  "realisera.md",
  "resonera.md",
  "visionera.md",
  "visualisera.md",
] as const;

const V2_SWEDISH_VERB_AGENT_SET = new Set<string>(V2_SWEDISH_VERB_AGENT_FILES);

export function isV2SwedishVerbAgentFile(name: string): boolean {
  return V2_SWEDISH_VERB_AGENT_SET.has(name);
}

/**
 * Closed set of v2 English-named per-capability agent files replaced by the
 * single v3 `agentera.md` primary agent. These shipped under `.cursor/agents`
 * and `.opencode/agents` and must be removed when the managed marker is present.
 */
export const V2_ENGLISH_CAPABILITY_AGENT_FILES = [
  "audit.md",
  "build.md",
  "design.md",
  "discuss.md",
  "document.md",
  "optimize.md",
  "orchestrate.md",
  "plan.md",
  "profile.md",
  "research.md",
  "status.md",
  "vision.md",
] as const;

const V2_ENGLISH_CAPABILITY_AGENT_SET = new Set<string>(V2_ENGLISH_CAPABILITY_AGENT_FILES);

export function isV2EnglishCapabilityAgentFile(name: string): boolean {
  return V2_ENGLISH_CAPABILITY_AGENT_SET.has(name);
}

export interface LegacyAgentScanTarget {
  runtime: "cursor" | "opencode";
  agentsDir: string;
}

export function legacyAgentScanTargets(ctx: MigrationContext): LegacyAgentScanTarget[] {
  const project = resolvePath(ctx.project);
  const home = resolvePath(ctx.home);
  const appHome = resolvePath(ctx.appHome);
  const env = ctx.env ?? process.env;
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
  if (appHome !== project && appHome !== home) {
    push("cursor", path.join(appHome, ".cursor", "agents"));
  }
  push("opencode", path.join(opencodeConfigDir(home, env), "agents"));
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

/** Scan a tree for reintroduced Swedish-verb agents (v1LegacyCruft-style guard). */
export function scanLegacySwedishVerbAgentViolations(root: string): string[] {
  const resolved = resolvePath(root);
  const violations: string[] = [];
  const agentDirs = [
    path.join(resolved, ".cursor", "agents"),
    path.join(resolved, ".opencode", "agents"),
  ];
  for (const agentsDir of agentDirs) {
    for (const filePath of scanLegacySwedishVerbAgentPaths(agentsDir)) {
      violations.push(path.relative(resolved, filePath));
    }
  }
  return violations.sort();
}

export function planLegacyAgentCleanupItems(ctx: MigrationContext): MigrationPhaseItem[] {
  const items: MigrationPhaseItem[] = [];
  for (const { runtime, agentsDir } of legacyAgentScanTargets(ctx)) {
    for (const source of scanLegacySwedishVerbAgentPaths(agentsDir)) {
      items.push({
        status: "pending",
        action: REMOVE_LEGACY_AGENT_ACTION,
        runtime,
        source,
        message: `will remove orphaned v2 Swedish-verb agent ${path.basename(source)}`,
      });
    }
  }
  return items;
}

export function planLegacyCapabilityAgentCleanupItems(ctx: MigrationContext): MigrationPhaseItem[] {
  const items: MigrationPhaseItem[] = [];
  for (const { runtime, agentsDir } of legacyAgentScanTargets(ctx)) {
    for (const source of scanLegacyCapabilityAgentPaths(agentsDir)) {
      items.push({
        status: "pending",
        action: REMOVE_LEGACY_AGENT_ACTION,
        runtime,
        source,
        message: `will remove orphaned v2 per-capability agent ${path.basename(source)}`,
      });
    }
  }
  return items;
}

export function applyLegacyAgentCleanupItems(items: MigrationPhaseItem[]): void {
  for (const item of items) {
    if (item.status !== "pending" || item.action !== REMOVE_LEGACY_AGENT_ACTION || !item.source) {
      continue;
    }
    const basename = path.basename(item.source);
    try {
      if (
        (!isV2SwedishVerbAgentFile(basename) && !isV2EnglishCapabilityAgentFile(basename)) ||
        !isFile(item.source)
      ) {
        item.status = "noop";
        item.message = `legacy agent already absent at ${item.source}`;
        continue;
      }
      fs.rmSync(item.source, { force: true });
      item.status = "applied";
      item.message = `removed orphaned v2 legacy agent ${basename}`;
    } catch (exc) {
      item.status = "failed";
      item.message = `${REMOVE_LEGACY_AGENT_ACTION} failed: ${(exc as Error).message}`;
    }
  }
}
