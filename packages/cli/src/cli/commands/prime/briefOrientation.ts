import type { JsonObject, JsonValue } from "../../../core/jsonValue.js";
import { truncateCodePoints } from "../../../core/text.js";
import { entityListFamily } from "../../../state/entityRetrievalHelp.js";
import { preCutoverCommand } from "../../preCutoverCommand.js";
import { STATE_FAMILY_FALLBACK_COMMANDS } from "../../capabilityContext/types.js";

/**
 * Bounded default decision brief for the bare `agentera prime --format json`
 * emission (Plan Task 3).
 *
 * The bare default projects the full orientation payload
 * ({@link buildOrientationJsonPayload}) to a bounded decision brief: every
 * required top-level field stays PRESENT (the compatibility boundary asserts
 * the key set), but rich diagnostic/writer detail within those fields is
 * projected to routing-essential leaves plus a named authoritative recovery
 * command for each omitted sub-detail. Dashboard startup independently omits
 * duplicated ordinary history entries; explicit fields and capability contexts
 * retain their separately governed projections.
 *
 * The byte gate is deterministic pretty-JSON UTF-8 measurement
 * (Buffer.byteLength(JSON.stringify(brief, null, 2) + "\n", "utf8")); an
 * over-budget brief is rejected in favor of a bounded degraded envelope.
 * Diagnostics stay on stderr and are measured separately. The state-storage
 * authority owns the briefing budget.
 */

/** Authoritative byte budget for the default bare prime decision brief.
 *  Mirrors references/artifacts/state-storage-authority.yaml
 *  budgets.startup.surfaces.prime_briefing.max_utf8_bytes and
 *  scripts/json_output_surface_manifest.yaml prime-briefing byte_budget.
 *  archiveAuthority.test.ts binds the authority to the manifest; the
 *  primeProjectionContract.test.ts suite binds this constant to the authority
 *  so the contract and implementation cannot drift apart. */
export const PRIME_BRIEF_MAX_UTF8_BYTES = 12000;

/** Deterministic pretty-JSON UTF-8 byte length (including the trailing newline)
 *  used by the brief byte gate. Identical to the projection-policy serializer
 *  (serializedProjectionBytes) so measurement is consistent across surfaces. */
export function briefUtf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError("brief value is not JSON serializable");
  return Buffer.byteLength(serialized + "\n", "utf8");
}

/** Byte-gate primitive: deterministic UTF-8 measurement + budget comparison.
 *  AC5: a passing fixture (bytes <= budget) is accepted; an over-budget fixture
 *  (bytes > budget) is rejected. */
export function briefByteGate(
  value: unknown,
  budget: number = PRIME_BRIEF_MAX_UTF8_BYTES,
): { accepted: boolean; bytes: number } {
  const bytes = briefUtf8Bytes(value);
  return { accepted: bytes <= budget, bytes };
}

interface OmittedRichStateEntry {
  field: string;
  reason: string;
  recovery: string;
}

/** Rich-state sub-detail projected out of the default brief, each with a named
 *  authoritative recovery command. */
const planTaskFamily = entityListFamily("plan_tasks");
const planTaskListRecovery = preCutoverCommand(`state ${planTaskFamily.commandTokens.join(" ")} list --format json`);

const OMITTED_RICH_STATE: readonly OmittedRichStateEntry[] = [
  { field: "startup.path_diagnostics", reason: "startup_path_diagnostics", recovery: preCutoverCommand("doctor --format json") },
  { field: "plan.tasks", reason: "plan_task_detail", recovery: planTaskListRecovery },
  { field: "plan.archived_plans", reason: "archive_catalog", recovery: STATE_FAMILY_FALLBACK_COMMANDS.plan },
  { field: "plan.diagnostics", reason: "plan_diagnostics", recovery: STATE_FAMILY_FALLBACK_COMMANDS.plan },
  { field: "history.progress.entries", reason: "startup_history_entries", recovery: STATE_FAMILY_FALLBACK_COMMANDS.progress },
  { field: "history.decisions.entries", reason: "startup_history_entries", recovery: STATE_FAMILY_FALLBACK_COMMANDS.decisions },
  { field: "history.health.entries", reason: "startup_history_entries", recovery: STATE_FAMILY_FALLBACK_COMMANDS.health },
  { field: "project_integration.phases", reason: "phase_blockers", recovery: preCutoverCommand("doctor --format json") },
  { field: "docs.source_contract", reason: "docs_state_families", recovery: STATE_FAMILY_FALLBACK_COMMANDS.docs },
  { field: "profile.bounded_signals", reason: "profile_signal_detail", recovery: preCutoverCommand("report profile-grounding --format json") },
];

