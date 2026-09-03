import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import YAML from "yaml";

import type { JsonObject, JsonValue } from "../core/jsonValue.js";
import { loadYamlMapping } from "../core/yaml.js";
import { discoverPlanArtifacts, planCatalogEntry, planDocumentParts, type PlanArtifact, type PlanArtifactDiagnostic, type PlanArtifactDiscovery, type PlanArtifactIdentity } from "../cli/planArtifacts.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureBody } from "./directRetrieval.js";
import { PLAN_ID } from "./planIdentity.js";

const CURSOR_VERSION = 1;
const ORDER = "created_desc_then_plan_id_asc";
const MAX_LIST_BYTES = 32_768;

interface LogicalPlan {
  stableId: string;
  artifact: PlanArtifact;
  identity: PlanArtifactIdentity;
  paths: string[];
  active: boolean;
  archived: boolean;
}

interface SnapshotRef {
  stable_id: string;
  paths: string[];
  canonical_hash: string;
}

interface CursorPayload {
  version: number;
  collection: "plan.plans";
  order: typeof ORDER;
  snapshot_id: string;
  candidate_ids: string[];
  diagnostics: PlanArtifactDiagnostic[];
  diagnostic_hash: string;
  after: number;
}

export interface PlanListResponse {
  schemaVersion: "agentera.stateRetrieval.v1";
  command: "state plan list";
  status: "ok" | "degraded";
  entries: JsonValue[];
  counts: JsonObject;
  order: typeof ORDER;
  filters: JsonObject;
  snapshot: JsonObject;
  source: JsonObject;
  source_contract: JsonObject;
  retrieval: JsonObject;
  omitted: boolean;
  omitted_count: number;
  omission_reason: string | null;
  next_cursor?: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

function fail(exitCode: 1 | 2, className: StateFailureBody["error"]["class"], message: string, verb: "list" | "get", details: Partial<StateFailureBody["error"]> = {}): StateRetrievalFailure {
  const list = verb === "list";
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: list ? "agentera state plan list [--limit N] [--cursor TOKEN]" : "agentera state plan get --plan PLAN_ID",
        example: list ? "agentera state plan list --limit 20" : "agentera state plan get --plan plan:123e4567-e89b-42d3-a456-426614174000",
        recovery: details.recovery ?? "Correct the command using one of the valid forms and retry; no state was changed.",
        valid_values: list ? ["list", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"] : ["get", "--plan PLAN_ID", "--format text|json|yaml"],
        ...details,
      },
    },
    exitCode,
  );
}

function logicalPlans(discovery: PlanArtifactDiscovery): LogicalPlan[] {
  const byId = new Map<string, PlanArtifactIdentity[]>();
  for (const identity of discovery.identities) {
    const values = byId.get(identity.stableId) ?? [];
    values.push(identity);
    byId.set(identity.stableId, values);
  }
  return [...byId.entries()]
    .map(([stableId, identities]) => {
      const ordered = [...identities].sort((left, right) => {
        const leftActive = left.artifact.path === discovery.activePath ? 0 : 1;
        const rightActive = right.artifact.path === discovery.activePath ? 0 : 1;
        return leftActive - rightActive || left.artifact.path.localeCompare(right.artifact.path);
      });
      const paths = [...new Set(ordered.map((value) => value.artifact.path))].sort();
      return {
        stableId,
        artifact: ordered[0]!.artifact,
        identity: ordered[0]!,
        paths,
        active: paths.includes(discovery.activePath),
        archived: paths.some((candidate) => candidate !== discovery.activePath),
      };
    })
    .sort((left, right) => {
      const created = planDocumentParts(right.artifact.data).created.localeCompare(planDocumentParts(left.artifact.data).created);
      return created || left.stableId.localeCompare(right.stableId);
    });
}

function catalogEntry(plan: LogicalPlan): JsonObject {
  const entry = planCatalogEntry(plan.artifact, plan.active ? plan.artifact.path : "", plan.identity);
  entry.detail_availability = plan.identity.ambiguous ? "unavailable" : "full";
  entry.active = plan.active;
  entry.archived = plan.archived;
  entry.provenance = {
    storage: plan.active && plan.archived ? "active_and_archive_files" : plan.active ? "active_plan_file" : "immutable_plan_archive",
    lifecycle_positions: [...(plan.active ? ["active"] : []), ...(plan.archived ? ["archived"] : [])],
    paths: plan.paths,
    ...(plan.paths.length > 1 ? { mirrored_paths: plan.paths } : { path: plan.paths[0]! }),
  };
  entry.retrieval = { get: `agentera state plan get --plan ${plan.stableId}` };
  return entry;
}

