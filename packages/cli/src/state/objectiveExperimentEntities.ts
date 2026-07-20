import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { dumpYamlMapping, loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateEntityId, canonicalEntityRecordViolations, publishEntityUnderLock, replaceEntityUnderLock, validateEntityDiscovery, validateEntityState, withEntityWriterLock, type DiscoveredEntity, type EntityDiscoveryResult } from "./entityStorage.js";
import type { EntityPublicationContext, PublishedTargetIdentity } from "./entityPublicationContext.js";
import { detectStateModeBinding } from "./stateMode.js";
import { reject } from "./write/errors.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { validateArtifactBytes } from "./write/validate.js";

const OBJECTIVE_ARTIFACT = "objective";
const EXPERIMENT_ARTIFACT = "experiments";
const OBJECTIVE = "objective";
const EXPERIMENT = "experiment";
const ID = /^[a-z]{10}$/;
const ACTIVE = new Set(["open", "active"]);
const OBJECTIVE_ORDER = "created_desc_then_id_asc";
const EXPERIMENT_ORDER = "date_desc_then_id_asc";

interface Options { sourceRoot?: string; publicationContext?: EntityPublicationContext; candidate?: () => string }
interface Contract { authorityPath: string; entityRoot: string; defaultLimit: number; maximumLimit: number; maxUtf8Bytes: number }

