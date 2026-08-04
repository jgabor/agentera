import { publicDoctorStatus } from "../../../upgrade/doctor.js";
import { projectInstallTrack } from "../../../upgrade/compatibility.js";
import { formatNextAction, startupPlanSummary } from "../../orientation.js";
import {
  requestedFields,
  REQUIRED_SPARSE_CONTEXT_FIELDS,
  PRIME_STRUCTURED_FIELDS,
  RETIRED_PRIME_FIELD_CORRECTIONS,
  availablePrimeFields,
} from "../../stateQuery.js";
import { emitStructured } from "../../structured.js";
import { emitInvalidInput } from "../../errors.js";
import type { JsonObject } from "../../../core/jsonValue.js";
import { preCutoverCommand } from "../../preCutoverCommand.js";
import { truncateCodePoints } from "../../../core/text.js";
import type { BundleStatus } from "../../contracts/bundleStatus.js";
import type { NextAction, OrientationState } from "../../contracts/orientationState.js";
import { briefOrientationPayload, briefUtf8Bytes, PRIME_BRIEF_MAX_UTF8_BYTES } from "./briefOrientation.js";
import { capabilityContext } from "../../capabilityContext/contract.js";
import { startupAggregation } from "../../capabilityContext/startupAggregation.js";

export { briefOrientationPayload, PRIME_BRIEF_MAX_UTF8_BYTES } from "./briefOrientation.js";

/** Authority for the complete status startup capsule, including instructions. */
export const PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES = 22500;

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

/** Top-level conditional fields whose default/inactive payload is omitted from
 *  the default bare briefing so startup does not carry default-only adjective
 *  noise. They remain declared in PRIME_STRUCTURED_FIELDS (selectable via
 *  `--fields` and advertised in `source_contract.fields`) and are recovered
 *  through `state_presence` (missing-vs-empty semantics) plus a named
 *  authoritative command. The full payload kept by `buildOrientationJsonPayload`
 *  still populates them, so explicit `--fields <name>` selection, the text
 *  briefing, and downstream state consumers are unaffected. */
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
  // absent state; recover via the canonical docs list command).
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
    fetch_command: preCutoverCommand("prime --context status --format json"),
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
  const startup = startupAggregation(capabilityContext("status") ?? {}, state.health as unknown as JsonObject, state.state_cutover as unknown as JsonObject);
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
    outcome: startup.outcome,
    app_home: appHome,
    app: bundlePublic,
    mode: state.mode,
    v1_migration: state.v1_migration,
    shared_skill: state.shared_skill,
    project_integration: state.project_integration,
    health: state.health,
    todo: { ...state.counts, detail: state.todo_detail },
    plan: startupPlanSummary(state.plan),
    docs: state.docs,
    progress: state.progress,
    objective: state.objective,
    state_presence: state.state_presence,
    attention: projectPublicOrientationAttention(state).map((item) => truncateCodePoints(item, 200, "…")),
    decision_attention: state.decision_attention,
    history: state.history,
    next_action: nextActionPayload(state),
    startup,
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
      empty_state: "fresh: summaries absent; zero TODO items",
       capability_context: capabilityContextPointer(options.capabilityContextRequiredBeforeRendering ?? true),
    },
  };
}

