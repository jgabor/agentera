import { publicDoctorStatus } from "../../upgrade/doctor.js";
import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import { asList } from "../stateQuery.js";
import { capabilityContext } from "./contract.js";
import { bespokeCapabilityContexts, slimBespokeContext } from "./bespoke.js";
import { capabilityContextAppSummary, docsConventions, hasRecordedValue, taskRef } from "./shared.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { boundStartupValue } from "../../state/startupProjection.js";
import type { OrientationState } from "../contracts/orientationState.js";
import { startupAggregation } from "./startupAggregation.js";

export function slimPlanState(plan: JsonObject): JsonObject {
  const firstPending = plan.first_pending;
  const tasks = asList(plan.tasks)
    .filter((task): task is JsonObject => Boolean(task) && typeof task === "object" && !Array.isArray(task))
    .map(taskRef);
  return {
    exists: Boolean(plan.exists),
    active: Boolean(plan.active),
    complete_plan: Boolean(plan.complete_plan),
    id: plan.id ?? null,
    artifact: plan.artifact ?? "plan",
    status: plan.status ?? null,
    title: plan.title ?? null,
    complete: plan.complete ?? null,
    superseded: plan.superseded ?? null,
    total: plan.total ?? null,
    task_status_counts: plan.task_status_counts ?? {},
    task_omission: plan.task_omission ?? { omitted: false },
    tasks,
    first_pending: firstPending && typeof firstPending === "object" && !Array.isArray(firstPending) ? taskRef(firstPending) : null,
    diagnostics: asList(plan.diagnostics),
    invalid_path: plan.invalid_path ?? null,
  };
}

export function slimDocsState(docs: JsonObject): JsonObject {
  const conventions = docsConventions(docs);
  return {
    exists: Boolean(docs.exists),
    status: docs.status ?? null,
    mapping_entries: docs.mapping_entries ?? asList(docs.mapping).length,
    version_policy: {
      version_files: asList(conventions.version_files),
      semver_policy: conventions.semver_policy && typeof conventions.semver_policy === "object" && !Array.isArray(conventions.semver_policy) ? conventions.semver_policy : {},
    },
  };
}

export function slimProgressState(progress: JsonObject): JsonObject {
  const latest = progress.latest && typeof progress.latest === "object" && !Array.isArray(progress.latest) ? progress.latest : {};
  const latestRecord = latest.record && typeof latest.record === "object" && !Array.isArray(latest.record) ? latest.record as JsonObject : latest;
  const latestCycle: JsonObject = { id: latest.id ?? null, artifact: latest.artifact ?? "progress" };
  for (const key of ["timestamp", "type", "phase"]) {
    if (latestRecord[key] !== null && latestRecord[key] !== undefined && latestRecord[key] !== "") latestCycle[key] = latestRecord[key];
  }
  return {
    exists: Boolean(progress.exists),
    status: progress.status ?? null,
    latest_cycle: latestCycle,
    verified_present: hasRecordedValue(latestRecord.verified),
  };
}

export function slimHealthState(health: JsonObject): JsonObject {
  return {
    exists: Boolean(health.exists),
    id: health.id ?? null,
    artifact: health.artifact ?? "health",
    grade: health.grade ?? null,
    trajectory: health.trajectory ?? null,
    worst: health.worst ?? null,
    degrading: Boolean(health.degrading),
  };
}

export function slimTodoState(todoItems: JsonObject[]): JsonObject {
  const severityCounts: Record<string, number> = {};
  for (const item of todoItems) {
    const severity = String(item.severity ?? "normal");
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
  }
  return { open_count: todoItems.length, severity_counts: severityCounts, entries: todoItems };
}

