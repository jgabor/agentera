import type { JsonObject, JsonValue } from "../../../core/jsonValue.js";
import { truncateCodePoints } from "../../../core/text.js";
import { entityListFamily } from "../../../state/entityRetrievalHelp.js";
import { preCutoverCommand } from "../../preCutoverCommand.js";
import { STATE_FAMILY_FALLBACK_COMMANDS } from "../../capabilityContext/types.js";
import { BriefBudgetError, briefByteGate, briefUtf8Bytes, PRIME_BRIEF_MAX_UTF8_BYTES, settledBriefEnvelope } from "./briefByteBudget.js";

export { BriefBudgetError, briefByteGate, briefUtf8Bytes, PRIME_BRIEF_MAX_UTF8_BYTES } from "./briefByteBudget.js";

/**
 * Bounded default decision brief for the bare `agentera prime`
 * emission (Plan Task 3).
 *
 * The bare default projects the full orientation payload
 * ({@link buildOrientationJsonPayload}) to a bounded decision brief: active
 * top-level fields stay present, but rich diagnostic/writer detail within
 * them is projected to routing-essential leaves. Every list is bounded by
 * construction, and each omitted or cut detail is named in `brief.omitted`
 * with the exact command that returns it. Values that repeat elsewhere in the
 * same output (startup rows, the attention summary) are not copied. Explicit
 * fields and capability contexts retain their separately governed
 * projections.
 *
 * The byte gate is deterministic pretty-JSON UTF-8 measurement
 * (Buffer.byteLength(JSON.stringify(brief, null, 2) + "\n", "utf8")); an
 * over-budget brief is rejected in favor of a bounded degraded envelope.
 * Diagnostics stay on stderr and are measured separately. The state-storage
 * authority owns the briefing budget.
 */

/** Collects every omission the projection makes, keyed by field path, with the
 *  exact command that returns the omitted detail. Only detail present in the
 *  source payload and absent from the brief is named, so a fresh project lists
 *  nothing it does not have. */
type Omissions = Record<string, string>;

/** Bare-brief list bounds. Overflow entries are dropped whole and named in
 *  `brief.omitted`. Attention is not cut here: the glossary caveat contract
 *  fixes its public limit and reserves the final slot, and upstream already
 *  applies both. */
const BRIEF_DECISION_MAX_ENTRIES = 1;
const BRIEF_DECISION_TITLE_MAX_CHARS = 80;
const BRIEF_ACCEPTANCE_MAX_ENTRIES = 1;
const BRIEF_DEPENDENCY_MAX_ENTRIES = 10;

/** The brief routes to the recommended action only. Ranked alternatives are
 *  named in `brief.omitted` with the status startup that lists them all. */
const BRIEF_NEXT_ACTION_ALTERNATIVES = 0;

function statusContinuation(): string {
  return preCutoverCommand("prime --context status");
}

/** Code-point cap for scalars that carry an exact trailing reference or a
 *  recovery path (attention lines, state-presence absence reasons). Matches the
 *  boundStartupValue 200-cp limit applied upstream, so the brief never cuts the
 *  reference those values end with. */
const BRIEF_SCALAR_MAX_CHARS = 200;

/** Code-point cap for free prose (titles, task names, progress what/next,
 *  reasons, trajectories). The full value recovers through the record's exact
 *  get command. */
const BRIEF_PROSE_MAX_CHARS = 100;

type SourceContractProjection = "normal" | "compact" | "irreducible";

function projectionMaxChars(projection: SourceContractProjection): number {
  return projection === "normal" ? BRIEF_PROSE_MAX_CHARS : projection === "compact" ? 80 : 32;
}

function projectionDiagnosticMaxChars(projection: SourceContractProjection): number {
  return projection === "irreducible" ? 16 : projectionMaxChars(projection);
}

/** Keys owned by the state-presence contract. Unknown keys are caller data, not
 * routing signals, so the brief never copies them into a fallback envelope. */
const STATE_PRESENCE_ACTIVE_KEYS = ["plan", "objective"] as const;
const STATE_PRESENCE_AVAILABLE_KEYS = ["plan", "docs", "progress", "health", "objective"] as const;
const STATE_PRESENCE_ABSENCE_KEYS = ["plan", "docs", "progress"] as const;