function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function relative(root: string, file: string): string { return path.relative(path.resolve(root), file).split(path.sep).join("/"); }
function contract(boundary: string, sourceRoot = resolveSourceRoot()): Contract {
  const authorityPath = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8")); const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const definition = (Array.isArray(target.entities) ? target.entities : []).find((value) => mapping(value) && value.boundary === boundary); const retrieval = mapping(definition) && mapping(definition.retrieval) ? definition.retrieval : {};
  const positive = (value: unknown, name: string): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid ${boundary} ${name} authority`); return result; };
  if (typeof storage.canonical_root !== "string") throw new Error(`invalid entity authority '${authorityPath}'`);
  return { authorityPath, entityRoot: storage.canonical_root, defaultLimit: positive(retrieval.default_limit, "default_limit"), maximumLimit: positive(retrieval.maximum_limit, "maximum_limit"), maxUtf8Bytes: positive(retrieval.max_utf8_bytes, "max_utf8_bytes") };
}
function failure(kind: StateFailureClass, artifact: string, message: string, recovery: string, id?: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  return new StateRetrievalFailure({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: `agentera state ${artifact} get --id ID --format json`, example: `agentera state ${artifact} get --id ${id ?? "qjtrmnpvka"} --format json`, recovery, artifact, ...(id ? { id } : {}) } }, exitCode);
}
function relevant(root: string, sourceRoot: string, precomputed?: EntityDiscoveryResult): DiscoveredEntity[] {
  const discovery = precomputed
    ? validateEntityDiscovery(root, sourceRoot, precomputed)
    : validateEntityState(root, sourceRoot);
  const graphIssue = discovery.issues.find((issue) => issue.artifact === OBJECTIVE_ARTIFACT || issue.artifact === EXPERIMENT_ARTIFACT || issue.boundary === OBJECTIVE || issue.boundary === EXPERIMENT);
  if (graphIssue) throw failure(graphIssue.code === "duplicate_id" ? "ambiguous" : "corrupt", graphIssue.artifact ?? OBJECTIVE_ARTIFACT, graphIssue.message, graphIssue.recovery, graphIssue.id);
  const entities = discovery.entities.filter(({ artifact, boundary }) => artifact === OBJECTIVE_ARTIFACT || artifact === EXPERIMENT_ARTIFACT || boundary === OBJECTIVE || boundary === EXPERIMENT);
  const bad = entities.find(({ classification, id, record }) => classification !== "valid" || !id || !record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", bad.artifact ?? EXPERIMENT_ARTIFACT, `entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state and resolve the reported identity or ownership conflict.", bad.id ?? undefined);
  return entities;
}
function objectiveStatus(entity: DiscoveredEntity): string { return String(mapping(entity.record?.header) ? entity.record!.header["status"] ?? "" : ""); }
function selectObjective(entities: DiscoveredEntity[], requested?: string): DiscoveredEntity {
  if (requested !== undefined && !ID.test(requested)) throw failure("invalid_request", OBJECTIVE_ARTIFACT, `objective ID '${requested}' must be ten lowercase letters`, "Use a bare objective ID returned by objective create or list.", requested, 2);
  const objectives = entities.filter(({ boundary }) => boundary === OBJECTIVE);
  if (requested) { const matches = objectives.filter(({ id }) => id === requested); if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", OBJECTIVE_ARTIFACT, matches.length ? `objective ID '${requested}' has conflicting ownership` : `objective ID '${requested}' was not found`, "Run agentera state objective list --format json and select one canonical objective ID.", requested); return matches[0]; }
  const active = objectives.filter((entity) => ACTIVE.has(objectiveStatus(entity)));
  if (active.length === 1) return active[0];
  if (!active.length) throw failure("not_found", OBJECTIVE_ARTIFACT, "no active objective exists", "Create an objective or select one explicitly with --id.");
  throw failure("ambiguous", OBJECTIVE_ARTIFACT, `multiple active objectives require an explicit ID: ${active.map(({ id }) => id).sort().join(", ")}`, "Run agentera state objective list --format json and retry with --id ID.");
}
function experimentById(entities: DiscoveredEntity[], id: string, objective?: string): DiscoveredEntity {
  if (!ID.test(id)) throw failure("invalid_request", EXPERIMENT_ARTIFACT, `experiment ID '${id}' must be ten lowercase letters`, "Use a bare experiment ID returned by publish or list.", id, 2);
  const matches = entities.filter((entity) => entity.boundary === EXPERIMENT && entity.id === id);
  if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", EXPERIMENT_ARTIFACT, matches.length ? `experiment ID '${id}' has conflicting ownership` : `experiment ID '${id}' was not found`, "Run agentera check validate state, or list experiments and retry with one canonical ID.", id);
  if (objective && matches[0].record?.objective !== objective) throw failure("not_found", EXPERIMENT_ARTIFACT, `experiment ID '${id}' does not belong to objective '${objective}'`, "List experiments for the selected objective and retry.", id);
  return matches[0];
}
function objectiveViolations(record: JsonObject, sourceRoot?: string): string[] {
  const header = mapping(record.header) ? record.header : {}; const objective = mapping(record.objective) ? record.objective : {}; const metric = mapping(record.metric) ? record.metric : {}; const baseline = mapping(record.baseline) ? record.baseline : {}; const scope = mapping(record.scope) ? record.scope : {};
  const violations = canonicalEntityRecordViolations(OBJECTIVE, record, sourceRoot);
  if (typeof header.title !== "string" || !header.title.trim()) violations.push("header.title is required");
  if (!ACTIVE.has(String(header["status"])) && header["status"] !== "closed") violations.push("objective lifecycle must be open, active, or closed");
  for (const [name, value] of [["objective.description", objective.description], ["objective.measurement", objective.measurement], ["metric.description", metric.description], ["metric.direction", metric.direction], ["metric.unit", metric.unit], ["baseline.description", baseline.description]]) if (typeof value !== "string" || !value.trim()) violations.push(`${name} is required`);
  if (!Array.isArray(scope.included) || !scope.included.length || !Array.isArray(scope.excluded)) violations.push("scope.included and scope.excluded are required");
  if (mapping(record.header) && record.header.id !== undefined) violations.push("header.id is forbidden in a canonical objective record");
  return [...new Set(violations)];
}
function experimentViolations(record: JsonObject): string[] {
  const candidate = structuredClone(record); delete candidate.objective;
  candidate.number = 0;
  const violations = validateArtifactBytes(EXPERIMENT_ARTIFACT, dumpYamlMapping({ experiments: [candidate] }));
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.date ?? ""))) violations.push("date must be YYYY-MM-DD HH:MM");
  if (!["baseline", "kept", "discarded"].includes(String(record.status))) violations.push("status must be baseline, kept, or discarded");
  for (const field of ["id", "artifact", "number", "experiment_number", "stable_id", "objective_id"]) if (record[field] !== undefined) violations.push(`${field} is forbidden in an experiment entity record`);
  return [...new Set(violations)];
}
function assertValidState(root: string, sourceRoot: string): void { const state = validateEntityState(root, sourceRoot); if (!state.valid) reject({ class: "conflict", message: `canonical entity state is invalid: ${state.issues.map(({ message }) => message).join("; ")}`, recovery: "Run agentera check validate state and resolve every identity, relationship, or baseline conflict before retrying; no state was changed." }); }
function assertBaseline(entities: DiscoveredEntity[], objective: string, candidate?: JsonObject): void {
  const records = entities.filter((entity) => entity.boundary === EXPERIMENT && entity.record?.objective === objective).map((entity) => entity.record!); if (candidate) records.push(candidate);
  const count = records.filter((record) => record.status === "baseline").length;
  if (records.length && count !== 1) reject({ class: "conflict", message: `objective '${objective}' requires exactly one experiment with status baseline; found ${count}`, recovery: count ? "Keep one immutable baseline and resolve competing baseline ownership before retrying; no state was changed." : "Publish the baseline experiment first with status baseline; no state was changed." });
}
function envelope(command: string, entity: { id: string; path: string; replay: boolean }, artifact: string, record: JsonObject, dryRun: boolean): StateWriteEnvelope { return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: entity.path, id: entity.id, artifact, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: entity.replay }, validation: { status: "pass", violations: [] } }; }
function entityPath(root: string, sourceRoot: string, artifact: string, boundary: string, id: string): string { return path.join(root, contract(boundary, sourceRoot).entityRoot, artifact, boundary, `${id}.yaml`); }

