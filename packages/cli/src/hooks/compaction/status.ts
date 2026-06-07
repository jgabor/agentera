/**
 * Compaction status reporting (read-only).
 *
 * Walks each tracked artifact path, counts active/archive entries, and
 * builds a `CompactionStatus` per artifact plus a per-status operation
 * row in `checkCompaction`/`fixCompaction`. The `fixCompaction` path
 * delegates the actual write to `apply.ts`.
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_ARTIFACT_PATHS, parseDocsYamlMapping } from "../common.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { COMPACTABLE_YAML_ARTIFACTS, NON_COMPACTABLE_ARTIFACTS } from "./dryRun.js";
import {
  decisionProtectedOverflowCount,
  overLimitCount,
  yamlArchiveEntries,
} from "./retention.js";
import { CompactResult, CompactionOperation, CompactionStatus } from "./types.js";
import { compactFile, compactYamlFile } from "./apply.js";
import { countTodoResolvedEntries, parseEntries } from "./parse.js";
import { YAML_SPEC_BY_ARTIFACT } from "./dryRun.js";

function artifactPaths(projectRoot: string): Record<string, string> {
  const paths: Record<string, string> = { ...DEFAULT_ARTIFACT_PATHS };
  const docsPath = path.join(projectRoot, ".agentera", "docs.yaml");
  if (fs.existsSync(docsPath)) {
    Object.assign(paths, parseDocsYamlMapping(fs.readFileSync(docsPath, "utf8")));
  }
  const resolved: Record<string, string> = {};
  for (const [artifact, rel] of Object.entries(paths)) {
    resolved[artifact] = path.join(projectRoot, rel);
  }
  return resolved;
}

function missingStatus(artifact: string, p: string, classification: string): CompactionStatus {
  return {
    artifact,
    path: p,
    classification,
    active_count: 0,
    archive_count: 0,
    total_count: 0,
    over_limit_count: 0,
    reason: "artifact path is not present",
    protected_overflow_count: 0,
    exists: false,
  };
}

function yamlErrorStatus(artifact: string, p: string, message: string): CompactionStatus {
  return {
    artifact,
    path: p,
    classification: "error",
    active_count: null,
    archive_count: null,
    total_count: null,
    over_limit_count: null,
    reason: message.trim() || "invalid YAML mapping root",
    protected_overflow_count: 0,
    exists: true,
  };
}

function yamlCounts(p: string, activeKey: string, archiveKey: string): [number, number] {
  const data = loadYamlMapping(fs.readFileSync(p, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) return [0, 0];
  const active = (data as any)[activeKey] || [];
  const archive = (data as any)[archiveKey] || [];
  return [Array.isArray(active) ? active.length : 0, Array.isArray(archive) ? archive.length : 0];
}

function yamlLists(p: string, activeKey: string, archiveKey: string): [any[], any[]] {
  const data = loadYamlMapping(fs.readFileSync(p, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) return [[], []];
  const active = (data as any)[activeKey] || [];
  const archive = (data as any)[archiveKey] || [];
  return [Array.isArray(active) ? active : [], Array.isArray(archive) ? archive : []];
}

function countStatus(
  artifact: string,
  p: string,
  activeCount: number,
  archiveCount: number,
  protectedOverflowCount = 0,
): CompactionStatus {
  const totalCount = activeCount + archiveCount;
  return {
    artifact,
    path: p,
    classification: "compactable",
    active_count: activeCount,
    archive_count: archiveCount,
    total_count: totalCount,
    over_limit_count: overLimitCount(activeCount, archiveCount),
    reason: protectedOverflowCount ? "protected-overflow review pressure" : "uniform_10_40_50",
    protected_overflow_count: protectedOverflowCount,
    exists: true,
  };
}

export function computeCompactionStatus(projectRoot: string): CompactionStatus[] {
  const paths = artifactPaths(projectRoot);
  const statuses: CompactionStatus[] = [];

  const todoPath = paths.todo;
  if (fs.existsSync(todoPath)) {
    const counts = countTodoResolvedEntries(fs.readFileSync(todoPath, "utf8"));
    statuses.push(countStatus("todo#Resolved", todoPath, counts.full, counts.oneline));
  } else {
    statuses.push(missingStatus("todo#Resolved", todoPath, "compactable"));
  }

  for (const [artifact, [activeKey, archiveKey]] of Object.entries(COMPACTABLE_YAML_ARTIFACTS)) {
    const p = paths[artifact];
    if (fs.existsSync(p)) {
      let active: any[];
      let archive: any[];
      try {
        [active, archive] = yamlLists(p, activeKey, archiveKey);
      } catch (exc) {
        statuses.push(yamlErrorStatus(artifact, p, (exc as Error).message));
        continue;
      }
      const protectedOverflowCount =
        artifact === "decisions" ? decisionProtectedOverflowCount(active, archive) : 0;
      statuses.push(countStatus(artifact, p, active.length, archive.length, protectedOverflowCount));
    } else {
      statuses.push(missingStatus(artifact, p, "compactable"));
    }
  }

  for (const [artifact, [classification, reason]] of Object.entries(NON_COMPACTABLE_ARTIFACTS)) {
    const p = paths[artifact];
    statuses.push({
      artifact,
      path: p,
      classification,
      active_count: null,
      archive_count: null,
      total_count: null,
      over_limit_count: null,
      reason,
      protected_overflow_count: 0,
      exists: fs.existsSync(p),
    });
  }

  const optimeraDir = path.join(projectRoot, ".agentera", "optimera");
  if (fs.existsSync(optimeraDir) && fs.statSync(optimeraDir).isDirectory()) {
    const experimentPaths: string[] = [];
    for (const sub of fs.readdirSync(optimeraDir).sort()) {
      const expPath = path.join(optimeraDir, sub, "experiments.yaml");
      if (fs.existsSync(expPath)) experimentPaths.push(expPath);
    }
    for (const expPath of experimentPaths) {
      let activeCount: number;
      let archiveCount: number;
      try {
        [activeCount, archiveCount] = yamlCounts(expPath, "experiments", "archive");
      } catch (exc) {
        statuses.push(yamlErrorStatus("experiments", expPath, (exc as Error).message));
        continue;
      }
      statuses.push({
        artifact: "experiments",
        path: expPath,
        classification: "protected",
        active_count: activeCount,
        archive_count: archiveCount,
        total_count: activeCount + archiveCount,
        over_limit_count: overLimitCount(activeCount, archiveCount),
        reason: "objective-state experiment files are classified but skipped by default",
        protected_overflow_count: 0,
        exists: true,
      });
    }
  }

  // Touch yamlArchiveEntries to keep the export alive in dry builds.
  void yamlArchiveEntries;

  return statuses;
}

function operationForStatus(status: CompactionStatus, mode: string): CompactionOperation {
  const base = (action: string, message: string): CompactionOperation => ({
    status,
    mode,
    action,
    changed: false,
    result: null,
    message,
  });
  if (!status.exists) return base("missing", status.reason);
  if (status.classification === "error") return base("error", status.reason);
  if (status.classification !== "compactable") return base("skipped", status.reason);
  if (status.protected_overflow_count) {
    return base("protected_overflow", `protected-overflow review pressure by ${status.protected_overflow_count}`);
  }
  if (!status.over_limit_count) return base("ok", "within uniform_10_40_50 limits");
  return base(
    mode === "check" ? "over_limit" : "pending_fix",
    `over uniform_10_40_50 limit by ${status.over_limit_count}`,
  );
}

export function checkCompaction(projectRoot: string): CompactionOperation[] {
  return computeCompactionStatus(projectRoot).map((status) => operationForStatus(status, "check"));
}

export function fixCompaction(projectRoot: string): CompactionOperation[] {
  const operations: CompactionOperation[] = [];
  for (const status of computeCompactionStatus(projectRoot)) {
    const baseline = operationForStatus(status, "fix");
    if (baseline.action !== "pending_fix") {
      operations.push(baseline);
      continue;
    }
    const p = status.path;
    let result: CompactResult;
    try {
      if (status.artifact === "todo#Resolved") {
        result = compactFile(p, "todo-resolved");
      } else if (status.artifact in YAML_SPEC_BY_ARTIFACT) {
        result = compactYamlFile(p, status.artifact);
      } else {
        operations.push({ status, mode: "fix", action: "skipped", changed: false, result: null, message: `no fixer registered for ${status.artifact}` });
        continue;
      }
    } catch (exc) {
      operations.push({ status, mode: "fix", action: "error", changed: false, result: null, message: (exc as Error).message });
      continue;
    }
    operations.push({
      status,
      mode: "fix",
      action: result.changed ? "compacted" : "ok",
      changed: result.changed,
      result,
      message:
        `full ${result.full_before}->${result.full_after}; ` +
        `archive ${result.oneline_before}->${result.oneline_after}; ` +
        `dropped ${result.dropped}`,
    });
  }
  return operations;
}

export function runCompaction(projectRoot: string, mode = "check"): CompactionOperation[] {
  if (mode === "check") return checkCompaction(projectRoot);
  if (mode === "fix") return fixCompaction(projectRoot);
  throw new Error(`unknown compaction mode: ${mode}`);
}
