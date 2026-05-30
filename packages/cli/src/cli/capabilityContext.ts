import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { publicDoctorStatus } from "../upgrade/doctor.js";
import { activeAppModel, discoverSchemasDir } from "./appContext.js";
import { asList, firstPresent } from "./stateQuery.js";

/**
 * prime --context capability-startup context. Faithful port of
 * scripts/agentera _capability_context / _slim_capability_context /
 * _generic_slim_startup_context and the slim state helpers. The five bespoke
 * capability contexts (orkestrera/dokumentera/inspektera/optimera/realisera)
 * are pending; this module covers the six non-bespoke capabilities.
 */

type Dict = Record<string, any>;

export const CAPABILITY_NAMES = [
  "hej", "visionera", "resonera", "inspirera", "planera", "realisera",
  "optimera", "inspektera", "dokumentera", "profilera", "visualisera", "orkestrera",
];
export const BESPOKE_CONTEXT_CAPABILITIES = new Set([
  "orkestrera", "dokumentera", "inspektera", "optimera", "realisera",
]);

const STATE_FAMILY_FALLBACK_COMMANDS: Record<string, string> = {
  plan: "agentera plan --format json",
  docs: "agentera docs --format json",
  progress: "agentera progress --format json",
  health: "agentera health --format json",
  todo: "agentera todo --format json",
  decisions: "agentera decisions --format json",
  changelog: "agentera query changelog --format json",
  objective: "agentera objective --format json",
  experiments: "agentera experiments --format json",
};
const STARTUP_ENVELOPE_STATE_FAMILIES = new Set([
  "plan", "docs", "progress", "health", "todo", "objective", "benchmark_context",
]);

