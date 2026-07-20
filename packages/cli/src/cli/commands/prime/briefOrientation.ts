import type { JsonObject, JsonValue } from "../../../core/jsonValue.js";
import { truncateCodePoints } from "../../../core/text.js";

/**
 * Bounded default decision brief for the bare `agentera prime --format json`
 * emission (Plan Task 3).
 *
 * The bare default projects the full orientation payload
 * ({@link buildOrientationJsonPayload}) to a bounded decision brief: every
 * required top-level field stays PRESENT (the compatibility boundary asserts
 * the key set), but rich diagnostic/writer detail within those fields is
 * projected to routing-essential leaves plus a named authoritative recovery
 * command for each omitted sub-detail. `--dashboard`, `--fields <name>`, and
 * `--context <capability>` are NOT projected and keep the full payload.
 *
 * The byte gate is deterministic pretty-JSON UTF-8 measurement
 * (Buffer.byteLength(JSON.stringify(brief, null, 2) + "\n", "utf8")); an
 * over-budget brief is rejected in favor of a bounded degraded envelope.
 * Diagnostics (the `issues` deprecation warning) stay on stderr and are
 * measured separately. See references/cli/prime-consumer-compatibility.yaml
 * brief_omission_contract and references/artifacts/state-storage-authority.yaml
 * budgets.startup.surfaces.prime_briefing.
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
 *  authoritative recovery command (AC4). Mirrors brief_omission_contract in
 *  references/cli/prime-consumer-compatibility.yaml. */
const OMITTED_RICH_STATE: readonly OmittedRichStateEntry[] = [
  { field: "plan.tasks", reason: "plan_task_detail", recovery: "agentera state plan tasks list --format json" },
  { field: "plan.archived_plans", reason: "archive_catalog", recovery: "agentera state plan list --format json" },
  { field: "plan.diagnostics", reason: "plan_diagnostics", recovery: "agentera state plan --format json" },
  { field: "history.entries", reason: "startup_history_entries", recovery: "agentera state <artifact> list --limit 20 --format json" },
  { field: "project_integration.phases", reason: "phase_blockers", recovery: "agentera doctor --format json" },
  { field: "source_contract.artifact_writes.artifacts", reason: "writer_contract_detail", recovery: "agentera schema --format json" },
  { field: "docs.source_contract", reason: "docs_state_families", recovery: "agentera state docs --format json" },
  { field: "profile.bounded_signals", reason: "profile_signal_detail", recovery: "agentera profile --format json" },
];

/** Maximum number of ranked next_action alternatives retained in the brief.
 *  The recommended entry is always kept; overflow alternatives recover via the
 *  state-derived readiness cascade rather than raw artifact access. */
const BRIEF_NEXT_ACTION_ALTERNATIVES = 3;

/** Code-point cap for routing-essential free-text scalars retained in the brief
 *  (e.g. progress.latest.what/next). Matches the boundStartupValue 200-cp
 *  limit already applied to context payloads so the brief never lets a single
 *  pathological scalar blow the budget; the full value recovers via the named
 *  state command. */
const BRIEF_SCALAR_MAX_CHARS = 200;

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

function briefPlan(plan: unknown): Record<string, unknown> {
  // Keep canonical plan/task identity and the routing-essential summary consumers
  // read plus the nested source_contract.retrieval pointer. Drop the archive catalog,
  // diagnostics, and lifecycle_state — each recovers via OMITTED_RICH_STATE.
  return pick(plan, [
    "exists",
    "id",
    "artifact",
    "active",
    "status",
    "title",
    "complete",
    "total",
    "complete_plan",
    "first_pending",
    "tasks",
    "task_count",
    "omitted_task_count",
    "source_contract",
  ]);
}