function refs(plans: LogicalPlan[]): SnapshotRef[] {
  return plans.map((plan) => ({
    stable_id: plan.stableId,
    paths: plan.paths,
    canonical_hash: hash(plan.identity.canonicalJson),
  }));
}

function snapshotId(candidateRefs: SnapshotRef[]): string {
  return hash({ collection: "plan.plans", order: ORDER, candidates: candidateRefs });
}

function cursorKey(projectRoot: string): Buffer {
  return createHash("sha256")
    .update(`agentera-plan-cursor\0${path.resolve(projectRoot)}`, "utf8")
    .digest();
}

function sign(payload: CursorPayload, projectRoot: string): string {
  return createHmac("sha256", cursorKey(projectRoot)).update(canonicalRecordJson(payload), "utf8").digest("hex");
}

function encodeCursor(payload: CursorPayload, projectRoot: string): string {
  const bytes = Buffer.from(JSON.stringify({ ...payload, signature: sign(payload, projectRoot) }), "utf8");
  return deflateRawSync(bytes).toString("base64url");
}

function parseCursor(token: string, projectRoot: string): CursorPayload {
  const invalid = (message: string): never => {
    throw fail(2, "cursor_invalid", message, "list", {
      recovery: "Copy response.next_cursor exactly, or omit --cursor to establish a new plan-catalog snapshot.",
      details: { cursor: "opaque; do not parse or construct cursor tokens" },
    });
  };
  if (!token || token.length > 100_000 || !/^[A-Za-z0-9_-]+$/.test(token)) invalid("cursor is not a valid opaque token");
  let decoded: unknown;
  try {
    const compressed = Buffer.from(token, "base64url");
    if (compressed.toString("base64url") !== token) invalid("cursor is not a canonical opaque token");
    decoded = JSON.parse(inflateRawSync(compressed, { maxOutputLength: 1_000_000 }).toString("utf8"));
  } catch {
    invalid("cursor is not a valid opaque token");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) invalid("cursor payload is invalid");
  const record = decoded as Record<string, unknown>;
  const { signature, ...unsigned } = record;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) invalid("cursor signature is invalid");
  const expected = sign(unsigned as unknown as CursorPayload, projectRoot);
  if (!timingSafeEqual(Buffer.from(signature as string), Buffer.from(expected))) invalid("cursor signature is invalid");
  if (unsigned.version !== CURSOR_VERSION || unsigned.collection !== "plan.plans" || unsigned.order !== ORDER) invalid("cursor is bound to a different collection or order");
  if (!Number.isSafeInteger(unsigned.after) || Number(unsigned.after) < 1 || !Array.isArray(unsigned.candidate_ids) || !Array.isArray(unsigned.diagnostics)) invalid("cursor payload is invalid");
  if ((unsigned.candidate_ids as unknown[]).some((candidate) => typeof candidate !== "string" || !PLAN_ID.test(candidate))) invalid("cursor candidate snapshot is invalid");
  if (typeof unsigned.snapshot_id !== "string" || !/^[0-9a-f]{64}$/.test(unsigned.snapshot_id) || typeof unsigned.diagnostic_hash !== "string" || !/^[0-9a-f]{64}$/.test(unsigned.diagnostic_hash)) invalid("cursor snapshot is invalid");
  return unsigned as unknown as CursorPayload;
}