const BRIEF_SOURCE_STRING_MAX_CHARS = 256;
const BRIEF_COMPACT_SOURCE_STRING_MAX_CHARS = 96;
const BRIEF_IRREDUCIBLE_SOURCE_STRING_MAX_CHARS = 16;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Phase detail is worth naming only when a phase has items or blockers; an
 *  all-zero phase summary adds nothing doctor would show. */
function hasPhaseDetail(phases: unknown): boolean {
  if (!isObject(phases)) return false;
  return Object.values(phases).some((phase) => isObject(phase) && (isNonEmptyList(phase.blockers) || (isObject(phase.counts) && Number(phase.counts.total) > 0)));
}

/** Copy only the listed keys that exist on `source`. Keeps the brief stable when
 *  a conditional field is absent (e.g. plan.first_pending on an empty plan). */
function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(source)) return {};
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? truncateCodePoints(value, maxChars, "…") : undefined;
}

function boundedStringList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, maxItems)
    .map((entry) => truncateCodePoints(entry, maxChars, "…"));
}

function boundedBooleanMap(value: unknown, keys: readonly string[]): Record<string, boolean> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const key of keys) {
    if (typeof value[key] === "boolean") out[key] = value[key] as boolean;
  }
  return out;
}

function boundedStringMap(value: unknown, keys: readonly string[], maxChars: number): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const bounded = boundedString(value[key], maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

/** Project the presence authority to its finite, contract-owned shape. This is
 * deliberately not a generic object trim: unknown caller keys cannot change
 * routing, and therefore must not be allowed to consume the fallback budget. */
function briefStatePresence(value: unknown, maxChars = BRIEF_SCALAR_MAX_CHARS): Record<string, unknown> | null {
  if (value === null || value === undefined) return value === null ? null : {};
  if (!isObject(value)) return {};
  const out: Record<string, unknown> = {};
  const active = boundedBooleanMap(value.active, STATE_PRESENCE_ACTIVE_KEYS);
  const available = boundedBooleanMap(value.available, STATE_PRESENCE_AVAILABLE_KEYS);
  const absence = boundedStringMap(value.absence, STATE_PRESENCE_ABSENCE_KEYS, maxChars);
  if (active !== undefined) out.active = active;
  if (available !== undefined) out.available = available;
  if (typeof value.any_active === "boolean") out.any_active = value.any_active;
  if (typeof value.absence_explained === "boolean") out.absence_explained = value.absence_explained;
  if (absence !== undefined) out.absence = absence;
  return out;
}

function briefSelectedPlanTask(task: unknown, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> | null {
  if (task === null) return null;
  if (!isObject(task)) return {};
  const maxChars = projectionMaxChars(projection);
  const out = pick(task, ["id", "artifact", "status", "acceptance_count"]);
  const name = boundedString(task.name ?? task.title, maxChars);
  if (name !== undefined) out.name = name;
  const getCommand = isObject(task.retrieval) && typeof task.retrieval.get === "string" ? task.retrieval.get : undefined;
  // Dependency IDs are exact identities: drop whole IDs past the bound, never
  // shorten one.
  if (Array.isArray(task.depends_on)) {
    const dependencies = task.depends_on.filter((entry): entry is string => typeof entry === "string");
    out.depends_on = dependencies.slice(0, BRIEF_DEPENDENCY_MAX_ENTRIES);
    if (dependencies.length > BRIEF_DEPENDENCY_MAX_ENTRIES && getCommand) omitted["plan.first_pending.depends_on"] = getCommand;
  }
  // Keep one executable criterion; the exact get command returns the rest.
  if (Array.isArray(task.acceptance)) {
    const source: unknown[] = task.acceptance;
    const acceptance = boundedStringList(source, BRIEF_ACCEPTANCE_MAX_ENTRIES, BRIEF_PROSE_MAX_CHARS) ?? [];
    out.acceptance = acceptance;
    const cut = source.length > acceptance.length || acceptance.some((entry, index) => entry !== source[index]);
    if (cut && getCommand) omitted["plan.first_pending.acceptance"] = getCommand;
  }
  if (getCommand) out.retrieval = { get: getCommand };
  return out;
}

function briefPlan(plan: unknown, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> {
  // Keep canonical plan identity, progress counts, and the selected task. The
  // task catalog, archive catalog, and diagnostics are named in
  // `brief.omitted`; the plan list command is already startup's plan row.
  const out = pick(plan, ["exists", "id", "artifact", "active", "status", "complete", "total", "complete_plan"]);
  if (!isObject(plan)) return out;
  const title = boundedString(plan.title, projectionMaxChars(projection));
  if (title !== undefined) out.title = title;
  if (Number(plan.total) > 0 || isNonEmptyList(plan.tasks)) omitted["plan.tasks"] = planTaskListCommand();
  if (isNonEmptyList(plan.archived_plans)) omitted["plan.archived_plans"] = STATE_FAMILY_FALLBACK_COMMANDS.plan;
  if (isNonEmptyList(plan.diagnostics)) omitted["plan.diagnostics"] = STATE_FAMILY_FALLBACK_COMMANDS.plan;
  if ("first_pending" in plan) {
    out.first_pending = briefSelectedPlanTask(plan.first_pending, projection, omitted);
  }
  return out;
}

function planTaskListCommand(): string {
  return preCutoverCommand(`state ${entityListFamily("plan_tasks").commandTokens.join(" ")} list`);
}

/** Caveats are evidence, not free prose: the normal tier keeps the 200-point
 *  scalar bound, smaller tiers never cut the compacted-history caveat below
 *  160 points, and a caveat's recovery command is never shortened. */
function briefHistoryCaveats(value: unknown, projection: SourceContractProjection): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const maxChars = projection === "normal" ? BRIEF_SCALAR_MAX_CHARS : projectionMaxChars(projection);
  return value.slice(0, 4).map((caveat) => {
    if (typeof caveat === "string") return truncateCodePoints(caveat, caveat.includes("incomplete historical evidence") ? Math.max(maxChars, 160) : maxChars, "…");
    if (!isObject(caveat)) return {};
    const out: Record<string, unknown> = {};
    for (const key of ["class", "kind", "state", "confidence", "satisfaction_state", "message", "reason", "detail_availability", "compatibility", "recovery"]) {
      const bounded = boundedString(caveat[key], key === "recovery" ? BRIEF_SOURCE_STRING_MAX_CHARS : maxChars);
      if (bounded !== undefined) out[key] = bounded;
    }
    if (typeof caveat.review_needed === "boolean") out.review_needed = caveat.review_needed;
    return out;
  });
}

function briefHistory(history: unknown, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> {
  if (!isObject(history)) return {};
  const out: Record<string, unknown> = {};
  for (const [artifactId, entry] of Object.entries(history)) {
    // Entity startup history owns canonical full/summary counts. The brief
    // never carries entries: a family with records names its exact list
    // command in `brief.omitted` instead of repeating it here. Per-family
    // storage authority and cursor kinds are static and live in `schema`.
    const entryObj = isObject(entry) ? (entry as Record<string, unknown>) : {};
    const counts = isObject(entryObj.counts) ? (entryObj.counts as Record<string, unknown>) : {};
    const projected: Record<string, unknown> = {
      ...pick(entryObj, ["artifact", "status", "compatibility"]),
      counts: pick(counts, ["total", "full", "summary"]),
    };
    const list = isObject(entryObj.retrieval) ? entryObj.retrieval.list : undefined;
    if (Number(counts.total) > 0) omitted[`history.${artifactId}.entries`] = typeof list === "string" ? list : (STATE_FAMILY_FALLBACK_COMMANDS[artifactId] ?? statusContinuation());
    const caveats = briefHistoryCaveats(entryObj.caveats, projection);
    if (caveats !== undefined) projected.caveats = caveats;
    if (isObject(entryObj.degraded_history)) {
      const degraded = pick(entryObj.degraded_history, ["summary_count", "returned_count", "omitted_count"]);
      const degradedCaveats = briefHistoryCaveats(entryObj.degraded_history.caveats, projection);
      if (degradedCaveats !== undefined) degraded.caveats = degradedCaveats;
      projected.degraded_history = degraded;
    }
    out[artifactId] = projected;
  }
  return out;
}

function briefProjectIntegration(integration: unknown, maxChars: number, omitted: Omissions): Record<string, unknown> {
  // Keep the routing recommendation, message, pending counts, channel,
  // aggregate status, and any major-boundary block (which overrides
  // next_action). Upgrade commands are part of the executable upgrade route;
  // preserve them only for that recommendation. Phase blockers and guidance
  // detail recover via doctor.
  const fields = ["recommendation", "update_channel", "pending_artifacts", "aggregate_status", "major_boundary_block"];
  if (isObject(integration) && integration.recommendation === "upgrade") {
    fields.push("dry_run_command", "apply_command");
  }
  const out = pick(integration, fields);
  const message = isObject(integration) ? boundedString(integration.message, maxChars) : undefined;
  if (message !== undefined) out.message = message;
  if (isObject(integration) && hasPhaseDetail(integration.phases)) omitted["project_integration.phases"] = preCutoverCommand("doctor");
  return out;
}

function briefProfile(profile: unknown): Record<string, unknown> {
  // opencode reads profile.status; the dashboard glyph reads profile.status.
  // bounded_signals (a legacy recovery blob) is omitted and recovers via
  // `agentera profile`.
  return pick(profile, ["status", "validity", "freshness", "days_since_generated", "stale", "stale_threshold_days", "generated_date", "validated_date", "suggested_action"]);
}

function briefApp(app: unknown): Record<string, unknown> {
  // `app` is required for app/v1/profile safety, but no default-bare consumer
  // reads its verbose path list (the packaging gate reads app_home.source).
  // Keep safety identity; path diagnostics recover through doctor so checkout
  // depth cannot displace routing or canonical history evidence.
  return pick(app, ["status", "expectedVersion", "updateChannel"]);
}

function briefAppHome(appHome: unknown): Record<string, unknown> {
  return pick(appHome, ["install_track", "status", "source"]);
}

function briefSharedSkill(sharedSkill: unknown, maxChars = BRIEF_SCALAR_MAX_CHARS): Record<string, unknown> {
  if (!isObject(sharedSkill)) return {};
  const out = pick(sharedSkill, ["name", "status", "source", "gap", "upgrade_offer"]);
  const message = boundedString(sharedSkill.message, maxChars);
  if (message !== undefined) out.message = message;
  if (Array.isArray(sharedSkill.details) && sharedSkill.details.length) {
    out.detail_availability = "summary";
    out.detail_command = preCutoverCommand("prime --fields shared_skill");
  }
  return out;
}

function briefSource(source: unknown): Record<string, unknown> {
  return pick(source, ["artifacts_present"]);
}

function briefAttention(attention: unknown): unknown {
  // The public attention list is already bounded upstream (count and the
  // glossary caveat's reserved final slot). Each line ends with an exact
  // reference, so it keeps the upstream 200-point bound and is never cut
  // shorter.
  if (!Array.isArray(attention)) return attention ?? [];
  return attention.map((entry) => (typeof entry === "string" ? truncateCodePoints(entry, BRIEF_SCALAR_MAX_CHARS, "…") : entry));
}

function briefDecisionAttention(attention: unknown, omitted: Omissions): Record<string, unknown> | null {
  // The summary line already appears in `attention`; the brief keeps the count
  // and the first review entries with their exact get commands.
  if (attention === null) return null;
  if (!isObject(attention)) return {};
  const out = pick(attention, ["type", "count"]);
  const entries = Array.isArray(attention.entries) ? attention.entries : [];
  out.entries = entries.slice(0, BRIEF_DECISION_MAX_ENTRIES).map((entry) => {
    if (!isObject(entry)) return {};
    // The state-storage authority requires review entries to keep
    // review_needed, their meaning, source gaps, and exact retrieval.
    const projected = pick(entry, ["id", "state", "review_needed", "detail_availability"]);
    const title = boundedString(entry.title, BRIEF_DECISION_TITLE_MAX_CHARS);
    if (title !== undefined) projected.title = title;
    if (isObject(entry.retrieval) && typeof entry.retrieval.get === "string") projected.retrieval = { get: entry.retrieval.get };
    return projected;
  });
  const shown = (out.entries as unknown[]).length;
  if (Number(attention.count) > shown || entries.length > shown || attention.bounded === true) omitted["decision_attention.entries"] = STATE_FAMILY_FALLBACK_COMMANDS.decisions;
  return out;
}

function briefDocs(docs: unknown, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> {
  // Docs routing needs presence, status, and size. Individual entries and the
  // docs source contract recover through the docs list command, which is also
  // startup's docs row.
  if (!isObject(docs)) return {};
  const maxChars = projectionMaxChars(projection);
  const out = pick(docs, ["exists", "status", "last_audit", "mapping_entries", "indexed_documents"]);
  const absenceReason = boundedString(docs.absence_reason, maxChars);
  if (absenceReason !== undefined) out.absence_reason = absenceReason;
  const caveats = briefHistoryCaveats(docs.caveats, projection);
  if (caveats !== undefined) out.caveats = caveats;
  if ((Array.isArray(docs.entries) && docs.entries.length > 0) || Number(docs.indexed_documents) > 0) omitted["docs.entries"] = STATE_FAMILY_FALLBACK_COMMANDS.docs;
  return out;
}

function briefDegradedHistory(value: unknown, omitRetrieval: boolean): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  if (!omitRetrieval) return { ...value };
  const out = pick(value, ["status", "summary_count", "returned_count", "omitted_count", "caveats"]);
  return out;
}

function briefProgress(progress: unknown, omitDegradedRetrieval = false, maxChars = BRIEF_PROSE_MAX_CHARS): Record<string, unknown> {
  // The brief keeps the latest cycle but caps free-text scalars so a long
  // value cannot displace routing. Full detail recovers via
  // `agentera state progress get --id ID`.
  if (!isObject(progress)) return {};
  const out = pick(progress, ["exists", "status", "cycle_count", "detail_omission"]);
  const degradedHistory = briefDegradedHistory(progress.degraded_history, omitDegradedRetrieval);
  if (degradedHistory !== undefined) out.degraded_history = degradedHistory;
  const latest = progress.latest;
  if (isObject(latest)) {
    const boundedLatest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(latest)) {
      boundedLatest[key] = typeof value === "string" ? truncateCodePoints(value, maxChars, "…") : value;
    }
    out.latest = boundedLatest;
  } else {
    out.latest = latest;
  }
  return out;
}

function briefTodo(todo: unknown): Record<string, unknown> {
  if (!isObject(todo)) return {};
  if (typeof todo.critical !== "number" || !isObject(todo.detail)) return todo;
  const out = pick(todo, ["critical", "degraded", "normal", "annoying"]);
  out.detail = {
    ...pick(todo.detail, ["total", "returned", "omitted"]),
    retrieval: {
      list: STATE_FAMILY_FALLBACK_COMMANDS.todo,
      get: preCutoverCommand("state todo get --id ID"),
    },
  };
  return out;
}

function briefHealth(health: unknown, omitDegradedRetrieval = false, maxChars = BRIEF_PROSE_MAX_CHARS): Record<string, unknown> {
  const out = pick(health, ["exists", "id", "artifact", "date", "grade"]);
  if (isObject(health)) {
    const trajectory = boundedString(health.trajectory, maxChars);
    if (trajectory !== undefined) out.trajectory = trajectory;
    const degradedHistory = briefDegradedHistory(health.degraded_history, omitDegradedRetrieval);
    if (degradedHistory !== undefined) out.degraded_history = degradedHistory;
  }
  return out;
}

function hasCanonicalHistoryRetrieval(history: unknown, artifact: "progress" | "health"): boolean {
  if (!isObject(history) || !isObject(history[artifact])) return false;
  const retrieval = history[artifact].retrieval;
  return isObject(retrieval) && typeof retrieval.list === "string" && retrieval.list.length > 0 && typeof retrieval.get === "string" && retrieval.get.length > 0;
}

function briefAction(action: unknown, maxChars: number): Record<string, unknown> {
  if (!isObject(action)) return {};
  const out = pick(action, ["id", "artifact", "outcome", "eligible"]);
  for (const key of ["object", "capability", "reason", "phase"] as const) {
    // Entity action labels are already bounded to 110 points at composition.
    // The irreducible tier may shorten reasons, but must not cut off identity.
    const entityLabel = key === "object" && typeof action.id === "string" && ["plan", "todo", "decisions"].includes(String(action.artifact));
    const bounded = boundedString(action[key], entityLabel ? Math.max(maxChars, 110) : maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  if (isObject(action.retrieval)) out.retrieval = pick(action.retrieval, ["exact", "get"]);
  return out;
}

function briefNextAction(nextAction: unknown, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> {
  if (!isObject(nextAction)) return {};
  const maxChars = projectionMaxChars(projection);
  const alternativeLimit = projection === "normal" ? BRIEF_NEXT_ACTION_ALTERNATIVES : 0;
  const source = Array.isArray(nextAction.alternatives) ? (nextAction.alternatives as JsonValue[]) : [];
  if (source.length > alternativeLimit) omitted["next_action.alternatives"] = statusContinuation();
  const alternatives = source.slice(0, alternativeLimit).map((entry) => briefAction(entry, maxChars));
  return {
    ...briefAction(nextAction, maxChars),
    alternatives,
  };
}

function briefCapabilityContext(value: unknown, maxChars: number): Record<string, unknown> {
  if (!isObject(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["capability", "fetch_command", "note"] as const) {
    // The fetch command is the continuation; shortening it would leave a
    // command that cannot run. It keeps the normal-tier bound in every tier.
    const bounded = boundedString(value[key], key === "fetch_command" ? BRIEF_SOURCE_STRING_MAX_CHARS : maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  if (typeof value.required_before_rendering === "boolean") {
    out.required_before_rendering = value.required_before_rendering;
  }
  return out;
}

function briefSourceContract(sourceContract: unknown, projection: SourceContractProjection = "normal"): Record<string, unknown> {
  if (!isObject(sourceContract)) return {};
  const maxChars = projection === "normal" ? BRIEF_SOURCE_STRING_MAX_CHARS : projection === "compact" ? BRIEF_COMPACT_SOURCE_STRING_MAX_CHARS : BRIEF_IRREDUCIBLE_SOURCE_STRING_MAX_CHARS;
  // The bare brief does not repeat the structured field list: `schema` owns
  // it, and `--fields` selection returns the full source contract.
  const out: Record<string, unknown> = {};
  for (const key of ["render", "access", "empty_state"] as const) {
    const bounded = boundedString(sourceContract[key], maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  if (projection !== "irreducible" && isObject(sourceContract.capability_context)) {
    out.capability_context = briefCapabilityContext(sourceContract.capability_context, maxChars);
  } else if (projection === "irreducible" && isObject(sourceContract.capability_context)) {
    const capabilityContext = briefCapabilityContext(sourceContract.capability_context, maxChars);
    if ("fetch_command" in capabilityContext) {
      out.capability_context = { fetch_command: capabilityContext.fetch_command };
    }
  }
  return out;
}

/** Project the full orientation payload to a bounded decision brief. The brief
 *  keeps every required top-level field present (content projected to
 *  routing-essential leaves) plus a `brief` meta block that records the budget,
 *  measured bytes, projection, and an `omitted` map from field path to the
 *  exact continuation command.
 *
 *  Measurement uses deterministic pretty-JSON UTF-8 byte length including the
 *  trailing newline. The reported `utf8_bytes` is settled to a fixed point so
 *  it equals the actual emitted byte count (self-measurement otherwise changes
 *  its own digit count); the gate then decides on the final form. */
export function briefOrientationPayload(payload: Record<string, unknown>, options: { budgetBytes?: number; degradedMode?: "minimal" | "status_routing" } = {}): Record<string, unknown> {
  const budget = options.budgetBytes ?? PRIME_BRIEF_MAX_UTF8_BYTES;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError("brief budget must be a non-negative safe integer");
  }
  const projected = projectBriefBody(payload);
  const finalPayload = withBriefMeta(projected.body, "ok", budget, projected.omitted, null);
  const gate = briefByteGate(finalPayload, budget);
  if (gate.accepted) {
    return finalPayload;
  }
  // Over-budget brief: reject the projected payload and emit a bounded degraded
  // envelope (never emit an over-budget payload). The envelope keeps bounded
  // plan/next-action/history/decision routing evidence, state presence, a brief
  // source contract, and the byte-budget error with a recovery command.
  return degradedBriefEnvelope(payload, budget, gate.bytes, options.degradedMode ?? "minimal");
}

/** Attach the brief meta block and settle `utf8_bytes` to a fixed point so the
 *  reported size equals the actual emitted byte count (otherwise the digits of
 *  `utf8_bytes` itself would change the measurement). */
function withBriefMeta(body: Record<string, unknown>, projection: "ok" | "degraded", budget: number, omitted: Omissions, error: JsonObject | null): Record<string, unknown> {
  const meta: JsonObject = {
    budget_utf8_bytes: budget,
    projection,
    omitted: { ...omitted },
  };
  if (error) meta.error = error;
  return settledBriefEnvelope(body, meta);
}

/** Inactive bespoke contexts are null on bare prime; they stay selectable with
 *  `--fields` and are omitted from the brief like other inactive conditionals. */
const BRIEF_NULL_OMITTED_FIELDS: readonly string[] = ["orchestration_context", "closeout_context", "evidence_context", "benchmark_context", "execution_context"];

function projectBriefBody(payload: Record<string, unknown>): { body: Record<string, unknown>; omitted: Omissions } {
  const out: Record<string, unknown> = {};
  const omitted: Omissions = {};
  for (const [key, value] of Object.entries(payload)) {
    switch (key) {
      case "plan":
        out[key] = briefPlan(value, "normal", omitted);
        break;
      case "history":
        out[key] = briefHistory(value, "normal", omitted);
        break;
      case "project_integration":
        out[key] = briefProjectIntegration(value, BRIEF_SCALAR_MAX_CHARS, omitted);
        break;
      case "profile":
        out[key] = briefProfile(value);
        break;
      case "app":
        out[key] = briefApp(value);
        break;
      case "app_home":
        out[key] = briefAppHome(value);
        break;
      case "shared_skill":
        out[key] = briefSharedSkill(value);
        break;
      case "progress":
        out[key] = briefProgress(value, hasCanonicalHistoryRetrieval(payload.history, "progress"));
        break;
      case "todo":
        out[key] = briefTodo(value);
        break;
      case "health":
        out[key] = briefHealth(value, hasCanonicalHistoryRetrieval(payload.history, "health"));
        break;
      case "next_action":
        out[key] = briefNextAction(value, "normal", omitted);
        break;
      case "attention":
        out[key] = briefAttention(value);
        break;
      case "decision_attention":
        out[key] = briefDecisionAttention(value, omitted);
        break;
      case "docs":
        out[key] = briefDocs(value, "normal", omitted);
        break;
      case "source_contract":
        out[key] = briefSourceContract(value);
        break;
      case "state_presence":
        out[key] = briefStatePresence(value);
        break;
      case "source":
        out[key] = briefSource(value);
        break;
      default:
        if (value === null && BRIEF_NULL_OMITTED_FIELDS.includes(key)) break;
        // Command/outcome/mode, bounded ordinary state, shared-skill diagnosis,
        // active bespoke contexts, and active conditional fields pass through
        // at full fidelity.
        out[key] = value;
        break;
    }
  }
  return { body: out, omitted };
}

function boundedEnvelopeScalar(value: unknown, fallback: string): string {
  return boundedString(value, BRIEF_SCALAR_MAX_CHARS) ?? fallback;
}

function briefStartup(startup: unknown, maxChars: number): unknown {
  if (!isObject(startup)) return startup;
  const out = { ...startup };
  const policy = boundedString(startup.raw_artifact_read_policy, maxChars);
  if (policy !== undefined) out.raw_artifact_read_policy = policy;
  return out;
}

function degradedBody(payload: Record<string, unknown>, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> {
  const maxChars = projectionDiagnosticMaxChars(projection);
  const out: Record<string, unknown> = {
    command: boundedEnvelopeScalar(payload.command, "prime"),
    outcome: boundedEnvelopeScalar(payload.outcome, "ok"),
    mode: boundedEnvelopeScalar(payload.mode, "unknown"),
    state_presence: briefStatePresence(payload.state_presence),
    source_contract: briefSourceContract(payload.source_contract, projection),
  };
  if ("app_home" in payload) out.app_home = briefAppHome(payload.app_home);
  if ("app" in payload) out.app = briefApp(payload.app);
  if ("profile" in payload) out.profile = briefProfile(payload.profile);
  if ("shared_skill" in payload) out.shared_skill = briefSharedSkill(payload.shared_skill, maxChars);
  if ("project_integration" in payload) out.project_integration = briefProjectIntegration(payload.project_integration, maxChars, omitted);
  if ("todo_reconciliation" in payload) out.todo_reconciliation = payload.todo_reconciliation;
  if ("startup" in payload) {
    // The top-level reconciliation object is the canonical bare-prime route.
    // Do not repeat it inside startup when compacting an over-budget envelope.
    const startup = briefStartup(payload.startup, maxChars);
    if (isObject(startup) && "todo_reconciliation" in out) delete startup.todo_reconciliation;
    out.startup = startup;
  }
  if ("health" in payload) out.health = briefHealth(payload.health, hasCanonicalHistoryRetrieval(payload.history, "health"), maxChars);
  if ("todo" in payload) out.todo = briefTodo(payload.todo);
  if ("progress" in payload) out.progress = briefProgress(payload.progress, hasCanonicalHistoryRetrieval(payload.history, "progress"), maxChars);
  if ("attention" in payload) out.attention = briefAttention(payload.attention);
  if ("source" in payload) out.source = briefSource(payload.source);
  if ("docs" in payload) out.docs = briefDocs(payload.docs, projection, omitted);
  for (const conditional of ["objective"] as const) {
    if (conditional in payload) out[conditional] = payload[conditional];
  }
  if (isObject(payload.plan)) out.plan = briefPlan(payload.plan, projection, omitted);
  if (isObject(payload.next_action)) out.next_action = briefNextAction(payload.next_action, projection, omitted);
  if (isObject(payload.history)) out.history = briefHistory(payload.history, projection, omitted);
  if (payload.decision_attention === null) out.decision_attention = null;
  else if (isObject(payload.decision_attention)) out.decision_attention = briefDecisionAttention(payload.decision_attention, omitted);
  return out;
}

function statusRoutingDegradedBody(payload: Record<string, unknown>, projection: SourceContractProjection, omitted: Omissions): Record<string, unknown> {
  return {
    ...degradedBody(payload, projection, omitted),
    todo: briefTodo(payload.todo),
    attention: briefAttention(payload.attention),
  };
}

function degradedBriefEnvelope(payload: Record<string, unknown>, budget: number, attemptedBytes: number, mode: "minimal" | "status_routing"): Record<string, unknown> {
  const statusRecovery = `Run \`${statusContinuation()}\`.`;
  const tier = (projection: SourceContractProjection): { body: Record<string, unknown>; omitted: Omissions } => {
    const omitted: Omissions = {};
    const body = mode === "status_routing" ? statusRoutingDegradedBody(payload, projection, omitted) : degradedBody(payload, projection, omitted);
    return { body, omitted };
  };
  const detailedTier = tier("normal");
  const detailedMeta: JsonObject = {
    budget_utf8_bytes: budget,
    projection: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    omitted: detailedTier.omitted,
    error: {
      class: "brief_output_budget",
      message: "the projected decision brief exceeded the authority byte budget; a bounded degraded envelope was emitted instead of the over-budget payload",
      recovery: `Run \`${statusContinuation()}\` for status startup, or \`${preCutoverCommand("state <artifact> list")}\` for a specific record family.`,
    },
  };
  const detailed = settledBriefEnvelope(detailedTier.body, detailedMeta);
  if (briefByteGate(detailed, budget).accepted) return detailed;

  // A smaller deterministic fallback keeps the omission map but shortens prose
  // and lists further. This is what lets a configured 7KB gate remain
  // enforceable even when caller data would make the detailed envelope too
  // large.
  const compactTier = tier("compact");
  const compactMeta: JsonObject = {
    budget_utf8_bytes: budget,
    projection: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    omitted: compactTier.omitted,
    error: {
      class: "brief_output_budget",
      message: "brief exceeds byte budget",
      recovery: statusRecovery,
    },
  };
  const compact = settledBriefEnvelope(compactTier.body, compactMeta);
  if (briefByteGate(compact, budget).accepted) return compact;

  // The irreducible form is intentionally finite and contains only the routing
  // contract plus one status recovery command in place of the omission map. If
  // even this cannot fit, throwing is explicit: returning an over-budget JSON
  // document would violate the public output contract.
  const minimumMeta: JsonObject = {
    budget_utf8_bytes: budget,
    projection: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    error: {
      class: "brief_output_budget",
      message: mode === "status_routing" ? "brief exceeds byte budget" : "the budget cannot contain the detailed recovery envelope",
      recovery: statusRecovery,
    },
  };
  const minimum = settledBriefEnvelope(tier("irreducible").body, minimumMeta);
  const minimumBytes = briefUtf8Bytes(minimum);
  if (minimumBytes <= budget) return minimum;
  throw new BriefBudgetError(budget, minimumBytes);
}
