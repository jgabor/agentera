import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";


import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateEntityId, entityExactGetMaxBytes, exactDiscoveredEntityBytes, publishEntity, replaceEntity, replaceEntityUnderLock, validateEntityDiscovery, validateEntityState, withEntityWriterLock, type DiscoveredEntity, type EntityDiscoveryResult } from "./entityStorage.js";
import type { EntityPublicationContext } from "./entityPublicationContext.js";
import type { PublishedTargetIdentity } from "./entityPublicationContext.js";
import { detectStateModeBinding } from "./stateMode.js";
import { normalizeAndValidatePlanCreateInput, validatePlanPublicationCandidate } from "./write/planPublication.js";
import { reject } from "./write/errors.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { mutatePlanTaskEvaluation, planTaskRecordViolations } from "./write/planEvaluation.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";
import { entityListSelectorFlags, entityListSelectorKey, projectEntityList, resolveEntityListSelector, type EntityListSelectorInput } from "./entityListProjection.js";
import { shellQuoteArgument } from "../core/shell.js";

const ARTIFACT = "plan";
const PLAN = "plan";
const TASK = "plan_task";
const ID = /^[a-z]{10}$/;
const OPEN = new Set(["open"]);
const ORDER = "created_desc_then_id_asc";
const TASK_ORDER = "id_asc";

interface Options {
  sourceRoot?: string;
  publicationContext?: EntityPublicationContext;
  candidate?: () => string;
}

interface Contract { authorityPath: string; entityRoot: string; defaultLimit: number; maximumLimit: number; maxUtf8Bytes: number; openPlanConflictLimit: number }

