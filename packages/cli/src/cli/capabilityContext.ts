import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { publicDoctorStatus } from "../upgrade/doctor.js";
import { activeAppModel, discoverSchemasDir, SchemaInfo } from "./appContext.js";
import { artifactPath } from "./appContext.js";
import { asList, firstPresent, sourceMetadata } from "./stateQuery.js";

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
  "dokumentera", "inspektera", "optimera",
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
      if (value !== null && value !== undefined) contextPayload[name] = slimBespokeContext(name, value as Dict);
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

// ── orchestration bespoke context (orkestrera) ──────────────────────

function orchestrationTaskSummary(task: Dict): Dict {
  const evidence = task.evidence;
  const evidenceItems = Array.isArray(evidence) ? evidence : evidence === null || evidence === undefined || evidence === "" ? [] : [evidence];
  return {
    ...taskRef(task),
    depends_on: asList(task.depends_on),
    acceptance_summary: { count: asList(task.acceptance).length, items: asList(task.acceptance) },
    evidence_summary: { count: evidenceItems.length, items: evidenceItems },
  };
}

function progressVerificationSummary(progress: Dict): Dict {
  const source = { source_family: "progress", command: "agentera progress --format json" };
  if (!progress.exists) {
    return {
      status: "unavailable",
      source_provenance: source,
      cycle: null,
      verified_present: false,
      non_empty_evidence_present: false,
      non_empty_evidence_fields: [],
      verified: null,
      verification_summary: null,
      latest_progress_verification_pointer: null,
      caveats: ["No progress cycles are recorded in CLI progress state."],
    };
  }
  const latest = progress.latest && typeof progress.latest === "object" && !Array.isArray(progress.latest) ? progress.latest : {};
  const verified = latest.verified;
  const verifiedPresent = hasRecordedValue(verified);
  const cycle: Dict = {};
  for (const key of ["number", "timestamp", "type", "phase"]) {
    if (latest[key] !== null && latest[key] !== undefined && latest[key] !== "") cycle[key] = latest[key];
  }
  const pointer = { ...source, cycle_number: latest.number ?? null, field: "verified" };
  const caveats = verifiedPresent ? [] : ["Latest progress cycle has no non-empty verified evidence."];
  const evidenceFields = verifiedPresent ? ["verified"] : [];
  return {
    status: "available",
    source_provenance: source,
    cycle,
    verified_present: verifiedPresent,
    non_empty_evidence_present: verifiedPresent,
    non_empty_evidence_fields: evidenceFields,
    verified: verifiedPresent ? verified : null,
    verification_summary: verifiedPresent ? verified : null,
    latest_progress_verification_pointer: pointer,
    caveats,
  };
}

function retryState(): Dict {
  return {
    status: "not_recorded",
    source_provenance: {
      source_family: "progress",
      command: "agentera progress --format json",
      reason: "Current CLI/artifact state records progress cycles but no retry attempt state for orchestration tasks.",
    },
    caveats: ["Retry attempt state is not recorded; no attempt count is exposed."],
  };
}

function evaluatorHandoff(selected: Dict | null, progressVerification: Dict, retry: Dict, stateCaveats: string[]): Dict {
  const caveats = [...stateCaveats, ...(progressVerification.caveats ?? []), ...(retry.caveats ?? [])];
  if (selected === null) {
    caveats.push("No dependency-ready task is selected for evaluator handoff.");
    return {
      status: "unavailable",
      task: null,
      acceptance_criteria: [],
      evidence_requirements: [],
      latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
      evaluation_caveats: caveats,
    };
  }
  const evidenceRequirements = (selected.evidence_summary?.items ?? []) as any[];
  if (evidenceRequirements.length === 0) {
    caveats.push("Selected task has no explicit evidence requirements recorded in plan state.");
  }
  return {
    status: "ready",
    task: taskRef(selected),
    acceptance_criteria: selected.acceptance_summary?.items ?? [],
    evidence_requirements: evidenceRequirements,
    latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
    evaluation_caveats: caveats,
  };
}

function uniqueList(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) if (!out.includes(item)) out.push(item);
  return out;
}

