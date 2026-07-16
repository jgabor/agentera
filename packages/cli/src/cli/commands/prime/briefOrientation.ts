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
 *  primeTask3Bounds test binds this constant to the authority so the contract
 *  and implementation cannot drift apart. */
export const PRIME_BRIEF_MAX_UTF8_BYTES = 12000;

/** Deterministic pretty-JSON UTF-8 byte length (including the trailing newline)
 *  used by the brief byte gate. Identical to the projection-policy serializer
 *  (serializedProjectionBytes) so measurement is consistent across surfaces. */
export function briefUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2) + "\n", "utf8");
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
  { field: "runtime_lifecycle.runtimes", reason: "lifecycle_runtime_detail", recovery: "agentera upgrade --dry-run --format json" },
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

function briefPlan(plan: unknown): Record<string, unknown> {
  // Keep the routing-essential summary consumers read (plan.exists/status/
  // title/first_pending.name and completion counts) plus the nested
  // source_contract.retrieval pointer. Drop task detail, the archive catalog,
  // diagnostics, and lifecycle_state — each recovers via OMITTED_RICH_STATE.
  return pick(plan, [
    "exists",
    "active",
    "status",
    "title",
    "complete",
    "total",
    "complete_plan",
    "first_pending",
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

function briefRuntimeLifecycle(runtime: unknown): Record<string, unknown> {
  // Keep the snapshot identity, active runtime IDs, aggregate counts, and the
  // release-blocked flag. Per-runtime surface/blocker detail is omitted and
  // recovers via `agentera upgrade --dry-run --format json`.
  return pick(runtime, [
    "schemaVersion",
    "snapshotVersion",
    "activeRuntimeIds",
    "counts",
    "releaseBlocked",
  ]);
}

function briefProjectIntegration(integration: unknown): Record<string, unknown> {
  // Keep the routing recommendation, message, pending counts, channel,
  // aggregate status, and any major-boundary block (which overrides
  // next_action). Phase blockers and guidance detail recover via doctor.
  return pick(integration, [
    "recommendation",
    "message",
    "update_channel",
    "pending_runtime",
    "pending_artifacts",
    "aggregate_status",
    "major_boundary_block",
  ]);
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

function briefCapabilityStartup(startup: unknown): Record<string, unknown> {
  // All capability_startup keys are routing-essential (AC1) and pinned by the
  // sourceContractOracles exact-key set, so this sub-object is a pass-through.
  // The raw_artifact_read_policy string is a cross-cutting source_contract
  // oracle contract and must stay present. available_state is already bounded
  // by Task 2's boundStartupValue 200-cp cap.
  return pick(startup, [
    "complete_for_capability_startup",
    "raw_artifact_reads_required",
    "raw_artifact_read_policy",
    "available_state",
    "missing_state",
    "confidence_caveats",
    "cli_fallback",
  ]);
}

function briefArtifactWrites(writes: unknown): Record<string, unknown> {
  // Keep the discovery pointer (required by the compatibility boundary test)
  // and schema identity; the full writer-operation matrix recovers via schema.
  return pick(writes, ["schemaVersion", "discovery_command"]);
}

function briefSourceContract(sourceContract: unknown): Record<string, unknown> {
  if (!isObject(sourceContract)) return {};
  const out = pick(sourceContract, ["fields", "render", "access", "empty_state", "capability_context"]);
  if (isObject(sourceContract.capability_startup)) {
    out.capability_startup = briefCapabilityStartup(sourceContract.capability_startup);
  } else {
    out.capability_startup = sourceContract.capability_startup;
  }
  if (isObject(sourceContract.artifact_writes)) {
    out.artifact_writes = briefArtifactWrites(sourceContract.artifact_writes);
  } else {
    out.artifact_writes = sourceContract.artifact_writes;
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
  options: { budgetBytes?: number } = {},
): Record<string, unknown> {
  const budget = options.budgetBytes ?? PRIME_BRIEF_MAX_UTF8_BYTES;
  const projected = projectBriefBody(payload);
  const finalPayload = withBriefMeta(projected, "ok", budget, null);
  const bytes = briefUtf8Bytes(finalPayload);
  if (bytes <= budget) {
    return finalPayload;
  }
  // Over-budget brief: reject the projected payload and emit a bounded degraded
  // envelope (never emit an over-budget payload). The envelope keeps
  // command/status/mode/state_presence, a brief source_contract, and the
  // byte-budget error with a recovery command.
  return degradedBriefEnvelope(payload, budget, bytes);
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
  const omitted = OMITTED_RICH_STATE.map((entry) => ({ ...entry }));
  const meta: JsonObject = {
    budget_utf8_bytes: budget,
    utf8_bytes: 0,
    status,
    omitted_rich_state: omitted,
  };
  if (error) meta.error = error;
  let payload: Record<string, unknown> = { ...body, brief: meta };
  // Settle: assign the measured size, re-measure; repeat until stable. The digit
  // count of a sub-12000 byte count never grows past 5, so this converges fast.
  let bytes = briefUtf8Bytes(payload);
  for (let guard = 0; guard < 4; guard += 1) {
    (meta as JsonObject).utf8_bytes = bytes;
    payload = { ...body, brief: { ...meta } };
    const next = briefUtf8Bytes(payload);
    if (next === bytes) break;
    bytes = next;
  }
  return payload;
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
      case "runtime_lifecycle":
        out[key] = briefRuntimeLifecycle(value);
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
      default:
        // command, status, app_home, app, mode, health, todo, issues, progress,
        // state_presence, attention, decision_attention, the bespoke context
        // pointers, and conditional v1_migration/docs/objective pass through at
        // full fidelity (they are either already bounded or routing-essential).
        out[key] = value;
        break;
    }
  }
  return out;
}

/** Bounded degraded envelope emitted when the projected brief itself exceeds the
 *  budget. Mirrors projectionPolicy.minimalBudgetedProjection: keep the
 *  top-level contract fields a routing consumer needs plus a byte-budget error
 *  with a recovery command, and stay within the budget by construction. */
function degradedBriefEnvelope(
  payload: Record<string, unknown>,
  budget: number,
  attemptedBytes: number,
): Record<string, unknown> {
  // Build the envelope (without the self-referential utf8_bytes), then settle
  // the size to a fixed point exactly as the ok path does.
  const meta: JsonObject = {
    budget_utf8_bytes: budget,
    utf8_bytes: 0,
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
  const body: Record<string, unknown> = {
    command: payload.command ?? "prime",
    status: payload.status ?? "ok",
    mode: payload.mode,
    state_presence: payload.state_presence ?? null,
    source_contract: briefSourceContract(payload.source_contract),
  };
  let envelope: Record<string, unknown> = { ...body, brief: meta };
  let bytes = briefUtf8Bytes(envelope);
  for (let guard = 0; guard < 4; guard += 1) {
    (meta as JsonObject).utf8_bytes = bytes;
    envelope = { ...body, brief: { ...meta } };
    const next = briefUtf8Bytes(envelope);
    if (next === bytes) break;
    bytes = next;
  }
  return envelope;
}
