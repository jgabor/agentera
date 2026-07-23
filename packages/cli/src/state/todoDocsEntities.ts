import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import {
  allocateEntityId,
  assertEntityDiscoveryOrigin,
  canonicalEntityRecordViolations,
  discoverEntities,
  publishEntityUnderLock,
  replaceEntityUnderLock,
  validateEntityState,
  withEntityWriterLock,
  type DiscoveredEntity,
  type EntityDiscoveryResult,
} from "./entityStorage.js";
import type { EntityPublicationContext, PublishedTargetIdentity } from "./entityPublicationContext.js";
import { detectStateModeBinding } from "./stateMode.js";
import { reject } from "./write/errors.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { loadYamlMapping } from "../core/yaml.js";
import { TODO_SEVERITIES, TODO_STATUSES, todoDocsRecordViolations } from "./todoDocsEntityValidation.js";

const ID = /^[a-z]{10}$/;
const TODO = { artifact: "todo", boundary: "todo_item", order: "severity_then_status_then_id" } as const;
const DOCS = { artifact: "docs", boundary: "documentation_inventory_entry", order: "path_then_id" } as const;

interface Options { sourceRoot?: string; publicationContext?: EntityPublicationContext; candidate?: () => string }
interface Contract { authorityPath: string; entityRoot: string; defaultLimit: number; maximumLimit: number; maxUtf8Bytes: number }

function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function relative(root: string, file: string): string { return path.relative(path.resolve(root), file).split(path.sep).join("/"); }
function shell(value: unknown): string { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function definition(artifact: "todo" | "docs") { return artifact === "todo" ? TODO : DOCS; }

function contract(boundary: string, sourceRoot = resolveSourceRoot()): Contract {
  const authorityPath = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const entity = (Array.isArray(target.entities) ? target.entities : []).find((value) => mapping(value) && value.boundary === boundary);
  const retrieval = mapping(entity) && mapping(entity.retrieval) ? entity.retrieval : {};
  const positive = (value: unknown, name: string): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid ${boundary} ${name} authority`); return result; };
  if (typeof storage.canonical_root !== "string") throw new Error(`invalid entity authority '${authorityPath}'`);
  return { authorityPath, entityRoot: storage.canonical_root, defaultLimit: positive(retrieval.default_limit, "default_limit"), maximumLimit: positive(retrieval.maximum_limit, "maximum_limit"), maxUtf8Bytes: positive(retrieval.max_utf8_bytes, "max_utf8_bytes") };
}

function failure(kind: StateFailureClass, artifact: string, message: string, recovery: string, id?: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  return new StateRetrievalFailure({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: `agentera state ${artifact} get --id ID --format json`, example: `agentera state ${artifact} get --id ${id ?? "qjtrmnpvka"} --format json`, recovery, artifact, ...(id ? { id } : {}) } }, exitCode);
}

function relevant(root: string, sourceRoot: string, artifact?: "todo" | "docs", supplied?: EntityDiscoveryResult): DiscoveredEntity[] {
  if (supplied) assertEntityDiscoveryOrigin(root, sourceRoot, supplied);
  const discovery = supplied ?? discoverEntities(root, sourceRoot);
  const selected = discovery.entities.filter((entity) => [TODO.boundary, DOCS.boundary].includes(entity.boundary as typeof TODO.boundary) || [TODO.artifact, DOCS.artifact].includes(entity.artifact as typeof TODO.artifact));
  const bad = selected.find(({ classification, id, record }) => classification !== "valid" || !id || !record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", artifact ?? bad.artifact ?? "todo", `entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state and resolve every invalid identity or record before retrying.", bad.id ?? undefined);
  return selected;
}

function selectedById(entities: DiscoveredEntity[], artifact: "todo" | "docs", id: string): DiscoveredEntity {
  if (!ID.test(id)) throw failure("invalid_request", artifact, `${artifact} ID '${id}' must be ten lowercase letters`, `Use a bare ${artifact} ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid.`, id, 2);
  const boundary = definition(artifact).boundary;
  const matches = entities.filter((entity) => entity.boundary === boundary && entity.id === id);
  if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", artifact, matches.length ? `${artifact} ID '${id}' has conflicting ownership` : `${artifact} ID '${id}' was not found`, `Run agentera state ${artifact} list --format json and select one canonical ID.`, id);
  return matches[0];
}

function recordViolations(artifact: "todo" | "docs", record: JsonObject, sourceRoot: string): string[] {
  const boundary = definition(artifact).boundary;
  const violations = [...canonicalEntityRecordViolations(boundary, record, sourceRoot), ...todoDocsRecordViolations(boundary, record)];
  return [...new Set(violations)];
}

function assertState(root: string, sourceRoot: string): void {
  const state = validateEntityState(root, sourceRoot);
  if (!state.valid) reject({ class: "conflict", message: `canonical entity state is invalid: ${state.issues.map(({ message }) => message).join("; ")}`, recovery: "Run agentera check validate state and resolve every identity or record conflict before retrying; no state was changed." });
}

function envelope(command: string, entity: { id: string; path: string; replay: boolean }, artifact: "todo" | "docs", record: JsonObject, dryRun: boolean): StateWriteEnvelope {
  return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: entity.path, id: entity.id, artifact, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: entity.replay }, validation: { status: "pass", violations: [] } };
}