function orchestrationContext(
  capability: string | null,
  plan: Dict,
  progress: Dict,
  health: Dict,
  todoItems: Array<Record<string, string>>,
  docs: Dict,
  profile: Dict,
  nextAction: Dict,
): Dict | null {
  if (capability !== "orkestrera") return null;
  const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const taskByNumber: Record<string, Dict> = {};
  for (const task of tasks) if (task.number !== null && task.number !== undefined) taskByNumber[String(task.number)] = task;
  const dependencyReady: Dict[] = [];
  const blocked: Dict[] = [];
  for (const task of tasks) {
    const status = entryStatus(task, "pending");
    if (DONE_STATUSES_ORCH.has(status)) continue;
    const reasons: string[] = [];
    if (BLOCKED_STATUSES_ORCH.has(status)) reasons.push(`task status is ${status}`);
    for (const dep of asList(task.depends_on)) {
      const dependency = taskByNumber[String(dep)];
      if (dependency === undefined) reasons.push(`dependency ${dep} is not present in plan tasks`);
      else if (!DONE_STATUSES_ORCH.has(entryStatus(dependency, "pending"))) {
        reasons.push(`dependency ${dep} is ${entryStatus(dependency, "pending")}`);
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
    fallbackCommands.push("agentera plan --format json");
  }
  if (!progress.exists) {
    stateCaveats.push("progress state is unavailable; latest verification is not summarized here.");
    fallbackCommands.push("agentera progress --format json");
  }
  if (!health.exists) {
    stateCaveats.push("health state is unavailable or incomplete.");
    fallbackCommands.push("agentera health --format json");
  }
  if (!docs.exists) {
    stateCaveats.push("docs mapping state is unavailable or incomplete.");
    fallbackCommands.push("agentera docs --format json");
  }
  if (todoItems.length === 0) {
    stateCaveats.push("todo state has no open entries in prime --context response; absence may mean none open or unavailable.");
    fallbackCommands.push("agentera todo --format json");
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
    capability: "orkestrera",
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

const DONE_STATUSES_ORCH = new Set(["complete", "completed", "closed", "done", "resolved", "retired"]);
const BLOCKED_STATUSES_ORCH = new Set(["blocked", "stuck"]);

function compactTaskSummaryForSlim(task: any): any {
  if (!task || typeof task !== "object" || Array.isArray(task)) return task;
  return {
    number: task.number ?? null,
    name: task.name ?? null,
    status: task.status ?? null,
    depends_on: task.depends_on ?? null,
    acceptance_count: task.acceptance_summary && typeof task.acceptance_summary === "object" ? task.acceptance_summary.count ?? null : null,
    evidence_count: task.evidence_summary && typeof task.evidence_summary === "object" ? task.evidence_summary.count ?? null : null,
    blocked_reasons: task.blocked_reasons ?? null,
  };
}

function compactProgressVerification(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Dict = {};
  for (const key of [
    "status", "source_provenance", "cycle", "verified_present",
    "non_empty_evidence_present", "non_empty_evidence_fields", "latest_progress_verification_pointer", "caveats",
  ]) {
    if (key in value) out[key] = value[key];
  }
  return out;
}

function slimOrchestrationContext(value: Dict): Dict {
  const compact: Dict = { ...value };
  const taskQueue = value.task_queue && typeof value.task_queue === "object" && !Array.isArray(value.task_queue) ? value.task_queue : {};
  compact.task_queue = {
    total: taskQueue.total ?? null,
    dependency_ready_tasks: asList(taskQueue.dependency_ready_tasks).map((t) => compactTaskSummaryForSlim(t)),
    blocked_tasks: asList(taskQueue.blocked_tasks).map((t) => compactTaskSummaryForSlim(t)),
  };
  compact.progress_verification = compactProgressVerification(value.progress_verification);
  compact.task_summaries = asList(value.task_summaries).map((t) => compactTaskSummaryForSlim(t));
  return compact;
}

function slimBespokeContext(name: string, value: Dict): Dict {
  if (name === "orchestration_context") return slimOrchestrationContext(value);
  // evidence_context / closeout_context slimming lands with their builders.
  return value;
}

function bespokeCapabilityContexts(capabilityName: string | null, state: Dict): Dict {
  return {
    orchestration_context: orchestrationContext(
      capabilityName,
      state.plan,
      state.progress,
      state.health,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.next_action,
    ),
    closeout_context: null,
    evidence_context: null,
    benchmark_context: null,
    execution_context: realiseraExecutionContext(
      capabilityName,
      state.schemas,
      state.plan,
      state.progress,
      state.health,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.bundle,
    ),
  };
}

// ── realisera execution bespoke context ─────────────────────────────

const TARGET_VERSION_RE = /\b\d+\.\d+\.\d+\b/;

function dependencyReadyTasks(tasks: Dict[]): Dict[] {
  const taskByNumber: Record<string, Dict> = {};
  for (const task of tasks) if (task.number !== null && task.number !== undefined) taskByNumber[String(task.number)] = task;
  const ready: Dict[] = [];
  for (const task of tasks) {
    const status = entryStatus(task, "pending");
    if (DONE_STATUSES_ORCH.has(status) || BLOCKED_STATUSES_ORCH.has(status)) continue;
    let blocked = false;
    for (const dep of asList(task.depends_on)) {
      const dependency = taskByNumber[String(dep)];
      if (dependency === undefined || !DONE_STATUSES_ORCH.has(entryStatus(dependency, "pending"))) {
        blocked = true;
        break;
      }
    }
    if (!blocked) ready.push(task);
  }
  return ready;
}

function selectEvidenceTarget(plan: Dict): Dict {
  const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const noTarget = {
    status: "no_target",
    target_type: "repository",
    task: null,
    selection_reason: "no_plan_task_target",
    source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries"),
    caveats: ["No plan task target was selected; evaluate repository-level evidence only."],
  };
  if (!plan.exists || tasks.length === 0) return noTarget;
  const inProgress = tasks.find((task) => entryStatus(task, "pending") === "in_progress");
  if (inProgress) {
    return {
      status: "selected",
      target_type: "plan_task",
      task: taskRef(inProgress),
      selection_reason: "in_progress_task",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.status"),
      caveats: [],
    };
  }
  const ready = dependencyReadyTasks(tasks);
  if (ready.length > 0) {
    return {
      status: "selected",
      target_type: "plan_task",
      task: taskRef(ready[0]),
      selection_reason: "first_dependency_ready_pending_task",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.depends_on"),
      caveats: [],
    };
  }
  const completedWithEvidence = [...tasks].reverse().find(
    (task) => DONE_STATUSES_ORCH.has(entryStatus(task, "pending")) && hasRecordedValue(task.evidence),
  );
  if (completedWithEvidence) {
    return {
      status: "selected",
      target_type: "plan_task",
      task: taskRef(completedWithEvidence),
      selection_reason: "latest_completed_task_with_evidence",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.evidence"),
      caveats: [],
    };
  }
  return noTarget;
}

function taskByRef(plan: Dict, ref: Dict | null): Dict | null {
  if (!ref) return null;
  for (const task of asList(plan.tasks)) {
    if (task && typeof task === "object" && !Array.isArray(task) && task.number === ref.number) return task;
  }
  return null;
}

function planContextField(plan: Dict, field: string): any {
  const summary = plan.summary && typeof plan.summary === "object" && !Array.isArray(plan.summary) ? plan.summary : {};
  return field in summary ? summary[field] : plan[field];
}

function realiseraScopeBoundary(plan: Dict, selected: Dict | null): Dict {
  const explicitPaths: string[] = [];
  const scopeField = planContextField(plan, "scope");
  const sources = [selected ?? {}, scopeField && typeof scopeField === "object" ? scopeField : {}];
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of ["source_files", "files", "paths"]) {
      for (const value of asList((source as Dict)[key])) {
        const text = String(value).trim();
        if (text && !explicitPaths.includes(text)) explicitPaths.push(text);
      }
    }
  }
  return {
    artifact_families: ["plan", "progress", "todo", "docs", "health", "changelog", "decisions", "vision", "profile", "design"],
    source_scope: {
      status: explicitPaths.length > 0 ? "explicit" : "unspecified",
      explicit_paths: explicitPaths,
      policy: "Do not infer source-file allowlists or exclusions from task text; use only explicit plan/source-contract paths.",
    },
  };
}

function realiseraArtifactUpdateRequirements(plan: Dict, docs: Dict): Dict {
  const mapping = asList(docs.mapping);
  const mapped = mapping.filter((e) => e && typeof e === "object" && e.artifact).map((e) => e.artifact);
  return {
    required_families: ["plan", "progress", "todo", "changelog"],
    protected_families: ["vision", "objective", "profile", "installed_app"],
    docs_mapping_available: Boolean(docs.exists && mapping.length > 0),
    mapped_artifacts: mapped,
    plan_status_update_required: Boolean(plan.exists),
    policy: "Update execution artifacts during the cycle; do not mutate protected state without explicit approval.",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.mapping"),
  };
}

function realiseraPlanCompletionSweep(plan: Dict): Dict {
  const complete = Boolean(plan.complete_plan);
  return {
    status: complete ? "eligible" : "not_eligible",
    mutation_allowed: false,
    required_updates: ["progress aggregate cycle", "changelog plan-level entries", "TODO milestone advance", "health cross-reference"],
    archive_candidate: complete ? "active plan archive path is generated only during Realisera sweep execution" : null,
    caveats: complete ? [] : ["Plan completion sweep is not eligible until every plan task is complete."],
    source_provenance: sourceProvenance("plan", "agentera plan --format json", "summary.status"),
  };
}

function selectedTargetVersion(plan: Dict): string | null {
  const textParts = [String(plan.title ?? "")];
  const firstPending = plan.first_pending;
  if (firstPending && typeof firstPending === "object" && !Array.isArray(firstPending)) {
    for (const key of ["name", "title"]) textParts.push(String(firstPending[key] ?? ""));
  }
  for (const task of asList(plan.tasks)) {
    if (task && typeof task === "object" && !Array.isArray(task)) {
      for (const key of ["name", "title"]) textParts.push(String(task[key] ?? ""));
    }
  }
  const match = TARGET_VERSION_RE.exec(textParts.join("\n"));
  return match ? match[0] : null;
}

function changelogRecordsTarget(text: string, targetVersion: string | null): boolean {
  if (!targetVersion) return false;
  const escaped = targetVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\d.])${escaped}(?![\\d.+-])`);
  return text.split(/\r\n|\r|\n/).some((line) => re.test(line));
}

function closeoutChangelogBoundary(schemas: Record<string, SchemaInfo>, plan: Dict): Dict {
  const info: SchemaInfo = schemas.changelog ?? { path: "CHANGELOG.md", record: undefined, schema: {}, fields: {} };
  const p = artifactPath(info, "changelog");
  const source = sourceMetadata("changelog", p);
  const targetVersion = selectedTargetVersion(plan);
  const unavailable = (caveat: string): Dict => ({
    status: "unavailable",
    source,
    source_provenance: sourceProvenance("changelog", "agentera query changelog --format json"),
    selected_target_version: targetVersion,
    selected_target_recorded: false,
    unreleased_present: false,
    latest_release_heading: null,
    boundary_present: false,
    boundary: null,
    caveats: [caveat],
  });
  if (!fs.existsSync(p)) return unavailable("CHANGELOG state is unavailable in CLI state.");
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (exc) {
    return unavailable(`CHANGELOG state could not be read by the CLI: ${(exc as Error).message}`);
  }
  const headings = text.split(/\r\n|\r|\n/).filter((line) => line.startsWith("## ")).map((line) => line.trim());
  const unreleased = headings.find((h) => h.toLowerCase().includes("unreleased")) ?? null;
  const latestRelease = headings.find((h) => !h.toLowerCase().includes("unreleased")) ?? null;
  const selectedRecorded = changelogRecordsTarget(text, targetVersion);
  const caveats: string[] = [];
  if (headings.length === 0) caveats.push("CHANGELOG state has no release headings.");
  if (targetVersion && !selectedRecorded) caveats.push(`CHANGELOG state has no ${targetVersion} closeout entry yet.`);
  const boundary = unreleased || latestRelease;
  return {
    status: headings.length > 0 ? "available" : "incomplete",
    source,
    source_provenance: {
      ...sourceProvenance("changelog", "agentera query changelog --format json", "release_headings"),
      internal_source: "CLI-resolved CHANGELOG.md heading scan",
    },
    selected_target_version: targetVersion,
    selected_target_recorded: selectedRecorded,
    unreleased_present: unreleased !== null,
    latest_release_heading: latestRelease,
    boundary_present: boundary !== null,
    boundary,
    release_state: selectedRecorded ? "selected_target_recorded" : "no_selected_target_closeout_entry",
    caveats,
  };
}

function realiseraExecutionContext(
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
  if (capability !== "realisera") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
  const target = selectEvidenceTarget(plan);
  const selected = taskByRef(plan, target && typeof target === "object" ? target.task : null);
  const acceptance = selected && typeof selected === "object" ? asList(selected.acceptance) : [];
  const progressVerification = progressVerificationSummary(progress);
  const changelogBoundary = closeoutChangelogBoundary(schemas, plan);
  const sweep = realiseraPlanCompletionSweep(plan);

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
    fallbackCommands.push("agentera plan --format json");
  }
  if (mode === "blocked_or_dependency_unready") {
    stateCaveats.push("No dependency-ready pending plan task is available in CLI plan state.");
    fallbackCommands.push("agentera plan --format json");
  }
  if (mode === "plan_driven" && acceptance.length === 0) {
    stateCaveats.push("Selected Realisera task has no acceptance criteria in CLI plan state.");
    fallbackCommands.push("agentera plan --format json");
  }
  if (!progress.exists) {
    stateCaveats.push("progress state is unavailable; progress logging context is incomplete.");
    fallbackCommands.push("agentera progress --format json");
  }
  if (!health.exists) {
    stateCaveats.push("health state is unavailable or incomplete.");
    fallbackCommands.push("agentera health --format json");
  }
  if (!docs.exists) {
    stateCaveats.push("docs mapping state is unavailable or incomplete.");
    fallbackCommands.push("agentera docs --format json");
  }
  if (todoItems.length === 0) {
    stateCaveats.push("todo state has no open entries in prime --context response; absence may mean none open or unavailable.");
    fallbackCommands.push("agentera todo --format json");
  }
  if (changelogBoundary.status !== "available") {
    stateCaveats.push(...((changelogBoundary.caveats ?? []) as string[]));
    fallbackCommands.push("agentera query changelog --format json");
  }
  if (profile.status !== "loaded") {
    stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  } else if (profile.stale === true) {
    stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  }
  if (bundle.status !== "up_to_date") {
    stateCaveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  }
  const scopeBoundary = realiseraScopeBoundary(plan, selected);
  if (scopeBoundary.source_scope.status === "unspecified") {
    stateCaveats.push("source-file scope is unspecified; no allowed or prohibited source paths were inferred.");
  }
  fallbackCommands = uniqueList(fallbackCommands);
  stateCaveats = uniqueList(stateCaveats);
  const requiredState: Record<string, boolean> = {
    work_selection: mode === "plan_driven" || mode === "completed_plan_sweep",
    acceptance_criteria: mode === "completed_plan_sweep" || acceptance.length > 0,
    artifact_update_requirements: Boolean(docs.exists),
    progress_logging_requirements: progressVerification.status === "available" || (progressVerification.caveats ?? []).length > 0,
    changelog_boundary: changelogBoundary.status === "available",
    scope_boundary: true,
    safety_boundaries: true,
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([name]) => name);
  const caveated = stateCaveats.length > 0;
  const complete = (mode === "plan_driven" || mode === "completed_plan_sweep") && missingRequired.length === 0;
  return {
    capability: "realisera",
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
      unsupported_cli_command_policy: "Do not introduce capability-name or slash-alias CLI commands for Realisera.",
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "summary.constraints"),
    },
    scope_boundary: scopeBoundary,
    verification_expectations: {
      latest_progress_verification: progressVerification,
      expected_commands: ["focused pytest targets", "Realisera capability validation", "self-validation", "agentera gate", "compaction check", "git diff --check"],
      source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.acceptance"),
    },
    artifact_update_requirements: realiseraArtifactUpdateRequirements(plan, docs),
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
      source_provenance: sourceProvenance("execution_context", "agentera prime --context realisera --format json", "git_boundary"),
    },
    plan_completion_sweep: sweep,
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_execution_context: complete,
      caveated,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this execution_context and included hej state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete execution state; raw artifact reads are last-resort diagnostics, not normal Realisera startup behavior.",
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