export function genericSlimStartupContext(
  capability: string,
  context: JsonObject,
  plan: JsonObject,
  docs: JsonObject,
  progress: JsonObject,
  health: JsonObject,
  todoItems: JsonObject[],
): JsonObject {
  const docsState = slimDocsState(docs);
  if (capability === "vision") {
    return { vision_startup_context: { docs_mapping: docsState, progress: slimProgressState(progress), health: slimHealthState(health), todo: slimTodoState(todoItems) } };
  }
  if (capability === "discuss") {
    return { deliberation_context: { todo: slimTodoState(todoItems), docs_mapping: docsState, protected_write_boundaries: ["vision", "todo", "objective"] } };
  }
  if (capability === "research") return { research_context: { write_boundaries: ["todo", "vision"] } };
  if (capability === "plan") {
    return { planning_context: { startup_contract: context.startup_contract ?? null, plan: slimPlanState(plan), docs: docsState, health: slimHealthState(health), todo: slimTodoState(todoItems), progress: slimProgressState(progress) } };
  }
  if (capability === "profile") return { profile_context: { raw_profile_body_emitted: false } };
  if (capability === "design") return { design_context: { progress: slimProgressState(progress), todo: slimTodoState(todoItems), docs_mapping: docsState } };
  return {};
}

export function slimCapabilityContext(
  capability: string,
  mode: string,
  appHome: JsonObject,
  bundle: JsonObject,
  plan: JsonObject,
  docs: JsonObject,
  progress: JsonObject,
  health: JsonObject,
  todoItems: JsonObject[],
  bespokeContexts: JsonObject | null,
  cutover: JsonObject | null = null,
): JsonObject {
  const context: JsonObject = capabilityContext(capability) ?? {
    capability,
    availability: [],
    schema_error: `No capability context found for ${capability}.`,
  };
  const contextPayload: JsonObject = { capability, schema_error: context.schema_error ?? null };
  Object.assign(contextPayload, genericSlimStartupContext(capability, context, plan, docs, progress, health, todoItems));
  contextPayload.plan = slimPlanState(plan);
  const firstRead = context.first_invocation_read;
  if (firstRead !== null && firstRead !== undefined) contextPayload.first_invocation_read = firstRead;
  if (bespokeContexts) {
    for (const [name, value] of Object.entries(bespokeContexts)) {
      if (value !== null && value !== undefined) contextPayload[name] = slimBespokeContext(name, value as JsonObject);
    }
  }
  return {
    schemaVersion: "agentera.capabilityContext.v1",
    capability,
    mode,
    app: capabilityContextAppSummary(appHome, bundle),
    startup: startupAggregation(context, health, cutover),
    context: boundStartupValue(contextPayload) as JsonObject,
    instructions: CAPABILITY_INSTRUCTIONS[capability] ?? "",
  };
}

export function orientationAppHome(bundle: JsonObject): JsonObject {
  return {
    status: bundle.status,
    home: bundle.appHome,
    source: bundle.appHomeSource,
    managed_app_root: bundle.managedAppRoot,
    user_data_root: bundle.userDataRoot,
  };
}

export function buildPrimeCapabilityContextPayload(
  state: OrientationState,
  capabilityName: string,
  command = "prime",
  buildRequest: import("../commands/prime/buildExecutionRequest.js").BuildExecutionRequest | null = null,
): JsonObject {
  const stateDict = state as unknown as JsonObject;
  const bundlePublic = publicDoctorStatus(state.app);
  const appHome = orientationAppHome(stateDict.app as JsonObject);
  const bespoke = bespokeCapabilityContexts(capabilityName, stateDict, buildRequest);
  const contract = capabilityContext(capabilityName) ?? {};
  const cutover = stateDict.state_cutover as JsonObject;
  const startup = startupAggregation(contract, stateDict.health as JsonObject, cutover);
  return {
    command,
    outcome: startup.outcome,
    shared_skill: stateDict.shared_skill,
    capability_context: slimCapabilityContext(
      capabilityName,
      state.mode,
      appHome,
      bundlePublic as unknown as JsonObject,
      stateDict.plan as JsonObject,
      stateDict.docs as JsonObject,
      stateDict.progress as JsonObject,
      stateDict.health as JsonObject,
      state.todo_items,
      bespoke,
      cutover,
    ),
  };
}