const PLANERA_STARTUP_CONTRACT_VERSION = "agentera.planeraStartup.v1";
const PLANERA_PLANNING_LEVELS = ["skip", "light", "full"];
const PLANERA_STEP_VERBS = ["orient", "specify", "review", "audit", "write", "handoff"];
const PLANERA_INSTRUCTIONS_AUTHORITY_EXCEPTIONS = [
  "editing Planera behavior or instructions",
  "resolving contradiction or ambiguity in compact context",
  "validating detailed behavior not covered by compact context",
  "investigating benchmark or read-trigger evidence",
];
const PLANERA_RAW_PLAN_ACCESS_ALLOWED_FOR = [
  "writing a new plan",
  "archiving a completed plan",
  "artifact validation",
  "corruption diagnostics",
  "unavailable or incomplete CLI state after CLI fallbacks",
];
const PLANERA_COMPLETED_PLAN_ARCHIVE_CONFIRMATION = {
  direct_planera_invocation:
    "Archiving an already completed existing plan before writing its replacement is implicit " +
    "in the direct Planera invocation and does not require a separate pre-write confirmation.",
  human_initiated_plan_write: "Plan approval is still required before writing a human-initiated replacement plan.",
  active_or_incomplete_plan:
    "Replacing, discarding, or archiving an active or incomplete plan is not implicit; " +
    "ask for explicit confirmation before the write.",
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function entryStatus(entry: Dict, def = "open"): string {
  const raw = "status" in entry ? entry.status : def;
  return String(raw || def).toLowerCase();
}

function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

export function validatePrimeCapability(capability: string): void {
  if (!CAPABILITY_NAMES.includes(capability)) {
    const valid = CAPABILITY_NAMES.join(", ");
    throw new Error(
      `unsupported capability ${pyRepr(capability)}; valid capabilities: ${valid}. ` +
        "Example: agentera prime --context planera --format json",
    );
  }
}

// ── instruction contract ────────────────────────────────────────────

function capabilityInstructionContractPath(): string {
  const model = activeAppModel();
  const active = path.join(String((model as Dict).authoritativeRoot ?? model.activeBundleRoot), "references", "cli", "capability-instruction-contract.yaml");
  if (isFile(active)) return active;
  return path.join(path.resolve(discoverSchemasDir(), "..", "..", "..", ".."), "references", "cli", "capability-instruction-contract.yaml");
}

function capabilityInstructionContract(): Dict {
  const p = capabilityInstructionContractPath();
  if (!isFile(p)) return {};
  try {
    return loadYamlMapping(fs.readFileSync(p, "utf8")) as Dict;
  } catch (exc) {
    process.stderr.write(`warning: failed to load capability instruction contract: ${(exc as Error).message}\n`);
    return {};
  }
}

function capabilityInstructionTarget(capability: string): Dict {
  const skillRoot = String(activeAppModel().skillRoot);
  const rel = `skills/agentera/capabilities/${capability}/instructions.md`;
  const installedTarget = path.join(skillRoot, "capabilities", capability, "instructions.md");
  return { path: rel, exists: isFile(installedTarget), runtime_path: installedTarget };
}

function firstInvocationReadMetadata(capability: string): Dict {
  const authority = capabilityInstructionContract();
  const firstRead = authority.first_invocation_read && typeof authority.first_invocation_read === "object" ? authority.first_invocation_read : {};
  const allowedValues = firstRead.allowed_values && typeof firstRead.allowed_values === "object" ? firstRead.allowed_values : {};
  const value = capability === "planera" ? "compact_startup" : "full";
  const valueContract = (allowedValues[value] ?? {}) as Dict;
  const fullContract = (allowedValues.full ?? {}) as Dict;
  return {
    field: "first_invocation_read",
    value,
    allowed_values: Object.keys(allowedValues),
    default_rule: firstRead.default_rule ?? firstRead.default_future_rule ?? null,
    instruction_target: capabilityInstructionTarget(capability),
    obligation_summary: valueContract.obligation ?? fullContract.obligation ?? null,
    meaning: valueContract.meaning ?? null,
    runtime_enforcement: false,
    provenance: {
      authority_path: "references/cli/capability-instruction-contract.yaml",
      authority_status: authority.status ?? null,
      decision: authority.decision ?? null,
      source_field: "first_invocation_read.allowed_values",
    },
  };
}

function planeraStartupContract(): Dict {
  return {
    schemaVersion: PLANERA_STARTUP_CONTRACT_VERSION,
    status: "implemented_compact_normal_startup_contract",
    canonical_surface: "agentera prime --context planera --format json",
    bounded: true,
    instructions_runtime_read_required: false,
    instructions_authority: {
      normal_startup:
        "Use this compact context for normal Planera execution startup before reading " +
        "skills/agentera/capabilities/planera/instructions.md.",
      read_planera_instructions_when: PLANERA_INSTRUCTIONS_AUTHORITY_EXCEPTIONS,
    },
    planning: {
      levels: PLANERA_PLANNING_LEVELS,
      step_marker_format: "── step N/6: verb",
      required_steps: PLANERA_STEP_VERBS,
      full_plan_review_required: true,
      pre_write_self_audit_required: true,
      max_full_plan_tasks: 8,
    },
    cli_first_orientation: {
      use_startup_state_first: true,
      current_plan_command: "agentera plan --format json",
      complete_plan_contract_key: "source_contract.complete_for_plan_artifact",
      fallback_policy:
        "Use CLI-provided fallback commands for missing or incomplete state families " +
        "before any last-resort raw artifact read.",
    },
    artifact_access_boundaries: {
      skip_raw_plan_artifact_when:
        "`agentera plan --format json` reports source_contract.complete_for_plan_artifact=true " +
        "during normal read-only startup or evaluation.",
      raw_plan_artifact_allowed_for: PLANERA_RAW_PLAN_ACCESS_ALLOWED_FOR,
      completed_plan_archive_confirmation: PLANERA_COMPLETED_PLAN_ARCHIVE_CONFIRMATION,
      artifact_mapping_source: "agentera docs/query artifact mapping before writes or closeout",
    },
    handoff_expectations: [
      "skip level suggests ⧉ realisera and waits for confirmation unless the user already asked to implement now",
      "single-task plans suggest ⧉ realisera and wait for confirmation",
      "full plans suggest ⎈ orkestrera and wait for confirmation",
    ],
    unsupported_command_boundary: {
      capability_cli_commands_added: true,
      forbidden_examples: [],
      route_boundary:
        "Use `/agentera plan` for routing, `agentera plan` for plan state, " +
        "and `agentera planera` for capability routing guidance only.",
    },
    seam_decision: {
      selected: "prime --context",
      not_changed: [
        { surface: "agentera schema --format json", reason: "runtime/schema command discovery, not capability workflow startup context" },
        { surface: "dispatcher guidance", reason: "route and CLI-state separation guidance, not a bounded Planera workflow payload" },
      ],
    },
  };
}

// ── artifact inventory + capability context ─────────────────────────

function appendUnique(items: string[], value: string): void {
  if (value && !items.includes(value)) items.push(value);
}

function capabilityArtifactInventory(capability: string): [Dict, string | null] {
  const inventory: Dict = { read_needs: [], write_targets: [] };
  const capabilityDir = path.join(String(activeAppModel().skillRoot), "capabilities", capability);
  const p = path.join(capabilityDir, "schemas", "artifacts.yaml");
  if (!isFile(p)) return [inventory, `No capability artifact schema found for ${capability}.`];
  let data: Dict;
  try {
    data = loadYamlMapping(fs.readFileSync(p, "utf8")) as Dict;
  } catch (exc) {
    return [inventory, `Capability artifact schema for ${capability} could not be read: ${(exc as Error).message}`];
  }
  const artifacts = data.ARTIFACTS;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    return [inventory, `Capability artifact schema for ${capability} has no ARTIFACTS mapping.`];
  }
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(artifacts as Dict)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`entry ${key} is not a mapping`);
      continue;
    }
    const e = entry as Dict;
    const artifactId = String(e.artifact_id ?? "").trim();
    const localRole = String(e.local_role ?? "").trim();
    if (!artifactId) {
      errors.push(`entry ${key} is missing artifact_id`);
      continue;
    }
    if (localRole === "consumes") appendUnique(inventory.read_needs, artifactId);
    else if (localRole === "produces") appendUnique(inventory.write_targets, artifactId);
    else if (localRole === "produces_and_consumes") {
      appendUnique(inventory.read_needs, artifactId);
      appendUnique(inventory.write_targets, artifactId);
    } else errors.push(`entry ${key} has unsupported local_role ${pyRepr(localRole)}`);
  }
  const error = errors.length > 0 ? `Capability artifact schema for ${capability} has invalid ARTIFACTS entries: ${errors.join("; ")}.` : null;
  return [inventory, error];
}