function targetPath(root: string, sourceRoot: string, artifact: "todo" | "docs", id: string): string {
  const model = definition(artifact); return path.join(root, contract(model.boundary, sourceRoot).entityRoot, artifact, model.boundary, `${id}.yaml`);
}

function mutationRecord(req: StateWriteRequest, current?: JsonObject): JsonObject {
  if (req.artifact === "docs") return structuredClone(req.input ?? {}) as JsonObject;
  const record = structuredClone(current ?? { severity: req.values.severity, status: "open", description: req.values.description }) as JsonObject;
  if (req.values.severity !== undefined) record.severity = req.values.severity as string;
  if (req.values.description !== undefined) record.description = req.values.description as string;
  if (req.spec.verb === "resolve") record.status = "resolved";
  return record;
}

export function mutateTodoDocsEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const artifact = req.artifact as "todo" | "docs";
  if (artifact !== "todo" && artifact !== "docs") throw new Error("TODO/docs entity mutation received an unsupported artifact");
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  if (!options.publicationContext) {
    const binding = detectStateModeBinding(req.projectRoot, sourceRoot);
    if (binding.mode !== "entities") reject({ class: "unsupported_target", message: `${artifact} entity mutations require the durable entity-mode marker; legacy aggregate behavior is unchanged` });
    try { return mutateTodoDocsEntity(req, { ...options, publicationContext: binding.publicationContext }); } finally { binding.publicationContext.close(); }
  }
  const context = options.publicationContext;
  return withEntityWriterLock(context, () => {
    context.assertValid();
    assertState(context.projectRoot, sourceRoot);
    context.assertValid();
    const entities = relevant(context.projectRoot, sourceRoot, artifact);
    context.assertValid();
    if (req.spec.verb === "create") {
      const record = mutationRecord(req); const violations = recordViolations(artifact, record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: `${artifact} entity input is invalid`, violations });
      const id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot); if (req.dryRun) return envelope(`state ${artifact} create`, { id, path: targetPath(req.projectRoot, sourceRoot, artifact, id), replay: false }, artifact, record, true);
      let published: { path: string; publishedIdentity?: PublishedTargetIdentity } | undefined;
      try { const result = publishEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact, boundary: definition(artifact).boundary, id, record }); published = result; assertState(context.projectRoot, sourceRoot); context.assertValid(); return envelope(`state ${artifact} create`, result, artifact, record, false); }
      catch (error) { if (published?.publishedIdentity) context.removeExact(relative(req.projectRoot, published.path), published.publishedIdentity); throw error; }
    }
    const id = String(req.values.id ?? "");
    if (!ID.test(id)) reject({ class: "invalid_request", message: `${artifact} ID '${id}' must be ten lowercase letters`, recovery: `Use a bare ${artifact} ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid.` });
    const entity = selectedById(entities, artifact, id); const record = mutationRecord(req, entity.record!); const violations = recordViolations(artifact, record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: `${artifact} entity input is invalid`, violations });
    if (canonicalRecordJson(record) === canonicalRecordJson(entity.record)) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: true }, artifact, record, req.dryRun);
    if (req.dryRun) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: false }, artifact, record, true);
    const request = { projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact, boundary: definition(artifact).boundary, id, expectedRecord: entity.record!, record };
    let replaced = false;
    try { const result = replaceEntityUnderLock(request); replaced = !result.replay; assertState(context.projectRoot, sourceRoot); context.assertValid(); return envelope(`state ${artifact} ${req.spec.verb}`, result, artifact, record, false); }
    catch (error) { if (replaced) replaceEntityUnderLock({ ...request, expectedRecord: record, record: entity.record! }); throw error; }
  });
}

