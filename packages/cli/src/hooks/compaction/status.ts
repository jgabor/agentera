/**
 * Compaction status reporting and projection repair.
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
import { detectStateMode } from "../../state/stateMode.js";
import { discoverEntities } from "../../state/entityStorage.js";
import {
  decisionProtectedOverflowCount,
  decisionSatisfiedActiveCount,
  overLimitCount,
  yamlArchiveEntries,
} from "./retention.js";
import { CompactResult, CompactionOperation, CompactionStatus } from "./types.js";
import { compactFile, compactYamlBytes, compactYamlFile } from "./apply.js";
import {
  countTodoResolvedEntries,
  countTodoResolvedSectionHeadings,
  countTodoPendingSummarization,
  parseEntries,
  TODO_DROPPED_RECOVERY_GUIDANCE,
} from "./parse.js";
import { YAML_SPEC_BY_ARTIFACT } from "./dryRun.js";
import {
  InjectedMutationFailure,
  type StateMutationTransaction,
  type StateMutationOptions,
  withStateMutation,
} from "../../state/write/mutation.js";
import { hydrateDecisionRecords } from "../../state/decisionOverlay.js";
import type { ProjectionRecoveryReport } from "../../state/archiveRecovery.js";
import { loadProjectionPolicy } from "../../state/projectionPolicy.js";
import { ARTIFACT_PROTOCOL_PATHS } from "../../registries/artifactProtocolIds.js";

function artifactPaths(projectRoot: string): Record<string, string> {
  const paths: Record<string, string> = { ...DEFAULT_ARTIFACT_PATHS };
  const docsPath = path.join(projectRoot, ARTIFACT_PROTOCOL_PATHS.docs);
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
  budgetActiveCount?: number,
  projectionRecovery?: ProjectionRecoveryReport,
  projectionState?: "within_defaults" | "over_defaults",
): CompactionStatus {
  const totalCount = activeCount + archiveCount;
  const budgetActive = budgetActiveCount ?? activeCount;
  return {
    artifact,
    path: p,
    classification: "compactable",
    active_count: activeCount,
    archive_count: archiveCount,
    total_count: totalCount,
    over_limit_count: projectionState ? 0 : overLimitCount(budgetActive, archiveCount),
    reason: projectionState
      ? projectionState === "over_defaults"
        ? "lossless projection exceeds display defaults; numbered archives remain authoritative"
        : "lossless projection is within display defaults"
      : protectedOverflowCount
        ? "protected-overflow review pressure"
        : "uniform_10_40_50",
    protected_overflow_count: protectedOverflowCount,
    exists: true,
    ...(projectionState ? { projection_state: projectionState } : {}),
    ...(projectionRecovery ? { projection_recovery: projectionRecovery } : {}),
  };
}

function projectionRecoveryFor(
  projectRoot: string,
  artifact: string,
  p: string,
): ProjectionRecoveryReport | undefined {
  try {
    return compactYamlBytes(fs.readFileSync(p, "utf8"), artifact, projectRoot).result.recovery;
  } catch {
    return undefined;
  }
}

export function computeCompactionStatus(projectRoot: string): CompactionStatus[] {
  if (detectStateMode(projectRoot) === "entities") {
    const discovered = discoverEntities(projectRoot);
    const issueCount = discovered.issues.length;
    return [{
      artifact: "entity_state",
      path: path.join(projectRoot, ".agentera", "entities"),
      classification: issueCount ? "error" : "canonical_entities",
      active_count: discovered.entities.length,
      archive_count: 0,
      total_count: discovered.entities.length,
      over_limit_count: 0,
      reason: issueCount
        ? `${issueCount} canonical entity validation issue(s); run agentera check validate state --format json`
        : "canonical entity state is independently stored and is not compacted",
      protected_overflow_count: 0,
      exists: true,
    }];
  }
  const paths = artifactPaths(projectRoot);
  const projectionPolicy = loadProjectionPolicy();
  const statuses: CompactionStatus[] = [];

  const todoPath = paths.todo;
  if (fs.existsSync(todoPath)) {
    const todoText = fs.readFileSync(todoPath, "utf8");
    const headingCount = countTodoResolvedSectionHeadings(todoText);
    if (headingCount > 1) {
      // Refuse rather than silently process only the first `## ✓ Resolved`
      // section: duplicates hide the trailing entries from the budget and
      // from fix-mode migration. TODO has no lossless numbered archive, so
      // recovery once entries are dropped is Git-only.
      statuses.push({
        artifact: "todo#Resolved",
        path: todoPath,
        classification: "error",
        active_count: null,
        archive_count: null,
        total_count: null,
        over_limit_count: null,
        reason:
          `TODO.md has ${headingCount} '## ✓ Resolved' sections; merge into exactly one before compacting. ` +
          `Compaction drops oldest resolved entries and is destructive (no lossless archive); ` +
          TODO_DROPPED_RECOVERY_GUIDANCE,
        protected_overflow_count: 0,
        exists: true,
      });
    } else if (headingCount === 0) {
      statuses.push({
        artifact: "todo#Resolved",
        path: todoPath,
        classification: "error",
        active_count: null,
        archive_count: null,
        total_count: null,
        over_limit_count: null,
        reason: "TODO.md has no required '## ✓ Resolved' section; add exactly one before compacting.",
        protected_overflow_count: 0,
        exists: true,
      });
    } else {
      const counts = countTodoResolvedEntries(todoText);
      const status = countStatus("todo#Resolved", todoPath, counts.full, counts.oneline);
      // Detect in-budget (≤50) TODOs that still need a formatting rewrite:
      // rows 11-50 that are long verbatim headers instead of ≤15-word
      // summaries. This triggers `--mode fix` before entries overflow.
      const pendingSummarization = countTodoPendingSummarization(todoText);
      if (pendingSummarization > 0) {
        status.pending_summarization_count = pendingSummarization;
      }
      statuses.push(status);
    }
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
        artifact === "decisions"
          ? decisionProtectedOverflowCount(
              hydrateDecisionRecords(active, projectRoot),
              hydrateDecisionRecords(archive, projectRoot),
            )
          : 0;
      const budgetActiveCount =
        artifact === "decisions"
          ? decisionSatisfiedActiveCount(hydrateDecisionRecords(active, projectRoot))
          : undefined;
       statuses.push(
         countStatus(
           artifact,
           p,
           active.length,
           archive.length,
           protectedOverflowCount,
            budgetActiveCount,
            projectionRecoveryFor(projectRoot, artifact, p),
            active.length > projectionPolicy.activeEntries ||
              archive.length > projectionPolicy.summaryEntries ||
              active.length + archive.length > projectionPolicy.totalEntries
              ? "over_defaults"
              : "within_defaults",
          ),
       );
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

  const optimizeDir = path.join(projectRoot, ".agentera", "optimize");
  if (fs.existsSync(optimizeDir) && fs.statSync(optimizeDir).isDirectory()) {
    const experimentPaths: string[] = [];
    for (const sub of fs.readdirSync(optimizeDir).sort()) {
      const expPath = path.join(optimizeDir, sub, "experiments.yaml");
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
  if (status.projection_recovery?.refused_count) {
    return base(
      "refused",
      `projection retained ${status.projection_recovery.retained_full} full entr${status.projection_recovery.retained_full === 1 ? "y" : "ies"}; archive recovery is required before summarization`,
    );
  }
  if (status.projection_state === "over_defaults") {
    return base(
      mode === "fix" ? "pending_projection" : "projection",
      "projection exceeds display defaults; archive history remains lossless",
    );
  }
  if (!status.over_limit_count && !status.pending_summarization_count) {
    return base(
      "ok",
      status.projection_state === "within_defaults"
        ? "within configured lossless projection defaults"
        : "within uniform_10_40_50 limits",
    );
  }
  if (status.over_limit_count) {
    return base(
      mode === "check" ? "over_limit" : "pending_fix",
      `over uniform_10_40_50 limit by ${status.over_limit_count}`,
    );
  }
  // pending_summarization_count > 0 but within budget: rows 11-50 need
  // ≤15-word summary formatting, not entry removal.
  const n = status.pending_summarization_count as number;
  return base(
    mode === "check" ? "formatting" : "pending_formatting",
    `${n} resolved entr${n === 1 ? "y" : "ies"} in summary tier need ≤15-word summarization`,
  );
}

export function checkCompaction(projectRoot: string): CompactionOperation[] {
  return computeCompactionStatus(projectRoot).map((status) => operationForStatus(status, "check"));
}

function fixCompactionUnlocked(
  projectRoot: string,
  transaction: StateMutationTransaction,
): CompactionOperation[] {
  const operations: CompactionOperation[] = [];
  for (const status of computeCompactionStatus(projectRoot)) {
    const baseline = operationForStatus(status, "fix");
   if (
     baseline.action !== "pending_fix" &&
     baseline.action !== "pending_projection" &&
     baseline.action !== "pending_formatting"
   ) {
      operations.push(baseline);
      continue;
    }
    const p = status.path;
    let result: CompactResult;
    try {
      if (status.artifact === "todo#Resolved") {
        result = transaction.mutateProjection(p, (stage) => compactFile(stage, "todo-resolved"));
      } else if (status.artifact in YAML_SPEC_BY_ARTIFACT) {
        result = transaction.mutateProjection(p, (stage) => compactYamlFile(stage, status.artifact, projectRoot));
      } else {
        operations.push({ status, mode: "fix", action: "skipped", changed: false, result: null, message: `no fixer registered for ${status.artifact}` });
        continue;
      }
    } catch (exc) {
      if (exc instanceof InjectedMutationFailure) throw exc;
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
        `omitted ${result.omitted_count ?? 0}; dropped ${result.dropped}`,
    });
  }
  return operations;
}

export function fixCompaction(
  projectRoot: string,
  options: StateMutationOptions = {},
): CompactionOperation[] {
  return withStateMutation(
    projectRoot,
    (transaction) => fixCompactionUnlocked(projectRoot, transaction),
    options,
  );
}

export function runCompaction(
  projectRoot: string,
  mode = "check",
  options: StateMutationOptions = {},
): CompactionOperation[] {
  if (mode === "check") return checkCompaction(projectRoot);
  if (mode === "fix") {
    if (detectStateMode(projectRoot) === "entities") {
      return computeCompactionStatus(projectRoot).map((status) => operationForStatus(status, "fix"));
    }
    return fixCompaction(projectRoot, options);
  }
  throw new Error(`unknown compaction mode: ${mode}`);
}
