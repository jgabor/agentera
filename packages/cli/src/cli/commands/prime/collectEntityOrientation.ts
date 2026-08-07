import path from "node:path";

import type { JsonObject, JsonValue } from "../../../core/jsonValue.js";
import { listProgressEntities } from "../../../state/progressEntities.js";
import { listDecisionEntities } from "../../../state/decisionEntities.js";
import { listHealthEntities } from "../../../state/healthEntities.js";
import { listPlanEntities, listPlanTaskEntities } from "../../../state/planEntities.js";
import { listObjectiveEntities, listExperimentEntities } from "../../../state/objectiveExperimentEntities.js";
import { assertTodoReconciliationReadable, listTodoDocsEntities, projectTodoReadEntities } from "../../../state/todoDocsEntities.js";
import { inspectTodoReconciliationState, type TodoReconciliationInspection } from "../../../state/todoReconciliationInspection.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { discoverEntities } from "../../../state/entityStorage.js";
import { summaryCaveat } from "../../../state/summaryEntityRead.js";
import { boundStartupValue, STARTUP_ARRAY_LIMIT } from "../../../state/startupProjection.js";
import { rememberPlanTaskIndex } from "../../planTaskIndex.js";
import { firstActionablePlanTask } from "../../capabilityContext/planState.js";
import type {
  DecisionFollowUp,
  DecisionReviewAttention,
  DocsSummary,
  HealthSummary,
  IssueCounts,
  ObjectiveSummary,
  PlanSummary,
  ProgressSummary,
  StartupHistorySummary,
  TodoDetailSummary,
} from "../../contracts/orientationState.js";
import { issueCounts } from "../../orientation.js";
import { preCutoverCommand } from "../../preCutoverCommand.js";
import { evaluateTodoReadinessQueue, type TodoReadinessQueueSelection } from "../../todoReadinessSelection.js";
import { projectCurrentGlossaryCaveats } from "../../../state/progressGlossaryCaveat.js";
import { glossaryCaveatContract } from "../../../registries/glossaryCaveatContract.js";
import { renderTodoPublicRecord } from "../../todoMarkdown.js";

