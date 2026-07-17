import { asList } from "../stateQuery.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { truncateCodePoints } from "../../core/text.js";

function pickObject(value: unknown, keys: string[]): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as JsonObject;
  const compact: JsonObject = {};
  for (const key of keys) if (key in source) compact[key] = source[key];
  return compact;
}

export function slimBenchmarkContext(value: JsonObject): JsonObject {
  const compact: JsonObject = { capability: value.capability ?? "optimize" };
  compact.benchmark_source = pickObject(value.benchmark_source, ["status", "source_provenance", "caveats"]);
  compact.latest_report = pickObject(value.latest_report, ["status", "source_label", "non_empty_evidence_present", "status_counts", "caveats"]);
  compact.history_summary = pickObject(value.history_summary, ["status", "source_label", "non_empty_evidence_present", "rows", "caveats"]);
  compact.runtime_coverage = pickObject(value.runtime_coverage, ["status", "source_label", "non_empty_evidence_present", "status_counts", "caveats"]);
  compact.state_access_metrics = pickObject(value.state_access_metrics, [
    "status", "total_state_sequences", "state_sequences_with_raw_after_cli", "state_sequences_with_redundant_raw_access",
    "raw_after_cli_sequence_rate", "redundant_raw_sequence_rate", "caveats",
  ]);
  compact.token_impact = pickObject(value.token_impact, ["status", "estimated_tokens_saved_vs_previous", "caveats"]);
  compact.comparison = pickObject(value.comparison, ["status", "rows", "caveats"]);
  compact.recommendation = pickObject(value.recommendation, ["status", "action", "rationale", "caveats"]);
  compact.manual_refresh = pickObject(value.manual_refresh, ["command", "source_provenance"]);
  compact.privacy_boundary = pickObject(value.privacy_boundary, ["status", "excluded", "caveats"]);
  compact.state_family_caveats = value.state_family_caveats ?? [];
  compact.fallback_commands = value.fallback_commands ?? [];
  compact.source_contract = value.source_contract ?? {};
  return compact;
}

export function compactTaskSummaryForSlim(task: any): any {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  return {
    id: task.id ?? null,
    artifact: task.artifact ?? "plan",
    name: task.name ?? null,
    status: task.status ?? null,
    depends_on: task.depends_on ?? null,
    acceptance_count: task.acceptance_summary && typeof task.acceptance_summary === "object" ? task.acceptance_summary.count ?? null : null,
    evidence_count: task.evidence_summary && typeof task.evidence_summary === "object" ? task.evidence_summary.count ?? null : null,
    blocked_reasons: task.blocked_reasons ?? null,
  };
}

export function compactProgressVerification(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: JsonObject = {};
  for (const key of [
    "status", "source_provenance", "cycle", "verified_present",
    "non_empty_evidence_present", "non_empty_evidence_fields", "latest_progress_verification_pointer", "caveats",
  ]) {
    if (key in value) out[key] = value[key];
  }
  return out;
}

export function slimOrchestrationContext(value: JsonObject): JsonObject {
  const compact: JsonObject = { ...value };
  const taskQueue = value.task_queue && typeof value.task_queue === "object" && !Array.isArray(value.task_queue) ? value.task_queue : {};
  compact.task_queue = {
    total: taskQueue.total ?? null,
    dependency_ready_tasks: asList(taskQueue.dependency_ready_tasks).slice(0, 10).map((t) => compactTaskSummaryForSlim(t)),
    blocked_tasks: asList(taskQueue.blocked_tasks).slice(0, 10).map((t) => compactTaskSummaryForSlim(t)),
  };
  compact.progress_verification = compactProgressVerification(value.progress_verification);
  compact.task_summaries = asList(value.task_summaries).slice(0, 10).map((t) => compactTaskSummaryForSlim(t));
  return compact;
}

export function truncateContextText(value: any, maxChars = 240): any {
  if (typeof value !== "string") return value;
  return truncateCodePoints(value, maxChars, "\u2026", true);
}

export function compactItemsState(value: any, maxItems = 3, maxChars = 180): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const compact: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["items", "attributed_items", "summary"].includes(key)) compact[key] = item;
  }
  const items = (value as JsonObject).items;
  if (Array.isArray(items)) {
    compact.item_count = items.length;
    compact.items = items.slice(0, maxItems).map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, truncateContextText(v, maxChars)]))
        : truncateContextText(item, maxChars),
    );
    compact.truncated_item_count = Math.max(items.length - maxItems, 0);
  }
  const attributed = (value as JsonObject).attributed_items;
  if (Array.isArray(attributed)) compact.attributed_item_count = attributed.length;
  if (typeof (value as JsonObject).summary === "string") {
    compact.summary_present = true;
    compact.summary_excerpt = truncateContextText((value as JsonObject).summary, maxChars);
  }
  return compact;
}

export function compactVersionChecks(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const compact: JsonObject = {};
  for (const key of ["status", "allowed_status_values", "source_provenance", "caveats"]) {
    if (key in value) compact[key] = (value as JsonObject)[key];
  }
  const checks = (value as JsonObject).checks;
  if (Array.isArray(checks)) {
    compact.checks = checks.map((check) => {
      const out: JsonObject = {};
      for (const key of ["name", "status", "refresh_performed", "remote_checks_performed", "registry_checks_performed"]) {
        if (check && typeof check === "object" && !Array.isArray(check) && key in check) {
          const c = check as JsonObject;
          out[key] = c[key];
        }
      }
      return out;
    });
  }
  return compact;
}

export function slimEvidenceContext(value: JsonObject): JsonObject {
  const compact: JsonObject = { ...value };
  compact.residual_risks = compactItemsState(value.residual_risks, 5, 180);
  compact.todo_state = compactItemsState(value.todo_state, 3, 180);
  compact.progress_verification = compactProgressVerification(value.progress_verification);
  compact.version_checks = compactVersionChecks(value.version_checks);
  return compact;
}

export function slimCloseoutContext(value: JsonObject): JsonObject {
  const compact: JsonObject = { ...value };
  compact.benchmark_evidence = compactItemsState(value.benchmark_evidence, 0, 220);
  compact.todo_blockers = compactItemsState(value.todo_blockers, 3, 160);
  compact.progress_evidence = compactProgressVerification(value.progress_evidence);
  return compact;
}
