import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { parseYaml } from "../core/yaml.js";
import { resolveRetiredResourceDiagnosticId } from "../runtime/nativeResourceCleanup.js";
import type { MigrationContext, MigrationPhaseItem } from "./migrateArtifactsV2ToV3.js";
import { bindMigrationResource, removeBoundMigrationResource } from "./migrationPublication.js";
import { diagnoseRetiredResources, type RetiredResourceDiagnostic } from "./retiredResourceDiagnostics.js";
import { runLifecycleUpgrade } from "./lifecycleUpgrade.js";
import { applyRuntimeMigrationItem, planDeclaredCopilotHookItem, type RuntimeMigrationItem } from "./runtimeMigration.js";

export const RETIRE_DECLARED_RESOURCE_ACTION = "retire-declared-resource";
export const REVIEW_DECLARED_RESOURCE_ACTION = "review-declared-resource";

export function resolveDeclaredMarkerManagedResource(selector: string) {
  const resource = resolveRetiredResourceDiagnosticId(selector);
  return resource?.definition.ownershipMode === "managed_marker_regular_file" ? resource : null;
}

export function planDeclaredMarkerManagedFileItem(resource: RetiredResourceDiagnostic, source: string, roots: string[]): MigrationPhaseItem {
  let body: string;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
    if (!stat.isFile()) throw new Error("not regular");
    body = fs.readFileSync(source, "utf8");
  } catch {
    return {
      resourceId: resource.id,
      status: "blocked",
      action: REVIEW_DECLARED_RESOURCE_ACTION,
      source,
      message: `preserved ${source}: expected marker on a readable regular declared file was not proven`,
    };
  }
  const expectedMarker = resource.markerSyntax === "html_comment_agentera_managed" ? "<!-- agentera: managed -->" : resource.markerSyntax;
  let marked = resource.markerKind === "first_line_exact" && body.split(/\r?\n/, 1)[0] === expectedMarker;
  if (resource.markerKind === "body_first_line_exact") {
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(body);
    marked =
      body
        .slice(frontmatter?.[0].length ?? 0)
        .split(/\r?\n/)
        .find((line) => line.trim() !== "") === expectedMarker;
  }
  if (resource.markerKind === "yaml_frontmatter_boolean") {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
    try {
      const frontmatter = match ? parseYaml(match[1]) : null;
      marked = !!frontmatter && typeof frontmatter === "object" && (frontmatter as Record<string, unknown>).agentera_managed === true;
    } catch {
      marked = false;
    }
  }
  if (!marked)
    return {
      resourceId: resource.id,
      status: "blocked",
      action: REVIEW_DECLARED_RESOURCE_ACTION,
      source,
      message: `preserved ${source}: expected managed marker is absent or misplaced; remove the marker to opt out`,
    };
  const item: MigrationPhaseItem = {
    resourceId: resource.id,
    status: "pending",
    action: RETIRE_DECLARED_RESOURCE_ACTION,
    source,
    ownership: {
      kind: "managed-marker-file",
      identity: `${stat.dev}:${stat.ino}`,
      fingerprint: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    },
    message: `will remove marker-owned retired resource ${resource.id} at ${source}`,
  };
  const error = bindMigrationResource(item, "source", source, roots, "file");
  if (error)
    return {
      ...item,
      status: "blocked",
      action: REVIEW_DECLARED_RESOURCE_ACTION,
      message: `preserved ${source}: ${error}`,
    };
  return item;
}

function lifecycleItem(ctx: MigrationContext, resourceId: string, source: string, automaticRetirement: boolean): MigrationPhaseItem {
  const result = runLifecycleUpgrade({
    home: ctx.home,
    appHome: ctx.appHome,
    apply: false,
    resourceCleanup: resourceId,
    destination: source,
    automaticRetirement,
  });
  const operation = "plan" in result.nativeResourceCleanup ? result.nativeResourceCleanup.plan.operations[0] : null;
  const status = operation?.action === "remove" ? "pending" : operation?.action === "noop" ? "noop" : "blocked";
  return {
    resourceId,
    status,
    action: RETIRE_DECLARED_RESOURCE_ACTION,
    source,
    message: status === "pending" ? `will remove ownership-proven retired resource ${resourceId} at ${source}` : status === "noop" ? `retired resource ${resourceId} is already absent at ${source}` : `preserved ${source}: ${operation?.reason ?? "matching ownership evidence is unavailable"}`,
  };
}