/** Maximum number of ranked next_action alternatives retained in the brief.
 *  The recommended entry is always kept; overflow alternatives recover via the
 *  state-derived readiness cascade rather than raw artifact access. */
const BRIEF_NEXT_ACTION_ALTERNATIVES = 3;
const PATH_DIAGNOSTICS_RECOVERY = preCutoverCommand("doctor --format json");

/** Code-point cap for routing-essential free-text scalars retained in the brief
 *  (e.g. progress.latest.what/next). Matches the boundStartupValue 200-cp
 *  limit already applied to context payloads so the brief never lets a single
 *  pathological scalar blow the budget; the full value recovers via the named
 *  state command. */
const BRIEF_SCALAR_MAX_CHARS = 200;

type SourceContractProjection = "normal" | "compact" | "irreducible";

function projectionMaxChars(projection: SourceContractProjection): number {
  return projection === "normal" ? BRIEF_SCALAR_MAX_CHARS : projection === "compact" ? 120 : 80;
}

function projectionMaxItems(projection: SourceContractProjection): number {
  return projection === "normal" ? 10 : projection === "compact" ? 6 : 3;
}

/** Keys owned by the state-presence contract. Unknown keys are caller data, not
 * routing signals, so the brief never copies them into a fallback envelope. */
const STATE_PRESENCE_ACTIVE_KEYS = ["plan", "objective"] as const;
const STATE_PRESENCE_AVAILABLE_KEYS = ["plan", "docs", "progress", "health", "objective"] as const;
const STATE_PRESENCE_ABSENCE_KEYS = ["plan", "docs", "progress"] as const;

const BRIEF_SOURCE_FIELDS_MAX = 64;
const BRIEF_SOURCE_STRING_MAX_CHARS = 256;
const BRIEF_COMPACT_SOURCE_FIELDS_MAX = 32;
const BRIEF_COMPACT_SOURCE_STRING_MAX_CHARS = 96;
const BRIEF_IRREDUCIBLE_SOURCE_FIELDS_MAX = 32;
const BRIEF_IRREDUCIBLE_SOURCE_STRING_MAX_CHARS = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function briefSelectedPlanTask(
  task: unknown,
  projection: SourceContractProjection,
): Record<string, unknown> | null {
  if (task === null) return null;
  if (!isObject(task)) return {};
  const maxChars = projectionMaxChars(projection);
  const maxItems = projectionMaxItems(projection);
  const out = pick(task, [
    "id",
    "artifact",
    "status",
    "dependency_count",
    "omitted_dependency_count",
    "acceptance_count",
    "omitted_acceptance_count",
  ]);
  const name = boundedString(task.name ?? task.title, maxChars);
  if (name !== undefined) out.name = name;
  const dependencies = boundedStringList(task.depends_on, maxItems, maxChars);
  if (dependencies !== undefined) out.depends_on = dependencies;
  const acceptance = boundedStringList(task.acceptance, maxItems, maxChars);
  if (acceptance !== undefined) out.acceptance = acceptance;
  if (isObject(task.retrieval)) {
    out.retrieval = pick(task.retrieval, ["get"]);
  }
  return out;
}

function briefPlan(
  plan: unknown,
  projection: SourceContractProjection = "normal",
): Record<string, unknown> {
  // Keep canonical plan/task identity and the routing-essential summary consumers
  // read plus the selected task's dependencies, acceptance, and exact retrieval.
  // Drop the optional task catalog, archive catalog, diagnostics, and
  // lifecycle_state — each recovers via OMITTED_RICH_STATE.
  const out = pick(plan, [
    "exists",
    "id",
    "artifact",
    "active",
    "status",
    "complete",
    "total",
    "complete_plan",
    "task_count",
    "omitted_task_count",
  ]);
  if (isObject(plan)) {
    const title = boundedString(plan.title, projectionMaxChars(projection));
    if (title !== undefined) out.title = title;
    if (isObject(plan.source_contract)) {
      out.source_contract = pick(plan.source_contract, ["detail_availability", "retrieval", "raw_archive_records"]);
    }
  }
  if (isObject(plan) && "first_pending" in plan) {
    out.first_pending = briefSelectedPlanTask(plan.first_pending, projection);
  }
  return out;
}