function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function contract(sourceRoot = resolveSourceRoot()): Contract {
  const { authorityPath, document: authority } = loadStateStorageAuthority(sourceRoot);
  const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const definitions = Array.isArray(target.entities) ? target.entities : [];
  const definition = definitions.find((value) => mapping(value) && value.boundary === PLAN);
  const retrieval = mapping(definition) && mapping(definition.retrieval) ? definition.retrieval : {};
  const number = (value: unknown, field: string): number => {
    const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid plan entity ${field} authority`); return result;
  };
  const grammar = mapping(authority.mutation_grammar) ? authority.mutation_grammar : {};
  const operations = Array.isArray(grammar.operations) ? grammar.operations : [];
  const lifecycleLimits = ["create", "archive"].map((verb) => {
    const operation = operations.find((value) => mapping(value) && value.artifact === ARTIFACT && value.verb === verb);
    const bounds = mapping(operation) && mapping(operation.bounds) ? operation.bounds : {};
    return number(bounds.max_collection_items, `plan ${verb} max_collection_items`);
  });
  if (new Set(lifecycleLimits).size !== 1) throw new Error("invalid plan lifecycle max_collection_items authority");
  if (typeof storage.canonical_root !== "string") throw new Error(`invalid plan entity authority '${authorityPath}'`);
  return { authorityPath, entityRoot: storage.canonical_root, defaultLimit: number(retrieval.default_limit, "default_limit"), maximumLimit: number(retrieval.maximum_limit, "maximum_limit"), maxUtf8Bytes: number(retrieval.max_utf8_bytes, "max_utf8_bytes"), openPlanConflictLimit: lifecycleLimits[0] };
}

function failure(kind: StateFailureClass, message: string, recovery: string, id?: string, details?: JsonObject): StateRetrievalFailure {
  const exampleId = id && ID.test(id) ? id : "qjtrmnpvka";
  return new StateRetrievalFailure({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: "agentera state plan get --id ID --format json", example: `agentera state plan get --id ${exampleId} --format json`, recovery, artifact: ARTIFACT, ...(id ? { id } : {}), ...(details ? { details } : {}) } }, kind === "invalid_request" ? 2 : 1);
}
function relative(root: string, file: string): string { return path.relative(path.resolve(root), file).split(path.sep).join("/"); }
function all(root: string, sourceRoot: string, discovery?: EntityDiscoveryResult): DiscoveredEntity[] {
  const discovered = discovery
    ? validateEntityDiscovery(root, sourceRoot, discovery)
    : validateEntityState(root, sourceRoot);
  const graphIssue = discovered.issues.find((issue) => issue.artifact === ARTIFACT || issue.boundary === PLAN || issue.boundary === TASK);
  if (graphIssue) throw failure(graphIssue.code === "duplicate_id" ? "ambiguous" : "corrupt", graphIssue.message, graphIssue.recovery, graphIssue.id);
  const relevant = discovered.entities.filter((entity) => entity.artifact === ARTIFACT || entity.boundary === PLAN || entity.boundary === TASK);
  const bad = relevant.find((entity) => entity.classification !== "valid" || !entity.id || !entity.record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", `plan entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state and resolve the reported plan ownership conflict.", bad.id ?? undefined);
  return relevant;
}
function planStatus(entity: DiscoveredEntity): string { return String(mapping(entity.record?.header) ? entity.record!.header.status ?? "" : entity.record?.status ?? ""); }
function multipleOpenPlanConflict(open: DiscoveredEntity[], sourceRoot: string): { message: string; details: JsonObject } {
  const allIds = open.map((entity) => entity.id!).sort();
  const sampleIds = allIds.slice(0, contract(sourceRoot).openPlanConflictLimit);
  const omittedCount = allIds.length - sampleIds.length;
  return {
    message: `multiple open plans exist: ${sampleIds.join(", ")} (total=${allIds.length}, omitted=${omittedCount})`,
    details: { open_plan_candidates: { total: allIds.length, sample_ids: sampleIds, omitted_count: omittedCount } },
  };
}
function selectedPlan(entities: DiscoveredEntity[], requested?: string, sourceRoot = resolveSourceRoot()): DiscoveredEntity {
  if (requested !== undefined && !ID.test(requested)) throw failure("invalid_request", `plan ID '${requested}' must be ten lowercase letters`, "Use a bare plan ID returned by plan create or list.", requested);
  const plans = entities.filter((entity) => entity.boundary === PLAN);
  if (requested) {
    const matches = plans.filter((entity) => entity.id === requested);
    if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", matches.length ? `plan ID '${requested}' has conflicting ownership` : `plan ID '${requested}' was not found`, "Run agentera state plan list --format json and select one canonical plan ID.", requested);
    return matches[0];
  }
  const open = plans.filter((entity) => OPEN.has(planStatus(entity)));
  if (open.length === 1) return open[0];
  if (open.length === 0) throw failure("not_found", "no open plan exists", "Create a plan, or use agentera state plan get --id ID for completed plan detail.");
  const conflict = multipleOpenPlanConflict(open, sourceRoot);
  throw failure("ambiguous", conflict.message, "List plans, then use agentera state plan get --id ID or agentera state plan tasks list PLAN_ID.", undefined, conflict.details);
}

interface PlanLifecycleDecision {
  predecessor?: DiscoveredEntity;
  target?: DiscoveredEntity;
  archivedRecord?: JsonObject;
  replay: boolean;
  effects: JsonObject;
}

function archivedPlanRecord(plan: DiscoveredEntity): JsonObject {
  const record = structuredClone(plan.record!);
  const header = mapping(record.header) ? record.header : {};
  header.status = "archived";
  record.header = header;
  return record;
}

function preservedPlanEffects(plan: DiscoveredEntity): JsonObject {
  return {
    id: plan.id!,
    from_status: planStatus(plan),
    to_status: "archived",
    preserved: ["task_records", "task_evaluations", "task_completion"],
  };
}

function planLifecycleDecision(
  entities: DiscoveredEntity[],
  intent: { verb: "create"; force: boolean } | { verb: "archive"; force: boolean; plan?: string },
  sourceRoot: string,
): PlanLifecycleDecision {
  const plans = entities.filter((entity) => entity.boundary === PLAN);
  const open = plans.filter((entity) => planStatus(entity) === "open");

  if (intent.verb === "create") {
    if (open.length > 1) {
      const conflict = multipleOpenPlanConflict(open, sourceRoot);
      reject({
        class: "conflict",
        message: `${conflict.message}; implicit plan create cannot choose a predecessor`,
        diagnosis: conflict.details,
        recovery: "List the canonical plan IDs with agentera state plan list --status open --format json and resolve the competing open plans before creating a successor.",
      });
    }
    if (open.length === 1) {
      const predecessor = open[0];
      if (!intent.force) {
        reject({
          class: "conflict",
          message: `open plan '${predecessor.id}' blocks plan create`,
          recovery: `Use agentera state plan create --force --input PLAN.yaml --format json only to archive '${predecessor.id}' unchanged and publish a successor.`,
        });
      }
      return {
        predecessor,
        archivedRecord: archivedPlanRecord(predecessor),
        replay: false,
        effects: {
          lifecycle: "forced_replacement",
          force: true,
          archived_predecessor: preservedPlanEffects(predecessor),
          successor_lineage: { field: "previous_plan_archived", predecessor: predecessor.id! },
        },
      };
    }
    const completed = plans.filter((entity) => planStatus(entity) === "complete");
    const predecessor = completed.length === 1 ? completed[0] : undefined;
    return {
      ...(predecessor ? { predecessor, archivedRecord: archivedPlanRecord(predecessor) } : {}),
      replay: false,
      effects: {
        lifecycle: predecessor ? "completed_predecessor_replacement" : "create",
        force: intent.force,
        ...(predecessor ? {
          archived_predecessor: preservedPlanEffects(predecessor),
          successor_lineage: { field: "previous_plan_archived", predecessor: predecessor.id! },
        } : {}),
      },
    };
  }

  const target = selectedPlan(entities, intent.plan, sourceRoot);
  const status = planStatus(target);
  if (status === "open" && !intent.force) {
    reject({
      class: "conflict",
      message: `open plan '${target.id}' cannot be archived without --force`,
      recovery: `Complete '${target.id}', or use agentera state plan archive --plan ${target.id} --force --format json to preserve unfinished task history without claiming completion.`,
    });
  }
  const archivedRecord = archivedPlanRecord(target);
  const replay = canonicalRecordJson(archivedRecord) === canonicalRecordJson(target.record);
  return {
    target,
    archivedRecord,
    replay,
    effects: {
      lifecycle: status === "open" ? "forced_archive" : "archive",
      force: intent.force,
      archived_plan: preservedPlanEffects(target),
    },
  };
}

function taskFor(entities: DiscoveredEntity[], id: string, plan?: string): DiscoveredEntity {
  if (!ID.test(id)) throw failure("invalid_request", `task ID '${id}' must be ten lowercase letters`, "Use a bare task ID returned by plan task append or list.", id);
  if (plan !== undefined && !ID.test(plan)) throw failure("invalid_request", `plan ID '${plan}' must be ten lowercase letters`, "Use a bare plan ID returned by plan create or list.", plan);
  const matches = entities.filter((entity) => entity.boundary === TASK && entity.id === id);
  if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", matches.length ? `task ID '${id}' has conflicting ownership` : `task ID '${id}' was not found`, "Run agentera check validate state, or list tasks and retry with one canonical ID.", id);
  if (plan && matches[0].record?.plan !== plan) throw failure("not_found", `task ID '${id}' does not belong to plan '${plan}'`, "List tasks for the selected plan and retry.", id);
  return matches[0];
}
function entityPath(root: string, sourceRoot: string, boundary: string, id: string): string { return path.join(root, contract(sourceRoot).entityRoot, ARTIFACT, boundary, `${id}.yaml`); }
function envelope(command: string, entity: { id: string; path: string; replay: boolean }, record: JsonObject, dryRun: boolean, extra: JsonObject = {}): StateWriteEnvelope {
  return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: entity.path, id: entity.id, artifact: ARTIFACT, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: entity.replay }, validation: { status: "pass", violations: [] }, ...extra };
}
function newId(root: string, sourceRoot: string, reserved: Set<string>, candidate?: () => string): string {
  for (let attempt = 0; attempt < 1024; attempt += 1) {
    const id = allocateEntityId(root, candidate, sourceRoot);
    if (!reserved.has(id)) { reserved.add(id); return id; }
  }
  throw new Error("could not allocate unique plan entity IDs");
}

