import { publicDoctorStatus } from "../../upgrade/doctor.js";
import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import { asList } from "../stateQuery.js";
import { capabilityContext } from "./contract.js";
import { bespokeCapabilityContexts, slimBespokeContext } from "./bespoke.js";
import {
  capabilityContextAppSummary,
  capabilityContextProfileSummary,
  docsConventions,
  entryStatus,
  fallbackStatePointer,
  hasRecordedValue,
  sourceProvenance,
  taskRef,
} from "./shared.js";
import type { Dict } from "./types.js";

export function slimPlanState(plan: Dict): Dict {
  const firstPending = plan.first_pending;
  return {
    exists: Boolean(plan.exists),
    status: plan.status ?? null,
    title: plan.title ?? null,
    complete: plan.complete ?? null,
    total: plan.total ?? null,
    first_pending: firstPending && typeof firstPending === "object" && !Array.isArray(firstPending) ? taskRef(firstPending) : null,
    source_provenance: sourceProvenance("plan", "agentera plan --format json"),
  };
}

export function slimDocsState(docs: Dict): Dict {
  const conventions = docsConventions(docs);
  return {
    exists: Boolean(docs.exists),
    status: docs.status ?? null,
    mapping_entries: docs.mapping_entries ?? asList(docs.mapping).length,
    version_policy: {
      version_files: asList(conventions.version_files),
      semver_policy: conventions.semver_policy && typeof conventions.semver_policy === "object" && !Array.isArray(conventions.semver_policy) ? conventions.semver_policy : {},
    },
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary"),
  };
}

export function slimProgressState(progress: Dict): Dict {
  const latest = progress.latest && typeof progress.latest === "object" && !Array.isArray(progress.latest) ? progress.latest : {};
  const latestCycle: Dict = {};
  for (const key of ["number", "timestamp", "type", "phase"]) {
    if (latest[key] !== null && latest[key] !== undefined && latest[key] !== "") latestCycle[key] = latest[key];
  }
  return {
    exists: Boolean(progress.exists),
    status: progress.status ?? null,
    latest_cycle: latestCycle,
    verified_present: hasRecordedValue(latest.verified),
    source_provenance: sourceProvenance("progress", "agentera progress --format json"),
  };
}

export function slimHealthState(health: Dict): Dict {
  return {
    exists: Boolean(health.exists),
    number: health.number ?? null,
    grade: health.grade ?? null,
    trajectory: health.trajectory ?? null,
    worst: health.worst ?? null,
    degrading: Boolean(health.degrading),
    source_provenance: sourceProvenance("health", "agentera health --format json"),
  };
}

export function slimTodoState(todoItems: Array<Record<string, string>>): Dict {
  const severityCounts: Record<string, number> = {};
  for (const item of todoItems) {
    const severity = String(item.severity ?? "normal");
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
  }
  return {
    open_count: todoItems.length,
    severity_counts: severityCounts,
    source_provenance: sourceProvenance("todo", "agentera todo --format json"),
  };
}

export function genericSlimStartupContext(
  capability: string,
  context: Dict,
  plan: Dict,
  docs: Dict,
  progress: Dict,
  health: Dict,
  todoItems: Array<Record<string, string>>,
  profile: Dict,
): Dict {
  const decisionsPointer = fallbackStatePointer("decisions", "agentera decisions --format json");
  const docsState = slimDocsState(docs);
  const profileState = capabilityContextProfileSummary(profile);
  if (capability === "visionera") {
    return {
      vision_startup_context: {
        vision: fallbackStatePointer("vision", "agentera query vision --format json"),
        docs_mapping: docsState,
        progress: slimProgressState(progress),
        health: slimHealthState(health),
        todo: slimTodoState(todoItems),
        decisions: decisionsPointer,
        design: fallbackStatePointer("design", "agentera query design --format json"),
        profile: profileState,
      },
    };
  }
  if (capability === "resonera") {
    return {
      deliberation_context: {
        decisions: decisionsPointer,
        vision: fallbackStatePointer("vision", "agentera query vision --format json"),
        objective: fallbackStatePointer("objective", "agentera objective --format json"),
        todo: slimTodoState(todoItems),
        docs_mapping: docsState,
        profile: profileState,
        protected_write_boundaries: ["vision", "todo", "objective"],
      },
    };
  }
  if (capability === "inspirera") {
    return {
      research_context: {
        profile: profileState,
        vision: fallbackStatePointer("vision", "agentera query vision --format json"),
        write_boundaries: ["todo", "vision"],
      },
    };
  }
  if (capability === "planera") {
    return {
      planning_context: {
        startup_contract: context.startup_contract ?? null,
        plan: slimPlanState(plan),
        docs: docsState,
        health: slimHealthState(health),
        todo: slimTodoState(todoItems),
        progress: slimProgressState(progress),
        decisions: decisionsPointer,
        profile: profileState,
      },
    };
  }
  if (capability === "profilera") {
    return {
      profile_context: { profile: profileState, decisions: decisionsPointer, raw_profile_body_emitted: false },
    };
  }
  if (capability === "visualisera") {
    return {
      design_context: {
        design: fallbackStatePointer("design", "agentera query design --format json"),
        vision: fallbackStatePointer("vision", "agentera query vision --format json"),
        progress: slimProgressState(progress),
        todo: slimTodoState(todoItems),
        docs_mapping: docsState,
        profile: profileState,
      },
    };
  }
  return {};
}