function plansFromSnapshot(discovery: PlanArtifactDiscovery, payload: CursorPayload): LogicalPlan[] {
  if (hash(discovery.diagnostics) !== payload.diagnostic_hash) {
    throw fail(1, "cursor_snapshot_unavailable", "the plan catalog diagnostics changed and the snapshot cannot be resumed exactly", "list", {
      recovery: "Start a new plan listing without --cursor to establish the current snapshot.",
      details: { snapshot_id: payload.snapshot_id },
    });
  }
  const current = logicalPlans(discovery);
  const plans = payload.candidate_ids.map((stableId) => {
    const match = current.find((candidate) => candidate.stableId === stableId);
    if (!match) {
      throw fail(1, "cursor_snapshot_unavailable", "the plan catalog snapshot changed and cannot be resumed exactly", "list", {
        recovery: "Start a new plan listing without --cursor to establish the current snapshot.",
        details: { snapshot_id: payload.snapshot_id },
      });
    }
    return match;
  });
  if (snapshotId(refs(plans)) !== payload.snapshot_id) {
    throw fail(1, "cursor_snapshot_unavailable", "the plan catalog snapshot changed and cannot be resumed exactly", "list", {
      recovery: "Start a new plan listing without --cursor to establish the current snapshot.",
      details: { snapshot_id: payload.snapshot_id },
    });
  }
  return plans;
}

function baseList(plans: LogicalPlan[], selected: LogicalPlan[], diagnostics: PlanArtifactDiagnostic[], snapshotRefs: SnapshotRef[]): PlanListResponse {
  const degraded = diagnostics.length > 0 || plans.some((plan) => !plan.identity.persisted || plan.identity.ambiguous);
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state plan list",
    status: degraded ? "degraded" : "ok",
    entries: selected.map(catalogEntry),
    counts: {
      total: plans.length,
      returned: selected.length,
      remaining: plans.length - selected.length,
      omitted: plans.length - selected.length,
    },
    order: ORDER,
    filters: {},
    snapshot: {
      id: snapshotId(snapshotRefs),
      candidate_count: plans.length,
      has_more: plans.length > selected.length,
    },
    source: {
      artifact: "plan",
      storage: "active_plan_file_and_immutable_plan_archive_files",
      compatibility_diagnostics: diagnostics,
    },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      complete_for_plan_list_retrieval: true,
      storage_ownership: "active_plan_file_and_immutable_plan_archive_files",
    },
    retrieval: { get: "agentera state plan get --plan PLAN_ID" },
    omitted: false,
    omitted_count: 0,
    omission_reason: null,
  };
}

function withPage(plans: LogicalPlan[], diagnostics: PlanArtifactDiagnostic[], start: number, retained: number, projectRoot: string, reason: string): PlanListResponse {
  const snapshotRefs = refs(plans);
  const selected = plans.slice(start, start + retained);
  const remaining = Math.max(0, plans.length - start - selected.length);
  const response = baseList(plans, selected, diagnostics, snapshotRefs);
  response.counts = {
    total: plans.length,
    returned: selected.length,
    remaining,
    omitted: remaining,
  };
  response.snapshot = { ...response.snapshot, has_more: remaining > 0 };
  if (remaining > 0 && selected.length > 0) {
    const token = encodeCursor(
      {
        version: CURSOR_VERSION,
        collection: "plan.plans",
        order: ORDER,
        snapshot_id: snapshotId(snapshotRefs),
        candidate_ids: plans.map((plan) => plan.stableId),
        diagnostics,
        diagnostic_hash: hash(diagnostics),
        after: start + selected.length,
      },
      projectRoot,
    );
    response.next_cursor = token;
    response.omitted = true;
    response.omitted_count = remaining;
    response.omission_reason = reason;
    response.retrieval = {
      continue: `agentera state plan list --cursor ${token}`,
      get: "agentera state plan get --plan PLAN_ID",
    };
  }
  return response;
}

function serializedListBytes(response: PlanListResponse, format: "json" | "yaml"): number {
  const text = format === "json" ? JSON.stringify(response, null, 2) + "\n" : YAML.stringify(response, { sortMapEntries: false });
  return Buffer.byteLength(text, "utf8");
}