export function createPlanEntities(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  if (!options.publicationContext) {
    const binding = detectStateModeBinding(req.projectRoot, options.sourceRoot);
    if (binding.mode !== "entities") throw new Error("plan entity creation requires the durable entity-mode marker");
    try { return createPlanEntities(req, { ...options, publicationContext: binding.publicationContext }); }
    finally { binding.publicationContext.close(); }
  }
  return withEntityWriterLock(options.publicationContext, () => createPlanEntitiesUnderLock(req, options as Options & { publicationContext: EntityPublicationContext }));
}

function createPlanEntitiesUnderLock(req: StateWriteRequest, options: Options & { publicationContext: EntityPublicationContext }): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const input = structuredClone(req.input ?? {});
  normalizeAndValidatePlanCreateInput(input);
  validatePlanPublicationCandidate(dumpYamlMapping(input));
  const discovery = validateEntityState(options.publicationContext.pinnedPath(), sourceRoot, { kind: "project", projectRoot: options.publicationContext.validatedRoot });
  const entities = all(options.publicationContext.pinnedPath(), sourceRoot, discovery);
  const lifecycle = planLifecycleDecision(entities, { verb: "create", force: req.force }, sourceRoot);
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter(mapping) : [];
  const reserved = new Set<string>();
  const planId = newId(options.publicationContext?.pinnedPath() ?? req.projectRoot, sourceRoot, reserved, options.candidate);
  const taskIds = tasks.map(() => newId(options.publicationContext?.pinnedPath() ?? req.projectRoot, sourceRoot, reserved, options.candidate));
  const byNumber = new Map(tasks.map((task, index) => [Number(task.number), taskIds[index]]));
  const planRecord = structuredClone(input) as JsonObject; delete planRecord.tasks; delete planRecord.previous_plan_archived;
  const header = mapping(planRecord.header) ? planRecord.header : {}; delete header.id; planRecord.header = header;
  if (header.status === "active") header.status = "open";
  if (header.status === "completed") header.status = "complete";
  if (lifecycle.predecessor) planRecord.previous_plan_archived = lifecycle.predecessor.id!;
  const taskRecords = tasks.map((task, index): JsonObject => {
    const record = structuredClone(task) as JsonObject; delete record.number;
    record.plan = planId;
    const dependencies = Array.isArray(record.depends_on) ? record.depends_on : [];
    record.depends_on = dependencies.map((value) => {
      const target = byNumber.get(Number(value));
      if (!target) reject({ class: "schema_violation", message: `task ${index + 1} create-local dependency '${String(value)}' does not resolve within the atomic plan input` });
      return target;
    });
    if (!Array.isArray(record.acceptance)) record.acceptance = [];
    return record;
  });
  const publications = [{ boundary: PLAN, id: planId, record: planRecord }, ...taskRecords.map((record, index) => ({ boundary: TASK, id: taskIds[index], record }))];
  if (req.dryRun) return envelope("state plan create", { id: planId, path: entityPath(req.projectRoot, sourceRoot, PLAN, planId), replay: false }, planRecord, true, { tasks: taskRecords.map((record, index) => ({ id: taskIds[index], artifact: ARTIFACT, record })), effects: lifecycle.effects });
  const published: Array<{ relative: string; identity: PublishedTargetIdentity }> = [];
  let predecessor: { relative: string; archivedIdentity: PublishedTargetIdentity; bytes: string } | undefined;
  try {
    if (lifecycle.predecessor && lifecycle.archivedRecord) {
      const archived = replaceEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: PLAN, id: lifecycle.predecessor.id!, expectedRecord: lifecycle.predecessor.record!, expectedBytes: exactDiscoveredEntityBytes(lifecycle.predecessor), migrationProvenance: lifecycle.predecessor.migrationProvenance, record: lifecycle.archivedRecord });
      if (!archived.publishedIdentity || archived.previousBytes === undefined) throw new Error(`predecessor '${lifecycle.predecessor.id}' archive did not retain its exact recovery identity and bytes`);
      predecessor = { relative: relative(req.projectRoot, archived.path), archivedIdentity: archived.publishedIdentity, bytes: archived.previousBytes };
    }
    for (const item of publications) {
      const result = publishEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, ...item });
      if (!result.replay) {
        if (!result.publishedIdentity) throw new Error(`entity '${item.id}' publication did not return its exact target identity`);
        published.push({ relative: relative(req.projectRoot, result.path), identity: result.publishedIdentity });
      }
    }
    options.publicationContext.assertValid();
    const validation = validateEntityState(options.publicationContext.pinnedPath(), sourceRoot, { kind: "project", projectRoot: options.publicationContext.validatedRoot });
    if (!validation.valid) throw new Error(`created plan graph failed state validation: ${validation.issues.map(({ message }) => message).join("; ")}`);
    options.publicationContext.assertValid();
  } catch (error) {
    const recoveryFailures: string[] = [];
    for (const item of published.reverse()) {
      try {
        const removed = options.publicationContext.removeExact(item.relative, item.identity, false);
        if (removed === "identity_mismatch") recoveryFailures.push(`cleanup ownership changed for replacement entity '${item.relative}'`);
      } catch (cleanupError) {
        recoveryFailures.push(`cleanup failed for replacement entity '${item.relative}': ${(cleanupError as Error).message}`);
      }
    }
    if (predecessor) {
      try { options.publicationContext.restoreExact(predecessor.relative, predecessor.archivedIdentity, predecessor.bytes, entityExactGetMaxBytes(sourceRoot)); }
      catch (restoreError) { recoveryFailures.push(`predecessor restoration failed because ownership changed or publication was unsafe: ${(restoreError as Error).message}`); }
    }
    if (recoveryFailures.length) throw new Error(`plan replacement failed: ${(error as Error).message}; recovery failed: ${recoveryFailures.join("; ")}`, { cause: error });
    throw error;
  }
  return envelope("state plan create", { id: planId, path: entityPath(req.projectRoot, sourceRoot, PLAN, planId), replay: false }, planRecord, false, { tasks: taskRecords.map((record, index) => ({ id: taskIds[index], artifact: ARTIFACT, record })), effects: lifecycle.effects });
}

