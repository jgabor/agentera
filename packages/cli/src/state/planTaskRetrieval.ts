import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";

import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureBody } from "./directRetrieval.js";
import { PLAN_ID } from "./planIdentity.js";
import { discoverPlanArtifacts, planDocumentParts, type PlanArtifact } from "../cli/planArtifacts.js";

const CURSOR_VERSION = 1;
const ORDER = "task_number_asc";
const MAX_LIST_BYTES = 32_768;

interface CursorPayload {
  version: number;
  collection: "plan.tasks";
  plan_id: string;
  order: typeof ORDER;
  snapshot_id: string;
  candidate_count: number;
  candidate_max: number;
  after: number;
}

interface LoadedPlan {
  artifact: PlanArtifact;
  planId: string;
  compatibility: "complete" | "degraded";
  tasks: Array<{ number: number; record: JsonObject }>;
  provenancePaths: string[];
}

export interface PlanTaskListResponse {
  schemaVersion: "agentera.stateRetrieval.v1";
  command: "state plan tasks list";
  status: "ok" | "degraded";
  entries: JsonValue[];
  counts: JsonObject;
  order: typeof ORDER;
  filters: JsonObject;
  snapshot: JsonObject;
  source: JsonObject;
  source_contract: JsonObject;
  retrieval: JsonObject;
  omitted?: boolean;
  omitted_count?: number;
  omission_reason?: string;
  next_cursor?: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

function fail(
  exitCode: 1 | 2,
  className: StateFailureBody["error"]["class"],
  message: string,
  verb: "list" | "get",
  details: Partial<StateFailureBody["error"]> = {},
): StateRetrievalFailure {
  const syntax = verb === "list"
    ? "agentera state plan tasks list [--plan PLAN_ID] [--limit N] [--cursor TOKEN] --format json"
    : "agentera state plan tasks get [--plan PLAN_ID] --task N --format json";
  const example = verb === "list"
    ? "agentera state plan tasks list --limit 20 --format json"
    : "agentera state plan tasks get --task 1 --format json";
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax,
        example,
        recovery: details.recovery ?? "Correct the command using one of the valid forms and retry; no state was changed.",
        valid_values: verb === "list"
          ? ["list", "--plan PLAN_ID", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
          : ["get", "--task N", "--plan PLAN_ID", "--format text|json|yaml"],
        ...details,
      },
    },
    exitCode,
  );
}

function activePlan(activePath: string, selectedPlan: string | undefined, verb: "list" | "get"): LoadedPlan {
  if (selectedPlan !== undefined && !PLAN_ID.test(selectedPlan)) {
    throw fail(2, "invalid_request", `invalid plan identity '${selectedPlan}'`, verb, {
      valid_values: ["plan:<lowercase-rfc9562-uuid>", "legacy-plan:<64-lowercase-hex-digest>"],
    });
  }
  const discovery = discoverPlanArtifacts(activePath);
  if (!discovery.active) {
    const diagnostic = discovery.diagnostics.find((entry) => entry.path === activePath && entry.category !== "legacy");
    if (diagnostic) {
      throw fail(1, "corrupt", `active plan cannot be read: ${diagnostic.message}`, verb, {
        recovery: "Repair the active file-based plan, then retry; archived plan retrieval is a separate command family.",
        details: { path: activePath, category: diagnostic.category },
      });
    }
    throw fail(1, "not_found", "no active file-based plan exists", verb, {
      recovery: "Create or restore an active plan, then retry the plan task command.",
      details: { path: activePath },
    });
  }
  const artifact = discovery.active;
  const parts = planDocumentParts(artifact.data);
  const identity = discovery.identities.find((candidate) => candidate.artifact.path === artifact.path);
  if (!identity) {
    throw fail(1, "corrupt", "active plan header.id is not a valid plan identity", verb, {
      recovery: "Repair the persisted active-plan identity before listing or fetching its tasks.",
      details: { path: artifact.path, plan_id: parts.header.id ?? null },
    });
  }
  const planId = identity.stableId;
  if (identity.ambiguous) {
    throw fail(1, "ambiguous", `plan identity '${planId}' resolves to different plan documents`, verb, {
      stable_id: planId,
      recovery: "Repair the identity collision; Agentera will not choose a plan by path, mtime, or discovery order.",
      details: { candidate_paths: identity.provenancePaths },
    });
  }
  if (selectedPlan !== undefined && selectedPlan !== planId) {
    throw fail(1, "not_found", `active plan '${selectedPlan}' was not found`, verb, {
      stable_id: selectedPlan,
      recovery: `Use the active plan '${planId}', or omit --plan; archived plan retrieval is not part of this command.`,
    });
  }
  const seen = new Set<number>();
  const tasks = parts.tasks.map((record) => {
    const number = record.number;
    if (!Number.isSafeInteger(number) || Number(number) < 1 || seen.has(Number(number))) {
      throw fail(1, "corrupt", "active plan tasks require unique positive integer numbers", verb, {
        recovery: "Repair duplicate or invalid task numbers in the active plan, then retry.",
        details: { path: artifact.path, task_number: number ?? null },
      });
    }
    seen.add(Number(number));
    return { number: Number(number), record };
  }).sort((left, right) => left.number - right.number);
  return {
    artifact,
    planId,
    compatibility: identity.persisted ? "complete" : "degraded",
    tasks,
    provenancePaths: identity.provenancePaths,
  };
}