export function listPlans(projectRoot: string, activePath: string, options: { limit: number; cursor?: string; format: "text" | "json" | "yaml" }): PlanListResponse {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw fail(2, "invalid_request", "plan list limit must be an integer from 1 through 100", "list", {
      valid_values: ["1..100"],
    });
  }
  const discovery = discoverPlanArtifacts(activePath);
  const parsed = options.cursor ? parseCursor(options.cursor, projectRoot) : undefined;
  const plans = parsed ? plansFromSnapshot(discovery, parsed) : logicalPlans(discovery);
  const diagnostics = parsed?.diagnostics ?? discovery.diagnostics;
  const start = parsed?.after ?? 0;
  if (start > plans.length) throw fail(2, "cursor_invalid", "cursor position is outside its plan snapshot", "list");
  const requested = Math.min(options.limit, plans.length - start);
  let response = withPage(plans, diagnostics, start, requested, projectRoot, "page_limit");
  if (options.format === "json" || options.format === "yaml") {
    for (let retained = requested; retained > 0 && serializedListBytes(response, options.format) > MAX_LIST_BYTES; retained -= 1) {
      response = withPage(plans, diagnostics, start, retained - 1, projectRoot, "serialized_output_byte_budget");
    }
    if (serializedListBytes(response, options.format) > MAX_LIST_BYTES || (plans.length > start && response.entries.length === 0)) {
      throw fail(1, "unsupported_state", `one plan cannot fit within the ${MAX_LIST_BYTES}-byte ${options.format.toUpperCase()} list budget`, "list", {
        recovery: "Fetch a plan directly with agentera state plan get --plan PLAN_ID.",
      });
    }
  }
  return response;
}

function invalidCandidates(discovery: PlanArtifactDiscovery, selectedPlan: string): string[] {
  const paths = [...discovery.invalidArchivePaths];
  if (!discovery.active) paths.push(discovery.activePath);
  return paths
    .filter((candidatePath) => {
      if (!fs.existsSync(candidatePath)) return false;
      try {
        const value = loadYamlMapping(fs.readFileSync(candidatePath, "utf8"));
        const header = value.header;
        return header !== null && typeof header === "object" && !Array.isArray(header) && (header as JsonObject).id === selectedPlan;
      } catch {
        return false;
      }
    })
    .sort();
}

export function getPlan(activePath: string, selectedPlan: string): JsonObject {
  if (!PLAN_ID.test(selectedPlan)) {
    throw fail(2, "invalid_request", `invalid plan identity '${selectedPlan}'`, "get", {
      valid_values: ["plan:<lowercase-rfc9562-uuid>", "legacy-plan:<64-lowercase-hex-digest>"],
    });
  }
  const discovery = discoverPlanArtifacts(activePath);
  const matches = logicalPlans(discovery).filter((plan) => plan.stableId === selectedPlan);
  const invalid = invalidCandidates(discovery, selectedPlan);
  if (matches.length > 0 && (matches[0]!.identity.ambiguous || invalid.length > 0)) {
    const paths = [...new Set([...matches[0]!.paths, ...invalid])].sort();
    throw fail(1, "ambiguous", `plan identity '${selectedPlan}' resolves to multiple incompatible candidates`, "get", {
      stable_id: selectedPlan,
      recovery: "Repair the identity collision; Agentera will not choose a plan by path, mtime, or discovery order.",
      details: { candidate_paths: paths },
    });
  }
  if (invalid.length > 0) {
    const selectedDiagnostics = discovery.diagnostics.filter((diagnostic) => invalid.includes(diagnostic.path));
    throw fail(1, "corrupt", `plan '${selectedPlan}' exists but cannot be read safely`, "get", {
      stable_id: selectedPlan,
      recovery: "Repair the selected plan archive, then retry the exact get command.",
      details: { candidate_paths: invalid, diagnostics: selectedDiagnostics },
    });
  }
  const plan = matches[0];
  if (!plan) {
    throw fail(1, "not_found", `plan '${selectedPlan}' was not found`, "get", {
      stable_id: selectedPlan,
      recovery: "List active and archived plan identities with agentera state plan list, then retry.",
      details: { compatibility_diagnostics: discovery.diagnostics },
    });
  }
  const entry = catalogEntry(plan);
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state plan get",
    status: plan.identity.persisted ? "ok" : "degraded",
    entry,
    plan: plan.artifact.data,
    source: {
      artifact: "plan",
      plan_id: selectedPlan,
      compatibility_diagnostics: discovery.diagnostics,
      provenance: (entry.provenance ?? {}) as JsonObject,
    },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      complete_for_plan_retrieval: true,
      detail: "full_plan_document",
      storage_ownership: "owning_active_or_archived_plan_file",
    },
  };
}