function taskRecord(req: StateWriteRequest, plan: string): JsonObject {
  const input = req.input ?? {};
  const record: JsonObject = { plan, name: String(input.name), status: "pending", depends_on: structuredClone(input.depends_on) as JsonObject["depends_on"], acceptance: structuredClone(input.acceptance) as JsonObject["acceptance"] };
  for (const field of ["evidence", "blocked_reason"])
    if (input[field] !== undefined) record[field] = structuredClone(input[field]) as never;
  return record;
}
function logicalTaskContent(record: JsonObject): JsonObject {
  const content: JsonObject = {
    name: record.name,
    depends_on: Array.isArray(record.depends_on) ? structuredClone(record.depends_on) as never : [],
    acceptance: Array.isArray(record.acceptance) ? structuredClone(record.acceptance) as never : [],
  };
  for (const field of ["evidence", "blocked_reason"])
    if (record[field] !== undefined) content[field] = structuredClone(record[field]) as never;
  return content;
}
function appendReplayOrConflict(entities: DiscoveredEntity[], planId: string, record: JsonObject): DiscoveredEntity | null {
  const logical = canonicalRecordJson(logicalTaskContent(record));
  const tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === planId);
  const sameName = tasks.filter((task) => task.record?.name === record.name);
  if (sameName.length === 0) return null;
  const identical = sameName.filter((task) => canonicalRecordJson(logicalTaskContent(task.record!)) === logical);
  if (identical.length === 1 && identical.length === sameName.length) return identical[0];
  if (identical.length > 1)
    reject({ class: "conflict", message: `plan '${planId}' contains multiple identical tasks named '${String(record.name)}'; retry cannot choose one existing task` });
  reject({ class: "conflict", message: `plan task '${String(record.name)}' already exists with different fields; use 'state plan update --id ID --input task-patch.yaml' to modify it` });
}
function assertDependencies(root: string, sourceRoot: string, record: JsonObject, taskId?: string): void {
  const entities = all(root, sourceRoot); const dependencies = Array.isArray(record.depends_on) ? record.depends_on : [];
  for (const dependency of dependencies) {
    if (typeof dependency !== "string" || !ID.test(dependency)) reject({ class: "schema_violation", message: `task dependency '${String(dependency)}' must be a bare task ID` });
    const target = taskFor(entities, dependency);
    if (target.record?.plan !== record.plan) reject({ class: "schema_violation", message: `task dependency '${dependency}' belongs to a different plan` });
    if (dependency === taskId) reject({ class: "schema_violation", message: "a task cannot depend on itself" });
  }
}
function hasSupersededPredecessor(entities: DiscoveredEntity[], planId: string, taskId: string): boolean {
  return entities.some((entity) => entity.boundary === TASK
    && entity.record?.plan === planId
    && entity.record?.status === "superseded"
    && Array.isArray(entity.record.superseded_by)
    && entity.record.superseded_by.includes(taskId));
}
function isCompletePassingReplacement(entity: DiscoveredEntity | undefined): boolean {
  const candidate = entity?.record?.evaluation;
  const evaluation = mapping(candidate) ? candidate : undefined;
  return entity?.record?.status === "complete" && evaluation?.last_verdict === "pass";
}
function assertProjectedTask(entities: DiscoveredEntity[], id: string, record: JsonObject): void {
  const violations = planTaskRecordViolations(record, `plan task '${id}'`);
  if (violations.length) reject({ class: "schema_violation", message: `plan task '${id}' would violate the task schema`, violations });
  const planId = String(record.plan);
  const records = new Map(entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === planId && entity.id).map((entity) => [entity.id!, entity.id === id ? record : entity.record!]));
  if (records.has(id) === false) records.set(id, record);
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (current: string): boolean => {
    if (visiting.has(current)) return true; if (visited.has(current)) return false;
    visiting.add(current); const value = records.get(current); const cyclic = (Array.isArray(value?.depends_on) ? value.depends_on : []).some((dependency) => typeof dependency === "string" && records.has(dependency) && visit(dependency)); visiting.delete(current); visited.add(current); return cyclic;
  };
  if ([...records.keys()].some(visit)) reject({ class: "schema_violation", message: `task '${id}' would create a dependency cycle in plan '${planId}'` });
  if (record.status !== "complete" && hasSupersededPredecessor(entities, planId, id))
    reject({ class: "conflict", message: `task '${id}' must remain complete while it is referenced by a superseded task` });
  const plan = entities.find((entity) => entity.boundary === PLAN && entity.id === planId);
  if (plan && planStatus(plan) === "complete" && !["complete", "superseded"].includes(String(record.status))) reject({ class: "conflict", message: `task '${id}' cannot become incomplete while plan '${planId}' is complete` });
}