function entry(root: string, entity: DiscoveredEntity): JsonObject { return { id: entity.id!, artifact: entity.artifact!, record: entity.record!, provenance: { storage: "canonical_entity_file", path: relative(root, entity.path), immutable: false } }; }
function snapshot(root: string, entities: DiscoveredEntity[]): string { return createHash("sha256").update(canonicalRecordJson(entities.map((entity) => ({ id: entity.id, boundary: entity.boundary, path: relative(root, entity.path), record: entity.record })).sort((a, b) => canonicalRecordJson(a).localeCompare(canonicalRecordJson(b))))).digest("hex"); }
function secret(root: string, authorityPath: string): Buffer { return createHash("sha256").update(path.resolve(root)).update("\0").update(fs.readFileSync(authorityPath)).digest(); }
function encode(value: JsonObject, root: string, authorityPath: string): string { const bytes = Buffer.from(canonicalRecordJson(value)); return `${bytes.toString("base64url")}.${createHmac("sha256", secret(root, authorityPath)).update(bytes).digest("base64url")}`; }
function decode(token: string, root: string, authorityPath: string, artifact: string): JsonObject { try { const [body, signature, extra] = token.split("."); if (!body || !signature || extra) throw new Error(); const bytes = Buffer.from(body, "base64url"); const supplied = Buffer.from(signature, "base64url"); const expected = createHmac("sha256", secret(root, authorityPath)).update(bytes).digest(); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error(); const value = JSON.parse(bytes.toString()); if (!mapping(value)) throw new Error(); return value; } catch { throw failure("cursor_invalid", artifact, `${artifact} cursor is malformed or belongs to another project`, "Copy next_cursor exactly, or omit --cursor to restart."); } }

function sorted(artifact: "todo" | "docs", entities: DiscoveredEntity[]): DiscoveredEntity[] {
  const selected = entities.filter(({ boundary }) => boundary === definition(artifact).boundary);
  if (artifact === "docs") return selected.sort((a, b) => String(a.record!.path).localeCompare(String(b.record!.path)) || a.id!.localeCompare(b.id!));
  return selected.sort((a, b) => TODO_SEVERITIES.indexOf(a.record!.severity as typeof TODO_SEVERITIES[number]) - TODO_SEVERITIES.indexOf(b.record!.severity as typeof TODO_SEVERITIES[number]) || TODO_STATUSES.indexOf(a.record!.status as typeof TODO_STATUSES[number]) - TODO_STATUSES.indexOf(b.record!.status as typeof TODO_STATUSES[number]) || a.id!.localeCompare(b.id!));
}

