import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { serializedProjectionBytes } from "./projectionPolicy.js";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateEntityId, publishEntity, replaceEntity, validateEntityState, type DiscoveredEntity } from "./entityStorage.js";
import type { EntityPublicationContext } from "./entityPublicationContext.js";
import type { PublishedTargetIdentity } from "./entityPublicationContext.js";
import { detectStateModeBinding } from "./stateMode.js";
import { validatePlanCreateInput, validatePlanPublicationCandidate } from "./write/planPublication.js";
import { reject } from "./write/errors.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { mutatePlanTaskEvaluation, planTaskRecordViolations } from "./write/planEvaluation.js";

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

interface Contract { authorityPath: string; entityRoot: string; defaultLimit: number; maximumLimit: number; maxUtf8Bytes: number }

function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function contract(sourceRoot = resolveSourceRoot()): Contract {
  const authorityPath = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const definitions = Array.isArray(target.entities) ? target.entities : [];
  const definition = definitions.find((value) => mapping(value) && value.boundary === PLAN);
  const retrieval = mapping(definition) && mapping(definition.retrieval) ? definition.retrieval : {};
  const number = (value: unknown, field: string): number => {
    const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid plan entity ${field} authority`); return result;
  };
  if (typeof storage.canonical_root !== "string") throw new Error(`invalid plan entity authority '${authorityPath}'`);
  return { authorityPath, entityRoot: storage.canonical_root, defaultLimit: number(retrieval.default_limit, "default_limit"), maximumLimit: number(retrieval.maximum_limit, "maximum_limit"), maxUtf8Bytes: number(retrieval.max_utf8_bytes, "max_utf8_bytes") };
}

function failure(kind: StateFailureClass, message: string, recovery: string, id?: string): StateRetrievalFailure {
  return new StateRetrievalFailure({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: "agentera state plan get --id ID --format json", example: `agentera state plan get --id ${id ?? "qjtrmnpvka"} --format json`, recovery, artifact: ARTIFACT, ...(id ? { id } : {}) } }, kind === "invalid_request" ? 2 : 1);
}
function relative(root: string, file: string): string { return path.relative(path.resolve(root), file).split(path.sep).join("/"); }
function all(root: string, sourceRoot: string): DiscoveredEntity[] {
  const discovered = validateEntityState(root, sourceRoot);
  const graphIssue = discovered.issues.find((issue) => issue.artifact === ARTIFACT || issue.boundary === PLAN || issue.boundary === TASK);
  if (graphIssue) throw failure(graphIssue.code === "duplicate_id" ? "ambiguous" : "corrupt", graphIssue.message, graphIssue.recovery, graphIssue.id);
  const relevant = discovered.entities.filter((entity) => entity.artifact === ARTIFACT || entity.boundary === PLAN || entity.boundary === TASK);
  const bad = relevant.find((entity) => entity.classification !== "valid" || !entity.id || !entity.record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", `plan entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state and resolve the reported plan ownership conflict.", bad.id ?? undefined);
  return relevant;
}
function planStatus(entity: DiscoveredEntity): string { return String(mapping(entity.record?.header) ? entity.record!.header.status ?? "" : entity.record?.status ?? ""); }
function selectedPlan(entities: DiscoveredEntity[], requested?: string): DiscoveredEntity {
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
  throw failure("ambiguous", `multiple open plans exist: ${open.map(({ id }) => id).sort().join(", ")}`, "List plans, then use agentera state plan get --id ID or agentera state plan tasks list --plan-id ID.");
}
function taskFor(entities: DiscoveredEntity[], id: string, plan?: string): DiscoveredEntity {
  if (!ID.test(id)) throw failure("invalid_request", `task ID '${id}' must be ten lowercase letters`, "Use a bare task ID returned by plan task append or list.", id);
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
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const input = structuredClone(req.input ?? {});
  validatePlanCreateInput(input);
  validatePlanPublicationCandidate(dumpYamlMapping(input));
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter(mapping) : [];
  const reserved = new Set<string>();
  const planId = newId(options.publicationContext?.pinnedPath() ?? req.projectRoot, sourceRoot, reserved, options.candidate);
  const taskIds = tasks.map(() => newId(options.publicationContext?.pinnedPath() ?? req.projectRoot, sourceRoot, reserved, options.candidate));
  const byNumber = new Map(tasks.map((task, index) => [Number(task.number), taskIds[index]]));
  const planRecord = structuredClone(input) as JsonObject; delete planRecord.tasks; delete planRecord.previous_plan_archived;
  const header = mapping(planRecord.header) ? planRecord.header : {}; delete header.id; planRecord.header = header;
  if (header.status === "active") header.status = "open";
  if (header.status === "completed") header.status = "complete";
  const taskRecords = tasks.map((task, index): JsonObject => {
    const record = structuredClone(task) as JsonObject; delete record.number;
    record.plan = planId;
    const dependencies = Array.isArray(record.depends_on) ? record.depends_on : [];
    record.depends_on = dependencies.map((value) => {
      const target = byNumber.get(Number(value));
      if (!target) reject({ class: "schema_violation", message: `task ${index + 1} dependency '${String(value)}' does not resolve within the created plan` });
      return target;
    });
    if (!Array.isArray(record.acceptance)) record.acceptance = [];
    return record;
  });
  const publications = [{ boundary: PLAN, id: planId, record: planRecord }, ...taskRecords.map((record, index) => ({ boundary: TASK, id: taskIds[index], record }))];
  if (req.dryRun) return envelope("state plan create", { id: planId, path: entityPath(req.projectRoot, sourceRoot, PLAN, planId), replay: false }, planRecord, true, { tasks: taskRecords.map((record, index) => ({ id: taskIds[index], artifact: ARTIFACT, record })) });
  const published: Array<{ relative: string; identity: PublishedTargetIdentity }> = [];
  try {
    for (const item of publications) {
      const result = publishEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, ...item });
      if (!result.replay) {
        if (!result.publishedIdentity) throw new Error(`entity '${item.id}' publication did not return its exact target identity`);
        published.push({ relative: relative(req.projectRoot, result.path), identity: result.publishedIdentity });
      }
    }
    options.publicationContext.assertValid();
    const validation = validateEntityState(options.publicationContext?.pinnedPath() ?? req.projectRoot, sourceRoot);
    if (!validation.valid) throw new Error(`created plan graph failed state validation: ${validation.issues.map(({ message }) => message).join("; ")}`);
    options.publicationContext.assertValid();
  } catch (error) {
    for (const item of published.reverse()) options.publicationContext?.removeExact(item.relative, item.identity);
    throw error;
  }
  return envelope("state plan create", { id: planId, path: entityPath(req.projectRoot, sourceRoot, PLAN, planId), replay: false }, planRecord, false, { tasks: taskRecords.map((record, index) => ({ id: taskIds[index], artifact: ARTIFACT, record })) });
}