export function mutateObjectiveEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const input = structuredClone(req.input ?? {}) as JsonObject; const violations = objectiveViolations(input, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: "objective entity input is invalid", violations });
  if (!options.publicationContext) { const binding = detectStateModeBinding(req.projectRoot, sourceRoot); if (binding.mode !== "entities") throw new Error("objective entity mutation requires the durable entity-mode marker"); try { return mutateObjectiveEntity(req, { ...options, publicationContext: binding.publicationContext }); } finally { binding.publicationContext.close(); } }
  const context = options.publicationContext;
  return withEntityWriterLock(context, () => {
    assertValidState(context.pinnedPath(), sourceRoot); const entities = relevant(context.pinnedPath(), sourceRoot);
    if (req.spec.verb === "create") {
      const id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot); if (req.dryRun) return envelope("state objective create", { id, path: entityPath(req.projectRoot, sourceRoot, OBJECTIVE_ARTIFACT, OBJECTIVE, id), replay: false }, OBJECTIVE_ARTIFACT, input, true);
      let published: { path: string; publishedIdentity?: PublishedTargetIdentity } | undefined;
      try { const result = publishEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact: OBJECTIVE_ARTIFACT, boundary: OBJECTIVE, id, record: input }); published = result; assertValidState(context.pinnedPath(), sourceRoot); context.assertValid(); return envelope("state objective create", result, OBJECTIVE_ARTIFACT, input, false); }
      catch (error) { if (published?.publishedIdentity) context.removeExact(relative(req.projectRoot, published.path), published.publishedIdentity); throw error; }
    }
    const objective = selectObjective(entities, String(req.values.id ?? ""));
    if (canonicalRecordJson(input) === canonicalRecordJson(objective.record)) return envelope("state objective update", { id: objective.id!, path: objective.path, replay: true }, OBJECTIVE_ARTIFACT, input, req.dryRun);
    if (req.dryRun) return envelope("state objective update", { id: objective.id!, path: objective.path, replay: false }, OBJECTIVE_ARTIFACT, input, true);
    const request = { projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact: OBJECTIVE_ARTIFACT, boundary: OBJECTIVE, id: objective.id!, expectedRecord: objective.record!, record: input };
    let replaced = false;
    try { const result = replaceEntityUnderLock(request); replaced = !result.replay; assertValidState(context.pinnedPath(), sourceRoot); context.assertValid(); return envelope("state objective update", result, OBJECTIVE_ARTIFACT, input, false); }
    catch (error) { if (replaced) replaceEntityUnderLock({ ...request, expectedRecord: input, record: objective.record! }); throw error; }
  });
}

