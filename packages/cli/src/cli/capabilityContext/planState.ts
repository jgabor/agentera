import fs from "node:fs";
import { asList } from "../stateQuery.js";
import { artifactPath, type SchemaInfo } from "../appContext.js";
import { loadNamedArtifact } from "../orientation.js";
import { sourceMetadata } from "../stateQuery.js";
import {
  entryStatus,
  sourceProvenance,
  taskRef,
  hasRecordedValue,
  uniqueList,
} from "./shared.js";
import type { Dict } from "./types.js";

export function orchestrationTaskSummary(task: Dict): Dict {
  const evidence = task.evidence;
  const evidenceItems = Array.isArray(evidence) ? evidence : evidence === null || evidence === undefined || evidence === "" ? [] : [evidence];
  return {
    ...taskRef(task),
    depends_on: planDependsOnList(task),
    acceptance_summary: { count: asList(task.acceptance).length, items: asList(task.acceptance) },
    evidence_summary: { count: evidenceItems.length, items: evidenceItems },
  };
}

/** Coerce plan task numbers and depends_on refs to comparable lookup keys (int/string/object forms). */
export function planTaskRefKeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "object" && !Array.isArray(value)) {
    const entry = value as Dict;
    const nested = entry.number ?? entry.task_number ?? entry.id;
    return nested === null || nested === undefined ? [] : planTaskRefKeys(nested);
  }
  const text = String(value).trim();
  if (!text) return [];
  const keys = new Set<string>([text]);
  const numeric = Number(text);
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) keys.add(String(numeric));
  return [...keys];
}

export function formatPlanTaskDepRef(dep: unknown): string {
  const keys = planTaskRefKeys(dep);
  return keys.length > 0 ? keys[0]! : String(dep);
}

export function planDependsOnList(task: Dict): unknown[] {
  const raw = task.depends_on;
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined || raw === "") return [];
  return [raw];
}

export function indexPlanTasksByNumber(tasks: Dict[]): Record<string, Dict> {
  const taskByNumber: Record<string, Dict> = {};
  for (const task of tasks) {
    if (task.number === null || task.number === undefined) continue;
    for (const key of planTaskRefKeys(task.number)) taskByNumber[key] = task;
  }
  return taskByNumber;
}

export function resolvePlanTaskByRef(taskByNumber: Record<string, Dict>, dep: unknown): Dict | undefined {
  for (const key of planTaskRefKeys(dep)) {
    const hit = taskByNumber[key];
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export const DONE_STATUSES_ORCH = new Set(["complete", "completed", "closed", "done", "resolved", "retired"]);
export const BLOCKED_STATUSES_ORCH = new Set(["blocked", "stuck"]);

export const TARGET_VERSION_RE = /\b\d+\.\d+\.\d+\b/;

export function dependencyReadyTasks(tasks: Dict[]): Dict[] {
  const taskByNumber = indexPlanTasksByNumber(tasks);
  const ready: Dict[] = [];
  for (const task of tasks) {
    const status = entryStatus(task, "pending");
    if (DONE_STATUSES_ORCH.has(status) || BLOCKED_STATUSES_ORCH.has(status)) continue;
    let blocked = false;
    for (const dep of planDependsOnList(task)) {
      const dependency = resolvePlanTaskByRef(taskByNumber, dep);
      if (dependency === undefined || !DONE_STATUSES_ORCH.has(entryStatus(dependency, "pending"))) {
        blocked = true;
        break;
      }
    }
    if (!blocked) ready.push(task);
  }
  return ready;
}

export function selectEvidenceTarget(plan: Dict): Dict {
  const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const noTarget = {
    status: "no_target",
    target_type: "repository",
    task: null,
    selection_reason: "no_plan_task_target",
    source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries"),
    caveats: ["No plan task target was selected; evaluate repository-level evidence only."],
  };
  if (!plan.exists || tasks.length === 0) return noTarget;
  const inProgress = tasks.find((task) => entryStatus(task, "pending") === "in_progress");
  if (inProgress) {
    return {
      status: "selected",
      target_type: "plan_task",
      task: taskRef(inProgress),
      selection_reason: "in_progress_task",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.status"),
      caveats: [],
    };
  }
  const ready = dependencyReadyTasks(tasks);
  if (ready.length > 0) {
    return {
      status: "selected",
      target_type: "plan_task",
      task: taskRef(ready[0]),
      selection_reason: "first_dependency_ready_pending_task",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.depends_on"),
      caveats: [],
    };
  }
  const completedWithEvidence = [...tasks].reverse().find(
    (task) => DONE_STATUSES_ORCH.has(entryStatus(task, "pending")) && hasRecordedValue(task.evidence),
  );
  if (completedWithEvidence) {
    return {
      status: "selected",
      target_type: "plan_task",
      task: taskRef(completedWithEvidence),
      selection_reason: "latest_completed_task_with_evidence",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.evidence"),
      caveats: [],
    };
  }
  return noTarget;
}

export function taskByRef(plan: Dict, ref: Dict | null): Dict | null {
  if (!ref) return null;
  for (const task of asList(plan.tasks)) {
    if (task && typeof task === "object" && !Array.isArray(task) && task.number === ref.number) return task;
  }
  return null;
}

export function planContextField(plan: Dict, field: string): any {
  const summary = plan.summary && typeof plan.summary === "object" && !Array.isArray(plan.summary) ? plan.summary : {};
  return field in summary ? summary[field] : plan[field];
}

export function realiseraScopeBoundary(plan: Dict, selected: Dict | null): Dict {
  const explicitPaths: string[] = [];
  const scopeField = planContextField(plan, "scope");
  const sources = [selected ?? {}, scopeField && typeof scopeField === "object" ? scopeField : {}];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of ["source_files", "files", "paths"]) {
      for (const value of asList((source as Dict)[key])) {
        const text = String(value).trim();
        if (text && !explicitPaths.includes(text)) explicitPaths.push(text);
      }
    }
  }
  return {
    artifact_families: ["plan", "progress", "todo", "docs", "health", "changelog", "decisions", "vision", "profile", "design"],
    source_scope: {
      status: explicitPaths.length > 0 ? "explicit" : "unspecified",
      explicit_paths: explicitPaths,
      policy: "Do not infer source-file allowlists or exclusions from task text; use only explicit plan/source-contract paths.",
    },
  };
}