function taskRecord(req: StateWriteRequest, plan: string): JsonObject {
  const record: JsonObject = { plan, name: String(req.values.name), status: String(req.values.status ?? "pending"), depends_on: Array.isArray(req.values.depends_on) ? req.values.depends_on : [], acceptance: Array.isArray(req.values.acceptance) ? req.values.acceptance : [] };
  return record;
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
  const plan = entities.find((entity) => entity.boundary === PLAN && entity.id === planId);
  if (plan && planStatus(plan) === "complete" && record.status !== "complete") reject({ class: "conflict", message: `task '${id}' cannot become incomplete while plan '${planId}' is complete` });
}
export function mutatePlanEntities(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = all(req.projectRoot, sourceRoot);
  if (req.spec.verb === "create") return createPlanEntities(req, options);
  const plan = selectedPlan(entities, typeof req.values.plan === "string" ? req.values.plan : undefined);
  if (req.spec.verb === "append") {
    if (!OPEN.has(planStatus(plan))) reject({ class: "conflict", message: `plan '${plan.id}' is ${planStatus(plan)} and cannot accept a new task` });
    const record = taskRecord(req, plan.id!); assertDependencies(req.projectRoot, sourceRoot, record);
    const id = allocateEntityId(options.publicationContext?.pinnedPath() ?? req.projectRoot, options.candidate, sourceRoot);
    assertProjectedTask(entities, id, record);
    if (req.dryRun) return envelope("state plan append", { id, path: entityPath(req.projectRoot, sourceRoot, TASK, id), replay: false }, record, true);
    const result = publishEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: TASK, id, record });
    return envelope("state plan append", result, record, false);
  }
  if (req.spec.verb === "set-plan-status" || req.spec.verb === "archive") {
    const tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === plan.id);
    const requested = req.spec.verb === "archive" ? "archived" : String(req.values.status);
    if (requested === "complete" && tasks.some((task) => task.record?.status !== "complete")) reject({ class: "conflict", message: "plan cannot be completed while incomplete tasks remain" });
    if (planStatus(plan) === "archived" && req.spec.verb !== "archive") reject({ class: "conflict", message: `archived plan '${plan.id}' is immutable` });
    const record = structuredClone(plan.record!); const header = mapping(record.header) ? record.header : {}; header.status = requested; record.header = header;
    const command = req.spec.verb === "archive" ? "state plan archive" : "state plan set-plan-status";
    if (canonicalRecordJson(record) === canonicalRecordJson(plan.record)) return envelope(command, { id: plan.id!, path: plan.path, replay: true }, record, req.dryRun);
    if (req.dryRun) return envelope(command, { id: plan.id!, path: plan.path, replay: false }, record, true);
    const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: PLAN, id: plan.id!, expectedRecord: plan.record!, record });
    return envelope(command, result, record, false);
  }
  if (planStatus(plan) === "archived") reject({ class: "conflict", message: `archived plan '${plan.id}' is immutable` });
  const taskId = String(req.values.id ?? ""); const task = taskFor(entities, taskId, plan.id!); const record = structuredClone(task.record!);
  if (req.spec.verb === "update") {
    const taskFields = ["name", "depends_on", "acceptance", "status", "evidence", "blocked_reason"];
    if (req.values.surprise !== undefined) {
      if (taskFields.some((field) => req.values[field] !== undefined)) reject({ class: "conflict", message: "entity mode cannot combine a plan-level surprise with task-field changes in one command; publish them as separate updates" });
      const planRecord = structuredClone(plan.record!); const current = String(planRecord.surprises ?? "").trim(); const surprise = String(req.values.surprise);
      if (!current.split("\n").includes(surprise)) planRecord.surprises = current ? `${current}\n${surprise}` : surprise;
      if (canonicalRecordJson(planRecord) === canonicalRecordJson(plan.record)) return envelope("state plan update", { id: plan.id!, path: plan.path, replay: true }, planRecord, req.dryRun);
      if (req.dryRun) return envelope("state plan update", { id: plan.id!, path: plan.path, replay: false }, planRecord, true);
      const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: PLAN, id: plan.id!, expectedRecord: plan.record!, record: planRecord });
      return envelope("state plan update", result, planRecord, false);
    }
    for (const field of taskFields) if (req.values[field] !== undefined) record[field] = req.values[field] as never;
    assertDependencies(req.projectRoot, sourceRoot, record, taskId);
  } else if (req.spec.verb === "set-status") record.status = String(req.values.status);
  else if (req.spec.verb === "record-evaluation") {
    const mutation = mutatePlanTaskEvaluation(record, req.values.evaluation, `plan task '${taskId}'`);
    if (mutation.replay) return envelope("state plan record-evaluation", { id: taskId, path: task.path, replay: true }, record, req.dryRun);
  }
  assertProjectedTask(entities, taskId, record);
  if (canonicalRecordJson(record) === canonicalRecordJson(task.record)) return envelope(`state plan ${req.spec.verb}`, { id: taskId, path: task.path, replay: true }, record, req.dryRun);
  if (req.dryRun) return envelope(`state plan ${req.spec.verb}`, { id: taskId, path: task.path, replay: false }, record, true);
  const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: TASK, id: taskId, expectedRecord: task.record!, record });
  return envelope(`state plan ${req.spec.verb}`, result, record, false);
}

