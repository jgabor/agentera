import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson, decisionOverlayContract } from "./archiveDiscovery.js";
import { requestedSatisfaction, validateTransition } from "./decisionOverlay.js";
import { decisionRevisionContract } from "./decisionRevision.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateAndPublishEntity, allocateEntityId, discoverEntities, publishEntity, replaceEntity, type DiscoveredEntity } from "./entityStorage.js";
import type { EntityPublicationContext } from "./entityPublicationContext.js";
import { localDate } from "./write/assign.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";

const ARTIFACT = "decisions";
const BASE = "decision";
const SATISFACTION = "decision_satisfaction";
const REVISION = "decision_revision";
const ORDER = "date_desc_then_id_asc";
const ID_PATTERN = /^[a-z]{10}$/;

interface Options { sourceRoot?: string; id?: string; candidate?: () => string; publicationContext?: EntityPublicationContext }
interface Contract { authorityPath: string; entityRoot: string; defaultLimit: number; maximumLimit: number; maxUtf8Bytes: number }

function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`decision entity requires ${field}`);
  return value;
}
function contract(sourceRoot = resolveSourceRoot()): Contract {
  const authorityPath = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const entities = Array.isArray(target.entities) ? target.entities : [];
  const base = entities.find((value) => mapping(value) && value.boundary === BASE);
  const retrieval = mapping(base) && mapping(base.retrieval) ? base.retrieval : {};
  const number = (value: unknown, field: string): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid decisions entity ${field} authority`);
    return result;
  };
  return { authorityPath, entityRoot: requiredText(storage.canonical_root, "canonical_root"), defaultLimit: number(retrieval.default_limit, "default_limit"), maximumLimit: number(retrieval.maximum_limit, "maximum_limit"), maxUtf8Bytes: number(retrieval.max_utf8_bytes, "max_utf8_bytes") };
}
function failure(kind: StateFailureClass, message: string, recovery: string, id?: string): StateRetrievalFailure {
  return new StateRetrievalFailure({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: "agentera state decisions get --id ID --format json", example: `agentera state decisions get --id ${id ?? "qjtrmnpvka"} --format json`, recovery, artifact: ARTIFACT, ...(id ? { id } : {}) } }, kind === "invalid_request" ? 2 : 1);
}
function relative(root: string, file: string): string { return path.relative(path.resolve(root), file).split(path.sep).join("/"); }
function entityRecord(values: Record<string, unknown>): JsonObject {
  const alternatives = mapping(values.alternatives) ? values.alternatives : {};
  const chosen = requiredText(alternatives.chosen, "alternatives.chosen");
  const rejected = Array.isArray(alternatives.rejected) ? alternatives.rejected.map(String) : [];
  const record: JsonObject = {
    date: typeof values.date === "string" ? values.date : localDate(),
    question: requiredText(values.question, "question"),
    context: requiredText(values.context, "context"),
    alternatives: [{ name: chosen, status: "chosen" }, ...rejected.map((name) => ({ name, status: "rejected" }))],
    choice: requiredText(values.choice, "choice"), reasoning: requiredText(values.reasoning, "reasoning"), confidence: requiredText(values.confidence, "confidence"),
  };
  if (typeof values.feeds_into === "string") record.feeds_into = values.feeds_into;
  return record;
}
function envelope(command: string, published: { path: string; id: string; artifact: string; replay: boolean }, record: JsonObject, dryRun = false): StateWriteEnvelope {
  return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: published.path, id: published.id, artifact: published.artifact, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: published.replay }, validation: { status: "pass", violations: [] } };
}
function publish(req: StateWriteRequest, boundary: string, record: JsonObject, options: Options): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  if (req.dryRun) {
    const id = options.id ?? allocateEntityId(options.publicationContext?.pinnedPath() ?? req.projectRoot, options.candidate, sourceRoot);
    return envelope(`state decisions ${req.spec.verb}`, { id, artifact: ARTIFACT, path: path.join(req.projectRoot, contract(sourceRoot).entityRoot, ARTIFACT, boundary, `${id}.yaml`), replay: false }, record, true);
  }
  const result = options.id
    ? publishEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary, id: options.id, record })
    : allocateAndPublishEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary, record }, options.candidate);
  return envelope(`state decisions ${req.spec.verb}`, result, record);
}
export function appendDecisionEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope { return publish(req, BASE, entityRecord(req.values), options); }

function decisionEntities(root: string, sourceRoot: string): DiscoveredEntity[] {
  const relevant = discoverEntities(root, sourceRoot).entities.filter((entity) => entity.artifact === ARTIFACT || [BASE, SATISFACTION, REVISION].includes(entity.boundary ?? ""));
  const bad = relevant.find((entity) => entity.classification !== "valid" || !entity.id || !entity.record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", `decision entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state, preserve conflicting values, and repair the entity files.", bad.id ?? undefined);
  return relevant;
}
function baseFor(root: string, id: string, sourceRoot: string): { base: DiscoveredEntity; all: DiscoveredEntity[] } {
  if (!ID_PATTERN.test(id)) throw failure("invalid_request", `decision ID '${id}' must be ten lowercase letters`, "Use an ID returned by decisions append or list.", id);
  const all = decisionEntities(root, sourceRoot);
  const matches = all.filter((entity) => entity.id === id && entity.boundary === BASE);
  if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", matches.length ? `decision ID '${id}' has multiple base entities` : `decision ID '${id}' was not found`, "Run agentera check validate state and resolve duplicate ownership, or use an ID returned by list.", id);
  return { base: matches[0], all };
}
function applyChanges(record: JsonObject, changes: JsonObject): JsonObject {
  const result = structuredClone(record);
  for (const [field, value] of Object.entries(changes)) {
    if (field === "alternatives.chosen" || field === "alternatives.rejected") {
      const alternatives = Array.isArray(result.alternatives) ? structuredClone(result.alternatives).filter(mapping) : [];
      if (field.endsWith("chosen")) {
        const chosen = alternatives.find((entry) => entry.status === "chosen");
        if (chosen) chosen.name = structuredClone(value) as never;
        else alternatives.unshift({ name: structuredClone(value) as never, status: "chosen" });
      } else {
        const names = Array.isArray(value) ? value.map(String) : [String(value)];
        for (const name of names) if (!alternatives.some((entry) => entry.status === "rejected" && entry.name === name)) alternatives.push({ name, status: "rejected" });
      }
      result.alternatives = alternatives;
    } else result[field] = structuredClone(value) as never;
  }
  return result;
}
function compose(root: string, base: DiscoveredEntity, all: DiscoveredEntity[]): JsonObject {
  let effective = structuredClone(base.record!);
  let hash = createHash("sha256").update(canonicalRecordJson(effective)).digest("hex");
  const revisions: JsonObject[] = [];
  const candidates = all.filter((entity) => entity.boundary === REVISION && entity.record?.decision === base.id);
  const unused = new Set(candidates);
  while (true) {
    const next = [...unused].filter((entity) => entity.record?.base_sha256 === hash);
    if (next.length > 1) throw failure("ambiguous", `decision '${base.id}' has competing revisions for base ${hash}`, "Preserve both revision entities and resolve their ownership explicitly.", base.id!);
    if (next.length === 0) break;
    const revision = next[0]; unused.delete(revision);
    if (!mapping(revision.record!.changes)) throw failure("corrupt", `decision revision '${revision.id}' has invalid changes`, "Repair the canonical revision entity.", base.id!);
    effective = applyChanges(effective, revision.record!.changes as JsonObject);
    hash = createHash("sha256").update(canonicalRecordJson(effective)).digest("hex");
    revisions.push({ id: revision.id!, base_sha256: revision.record!.base_sha256 as string, effective_sha256: hash, fields: Object.keys(revision.record!.changes as JsonObject), path: relative(root, revision.path) });
  }
  if (unused.size) throw failure("ambiguous", `decision '${base.id}' has stale or disconnected revision ownership`, "Preserve every revision and repair the revision chain explicitly.", base.id!);
  const satisfactions = all.filter((entity) => entity.boundary === SATISFACTION && entity.record?.decision === base.id);
  if (satisfactions.length > 1) throw failure("ambiguous", `decision '${base.id}' has competing satisfaction owners`, "Preserve both satisfaction entities and resolve ownership explicitly.", base.id!);
  let satisfactionProvenance: JsonObject | null = null;
  if (satisfactions[0]) {
    const { decision: _decision, ...satisfaction } = satisfactions[0].record!;
    effective.satisfaction = satisfaction;
    satisfactionProvenance = { id: satisfactions[0].id!, path: relative(root, satisfactions[0].path) };
  }
  return { id: base.id!, artifact: ARTIFACT, record: effective, effective_sha256: hash, provenance: { base: { id: base.id!, path: relative(root, base.path) }, revisions, satisfaction: satisfactionProvenance }, retrieval: { get: `agentera state decisions get --id ${base.id} --format json` } };
}
export function getDecisionEntity(root: string, id: string, sourceRoot = resolveSourceRoot()): JsonObject {
  const { base, all } = baseFor(root, id, sourceRoot);
  return { schemaVersion: "agentera.stateRetrieval.v1", command: "state decisions get", status: "ok", entry: compose(root, base, all), source: { artifact: ARTIFACT, authority: "canonical_entity_files" } };
}

export function updateDecisionSatisfactionEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const id = requiredText(req.values.id, "id");
  const { all } = baseFor(req.projectRoot, id, sourceRoot);
  const owners = all.filter((entity) => entity.boundary === SATISFACTION && entity.record?.decision === id);
  if (owners.length > 1) throw failure("ambiguous", `decision '${id}' has competing satisfaction owners`, "Preserve both entities and resolve ownership explicitly.", id);
  const requested = requestedSatisfaction(mapping(req.values.satisfaction) ? req.values.satisfaction : {}, decisionOverlayContract(sourceRoot));
  const current = owners[0];
  const historical = current ? { ...current.record } : undefined;
  if (mapping(historical)) delete historical.decision;
  validateTransition(requested, historical ? { satisfaction: historical } : undefined, undefined, decisionOverlayContract(sourceRoot));
  const record = { decision: id, ...requested };
  if (!current) return publish(req, SATISFACTION, record, options);
  if (req.dryRun) return envelope("state decisions update", { id: current.id!, artifact: ARTIFACT, path: current.path, replay: canonicalRecordJson(current.record) === canonicalRecordJson(record) }, record, true);
  const result = replaceEntity({ projectRoot: req.projectRoot, sourceRoot, publicationContext: options.publicationContext, artifact: ARTIFACT, boundary: SATISFACTION, id: current.id!, expectedRecord: current.record!, record });
  return envelope("state decisions update", result, record);
}