export function realiseraArtifactUpdateRequirements(plan: Dict, docs: Dict): Dict {
  const mapping = asList(docs.mapping);
  const mapped = mapping.filter((e) => e && typeof e === "object" && e.artifact).map((e) => e.artifact);
  return {
    required_families: ["plan", "progress", "todo", "changelog"],
    protected_families: ["vision", "objective", "profile", "installed_app"],
    docs_mapping_available: Boolean(docs.exists && mapping.length > 0),
    mapped_artifacts: mapped,
    plan_status_update_required: Boolean(plan.exists),
    policy: "Update execution artifacts during the cycle; do not mutate protected state without explicit approval.",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.mapping"),
  };
}

export function realiseraPlanCompletionSweep(plan: Dict): Dict {
  const complete = Boolean(plan.complete_plan);
  return {
    status: complete ? "eligible" : "not_eligible",
    mutation_allowed: false,
    required_updates: ["progress aggregate cycle", "changelog plan-level entries", "TODO milestone advance", "health cross-reference"],
    archive_candidate: complete ? "active plan archive path is generated only during Realisera sweep execution" : null,
    caveats: complete ? [] : ["Plan completion sweep is not eligible until every plan task is complete."],
    source_provenance: sourceProvenance("plan", "agentera plan --format json", "summary.status"),
  };
}

export function selectedTargetVersion(plan: Dict): string | null {
  const textParts = [String(plan.title ?? "")];
  const firstPending = plan.first_pending;
  if (firstPending && typeof firstPending === "object" && !Array.isArray(firstPending)) {
    for (const key of ["name", "title"]) textParts.push(String(firstPending[key] ?? ""));
  }
  for (const task of asList(plan.tasks)) {
    if (task && typeof task === "object" && !Array.isArray(task)) {
      for (const key of ["name", "title"]) textParts.push(String(task[key] ?? ""));
    }
  }
  const match = TARGET_VERSION_RE.exec(textParts.join("\n"));
  return match ? match[0] : null;
}

export function changelogRecordsTarget(text: string, targetVersion: string | null): boolean {
  if (!targetVersion) return false;
  const escaped = targetVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\d.])${escaped}(?![\\d.+-])`);
  return text.split(/\r\n|\r|\n/).some((line) => re.test(line));
}

export function closeoutChangelogBoundary(schemas: Record<string, SchemaInfo>, plan: Dict): Dict {
  const info: SchemaInfo = schemas.changelog ?? { path: "CHANGELOG.md", record: undefined, schema: {}, fields: {} };
  const p = artifactPath(info, "changelog");
  const source = sourceMetadata("changelog", p);
  const targetVersion = selectedTargetVersion(plan);
  const unavailable = (caveat: string): Dict => ({
    status: "unavailable",
    source,
    source_provenance: sourceProvenance("changelog", "agentera query changelog --format json"),
    selected_target_version: targetVersion,
    selected_target_recorded: false,
    unreleased_present: false,
    latest_release_heading: null,
    boundary_present: false,
    boundary: null,
    caveats: [caveat],
  });
  if (!fs.existsSync(p)) return unavailable("CHANGELOG state is unavailable in CLI state.");
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (exc) {
    return unavailable(`CHANGELOG state could not be read by the CLI: ${(exc as Error).message}`);
  }
  const headings = text.split(/\r\n|\r|\n/).filter((line) => line.startsWith("## ")).map((line) => line.trim());
  const unreleased = headings.find((h) => h.toLowerCase().includes("unreleased")) ?? null;
  const latestRelease = headings.find((h) => !h.toLowerCase().includes("unreleased")) ?? null;
  const selectedRecorded = changelogRecordsTarget(text, targetVersion);
  const caveats: string[] = [];
  if (headings.length === 0) caveats.push("CHANGELOG state has no release headings.");
  if (targetVersion && !selectedRecorded) caveats.push(`CHANGELOG state has no ${targetVersion} closeout entry yet.`);
  const boundary = unreleased || latestRelease;
  return {
    status: headings.length > 0 ? "available" : "incomplete",
    source,
    source_provenance: {
      ...sourceProvenance("changelog", "agentera query changelog --format json", "release_headings"),
      internal_source: "CLI-resolved CHANGELOG.md heading scan",
    },
    selected_target_version: targetVersion,
    selected_target_recorded: selectedRecorded,
    unreleased_present: unreleased !== null,
    latest_release_heading: latestRelease,
    boundary_present: boundary !== null,
    boundary,
    release_state: selectedRecorded ? "selected_target_recorded" : "no_selected_target_closeout_entry",
    caveats,
  };
}
