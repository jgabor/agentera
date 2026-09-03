import { capabilityContext } from "./contract.js";
import { entryStatus, sourceProvenance, uniqueList } from "./shared.js";
import { formatPlanTaskDepRef, indexPlanTasksByNumber, orchestrationTaskSummary, planDependsOnList, resolvePlanTaskByRef, DONE_STATUSES_ORCH, BLOCKED_STATUSES_ORCH } from "./planState.js";
import { progressVerificationSummary, retryState, evaluatorHandoff } from "./progress.js";
import { STATE_FAMILY_FALLBACK_COMMANDS } from "./types.js";
import { planLifecycleState } from "../planLifecycleState.js";
import { planTaskIndex } from "../planTaskIndex.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { entityListFamily } from "../../state/entityRetrievalHelp.js";
import { deferredStartupFamilies } from "./startupAggregation.js";
import { preCutoverCommand, preCutoverCommandFromBare } from "../preCutoverCommand.js";

export function orchestrationContext(capability: string | null, plan: JsonObject, progress: JsonObject, health: JsonObject, todoItems: JsonObject[], docs: JsonObject, profile: JsonObject, nextAction: JsonObject): JsonObject | null {
  if (capability !== "orchestrate") return null;
  const lifecycle = planLifecycleState(plan);
  const tasks = lifecycle.current_plan_degraded === true ? [] : planTaskIndex(plan);
  const taskByNumber = indexPlanTasksByNumber(tasks);
  const dependencyReady: JsonObject[] = [];
  const blocked: JsonObject[] = [];
  const complete = tasks.filter((task) => entryStatus(task, "pending") === "complete").length;
  const superseded = tasks.filter((task) => entryStatus(task, "pending") === "superseded").length;
  const statusCounts = tasks.reduce<Record<string, number>>((counts, task) => {
    const status = entryStatus(task, "pending");
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  for (const task of tasks) {
    const status = entryStatus(task, "pending");
    if (DONE_STATUSES_ORCH.has(status)) continue;
    const reasons: string[] = [];
    if (BLOCKED_STATUSES_ORCH.has(status)) reasons.push(`task status is ${status}`);
    for (const dep of planDependsOnList(task)) {
      const dependency = resolvePlanTaskByRef(taskByNumber, dep);
      if (dependency === undefined) reasons.push(`dependency ${formatPlanTaskDepRef(dep)} is not present in plan tasks`);
      else if (!DONE_STATUSES_ORCH.has(entryStatus(dependency, "pending"))) {
        reasons.push(`dependency ${formatPlanTaskDepRef(dep)} is ${entryStatus(dependency, "pending")}`);
      }
    }
    if (reasons.length > 0) blocked.push({ ...orchestrationTaskSummary(task), blocked_reasons: reasons });
    else dependencyReady.push(orchestrationTaskSummary(task));
  }
  const selected = dependencyReady.length > 0 ? dependencyReady[0] : null;
  const planTasks = entityListFamily("plan_tasks");
  const queueCommand = plan.id ? preCutoverCommand(`state ${planTasks.commandTokens.join(" ")} list ${String(plan.id)} --limit 100`) : null;
  const queueRetrieval = queueCommand ? { list: queueCommand, restart: queueCommand, get: preCutoverCommandFromBare(planTasks.get) } : null;
  const stateCaveats: string[] = [];
  let fallbackCommands: string[] = [];
  const capabilityContract = capabilityContext(capability) ?? {};
  for (const family of deferredStartupFamilies(capabilityContract)) {
    stateCaveats.push(`${family} detail is deferred from prime --context startup.`);
  }
  if (!plan.exists) {
    stateCaveats.push("plan state is unavailable; task queue cannot be complete.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  }
  if (lifecycle.status === "degraded") {
    stateCaveats.push(...((lifecycle.caveats ?? []) as string[]));
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  }
  if (!progress.exists) {
    stateCaveats.push("progress state is unavailable; latest verification is not summarized here.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.progress);
  }
  if (!health.exists) {
    stateCaveats.push("health state is unavailable or incomplete.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.health);
  }
  if (!docs.exists) {
    stateCaveats.push("docs mapping state is unavailable or incomplete.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.docs);
  }
  if (todoItems.length === 0) {
    stateCaveats.push("todo state has no open entries in prime --context response; absence may mean none open or unavailable.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.todo);
  }
  if (profile.status !== "valid") {
    stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  } else if (profile.stale === true) {
    stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  }
  fallbackCommands = uniqueList(fallbackCommands);
  const progressVerification = progressVerificationSummary(progress);
  const retry = retryState(selected, tasks);
  const handoff = evaluatorHandoff(selected, progressVerification, retry, stateCaveats);
  const contextComplete = Boolean(plan.exists) && tasks.length > 0 && stateCaveats.length === 0 && (dependencyReady.length + blocked.length === 0 || queueRetrieval !== null);
  return {
    capability: "orchestrate",
    task_queue: {
      total: tasks.length,
      complete,
      superseded,
      status_counts: statusCounts,
      dependency_ready_tasks: dependencyReady,
      blocked_tasks: blocked,
      retrieval: queueRetrieval,
    },
    selected_next_task: selected,
    selected_next_action: nextAction,
    progress_verification: progressVerification,
    retry_state: retry,
    plan_lifecycle_state: lifecycle,
    evaluator_handoff: handoff,
    task_summaries: tasks.map((task) => orchestrationTaskSummary(task)),
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_orchestration_context: contextComplete,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy: "Use this orchestration_context and included status state first. Run listed routine CLI fallback commands " + "for missing or incomplete state families; raw artifact reads are last-resort diagnostics, not normal startup behavior.",
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: ["dependency-ready task queue", "blocked task reasons", "selected next task", "task acceptance summaries", "task evidence summaries", "latest progress verification summary", "retry_state provenance", "evaluator handoff inputs", "state-family caveats", "plan lifecycle state"],
      deferred: [],
    },
  };
}
