import { publicDoctorStatus } from "../../../upgrade/doctor.js";
import { projectInstallTrack } from "../../../upgrade/compatibility.js";
import { formatNextAction, startupPlanSummary } from "../../orientation.js";
import { requestedFields, REQUIRED_SPARSE_CONTEXT_FIELDS, PRIME_STRUCTURED_FIELDS, availablePrimeFields } from "../../stateQuery.js";
import { emitStructured } from "../../structured.js";
import type { JsonObject } from "../../../core/jsonValue.js";
import type { BundleStatus } from "../../contracts/bundleStatus.js";
import type { NextAction, OrientationState } from "../../contracts/orientationState.js";
import { startupCompletenessContract } from "../../startupCompletenessContract.js";
import { stateWriterContract } from "../../../state/write/operations.js";
import { briefOrientationPayload, briefUtf8Bytes, PRIME_BRIEF_MAX_UTF8_BYTES } from "./briefOrientation.js";

export { startupCompletenessContract } from "../../startupCompletenessContract.js";
export { briefOrientationPayload, PRIME_BRIEF_MAX_UTF8_BYTES } from "./briefOrientation.js";

/** Authority for the complete status startup capsule, including instructions. */
export const PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES = 25000;

/** Project a single {@link NextAction} to its JSON record shape. */
function nextActionEntry(action: NextAction): Record<string, unknown> {
  return {
    object: action.object,
    capability: action.capability,
    reason: action.reason,
    phase: action.phase,
    ...(action.id ? { id: action.id } : {}),
    ...(action.artifact ? { artifact: action.artifact } : {}),
    ...(action.outcome ? { outcome: action.outcome } : {}),
    ...(typeof action.eligible === "boolean" ? { eligible: action.eligible } : {}),
    ...(action.retrieval ? { retrieval: action.retrieval } : {}),
  };
}

/** Ranked state-readiness hint for the prime JSON `next_action` field (D76).
 *  The recommended entry is flattened to top-level `object`/`capability`/
 *  `reason`/`phase` so consumers reading `next_action.object` keep working,
 *  and `alternatives` carries the cascade branches the early-return model
 *  would have skipped, each with the same `{object, capability, reason, phase}`
 *  shape. */
function nextActionPayload(state: OrientationState): Record<string, unknown> {
  const { recommended, alternatives } = state.next_action;
  return {
    ...nextActionEntry(recommended),
    alternatives: alternatives.map(nextActionEntry),
  };
}

const STATUS_STRUCTURED_FIELDS = PRIME_STRUCTURED_FIELDS;

const DEFAULT_PUBLIC_ATTENTION_LIMIT = 6;

export function projectPublicOrientationAttention(state: OrientationState): string[] {
  const glossary = state.glossary_caveat_attention;
  const policy = state.glossary_caveat_attention_policy;
  if (!glossary || !policy) return state.attention.slice(0, DEFAULT_PUBLIC_ATTENTION_LIMIT);
  const unrelated = state.attention.filter((item) => item !== glossary);
  const unrelatedLimit = Math.max(0, policy.public_limit - policy.reserved_slots);
  return [...unrelated.slice(0, unrelatedLimit), glossary].slice(0, policy.public_limit);
}

const ISSUES_FIELD_DEPRECATION_MESSAGE =
  "Deprecation: prime JSON field 'issues' is deprecated; use 'todo'. The 'issues' field will be removed at the 3.0.0 stable cut.\n";

/** Top-level conditional fields whose default/inactive payload is omitted from
 *  the default bare briefing so startup does not carry default-only adjective
 *  noise. They remain declared in PRIME_STRUCTURED_FIELDS (selectable via
 *  `--fields` and advertised in `source_contract.fields`) and are recovered
 *  through `state_presence` (missing-vs-empty semantics) plus a named
 *  authoritative command. The full payload kept by `buildOrientationJsonPayload`
 *  still populates them, so explicit `--fields <name>` selection, the text
 *  briefing, and downstream state consumers are unaffected. See
 *  references/cli/prime-consumer-compatibility.yaml
 *  default_emission_omission_contract for the published contract. */