export function amendDecisionEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const id = requiredText(req.values.id, "id");
  const expected = requiredText(req.values.base_sha256, "base_sha256");
  const allowed = new Set(decisionRevisionContract(sourceRoot).amendablePaths);
  const changes: JsonObject = {};
  for (const [field, value] of Object.entries(req.values)) if (!["id", "base_sha256"].includes(field)) {
    if (field === "alternatives" && mapping(value)) {
      for (const [name, alternative] of Object.entries(value)) {
        const target = `alternatives.${name}`;
        if (!allowed.has(target)) throw failure("invalid_request", `'${target}' is not amendable decision content`, "Use only authority-declared content fields.", id);
        changes[target] = structuredClone(alternative) as never;
      }
    } else {
      if (!allowed.has(field) || field === "satisfaction") throw failure("invalid_request", `'${field}' is not amendable decision content`, "Use only authority-declared content fields; update satisfaction separately.", id);
      changes[field] = structuredClone(value) as never;
    }
  }
  if (!Object.keys(changes).length) throw failure("invalid_request", "decision amendment requires at least one content field", "Supply one amendable content field.", id);
  const { all } = baseFor(req.projectRoot, id, sourceRoot);
  const existingClaims = all.filter((entity) => entity.boundary === REVISION && entity.record?.decision === id && entity.record?.base_sha256 === expected);
  const replay = existingClaims.find((entity) => canonicalRecordJson(entity.record?.changes) === canonicalRecordJson(changes));
  if (replay) return envelope("state decisions amend", { id: replay.id!, artifact: ARTIFACT, path: replay.path, replay: true }, replay.record!, req.dryRun);
  if (existingClaims.length) throw failure("immutable_conflict", `decision '${id}' already has a divergent revision for requested base ${expected}`, "Preserve both requested values and resolve the same-base amendment explicitly.", id);
  const current = getDecisionEntity(req.projectRoot, id, sourceRoot).entry as JsonObject;
  if (current.effective_sha256 !== expected) throw failure("immutable_conflict", `decision '${id}' changed from requested base ${expected}`, "Get the decision again, review the effective provenance, and retry with its current effective_sha256.", id);
  const effective = current.record as JsonObject;
  const projected = applyChanges(effective, changes);
  if (canonicalRecordJson(projected) === canonicalRecordJson(effective)) return { schemaVersion: "agentera.stateWrite.v1", command: "state decisions amend", status: "pass", path: String(((current.provenance as JsonObject).base as JsonObject).path), id, artifact: ARTIFACT, record: changes, operation: { verb: "amend", dry_run: req.dryRun, idempotent_replay: true }, validation: { status: "pass", violations: [] } };
  return publish(req, REVISION, { decision: id, date: localDate(), provenance: "historical_revision", base_sha256: expected, changes }, options);
}

