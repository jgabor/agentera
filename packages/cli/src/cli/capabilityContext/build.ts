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
import { STATE_FAMILY_FALLBACK_COMMANDS, STATE_FAMILY_LIST_COMMANDS } from "./types.js";
import { planLifecycleState } from "../planLifecycleState.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { discoverProjectVerification } from "./projectVerification.js";
import type { BuildExecutionRequest } from "../commands/prime/buildExecutionRequest.js";
import { deferredStartupFamilies } from "./startupAggregation.js";
import { preCutoverCommand } from "../preCutoverCommand.js";
import { progressWritePolicy } from "../../state/progressWritePolicy.js";

const TRANSIENT_BUILD_INPUT_COMMAND = preCutoverCommand("prime --context build --input <file|-> --format json");
const TRANSIENT_BUILD_STDIN_COMMAND = preCutoverCommand("prime --context build --input - --format json");

function transientSourceProvenance(request: BuildExecutionRequest, field: string): JsonObject {
  return {
    source_family: "transient_build_execution_request",
    command: TRANSIENT_BUILD_INPUT_COMMAND,
    field,
    schema_version: request.schema_version,
    source_kind: request.source.kind,
    persisted: false,
  };
}

export function buildExecutionContext(
  capability: string | null,
  schemas: Record<string, SchemaInfo>,
  plan: JsonObject,
  progress: JsonObject,
  health: JsonObject,
  todoItems: JsonObject[],
  docs: JsonObject,
  profile: JsonObject,
  bundle: JsonObject,
  projectRoot: string,
  buildRequest: BuildExecutionRequest | null = null,
): JsonObject | null {
  if (capability !== "build") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const lifecycle = planLifecycleState(plan);
  const tasks =
    lifecycle.current_plan_degraded === true
      ? []
      : asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const target = selectEvidenceTarget(plan);
  const selected = taskByRef(plan, (target && typeof target === "object" ? target.task : null) as JsonObject | null);
  const acceptance = buildRequest?.acceptance
    ?? (selected && typeof selected === "object" ? asList(selected.acceptance) : []);
  const progressVerification = progressVerificationSummary(progress);
  const changelogBoundary = closeoutChangelogBoundary(projectRoot, plan);
  const sweep = buildPlanCompletionSweep(plan);
  const archiveOnly = Boolean(plan.exists) && plan.active === false;

  let mode: string;
  if (plan.active === true && plan.complete_plan) mode = "completed_plan_sweep";
  else if (buildRequest !== null && plan.active !== true) mode = "no_plan";
  else if (archiveOnly) mode = "archive_only_history";
  else if (!plan.exists || tasks.length === 0) mode = "no_plan";
  else if (target.status === "selected" && selected !== null) mode = "plan_driven";
  else mode = "blocked_or_dependency_unready";

  let stateCaveats: string[] = [];
  let fallbackCommands: string[] = [];
  for (const family of deferredStartupFamilies(capabilityContract)) {
    stateCaveats.push(`${family} detail is deferred from prime --context startup.`);
  }
  if (lifecycle.status === "degraded") {
    stateCaveats.push(...((lifecycle.caveats ?? []) as string[]));
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  }
  if (mode === "blocked_or_dependency_unready") {
    stateCaveats.push("No dependency-ready pending plan task is available in CLI plan state.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  }
  if (mode === "plan_driven" && acceptance.length === 0) {
    stateCaveats.push("Selected Build task has no acceptance criteria in CLI plan state.");
    fallbackCommands.push(STATE_FAMILY_FALLBACK_COMMANDS.plan);
  }
  if (!progress.exists) {
    stateCaveats.push("progress state is unavailable; progress logging context is incomplete.");
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
  if (changelogBoundary.status !== "available") {
    stateCaveats.push(...((changelogBoundary.caveats ?? []) as string[]));
    fallbackCommands.push(preCutoverCommand("state query changelog --format json"));
  }
  if (profile.status !== "valid") {
    stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  } else if (profile.stale === true) {
    stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  }
  if (bundle.status !== "up_to_date") {
    stateCaveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  }
  const scopeBoundary = buildRequest === null
    ? buildScopeBoundary(plan, selected)
    : {
        artifact_families: ["progress", "todo", "docs", "health", "changelog", "decisions", "vision", "profile", "design"],
        explicit_scope: buildRequest.scope,
        source_scope: {
          status: "unspecified",
          explicit_paths: [],
          policy: "The transient scope defines work intent only; no source-file allowlist or exclusion is inferred from its text.",
        },
        source_provenance: transientSourceProvenance(buildRequest, "scope"),
      };
  const sourceScope =
    scopeBoundary.source_scope && typeof scopeBoundary.source_scope === "object" && !Array.isArray(scopeBoundary.source_scope)
      ? scopeBoundary.source_scope
      : {};
  if (sourceScope.status === "unspecified") {
    stateCaveats.push("source-file scope is unspecified; no allowed or prohibited source paths were inferred.");
  }
  const noCurrentPlan = plan.active !== true && lifecycle.status !== "degraded";
  if (noCurrentPlan) {
    fallbackCommands = fallbackCommands.filter((command) => command !== STATE_FAMILY_FALLBACK_COMMANDS.plan);
    if (buildRequest === null) {
      stateCaveats.push("Explicit no-plan scope and acceptance are required before Build can execute without a current plan.");
      fallbackCommands.push(TRANSIENT_BUILD_STDIN_COMMAND);
    }
  }
  fallbackCommands = uniqueList(fallbackCommands);
  stateCaveats = uniqueList(stateCaveats);
  const requiredState: Record<string, boolean> = {
    work_selection: mode === "plan_driven" || mode === "completed_plan_sweep" || buildRequest !== null,
    acceptance_criteria: mode === "completed_plan_sweep" || acceptance.length > 0,
    artifact_update_requirements: Boolean(docs.exists),
    progress_logging_requirements: progressVerification.status === "available" || ((progressVerification.caveats ?? []) as string[]).length > 0,
    changelog_boundary: changelogBoundary.status === "available",
    scope_boundary: true,
    safety_boundaries: true,
    plan_state_healthy: lifecycle.status !== "degraded",
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([name]) => name);
  const caveated = stateCaveats.length > 0;
  const complete = (mode === "plan_driven" || mode === "completed_plan_sweep" || buildRequest !== null)
    && missingRequired.length === 0;
  const workSelection: JsonObject = buildRequest === null
    ? {
        status: target.status,
        selection_reason: target.selection_reason,
        task: selected && typeof selected === "object" ? taskRef(selected) : null,
        source_provenance: target.source_provenance,
        caveats: target.caveats ?? [],
      }
    : {
        status: "selected",
        selection_reason: "explicit_no_plan_scope",
        task: null,
        scope: buildRequest.scope,
        source_provenance: transientSourceProvenance(buildRequest, "scope"),
        caveats: [],
      };
  const artifactUpdateRequirements = buildArtifactUpdateRequirements(plan, docs);
  if (buildRequest !== null) {
    artifactUpdateRequirements.required_families = ["todo", "changelog"];
    artifactUpdateRequirements.conditional_families = ["progress"];
    artifactUpdateRequirements.plan_status_update_required = false;
    artifactUpdateRequirements.policy = "Transient no-plan work does not create, mutate, or require plan state.";
  }
  const progressRequirement = archiveOnly
    ? "none"
    : mode === "completed_plan_sweep"
      ? "required"
      : "conditional";
  return {
    capability: "build",
    mode,
    work_selection: workSelection,
    plan_task: selected && typeof selected === "object" ? orchestrationTaskSummary(selected) : null,
    acceptance_criteria: {
      status: acceptance.length > 0 ? "available" : "incomplete",
      items: acceptance,
      count: acceptance.length,
      source_provenance: buildRequest === null
        ? sourceProvenance("plan", STATE_FAMILY_FALLBACK_COMMANDS.plan, "entries.acceptance")
        : transientSourceProvenance(buildRequest, "acceptance"),
    },
    constraints: {
      plan_constraints_present: buildRequest === null && hasRecordedValue(planContextField(plan, "constraints")),
      plan_constraints_summary: buildRequest === null
        ? "Plan constraints are represented here as structured safety and fallback policy; run the plan CLI fallback only if full wording is needed."
        : "Transient no-plan input supplies scope and acceptance only; no plan constraints are inferred.",
      protected_actions: [
        "no profile refresh",
        "no installed app refresh",
        "no vision edit",
        "no objective-state edit",
        "no dispatch without explicit cycle execution",
        "no commit/push/tag/publication without explicit approval",
      ],
      unsupported_cli_command_policy: "Do not introduce capability-name or slash-alias CLI commands for Build.",
      source_provenance: buildRequest === null
        ? sourceProvenance("plan", STATE_FAMILY_FALLBACK_COMMANDS.plan, "summary.constraints")
        : transientSourceProvenance(buildRequest, "scope"),
    },
    scope_boundary: scopeBoundary,
    verification_expectations: {
      latest_progress_verification: progressVerification,
      ...discoverProjectVerification(projectRoot),
    },
    artifact_update_requirements: artifactUpdateRequirements,
    progress_logging_requirements: {
      requirement: progressRequirement,
      verified_field_mandatory_when_appended: true,
      policy: progressWritePolicy(),
      guidance_command: preCutoverCommand("state progress explain --verb append --format json"),
      latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
      source_provenance: sourceProvenance("progress", STATE_FAMILY_LIST_COMMANDS.progress),
    },
    changelog_boundary: changelogBoundary,
    git_boundary: {
      remote_push_allowed: false,
      commit_allowed_only_with_explicit_user_request: true,
      tag_or_publication_allowed: false,
      source_provenance: sourceProvenance("execution_context", preCutoverCommand("prime --context build --format json"), "git_boundary"),
    },
    plan_completion_sweep: sweep,
    plan_lifecycle_state: lifecycle,
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_execution_context: complete,
      caveated,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this execution_context and included status state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete execution state; raw artifact reads are last-resort diagnostics, not normal Build startup behavior.",
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
        "plan lifecycle state",
      ],
      deferred: [],
    },
  };
}