export function publishExperimentEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const raw = structuredClone(req.input ?? {}) as JsonObject; const inputViolations = experimentViolations({ ...raw, objective: "qjtrmnpvka" }); if (inputViolations.length) reject({ class: "schema_violation", message: "experiment entity input is invalid", violations: inputViolations });
  if (!options.publicationContext) { const binding = detectStateModeBinding(req.projectRoot, sourceRoot); if (binding.mode !== "entities") throw new Error("experiment entity publication requires the durable entity-mode marker"); try { return publishExperimentEntity(req, { ...options, publicationContext: binding.publicationContext }); } finally { binding.publicationContext.close(); } }
  const context = options.publicationContext;
  return withEntityWriterLock(context, () => {
    assertValidState(context.pinnedPath(), sourceRoot); const entities = relevant(context.pinnedPath(), sourceRoot); const objective = selectObjective(entities, String(req.values.objective ?? ""));
    const record = { ...raw, objective: objective.id! }; const requested = req.values.id === undefined ? undefined : String(req.values.id); if (requested) { const existing = experimentById(entities, requested, objective.id!); if (canonicalRecordJson(existing.record) !== canonicalRecordJson(record)) reject({ class: "conflict", message: `divergent content for immutable experiment ID '${requested}'; no state was changed` }); return envelope("state experiments publish", { id: requested, path: existing.path, replay: true }, EXPERIMENT_ARTIFACT, record, req.dryRun); }
    assertBaseline(entities, objective.id!, record); const id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot); if (req.dryRun) return envelope("state experiments publish", { id, path: entityPath(req.projectRoot, sourceRoot, EXPERIMENT_ARTIFACT, EXPERIMENT, id), replay: false }, EXPERIMENT_ARTIFACT, record, true);
    let published: { path: string; publishedIdentity?: PublishedTargetIdentity } | undefined;
    try { const result = publishEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact: EXPERIMENT_ARTIFACT, boundary: EXPERIMENT, id, record }); published = result; assertValidState(context.pinnedPath(), sourceRoot); assertBaseline(relevant(context.pinnedPath(), sourceRoot), objective.id!); context.assertValid(); return envelope("state experiments publish", result, EXPERIMENT_ARTIFACT, record, false); }
    catch (error) { if (published?.publishedIdentity) context.removeExact(relative(req.projectRoot, published.path), published.publishedIdentity); throw error; }
  });
}