export function slimCapabilityContext(
  capability: string,
  mode: string,
  appHome: Dict,
  bundle: Dict,
  profile: Dict,
  plan: Dict,
  docs: Dict,
  progress: Dict,
  health: Dict,
  todoItems: Array<Record<string, string>>,
  bespokeContexts: Dict | null,
): Dict {
  const context =
    capabilityContext(capability) ?? {
      capability,
      declared_state_needs: [],
      declared_write_targets: [],
      artifact_inventory: { read_needs: [], write_targets: [] },
      included_state_families: [],
      missing_state_families: [],
      cli_fallback: [],
      raw_artifact_read_policy:
        "Use the included state families from this prime --context response first. " +
        "If needed families are missing or CLI state is incomplete, run the CLI fallback commands before raw file access.",
      schema_error: `No capability context found for ${capability}.`,
    };
  const contextPayload: Dict = { capability, schema_error: context.schema_error ?? null };
  Object.assign(contextPayload, genericSlimStartupContext(capability, context, plan, docs, progress, health, todoItems, profile));
  const firstRead = context.first_invocation_read;
  if (firstRead !== null && firstRead !== undefined) contextPayload.first_invocation_read = firstRead;
  // bespoke contexts are all null for the six non-bespoke capabilities.
  if (bespokeContexts) {
    for (const [name, value] of Object.entries(bespokeContexts)) {
      if (value !== null && value !== undefined) contextPayload[name] = slimBespokeContext(name, value as Dict);
    }
  }
  const prose = CAPABILITY_INSTRUCTIONS[capability] ?? null;
  return {
    schemaVersion: "agentera.capabilityContext.v1",
    capability,
    mode,
    app: capabilityContextAppSummary(appHome, bundle),
    profile: capabilityContextProfileSummary(profile),
    state: {
      declared_read_needs: context.declared_state_needs ?? [],
      declared_write_targets: context.declared_write_targets ?? [],
      artifact_inventory: context.artifact_inventory ?? { read_needs: [], write_targets: [] },
      included: context.included_state_families ?? [],
      missing: context.missing_state_families ?? [],
      fallback_commands: context.cli_fallback ?? [],
      schema_error: context.schema_error ?? null,
    },
    context: contextPayload,
    prose: prose ?? "",
    raw_artifact_read_policy: context.raw_artifact_read_policy ?? null,
  };
}

export function orientationAppHome(bundle: Dict): Dict {
  return {
    status: bundle.status,
    home: bundle.appHome,
    source: bundle.appHomeSource,
    managed_app_root: bundle.managedAppRoot,
    user_data_root: bundle.userDataRoot,
  };
}

export function buildPrimeCapabilityContextPayload(state: Dict, capabilityName: string, command = "prime"): Dict {
  const bundlePublic = publicDoctorStatus(state.bundle);
  const appHome = orientationAppHome(state.bundle);
  const bespoke = bespokeCapabilityContexts(capabilityName, state);
  return {
    command,
    status: "ok",
    capability_context: slimCapabilityContext(
      capabilityName,
      state.mode,
      appHome,
      bundlePublic,
      state.profile_dict,
      state.plan,
      state.docs,
      state.progress,
      state.health,
      state.todo_items,
      bespoke,
    ),
  };
}