function briefHistoryRetrieval(value: unknown): Record<string, unknown> {
  return pick(value, ["list", "get"]);
}

function briefHistoryCaveats(value: unknown, maxChars: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 4).map((caveat) => {
    if (typeof caveat === "string") return truncateCodePoints(caveat, maxChars, "…");
    if (!isObject(caveat)) return {};
    const out: Record<string, unknown> = {};
    for (const key of [
      "class",
      "kind",
      "state",
      "confidence",
      "satisfaction_state",
      "message",
      "reason",
      "detail_availability",
      "compatibility",
      "recovery",
    ]) {
      const bounded = boundedString(caveat[key], maxChars);
      if (bounded !== undefined) out[key] = bounded;
    }
    if (typeof caveat.review_needed === "boolean") out.review_needed = caveat.review_needed;
    return out;
  });
}

function briefHistory(
  history: unknown,
  projection: SourceContractProjection = "normal",
): Record<string, unknown> {
  if (!isObject(history)) return {};
  const out: Record<string, unknown> = {};
  const maxChars = projectionMaxChars(projection);
  for (const [artifactId, entry] of Object.entries(history)) {
    // Entity startup history owns canonical full/summary counts. Entry detail
    // remains omitted and recovers through exact list/get commands.
    const entryObj = isObject(entry) ? (entry as Record<string, unknown>) : {};
    const counts = isObject(entryObj.counts) ? entryObj.counts as Record<string, unknown> : {};
    const projected: Record<string, unknown> = {
      ...pick(entryObj, [
        "artifact",
        "status",
        "compatibility",
        "detail_availability",
        "omitted",
        "omitted_count",
        "omission_reason",
      ]),
      counts: pick(counts, ["total", "returned", "remaining", "full", "summary"]),
      retrieval: briefHistoryRetrieval(entryObj.retrieval),
    };
    const caveats = briefHistoryCaveats(entryObj.caveats, maxChars);
    if (caveats !== undefined) projected.caveats = caveats;
    if (isObject(entryObj.degraded_history)) {
      const degraded = pick(entryObj.degraded_history, ["summary_count", "returned_count", "omitted_count"]);
      degraded.retrieval = briefHistoryRetrieval(entryObj.degraded_history.retrieval);
      const degradedCaveats = briefHistoryCaveats(entryObj.degraded_history.caveats, maxChars);
      if (degradedCaveats !== undefined) degraded.caveats = degradedCaveats;
      projected.degraded_history = degraded;
    }
    if (isObject(entryObj.source_contract)) {
      projected.source_contract = pick(entryObj.source_contract, ["authority", "detail", "cursor"]);
    }
    out[artifactId] = projected;
  }
  return out;
}

function briefProjectIntegration(integration: unknown): Record<string, unknown> {
  // Keep the routing recommendation, message, pending counts, channel,
  // aggregate status, and any major-boundary block (which overrides
  // next_action). Upgrade commands are part of the executable upgrade route;
  // preserve them only for that recommendation. Phase blockers and guidance
  // detail recover via doctor.
  const fields = [
    "recommendation",
    "message",
    "update_channel",
    "pending_artifacts",
    "aggregate_status",
    "major_boundary_block",
  ];
  if (isObject(integration) && integration.recommendation === "upgrade") {
    fields.push("dry_run_command", "apply_command");
  }
  return pick(integration, fields);
}

function briefProfile(profile: unknown): Record<string, unknown> {
  // opencode reads profile.status; the dashboard glyph reads profile.status.
  // bounded_signals (a legacy recovery blob) is omitted and recovers via
  // `agentera profile --format json`.
  return pick(profile, [
    "status",
    "validity",
    "freshness",
    "days_since_generated",
    "stale",
    "stale_threshold_days",
    "generated_date",
    "validated_date",
    "suggested_action",
  ]);
}

function briefApp(app: unknown): Record<string, unknown> {
  // `app` is required for app/v1/profile safety, but no default-bare consumer
  // reads its verbose path list (the packaging gate reads app_home.source).
  // Keep safety identity; path diagnostics recover through doctor so checkout
  // depth cannot displace routing or canonical history evidence.
  return pick(app, [
    "status",
    "expectedVersion",
    "updateChannel",
  ]);
}