const OMITTABLE_DEFAULT_CONDITIONAL_TOP_FIELDS: readonly string[] = [
  "v1_migration",
  "docs",
  "objective",
];

/** Whether a conditional top-level field carries present/active payload (not the
 *  default-only state that should be omitted from the default briefing). The
 *  activity predicate mirrors each summary's "default" branch so absence stays
 *  non-ambiguous: a survivor key is present exactly when the field is active. */
function isConditionalFieldPresent(field: string, payload: Record<string, unknown>): boolean {
  const value = payload[field];
  if (value === null || value === undefined) return false;
  if (typeof value !== "object" || Array.isArray(value)) return true;
  const obj = value as Record<string, unknown>;
  // v1_migration: present when v1 artifacts are detected (detected !== true is
  // the default state; recover via `agentera upgrade --dry-run`).
  if (field === "v1_migration") return obj.detected === true;
  // docs: present when a docs mapping artifact exists (exists !== true is the
  // absent state; recover via `agentera state docs`).
  if (field === "docs") return obj.exists === true;
  // objective: present when an objective is active (active !== true is the
  // none-active state; state_presence.active.objective disambiguates).
  if (field === "objective") return obj.active === true;
  return true;
}

/** Return a default-briefing copy of `payload` with inactive conditional
 *  top-level fields removed. Required fields and `state_presence` (the
 *  missing-vs-empty authority) are always retained. Used only by the default
 *  bare emission path; explicit `--fields` selection keeps the full payload. */
function omitInactiveConditionalDefaults(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      OMITTABLE_DEFAULT_CONDITIONAL_TOP_FIELDS.includes(key) &&
      !isConditionalFieldPresent(key, payload)
    ) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function shouldEmitIssuesDeprecation(requested: string[], payload: Record<string, unknown>): boolean {
  if (!("issues" in payload)) return false;
  if (requested.length === 0) return true;
  return requested.includes("issues");
}

function emitIssuesFieldDeprecationWarning(
  requested: string[],
  payload: Record<string, unknown>,
  err: (t: string) => void,
): void {
  if (shouldEmitIssuesDeprecation(requested, payload)) {
    err(ISSUES_FIELD_DEPRECATION_MESSAGE);
  }
}

function orientationAppHome(bundle: BundleStatus): JsonObject {
  return {
    install_track: projectInstallTrack(bundle.installKind),
    status: bundle.status,
    home: bundle.appHome,
    source: bundle.appHomeSource,
    managed_app_root: bundle.managedAppRoot,
    user_data_root: bundle.userDataRoot,
  };
}

function capabilityContextPointer(requiredBeforeRendering = true): JsonObject {
  return {
    capability: "status",
    fetch_command: "agentera prime --context status --format json",
    required_before_rendering: requiredBeforeRendering,
    note: requiredBeforeRendering
      ? "Dashboard rendering instructions (template, field rules, exit marker) are owned by the status capability. Run the fetch_command before rendering."
      : "Includes dashboard instructions and bounded state; no second prime call.",
  };
}