export function planDeclaredRetiredResourceCleanupItems(ctx: MigrationContext, representedPaths: ReadonlySet<string> = new Set(), selectedResourceId: string | null = null, includeDefaultPlugin = false): MigrationPhaseItem[] {
  const defaultPlugin = path.resolve(ctx.home, ".config", "opencode", "plugins", "agentera.js");
  const diagnosis = diagnoseRetiredResources({
    home: ctx.home,
    project: ctx.project,
    installRoot: ctx.appHome,
    env: ctx.env,
    sourceRoot: ctx.sourceRoot,
    resourceId: selectedResourceId,
  });
  return diagnosis.resources.flatMap((resource) =>
    resource.evidence.paths.flatMap((source) => {
      const resolved = path.resolve(source);
      if (representedPaths.has(resolved)) return [];
      if (resource.ownershipMode === "whole_resource_retired_hook") {
        return [planDeclaredCopilotHookItem(source, ctx.project, resource.id)];
      }
      if (resource.ownershipMode === "managed_marker_regular_file") return [planDeclaredMarkerManagedFileItem(resource, source, [ctx.home, ctx.project, ctx.appHome])];
      if (resource.ownershipMode === "managed_bundle_identity") {
        return [
          {
            resourceId: resource.id,
            status: "blocked",
            action: REVIEW_DECLARED_RESOURCE_ACTION,
            source,
            message: `preserved ${source}: ${resource.ownershipEvidence} was not proven`,
          } as MigrationPhaseItem,
        ];
      }
      if (resource.ownershipMode === "manual_review") {
        return [
          {
            resourceId: resource.id,
            status: "blocked",
            action: REVIEW_DECLARED_RESOURCE_ACTION,
            source,
            message: `preserved ${source}: ${resource.ownershipEvidence}; review it manually`,
          } as MigrationPhaseItem,
        ];
      }
      if (!includeDefaultPlugin && resource.ownershipMode === "bounded_fingerprint_and_ledger" && resolved === defaultPlugin) {
        // The existing lifecycle phase owns the default plugin outcome.
        return [];
      }
      return [lifecycleItem(ctx, resource.id, source, resource.ownershipMode === "bounded_fingerprint_and_ledger")];
    }),
  );
}

export function applyDeclaredRetiredResourceCleanupItems(items: MigrationPhaseItem[], ctx: MigrationContext): void {
  for (const item of items) {
    if (item.action === "retire-hooks") {
      applyRuntimeMigrationItem(item as RuntimeMigrationItem);
      continue;
    }
    if (item.status !== "pending" || item.action !== RETIRE_DECLARED_RESOURCE_ACTION || !item.resourceId || !item.source) continue;
    if (item.ownership?.kind === "managed-marker-file") {
      try {
        if (!fs.existsSync(item.source)) {
          item.status = "noop";
          item.message = `retired resource ${item.resourceId} is already absent at ${item.source}`;
          continue;
        }
        const resource = diagnoseRetiredResources({
          home: ctx.home,
          project: ctx.project,
          installRoot: ctx.appHome,
          env: ctx.env,
          sourceRoot: ctx.sourceRoot,
          resourceId: item.resourceId,
        }).resources.find((entry) => entry.evidence.paths.includes(item.source!));
        const current = resource && planDeclaredMarkerManagedFileItem(resource, item.source, [ctx.home, ctx.project, ctx.appHome]);
        if (!current?.ownership || current.ownership.identity !== item.ownership.identity || current.ownership.fingerprint !== item.ownership.fingerprint) throw new Error("changed");
        removeBoundMigrationResource(item, "source");
        item.status = "applied";
        item.message = `removed marker-owned retired resource ${item.resourceId} at ${item.source}`;
      } catch {
        item.status = "blocked";
        item.message = `preserved ${item.source}: identity, fingerprint, or managed marker changed after preview`;
      }
      continue;
    }
    const result = runLifecycleUpgrade({
      home: ctx.home,
      appHome: ctx.appHome,
      apply: true,
      resourceCleanup: item.resourceId,
      destination: item.source,
      automaticRetirement: item.resourceId === "opencode.plugin.agentera",
    });
    if (result.cleanupSummary.applied > 0) {
      item.status = "applied";
      item.message = `removed ownership-proven retired resource ${item.resourceId} at ${item.source}`;
    } else if (result.cleanupSummary.noop > 0) {
      item.status = "noop";
      item.message = `retired resource ${item.resourceId} is already absent at ${item.source}`;
    } else {
      item.status = "blocked";
      item.message = `preserved ${item.source}: ownership changed or could not be revalidated`;
    }
  }
}