function entries(payload: JsonObject): JsonObject[] {
  return Array.isArray(payload.entries)
    ? payload.entries.filter((entry): entry is JsonObject => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function bounded<T>(value: T): T {
  return boundStartupValue(value as unknown as JsonValue) as unknown as T;
}

function record(entry: JsonObject | undefined): JsonObject {
  return entry?.record && typeof entry.record === "object" && !Array.isArray(entry.record)
    ? entry.record as JsonObject
    : {};
}

function header(entry: JsonObject | undefined): JsonObject {
  const value = record(entry).header;
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function terminal(status: unknown): boolean {
  return ["complete", "completed", "closed", "done", "resolved", "retired", "superseded"].includes(String(status ?? "").toLowerCase());
}

function healthSummary(latest: JsonObject | undefined, history: JsonObject | undefined): HealthSummary {
  if (!latest) {
    return history
      ? { exists: true, status: "degraded", startup_outcome: "degraded", degraded_history: history }
      : { exists: false, status: "absent", startup_outcome: "ok" };
  }
  const healthRecord = record(latest);
  const grades = healthRecord.grades && typeof healthRecord.grades === "object" && !Array.isArray(healthRecord.grades)
    ? healthRecord.grades as JsonObject
    : {};
  const ranks: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
  let worst: [string, string, number] | null = null;
  for (const [dimension, grade] of Object.entries(grades)) {
    const text = String(grade);
    const rank = ranks[text.toUpperCase().slice(0, 1)] ?? -1;
    if (worst === null || rank > worst[2]) worst = [dimension, text, rank];
  }
  const trajectory = String(healthRecord.trajectory ?? "");
  const degrading = ["degrading", "declining", "worse"].includes(trajectory.toLowerCase()) || (worst !== null && worst[2] >= ranks.D);
  return {
    exists: true,
    status: degrading ? "degraded" : "available",
    startup_outcome: degrading ? "degraded" : "ok",
    id: latest.id,
    artifact: latest.artifact,
    date: String(healthRecord.date ?? ""),
    trajectory,
    grade: worst?.[1] ?? "",
    worst,
    degrading,
    ...(history ? { degraded_history: history } : {}),
  };
}

function degradedHistory(
  artifact: "progress" | "decisions" | "health",
  totalSummaryCount: number,
): JsonObject | undefined {
  if (totalSummaryCount === 0) return undefined;
  return {
    summary_count: totalSummaryCount,
    returned_count: 0,
    omitted_count: totalSummaryCount,
    retrieval: {
      list: preCutoverCommand(`state ${artifact} list --limit 20 --format json`),
      get: preCutoverCommand(`state ${artifact} get --id ID --format json`),
    },
  };
}

function projectedHistory(
  list: JsonObject,
  artifact: "progress" | "decisions" | "health",
  fullCount: number,
  summaryCount: number,
  degraded: JsonObject | undefined,
): JsonObject {
  const total = fullCount + summaryCount;
  const listCommand = preCutoverCommand(`state ${artifact} list --limit 20 --format json`);
  const getCommand = preCutoverCommand(`state ${artifact} get --id ID --format json`);
  return {
    schemaVersion: list.schemaVersion,
    command: list.command,
    status: summaryCount > 0 ? "degraded" : "ok",
    compatibility: summaryCount > 0 ? (fullCount > 0 ? "mixed" : "degraded") : "current",
    detail_availability: "omitted",
    counts: { total, returned: 0, remaining: total, full: fullCount, summary: summaryCount },
    ...(summaryCount > 0 ? { caveats: [summaryCaveat(artifact)] } : {}),
    omitted: total > 0,
    omitted_count: total,
    omission_reason: total > 0 ? "startup_history_detail" : "none",
    retrieval: { list: listCommand, get: getCommand },
    ...(degraded ? { degraded_history: degraded } : {}),
    source_contract: list.source_contract,
  };
}

function selected(entries: JsonObject[], artifact: "plan" | "objective"): JsonObject | undefined {
  if (entries.length < 2) return entries[0];
  const ids = entries.map((entry) => String(entry.id)).sort().join(", ");
  const noun = artifact === "plan" ? "open plans" : "active objectives";
  const list = preCutoverCommand(`state ${artifact} list --format json`);
  throw new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "ambiguous",
      artifact,
      message: `multiple ${noun} require explicit selection: ${ids}`,
      syntax: preCutoverCommand(`state ${artifact} get --id ID --format json`),
      example: preCutoverCommand(`state ${artifact} get --id ${String(entries[0]?.id)} --format json`),
      recovery: `Run ${list}, resolve the competing ${noun}, and retry prime.`,
    },
  }, 1);
}

export interface EntityOrientationProjection {
  plan: PlanSummary;
  docs: DocsSummary;
  progress: ProgressSummary;
  health: HealthSummary;
  objective: ObjectiveSummary;
  todoItems: JsonObject[];
  todoCounts: IssueCounts;
  todoDetail: TodoDetailSummary;
  todoReadiness: TodoReadinessQueueSelection;
  todoReconciliation: TodoReconciliationInspection | null;
  decision: DecisionFollowUp | null;
  decisionAttention: DecisionReviewAttention | null;
  glossaryCaveatAttention: string | null;
  glossaryCaveatAttentionPolicy: { public_limit: number; reserved_slots: number } | null;
  history: Record<string, StartupHistorySummary>;
}