function supersedeTask(entities: DiscoveredEntity[], task: DiscoveredEntity, taskId: string, planId: string, values: Record<string, unknown>): JsonObject {
  const reason = String(values.superseded_reason ?? "").trim();
  const replacements = Array.isArray(values.superseded_by) ? values.superseded_by.map(String) : [];
  if (!replacements.length) reject({ class: "schema_violation", message: "supersede requires at least one --by replacement task ID" });
  if (new Set(replacements).size !== replacements.length) reject({ class: "schema_violation", message: "supersede replacement task IDs must be distinct" });
  if (!reason || reason.length > 500) reject({ class: "schema_violation", message: "supersede --reason must be a non-empty explanation of at most 500 characters" });
  const normalized = [...replacements].sort();
  if (task.record?.status === "superseded") {
    const existing = Array.isArray(task.record.superseded_by) ? task.record.superseded_by : [];
    if (canonicalRecordJson(existing) === canonicalRecordJson(normalized) && task.record.superseded_reason === reason)
      return structuredClone(task.record);
    reject({ class: "conflict", message: `task '${taskId}' is already superseded with different replacements or reason` });
  }
  if (task.record?.status !== "blocked") reject({ class: "conflict", message: `only a currently blocked task can be superseded; task '${taskId}' is ${String(task.record?.status)}` });
  for (const replacementId of normalized) {
    if (!ID.test(replacementId)) reject({ class: "schema_violation", message: `supersede replacement task ID '${replacementId}' must be ten lowercase letters` });
    if (replacementId === taskId) reject({ class: "schema_violation", message: "a task cannot supersede itself" });
    const replacement = taskFor(entities, replacementId, planId);
    if (!isCompletePassingReplacement(replacement)) {
      const historicallyReferenced = hasSupersededPredecessor(entities, planId, replacementId);
      const hasEvaluation = mapping(replacement.record?.evaluation);
      reject({
        class: "conflict",
        message: `supersede replacement task '${replacementId}' must be complete with latest persisted PASS evidence`,
        recovery: historicallyReferenced
          ? hasEvaluation
            ? `Replacement task '${replacementId}' already has non-PASS evaluation state, so historical first-PASS recovery is unavailable; use another complete latest-PASS replacement, or keep the plan open or archive it without claiming completion as applicable.`
            : `Record the allowed first PASS for historical replacement task '${replacementId}' while it remains complete, then retry supersession; no state was changed.`
          : `Reopen replacement task '${replacementId}', record PASS, complete it, then retry supersession; no state was changed.`,
      });
    }
  }
  const record = structuredClone(task.record!);
  record.status = "superseded";
  record.superseded_by = normalized;
  record.superseded_reason = reason;
  return record;
}
export function mutatePlanEntities(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  if (req.spec.verb === "create") return createPlanEntities(req, options);
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = all(req.projectRoot, sourceRoot);
  if (req.spec.verb === "set-plan-status" && req.values.id !== undefined) reject({ class: "invalid_request", message: "plan set-plan-status accepts only the --plan selector; --id is a task selector and is not valid for plan lifecycle" });
  if (req.spec.verb === "archive") {
    const lifecycle = planLifecycleDecision(entities, { verb: "archive", force: req.force, ...(typeof req.values.plan === "string" ? { plan: req.values.plan } : {}) }, sourceRoot);
    const plan = lifecycle.target!;
    const record = lifecycle.archivedRecord!;
    if (lifecycle.replay) return envelope("state plan archive", { id: plan.id!, path: plan.path, replay: true }, record, req.dryRun, { effects: lifecycle.effects });
    if (req.dryRun) return envelope("state plan archive", { id: plan.id!, path: plan.path, replay: false }, record, true, { effects: lifecycle.effects });
    const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: PLAN, id: plan.id!, expectedRecord: plan.record!, expectedBytes: exactDiscoveredEntityBytes(plan), migrationProvenance: plan.migrationProvenance, record });
    return envelope("state plan archive", result, record, false, { effects: lifecycle.effects });
  }
  const plan = selectedPlan(entities, typeof req.values.plan === "string" ? req.values.plan : undefined, sourceRoot);
  if (req.spec.verb === "append") {
    if (!OPEN.has(planStatus(plan))) reject({ class: "conflict", message: `plan '${plan.id}' is ${planStatus(plan)} and cannot accept a new task` });
    const record = taskRecord(req, plan.id!); assertDependencies(req.projectRoot, sourceRoot, record);
    const replay = appendReplayOrConflict(entities, plan.id!, record);
    if (replay) return envelope("state plan append", { id: replay.id!, path: replay.path, replay: true }, replay.record!, req.dryRun);
    const id = allocateEntityId(options.publicationContext?.pinnedPath() ?? req.projectRoot, options.candidate, sourceRoot);
    assertProjectedTask(entities, id, record);
    if (req.dryRun) return envelope("state plan append", { id, path: entityPath(req.projectRoot, sourceRoot, TASK, id), replay: false }, record, true);
    const result = publishEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: TASK, id, record });
    return envelope("state plan append", result, record, false);
  }
  if (req.spec.verb === "set-plan-status") {
    const tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === plan.id);
    const requested = String(req.values.status);
    if (planStatus(plan) === "archived") reject({ class: "conflict", message: `archived plan '${plan.id}' is immutable` });
    const record = structuredClone(plan.record!); const header = mapping(record.header) ? record.header : {}; header.status = requested; record.header = header;
    const command = "state plan set-plan-status";
    if (canonicalRecordJson(record) === canonicalRecordJson(plan.record)) return envelope(command, { id: plan.id!, path: plan.path, replay: true }, record, req.dryRun);
    if (requested === "complete" && tasks.some((task) => !["complete", "superseded"].includes(String(task.record?.status)))) reject({ class: "conflict", message: "plan cannot be completed while incomplete tasks remain" });
    if (requested === "complete") {
      for (const task of tasks.filter((candidate) => candidate.record?.status === "superseded")) {
        for (const replacementId of Array.isArray(task.record?.superseded_by) ? task.record.superseded_by : []) {
          if (typeof replacementId !== "string") continue;
          const replacement = tasks.find((candidate) => candidate.id === replacementId);
          if (!isCompletePassingReplacement(replacement)) reject({
            class: "conflict",
            message: `plan '${plan.id}' cannot be completed because replacement task '${replacementId}' lacks complete latest persisted PASS evidence`,
            recovery: mapping(replacement?.record?.evaluation)
              ? `Replacement task '${replacementId}' cannot use historical first-PASS recovery because it already has evaluation state; keep the plan open or archive it without claiming completion.`
              : `Record the allowed first PASS for replacement task '${replacementId}' with agentera state plan record-evaluation --id ${replacementId}, then retry plan completion; no state was changed.`,
          });
        }
      }
    }
    if (req.dryRun) return envelope(command, { id: plan.id!, path: plan.path, replay: false }, record, true);
    const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: PLAN, id: plan.id!, expectedRecord: plan.record!, expectedBytes: exactDiscoveredEntityBytes(plan), migrationProvenance: plan.migrationProvenance, record });
    return envelope(command, result, record, false);
  }
  if (planStatus(plan) === "archived") reject({ class: "conflict", message: `archived plan '${plan.id}' is immutable` });
  const taskId = String(req.values.id ?? ""); const task = taskFor(entities, taskId, plan.id!); const record = structuredClone(task.record!);
  if (req.spec.verb === "supersede") {
    const superseded = supersedeTask(entities, task, taskId, plan.id!, req.values);
    if (canonicalRecordJson(superseded) === canonicalRecordJson(task.record)) return envelope("state plan supersede", { id: taskId, path: task.path, replay: true }, superseded, req.dryRun);
    if (req.dryRun) return envelope("state plan supersede", { id: taskId, path: task.path, replay: false }, superseded, true);
    const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: TASK, id: taskId, expectedRecord: task.record!, expectedBytes: exactDiscoveredEntityBytes(task), migrationProvenance: task.migrationProvenance, record: superseded });
    return envelope("state plan supersede", result, superseded, false);
  }
  if (req.spec.verb === "update") {
    const input = req.input ?? {};
    const taskFields = ["name", "depends_on", "acceptance", "evidence", "blocked_reason"];
    if (input.surprise !== undefined) {
      if (taskFields.some((field) => input[field] !== undefined)) reject({ class: "conflict", message: "entity mode cannot combine a plan-level surprise with task-field changes in one command; publish them as separate updates" });
      const planRecord = structuredClone(plan.record!); const current = String(planRecord.surprises ?? "").trim(); const surprise = String(input.surprise);
      if (!current.split("\n").includes(surprise)) planRecord.surprises = current ? `${current}\n${surprise}` : surprise;
      if (canonicalRecordJson(planRecord) === canonicalRecordJson(plan.record)) return envelope("state plan update", { id: plan.id!, path: plan.path, replay: true }, planRecord, req.dryRun);
      if (req.dryRun) return envelope("state plan update", { id: plan.id!, path: plan.path, replay: false }, planRecord, true);
      const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: PLAN, id: plan.id!, expectedRecord: plan.record!, expectedBytes: exactDiscoveredEntityBytes(plan), migrationProvenance: plan.migrationProvenance, record: planRecord });
      return envelope("state plan update", result, planRecord, false);
    }
    for (const field of taskFields) if (Object.prototype.hasOwnProperty.call(input, field)) {
      const value = input[field];
      if (value === null) {
        if (field === "depends_on" || field === "acceptance") record[field] = [];
        else delete record[field];
      } else record[field] = structuredClone(value) as never;
    }
    assertDependencies(req.projectRoot, sourceRoot, record, taskId);
  } else if (req.spec.verb === "set-status") record.status = String(req.values.status);
  else if (req.spec.verb === "record-evaluation") {
    const completedReplacementRecovery = OPEN.has(planStatus(plan)) && hasSupersededPredecessor(entities, plan.id!, taskId);
    const mutation = mutatePlanTaskEvaluation(record, req.values.evaluation, `plan task '${taskId}'`, completedReplacementRecovery);
    if (mutation.replay) return envelope("state plan record-evaluation", { id: taskId, path: task.path, replay: true }, record, req.dryRun);
  }
  assertProjectedTask(entities, taskId, record);
  if (canonicalRecordJson(record) === canonicalRecordJson(task.record)) return envelope(`state plan ${req.spec.verb}`, { id: taskId, path: task.path, replay: true }, record, req.dryRun);
  if (req.dryRun) return envelope(`state plan ${req.spec.verb}`, { id: taskId, path: task.path, replay: false }, record, true);
  const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: TASK, id: taskId, expectedRecord: task.record!, expectedBytes: exactDiscoveredEntityBytes(task), migrationProvenance: task.migrationProvenance, record });
  return envelope(`state plan ${req.spec.verb}`, result, record, false);
}