function capabilityContext(capability: string | null): Dict | null {
  if (!capability) return null;
  const [inventory, error] = capabilityArtifactInventory(capability);
  const needs = inventory.read_needs as string[];
  const writeTargets = inventory.write_targets as string[];
  const missing = needs.filter((name) => !STARTUP_ENVELOPE_STATE_FAMILIES.has(name));
  const cliFallback = missing.filter((name) => name in STATE_FAMILY_FALLBACK_COMMANDS).map((name) => STATE_FAMILY_FALLBACK_COMMANDS[name]);
  const context: Dict = {
    capability,
    first_invocation_read: firstInvocationReadMetadata(capability),
    declared_state_needs: needs,
    declared_write_targets: writeTargets,
    artifact_inventory: inventory,
    included_state_families: needs.filter((name) => STARTUP_ENVELOPE_STATE_FAMILIES.has(name)),
    missing_state_families: missing,
    cli_fallback: cliFallback,
    raw_artifact_read_policy:
      "Use the included state families from this prime --context response first. " +
      "If needed families are missing or CLI state is incomplete, run the CLI fallback commands before raw file access.",
    schema_error: error,
  };
  if (capability === "planera") context.startup_contract = planeraStartupContract();
  return context;
}

// ── slim state helpers ──────────────────────────────────────────────

function taskRef(task: Dict): Dict {
  return { number: task.number ?? null, name: firstPresent(task, ["name", "title"], ""), status: entryStatus(task, "pending") };
}

function sourceProvenance(sourceFamily: string, command: string, field: string | null = null): Dict {
  const provenance: Dict = { source_family: sourceFamily, command };
  if (field) provenance.field = field;
  return provenance;
}

function docsConventions(docs: Dict): Dict {
  const conventions = docs.conventions;
  return conventions && typeof conventions === "object" && !Array.isArray(conventions) ? conventions : {};
}

function hasRecordedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Dict).length > 0;
  return true;
}

function fallbackStatePointer(artifactId: string, command: string): Dict {
  return { status: "fallback_only", artifact_id: artifactId, fallback_command: command, raw_artifact_reads_required: false };
}

function capabilityContextAppSummary(appHome: Dict, bundle: Dict): Dict {
  const caveats: string[] = [];
  if (appHome.status !== "up_to_date") {
    caveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  }
  return {
    status: appHome.status,
    home: appHome.home,
    source: appHome.source,
    managed_app_root: appHome.managed_app_root,
    user_data_root: appHome.user_data_root,
    expected_version: bundle.expectedVersion,
    caveats,
  };
}

function capabilityContextProfileSummary(profile: Dict): Dict {
  const caveats: string[] = [];
  if (profile.status !== "loaded") caveats.push("profile-derived state is unavailable in prime --context response.");
  else if (profile.stale === true) caveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  const summary: Dict = {};
  for (const key of ["status", "path", "stale", "days_since_generated", "stale_threshold_days", "suggested_action"]) {
    if (key in profile) summary[key] = profile[key];
  }
  summary.caveats = caveats;
  return summary;
}

function slimPlanState(plan: Dict): Dict {
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

function slimDocsState(docs: Dict): Dict {
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

function slimProgressState(progress: Dict): Dict {
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

function slimHealthState(health: Dict): Dict {
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

function slimTodoState(todoItems: Array<Record<string, string>>): Dict {
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

function genericSlimStartupContext(
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

function slimCapabilityContext(
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
      if (value !== null && value !== undefined) contextPayload[name] = value;
    }
  }
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
    raw_artifact_read_policy: context.raw_artifact_read_policy ?? null,
  };
}

function orientationAppHome(bundle: Dict): Dict {
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
  // The five bespoke contexts are pending; all null for the six non-bespoke capabilities.
  const bespoke: Dict = {
    orchestration_context: null,
    closeout_context: null,
    evidence_context: null,
    benchmark_context: null,
    execution_context: null,
  };
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