/** Bounded startup projection built only from canonical entity readers. */
export function collectEntityOrientation(projectRoot: string, sourceRoot: string): EntityOrientationProjection {
  assertTodoReconciliationReadable(projectRoot, sourceRoot);
  const discovery = discoverEntities(projectRoot, sourceRoot);
  const todoReconciliation = inspectTodoReconciliationState(projectRoot, sourceRoot, discovery);
  const caveatContract = glossaryCaveatContract(path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml"));
  const glossaryCaveatProjection = projectCurrentGlossaryCaveats(discovery.entities, caveatContract);
  const invalidProgress = (entity: (typeof discovery.entities)[number]): boolean =>
    (entity.artifact === "progress" || ["progress_cycle", "progress_summary"].includes(entity.boundary ?? "")) &&
    entity.classification !== "valid";
  const progressDiscovery = discovery.entities.some(invalidProgress)
    ? { ...discovery, entities: discovery.entities.filter((entity) => !invalidProgress(entity)) }
    : discovery;
  const progressList = listProgressEntities(projectRoot, 10, {}, undefined, { sourceRoot, format: "json", discovery: progressDiscovery });
  const decisionList = listDecisionEntities(projectRoot, 10, undefined, undefined, { sourceRoot, format: "json", discovery });
  const healthList = listHealthEntities(projectRoot, 10, undefined, undefined, { sourceRoot, format: "json", discovery });
  const planList = listPlanEntities(projectRoot, 2, undefined, { sourceRoot, format: "json", statuses: ["open", "active"], discovery });
  const objectiveList = listObjectiveEntities(projectRoot, 2, undefined, { sourceRoot, format: "json", statuses: ["open", "active"], discovery });
  const closedObjectiveList = listObjectiveEntities(projectRoot, 1, undefined, { sourceRoot, format: "json", statuses: ["closed"], discovery });
  const todoList = listTodoDocsEntities(projectRoot, "todo", 20, undefined, { status: "open" }, { sourceRoot, format: "json", discovery });
  const docsList = listTodoDocsEntities(projectRoot, "docs", 20, undefined, {}, { sourceRoot, format: "json", discovery });

  const progressEntries = entries(progressList);
  const healthEntries = entries(healthList);
  const decisionEntries = entries(decisionList);
  const fullProgressEntries = progressEntries.filter((entry) => entry.detail_availability === "full");
  const fullHealthEntries = healthEntries.filter((entry) => entry.detail_availability === "full");
  const fullDecisionEntries = decisionEntries.filter((entry) => entry.detail_availability === "full");
  const progressHistory = degradedHistory(
    "progress",
    discovery.entities.filter((entry) => entry.boundary === "progress_summary").length,
  );
  const decisionHistory = degradedHistory(
    "decisions",
    discovery.entities.filter((entry) => entry.boundary === "decision_summary").length,
  );
  const healthHistory = degradedHistory(
    "health",
    discovery.entities.filter((entry) => entry.boundary === "health_summary").length,
  );
  const progressFullCount = discovery.entities.filter((entry) => entry.boundary === "progress_cycle").length;
  const decisionFullCount = discovery.entities.filter((entry) => entry.boundary === "decision").length;
  const healthFullCount = discovery.entities.filter((entry) => entry.boundary === "health_audit").length;
  const progressSummaryCount = discovery.entities.filter((entry) => entry.boundary === "progress_summary").length;
  const decisionSummaryCount = discovery.entities.filter((entry) => entry.boundary === "decision_summary").length;
  const healthSummaryCount = discovery.entities.filter((entry) => entry.boundary === "health_summary").length;
  const planEntries = entries(planList);
  const objectiveEntries = entries(objectiveList);
  const todoEntries = entries(todoList);
  const docsEntries = entries(docsList);

  const selectedPlan = selected(planEntries, "plan");
  const taskPage = selectedPlan
    ? listPlanTaskEntities(projectRoot, String(selectedPlan.id), 100, undefined, { sourceRoot, format: "json", discovery })
    : null;
  const taskEntries = (taskPage
    ? entries(taskPage)
    : []).map((entry): JsonObject => ({ ...record(entry), id: entry.id, artifact: entry.artifact, provenance: entry.provenance }));
  const allTaskEntries = selectedPlan
    ? discovery.entities
      .filter((entry) => entry.boundary === "plan_task" && entry.classification === "valid" && entry.record?.plan === selectedPlan.id && entry.id)
      .sort((left, right) => left.id!.localeCompare(right.id!))
      .map((entry): JsonObject => ({ ...entry.record!, id: entry.id!, artifact: entry.artifact!, provenance: { storage: "canonical_entity_file", path: entry.relativePath } }))
    : [];
  const firstPending = firstActionablePlanTask(allTaskEntries);
  const taskStatusCounts = allTaskEntries.reduce<Record<string, number>>((counts, entry) => {
    const status = String(entry.status ?? "pending").toLowerCase(); counts[status] = (counts[status] ?? 0) + 1; return counts;
  }, {});
  const publicTaskEntries = taskEntries.slice(0, STARTUP_ARRAY_LIMIT);
  const taskDetailOmitted = allTaskEntries.length > publicTaskEntries.length;
  const taskRetrieval: JsonObject = selectedPlan
    ? { list: preCutoverCommand(`state plan tasks list ${String(selectedPlan.id)} --limit 100 --format json`), restart: preCutoverCommand(`state plan tasks list ${String(selectedPlan.id)} --limit 100 --format json`), get: preCutoverCommand("state plan tasks get --id ID --format json") }
    : {};
  const plan: PlanSummary = selectedPlan ? {
    exists: true,
    active: true,
    id: selectedPlan.id,
    artifact: selectedPlan.artifact,
    status: String(header(selectedPlan).status ?? "open"),
    title: String(header(selectedPlan).title ?? ""),
    tasks: publicTaskEntries,
    complete: taskStatusCounts.complete ?? 0,
    superseded: taskStatusCounts.superseded ?? 0,
    total: allTaskEntries.length,
    complete_plan: allTaskEntries.length > 0 && allTaskEntries.every((entry) => terminal(entry.status)),
    first_pending: firstPending ?? null,
    task_status_counts: taskStatusCounts,
    task_omission: { omitted: taskDetailOmitted, total: allTaskEntries.length, returned_count: publicTaskEntries.length, omitted_count: allTaskEntries.length - publicTaskEntries.length, omission_reason: taskDetailOmitted ? taskPage?.omitted === true ? taskPage.omission_reason : "startup_detail_capacity" : "none", retrieval: taskRetrieval },
    diagnostics: [],
  } : { exists: false, active: false, status: "missing", tasks: [], complete: 0, superseded: 0, total: 0, complete_plan: false, first_pending: null };

  const latestProgress = fullProgressEntries[0];
  const latestProgressRecord = record(latestProgress);
  const progress: ProgressSummary = latestProgress ? {
    exists: true,
    status: "available",
    latest: {
      id: latestProgress.id,
      artifact: latestProgress.artifact,
      ...Object.fromEntries(
        ["what", "next"]
          .filter((field) => latestProgressRecord[field] !== undefined)
          .map((field) => [field, latestProgressRecord[field]]),
      ),
    },
    ...(latestProgressRecord.verified === undefined ? {} : { latest_verification: latestProgressRecord.verified }),
    cycle_count: Number((progressList.counts as JsonObject | undefined)?.total ?? progressEntries.length),
    ...(progressHistory ? { degraded_history: progressHistory } : {}),
  } : progressEntries.length ? {
    exists: true,
    status: "degraded_history",
    cycle_count: Number((progressList.counts as JsonObject | undefined)?.total ?? progressEntries.length),
    degraded_history: progressHistory!,
  } : { exists: false, status: "missing", cycle_count: 0 };

  const health = healthSummary(fullHealthEntries[0], healthEntries.length ? healthHistory : undefined);

  const activeObjective = selected(objectiveEntries, "objective");
  const closedObjectiveCount = Number((closedObjectiveList.counts as JsonObject | undefined)?.total ?? 0);
  const objectiveRecord = record(activeObjective);
  const objective: ObjectiveSummary = activeObjective ? {
    exists: true,
    active: true,
    id: activeObjective.id,
    artifact: activeObjective.artifact,
    title: String(header(activeObjective).title ?? ""),
    status: String(header(activeObjective).status ?? "open"),
    metric: String((objectiveRecord.metric as JsonObject | undefined)?.description ?? ""),
    experiments: entries(listExperimentEntities(projectRoot, String(activeObjective.id), 20, undefined, { sourceRoot, format: "json", discovery })),
    closed_count: closedObjectiveCount,
  } : { exists: closedObjectiveCount > 0, active: false, closed_count: closedObjectiveCount };

  const completeTodoEntities = projectTodoReadEntities(projectRoot, sourceRoot, discovery);
  const todoReadiness = evaluateTodoReadinessQueue(completeTodoEntities, sourceRoot);
  const todoItems = todoEntries.map((entry) => {
    const todo = record(entry);
    return {
      id: String(entry.id), artifact: String(entry.artifact),
      severity: String(todo.severity ?? "normal"),
      status: String(todo.status ?? "open"),
      kind: typeof todo.kind === "string" ? todo.kind : null,
      target_version: typeof todo.target_version === "string" ? todo.target_version : null,
      title: typeof todo.title === "string" ? todo.title : null,
      requirements: Array.isArray(todo.requirements) ? todo.requirements : [],
      acceptance: Array.isArray(todo.acceptance) ? todo.acceptance : [],
      release_blocker: todo.release_blocker === true,
      text: renderTodoPublicRecord(todo),
    };
  });
  const todoCounts = issueCounts(
    completeTodoEntities
      .filter((entry) => entry.record.status === "open")
      .map((entry) => ({ severity: String(entry.record.severity ?? "normal") })),
  );
  const todoListCounts = todoList.counts as JsonObject | undefined;
  const todoDetail: TodoDetailSummary = {
    total: Number(todoListCounts?.total ?? todoEntries.length),
    returned: Number(todoListCounts?.returned ?? todoEntries.length),
    omitted: Number(todoListCounts?.remaining ?? 0),
    retrieval: (todoList.retrieval as JsonObject | undefined) ?? {},
  };
  const docs: DocsSummary = {
    exists: docsEntries.length > 0,
    status: docsEntries.length ? "available" : "missing",
    indexed_documents: Number((docsList.counts as JsonObject | undefined)?.total ?? docsEntries.length),
    entries: docsEntries,
  };

  const reviewEntries = fullDecisionEntries.filter((entry) => {
    const satisfaction = record(entry).satisfaction as JsonObject | undefined;
    return satisfaction?.review_needed === true || satisfaction?.state === "open";
  });
  const decisionAttention: DecisionReviewAttention | null = reviewEntries.length ? {
    type: "decision_review",
    count: reviewEntries.length,
    states: {},
    entries: reviewEntries.slice(0, 3).map((entry) => ({
      id: String(entry.id), artifact: String(entry.artifact), title: String(record(entry).question ?? "Decision"), state: String((record(entry).satisfaction as JsonObject | undefined)?.state ?? "open"), source: entry.provenance ?? null,
    })),
    max_entries: 3,
    bounded: reviewEntries.length > 3,
    attention: `${reviewEntries.length} decision(s) require review`,
  } : null;
  const firstDecision = reviewEntries[0];
  const decision = firstDecision ? { object: String(firstDecision.id), title: String(record(firstDecision).question ?? "Decision review") } : null;

  const projection = bounded({
    plan, docs, progress, health, objective, todoItems, todoCounts, decision, decisionAttention,
    glossaryCaveatAttention: glossaryCaveatProjection.attention,
    glossaryCaveatAttentionPolicy: glossaryCaveatProjection.attention ? {
      public_limit: glossaryCaveatProjection.publicAttentionLimit,
      reserved_slots: glossaryCaveatProjection.reservedGlossarySlots,
    } : null,
    history: {
      progress: projectedHistory(progressList, "progress", progressFullCount, progressSummaryCount, progressHistory),
      decisions: projectedHistory(decisionList, "decisions", decisionFullCount, decisionSummaryCount, decisionHistory),
      health: projectedHistory(healthList, "health", healthFullCount, healthSummaryCount, healthHistory),
    },
  });
  // The opaque continuation cursor is already list-budget bounded and must stay
  // byte-exact so omitted TODO detail remains recoverable.
  const result = { ...projection, todoDetail, todoReadiness, todoReconciliation };
  rememberPlanTaskIndex(result.plan as unknown as JsonObject, allTaskEntries);
  return result;
}
