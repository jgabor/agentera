import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";
import { publicDoctorStatus } from "../upgrade/doctor.js";
import { activeAppModel, discoverSchemasDir, SchemaInfo } from "./appContext.js";
import { artifactPath } from "./appContext.js";
import { asList, firstPresent, sourceMetadata } from "./stateQuery.js";
import { loadNamedArtifact } from "./orientation.js";
import { decisionContextEntry, decisionSourceContract, extractDecisionEntries } from "./commands/state.js";
import {
  evaluatorHandoffOutputRequirements,
  loadEvaluatorHandoffContract,
} from "../registries/evaluatorHandoffContract.js";
import {
  CAPABILITY_INSTRUCTIONS,
  capabilityInstructionModulePath,
  capabilityStartupCommand,
} from "../capabilities/index.js";

/**
 * prime --context capability-startup context. Faithful port of
 * scripts/agentera _capability_context / _slim_capability_context /
 * _generic_slim_startup_context and the slim state helpers. The five bespoke
 * capability contexts (orkestrera/dokumentera/inspektera/optimera/realisera)
 * are pending; this module covers the six non-bespoke capabilities.
 */

type Dict = Record<string, any>;
type Env = Record<string, string | undefined>;

export const CAPABILITY_NAMES = [
  "hej", "visionera", "resonera", "inspirera", "planera", "realisera",
  "optimera", "inspektera", "dokumentera", "profilera", "visualisera", "orkestrera",
];
export const BESPOKE_CONTEXT_CAPABILITIES = new Set<string>([]);

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
  const module = capabilityInstructionModulePath(capability);
  const prose = CAPABILITY_INSTRUCTIONS[capability] ?? null;
  return {
    module,
    exists: prose !== null && prose.length > 0,
    runtime_path: module,
    prose_present: prose !== null,
    prose_length: prose === null ? 0 : prose.length,
  };
}

function firstInvocationReadMetadata(capability: string): Dict {
  const authority = capabilityInstructionContract();
  const firstRead = authority.first_invocation_read && typeof authority.first_invocation_read === "object" ? authority.first_invocation_read : {};
  const allowedValues = firstRead.allowed_values && typeof firstRead.allowed_values === "object" ? firstRead.allowed_values : {};
  const value = "prime_context";
  const valueContract = (allowedValues[value] ?? {}) as Dict;
  return {
    field: "first_invocation_read",
    value,
    allowed_values: Object.keys(allowedValues),
    default_rule: firstRead.default_rule ?? firstRead.default_future_rule ?? null,
    module_target: capabilityInstructionTarget(capability),
    startup_command: capabilityStartupCommand(capability),
    obligation_summary: valueContract.obligation ?? `shell out to ${capabilityStartupCommand(capability)}`,
    meaning: valueContract.meaning ?? null,
    runtime_enforcement: true,
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
        "Use this compact context for normal Planera execution startup; " +
        "shell out to `agentera prime --context planera --format json` for the full Planera prose.",
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
    depends_on: planDependsOnList(task),
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

function evaluatorHandoffOutputRequirementsFromContract(): Dict {
  const contractPath = capabilityInstructionContractPath();
  if (!isFile(contractPath)) return {};
  try {
    const contract = loadEvaluatorHandoffContract(contractPath);
    return evaluatorHandoffOutputRequirements(contract);
  } catch {
    return {};
  }
}

function evaluatorHandoff(selected: Dict | null, progressVerification: Dict, retry: Dict, stateCaveats: string[]): Dict {
  const caveats = [...stateCaveats, ...(progressVerification.caveats ?? []), ...(retry.caveats ?? [])];
  const outputRequirements = evaluatorHandoffOutputRequirementsFromContract();
  if (selected === null) {
    caveats.push("No dependency-ready task is selected for evaluator handoff.");
    return {
      status: "unavailable",
      task: null,
      acceptance_criteria: [],
      evidence_requirements: [],
      latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
      evaluation_caveats: caveats,
      output_requirements: outputRequirements,
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
    output_requirements: outputRequirements,
  };
}

function uniqueList(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) if (!out.includes(item)) out.push(item);
  return out;
}

/** Coerce plan task numbers and depends_on refs to comparable lookup keys (int/string/object forms). */
function planTaskRefKeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "object" && !Array.isArray(value)) {
    const entry = value as Dict;
    const nested = entry.number ?? entry.task_number ?? entry.id;
    return nested === null || nested === undefined ? [] : planTaskRefKeys(nested);
  }
  const text = String(value).trim();
  if (!text) return [];
  const keys = new Set<string>([text]);
  const numeric = Number(text);
  if (Number.isFinite(numeric) && Number.isInteger(numeric)) keys.add(String(numeric));
  return [...keys];
}

function formatPlanTaskDepRef(dep: unknown): string {
  const keys = planTaskRefKeys(dep);
  return keys.length > 0 ? keys[0]! : String(dep);
}

function planDependsOnList(task: Dict): unknown[] {
  const raw = task.depends_on;
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined || raw === "") return [];
  return [raw];
}

function indexPlanTasksByNumber(tasks: Dict[]): Record<string, Dict> {
  const taskByNumber: Record<string, Dict> = {};
  for (const task of tasks) {
    if (task.number === null || task.number === undefined) continue;
    for (const key of planTaskRefKeys(task.number)) taskByNumber[key] = task;
  }
  return taskByNumber;
}