export function buildOrientationJsonPayload(
  state: OrientationState,
  command: string,
  options: { capabilityContextRequiredBeforeRendering?: boolean } = {},
): Record<string, unknown> {
  const bundle = state.app;
  const schemasDir = state.schemas_dir;
  const bundlePublic = publicDoctorStatus(bundle);
  const appHome = orientationAppHome(bundle);
  const bespoke: JsonObject = {
    orchestration_context: null,
    closeout_context: null,
    evidence_context: null,
    benchmark_context: null,
    execution_context: null,
  };
  const render =
    command === "status"
      ? "caller-owned README-style prime orientation dashboard"
      : "caller-owned README-style prime orientation dashboard";
  const access =
    command === "status"
      ? "single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls during normal prime"
      : "single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls during normal prime";
  return {
    command,
    status: "ok",
    app_home: appHome,
    app: bundlePublic,
    mode: state.mode,
    profile: state.profile_dict,
    v1_migration: state.v1_migration,
    shared_skill: state.shared_skill,
    project_integration: state.project_integration,
    health: state.health,
    todo: { ...state.counts, detail: state.todo_detail },
    issues: state.counts,
    plan: startupPlanSummary(state.plan),
    docs: state.docs,
    progress: state.progress,
    objective: state.objective,
    state_presence: state.state_presence,
    attention: projectPublicOrientationAttention(state),
    decision_attention: state.decision_attention,
    history: state.history,
    next_action: nextActionPayload(state),
    orchestration_context: bespoke.orchestration_context,
    closeout_context: bespoke.closeout_context,
    evidence_context: bespoke.evidence_context,
    benchmark_context: bespoke.benchmark_context,
    execution_context: bespoke.execution_context,
    source: {
      schemas_dir: schemasDir,
      project: process.cwd(),
      artifacts_present: state.mode === "returning",
    },
    source_contract: {
      fields: STATUS_STRUCTURED_FIELDS,
      render,
      access,
      empty_state: "fresh: summaries absent; zero issues",
      capability_startup: startupCompletenessContract({ profileStatus: state.profile_status }),
       capability_context: capabilityContextPointer(options.capabilityContextRequiredBeforeRendering ?? true),
      artifact_writes: stateWriterContract(),
    },
  };
}

/**
 * The status capability consumes the same bounded decision-brief projection as
 * bare prime. Keeping the projection here prevents a second status summary
 * implementation from drifting from the public prime contract.
 */
export function buildStatusContextState(
  state: OrientationState,
  command = "prime",
  options: { budgetBytes?: number; degradedMode?: "minimal" | "status_routing" } = {},
): Record<string, unknown> {
  const projected = briefOrientationPayload(
    omitInactiveConditionalDefaults(
      buildOrientationJsonPayload(state, command, { capabilityContextRequiredBeforeRendering: false }),
    ),
    {
      budgetBytes: options.budgetBytes ?? PRIME_BRIEF_MAX_UTF8_BYTES,
      degradedMode: options.degradedMode,
    },
  );
  // The canonical brief contains compatibility and source metadata useful to
  // bare-prime consumers. Keep only the startup-completeness source contract
  // consumed by status; the outer capability capsule already declares how it
  // was fetched, while the brief block retains omitted-detail recovery.
  const sourceContract = projected.source_contract;
  if (sourceContract && typeof sourceContract === "object" && !Array.isArray(sourceContract)) {
    projected.source_contract = {
      capability_startup: (sourceContract as Record<string, unknown>).capability_startup,
      empty_state: (sourceContract as Record<string, unknown>).empty_state,
    };
  }
  // History/source and null bespoke pointers are not dashboard or routing
  // inputs. Omit those redundant leaves after applying the shared projection.
  for (const field of [
    "app_home",
    "history",
    "issues",
    "source",
    "orchestration_context",
    "closeout_context",
    "evidence_context",
    "benchmark_context",
    "execution_context",
  ]) {
    delete projected[field];
  }
  return projected;
}