function snapshot(root: string, entities: DiscoveredEntity[]): string { return createHash("sha256").update(canonicalRecordJson(entities.map(({ id, boundary, record, path: file }) => ({ id, boundary, record, path: relative(root, file) })).sort((a, b) => canonicalRecordJson(a).localeCompare(canonicalRecordJson(b))))).digest("hex"); }
function secret(root: string, authorityPath: string): Buffer { return createHash("sha256").update(path.resolve(root)).update("\0").update(fs.readFileSync(authorityPath)).digest(); }
function encode(value: JsonObject, root: string, authorityPath: string): string { const bytes = Buffer.from(canonicalRecordJson(value)); return `${bytes.toString("base64url")}.${createHmac("sha256", secret(root, authorityPath)).update(bytes).digest("base64url")}`; }
function decode(token: string, root: string, authorityPath: string): JsonObject { try { const [body, signature, extra] = token.split("."); if (!body || !signature || extra) throw new Error(); const bytes = Buffer.from(body, "base64url"); const supplied = Buffer.from(signature, "base64url"); const expected = createHmac("sha256", secret(root, authorityPath)).update(bytes).digest(); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error(); const value = JSON.parse(bytes.toString()); if (!mapping(value)) throw new Error(); return value; } catch { throw failure("cursor_invalid", "plan cursor is malformed or belongs to another project", "Copy next_cursor exactly, or omit --cursor to restart."); } }
function entry(root: string, entity: DiscoveredEntity): JsonObject { return { id: entity.id!, artifact: ARTIFACT, record: entity.record!, provenance: { storage: "canonical_entity_file", path: relative(root, entity.path) } }; }
function boundedList(root: string, sourceRoot: string, selected: DiscoveredEntity[], allEntities: DiscoveredEntity[], limit: number | undefined, cursor: string | undefined, order: string, command: string, filter: JsonObject, format = "json", envelope: JsonObject = {}, decodedCursor?: JsonObject, selectorInput?: EntityListSelectorInput): JsonObject {
  const declared = contract(sourceRoot); const take = limit ?? declared.defaultLimit; if (!Number.isSafeInteger(take) || take < 1 || take > declared.maximumLimit) throw failure("invalid_request", `plan list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.");
  const projectionOptions = { family: (command.includes("tasks") ? "plan_tasks" : "plans") as "plan_tasks" | "plans", artifact: ARTIFACT, boundary: command.includes("tasks") ? TASK : PLAN, format, maxUtf8Bytes: declared.maxUtf8Bytes, selector: selectorInput };
  const selector = resolveEntityListSelector(selectorInput, selected.map((entity) => entry(root, entity)), projectionOptions);
  const selectorKey = entityListSelectorKey(selector);
  const snap = snapshot(root, allEntities); let start = 0;
  if (cursor) { const value = decodedCursor ?? decode(cursor, root, declared.authorityPath); if (value.selector !== selectorKey) throw failure("cursor_invalid", "plan cursor selectors do not match this request", "Repeat the original selector, or omit --cursor to restart from current state."); if (value.snapshot_id !== snap || value.order !== order || canonicalRecordJson(value.filter) !== canonicalRecordJson(filter)) throw failure("cursor_snapshot_unavailable", "plan state or filters changed after this cursor snapshot", "Repeat the original filters, or omit --cursor to restart from current state."); const found = selected.findIndex((entity) => entity.id === value.after); if (found < 0) throw failure("cursor_snapshot_unavailable", "plan cursor continuation is unavailable", "Omit --cursor to restart."); start = found + 1; }
  const page = selected.slice(start, start + take);
  const remaining = selected.length - start - page.length;
  const next = remaining && page.length ? encode({ snapshot_id: snap, order, filter, selector: selectorKey, after: page.at(-1)!.id! }, root, declared.authorityPath) : undefined;
  const familyIdentifier = command.includes("tasks") && typeof filter.plan === "string" ? ` ${shellQuoteArgument(filter.plan)}` : "";
  const filterFlags = filter.status ? ` --status ${shellQuoteArgument(Array.isArray(filter.status) ? filter.status.join(",") : filter.status)}` : "";
  const selectorFlags = entityListSelectorFlags(selector);
  const response: JsonObject = { schemaVersion: "agentera.stateList.v1", command, status: remaining ? "degraded" : "ok", entries: page.map((entity) => entry(root, entity)), counts: { total: selected.length, returned: page.length, remaining }, order, filters: filter, snapshot: { id: snap, first_page: !cursor, has_more: Boolean(remaining), candidate_count: selected.length }, source: { artifact: ARTIFACT, authority: "canonical_entity_files", root: declared.entityRoot }, retrieval: { ...(next ? { continue: `${command.replace("state ", "agentera state ")}${familyIdentifier}${filterFlags}${selectorFlags} --limit ${take} --cursor ${next} --format json` } : {}) }, ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: "page_limit", next_cursor: next } : {}), ...envelope };
  return projectEntityList(response, selector, projectionOptions);
}
export function getPlanEntity(root: string, id: string, sourceRoot = resolveSourceRoot()): JsonObject { const entities = all(root, sourceRoot); const plan = selectedPlan(entities, id, sourceRoot); return { schemaVersion: "agentera.stateGet.v1", command: "state plan get", status: "ok", entry: entry(root, plan), tasks: entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === id).sort((a, b) => a.id!.localeCompare(b.id!)).map((entity) => entry(root, entity)), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entities" } }; }
export function listPlanEntities(root: string, limit?: number, cursor?: string, options: { sourceRoot?: string; format?: string; statuses?: string[]; discovery?: EntityDiscoveryResult; selector?: EntityListSelectorInput } = {}): JsonObject { const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = all(root, sourceRoot, options.discovery); const statuses = options.statuses?.length ? new Set(options.statuses) : undefined; const plans = entities.filter((entity) => entity.boundary === PLAN && (!statuses || statuses.has(planStatus(entity)))).sort((a, b) => String(mapping(b.record?.header) ? b.record!.header.created ?? "" : "").localeCompare(String(mapping(a.record?.header) ? a.record!.header.created ?? "" : "")) || a.id!.localeCompare(b.id!)); return boundedList(root, sourceRoot, plans, entities, limit, cursor, ORDER, "state plan list", options.statuses ? { status: options.statuses } : {}, options.format, {}, undefined, options.selector); }
export function getPlanTaskEntity(root: string, id: string, planId?: string, sourceRoot = resolveSourceRoot()): JsonObject { const entities = all(root, sourceRoot); const task = taskFor(entities, id, planId); return { schemaVersion: "agentera.stateGet.v1", command: "state plan tasks get", status: "ok", entry: entry(root, task), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entity" } }; }
export function listPlanTaskEntities(root: string, planId?: string, limit?: number, cursor?: string, options: { sourceRoot?: string; format?: string; discovery?: EntityDiscoveryResult; selector?: EntityListSelectorInput } = {}): JsonObject { const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = all(root, sourceRoot, options.discovery); const declared = contract(sourceRoot); const decodedCursor = cursor ? decode(cursor, root, declared.authorityPath) : undefined; const cursorFilter = mapping(decodedCursor?.filter) ? decodedCursor.filter : undefined; const cursorPlan = typeof cursorFilter?.plan === "string" && ID.test(cursorFilter.plan) ? cursorFilter.plan : undefined; if (decodedCursor && !cursorPlan) throw failure("cursor_snapshot_unavailable", "plan state changed after this cursor snapshot", "Omit --cursor to restart from current state."); const plan = selectedPlan(entities, planId ?? cursorPlan, sourceRoot); const tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === plan.id).sort((a, b) => a.id!.localeCompare(b.id!)); return boundedList(root, sourceRoot, tasks, entities, limit, cursor, TASK_ORDER, "state plan tasks list", { plan: plan.id! }, options.format, {}, decodedCursor, options.selector); }

export function currentPlanEntityView(root: string, limit?: number, cursor?: string, status?: string, options: { sourceRoot?: string; format?: string } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const entities = all(root, sourceRoot);
  const plan = selectedPlan(entities, undefined, sourceRoot);
  let tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === plan.id);
  if (status) tasks = tasks.filter((entity) => entity.record?.status === status);
  tasks.sort((a, b) => a.id!.localeCompare(b.id!));
  return boundedList(root, sourceRoot, tasks, entities, limit, cursor, TASK_ORDER, "state plan", { plan: plan.id!, status: status ?? null }, options.format, { plan: entry(root, plan) });
}