function briefAppHome(appHome: unknown): Record<string, unknown> {
  return pick(appHome, ["install_track", "status", "source"]);
}

function briefSharedSkill(sharedSkill: unknown): Record<string, unknown> {
  if (!isObject(sharedSkill)) return {};
  const out = pick(sharedSkill, ["name", "status", "source", "gap"]);
  const message = boundedString(sharedSkill.message, BRIEF_SCALAR_MAX_CHARS);
  if (message !== undefined) out.message = message;
  const details = boundedStringList(sharedSkill.details, 3, BRIEF_SCALAR_MAX_CHARS);
  if (details !== undefined) out.details = details;
  return out;
}

function briefSource(source: unknown): Record<string, unknown> {
  return pick(source, ["artifacts_present"]);
}

function briefAttention(attention: unknown): unknown {
  // opencode reads the attention array for routing hints, but each entry is an
  // advisory string. Cap each at BRIEF_SCALAR_MAX_CHARS so a pathological
  // lifecycle procedure text cannot blow the budget; the full detail recovers
  // via the named recovery commands in omitted_rich_state.
  if (!Array.isArray(attention)) return attention ?? [];
  return attention.map((entry) =>
    typeof entry === "string" ? truncateCodePoints(entry, BRIEF_SCALAR_MAX_CHARS, "…") : entry,
  );
}

function briefDecisionAttention(attention: unknown): Record<string, unknown> | null {
  if (attention === null) return null;
  if (!isObject(attention)) return {};
  const out = pick(attention, ["type", "count", "states", "max_entries", "bounded"]);
  const summary = boundedString(attention.attention, BRIEF_SCALAR_MAX_CHARS);
  if (summary !== undefined) out.attention = summary;
  out.entries = Array.isArray(attention.entries)
    ? attention.entries.slice(0, 3).map((entry) => {
        if (!isObject(entry)) return {};
        const projected = pick(entry, ["id", "artifact", "state"]);
        const title = boundedString(entry.title, BRIEF_SCALAR_MAX_CHARS);
        if (title !== undefined) projected.title = title;
        return projected;
      })
    : [];
  return out;
}

function briefDocsRetrieval(value: unknown, maxChars: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isObject(value)) {
    for (const key of ["list", "get", "exact", "detail_command"] as const) {
      const command = boundedString(value[key], maxChars);
      if (command !== undefined) out[key] = command;
    }
  }
  return out;
}

function briefDocEntry(value: unknown, maxChars: number): Record<string, unknown> {
  if (!isObject(value)) return {};
  const out = pick(value, ["id", "artifact"]);
  const source = isObject(value.record) ? value.record : value;
  const record: Record<string, unknown> = {};
  for (const key of ["document", "path", "last_updated", "status"] as const) {
    const bounded = boundedString(source[key], maxChars);
    if (bounded !== undefined) record[key] = bounded;
  }
  const recordCaveats = briefHistoryCaveats(source.caveats, maxChars);
  if (recordCaveats !== undefined) record.caveats = recordCaveats;
  if (Object.keys(record).length > 0) out.record = record;
  const caveats = briefHistoryCaveats(value.caveats, maxChars);
  if (caveats !== undefined) out.caveats = caveats;
  const retrieval = briefDocsRetrieval(value.retrieval, maxChars);
  if (Object.keys(retrieval).length > 0) out.retrieval = retrieval;
  return out;
}