export function emitPrime(
  command: string,
  payload: Record<string, unknown>,
  format: string,
  fieldsArg: string | null | undefined,
  out: (t: string) => void,
  err: (t: string) => void,
  options: { bareBrief?: boolean; briefBudgetBytes?: number; maxUtf8Bytes?: number } = {},
): number {
  const requested = requestedFields(fieldsArg);
  // The default bare briefing first omits inactive conditional top-level fields
  // (v1_migration/docs/objective when default) so startup does not carry
  // default-only payload, then — for the bare default only — projects the full
  // payload to a bounded decision brief (Plan Task 3). Explicit `--fields`
  // selection and `--context` use their governed payloads. Dashboard history is
  // already projected at collection time so ordinary list detail is not copied
  // into startup (see default_emission_omission_contract + brief_omission_contract).
  const conditional = requested.length === 0 && options.bareBrief ? omitInactiveConditionalDefaults(payload) : payload;
  const effectivePayload =
    requested.length === 0 && options.bareBrief
      ? briefOrientationPayload(conditional, { budgetBytes: options.briefBudgetBytes })
      : conditional;
  emitIssuesFieldDeprecationWarning(requested, effectivePayload, err);
  if (requested.length === 0) {
    if (format === "json" && options.maxUtf8Bytes !== undefined) {
      const bytes = briefUtf8Bytes(effectivePayload);
      if (bytes > options.maxUtf8Bytes) {
        err(`Error: ${command} JSON output is ${bytes} UTF-8 bytes, over the ${options.maxUtf8Bytes}-byte startup budget; use the named recovery commands in the projected output contract.\n`);
        return 1;
      }
    }
    emitStructured(effectivePayload, format, out);
    return 0;
  }
  const available = availablePrimeFields(command);
  const unsupported = requested.filter((f) => !available.includes(f));
  if (unsupported.length > 0) {
    err(`Error: unsupported field '${unsupported[0]}' for ${command}. Available fields: ${available.join(", ")}\n`);
    return 1;
  }
  const selected: Record<string, unknown> = {};
  for (const field of [...REQUIRED_SPARSE_CONTEXT_FIELDS, ...requested]) {
    if (field in payload && !(field in selected)) selected[field] = payload[field];
  }
  if (format === "json" && options.maxUtf8Bytes !== undefined) {
    const bytes = briefUtf8Bytes(selected);
    if (bytes > options.maxUtf8Bytes) {
      err(`Error: ${command} JSON output is ${bytes} UTF-8 bytes, over the ${options.maxUtf8Bytes}-byte startup budget; use the named recovery commands in the projected output contract.\n`);
      return 1;
    }
  }
  emitStructured(selected, format, out);
  return 0;
}