function entry(root: string, entity: DiscoveredEntity): JsonObject { return { id: entity.id!, artifact: entity.artifact!, record: entity.record!, provenance: { storage: "canonical_entity_file", path: relative(root, entity.path), immutable: entity.boundary === EXPERIMENT } }; }
function snapshot(root: string, entities: DiscoveredEntity[]): string { return createHash("sha256").update(canonicalRecordJson(entities.map((entity) => ({ id: entity.id, boundary: entity.boundary, path: relative(root, entity.path), record: entity.record })).sort((a, b) => canonicalRecordJson(a).localeCompare(canonicalRecordJson(b))))).digest("hex"); }
function secret(root: string, authorityPath: string): Buffer { return createHash("sha256").update(path.resolve(root)).update("\0").update(fs.readFileSync(authorityPath)).digest(); }
function encode(value: JsonObject, root: string, authorityPath: string): string { const bytes = Buffer.from(canonicalRecordJson(value)); return `${bytes.toString("base64url")}.${createHmac("sha256", secret(root, authorityPath)).update(bytes).digest("base64url")}`; }
function decode(token: string, root: string, authorityPath: string, artifact: string): JsonObject { try { const [body, signature, extra] = token.split("."); if (!body || !signature || extra) throw new Error(); const bytes = Buffer.from(body, "base64url"); const supplied = Buffer.from(signature, "base64url"); const expected = createHmac("sha256", secret(root, authorityPath)).update(bytes).digest(); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error(); const value = JSON.parse(bytes.toString()); if (!mapping(value)) throw new Error(); return value; } catch { throw failure("cursor_invalid", artifact, `${artifact} cursor is malformed or belongs to another project`, "Copy next_cursor exactly, or omit --cursor to restart."); } }
function boundedList(root: string, sourceRoot: string, artifact: string, boundary: string, selected: DiscoveredEntity[], all: DiscoveredEntity[], limit: number | undefined, cursor: string | undefined, order: string, filter: JsonObject, format = "json"): JsonObject {
  const declared = contract(boundary, sourceRoot); const take = limit ?? declared.defaultLimit; if (!Number.isSafeInteger(take) || take < 1 || take > declared.maximumLimit) throw failure("invalid_request", artifact, `${artifact} list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.", undefined, 2);
  const snap = snapshot(root, all); let start = 0; if (cursor) { const value = decode(cursor, root, declared.authorityPath, artifact); if (value.snapshot_id !== snap || value.order !== order || canonicalRecordJson(value.filter) !== canonicalRecordJson(filter)) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} state changed after this cursor snapshot`, "Omit --cursor to restart from current state."); const found = selected.findIndex(({ id }) => id === value.after); if (found < 0) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} cursor continuation is unavailable`, "Omit --cursor to restart."); start = found + 1; }
  let page = selected.slice(start, start + take); let trimmed = false;
  const response = (): JsonObject => { const remaining = selected.length - start - page.length; const next = remaining && page.length ? encode({ snapshot_id: snap, order, filter, after: page.at(-1)!.id! }, root, declared.authorityPath) : undefined; const listCommand = `state ${artifact} list`; const filterFlags = `${filter.objective ? ` --objective ${filter.objective}` : ""}${filter.topic ? ` --topic ${filter.topic}` : ""}${filter.status ? ` --status ${filter.status}` : ""}`; return { schemaVersion: "agentera.stateList.v1", command: listCommand, status: remaining ? "degraded" : "ok", entries: page.map((entity) => entry(root, entity)), counts: { total: selected.length, returned: page.length, remaining }, order, filters: filter, snapshot: { id: snap, first_page: !cursor, has_more: Boolean(remaining), candidate_count: selected.length }, source: { artifact, authority: "canonical_entity_files", root: declared.entityRoot }, source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full", cursor: "opaque_snapshot_cursor" }, retrieval: { get: `agentera state ${artifact} get --id ID --format json`, ...(next ? { continue: `agentera ${listCommand}${filterFlags} --limit ${take} --cursor ${next} --format json` } : {}) }, ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: trimmed ? "serialized_byte_budget" : "page_limit", next_cursor: next } : {}) }; };
  let result = response(); const bytes = () => Buffer.byteLength(format === "json" ? `${JSON.stringify(result, null, 2)}\n` : YAML.stringify(result)); while (bytes() > declared.maxUtf8Bytes && page.length) { page = page.slice(0, -1); trimmed = true; result = response(); } if (!page.length && selected.length > start) throw failure("unsupported_state", artifact, `one full ${artifact} entity cannot fit the ${declared.maxUtf8Bytes}-byte list budget`, "Use exact get by ID."); return result;
}

export function getObjectiveEntity(root: string, id: string, sourceRoot = resolveSourceRoot()): JsonObject { const entity = selectObjective(relevant(root, sourceRoot), id); return { schemaVersion: "agentera.stateGet.v1", command: "state objective get", status: "ok", entry: entry(root, entity), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entity" } }; }
export function listObjectiveEntities(root: string, limit?: number, cursor?: string, options: { sourceRoot?: string; format?: string; statuses?: string[]; discovery?: EntityDiscoveryResult } = {}): JsonObject { const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = relevant(root, sourceRoot, options.discovery); const statuses = options.statuses?.length ? new Set(options.statuses) : undefined; const selected = entities.filter((entity) => entity.boundary === OBJECTIVE && (!statuses || statuses.has(objectiveStatus(entity)))).sort((a, b) => String(mapping(b.record?.header) ? b.record!.header.created ?? "" : "").localeCompare(String(mapping(a.record?.header) ? a.record!.header.created ?? "" : "")) || a.id!.localeCompare(b.id!)); return boundedList(root, sourceRoot, OBJECTIVE_ARTIFACT, OBJECTIVE, selected, entities, limit, cursor, OBJECTIVE_ORDER, options.statuses ? { status: options.statuses } : {}, options.format); }
export function currentObjectiveEntity(root: string, sourceRoot = resolveSourceRoot()): JsonObject { const entity = selectObjective(relevant(root, sourceRoot)); return { schemaVersion: "agentera.stateList.v1", command: "state objective", status: "ok", entries: [entry(root, entity)], counts: { total: 1, returned: 1, remaining: 0 }, filters: { status: "active" }, source: { artifact: OBJECTIVE_ARTIFACT, authority: "canonical_entity_files" } }; }
export function getExperimentEntity(root: string, id: string, objective?: string, sourceRoot = resolveSourceRoot()): JsonObject { const entities = relevant(root, sourceRoot); if (objective) selectObjective(entities, objective); const entity = experimentById(entities, id, objective); return { schemaVersion: "agentera.stateGet.v1", command: "state experiments get", status: "ok", entry: entry(root, entity), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_immutable_entity" } }; }
export function listExperimentEntities(root: string, objective: string, limit?: number, cursor?: string, options: { sourceRoot?: string; format?: string; discovery?: EntityDiscoveryResult } = {}): JsonObject { const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const entities = relevant(root, sourceRoot, options.discovery); const owner = selectObjective(entities, objective); assertBaseline(entities, owner.id!); const selected = entities.filter((entity) => entity.boundary === EXPERIMENT && entity.record?.objective === owner.id).sort((a, b) => String(b.record!.date).localeCompare(String(a.record!.date)) || a.id!.localeCompare(b.id!)); return boundedList(root, sourceRoot, EXPERIMENT_ARTIFACT, EXPERIMENT, selected, entities, limit, cursor, EXPERIMENT_ORDER, { objective: owner.id! }, options.format); }

export function listCurrentExperimentEntities(root: string, objective: string | undefined, limit?: number, cursor?: string, filters: { topic?: string; status?: string } = {}, options: { sourceRoot?: string; format?: string } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const entities = relevant(root, sourceRoot);
  let owner: DiscoveredEntity;
  try { owner = selectObjective(entities, objective); }
  catch (error) {
    if (error instanceof StateRetrievalFailure && !objective) {
      error.body.error.syntax = "agentera state experiments --objective ID [--limit N] [--cursor TOKEN] --format json";
      error.body.error.example = "agentera state experiments --objective qjtrmnpvka --format json";
      error.body.error.recovery = "Pass --objective with one bare objective ID returned by state objective list; no state was changed.";
    }
    throw error;
  }
  assertBaseline(entities, owner.id!);
  let selected = entities.filter((entity) => entity.boundary === EXPERIMENT && entity.record?.objective === owner.id);
  if (filters.status) selected = selected.filter((entity) => entity.record?.status === filters.status);
  if (filters.topic) { const needle = filters.topic.toLowerCase(); selected = selected.filter((entity) => canonicalRecordJson(entity.record).toLowerCase().includes(needle)); }
  selected.sort((a, b) => String(b.record!.date).localeCompare(String(a.record!.date)) || a.id!.localeCompare(b.id!));
  const result = boundedList(root, sourceRoot, EXPERIMENT_ARTIFACT, EXPERIMENT, selected, entities, limit, cursor, EXPERIMENT_ORDER, { objective: owner.id!, topic: filters.topic ?? null, status: filters.status ?? null }, options.format);
  result.command = "state experiments";
  if (mapping(result.retrieval) && typeof result.retrieval.continue === "string") result.retrieval.continue = result.retrieval.continue.replace("state experiments list", "state experiments");
  return result;
}