export function getTodoDocsEntity(root: string, artifact: "todo" | "docs", id: string, sourceRoot = resolveSourceRoot()): JsonObject {
  const entity = selectedById(relevant(root, sourceRoot, artifact), artifact, id); return { schemaVersion: "agentera.stateGet.v1", command: `state ${artifact} get`, status: "ok", entry: entry(root, entity), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entity" } };
}

export function listTodoDocsEntities(root: string, artifact: "todo" | "docs", limit?: number, cursor?: string, filters: JsonObject = {}, options: { sourceRoot?: string; format?: string; reservedUtf8Bytes?: number; discovery?: EntityDiscoveryResult } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const declared = contract(definition(artifact).boundary, sourceRoot); const take = limit ?? declared.defaultLimit;
  if (!Number.isSafeInteger(take) || take < 1 || take > declared.maximumLimit) throw failure("invalid_request", artifact, `${artifact} list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.", undefined, 2);
  const all = relevant(root, sourceRoot, artifact, options.discovery).filter(({ boundary }) => boundary === definition(artifact).boundary); let selected = sorted(artifact, all);
  if (artifact === "todo") selected = selected.filter((entity) => (!filters.severity || entity.record!.severity === filters.severity) && (!filters.status || entity.record!.status === filters.status));
  if (artifact === "docs") selected = selected.filter((entity) => (!filters.status || entity.record!.status === filters.status) && (!filters.topic || [entity.record!.document, entity.record!.path, entity.record!.status].some((value) => String(value).toLowerCase().includes(String(filters.topic).toLowerCase()))));
  const snap = snapshot(root, all); let start = 0;
  if (cursor) { const value = decode(cursor, root, declared.authorityPath, artifact); if (value.snapshot_id !== snap || value.order !== definition(artifact).order || canonicalRecordJson(value.filters) !== canonicalRecordJson(filters)) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} state changed after this cursor snapshot`, "Omit --cursor to restart from current state."); const found = selected.findIndex(({ id }) => id === value.after); if (found < 0) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} cursor continuation is unavailable`, "Omit --cursor to restart."); start = found + 1; }
  let page = selected.slice(start, start + take); let trimmed = false;
  const response = (): JsonObject => { const remaining = selected.length - start - page.length; const next = remaining && page.length ? encode({ snapshot_id: snap, order: definition(artifact).order, filters, after: page.at(-1)!.id! }, root, declared.authorityPath) : undefined; const filterFlags = Object.entries(filters).map(([name, value]) => ` --${name} ${shell(value)}`).join(""); return { schemaVersion: "agentera.stateList.v1", command: `state ${artifact} list`, status: remaining ? "degraded" : "ok", entries: page.map((entity) => entry(root, entity)), counts: { total: selected.length, returned: page.length, remaining }, order: definition(artifact).order, filters, snapshot: { id: snap, first_page: !cursor, has_more: Boolean(remaining), candidate_count: selected.length }, source: { artifact, authority: "canonical_entity_files", root: declared.entityRoot }, source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full", cursor: "opaque_snapshot_cursor" }, retrieval: { get: `agentera state ${artifact} get --id ID --format json`, ...(next ? { continue: `agentera state ${artifact} list${filterFlags} --limit ${take} --cursor ${next} --format json` } : {}) }, ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: trimmed ? "serialized_byte_budget" : "page_limit", next_cursor: next } : {}) }; };
  const outputBudget = declared.maxUtf8Bytes - (options.reservedUtf8Bytes ?? 0); if (outputBudget < 1024) throw failure("unsupported_state", artifact, `${artifact} singleton metadata leaves no room for a bounded entity view`, "Reduce the authority-owned singleton metadata within its declared artifact budget.");
  let result = response(); const bytes = () => Buffer.byteLength(options.format === "yaml" ? YAML.stringify(result) : `${JSON.stringify(result, null, 2)}\n`); while (bytes() > outputBudget && page.length) { page = page.slice(0, -1); trimmed = true; result = response(); } if (!page.length && selected.length > start) throw failure("unsupported_state", artifact, `one full ${artifact} entity cannot fit the ${declared.maxUtf8Bytes}-byte list budget`, "Use exact get by ID."); return result;
}