function snapshotId(planId: string, tasks: LoadedPlan["tasks"]): string {
  return hash({ collection: "plan.tasks", plan_id: planId, order: ORDER, tasks });
}

function cursorKey(projectRoot: string): Buffer {
  return createHash("sha256").update(`agentera-plan-task-cursor\0${path.resolve(projectRoot)}`, "utf8").digest();
}

function sign(payload: CursorPayload, projectRoot: string): string {
  return createHmac("sha256", cursorKey(projectRoot)).update(canonicalRecordJson(payload), "utf8").digest("hex");
}

function encodeCursor(payload: CursorPayload, projectRoot: string): string {
  return Buffer.from(JSON.stringify({ ...payload, signature: sign(payload, projectRoot) }), "utf8").toString("base64url");
}

function parseCursor(token: string, projectRoot: string, planId: string): CursorPayload {
  const invalid = (message: string): never => {
    throw fail(2, "cursor_invalid", message, "list", {
      recovery: "Copy response.next_cursor exactly, or omit --cursor to establish a new active-plan snapshot.",
      details: { cursor: "opaque; do not parse or construct cursor tokens" },
    });
  };
  if (!token || token.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(token)) invalid("cursor is not a valid opaque token");
  let decoded: unknown;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) invalid("cursor is not a canonical opaque token");
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid("cursor is not a valid opaque token");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) invalid("cursor payload is invalid");
  const signed = decoded as Record<string, unknown>;
  const signature = signed.signature;
  const payload = { ...signed };
  delete payload.signature;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) invalid("cursor signature is missing or malformed");
  const signatureString = signature as string;
  const expected = sign(payload as unknown as CursorPayload, projectRoot);
  if (!timingSafeEqual(Buffer.from(signatureString, "hex"), Buffer.from(expected, "hex"))) invalid("cursor signature is invalid");
  const parsed = payload as unknown as CursorPayload;
  if (
    parsed.version !== CURSOR_VERSION || parsed.collection !== "plan.tasks" || parsed.plan_id !== planId ||
    parsed.order !== ORDER || !/^[0-9a-f]{64}$/.test(parsed.snapshot_id) ||
    !Number.isSafeInteger(parsed.candidate_count) || parsed.candidate_count < 1 ||
    !Number.isSafeInteger(parsed.candidate_max) || parsed.candidate_max < 1 ||
    !Number.isSafeInteger(parsed.after) || parsed.after < 1 || parsed.after > parsed.candidate_max
  ) invalid("cursor is bound to a different plan task list or has an invalid payload");
  return parsed;
}

function taskEntry(plan: LoadedPlan, task: LoadedPlan["tasks"][number]): JsonObject {
  const get = `agentera state plan tasks get --task ${task.number} --format json`;
  return {
    stable_id: `${plan.planId}/task:${task.number}`,
    addressable: true,
    task_number: task.number,
    detail_availability: "full",
    compatibility: plan.compatibility,
    provenance: {
      storage: "active_plan_file",
      path: plan.artifact.path,
      lifecycle_position: "active",
      plan_id: plan.planId,
      ...(plan.provenancePaths.length > 1 ? { mirrored_paths: plan.provenancePaths } : {}),
    },
    retrieval: { get },
    record: task.record,
  };
}

function baseList(plan: LoadedPlan, snapshotTasks: LoadedPlan["tasks"], pageTasks: LoadedPlan["tasks"], projectRoot: string): PlanTaskListResponse {
  const snapshot = snapshotId(plan.planId, snapshotTasks);
  const entries = pageTasks.map((task) => taskEntry(plan, task));
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state plan tasks list",
    status: plan.compatibility === "complete" ? "ok" : "degraded",
    entries,
    counts: { total: snapshotTasks.length, returned: entries.length, remaining: 0, omitted: 0 },
    order: ORDER,
    filters: { plan: plan.planId },
    snapshot: { id: snapshot, candidate_count: snapshotTasks.length, has_more: false },
    source: { artifact: "plan", active: true, path: plan.artifact.path, plan_id: plan.planId, storage: "active_plan_file" },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      complete_for_plan_task_retrieval: true,
      storage_ownership: "owning_active_plan_file",
      cursor: "opaque_snapshot_cursor",
    },
    retrieval: { get: "agentera state plan tasks get --task N --format json" },
  };
}