function snapshot(root: string, entities: DiscoveredEntity[]): string { return createHash("sha256").update(canonicalRecordJson(entities.map(({ id, boundary, record, path: file }) => ({ id, boundary, record, path: relative(root, file) })).sort((a, b) => canonicalRecordJson(a).localeCompare(canonicalRecordJson(b))))).digest("hex"); }
function secret(root: string, authorityPath: string): Buffer { return createHash("sha256").update(path.resolve(root)).update("\0").update(fs.readFileSync(authorityPath)).digest(); }
function encode(value: JsonObject, root: string, authorityPath: string): string { const bytes = Buffer.from(canonicalRecordJson(value)); return `${bytes.toString("base64url")}.${createHmac("sha256", secret(root, authorityPath)).update(bytes).digest("base64url")}`; }
function decode(token: string, root: string, authorityPath: string): JsonObject { try { const [body, signature, extra] = token.split("."); if (!body || !signature || extra) throw new Error(); const bytes = Buffer.from(body, "base64url"); const supplied = Buffer.from(signature, "base64url"); const expected = createHmac("sha256", secret(root, authorityPath)).update(bytes).digest(); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error(); const value = JSON.parse(bytes.toString()); if (!mapping(value)) throw new Error(); return value; } catch { throw failure("cursor_invalid", "plan cursor is malformed or belongs to another project", "Copy next_cursor exactly, or omit --cursor to restart."); } }
function entry(root: string, entity: DiscoveredEntity): JsonObject { return { id: entity.id!, artifact: ARTIFACT, record: entity.record!, provenance: { storage: "canonical_entity_file", path: relative(root, entity.path) } }; }
function boundedList(root: string, sourceRoot: string, selected: DiscoveredEntity[], allEntities: DiscoveredEntity[], limit: number | undefined, cursor: string | undefined, order: string, command: string, filter: JsonObject, format = "json", envelope: JsonObject = {}): JsonObject {
  const declared = contract(sourceRoot); const take = limit ?? declared.defaultLimit; if (!Number.isSafeInteger(take) || take < 1 || take > declared.maximumLimit) throw failure("invalid_request", `plan list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.");
  const snap = snapshot(root, allEntities); let start = 0;
  if (cursor) { const value = decode(cursor, root, declared.authorityPath); if (value.snapshot_id !== snap || value.order !== order || canonicalRecordJson(value.filter) !== canonicalRecordJson(filter)) throw failure("cursor_snapshot_unavailable", "plan state changed after this cursor snapshot", "Omit --cursor to restart from current state."); const found = selected.findIndex((entity) => entity.id === value.after); if (found < 0) throw failure("cursor_snapshot_unavailable", "plan cursor continuation is unavailable", "Omit --cursor to restart."); start = found + 1; }
  let page = selected.slice(start, start + take); let trimmed = false;
  const response = (): JsonObject => { const remaining = selected.length - start - page.length; const next = remaining && page.length ? encode({ snapshot_id: snap, order, filter, after: page.at(-1)!.id! }, root, declared.authorityPath) : undefined; const filterFlags = `${command.includes("tasks") && filter.plan ? ` --plan-id ${filter.plan}` : ""}${filter.status ? ` --status ${filter.status}` : ""}`; return { schemaVersion: "agentera.stateList.v1", command, status: remaining ? "degraded" : "ok", entries: page.map((entity) => entry(root, entity)), counts: { total: selected.length, returned: page.length, remaining }, order, filters: filter, snapshot: { id: snap, first_page: !cursor, has_more: Boolean(remaining), candidate_count: selected.length }, source: { artifact: ARTIFACT, authority: "canonical_entity_files", root: declared.entityRoot }, ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: trimmed ? "serialized_byte_budget" : "page_limit", next_cursor: next, retrieval: { continue: `${command.replace("state ", "agentera state ")}${filterFlags} --limit ${take} --cursor ${next} --format json`, get: command.includes("tasks") ? "agentera state plan tasks get --id ID --format json" : "agentera state plan get --id ID --format json" } } : {}), ...envelope }; };
  let result = response(); const bytes = (): number => serializedProjectionBytes(result, format === "text" ? "yaml" : format); while (bytes() > declared.maxUtf8Bytes && page.length) { page = page.slice(0, -1); trimmed = true; result = response(); } if (!page.length && selected.length > start) throw failure("unsupported_state", `one full plan entry cannot fit the ${declared.maxUtf8Bytes}-byte list budget`, "Use exact get by ID."); return result;
}
export function getPlanEntity(root: string, id: string, sourceRoot = resolveSourceRoot()): JsonObject { const entities = all(root, sourceRoot); const plan = selectedPlan(entities, id); return { schemaVersion: "agentera.stateGet.v1", command: "state plan get", status: "ok", entry: entry(root, plan), tasks: entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === id).sort((a, b) => a.id!.localeCompare(b.id!)).map((entity) => entry(root, entity)), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entities" } }; }
export function listPlanEntities(root: string, limit?: number, cursor?: string, options: { sourceRoot?: string; format?: string; statuses?: string[] } = {}): JsonObject { const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = all(root, sourceRoot); const statuses = options.statuses?.length ? new Set(options.statuses) : undefined; const plans = entities.filter((entity) => entity.boundary === PLAN && (!statuses || statuses.has(planStatus(entity)))).sort((a, b) => String(mapping(b.record?.header) ? b.record!.header.created ?? "" : "").localeCompare(String(mapping(a.record?.header) ? a.record!.header.created ?? "" : "")) || a.id!.localeCompare(b.id!)); return boundedList(root, sourceRoot, plans, entities, limit, cursor, ORDER, "state plan list", options.statuses ? { status: options.statuses } : {}, options.format); }
export function getPlanTaskEntity(root: string, id: string, planId?: string, sourceRoot = resolveSourceRoot()): JsonObject { const entities = all(root, sourceRoot); const task = taskFor(entities, id, planId); return { schemaVersion: "agentera.stateGet.v1", command: "state plan tasks get", status: "ok", entry: entry(root, task), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entity" } }; }
export function listPlanTaskEntities(root: string, planId?: string, limit?: number, cursor?: string, options: { sourceRoot?: string; format?: string } = {}): JsonObject { const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = all(root, sourceRoot); const plan = selectedPlan(entities, planId); const tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === plan.id).sort((a, b) => a.id!.localeCompare(b.id!)); return boundedList(root, sourceRoot, tasks, entities, limit, cursor, TASK_ORDER, "state plan tasks list", { plan: plan.id! }, options.format); }

export function currentPlanEntityView(root: string, limit?: number, cursor?: string, status?: string, options: { sourceRoot?: string; format?: string } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const entities = all(root, sourceRoot);
  const plan = selectedPlan(entities);
  let tasks = entities.filter((entity) => entity.boundary === TASK && entity.record?.plan === plan.id);
  if (status) tasks = tasks.filter((entity) => entity.record?.status === status);
  tasks.sort((a, b) => a.id!.localeCompare(b.id!));
  return boundedList(root, sourceRoot, tasks, entities, limit, cursor, TASK_ORDER, "state plan", { plan: plan.id!, status: status ?? null }, options.format, { plan: entry(root, plan) });
}
