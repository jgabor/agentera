import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { isFile, pathExists, resolvePath } from "../core/paths.js";
import { opencodeConfigDir } from "../setup/opencode.js";
import type { MigrationContext, MigrationPhaseItem } from "./migrateArtifactsV2ToV3.js";
import { bindMigrationResource, removeBoundMigrationResource } from "./migrationPublication.js";

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
  if (!body.includes(MANAGED_AGENT_MARKER)) return null;
  return {
    kind: "managed-marker-file",
    identity,
    fingerprint: `sha256:${createHash("sha256").update(body).digest("hex")}`,
  };
}

function planAgentFiles(
  ctx: MigrationContext,
  names: readonly string[],
  description: string,
): MigrationPhaseItem[] {
  const items: MigrationPhaseItem[] = [];
  for (const { runtime, agentsDir } of legacyAgentScanTargets(ctx)) {
    let directory: fs.Stats;
    try {
      directory = fs.lstatSync(agentsDir);
    } catch {
      continue;
    }
    if (!directory.isDirectory()) {
      items.push({
        status: "blocked",
        action: REMOVE_LEGACY_AGENT_ACTION,
        runtime,
        source: agentsDir,
        message: `preserved ${agentsDir}: the legacy agents path is not a real directory; replace the unsafe path or review it manually`,
      });
      continue;
    }
    for (const name of names) {
      const source = path.join(agentsDir, name);
      let candidate: fs.Stats;
      try {
        candidate = fs.lstatSync(source);
      } catch {
        continue;
      }
      if (!candidate.isFile()) {
        items.push({
          status: "blocked",
          action: REMOVE_LEGACY_AGENT_ACTION,
          runtime,
          source,
          message: `preserved ${source}: only a marker-owned regular file is eligible; review the unsafe resource manually`,
        });
        continue;
      }
      const ownership = managedAgentOwnership(source);
      const item: MigrationPhaseItem = {
        status: ownership ? "pending" : "blocked",
        action: REMOVE_LEGACY_AGENT_ACTION,
        runtime,
        source,
        ...(ownership ? { ownership } : {}),
        message: ownership
          ? `will remove marker-owned v2 ${description} ${name}`
          : `preserved ${source}: the legacy filename does not prove Agentera ownership; confirm ownership and remove it manually if appropriate`,
      };
      if (ownership) {
        const evidenceError = bindMigrationResource(item, "source", source, [agentsDir], "file");
        if (evidenceError) {
          item.status = "blocked";
          item.message = `preserved ${source}: ${evidenceError}; review the unsafe path manually`;
        }
      }
      items.push(item);
    }
  }
  return items;
}

export function legacyAgentScanTargets(ctx: MigrationContext): LegacyAgentScanTarget[] {
  const project = resolvePath(ctx.project);
  const home = resolvePath(ctx.home);
  const appHome = resolvePath(ctx.appHome);
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
  return planAgentFiles(ctx, V2_SWEDISH_VERB_AGENT_FILES, "Swedish-verb agent");
}

export function planLegacyCapabilityAgentCleanupItems(ctx: MigrationContext): MigrationPhaseItem[] {
  return planAgentFiles(ctx, V2_ENGLISH_CAPABILITY_AGENT_FILES, "per-capability agent");
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
      if (
        item.ownership?.kind !== "managed-marker-file"
        || item.ownership.identity !== ownership.identity
        || item.ownership.fingerprint !== ownership.fingerprint
      ) {
        item.status = "blocked";
        item.message = `preserved ${item.source}: ownership identity or fingerprint changed after preview; rerun migration and review the resource`;
        continue;
      }
      if (
        (!isV2SwedishVerbAgentFile(basename) && !isV2EnglishCapabilityAgentFile(basename)) ||
        !regularFileIdentity(item.source)
      ) {
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
}