function resolvePlanTaskByRef(taskByNumber: Record<string, Dict>, dep: unknown): Dict | undefined {
  for (const key of planTaskRefKeys(dep)) {
    const hit = taskByNumber[key];
    if (hit !== undefined) return hit;
  }
  return undefined;
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
  if (name === "evidence_context") return slimEvidenceContext(value);
  if (name === "closeout_context") return slimCloseoutContext(value);
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
    closeout_context: dokumenteraCloseoutContext(
      capabilityName,
      state.schemas,
      state.plan,
      state.progress,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.bundle,
    ),
    evidence_context: inspekteraEvidenceContext(
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
    benchmark_context: optimeraBenchmarkContext(capabilityName),
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
  const taskByNumber = indexPlanTasksByNumber(tasks);
  const ready: Dict[] = [];
  for (const task of tasks) {
    const status = entryStatus(task, "pending");
    if (DONE_STATUSES_ORCH.has(status) || BLOCKED_STATUSES_ORCH.has(status)) continue;
    let blocked = false;
    for (const dep of planDependsOnList(task)) {
      const dependency = resolvePlanTaskByRef(taskByNumber, dep);
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

// ── inspektera evidence bespoke context ─────────────────────────────

function dateFromIsoUtc(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(utc);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return utc;
}
function todayUtcMs(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function currentStateStatus(value: unknown, label: string, staleAfterDays = 30): [string, string | null] {
  if (typeof value !== "string" || !value.trim()) return ["unknown", null];
  const observed = dateFromIsoUtc(value.trim().slice(0, 10));
  if (observed === null) return ["unknown", `${label} current-state date is not ISO-parseable in CLI state.`];
  const ageDays = Math.round((todayUtcMs() - observed) / 86400000);
  if (ageDays > staleAfterDays) return ["stale", `${label} evidence is stale (${ageDays} days old; threshold=${staleAfterDays}).`];
  return ["current", null];
}

function evidenceDocsState(docs: Dict): Dict {
  const available = Boolean(docs.exists);
  const nonEmptyFields = ["mapping_entries", "indexed_documents", "last_audit"].filter((f) => hasRecordedValue(docs[f]));
  const [currentState, currentStateCaveat] = currentStateStatus(docs.last_audit, "Docs");
  return {
    status: available ? "available" : "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json"),
    mapping_entries: docs.mapping_entries ?? 0,
    indexed_documents: docs.indexed_documents ?? 0,
    last_audit: docs.last_audit ?? null,
    current_state: currentState,
    non_empty_evidence_present: nonEmptyFields.length > 0,
    non_empty_evidence_fields: nonEmptyFields,
    caveats: [
      ...(available ? [] : ["Docs state is unavailable in CLI docs state."]),
      ...(available && currentStateCaveat ? [currentStateCaveat] : []),
    ],
  };
}

function evidenceHealthState(health: Dict): Dict {
  const available = Boolean(health.exists);
  const merged: Dict = { audit_number: health.number, ...health };
  const nonEmptyFields = ["audit_number", "trajectory", "grade"].filter((f) => hasRecordedValue(merged[f]));
  const auditDate = health.date ?? health.timestamp ?? null;
  const [currentState, currentStateCaveat] = currentStateStatus(auditDate, "Health");
  return {
    status: available ? "available" : "unavailable",
    source_provenance: sourceProvenance("health", "agentera health --format json"),
    audit_number: health.number ?? null,
    date: auditDate,
    timestamp: auditDate,
    trajectory: health.trajectory ?? null,
    grade: health.grade ?? null,
    degrading: Boolean(health.degrading),
    current_state: currentState,
    non_empty_evidence_present: nonEmptyFields.length > 0,
    non_empty_evidence_fields: nonEmptyFields,
    caveats: [
      ...(available ? [] : ["Health state is unavailable in CLI health state."]),
      ...(available && currentStateCaveat ? [currentStateCaveat] : []),
    ],
  };
}

function evidenceTodoState(schemas: Record<string, SchemaInfo>, todoItems: Array<Record<string, string>>): Dict {
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const exists = fs.existsSync(artifactPath(info, "todo"));
  return {
    status: exists ? "available" : "unavailable",
    source_provenance: sourceProvenance("todo", "agentera todo --format json"),
    open_count: todoItems.length,
    items: todoItems,
    non_empty_evidence_present: todoItems.length > 0,
    non_empty_evidence_fields: todoItems.length > 0 ? ["items"] : [],
    caveats: exists ? [] : ["TODO state is unavailable in CLI TODO state."],
  };
}

function evidenceProtectedStateChecks(): Dict {
  const source = sourceProvenance("evidence_context", "agentera prime --context inspektera --format json", "protected_state_checks");
  return {
    status: "not_checked_by_design",
    allowed_status_values: ["verified_local", "not_checked_by_design", "requires_manual_check", "unavailable"],
    source_provenance: source,
    checks: [
      {
        name: "vision_state",
        status: "not_checked_by_design",
        protected: true,
        checked: false,
        source_provenance: source,
        caveats: ["Vision state is protected during execution cycles and was not read or modified."],
      },
      {
        name: "objective_state",
        status: "not_checked_by_design",
        protected: true,
        checked: false,
        source_provenance: source,
        caveats: ["Objective state is protected during execution cycles and was not read or modified."],
      },
    ],
    caveats: ["Protected-state boundaries are reported without reading or modifying vision or objective state."],
  };
}

function evidenceVersionChecks(docs: Dict): Dict {
  const conventions = docsConventions(docs);
  const versionFiles = asList(conventions.version_files);
  const semverPolicy = conventions.semver_policy && typeof conventions.semver_policy === "object" && !Array.isArray(conventions.semver_policy) ? conventions.semver_policy : {};
  const source = sourceProvenance("docs", "agentera docs --format json", "summary.conventions");
  const ec = (field: string) => sourceProvenance("evidence_context", "agentera prime --context inspektera --format json", field);
  const checks: Dict[] = [
    {
      name: "docs_version_policy",
      status: Object.keys(semverPolicy).length > 0 ? "verified_local" : "unavailable",
      source_provenance: source,
      evidence: { semver_policy: semverPolicy },
      caveats: Object.keys(semverPolicy).length > 0 ? [] : ["Docs semver policy is unavailable in CLI docs state."],
    },
    {
      name: "version_files",
      status: versionFiles.length > 0 ? "verified_local" : "unavailable",
      source_provenance: source,
      evidence: { version_files: versionFiles },
      caveats: versionFiles.length > 0 ? [] : ["Docs version files are unavailable in CLI docs state."],
    },
    {
      name: "publication_evidence",
      status: "requires_manual_check",
      source_provenance: ec("version_checks.publication_evidence"),
      remote_checks_performed: false,
      registry_checks_performed: false,
      caveats: ["Publication and registry evidence is not recorded in CLI evidence context and requires manual verification if needed."],
    },
    {
      name: "remote_push_evidence",
      status: "requires_manual_check",
      source_provenance: ec("version_checks.remote_push_evidence"),
      remote_checks_performed: false,
      caveats: ["Remote push evidence is not recorded in CLI evidence context and requires manual verification if needed."],
    },
    {
      name: "installed_app_refresh",
      status: "not_checked_by_design",
      source_provenance: ec("version_checks.installed_app_refresh"),
      refresh_performed: false,
      caveats: ["Installed app refresh state is deliberately not checked or changed by evidence context."],
    },
  ];
  let status: string;
  if (checks.some((c) => c.status === "requires_manual_check")) status = "requires_manual_check";
  else if (checks.some((c) => c.status === "unavailable")) status = "unavailable";
  else status = "verified_local";
  return {
    status,
    allowed_status_values: ["verified_local", "not_checked_by_design", "requires_manual_check", "unavailable"],
    source_provenance: source,
    checks,
    caveats: checks.flatMap((c) => (c.caveats ?? []) as string[]),
  };
}

function evidencePlanCriteria(plan: Dict, target: Dict): Dict {
  const taskRefObj = target.task && typeof target.task === "object" && !Array.isArray(target.task) ? target.task : null;
  let selected: Dict | null = null;
  if (taskRefObj) {
    const tasks = asList(plan.tasks).filter((t) => t && typeof t === "object" && !Array.isArray(t));
    selected = tasks.find((t) => t.number === taskRefObj.number) ?? null;
  }
  const criteria = selected && typeof selected === "object" ? asList(selected.acceptance) : [];
  return {
    status: criteria.length > 0 ? "available" : "incomplete",
    source_provenance: sourceProvenance("plan", "agentera plan --format json", "entries.acceptance"),
    target: taskRefObj,
    criteria,
    criteria_count: criteria.length,
    non_empty_evidence_present: criteria.length > 0,
    non_empty_evidence_fields: criteria.length > 0 ? ["criteria"] : [],
    caveats: criteria.length > 0 ? [] : ["Selected evaluation target has no acceptance criteria in CLI plan state."],
  };
}

function residualRiskEntry(category: string, status: string, message: string, sp: Dict): Dict {
  return { category, status, message, source_provenance: sp };
}

function decisionContextRisk(schemas: Record<string, SchemaInfo>): Dict {
  const info: SchemaInfo = schemas.decisions ?? { path: ".agentera/decisions.yaml", record: undefined, schema: {}, fields: {} };
  const p = artifactPath(info, "decisions");
  const source = sourceMetadata("decisions", p);
  const data = loadNamedArtifact(schemas, "decisions");
  const entries = extractDecisionEntries(data).map((e) => decisionContextEntry(e));
  if (!source.exists) {
    return {
      status: "unavailable",
      source_provenance: sourceProvenance("decisions", "agentera decisions --format json"),
      summary: null,
      caveats: ["Decision state is unavailable in CLI evidence context."],
    };
  }
  const contract = decisionSourceContract(source, entries, {});
  const compacted = contract.completeness.compacted_entries;
  const missing = contract.completeness.entries_with_missing_fields;
  const caveats = compacted || missing ? (contract.caveats ?? []) : [];
  return {
    status: caveats.length > 0 ? "caveated" : "available",
    source_provenance: sourceProvenance("decisions", "agentera decisions --format json"),
    summary: contract.completeness,
    caveats,
  };
}

function parseDecisionReviewDate(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return dateFromIsoUtc(value.trim().slice(0, 10));
}

function decisionReviewDue(entry: Dict): [string | null, number | null] {
  const satisfaction = entry.satisfaction && typeof entry.satisfaction === "object" && !Array.isArray(entry.satisfaction) ? entry.satisfaction : {};
  const candidates: Array<[string, unknown]> = [
    ["review_date", entry.review_date],
    ["review_by", entry.review_by],
    ["satisfaction.review_date", satisfaction.review_date],
    ["satisfaction.review_by", satisfaction.review_by],
    ["satisfaction.review_due", satisfaction.review_due],
  ];
  for (const [field, value] of candidates) {
    const parsed = parseDecisionReviewDate(value);
    if (parsed !== null) return [field, parsed];
  }
  return [null, null];
}

function decisionLabel(entry: Dict): string {
  const number = entry.number;
  if (number !== null && number !== undefined && number !== "") return `Decision ${number}`;
  const summary = entry.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim().split(":", 1)[0];
  return "Decision entry";
}

function isoFromUtcMs(utc: number): string {
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function decisionReviewPressure(schemas: Record<string, SchemaInfo>): Dict {
  const info: SchemaInfo = schemas.decisions ?? { path: ".agentera/decisions.yaml", record: undefined, schema: {}, fields: {} };
  const p = artifactPath(info, "decisions");
  const source = sourceMetadata("decisions", p);
  const sp = sourceProvenance("decisions", "agentera decisions --format json");
  if (!source.exists) {
    return { status: "unavailable", source_provenance: sp, summary: null, stale_protected_decisions: [], caveats: [] };
  }
  const data = loadNamedArtifact(schemas, "decisions");
  const dd = data && typeof data === "object" && !Array.isArray(data) ? (data as Dict) : {};
  const active = Array.isArray(dd.decisions) ? dd.decisions : [];
  const archive = Array.isArray(dd.archive) ? dd.archive : [];
  const activeEntries = active.filter((e: unknown) => e && typeof e === "object" && !Array.isArray(e)).map((e: Dict) => decisionContextEntry(e));
  const archiveEntries = archive.filter((e: unknown) => e && typeof e === "object" && !Array.isArray(e)).map((e: Dict) => decisionContextEntry(e));
  const protectedActive = activeEntries.filter((e: Dict) => e.satisfaction && typeof e.satisfaction === "object" && e.satisfaction.review_needed);
  const protectedArchive = archiveEntries.filter((e: Dict) => e.satisfaction && typeof e.satisfaction === "object" && e.satisfaction.review_needed);
  const today = todayUtcMs();
  const stale: Dict[] = [];
  let caveats: string[] = [];
  for (const [collection, entries] of [["decisions", protectedActive], ["archive", protectedArchive]] as Array<[string, Dict[]]>) {
    for (const entry of entries) {
      const [field, reviewDate] = decisionReviewDue(entry);
      if (reviewDate === null || reviewDate > today) continue;
      const label = decisionLabel(entry);
      const message = `${label} requires protected decision review because ${field} elapsed on ${isoFromUtcMs(reviewDate)}.`;
      stale.push({ label, collection, reason: "review_date_elapsed", review_date: isoFromUtcMs(reviewDate), source_field: field, message });
      caveats.push(message);
    }
  }
  const protectedOverflowCount = Math.max(
    protectedActive.length - 10,
    protectedArchive.length - 40,
    protectedActive.length + protectedArchive.length - 50,
    0,
  );
  if (protectedOverflowCount) {
    const message =
      "Protected decisions exceed the 10/40/50 compaction budget; " +
      `${protectedOverflowCount} protected decision(s) require review before compaction can complete.`;
    stale.push({ label: "decisions", collection: "decisions/archive", reason: "protected_compaction_budget_pressure", protected_overflow_count: protectedOverflowCount, message });
    caveats.push(message);
  }
  caveats = uniqueList(caveats);
  return {
    status: caveats.length > 0 ? "review_required" : "available",
    source_provenance: sp,
    summary: {
      protected_active_decisions: protectedActive.length,
      protected_archive_decisions: protectedArchive.length,
      protected_overflow_count: protectedOverflowCount,
      stale_protected_decisions: stale.length,
    },
    stale_protected_decisions: stale,
    caveats,
  };
}

function inspekteraEvidenceContext(
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
  if (capability !== "inspektera") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const evaluationTarget = selectEvidenceTarget(plan);
  const planCriteria = evidencePlanCriteria(plan, evaluationTarget);
  const progressVerification = progressVerificationSummary(progress);
  const docsState = evidenceDocsState(docs);
  const healthState = evidenceHealthState(health);
  const todoState = evidenceTodoState(schemas, todoItems);
  const protectedStateChecks = evidenceProtectedStateChecks();
  const versionChecks = evidenceVersionChecks(docs);
  const decisionRisk = decisionContextRisk(schemas);
  const reviewPressure = decisionReviewPressure(schemas);

  let stateCaveats: string[] = [];
  const attributedRisks: Dict[] = [];
  for (const family of (capabilityContract.missing_state_families ?? []) as string[]) {
    const message = `${family} state is not included in prime --context startup context.`;
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("missing_state_family", "caveated", message, sourceProvenance("prime", "agentera prime --context inspektera --format json", "source_contract.capability_context.missing_state_families")));
  }
  if (bundle.status !== "up_to_date") {
    const message = "Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.";
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("installed_app_state", "caveated", message, sourceProvenance("hej", "agentera hej --format json", "bundle.status")));
  }
  if (profile.status !== "loaded") {
    const message = "profile-derived state is unavailable in prime --context response.";
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("profile_state", "unavailable", message, sourceProvenance("hej", "agentera hej --format json", "profile.status")));
  } else if (profile.stale === true) {
    const message = "profile-derived state is stale; this is a caveat, not approval to refresh profile state.";
    stateCaveats.push(message);
    attributedRisks.push(residualRiskEntry("profile_state", "caveated", message, sourceProvenance("hej", "agentera hej --format json", "profile.stale")));
  }
  for (const component of [evaluationTarget, planCriteria, progressVerification, docsState, healthState, todoState, protectedStateChecks, versionChecks]) {
    for (const caveat of (component.caveats ?? []) as string[]) {
      stateCaveats.push(caveat);
      attributedRisks.push(residualRiskEntry("evidence_family", "caveated", caveat, component.source_provenance ?? sourceProvenance("evidence_context", "agentera prime --context inspektera --format json")));
    }
  }
  for (const caveat of (decisionRisk.caveats ?? []) as string[]) {
    stateCaveats.push(caveat);
    attributedRisks.push(residualRiskEntry("decisions_context", decisionRisk.status, caveat, decisionRisk.source_provenance));
  }
  for (const caveat of (reviewPressure.caveats ?? []) as string[]) {
    stateCaveats.push(caveat);
    attributedRisks.push(residualRiskEntry("decision_review_pressure", reviewPressure.status, caveat, reviewPressure.source_provenance));
  }
  const retry = retryState();
  for (const caveat of (retry.caveats ?? []) as string[]) {
    stateCaveats.push(caveat);
    attributedRisks.push(residualRiskEntry("retry_state", retry.status, caveat, retry.source_provenance));
  }
  stateCaveats = uniqueList(stateCaveats);
  const dedupedRisks: Dict[] = [];
  const seen = new Set<string>();
  for (const risk of attributedRisks) {
    const key = `${risk.category}\u0000${risk.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      dedupedRisks.push(risk);
    }
  }
  const requiredState: Record<string, boolean> = {
    evaluation_target: evaluationTarget.status === "selected",
    plan_criteria: planCriteria.status === "available",
    progress_verification: progressVerification.status === "available",
    docs_state: docsState.status === "available",
    health_state: healthState.status === "available",
    todo_state: todoState.status === "available",
    source_contract: true,
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([name]) => name);
  const fallbackCommands = uniqueList([
    "agentera plan --format json",
    "agentera progress --format json",
    "agentera docs --format json",
    "agentera health --format json",
    "agentera todo --format json",
    "agentera query --list-artifacts --format json",
    ...((capabilityContract.cli_fallback ?? []) as string[]),
  ]);
  return {
    capability: "inspektera",
    evaluation_target: evaluationTarget,
    plan_criteria: planCriteria,
    progress_verification: progressVerification,
    docs_state: docsState,
    health_state: healthState,
    todo_state: todoState,
    protected_state_checks: protectedStateChecks,
    version_checks: versionChecks,
    decision_context: decisionRisk,
    decision_review_pressure: reviewPressure,
    residual_risks: {
      status: dedupedRisks.length > 0 ? "caveated" : "none_recorded",
      items: stateCaveats,
      attributed_items: dedupedRisks,
      caveats: [],
    },
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_evidence_context: missingRequired.length === 0,
      caveated: stateCaveats.length > 0,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this evidence_context and included hej state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete evidence state; raw artifact reads are last-resort diagnostics, not normal evaluation startup behavior.",
      included_state_families: capabilityContract.included_state_families ?? [],
      missing_state_families: capabilityContract.missing_state_families ?? [],
      required_evidence_state: requiredState,
      missing_required_evidence_state: missingRequired,
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: [
        "evaluation target",
        "plan criteria",
        "progress verification",
        "docs state",
        "health state",
        "TODO state",
        "protected-state placeholder checks",
        "version boundary checks",
        "compacted decision caveats",
        "protected decision review pressure",
        "attributed residual risks",
        "fallback commands",
        "raw-read policy",
        "truthful completeness metadata",
      ],
      deferred: [],
    },
  };
}

// ── slim transforms for evidence ────────────────────────────────────

function truncateContextText(value: any, maxChars = 240): any {
  if (typeof value !== "string" || value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1).replace(/\s+$/, "") + "\u2026";
}

function compactItemsState(value: any, maxItems = 3, maxChars = 180): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const compact: Dict = {};
  for (const [key, item] of Object.entries(value)) {
    if (!["items", "attributed_items", "summary"].includes(key)) compact[key] = item;
  }
  const items = (value as Dict).items;
  if (Array.isArray(items)) {
    compact.item_count = items.length;
    compact.items = items.slice(0, maxItems).map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, truncateContextText(v, maxChars)]))
        : truncateContextText(item, maxChars),
    );
    compact.truncated_item_count = Math.max(items.length - maxItems, 0);
  }
  const attributed = (value as Dict).attributed_items;
  if (Array.isArray(attributed)) compact.attributed_item_count = attributed.length;
  if (typeof (value as Dict).summary === "string") {
    compact.summary_present = true;
    compact.summary_excerpt = truncateContextText((value as Dict).summary, maxChars);
  }
  return compact;
}

function compactVersionChecks(value: any): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const compact: Dict = {};
  for (const key of ["status", "allowed_status_values", "source_provenance", "caveats"]) {
    if (key in value) compact[key] = (value as Dict)[key];
  }
  const checks = (value as Dict).checks;
  if (Array.isArray(checks)) {
    compact.checks = checks.map((check) => {
      const out: Dict = {};
      for (const key of ["name", "status", "refresh_performed", "remote_checks_performed", "registry_checks_performed"]) {
        if (check && typeof check === "object" && key in check) out[key] = check[key];
      }
      return out;
    });
  }
  return compact;
}

function slimEvidenceContext(value: Dict): Dict {
  const compact: Dict = { ...value };
  compact.residual_risks = compactItemsState(value.residual_risks, 15, 180);
  compact.todo_state = compactItemsState(value.todo_state, 3, 180);
  compact.progress_verification = compactProgressVerification(value.progress_verification);
  compact.version_checks = compactVersionChecks(value.version_checks);
  return compact;
}

// ── optimera benchmark bespoke context ──────────────────────────────

import os from "node:os";

const BENCHMARK_CONTEXT_CMD = "agentera prime --context optimera --format json";
const BENCHMARK_LATEST_REPORT_LABEL = "startup_benchmark_latest_report";
const BENCHMARK_HISTORY_LABEL = "startup_benchmark_history";
const BENCHMARK_CONTEXT_SOURCE_LABELS = [BENCHMARK_LATEST_REPORT_LABEL, BENCHMARK_HISTORY_LABEL];
const BENCHMARK_TOKEN_NULL_REASONS = [
  "previous_row_missing", "previous_missing_token_estimates", "estimator_version_mismatch",
  "runtime_scope_mismatch", "benchmark_mode_mismatch", "contract_version_mismatch",
];
const BENCHMARK_RECOMMENDATION_ACTIONS = new Set([
  "plan_cli_startup_envelope", "targeted_capability_guidance_fixes", "close_without_implementation",
]);
const BENCHMARK_CAVEATED_RUNTIME_STATUSES = new Set(["degraded", "missing", "skipped", "locked", "unreadable"]);
const BENCHMARK_FORBIDDEN_OUTPUTS = [
  "raw_transcripts", "raw_corpus_files", "raw_intermediates", "raw_runtime_store_paths", "raw_session_ids",
  "private_salts", "generated_salted_hashes", "raw_benchmark_report_bodies", "full_local_benchmark_paths",
];
const BENCHMARK_SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .:_-]{0,79}$/;
const BENCHMARK_SAFE_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9 .:_+@-]{0,119}$/;
const HEX16_RE = /^[0-9a-fA-F]{16,}$/;

function agenteraDataHome(env: Env = process.env): string {
  const override = env.AGENTERA_HOME;
  if (override) return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agentera");
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "agentera");
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "agentera");
}

function startupBenchmarkDir(): string {
  return path.join(agenteraDataHome(), "benchmarks", "startup-state");
}

function safeBenchmarkNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  return null;
}

function safeBenchmarkLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.includes("/") || label.includes("\\")) return null;
  if (HEX16_RE.test(label)) return null;
  if (!BENCHMARK_SAFE_LABEL_RE.test(label)) return null;
  return label;
}

function safeBenchmarkScalar(value: unknown, field: string, allowed: Set<string> | null = null): [string | null, string[]] {
  if (value === null || value === undefined) return [null, []];
  if (typeof value !== "string") return [null, [`${field} was omitted because it is not a bounded string value.`]];
  const text = value.trim();
  if (allowed !== null && !allowed.has(text)) return [null, [`${field} was omitted because it is not a supported bounded value.`]];
  if (!text || text.includes("/") || text.includes("\\") || HEX16_RE.test(text)) return [null, [`${field} was omitted at the benchmark privacy boundary.`]];
  if (!BENCHMARK_SAFE_SCALAR_RE.test(text)) return [null, [`${field} was omitted because it is outside the bounded scalar contract.`]];
  return [text, []];
}

function safeBenchmarkLabelCounts(value: unknown, family: string): [Record<string, number>, string[]] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{}, []];
  const counts: Record<string, number> = {};
  let dropped = 0;
  for (const [key, rawCount] of Object.entries(value as Dict)) {
    const label = safeBenchmarkLabel(key);
    const count = safeBenchmarkNumber(rawCount);
    if (label === null || count === null) {
      dropped += 1;
      continue;
    }
    counts[label] = count;
  }
  const caveats: string[] = [];
  if (dropped) caveats.push(`${family} omitted ${dropped} unsafe label(s) at the benchmark privacy boundary.`);
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  return [sorted, caveats];
}

function readBenchmarkJson(p: string, label: string): [string, Dict | null, string[]] {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return ["missing", null, [`${label} is missing from retained startup benchmark evidence.`]];
    return ["unreadable", null, [`${label} could not be read by the CLI.`]];
  }
  if (!text.trim()) return ["empty", null, [`${label} is empty.`]];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return ["malformed", null, [`${label} is malformed JSON.`]];
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data as Dict).length === 0) {
    return ["empty", null, [`${label} did not contain a non-empty JSON object.`]];
  }
  return ["available", data as Dict, []];
}

function readBenchmarkHistory(p: string): [string, Dict[], string[]] {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return ["missing", [], [`${BENCHMARK_HISTORY_LABEL} is missing from retained startup benchmark evidence.`]];
    return ["unreadable", [], [`${BENCHMARK_HISTORY_LABEL} could not be read by the CLI.`]];
  }
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim());
  if (lines.length === 0) return ["empty", [], ["Startup benchmark aggregate history exists but has no rows."]];
  const rows: Dict[] = [];
  let malformed = 0;
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row as Dict);
    else malformed += 1;
  }
  if (malformed) return ["malformed", rows, [`Startup benchmark aggregate history has ${malformed} malformed row(s).`]];
  if (rows.length === 0) return ["empty", [], ["Startup benchmark aggregate history has no usable rows."]];
  return ["available", rows, []];
}

function latestBenchmarkSummary(status: string, report: Dict | null, caveats: string[]): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "latest_report");
  if (status !== "available" || report === null) {
    return {
      status, source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      non_empty_evidence_present: false, contract_version: null, generated_at: null, benchmark_mode: null,
      benchmark_window: {}, total_records: null, total_state_sequences: null, caveats,
    };
  }
  const sc = [...caveats];
  const scalar = (key: string) => {
    const [v, c] = safeBenchmarkScalar(report[key], `latest_report.${key}`);
    sc.push(...c);
    return v;
  };
  const contractVersion = scalar("contract_version");
  const generatedAt = scalar("generated_at");
  const benchmarkMode = scalar("benchmark_mode");
  const previousWatermark = scalar("benchmark_previous_watermark_at");
  const windowStarted = scalar("benchmark_window_started_after");
  const watermarkAt = scalar("benchmark_watermark_at");
  const totalStateSequences = safeBenchmarkNumber(report.total_state_sequences);
  if (totalStateSequences === null) sc.push("Latest startup benchmark report is missing total_state_sequences.");
  return {
    status: "available", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: true, contract_version: contractVersion, generated_at: generatedAt,
    benchmark_mode: benchmarkMode,
    benchmark_window: { previous_watermark_at: previousWatermark, window_started_after: windowStarted, watermark_at: watermarkAt },
    total_records: safeBenchmarkNumber(report.total_records), total_state_sequences: totalStateSequences, caveats: sc,
  };
}

function historyBenchmarkSummary(status: string, rows: Dict[], caveats: string[]): Dict {
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  let latestSummary: Dict | null = null;
  const sc = [...caveats];
  if (latest) {
    const runtimeScope = Array.isArray(latest.runtime_scope) ? latest.runtime_scope : [];
    const safeScope = runtimeScope.map((v: unknown) => safeBenchmarkLabel(v)).filter((l): l is string => l !== null);
    if (safeScope.length !== runtimeScope.length) sc.push("Startup benchmark history omitted unsafe runtime-scope label(s).");
    const scalar = (key: string, allowed: Set<string> | null = null) => {
      const [v, c] = safeBenchmarkScalar(latest[key], `history_summary.latest_row.${key}`, allowed);
      sc.push(...c);
      return v;
    };
    const generatedAt = scalar("generated_at");
    const agenteraVersion = scalar("agentera_version");
    const benchmarkMode = scalar("benchmark_mode");
    const recommendationAction = scalar("startup_recommendation_action", BENCHMARK_RECOMMENDATION_ACTIONS);
    latestSummary = {
      generated_at: generatedAt, agentera_version: agenteraVersion, runtime_scope: safeScope,
      benchmark_mode: benchmarkMode, total_state_sequences: safeBenchmarkNumber(latest.total_state_sequences),
      raw_after_cli_rate: safeBenchmarkNumber(latest.raw_after_cli_rate),
      redundant_raw_access_rate: safeBenchmarkNumber(latest.redundant_raw_access_rate),
      startup_recommendation_action: recommendationAction,
    };
  }
  return {
    status, source_label: BENCHMARK_HISTORY_LABEL,
    source_provenance: sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "history_summary"),
    non_empty_evidence_present: rows.length > 0, row_count: rows.length, latest_row: latestSummary, caveats: sc,
  };
}

function runtimeBenchmarkCoverage(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "runtime_coverage");
  const miss = (caveat: string): Dict => ({
    status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: false, items: [], status_counts: {}, caveats: [caveat],
  });
  if (reportStatus !== "available" || report === null) return miss("Runtime coverage is unavailable without a valid latest startup benchmark report.");
  const rawItems = report.runtime_coverage;
  if (!Array.isArray(rawItems)) return miss("Latest startup benchmark report has no runtime_coverage list.");
  const items: Dict[] = [];
  let caveats: string[] = [];
  const statusCounts: Record<string, number> = {};
  for (const raw of rawItems.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      caveats.push("Runtime coverage omitted a non-object item.");
      continue;
    }
    const runtime = safeBenchmarkLabel(raw.runtime);
    let status = safeBenchmarkLabel(raw.status);
    const reason = safeBenchmarkLabel(raw.reason);
    if (runtime === null) {
      caveats.push("Runtime coverage omitted an unsafe runtime label.");
      continue;
    }
    status = status || "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const item: Dict = { runtime, status };
    if (reason) item.reason = reason;
    for (const key of ["record_count", "candidate_count", "error_count"]) {
      const number = safeBenchmarkNumber(raw[key]);
      if (number !== null) item[key] = number;
    }
    items.push(item);
  }
  if (rawItems.length > items.length) caveats.push("Runtime coverage summary is bounded and may omit invalid or excess rows.");
  const caveatedStatuses = [...new Set(items.map((i) => String(i.status)).filter((s) => BENCHMARK_CAVEATED_RUNTIME_STATUSES.has(s)))].sort();
  let statusValue: string;
  if (caveatedStatuses.length > 0) {
    statusValue = "degraded";
    caveats.push(
      "One or more runtime stores are missing, skipped, locked, unreadable, or degraded; " +
        "treat this as benchmark evidence caveat, not successful product behavior.",
    );
  } else if (items.some((i) => i.status === "sparse")) {
    statusValue = "sparse";
    caveats.push("One or more runtime stores are sparse; benchmark coverage is caveated.");
  } else if (items.length > 0) {
    statusValue = "available";
  } else {
    statusValue = "missing";
    caveats.push("Runtime coverage has no usable bounded rows.");
  }
  const sortedCounts: Record<string, number> = {};
  for (const k of Object.keys(statusCounts).sort()) sortedCounts[k] = statusCounts[k];
  return {
    status: statusValue, source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: items.length > 0, items, status_counts: sortedCounts, caveats: uniqueList(caveats),
  };
}

function stateAccessBenchmarkMetrics(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "state_access_metrics");
  if (reportStatus !== "available" || report === null) {
    return {
      status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      non_empty_evidence_present: false,
      caveats: ["State-access metrics are unavailable without a valid latest startup benchmark report."],
    };
  }
  const caveats: string[] = [];
  const [cliCounts, c1] = safeBenchmarkLabelCounts(report.cli_state_command_counts, "cli_state_command_counts");
  const [rawCounts, c2] = safeBenchmarkLabelCounts(report.raw_artifact_access_after_cli_counts, "raw_artifact_access_after_cli_counts");
  const [redundantCounts, c3] = safeBenchmarkLabelCounts(report.redundant_raw_artifact_access_counts, "redundant_raw_artifact_access_counts");
  const [capabilityCounts, c4] = safeBenchmarkLabelCounts(report.per_capability_state_counts, "per_capability_state_counts");
  caveats.push(...c1, ...c2, ...c3, ...c4);
  const required: Record<string, number | null> = {
    total_state_sequences: safeBenchmarkNumber(report.total_state_sequences),
    state_sequences_with_raw_after_cli: safeBenchmarkNumber(report.state_sequences_with_raw_after_cli),
    state_sequences_with_redundant_raw_access: safeBenchmarkNumber(report.state_sequences_with_redundant_raw_access),
    raw_after_cli_sequence_rate: safeBenchmarkNumber(report.raw_after_cli_sequence_rate),
    redundant_raw_sequence_rate: safeBenchmarkNumber(report.redundant_raw_sequence_rate),
  };
  const missing = Object.entries(required).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length > 0) caveats.push(`Latest startup benchmark report is missing state-access metric fields: ${missing.join(", ")}.`);
  if (required.total_state_sequences === 0) caveats.push("Startup benchmark observed zero state-gathering sequences; optimization conclusions are weak.");
  return {
    status: missing.length > 0 ? "incomplete" : "available",
    source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: missing.length === 0,
    ...required,
    total_cli_state_calls: safeBenchmarkNumber(report.total_cli_state_calls),
    total_raw_artifact_access_after_cli: safeBenchmarkNumber(report.total_raw_artifact_access_after_cli),
    total_redundant_raw_artifact_accesses: safeBenchmarkNumber(report.total_redundant_raw_artifact_accesses),
    cli_state_command_counts: cliCounts,
    raw_artifact_access_after_cli_counts: rawCounts,
    redundant_raw_artifact_access_counts: redundantCounts,
    per_capability_state_counts: capabilityCounts,
    caveats: uniqueList(caveats),
  };
}

function tokenBenchmarkImpact(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "token_impact");
  if (reportStatus !== "available" || report === null) {
    return {
      status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      non_empty_evidence_present: false,
      caveats: ["Token-impact estimates are unavailable without a valid latest startup benchmark report."],
    };
  }
  const [rawByArtifact, rawCaveats] = safeBenchmarkLabelCounts(report.estimated_raw_after_cli_tokens_by_artifact, "estimated_raw_after_cli_tokens_by_artifact");
  const [redundantByArtifact, redundantCaveats] = safeBenchmarkLabelCounts(report.estimated_redundant_raw_tokens_by_artifact, "estimated_redundant_raw_tokens_by_artifact");
  const [estimatorVersion, estimatorCaveats] = safeBenchmarkScalar(report.token_estimator_version, "token_impact.token_estimator_version");
  const required: Record<string, unknown> = {
    token_estimator_version: estimatorVersion,
    estimated_raw_after_cli_tokens: safeBenchmarkNumber(report.estimated_raw_after_cli_tokens),
    estimated_redundant_raw_tokens: safeBenchmarkNumber(report.estimated_redundant_raw_tokens),
  };
  const missing = Object.entries(required).filter(([, v]) => v === null || v === undefined || v === "").map(([k]) => k);
  const caveats = [...rawCaveats, ...redundantCaveats, ...estimatorCaveats];
  if (missing.length > 0) caveats.push(`Latest startup benchmark report is missing token-impact fields: ${missing.join(", ")}.`);
  return {
    status: missing.length > 0 ? "missing" : "available",
    source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: missing.length === 0,
    ...required,
    estimated_raw_after_cli_tokens_by_artifact: rawByArtifact,
    estimated_redundant_raw_tokens_by_artifact: redundantByArtifact,
    caveats: uniqueList(caveats),
  };
}

function benchmarkComparison(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "comparison");
  if (reportStatus !== "available" || report === null) {
    return {
      status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      estimated_tokens_saved_vs_previous: null, null_reason: null, allowed_null_reasons: BENCHMARK_TOKEN_NULL_REASONS,
      caveats: ["Benchmark comparison is unavailable without a valid latest startup benchmark report."],
    };
  }
  const saved = report.estimated_tokens_saved_vs_previous;
  const reason = report.estimated_tokens_saved_vs_previous_null_reason;
  let status: string;
  let caveats: string[];
  if (safeBenchmarkNumber(saved) !== null) {
    status = "comparable";
    caveats = [];
  } else if (BENCHMARK_TOKEN_NULL_REASONS.includes(reason)) {
    status = "not_comparable";
    caveats = [`Benchmark comparison is not comparable: ${reason}.`];
  } else {
    status = "missing";
    caveats = ["Benchmark comparison status is missing from latest startup benchmark report."];
  }
  return {
    status, source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    estimated_tokens_saved_vs_previous: safeBenchmarkNumber(saved),
    null_reason: BENCHMARK_TOKEN_NULL_REASONS.includes(reason) ? reason : null,
    allowed_null_reasons: BENCHMARK_TOKEN_NULL_REASONS, caveats,
  };
}

function benchmarkRecommendation(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "recommendation");
  const miss = (caveat: string): Dict => ({
    status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    action: null, measured_trigger: null, rationale: null, rationale_present: false,
    rationale_boundary: "not_emitted_from_retained_report", implementation_recommended: false, caveats: [caveat],
  });
  if (reportStatus !== "available" || report === null) return miss("Startup benchmark recommendation is unavailable without a valid latest report.");
  const recommendation = report.startup_recommendation;
  if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) {
    return miss("Latest startup benchmark report has no startup_recommendation object.");
  }
  const rec = recommendation as Dict;
  const caveats: string[] = [];
  let action = rec.action;
  if (!BENCHMARK_RECOMMENDATION_ACTIONS.has(action)) {
    action = "omitted_by_privacy_boundary";
    caveats.push("Startup benchmark recommendation action was omitted because it is not a supported bounded value.");
  }
  let trigger = rec.measured_trigger;
  if (typeof trigger === "string" && safeBenchmarkLabel(trigger) === null) {
    trigger = "omitted_by_privacy_boundary";
    caveats.push("Startup benchmark recommendation trigger was omitted at the privacy boundary.");
  } else if (typeof trigger !== "string") {
    trigger = null;
  }
  const rationalePresent = typeof rec.rationale === "string" && rec.rationale.trim().length > 0;
  if (rationalePresent) caveats.push("Startup benchmark recommendation rationale is present but not emitted from retained benchmark JSON.");
  return {
    status: "available", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    action, measured_trigger: trigger, rationale: null, rationale_present: rationalePresent,
    rationale_boundary: "not_emitted_from_retained_report",
    implementation_recommended: Boolean(report.implementation_recommended), caveats,
  };
}

function benchmarkManualRefresh(complete: boolean, latestReport: Dict, stateMetrics: Dict): Dict {
  const caveats = ["The CLI did not run `mage bench:startupState`; benchmark refresh is manual-only by design."];
  let status: string;
  if (["missing", "empty", "malformed", "unreadable"].includes(latestReport.status)) {
    status = "requires_manual_run";
    caveats.push("Retained startup benchmark evidence is absent or invalid; run the manual benchmark before using it for optimization decisions.");
  } else if (stateMetrics.total_state_sequences === 0) {
    status = "requires_manual_run";
    caveats.push("Retained startup benchmark evidence has zero state-gathering sequences; refresh or gather better evidence before optimizing from it.");
  } else if (complete) {
    status = "available";
  } else {
    status = "requires_manual_run";
  }
  return { status, command: "mage bench:startupState", execution_status: "not_run_by_design", auto_run: false, caveats: uniqueList(caveats) };
}

function benchmarkPrivacyBoundary(): Dict {
  return {
    status: "enforced",
    source_provenance: sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "privacy_boundary"),
    user_local_benchmark_reads: "cli_internal_summary_only",
    normal_agent_file_reads: "last_resort_diagnostics_only",
    raw_paths_emitted: false, raw_report_bodies_emitted: false, forbidden_outputs: BENCHMARK_FORBIDDEN_OUTPUTS,
    allowed_outputs: [
      "canonical source labels", "canonical runtime labels", "canonical artifact labels",
      "bounded counts and rates", "token estimate aggregates", "comparison null reasons", "manual refresh command",
    ],
  };
}

function optimeraBenchmarkContext(capability: string | null): Dict | null {
  if (capability !== "optimera") return null;
  const benchmarkDir = startupBenchmarkDir();
  const [latestStatus, latestData, latestCaveats] = readBenchmarkJson(path.join(benchmarkDir, "latest-report.json"), BENCHMARK_LATEST_REPORT_LABEL);
  const [historyStatus, historyRows, historyCaveats] = readBenchmarkHistory(path.join(benchmarkDir, "runs.jsonl"));
  const latestReport = latestBenchmarkSummary(latestStatus, latestData, latestCaveats);
  const historySummary = historyBenchmarkSummary(historyStatus, historyRows, historyCaveats);
  const runtimeCoverage = runtimeBenchmarkCoverage(latestStatus, latestData);
  const stateMetrics = stateAccessBenchmarkMetrics(latestStatus, latestData);
  const tokenImpact = tokenBenchmarkImpact(latestStatus, latestData);
  const comparison = benchmarkComparison(latestStatus, latestData);
  const recommendation = benchmarkRecommendation(latestStatus, latestData);
  const privacyBoundary = benchmarkPrivacyBoundary();
  const requiredState: Record<string, boolean> = {
    latest_report: latestReport.status === "available" && Boolean(latestReport.non_empty_evidence_present),
    history_summary: ["available", "empty"].includes(historySummary.status),
    runtime_coverage: runtimeCoverage.status !== "missing",
    state_access_metrics: stateMetrics.status === "available",
    token_impact_status: ["available", "missing"].includes(tokenImpact.status),
    recommendation_status: ["available", "missing"].includes(recommendation.status),
    source_contract: true,
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([k]) => k);
  const complete = missingRequired.length === 0;
  const manualRefresh = benchmarkManualRefresh(complete, latestReport, stateMetrics);
  const benchmarkSourceCaveats = [...latestCaveats, ...historyCaveats];
  const retainedOutputs = [
    { source_label: BENCHMARK_LATEST_REPORT_LABEL, filename: "latest-report.json", status: latestStatus },
    { source_label: BENCHMARK_HISTORY_LABEL, filename: "runs.jsonl", status: historyStatus },
    { source_label: "startup_benchmark_latest_markdown", filename: "latest-report.md", status: "not_read_by_context" },
  ];
  const caveats = uniqueList([
    ...benchmarkSourceCaveats,
    ...((latestReport.caveats ?? []) as string[]),
    ...((historySummary.caveats ?? []) as string[]),
    ...((runtimeCoverage.caveats ?? []) as string[]),
    ...((stateMetrics.caveats ?? []) as string[]),
    ...((tokenImpact.caveats ?? []) as string[]),
    ...((comparison.caveats ?? []) as string[]),
    ...((recommendation.caveats ?? []) as string[]),
    ...((manualRefresh.caveats ?? []) as string[]),
  ]);
  const fallbackCommands = ["agentera docs --format json", "agentera query --list-artifacts --format json"];
  return {
    capability: "optimera",
    benchmark_source: {
      status: latestStatus === "available" && ["available", "empty"].includes(historyStatus) ? "available" : "incomplete",
      source_provenance: sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "benchmark_source"),
      retained_outputs: retainedOutputs,
      non_empty_evidence_present: Boolean(latestReport.non_empty_evidence_present) || Boolean(historySummary.non_empty_evidence_present),
      normal_read_policy: "Agents consume this CLI summary first; direct retained benchmark file reads are last-resort diagnostics.",
      caveats: benchmarkSourceCaveats,
    },
    latest_report: latestReport,
    history_summary: historySummary,
    runtime_coverage: runtimeCoverage,
    state_access_metrics: stateMetrics,
    token_impact: tokenImpact,
    comparison,
    recommendation,
    manual_refresh: manualRefresh,
    privacy_boundary: privacyBoundary,
    state_family_caveats: caveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_benchmark_context: complete,
      caveated: caveats.length > 0,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this benchmark_context from `agentera prime --context optimera --format json` first. " +
        "If incomplete, follow fallback_commands and manual_refresh before any last-resort direct latest-report.json, " +
        "latest-report.md, or runs.jsonl diagnostic read.",
      benchmark_state_families: [
        "latest_report", "history_summary", "runtime_coverage", "state_access_metrics", "token_impact",
        "comparison", "recommendation", "manual_refresh", "privacy_boundary",
      ],
      required_benchmark_state: requiredState,
      missing_required_benchmark_state: missingRequired,
      source_labels: BENCHMARK_CONTEXT_SOURCE_LABELS,
      fallback_commands: fallbackCommands,
      manual_refresh_status: manualRefresh.status,
      privacy_boundary: { raw_paths_emitted: false, raw_report_bodies_emitted: false, forbidden_outputs: BENCHMARK_FORBIDDEN_OUTPUTS },
      caveats,
      owns: [
        "retained startup benchmark source status",
        "latest report summary",
        "aggregate history summary",
        "runtime coverage caveats",
        "state-access rates and counts",
        "token-impact estimates",
        "comparison null reasons",
        "startup recommendation action",
        "manual refresh guidance",
        "privacy boundary",
        "raw-read-last-resort policy",
        "truthful completeness metadata",
      ],
      deferred: ["2.3.12 Realisera execution-context state"],
    },
  };
}

// ── dokumentera closeout bespoke context ────────────────────────────

import { execFileSync } from "node:child_process";

function closeoutArtifactMappings(docs: Dict): Dict {
  const mapping = asList(docs.mapping);
  const ok = Boolean(docs.exists) && mapping.length > 0;
  return {
    status: ok ? "available" : "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.mapping"),
    entries: mapping,
    mapping_entries: mapping.length,
    caveats: ok ? [] : ["Docs artifact mappings are unavailable or empty in CLI docs state."],
  };
}

function closeoutVersionPolicy(docs: Dict): Dict {
  const conventions = docsConventions(docs);
  const semverPolicy = conventions.semver_policy && typeof conventions.semver_policy === "object" && !Array.isArray(conventions.semver_policy) ? conventions.semver_policy : {};
  const versionFiles = asList(conventions.version_files);
  const registry = conventions.version_files_registry ?? null;
  const available = Object.keys(semverPolicy).length > 0;
  return {
    status: available ? "available" : "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.conventions"),
    version_files: versionFiles,
    version_files_registry: registry,
    semver_policy: semverPolicy,
    caveats: available ? [] : ["Docs version policy is unavailable in CLI docs state."],
  };
}

function closeoutTodoBlockers(schemas: Record<string, SchemaInfo>, todoItems: Array<Record<string, string>>): Dict {
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const exists = fs.existsSync(artifactPath(info, "todo"));
  return {
    status: exists ? "available" : "unavailable",
    source_provenance: sourceProvenance("todo", "agentera todo --format json"),
    open_count: todoItems.length,
    items: todoItems,
    caveats: exists ? [] : ["TODO state is unavailable in CLI state."],
  };
}

function closeoutBenchmarkEvidence(docs: Dict): Dict {
  const coverage = docs.coverage && typeof docs.coverage === "object" && !Array.isArray(docs.coverage) ? docs.coverage : {};
  const testsSummary = String(coverage.tests ?? "").trim();
  if (testsSummary && testsSummary.toLowerCase().includes("benchmark")) {
    return {
      status: "available",
      source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.coverage.tests"),
      summary_present: true,
      non_empty_evidence_present: true,
      history_scope: "cli_visible_summary",
      user_local_benchmark_reads_required: false,
      summary: testsSummary,
      caveats: [],
    };
  }
  return {
    status: "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.coverage.tests"),
    summary_present: false,
    non_empty_evidence_present: false,
    history_scope: "not_exposed_by_supported_cli_state",
    user_local_benchmark_reads_required: false,
    summary: null,
    caveats: ["Supported CLI/state summaries do not expose benchmark evidence; do not read user-local benchmark files for normal closeout."],
  };
}

function localGitTagEvidence(targetVersion: string | null): Dict {
  const tag = targetVersion ? `v${targetVersion}` : null;
  const source = { source_family: "local_git", command: "git tag --list <target-tag>", remote: false };
  if (!tag) {
    return { status: "unavailable", tag: null, source_provenance: source, object_type: null, caveats: ["No selected target version is available for local tag evidence."] };
  }
  let stdout: string;
  try {
    stdout = execFileSync("git", ["tag", "--list", tag], { cwd: process.cwd(), encoding: "utf8", timeout: 2000 });
  } catch (exc) {
    const e = exc as { status?: number };
    if (typeof e.status === "number" && e.status !== 0) {
      return { status: "unavailable", tag, source_provenance: source, object_type: null, caveats: ["Local git tag evidence is unavailable because this project is not a git worktree."] };
    }
    return { status: "unavailable", tag, source_provenance: source, object_type: null, caveats: [`Local git tag evidence is unavailable: ${(exc as Error).message}`] };
  }
  if (!stdout.split(/\r\n|\r|\n/).includes(tag)) {
    return { status: "absent", tag, source_provenance: source, object_type: null, caveats: [`Local tag ${tag} is not present.`] };
  }
  let objectType: string | null = null;
  try {
    const out = execFileSync("git", ["cat-file", "-t", tag], { cwd: process.cwd(), encoding: "utf8", timeout: 2000 });
    objectType = out.trim() || null;
  } catch {
    objectType = null;
  }
  return {
    status: "available",
    tag,
    source_provenance: source,
    object_type: objectType,
    caveats: objectType ? [] : [`Local tag ${tag} exists but object type could not be verified.`],
  };
}

function closeoutReleaseBoundary(changelogBoundary: Dict, bundle: Dict): Dict {
  const targetVersion = changelogBoundary.selected_target_version;
  const localTag = localGitTagEvidence(targetVersion ? String(targetVersion) : null);
  const metadataRecorded = Boolean(changelogBoundary.selected_target_recorded);
  const caveats = [...((changelogBoundary.caveats ?? []) as string[]), ...((localTag.caveats ?? []) as string[])];
  if (!metadataRecorded && localTag.status !== "available") {
    caveats.push("No local closeout metadata or local tag evidence is recorded for the selected target.");
  }
  return {
    status: changelogBoundary.boundary_present ? "available" : "incomplete",
    selected_target_version: targetVersion ?? null,
    boundary: changelogBoundary.boundary ?? null,
    local_metadata_evidence: {
      status: metadataRecorded ? "recorded" : "not_recorded",
      source_provenance: changelogBoundary.source_provenance ?? null,
      field: "changelog_boundary.selected_target_recorded",
    },
    local_tag_evidence: localTag,
    publication_evidence: {
      package_publication: "not_recorded_in_cli_state",
      remote_push: "not_recorded_in_cli_state",
      remote_checks_performed: false,
      registry_checks_performed: false,
      source_provenance: sourceProvenance("closeout_context", "agentera prime --context dokumentera --format json", "release_boundary.publication_evidence"),
      caveats: ["Closeout context does not contact remotes or package registries."],
    },
    app_refresh_evidence: {
      installed_app_status: bundle.status ?? null,
      refresh: "not_recorded_in_cli_state",
      approval_recorded: false,
      source_provenance: sourceProvenance("hej", "agentera hej --format json", "bundle.status"),
    },
    caveats,
  };
}

function dokumenteraCloseoutContext(
  capability: string | null,
  schemas: Record<string, SchemaInfo>,
  plan: Dict,
  progress: Dict,
  todoItems: Array<Record<string, string>>,
  docs: Dict,
  profile: Dict,
  bundle: Dict,
): Dict | null {
  if (capability !== "dokumentera") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const artifactMappings = closeoutArtifactMappings(docs);
  const versionPolicy = closeoutVersionPolicy(docs);
  const todoBlockers = closeoutTodoBlockers(schemas, todoItems);
  const changelogBoundary = closeoutChangelogBoundary(schemas, plan);
  const progressEvidence = progressVerificationSummary(progress);
  const benchmarkEvidence = closeoutBenchmarkEvidence(docs);
  const releaseBoundary = closeoutReleaseBoundary(changelogBoundary, bundle);
  const reviewPressure = decisionReviewPressure(schemas);
  const requiredState: Record<string, boolean> = {
    artifact_mappings: artifactMappings.status === "available",
    version_policy: versionPolicy.status === "available",
    todo_blockers: todoBlockers.status === "available",
    changelog_boundary: Boolean(changelogBoundary.boundary_present),
    progress_evidence: progressEvidence.status === "available",
    benchmark_evidence_or_caveat: benchmarkEvidence.status === "available" || (benchmarkEvidence.caveats ?? []).length > 0,
    decision_review_pressure: reviewPressure.status !== "review_required",
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([k]) => k);
  let stateCaveats: string[] = [];
  for (const family of (capabilityContract.missing_state_families ?? []) as string[]) {
    stateCaveats.push(`${family} state is not included in prime --context startup context.`);
  }
  for (const component of [artifactMappings, versionPolicy, todoBlockers, changelogBoundary, releaseBoundary, progressEvidence, benchmarkEvidence, reviewPressure]) {
    stateCaveats.push(...((component.caveats ?? []) as string[]));
  }
  if (bundle.status !== "up_to_date") stateCaveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  if (profile.status !== "loaded") stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  else if (profile.stale === true) stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  stateCaveats = uniqueList(stateCaveats);
  const fallbackCommands = uniqueList([
    "agentera todo --format json",
    "agentera docs --format json",
    "agentera progress --format json",
    "agentera query changelog --format json",
    "agentera query --list-artifacts --format json",
    ...((capabilityContract.cli_fallback ?? []) as string[]),
  ]);
  return {
    capability: "dokumentera",
    artifact_mappings: artifactMappings,
    version_policy: versionPolicy,
    todo_blockers: todoBlockers,
    changelog_boundary: changelogBoundary,
    release_boundary: releaseBoundary,
    progress_evidence: progressEvidence,
    benchmark_evidence: benchmarkEvidence,
    decision_review_pressure: reviewPressure,
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_closeout_context: missingRequired.length === 0,
      caveated: stateCaveats.length > 0,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this closeout_context and included hej state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete closeout state; raw artifact reads are last-resort diagnostics, not normal closeout behavior.",
      included_state_families: capabilityContract.included_state_families ?? [],
      missing_state_families: capabilityContract.missing_state_families ?? [],
      closeout_state_families: ["docs", "todo", "changelog", "progress", "benchmark_evidence", "decisions"],
      required_closeout_state: requiredState,
      missing_required_closeout_state: missingRequired,
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: [
        "artifact mappings",
        "version policy",
        "TODO blockers",
        "changelog or no-release boundary",
        "local metadata/tag versus publication boundary",
        "latest progress evidence",
        "benchmark evidence pointer or unavailable caveat",
        "protected decision review pressure",
        "provenance pointers and non-empty evidence flags",
        "fallback commands",
        "raw-read policy",
        "truthful completeness flag",
      ],
    },
  };
}

function slimCloseoutContext(value: Dict): Dict {
  const compact: Dict = { ...value };
  compact.benchmark_evidence = compactItemsState(value.benchmark_evidence, 0, 220);
  compact.todo_blockers = compactItemsState(value.todo_blockers, 3, 160);
  compact.progress_evidence = compactProgressVerification(value.progress_evidence);
  return compact;
}