function briefDocs(
  docs: unknown,
  projection: SourceContractProjection = "normal",
): Record<string, unknown> {
  if (!isObject(docs)) return {};
  const maxChars = projectionMaxChars(projection);
  const entryLimit = projection === "normal" ? 3 : 1;
  const out = pick(docs, ["exists", "status", "last_audit", "mapping_entries", "indexed_documents"]);
  const absenceReason = boundedString(docs.absence_reason, maxChars);
  if (absenceReason !== undefined) out.absence_reason = absenceReason;
  const caveats = briefHistoryCaveats(docs.caveats, maxChars);
  if (caveats !== undefined) out.caveats = caveats;
  const sourceEntries = Array.isArray(docs.entries) ? docs.entries : null;
  let detailAvailability = Number(docs.mapping_entries) > 0 || Number(docs.indexed_documents) > 0
    ? "summary"
    : "full";
  if (sourceEntries) {
    const entries = sourceEntries.slice(0, entryLimit).map((entry) => briefDocEntry(entry, maxChars));
    const declaredTotal = Number(docs.indexed_documents);
    const total = Number.isSafeInteger(declaredTotal) && declaredTotal >= entries.length
      ? declaredTotal
      : sourceEntries.length;
    out.counts = { total, returned: entries.length, remaining: Math.max(0, total - entries.length) };
    out.entries = entries;
    detailAvailability = total > entries.length ? "summary" : "full";
  }
  const sourceContract = isObject(docs.source_contract)
    ? pick(docs.source_contract, ["detail_availability", "raw_artifact_reads_required", "capability_startup_complete", "inventory_authority"])
    : {};
  sourceContract.detail_availability = detailAvailability;
  sourceContract.retrieval = STATE_FAMILY_FALLBACK_COMMANDS.docs;
  out.source_contract = sourceContract;
  return out;
}

function briefProgress(progress: unknown): Record<string, unknown> {
  // opencode reads progress.latest.number/what/next; the brief keeps the
  // latest cycle but caps free-text scalars at BRIEF_SCALAR_MAX_CHARS so a
  // pathological value cannot blow the budget. Full detail recovers via
  // `agentera state progress get --id ID --format json`.
  if (!isObject(progress)) return {};
  const out = pick(progress, ["exists", "status", "latest_verification", "cycle_count", "degraded_history"]);
  const latest = progress.latest;
  if (isObject(latest)) {
    const boundedLatest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(latest)) {
      boundedLatest[key] = typeof value === "string" ? truncateCodePoints(value, BRIEF_SCALAR_MAX_CHARS, "…") : value;
    }
    out.latest = boundedLatest;
  } else {
    out.latest = latest;
  }
  return out;
}

function briefHealth(health: unknown): Record<string, unknown> {
  return pick(health, ["exists", "id", "artifact", "date", "trajectory", "grade", "degraded_history"]);
}

