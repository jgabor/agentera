import { publicDoctorStatus } from "../../upgrade/doctor.js";
import type { SchemaInfo } from "../appContext.js";
import { asList } from "../stateQuery.js";
import { capabilityContext } from "./contract.js";
import { entryStatus, sourceProvenance, uniqueList, hasRecordedValue, taskRef } from "./shared.js";
import {
  closeoutChangelogBoundary,
  dependencyReadyTasks,
  orchestrationTaskSummary,
  planContextField,
  buildArtifactUpdateRequirements,
  buildPlanCompletionSweep,
  buildScopeBoundary,
  selectEvidenceTarget,
  taskByRef,
} from "./planState.js";
import { progressVerificationSummary } from "./progress.js";
import type { Dict } from "./types.js";

export function buildExecutionContext(
  capability: string | null,
  schemas: Record<string, SchemaInfo>,
  plan: Dict,
  progress: Dict,
  health: Dict,
  todoItems: Array<Record<string, string>>,
  docs: Dict,
  profile: Dict,
  bundle: Dict,
): Dict | null {
  if (capability !== "build") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const target = selectEvidenceTarget(plan);
  const selected = taskByRef(plan, (target && typeof target === "object" ? target.task : null) as Dict | null);
  const acceptance = selected && typeof selected === "object" ? asList(selected.acceptance) : [];
  const progressVerification = progressVerificationSummary(progress);
  const changelogBoundary = closeoutChangelogBoundary(schemas, plan);
  const sweep = buildPlanCompletionSweep(plan);

  let mode: string;
  if (plan.complete_plan) mode = "completed_plan_sweep";
  else if (!plan.exists || tasks.length === 0) mode = "no_plan";
  else if (target.status === "selected" && selected !== null) mode = "plan_driven";
  else mode = "blocked_or_dependency_unready";

  let stateCaveats: string[] = [];
  let fallbackCommands: string[] = [];
  for (const family of (capabilityContract.missing_state_families ?? []) as string[]) {
    stateCaveats.push(`${family} state is not included in prime --context startup context.`);
  }
  fallbackCommands.push(...((capabilityContract.cli_fallback ?? []) as string[]));
  if (!plan.exists) {
    stateCaveats.push("plan state is unavailable; execution context cannot select plan-driven work.");
    fallbackCommands.push("agentera state plan --format json");
  }
  if (mode === "blocked_or_dependency_unready") {
    stateCaveats.push("No dependency-ready pending plan task is available in CLI plan state.");
    fallbackCommands.push("agentera state plan --format json");
  }
  if (mode === "plan_driven" && acceptance.length === 0) {
    stateCaveats.push("Selected Build task has no acceptance criteria in CLI plan state.");
    fallbackCommands.push("agentera state plan --format json");
  }
  if (!progress.exists) {
    stateCaveats.push("progress state is unavailable; progress logging context is incomplete.");
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
  if (changelogBoundary.status !== "available") {
    stateCaveats.push(...((changelogBoundary.caveats ?? []) as string[]));
    fallbackCommands.push("agentera state query changelog --format json");
  }
  if (profile.status !== "loaded") {
    stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  } else if (profile.stale === true) {
    stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  }
  if (bundle.status !== "up_to_date") {
    stateCaveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  }
  const scopeBoundary = buildScopeBoundary(plan, selected);
  const sourceScope =
    scopeBoundary.source_scope && typeof scopeBoundary.source_scope === "object" && !Array.isArray(scopeBoundary.source_scope)
      ? scopeBoundary.source_scope
      : {};
  if (sourceScope.status === "unspecified") {
    stateCaveats.push("source-file scope is unspecified; no allowed or prohibited source paths were inferred.");
  }
  fallbackCommands = uniqueList(fallbackCommands);
  stateCaveats = uniqueList(stateCaveats);
  const requiredState: Record<string, boolean> = {
    work_selection: mode === "plan_driven" || mode === "completed_plan_sweep",
    acceptance_criteria: mode === "completed_plan_sweep" || acceptance.length > 0,
    artifact_update_requirements: Boolean(docs.exists),
    progress_logging_requirements: progressVerification.status === "available" || ((progressVerification.caveats ?? []) as string[]).length > 0,
    changelog_boundary: changelogBoundary.status === "available",
    scope_boundary: true,
    safety_boundaries: true,
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([name]) => name);
  const caveated = stateCaveats.length > 0;
  const complete = (mode === "plan_driven" || mode === "completed_plan_sweep") && missingRequired.length === 0;
  return {
    capability: "build",
    mode,
    work_selection: {
      status: target.status,
      selection_reason: target.selection_reason,
      task: selected && typeof selected === "object" ? taskRef(selected) : null,
      source_provenance: target.source_provenance,
      caveats: target.caveats ?? [],
    },
    plan_task: selected && typeof selected === "object" ? orchestrationTaskSummary(selected) : null,
    acceptance_criteria: {
      status: acceptance.length > 0 ? "available" : "incomplete",
      items: acceptance,
      count: acceptance.length,
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.acceptance"),
    },
    constraints: {
      plan_constraints_present: hasRecordedValue(planContextField(plan, "constraints")),
      plan_constraints_summary:
        "Plan constraints are represented here as structured safety and fallback policy; " +
        "run the plan CLI fallback only if full wording is needed.",
      protected_actions: [
        "no profile refresh",
        "no installed app refresh",
        "no vision edit",
        "no objective-state edit",
        "no dispatch without explicit cycle execution",
        "no commit/push/tag/publication without explicit approval",
      ],
      unsupported_cli_command_policy: "Do not introduce capability-name or slash-alias CLI commands for Build.",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "summary.constraints"),
    },
    scope_boundary: scopeBoundary,
    verification_expectations: {
      latest_progress_verification: progressVerification,
      expected_commands: ["focused pytest targets", "Build capability validation", "self-validation", "agentera gate", "compaction check", "git diff --check"],
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.acceptance"),
    },
    artifact_update_requirements: buildArtifactUpdateRequirements(plan, docs),
    progress_logging_requirements: {
      append_cycle: true,
      verified_field_mandatory: true,
      latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
      source_provenance: sourceProvenance("progress", "agentera progress --format json"),
    },
    changelog_boundary: changelogBoundary,
    git_boundary: {
      remote_push_allowed: false,
      commit_allowed_only_with_explicit_user_request: true,
      tag_or_publication_allowed: false,
      source_provenance: sourceProvenance("execution_context", "agentera prime --context build --format json", "git_boundary"),
    },
    plan_completion_sweep: sweep,
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_execution_context: complete,
      caveated,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this execution_context and included status state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete execution state; raw artifact reads are last-resort diagnostics, not normal Build startup behavior.",
      included_state_families: capabilityContract.included_state_families ?? [],
      missing_state_families: capabilityContract.missing_state_families ?? [],
      required_execution_state: requiredState,
      missing_required_execution_state: missingRequired,
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: [
        "selected work item",
        "task details and acceptance criteria",
        "constraints and safety boundaries",
        "verification expectations",
        "artifact update requirements",
        "progress logging requirements",
        "changelog boundary",
        "scope boundary",
        "read-only plan completion sweep metadata",
        "truthful completeness metadata",
      ],
      deferred: [],
    },
  };
}