function withPage(plan: LoadedPlan, snapshotTasks: LoadedPlan["tasks"], candidates: LoadedPlan["tasks"], retained: number, projectRoot: string, reason: string): PlanTaskListResponse {
  const selected = candidates.slice(0, retained);
  const remaining = candidates.length - selected.length;
  const response = baseList(plan, snapshotTasks, selected, projectRoot);
  response.counts = { total: snapshotTasks.length, returned: selected.length, remaining, omitted: remaining };
  response.snapshot = { ...response.snapshot, has_more: remaining > 0 };
  if (remaining > 0 && selected.length > 0) {
    const last = selected.at(-1)!;
    const token = encodeCursor({
      version: CURSOR_VERSION,
      collection: "plan.tasks",
      plan_id: plan.planId,
      order: ORDER,
      snapshot_id: snapshotId(plan.planId, snapshotTasks),
      candidate_count: snapshotTasks.length,
      candidate_max: snapshotTasks.at(-1)!.number,
      after: last.number,
    }, projectRoot);
    response.next_cursor = token;
    response.omitted = true;
    response.omitted_count = remaining;
    response.omission_reason = reason;
    response.retrieval = {
      continue: `agentera state plan tasks list --cursor ${token} --format json`,
      get: "agentera state plan tasks get --task N --format json",
    };
  }
  return response;
}

export function listPlanTasks(
  projectRoot: string,
  activePath: string,
  options: { plan?: string; limit: number; cursor?: string; format: "text" | "json" | "yaml" },
): PlanTaskListResponse {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw fail(2, "invalid_request", "task list limit must be an integer from 1 through 100", "list", {
      valid_values: ["1..100"],
    });
  }
  const plan = activePlan(activePath, options.plan, "list");
  const parsed = options.cursor ? parseCursor(options.cursor, projectRoot, plan.planId) : undefined;
  const snapshotTasks = parsed ? plan.tasks.filter((task) => task.number <= parsed.candidate_max) : plan.tasks;
  if (parsed && (snapshotTasks.length !== parsed.candidate_count || snapshotId(plan.planId, snapshotTasks) !== parsed.snapshot_id)) {
    throw fail(1, "cursor_snapshot_unavailable", "the active plan task snapshot changed and cannot be resumed exactly", "list", {
      recovery: "Start a new task listing without --cursor to establish the current active-plan snapshot.",
      details: { snapshot_id: parsed.snapshot_id, current_snapshot_id: snapshotId(plan.planId, snapshotTasks) },
    });
  }
  const candidates = snapshotTasks.filter((task) => task.number > (parsed?.after ?? 0));
  const requested = Math.min(options.limit, candidates.length);
  let response = withPage(plan, snapshotTasks, candidates, requested, projectRoot, "page_limit");
  if (options.format === "json") {
    for (let retained = requested; retained > 0 && Buffer.byteLength(JSON.stringify(response, null, 2) + "\n", "utf8") > MAX_LIST_BYTES; retained -= 1) {
      response = withPage(plan, snapshotTasks, candidates, retained - 1, projectRoot, "serialized_output_byte_budget");
    }
    if (Buffer.byteLength(JSON.stringify(response, null, 2) + "\n", "utf8") > MAX_LIST_BYTES || (candidates.length > 0 && response.entries.length === 0)) {
      throw fail(1, "unsupported_state", `one task cannot fit within the ${MAX_LIST_BYTES}-byte JSON list budget`, "list", {
        recovery: "Fetch the task directly with agentera state plan tasks get --task N --format json.",
      });
    }
  }
  return response;
}

export function getPlanTask(projectRoot: string, activePath: string, taskNumber: number, selectedPlan?: string): JsonObject {
  const plan = activePlan(activePath, selectedPlan, "get");
  const task = plan.tasks.find((candidate) => candidate.number === taskNumber);
  if (!task) {
    throw fail(1, "not_found", `task ${taskNumber} was not found in active plan '${plan.planId}'`, "get", {
      stable_id: `${plan.planId}/task:${taskNumber}`,
      entry_number: taskNumber,
      recovery: "List valid active-plan task numbers with agentera state plan tasks list --format json, then retry.",
    });
  }
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state plan tasks get",
    status: "ok",
    entry: taskEntry(plan, task),
    source: { artifact: "plan", active: true, path: plan.artifact.path, plan_id: plan.planId, storage: "active_plan_file" },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      complete_for_plan_task_retrieval: true,
      storage_ownership: "owning_active_plan_file",
    },
  };
}