/** The status dashboard consumes a compact view of the one startup aggregation. */
export function buildStatusContextState(
  state: OrientationState,
  _command = "prime",
  _options: { budgetBytes?: number; degradedMode?: "minimal" | "status_routing" } = {},
): Record<string, unknown> {
  const startup = startupAggregation(capabilityContext("status") ?? {}, state.health as unknown as JsonObject, state.state_cutover as unknown as JsonObject);
  const plan = state.plan;
  const firstPending = plan.first_pending && typeof plan.first_pending === "object" && !Array.isArray(plan.first_pending)
    ? plan.first_pending as JsonObject
    : null;
  return {
    outcome: startup.outcome,
    mode: state.mode,
    project_integration: {
      recommendation: state.project_integration.recommendation,
      ...(state.project_integration.message ? { message: state.project_integration.message } : {}),
      ...(state.project_integration.dry_run_command ? { dry_run_command: state.project_integration.dry_run_command } : {}),
      ...(state.project_integration.apply_command ? { apply_command: state.project_integration.apply_command } : {}),
    },
    health: {
      exists: state.health.exists,
      status: state.health.status ?? null,
      id: state.health.id ?? null,
      grade: state.health.grade ?? null,
      worst: state.health.worst ?? null,
      trajectory: state.health.trajectory ?? null,
      degrading: Boolean(state.health.degrading),
    },
    todo: { ...state.counts, detail: state.todo_detail },
    plan: {
      exists: plan.exists,
      active: plan.active ?? false,
      status: plan.status,
      title: plan.title ?? null,
      complete: plan.complete ?? 0,
      total: plan.total ?? 0,
      complete_plan: plan.complete_plan ?? false,
      first_pending: firstPending ? {
        id: firstPending.id ?? null,
        artifact: firstPending.artifact ?? "plan",
        name: firstPending.name ?? firstPending.title ?? null,
        status: firstPending.status ?? null,
      } : null,
    },
    progress: { exists: state.progress.exists, status: state.progress.status ?? null, latest: state.progress.latest ?? null },
    objective: { exists: state.objective.exists, active: state.objective.active ?? false, title: state.objective.title ?? null },
    state_presence: state.state_presence,
    attention: projectPublicOrientationAttention(state).map((item) => truncateCodePoints(item, 200, "…")),
    next_action: nextActionPayload(state),
  };
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
  const retiredRejection = rejectRetiredPrimeFields(command, format, fieldsArg, out, err);
  if (retiredRejection !== null) return retiredRejection;
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

/** Reject a retired selector before state collection or output projection. Text
 *  mode uses JSON because a retired-field request is an automation-shaped
 *  selector and must return one machine-readable correction, not a briefing. */
export function rejectRetiredPrimeFields(
  command: string,
  format: string,
  fieldsArg: string | null | undefined,
  out: (t: string) => void,
  err: (t: string) => void,
): number | null {
  const requested = requestedFields(fieldsArg);
  const retired = requested.find((field) => field in RETIRED_PRIME_FIELD_CORRECTIONS);
  if (retired === undefined) return null;
  const replacement = RETIRED_PRIME_FIELD_CORRECTIONS[retired as keyof typeof RETIRED_PRIME_FIELD_CORRECTIONS];
  return emitInvalidInput({ out, err }, {
    format: format === "yaml" ? "yaml" : "json",
    body: {
      class: "invalid_choice",
      message: `prime field '${retired}' is retired; use '${replacement}'`,
      valid_values: [replacement],
      syntax: preCutoverCommand(`${command} --fields ${replacement} --format json`),
      example: preCutoverCommand(`${command} --fields ${replacement} --format json`),
      recovery: `Replace '${retired}' with '${replacement}' and retry; no state was changed.`,
    },
  });
}

export function printOrientationTextBriefing(state: OrientationState, command: string, out: (t: string) => void): void {
  const bundle = state.app;
  const mode = state.mode;
  const health = state.health;
  const counts = state.counts;
  const plan = state.plan;
  const objective = state.objective;
  const presence = state.state_presence;
  const attention = state.attention;
  const nextAction = state.next_action;
  const dashboardLabel = command === "prime" ? "prime orientation dashboard" : "prime orientation dashboard";

  out(`${preCutoverCommand(command)}\n`);
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
  const startup = startupAggregation(capabilityContext("status") ?? {}, state.health as unknown as JsonObject, state.state_cutover as unknown as JsonObject);
  out(`outcome: ${String(startup.outcome)}\n`);
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
        `detail=summary-only | recovery=${preCutoverCommand("state health list --limit 20 --format json")}\n`,
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
        `detail=summary-only | recovery=${preCutoverCommand("state progress list --limit 20 --format json")}\n`,
    );
  }
  const decisionHistory = (state.history.decisions as Record<string, unknown> | undefined)?.degraded_history as Record<string, unknown> | undefined;
  if (decisionHistory) {
    out(
      `decisions: degraded_history | summaries=${String(decisionHistory.summary_count ?? 0)} | returned=${String(decisionHistory.returned_count ?? 0)} | omitted=${String(decisionHistory.omitted_count ?? 0)} | ` +
      `detail=summary-only | recovery=${preCutoverCommand("state decisions list --limit 20 --format json")}\n`,
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
  out(`- startup_outcome=${String(startup.outcome)}\n`);
  out(`- capability_context: fetch rendering instructions via \`${preCutoverCommand("prime --context status --format json")}\`\n`);
  out(`- detail_discovery=${String((startup.detail_discovery as JsonObject).schema)}\n`);
  out(
    `- raw_artifact_reads_required=${String(startup.raw_artifact_reads_required).toLowerCase()}; policy=${startup.raw_artifact_read_policy}\n`,
  );
  const deferred = (startup.availability as JsonObject[])
    .filter((entry) => entry.availability === "deferred")
    .map((entry) => String(entry.family));
  out(`- deferred_detail=${deferred.join(", ") || "none"}\n`);
}