export function printOrientationTextBriefing(state: OrientationState, command: string, out: (t: string) => void): void {
  const bundle = state.app;
  const mode = state.mode;
  const profileStatus = state.profile_status;
  const profile = state.profile;
  const health = state.health;
  const counts = state.counts;
  const plan = state.plan;
  const objective = state.objective;
  const presence = state.state_presence;
  const attention = state.attention;
  const nextAction = state.next_action;
  const dashboardLabel = command === "prime" ? "prime orientation dashboard" : "prime orientation dashboard";

  out(`agentera ${command}\n`);
  out(
    `app_home: install_track=${projectInstallTrack(bundle.installKind)} | status=${bundle.status} | home=${bundle.appHome} | ` +
      `source=${bundle.appHomeSource} | managed_app=${bundle.managedAppRoot} | user_data=${bundle.userDataRoot} | expected=${bundle.expectedVersion} | ` +
      `expected_source=${bundle.expectedVersionSource ?? "-"} | current=${bundle.markerVersion || "-"}\n`,
  );
  out(`mode: ${mode}\n`);
  const projectIntegration = state.project_integration;
  out(
    `project_integration: recommendation=${projectIntegration.recommendation} | ` +
      `channel=${projectIntegration.update_channel} | pending_artifacts=${projectIntegration.pending_artifacts}\n`,
  );
  if (projectIntegration.recommendation === "upgrade" && projectIntegration.message) {
    out(`project_integration_message: ${projectIntegration.message}\n`);
  }
  out(`shared_skill: status=${String(state.shared_skill.status)} | path=${String(state.shared_skill.path)}\n`);
  out(`profile: ${profileStatus} | path=${profile}\n`);
  if (health.exists && health.id) {
    const worst = health.worst;
    const worstText = worst ? `${worst[0]}:${worst[1]}` : "none";
    out(
      `health: id=${health.id} | artifact=${health.artifact ?? "health"} | grade=${health.grade || "unknown"} | ` +
      `trajectory=${health.trajectory || "unknown"} | worst=${worstText}\n`,
    );
  }
  if (health.degraded_history) {
    const degraded = health.degraded_history as Record<string, unknown>;
    out(
      `health: degraded_history | summaries=${String(degraded.summary_count ?? 0)} | returned=${String(degraded.returned_count ?? 0)} | omitted=${String(degraded.omitted_count ?? 0)} | ` +
        `detail=summary-only | recovery=agentera state health list --limit 20 --format json\n`,
    );
  }
  const latestProgress = state.progress.latest as Record<string, unknown> | undefined;
  if (latestProgress) {
    out(
      `progress: id=${String(latestProgress.id ?? "unknown")} | artifact=${String(latestProgress.artifact ?? "progress")} | ` +
      `what=${String(latestProgress.what ?? "unknown")}\n`,
    );
  }
  if (state.progress.degraded_history) {
    const degraded = state.progress.degraded_history as Record<string, unknown>;
    out(
      `progress: degraded_history | summaries=${String(degraded.summary_count ?? 0)} | returned=${String(degraded.returned_count ?? 0)} | omitted=${String(degraded.omitted_count ?? 0)} | ` +
        `detail=summary-only | recovery=agentera state progress list --limit 20 --format json\n`,
    );
  }
  const decisionHistory = (state.history.decisions as Record<string, unknown> | undefined)?.degraded_history as Record<string, unknown> | undefined;
  if (decisionHistory) {
    out(
      `decisions: degraded_history | summaries=${String(decisionHistory.summary_count ?? 0)} | returned=${String(decisionHistory.returned_count ?? 0)} | omitted=${String(decisionHistory.omitted_count ?? 0)} | ` +
      `detail=summary-only | recovery=agentera state decisions list --limit 20 --format json\n`,
    );
  }
  out(`todo: critical=${counts.critical} | degraded=${counts.degraded} | normal=${counts.normal} | annoying=${counts.annoying}\n`);
  if (!presence.any_active) {
    const missing = Object.keys(presence.absence).sort().join(", ") || "none";
    out(`state: no active plan or objective | missing=${missing}\n`);
  }
  if (plan.exists && !plan.complete_plan) {
    out(`plan: status=${plan.status || "unknown"} | progress=${plan.complete ?? 0}/${plan.total ?? 0}\n`);
  }
  if (objective.active) {
    const target = objective.target ? ` | target=${objective.target}` : "";
    out(`objective: active | name=${objective.name} | metric=${objective.metric}${target}\n`);
  } else if (objective.exists) {
    out(`objective: none active | closed=${objective.closed_count ?? 0}\n`);
  } else {
    out("objective: none active\n");
  }
  if (attention.length > 0) {
    out("attention:\n");
    for (const item of projectPublicOrientationAttention(state)) out(`- ${item}\n`);
  }
  out("next_action:\n");
  out(`- ${formatNextAction(nextAction.recommended)}\n`);
  for (const alt of nextAction.alternatives) {
    out(`- alt: ${formatNextAction(alt)}\n`);
  }
  out("source_contract:\n");
  out(`- fields=${PRIME_STRUCTURED_FIELDS.join(", ")}\n`);
  out(`- render=caller-owned README-style ${dashboardLabel}\n`);
  out("- access=single installed CLI call; app/v1/profile safety included; no preflight glob/read/import/doctor calls\n");
  const startup = startupCompletenessContract({ profileStatus: state.profile_status });
  out(`- capability_startup_complete=${String(startup.complete_for_capability_startup).toLowerCase()}\n`);
  out(`- capability_context: fetch rendering instructions via \`agentera prime --context status --format json\`\n`);
  out("- artifact_writes: discover via `agentera schema --format json` or `agentera state <artifact> explain --format json`\n");
  out(
    `- raw_artifact_reads_required=${String(startup.raw_artifact_reads_required).toLowerCase()}; policy=${startup.raw_artifact_read_policy}\n`,
  );
  const missingState = (startup.missing_state as string[]).join("; ") || "none";
  out(`- missing_state=${missingState}\n`);
  out(`- confidence_caveats=${(startup.confidence_caveats as string[]).join("; ")}\n`);
  out(`- cli_fallback=${(startup.cli_fallback as string[]).join("; ")}\n`);
}
