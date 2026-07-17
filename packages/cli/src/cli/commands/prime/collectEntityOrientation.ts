import type { JsonObject } from "../../../core/jsonValue.js";
import { listProgressEntities } from "../../../state/progressEntities.js";
import { listDecisionEntities } from "../../../state/decisionEntities.js";
import { listHealthEntities } from "../../../state/healthEntities.js";
import { listPlanEntities, listPlanTaskEntities } from "../../../state/planEntities.js";
import { listObjectiveEntities, listExperimentEntities } from "../../../state/objectiveExperimentEntities.js";
import { listTodoDocsEntities } from "../../../state/todoDocsEntities.js";
import type {
  DecisionFollowUp,
  DecisionReviewAttention,
  DocsSummary,
  HealthSummary,
  ObjectiveSummary,
  PlanSummary,
  ProgressSummary,
  StartupHistorySummary,
} from "../../contracts/orientationState.js";

function entries(payload: JsonObject): JsonObject[] {
  return Array.isArray(payload.entries)
    ? payload.entries.filter((entry): entry is JsonObject => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
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

function complete(status: unknown): boolean {
  return ["complete", "completed", "closed", "done", "resolved", "retired"].includes(String(status ?? "").toLowerCase());
}

export interface EntityOrientationProjection {
  plan: PlanSummary;
  docs: DocsSummary;
  progress: ProgressSummary;
  health: HealthSummary;
  objective: ObjectiveSummary;
  todoItems: Array<Record<string, string>>;
  decision: DecisionFollowUp | null;
  decisionAttention: DecisionReviewAttention | null;
  history: Record<string, StartupHistorySummary>;
}

/** Bounded startup projection built only from canonical entity readers. */
export function collectEntityOrientation(projectRoot: string, sourceRoot: string): EntityOrientationProjection {
  const progressList = listProgressEntities(projectRoot, 10, {}, undefined, { sourceRoot, format: "json" });
  const decisionList = listDecisionEntities(projectRoot, 10, undefined, undefined, { sourceRoot, format: "json" });
  const healthList = listHealthEntities(projectRoot, 10, undefined, undefined, { sourceRoot, format: "json" });
  const planList = listPlanEntities(projectRoot, 20, undefined, { sourceRoot, format: "json" });
  const objectiveList = listObjectiveEntities(projectRoot, 20, undefined, { sourceRoot, format: "json" });
  const todoList = listTodoDocsEntities(projectRoot, "todo", 20, undefined, {}, { sourceRoot, format: "json" });
  const docsList = listTodoDocsEntities(projectRoot, "docs", 20, undefined, {}, { sourceRoot, format: "json" });

  const progressEntries = entries(progressList);
  const healthEntries = entries(healthList);
  const decisionEntries = entries(decisionList);
  const planEntries = entries(planList);
  const objectiveEntries = entries(objectiveList);
  const todoEntries = entries(todoList);
  const docsEntries = entries(docsList);

  const openPlans = planEntries.filter((entry) => !complete(header(entry).status));
  const selectedPlan = openPlans[0];
  const taskEntries = (selectedPlan
    ? entries(listPlanTaskEntities(projectRoot, String(selectedPlan.id), 100, undefined, { sourceRoot, format: "json" }))
    : []).map((entry): JsonObject => ({ ...record(entry), id: entry.id, artifact: entry.artifact, provenance: entry.provenance }));
  const firstPending = taskEntries.find((entry) => !complete(entry.status));
  const plan: PlanSummary = selectedPlan ? {
    exists: true,
    active: true,
    id: selectedPlan.id,
    artifact: selectedPlan.artifact,
    status: String(header(selectedPlan).status ?? "open"),
    title: String(header(selectedPlan).title ?? ""),
    tasks: taskEntries,
    complete: taskEntries.filter((entry) => complete(entry.status)).length,
    total: taskEntries.length,
    complete_plan: taskEntries.length > 0 && taskEntries.every((entry) => complete(entry.status)),
    first_pending: firstPending ?? null,
    diagnostics: openPlans.length > 1 ? [{ class: "multiple_open_plans", count: openPlans.length }] : [],
  } : { exists: false, active: false, status: "missing", tasks: [], complete: 0, total: 0, complete_plan: false, first_pending: null };

  const latestProgress = progressEntries[0];
  const progress: ProgressSummary = latestProgress ? {
    exists: true,
    status: "available",
    latest: latestProgress,
    latest_verification: record(latestProgress).verified ?? null,
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

  const activeObjectives = objectiveEntries.filter((entry) => !complete(header(entry).status));
  const activeObjective = activeObjectives[0];
  const objectiveRecord = record(activeObjective);
  const objective: ObjectiveSummary = activeObjective ? {
    exists: true,
    active: true,
    id: activeObjective.id,
    artifact: activeObjective.artifact,
    title: String(header(activeObjective).title ?? ""),
    status: String(header(activeObjective).status ?? "open"),
    metric: String((objectiveRecord.metric as JsonObject | undefined)?.description ?? ""),
    experiments: entries(listExperimentEntities(projectRoot, String(activeObjective.id), 20, undefined, { sourceRoot, format: "json" })),
    closed_count: objectiveEntries.filter((entry) => complete(header(entry).status)).length,
  } : { exists: objectiveEntries.length > 0, active: false, closed_count: objectiveEntries.filter((entry) => complete(header(entry).status)).length };

  const todoItems = todoEntries.map((entry) => ({
    id: String(entry.id), artifact: String(entry.artifact),
    ...Object.fromEntries(Object.entries(record(entry)).map(([key, value]) => [key, String(value)])),
    text: String(record(entry).description ?? ""),
  }));
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

  return {
    plan, docs, progress, health, objective, todoItems, decision, decisionAttention,
    history: { progress: progressList, decisions: decisionList, health: healthList },
  };
}
