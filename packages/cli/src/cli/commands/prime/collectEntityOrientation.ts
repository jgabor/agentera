import type { JsonObject, JsonValue } from "../../../core/jsonValue.js";
import { listProgressEntities } from "../../../state/progressEntities.js";
import { listDecisionEntities } from "../../../state/decisionEntities.js";
import { listHealthEntities } from "../../../state/healthEntities.js";
import { listPlanEntities, listPlanTaskEntities } from "../../../state/planEntities.js";
import { listObjectiveEntities, listExperimentEntities } from "../../../state/objectiveExperimentEntities.js";
import { listTodoDocsEntities } from "../../../state/todoDocsEntities.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { discoverEntities } from "../../../state/entityStorage.js";
import { boundStartupValue, STARTUP_ARRAY_LIMIT } from "../../../state/startupProjection.js";
import { rememberPlanTaskIndex } from "../../planTaskIndex.js";
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

function selected(entries: JsonObject[], artifact: "plan" | "objective"): JsonObject | undefined {
  if (entries.length < 2) return entries[0];
  const ids = entries.map((entry) => String(entry.id)).sort().join(", ");
  const noun = artifact === "plan" ? "open plans" : "active objectives";
  const list = `agentera state ${artifact} list --format json`;
  throw new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "ambiguous",
      artifact,
      message: `multiple ${noun} require explicit selection: ${ids}`,
      syntax: `agentera state ${artifact} get --id ID --format json`,
      example: `agentera state ${artifact} get --id ${String(entries[0]?.id)} --format json`,
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
  todoItems: Array<Record<string, string>>;
  todoCounts: IssueCounts;
  todoDetail: TodoDetailSummary;
  decision: DecisionFollowUp | null;
  decisionAttention: DecisionReviewAttention | null;
  history: Record<string, StartupHistorySummary>;
}

/** Bounded startup projection built only from canonical entity readers. */
export function collectEntityOrientation(projectRoot: string, sourceRoot: string): EntityOrientationProjection {
  const discovery = discoverEntities(projectRoot, sourceRoot);
  const progressList = listProgressEntities(projectRoot, 10, {}, undefined, { sourceRoot, format: "json", discovery });
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
  const firstPending = allTaskEntries.find((entry) => !terminal(entry.status));
  const taskStatusCounts = allTaskEntries.reduce<Record<string, number>>((counts, entry) => {
    const status = String(entry.status ?? "pending").toLowerCase(); counts[status] = (counts[status] ?? 0) + 1; return counts;
  }, {});
  const publicTaskEntries = taskEntries.slice(0, STARTUP_ARRAY_LIMIT);
  const taskDetailOmitted = allTaskEntries.length > publicTaskEntries.length;
  const taskRetrieval: JsonObject = selectedPlan
    ? { list: `agentera state plan tasks list ${String(selectedPlan.id)} --limit 100 --format json`, restart: `agentera state plan tasks list ${String(selectedPlan.id)} --limit 100 --format json`, get: "agentera state plan tasks get --id ID --format json" }
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

  const latestProgress = progressEntries[0];
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
  } : { exists: false, status: "missing", cycle_count: 0 };

  const latestHealth = healthEntries[0];
  const healthRecord = record(latestHealth);
  const grades = healthRecord.grades && typeof healthRecord.grades === "object" && !Array.isArray(healthRecord.grades)
    ? healthRecord.grades as JsonObject
    : {};
  const health: HealthSummary = latestHealth ? {
    exists: true,
    id: latestHealth.id,
    artifact: latestHealth.artifact,
    date: String(healthRecord.date ?? ""),
    trajectory: String(healthRecord.trajectory ?? ""),
    grade: Object.values(grades).map(String).sort()[0] ?? "",
  } : { exists: false };

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

  const todoItems = todoEntries.map((entry) => ({
    id: String(entry.id), artifact: String(entry.artifact),
    ...Object.fromEntries(Object.entries(record(entry)).map(([key, value]) => [key, String(value)])),
    text: String(record(entry).description ?? ""),
  }));
  const todoCounts = issueCounts(
    discovery.entities
      .filter((entry) => entry.boundary === "todo_item" && entry.record?.status === "open")
      .map((entry) => ({ severity: String(entry.record?.severity ?? "normal") })),
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

  const reviewEntries = decisionEntries.filter((entry) => {
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
    history: { progress: progressList, decisions: decisionList, health: healthList },
  });
  // The opaque continuation cursor is already list-budget bounded and must stay
  // byte-exact so omitted TODO detail remains recoverable.
  const result = { ...projection, todoDetail };
  rememberPlanTaskIndex(result.plan as unknown as JsonObject, allTaskEntries);
  return result;
}