function key(entity: DiscoveredEntity): string { return `${String(entity.record!.date)}\0${entity.id}`; }
function snapshot(root: string, entities: DiscoveredEntity[]): string {
  const inputs = entities
    .map(({ id, artifact, boundary, record, path: entityPath }) => ({ id, artifact, boundary, path: relative(root, entityPath), record }))
    .sort((left, right) => canonicalRecordJson(left).localeCompare(canonicalRecordJson(right)));
  return createHash("sha256").update(canonicalRecordJson(inputs)).digest("hex");
}
function cursorSecret(root: string, authorityPath: string): Buffer { return createHash("sha256").update(path.resolve(root)).update("\0").update(fs.readFileSync(authorityPath)).digest(); }
function encode(payload: JsonObject, root: string, authorityPath: string): string { const bytes = Buffer.from(canonicalRecordJson(payload)); return `${bytes.toString("base64url")}.${createHmac("sha256", cursorSecret(root, authorityPath)).update(bytes).digest("base64url")}`; }
function decode(token: string, root: string, authorityPath: string): JsonObject {
  const parts = token.split(".");
  try {
    if (parts.length !== 2) throw new Error();
    const bytes = Buffer.from(parts[0], "base64url"); const supplied = Buffer.from(parts[1], "base64url"); const expected = createHmac("sha256", cursorSecret(root, authorityPath)).update(bytes).digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
    const value = JSON.parse(bytes.toString()); if (!mapping(value)) throw new Error(); return value;
  } catch { throw failure("cursor_invalid", "decisions cursor is malformed or belongs to another project", "Copy next_cursor exactly, or omit --cursor to restart."); }
}
export function listDecisionEntities(root: string, limit?: number, topic?: string, cursor?: string, options: { sourceRoot?: string; format?: string } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const declared = contract(sourceRoot); const effectiveLimit = limit ?? declared.defaultLimit;
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > declared.maximumLimit) throw failure("invalid_request", `decisions list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.");
  const all = decisionEntities(root, sourceRoot); let bases = all.filter((entity) => entity.boundary === BASE).sort((a, b) => String(b.record!.date).localeCompare(String(a.record!.date)) || a.id!.localeCompare(b.id!));
  if (topic) { const needle = topic.toLowerCase(); bases = bases.filter((entity) => canonicalRecordJson(entity.record).toLowerCase().includes(needle)); }
  const snap = snapshot(root, all); let start = 0;
  if (cursor) { const value = decode(cursor, root, declared.authorityPath); if (value.artifact !== ARTIFACT || value.order !== ORDER || value.snapshot_id !== snap || value.topic !== (topic ?? null)) throw failure("cursor_snapshot_unavailable", "decisions changed after this cursor snapshot", "Omit --cursor to restart from the current snapshot."); const found = bases.findIndex((entity) => key(entity) === value.after_key); if (found < 0) throw failure("cursor_snapshot_unavailable", "decisions cursor continuation is unavailable", "Omit --cursor to restart."); start = found + 1; }
  let selected = bases.slice(start, start + effectiveLimit); let trimmed = false;
  const response = (): JsonObject => { const remaining = bases.length - start - selected.length; const next = remaining && selected.length ? encode({ version: 1, artifact: ARTIFACT, order: ORDER, snapshot_id: snap, topic: topic ?? null, after_key: key(selected.at(-1)!) }, root, declared.authorityPath) : undefined; return { schemaVersion: "agentera.stateList.v1", command: "state decisions list", status: remaining ? "degraded" : "ok", entries: selected.map((base) => compose(root, base, all)), counts: { total: bases.length, returned: selected.length, remaining }, filters: { topic: topic ?? null }, snapshot: { id: snap, first_page: !cursor, order: ORDER, has_more: Boolean(remaining), candidate_count: bases.length }, source: { artifact: ARTIFACT, authority: "canonical_entity_files", root: declared.entityRoot }, ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: trimmed ? "serialized_byte_budget" : "page_limit", next_cursor: next, retrieval: { continue: `agentera state decisions list --limit ${effectiveLimit} --cursor ${next} --format json`, get: "agentera state decisions get --id ID --format json" } } : {}) }; };
  let result = response(); const bytes = (): number => Buffer.byteLength(options.format === "yaml" || options.format === "text" ? YAML.stringify(result) : JSON.stringify(result));
  while (bytes() > declared.maxUtf8Bytes && selected.length) { selected = selected.slice(0, -1); trimmed = true; result = response(); }
  if (!selected.length && bases.length > start) throw failure("unsupported_state", `one full decision cannot fit the ${declared.maxUtf8Bytes}-byte list budget`, "Use exact get by ID.");
  return result;
}