function briefAction(action: unknown, maxChars: number): Record<string, unknown> {
  if (!isObject(action)) return {};
  const out = pick(action, ["id", "artifact", "outcome", "eligible"]);
  for (const key of ["object", "capability", "reason", "phase"] as const) {
    const bounded = boundedString(action[key], maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  if (isObject(action.retrieval)) out.retrieval = pick(action.retrieval, ["exact", "get"]);
  return out;
}

function briefNextAction(
  nextAction: unknown,
  projection: SourceContractProjection = "normal",
): Record<string, unknown> {
  if (!isObject(nextAction)) return {};
  const maxChars = projectionMaxChars(projection);
  const alternativeLimit = projection === "normal"
    ? BRIEF_NEXT_ACTION_ALTERNATIVES
    : projection === "compact"
      ? 1
      : 0;
  const alternatives = Array.isArray(nextAction.alternatives)
    ? (nextAction.alternatives as JsonValue[]).slice(0, alternativeLimit).map((entry) => briefAction(entry, maxChars))
    : [];
  return {
    ...briefAction(nextAction, maxChars),
    alternatives,
  };
}

function briefCapabilityContext(value: unknown, maxChars: number): Record<string, unknown> {
  if (!isObject(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["capability", "fetch_command", "note"] as const) {
    const bounded = boundedString(value[key], maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  if (typeof value.required_before_rendering === "boolean") {
    out.required_before_rendering = value.required_before_rendering;
  }
  return out;
}

function briefSourceContract(
  sourceContract: unknown,
  projection: SourceContractProjection = "normal",
): Record<string, unknown> {
  if (!isObject(sourceContract)) return {};
  const maxItems = projection === "normal"
    ? BRIEF_SOURCE_FIELDS_MAX
    : projection === "compact"
      ? BRIEF_COMPACT_SOURCE_FIELDS_MAX
      : BRIEF_IRREDUCIBLE_SOURCE_FIELDS_MAX;
  const maxChars = projection === "normal"
    ? BRIEF_SOURCE_STRING_MAX_CHARS
    : projection === "compact"
      ? BRIEF_COMPACT_SOURCE_STRING_MAX_CHARS
      : BRIEF_IRREDUCIBLE_SOURCE_STRING_MAX_CHARS;
  const out: Record<string, unknown> = {};
  const fields = boundedStringList(sourceContract.fields, maxItems, maxChars);
  if (fields !== undefined) out.fields = fields;
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
 *  measured bytes, status, and omitted rich-state recovery commands.
 *
 *  Measurement uses deterministic pretty-JSON UTF-8 byte length including the
 *  trailing newline. The reported `utf8_bytes` is settled to a fixed point so
 *  it equals the actual emitted byte count (self-measurement otherwise changes
 *  its own digit count); the gate then decides on the final form. */
export function briefOrientationPayload(
  payload: Record<string, unknown>,
  options: { budgetBytes?: number; degradedMode?: "minimal" | "status_routing" } = {},
): Record<string, unknown> {
  const budget = options.budgetBytes ?? PRIME_BRIEF_MAX_UTF8_BYTES;
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new RangeError("brief budget must be a non-negative safe integer");
  }
  const projected = projectBriefBody(payload);
  const finalPayload = withBriefMeta(projected, "ok", budget, null);
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
function withBriefMeta(
  body: Record<string, unknown>,
  projection: "ok" | "degraded",
  budget: number,
  error: JsonObject | null,
): Record<string, unknown> {
  const meta: JsonObject = {
    budget_utf8_bytes: budget,
    projection,
    path_diagnostics_recovery: PATH_DIAGNOSTICS_RECOVERY,
    omitted_rich_state: OMITTED_RICH_STATE.map((entry) => ({ ...entry })),
  };
  if (error) meta.error = error;
  return settledBriefEnvelope(body, meta);
}

function projectBriefBody(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    switch (key) {
      case "plan":
        out[key] = briefPlan(value);
        break;
      case "history":
        out[key] = briefHistory(value);
        break;
      case "project_integration":
        out[key] = briefProjectIntegration(value);
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
        out[key] = briefProgress(value);
        break;
      case "health":
        out[key] = briefHealth(value);
        break;
      case "next_action":
        out[key] = briefNextAction(value);
        break;
      case "attention":
        out[key] = briefAttention(value);
        break;
      case "decision_attention":
        out[key] = briefDecisionAttention(value);
        break;
      case "docs":
        out[key] = briefDocs(value);
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
        // Command/outcome/mode, bounded ordinary state, shared-skill diagnosis,
        // bespoke context pointers, and active conditional fields pass through
        // at full fidelity.
        out[key] = value;
        break;
    }
  }
  return out;
}

function boundedEnvelopeScalar(value: unknown, fallback: string): string {
  return boundedString(value, BRIEF_SCALAR_MAX_CHARS) ?? fallback;
}

function degradedBody(payload: Record<string, unknown>, projection: SourceContractProjection): Record<string, unknown> {
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
  if ("shared_skill" in payload) out.shared_skill = briefSharedSkill(payload.shared_skill);
  if ("project_integration" in payload) out.project_integration = briefProjectIntegration(payload.project_integration);
  if ("todo_reconciliation" in payload) out.todo_reconciliation = payload.todo_reconciliation;
  if ("startup" in payload) out.startup = payload.startup;
  if ("health" in payload) out.health = briefHealth(payload.health);
  if ("todo" in payload) out.todo = payload.todo;
  if ("progress" in payload) out.progress = briefProgress(payload.progress);
  if ("attention" in payload) out.attention = briefAttention(payload.attention);
  if ("source" in payload) out.source = briefSource(payload.source);
  if ("docs" in payload) out.docs = briefDocs(payload.docs, projection);
  for (const conditional of ["v1_migration", "objective"] as const) {
    if (conditional in payload) out[conditional] = payload[conditional];
  }
  if (isObject(payload.plan)) out.plan = briefPlan(payload.plan, projection);
  if (isObject(payload.next_action)) out.next_action = briefNextAction(payload.next_action, projection);
  if (isObject(payload.history)) out.history = briefHistory(payload.history, projection);
  if (payload.decision_attention === null) out.decision_attention = null;
  else if (isObject(payload.decision_attention)) out.decision_attention = briefDecisionAttention(payload.decision_attention);
  return out;
}

function statusRoutingDegradedBody(
  payload: Record<string, unknown>,
  projection: SourceContractProjection,
): Record<string, unknown> {
  return {
    ...degradedBody(payload, projection),
    todo: payload.todo,
    attention: briefAttention(payload.attention),
  };
}

/** Settle the self-measuring byte field and return only at a fixed point. The
 * serialized value and the reported value therefore use the same pretty UTF-8
 * plus newline accounting as emitStructured. */
function settledBriefEnvelope(body: Record<string, unknown>, meta: JsonObject): Record<string, unknown> {
  let brief: JsonObject = { ...meta, utf8_bytes: 0 };
  let envelope: Record<string, unknown> = { ...body, brief };
  for (let guard = 0; guard < 32; guard += 1) {
    const bytes = briefUtf8Bytes(envelope);
    if (brief.utf8_bytes === bytes) return envelope;
    brief = { ...brief, utf8_bytes: bytes };
    envelope = { ...body, brief };
  }
  throw new Error("brief UTF-8 byte measurement did not settle");
}

export class BriefBudgetError extends Error {
  readonly budgetBytes: number;
  readonly minimumBytes: number;

  constructor(budgetBytes: number, minimumBytes: number) {
    super(
      `brief budget ${budgetBytes} bytes cannot contain the minimum routing envelope (${minimumBytes} bytes); increase the budget or use prime --context status`,
    );
    this.name = "BriefBudgetError";
    this.budgetBytes = budgetBytes;
    this.minimumBytes = minimumBytes;
  }
}

function degradedBriefEnvelope(
  payload: Record<string, unknown>,
  budget: number,
  attemptedBytes: number,
  mode: "minimal" | "status_routing",
): Record<string, unknown> {
  const detailedMeta: JsonObject = {
    budget_utf8_bytes: budget,
    projection: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    path_diagnostics_recovery: PATH_DIAGNOSTICS_RECOVERY,
    omitted_rich_state: OMITTED_RICH_STATE.map((entry) => ({ ...entry })),
    error: {
      class: "brief_output_budget",
      message:
        "the projected decision brief exceeded the authority byte budget; a bounded degraded envelope was emitted instead of the over-budget payload",
      recovery:
        `Run \`${preCutoverCommand("prime --context status --format json")}\` for status startup, or \`${preCutoverCommand("state <artifact> list --format json")}\` for a specific record family.`,
    },
  };
  const body = (projection: SourceContractProjection): Record<string, unknown> =>
    mode === "status_routing"
      ? statusRoutingDegradedBody(payload, projection)
      : degradedBody(payload, projection);
  const detailed = settledBriefEnvelope(body("normal"), detailedMeta);
  if (briefByteGate(detailed, budget).accepted) return detailed;

  // A smaller deterministic fallback drops the recovery catalog but retains the
  // bounded state-presence and source-contract projections plus one recovery
  // command. This is what lets a configured 7KB gate remain enforceable even
  // when caller data would make the detailed degraded envelope too large.
  const compactMeta: JsonObject = {
    budget_utf8_bytes: budget,
    projection: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    path_diagnostics_recovery: PATH_DIAGNOSTICS_RECOVERY,
    error: {
      class: "brief_output_budget",
      message: "brief exceeds byte budget",
      recovery: `Run \`${preCutoverCommand("prime --context status --format json")}\`.`,
    },
  };
  const compact = settledBriefEnvelope(body("compact"), compactMeta);
  if (briefByteGate(compact, budget).accepted) return compact;

  if (mode === "status_routing") {
    const minimum = settledBriefEnvelope(body("irreducible"), compactMeta);
    const minimumBytes = briefUtf8Bytes(minimum);
    if (minimumBytes <= budget) return minimum;
    throw new BriefBudgetError(budget, minimumBytes);
  }

  // The irreducible form is intentionally finite and contains only the routing
  // contract. If even this cannot fit, throwing is explicit: returning an
  // over-budget JSON document would violate the public output contract.
  const minimumMeta: JsonObject = {
    budget_utf8_bytes: budget,
    projection: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    error: {
      class: "brief_output_budget",
      message: "the configured budget cannot contain the detailed recovery envelope",
      recovery: `Increase the budget or run \`${preCutoverCommand("prime --context status --format json")}\`.`,
    },
  };
  const minimum = settledBriefEnvelope(body("irreducible"), minimumMeta);
  const minimumBytes = briefUtf8Bytes(minimum);
  if (minimumBytes <= budget) return minimum;
  throw new BriefBudgetError(budget, minimumBytes);
}
