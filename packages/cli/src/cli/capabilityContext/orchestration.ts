import { asList } from "../stateQuery.js";
import { capabilityContext } from "./contract.js";
import { entryStatus, sourceProvenance, uniqueList } from "./shared.js";
import {
  formatPlanTaskDepRef,
  indexPlanTasksByNumber,
  orchestrationTaskSummary,
  planDependsOnList,
  resolvePlanTaskByRef,
  DONE_STATUSES_ORCH,
  BLOCKED_STATUSES_ORCH,
} from "./planState.js";
import { progressVerificationSummary, retryState, evaluatorHandoff } from "./progress.js";
import type { Dict } from "./types.js";

export function orchestrationContext(
  capability: string | null,
  plan: Dict,
  progress: Dict,
  health: Dict,
  todoItems: Array<Record<string, string>>,
  docs: Dict,
  profile: Dict,
  nextAction: Dict,
): Dict | null {
  if (capability !== "orchestrate") return null;
  const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const taskByNumber = indexPlanTasksByNumber(tasks);
  const dependencyReady: Dict[] = [];
  const blocked: Dict[] = [];
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
  const stateCaveats: string[] = [];
  let fallbackCommands: string[] = [];
  const capabilityContract = capabilityContext(capability) ?? {};
  for (const family of (capabilityContract.missing_state_families ?? []) as string[]) {
    stateCaveats.push(`${family} state is not included in prime --context startup context.`);
  }
  fallbackCommands.push(...((capabilityContract.cli_fallback ?? []) as string[]));
  if (!plan.exists) {
    stateCaveats.push("plan state is unavailable; task queue cannot be complete.");
    fallbackCommands.push("agentera state plan --format json");
  }
  if (!progress.exists) {
    stateCaveats.push("progress state is unavailable; latest verification is not summarized here.");
    fallbackCommands.push("agentera state progress --format json");
  }
  if (!health.exists) {
    stateCaveats.push("health state is unavailable or incomplete.");
    fallbackCommands.push("agentera state health --format json");
  }
  if (!docs.exists) {
    stateCaveats.push("docs mapping state is unavailable or incomplete.");
    fallbackCommands.push("agentera state docs --format json");
  }
  if (todoItems.length === 0) {
    stateCaveats.push("todo state has no open entries in prime --context response; absence may mean none open or unavailable.");
    fallbackCommands.push("agentera state todo --format json");
  }
  if (profile.status !== "loaded") {
    stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  } else if (profile.stale === true) {
    stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  }
  fallbackCommands = uniqueList(fallbackCommands);
  const progressVerification = progressVerificationSummary(progress);
  const retry = retryState();
  const handoff = evaluatorHandoff(selected, progressVerification, retry, stateCaveats);
  const complete = Boolean(plan.exists) && tasks.length > 0 && stateCaveats.length === 0;
  return {
    capability: "orchestrate",
    task_queue: { total: tasks.length, dependency_ready_tasks: dependencyReady, blocked_tasks: blocked },
    selected_next_task: selected,
    selected_next_action: nextAction,
    progress_verification: progressVerification,
    retry_state: retry,
    evaluator_handoff: handoff,
    task_summaries: tasks.map((task) => orchestrationTaskSummary(task)),
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_orchestration_context: complete,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this orchestration_context and included hej state first. Run listed routine CLI fallback commands " +
        "for missing or incomplete state families; raw artifact reads are last-resort diagnostics, not normal startup behavior.",
      included_state_families: capabilityContract.included_state_families ?? [],
      missing_state_families: capabilityContract.missing_state_families ?? [],
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: [
        "dependency-ready task queue",
        "blocked task reasons",
        "selected next task",
        "task acceptance summaries",
        "task evidence summaries",
        "latest progress verification summary",
        "retry_state provenance",
        "evaluator handoff inputs",
        "state-family caveats",
      ],
      deferred: [],
    },
  };
}