function briefHistory(history: unknown): Record<string, unknown> {
  if (!isObject(history)) return {};
  const out: Record<string, unknown> = {};
  for (const [artifactId, entry] of Object.entries(history)) {
    // Each startup-history artifact keeps its status, the routing-essential
    // counts (physical/addressable/omitted), and the retrieval pointer. The
    // full 10-field counts object and entries array are omitted (diagnostic;
    // Task 4 decides when status needs them) and recover via the named state
    // command.
    const entryObj = isObject(entry) ? (entry as Record<string, unknown>) : {};
    const counts = isObject(entryObj.counts) ? entryObj.counts as Record<string, unknown> : {};
    out[artifactId] = {
      ...pick(entryObj, ["artifact", "status", "retrieval"]),
      counts: pick(counts, ["physical", "addressable", "omitted"]),
    };
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
    "path",
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
  // reads its verbose path list (the packaging gate reads app_home). Keep the
  // safety-essential identity fields; full paths recover via `agentera doctor`.
  return pick(app, [
    "status",
    "expectedVersion",
    "appHome",
    "skillRoot",
    "runtimeRoot",
    "sourceRoot",
    "updateChannel",
  ]);
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

function briefDocs(docs: unknown): Record<string, unknown> {
  // No default-bare consumer reads the docs projection detail. Keep the
  // availability signal and mapping count; the verbose source_contract with
  // state_families recovers via `agentera state docs --format json`.
  return pick(docs, ["exists", "status", "mapping_entries", "indexed_documents"]);
}

function briefProgress(progress: unknown): Record<string, unknown> {
  // opencode reads progress.latest.number/what/next; the brief keeps the
  // latest cycle but caps free-text scalars at BRIEF_SCALAR_MAX_CHARS so a
  // pathological value cannot blow the budget. Full detail recovers via
  // `agentera state progress get --number N --format json`.
  if (!isObject(progress)) return {};
  const out = pick(progress, ["exists", "status", "latest_verification", "cycle_count"]);
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

function briefNextAction(nextAction: unknown): Record<string, unknown> {
  if (!isObject(nextAction)) return {};
  const alternatives = Array.isArray(nextAction.alternatives)
    ? (nextAction.alternatives as JsonValue[]).slice(0, BRIEF_NEXT_ACTION_ALTERNATIVES)
    : [];
  return {
    ...pick(nextAction, ["object", "capability", "reason", "phase"]),
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

function briefCapabilityStartup(startup: unknown, maxChars: number): Record<string, unknown> {
  if (!isObject(startup)) return {};
  const out: Record<string, unknown> = {};
  if (typeof startup.complete_for_capability_startup === "boolean") {
    out.complete_for_capability_startup = startup.complete_for_capability_startup;
  }
  if (typeof startup.raw_artifact_reads_required === "boolean") {
    out.raw_artifact_reads_required = startup.raw_artifact_reads_required;
  }
  const policy = boundedString(startup.raw_artifact_read_policy, maxChars);
  if (policy !== undefined) out.raw_artifact_read_policy = policy;
  for (const [key, maxItems] of [
    ["available_state", 64],
    ["missing_state", 16],
    ["confidence_caveats", 8],
    ["cli_fallback", 8],
  ] as const) {
    const bounded = boundedStringList(startup[key], maxItems, maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

function briefArtifactWrites(writes: unknown, maxChars: number): Record<string, unknown> {
  // Keep the discovery pointer (required by the compatibility boundary test)
  // and schema identity; the full writer-operation matrix recovers via schema.
  if (!isObject(writes)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["schemaVersion", "discovery_command"] as const) {
    const bounded = boundedString(writes[key], maxChars);
    if (bounded !== undefined) out[key] = bounded;
  }
  return out;
}

type SourceContractProjection = "normal" | "compact" | "irreducible";

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
  if (isObject(sourceContract.capability_startup)) {
    if (projection === "irreducible") {
      const startup = sourceContract.capability_startup;
      const minimalStartup: Record<string, unknown> = {};
      if (typeof startup.complete_for_capability_startup === "boolean") {
        minimalStartup.complete_for_capability_startup = startup.complete_for_capability_startup;
      }
      if (typeof startup.raw_artifact_reads_required === "boolean") {
        minimalStartup.raw_artifact_reads_required = startup.raw_artifact_reads_required;
      }
      out.capability_startup = minimalStartup;
    } else {
      out.capability_startup = briefCapabilityStartup(sourceContract.capability_startup, maxChars);
    }
  }
  if (isObject(sourceContract.artifact_writes)) {
    if (projection !== "irreducible") {
      out.artifact_writes = briefArtifactWrites(sourceContract.artifact_writes, maxChars);
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
  // envelope (never emit an over-budget payload). The envelope keeps
  // command/status/mode/state_presence, a brief source_contract, and the
  // byte-budget error with a recovery command.
  return degradedBriefEnvelope(payload, budget, gate.bytes, options.degradedMode ?? "minimal");
}

/** Attach the brief meta block and settle `utf8_bytes` to a fixed point so the
 *  reported size equals the actual emitted byte count (otherwise the digits of
 *  `utf8_bytes` itself would change the measurement). */
function withBriefMeta(
  body: Record<string, unknown>,
  status: "ok" | "degraded",
  budget: number,
  error: JsonObject | null,
): Record<string, unknown> {
  const meta: JsonObject = {
    budget_utf8_bytes: budget,
    status,
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
      case "progress":
        out[key] = briefProgress(value);
        break;
      case "next_action":
        out[key] = briefNextAction(value);
        break;
      case "attention":
        out[key] = briefAttention(value);
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
      default:
        // command, status, app_home, app, mode, health, todo, issues, progress,
        // attention, decision_attention, the bespoke context
        // pointers, and conditional v1_migration/docs/objective pass through at
        // full fidelity (they are either already bounded or routing-essential).
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
  return {
    command: boundedEnvelopeScalar(payload.command, "prime"),
    status: boundedEnvelopeScalar(payload.status, "ok"),
    mode: boundedEnvelopeScalar(payload.mode, "unknown"),
    state_presence: briefStatePresence(payload.state_presence),
    source_contract: briefSourceContract(payload.source_contract, projection),
  };
}

function statusRoutingDegradedBody(
  payload: Record<string, unknown>,
  projection: SourceContractProjection,
): Record<string, unknown> {
  return {
    ...degradedBody(payload, projection),
    todo: payload.todo,
    attention: briefAttention(payload.attention),
    next_action: briefNextAction(payload.next_action),
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
      `brief budget ${budgetBytes} bytes cannot contain the minimum routing envelope (${minimumBytes} bytes); increase the budget or use --dashboard`,
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
    status: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    omitted_rich_state: OMITTED_RICH_STATE.map((entry) => ({ ...entry })),
    error: {
      class: "brief_output_budget",
      message:
        "the projected decision brief exceeded the authority byte budget; a bounded degraded envelope was emitted instead of the over-budget payload",
      recovery:
        "Run `agentera prime --dashboard --format json` for the full orientation payload, or `agentera state <artifact> --format json` for a specific family.",
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
    status: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    error: {
      class: "brief_output_budget",
      message: "the projected decision brief exceeded the authority byte budget; compact recovery metadata was emitted",
      recovery: "Run `agentera prime --dashboard --format json` for full orientation detail.",
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
    status: "degraded",
    attempted_utf8_bytes: attemptedBytes,
    error: {
      class: "brief_output_budget",
      message: "the configured budget cannot contain the detailed recovery envelope",
      recovery: "Increase the budget or run `agentera prime --dashboard --format json`.",
    },
  };
  const minimum = settledBriefEnvelope(body("irreducible"), minimumMeta);
  const minimumBytes = briefUtf8Bytes(minimum);
  if (minimumBytes <= budget) return minimum;
  throw new BriefBudgetError(budget, minimumBytes);
}
