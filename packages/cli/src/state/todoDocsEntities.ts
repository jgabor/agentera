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
  entityExactGetMaxBytes,
  exactDiscoveredEntityBytes,
  publishEntityUnderLock,
  replaceEntityUnderLock,
  validateEntityState,
  withEntityWriterLock,
  type DiscoveredEntity,
  type EntityDiscoveryResult,
} from "./entityStorage.js";
import type { EntityPublicationContext, PublishedTargetIdentity } from "./entityPublicationContext.js";
import type { MigrationSourceBindingContext } from "./migrationSourceBinding.js";
import { detectStateModeBinding } from "./stateMode.js";
import { reject } from "./write/errors.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { TODO_SEVERITIES, TODO_STATUSES, todoDocsRecordViolations, todoInputViolations } from "./todoDocsEntityValidation.js";
import { todoReadinessReferenceViolations } from "../registries/todoReadinessContract.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";
import { parseTodoMarkdownListItem, renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { artifactSchemasDir, loadArtifactRecord, registryModelPath, resolveArtifactPath } from "../registries/artifactRegistry.js";

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
  const { authorityPath, document: authority } = loadStateStorageAuthority(sourceRoot);
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

function relevant(root: string, sourceRoot: string, artifact?: "todo" | "docs", supplied?: EntityDiscoveryResult, sourceBinding?: MigrationSourceBindingContext): DiscoveredEntity[] {
  if (supplied) assertEntityDiscoveryOrigin(root, sourceRoot, supplied);
  const discovery = supplied ?? discoverEntities(root, sourceRoot, sourceBinding);
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
  const violations = [...canonicalEntityRecordViolations(boundary, record, sourceRoot), ...todoDocsRecordViolations(boundary, record, sourceRoot)];
  return [...new Set(violations)];
}

function assertState(root: string, sourceRoot: string, sourceBinding?: MigrationSourceBindingContext): void {
  const state = validateEntityState(root, sourceRoot, sourceBinding);
  if (!state.valid) reject({ class: "conflict", message: `canonical entity state is invalid: ${state.issues.map(({ message }) => message).join("; ")}`, recovery: "Run agentera check validate state and resolve every identity or record conflict before retrying; no state was changed." });
}

function markdownSeverity(section: string): string | null {
  return section === "critical" || section === "degraded" || section === "normal" || section === "annoying" ? section : null;
}

function todoPublicPath(root: string, sourceRoot: string): string {
  const todo = loadArtifactRecord("todo", artifactSchemasDir(sourceRoot), registryModelPath(sourceRoot));
  if (!todo) throw new Error("artifact registry is missing the canonical 'todo' record");
  return resolveArtifactPath(todo, root, { strictWrite: true });
}

function todoMarkdownRow(root: string, sourceRoot: string, id: string): { severity: string | null; item: ReturnType<typeof parseTodoMarkdownListItem> } | null {
  const file = todoPublicPath(root, sourceRoot);
  if (!fs.existsSync(file)) return null;
  let section = "normal";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const heading = line.trim().match(/^##\s+(.+)$/)?.[1]?.toLowerCase();
    if (heading) section = heading.includes("critical") ? "critical" : heading.includes("degraded") ? "degraded" : heading.includes("annoying") ? "annoying" : heading.includes("resolved") ? "resolved" : heading.includes("normal") ? "normal" : section;
    const item = parseTodoMarkdownListItem(line.trim());
    if (item?.id === id) return { severity: markdownSeverity(section), item };
  }
  return null;
}

function assertTodoPublicAgreement(root: string, sourceRoot: string, id: string, current: JsonObject, proposed: JsonObject = current): void {
  const row = todoMarkdownRow(root, sourceRoot, id);
  if (!row?.item) return;
  const expectedStatus = row.item.status;
  const currentText = renderTodoPublicRecord(current);
  const proposedText = renderTodoPublicRecord(proposed);
  const publicText = row.item.public_description ?? row.item.description;
  const currentSeverityMatches = row.severity === "resolved" || row.severity === null || current.severity === row.severity;
  const proposedSeverityMatches = row.severity === "resolved" || row.severity === null || proposed.severity === row.severity;
  const currentTextMatches = current.title !== undefined ? currentText === publicText : currentText === row.item.description || currentText === publicText;
  const proposedTextMatches = proposed.title !== undefined ? proposedText === publicText : proposedText === row.item.description || proposedText === publicText;
  const currentMatches = current.status === expectedStatus && currentSeverityMatches && currentTextMatches;
  const proposedMatches = proposed.status === expectedStatus && proposedSeverityMatches && proposedTextMatches;
  if (!currentMatches || !proposedMatches) reject({
    class: "conflict",
    message: `TODO.md and Agentera disagree on public values for TODO '${id}'`,
    violations: [
      ...(!currentMatches ? ["current canonical entity is already divergent from TODO.md"] : []),
      ...(!proposedMatches ? ["the requested mutation would diverge from TODO.md-owned public values"] : []),
    ],
    recovery: "Reconcile the TODO.md row and canonical entity through the repository-first reconciliation contract; no state was changed.",
  });
}

function envelope(command: string, entity: { id: string; path: string; replay: boolean }, artifact: "todo" | "docs", record: JsonObject, dryRun: boolean): StateWriteEnvelope {
  return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: entity.path, id: entity.id, artifact, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: entity.replay }, validation: { status: "pass", violations: [] } };
}

function targetPath(root: string, sourceRoot: string, artifact: "todo" | "docs", id: string): string {
  const model = definition(artifact); return path.join(root, contract(model.boundary, sourceRoot).entityRoot, artifact, model.boundary, `${id}.yaml`);
}

function readinessRecord(value: unknown): JsonObject {
  if (!mapping(value)) return structuredClone(value) as JsonObject;
  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies.map((dependency) => typeof dependency === "string" ? { artifact: "todo", id: dependency } : dependency)
    : value.dependencies;
  return {
    ...structuredClone(value),
    ...(dependencies !== undefined ? { dependencies } : { dependencies: [] }),
    ...(value.blocked === undefined ? { blocked: null } : {}),
    ...(value.gate === undefined ? { gate: null } : {}),
  } as JsonObject;
}

function legacyTodoPayload(req: StateWriteRequest): JsonObject {
  const values = req.values;
  return {
    ...(values.severity !== undefined ? { severity: values.severity } : {}),
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values.readiness !== undefined ? { readiness: readinessRecord(values.readiness) } : {}),
  } as JsonObject;
}

function todoPayload(req: StateWriteRequest): JsonObject {
  return req.input ? structuredClone(req.input) as JsonObject : legacyTodoPayload(req);
}

function applyTodoPatch(current: JsonObject, patch: JsonObject): JsonObject {
  const record = structuredClone(current);
  if (patch.title !== undefined && record.title === undefined && typeof record.description === "string") {
    const legacy = parseTodoMarkdownListItem(`- [ ] ${record.description}`);
    record.kind = legacy?.kind ?? "task";
    record.target_version = legacy?.target_version ?? null;
    record.requirements = [];
    record.acceptance = [];
    record.release_blocker = false;
  }
  for (const field of ["kind", "target_version", "title", "requirements", "acceptance", "release_blocker", "severity", "description"]) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null) delete record[field];
    else record[field] = structuredClone(value);
  }
  if ("readiness" in patch) {
    if (patch.readiness === null) delete record.readiness;
    else record.readiness = readinessRecord(patch.readiness) as JsonObject;
  }
  if ("title" in patch) delete record.description;
  return record;
}

function transitionRecord(req: StateWriteRequest, current: JsonObject, entities: DiscoveredEntity[]): JsonObject {
  const lifecycle = mapping(req.values.lifecycle) ? req.values.lifecycle : {};
  const operation = req.spec.verb;
  const reason = String(lifecycle.reason ?? "").trim();
  const date = String(lifecycle.date ?? "");
  const severity = String(req.values.severity ?? "");
  const replacement = String(lifecycle.replacement ?? "");
  const record = structuredClone(current);
  const previous = mapping(current.lifecycle) ? current.lifecycle : null;
  const sameTransition = previous !== null
    && previous.operation === operation
    && previous.reason === reason
    && previous.date === date
    && (operation === "set-severity" ? current.severity === severity : true)
    && (operation === "supersede" ? previous.replacement === replacement : previous.replacement === undefined);
  const replayStatus = operation === "resolve" || operation === "supersede" ? "resolved" : operation === "reopen" ? "open" : null;
  if (sameTransition && (replayStatus === null || current.status === replayStatus)) return record;
  if (operation === "set-severity") {
    if (previous?.operation === operation && previous.reason === reason && previous.date === date) reject({
      class: "conflict",
      message: "TODO set-severity retry differs from the established transition",
      recovery: `Retry the exact transition with --severity ${String(current.severity)}, --reason ${shell(previous.reason)}, and --date ${String(previous.date)}; use a distinct reason or date for a new transition; no state was changed.`,
    });
    record.severity = severity;
  } else if (operation === "resolve") {
    if (current.status !== "open") reject({
      class: "conflict",
      message: "TODO resolve requires an open item",
      recovery: previous?.operation === operation
        ? `Retry the exact transition with --reason ${shell(previous.reason)} and --date ${String(previous.date)}; no state was changed.`
        : "Use state todo reopen only for a resolved item; no state was changed.",
    });
    record.status = "resolved";
  } else if (operation === "reopen") {
    if (current.status !== "resolved") reject({
      class: "conflict",
      message: "TODO reopen requires a resolved item",
      recovery: previous?.operation === operation
        ? `Retry the exact transition with --reason ${shell(previous.reason)} and --date ${String(previous.date)}; no state was changed.`
        : "Use state todo resolve for an open item; no state was changed.",
    });
    record.status = "open";
  } else if (operation === "supersede") {
    if (current.status !== "open") reject({
      class: "conflict",
      message: "TODO supersede requires an open item",
      recovery: previous?.operation === operation
        ? `Retry the exact transition with --replacement ${String(previous.replacement)}, --reason ${shell(previous.reason)}, and --date ${String(previous.date)}; no state was changed.`
        : "Reopen the resolved item before establishing a supersession; no state was changed.",
    });
    if (!/^[a-z]{10}$/.test(replacement) || replacement === String(req.values.id)) reject({ class: "schema_violation", message: "supersede replacement must be a distinct bare TODO ID", recovery: "Use an existing ten-letter TODO ID other than the selected item; no state was changed." });
    const target = entities.find((entity) => entity.boundary === TODO.boundary && entity.id === replacement);
    if (!target) reject({ class: "unsupported_target", message: `TODO replacement '${replacement}' was not found`, recovery: "Use an ID returned by agentera state todo list --format json; no state was changed." });
    record.status = "resolved";
  }
  record.lifecycle = {
    operation,
    reason,
    date,
    ...(lifecycle.replacement !== undefined ? { replacement: String(lifecycle.replacement) } : {}),
  };
  return record;
}

function mutationRecord(req: StateWriteRequest, current: JsonObject | undefined, entities: DiscoveredEntity[] = []): JsonObject {
  if (req.artifact === "docs") return structuredClone(req.input ?? {}) as JsonObject;
  if (current && ["set-severity", "supersede", "resolve", "reopen"].includes(req.spec.verb)) return transitionRecord(req, current, entities);
  const payload = todoPayload(req);
  if (req.spec.verb === "create") return { ...structuredClone(payload), status: "open", ...(payload.readiness !== undefined ? { readiness: readinessRecord(payload.readiness) } : {}) } as JsonObject;
  return applyTodoPatch(current ?? {}, payload);
}

function assertTodoReferences(id: string, record: JsonObject, entities: DiscoveredEntity[]): void {
  if (record.readiness === undefined) return;
  const todos = entities
    .filter((entity) => entity.boundary === TODO.boundary && entity.id && entity.record && entity.id !== id)
    .map((entity) => ({ id: entity.id!, record: entity.record! }));
  todos.push({ id, record });
  const violations = todoReadinessReferenceViolations(id, record.readiness, todos);
  if (violations.length) reject({
    class: "schema_violation",
    message: "todo readiness dependencies are invalid",
    violations,
    recovery: "Use bare ten-letter IDs returned by `agentera state todo list --format json`; reference existing TODO items only and remove self-references or cycles, then retry.",
  });
}

function todoReadinessRecovery(verb: string): string {
  return `Run agentera state todo explain --verb ${verb} --format json, then provide a complete typed TODO record or patch; readiness must include capability, reason, queue_rank, and order_reason together, and dependencies must use IDs returned by agentera state todo list --format json.`;
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
    const pinnedRoot = context.pinnedPath();
    const sourceBinding = { kind: "project", projectRoot: context.validatedRoot } as const;
    context.assertValid();
    assertState(pinnedRoot, sourceRoot, sourceBinding);
    context.assertValid();
    const entities = relevant(pinnedRoot, sourceRoot, artifact, undefined, sourceBinding);
    context.assertValid();
    if (req.spec.verb === "create") {
      if (artifact === "todo" && req.input) {
        const inputViolations = todoInputViolations(req.input as JsonObject, "create");
        if (inputViolations.length) reject({ class: "schema_violation", message: "todo create input is invalid", violations: inputViolations, recovery: todoReadinessRecovery(req.spec.verb) });
      }
      const record = mutationRecord(req, undefined, entities); const violations = recordViolations(artifact, record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: `${artifact} entity input is invalid`, violations, ...(artifact === "todo" && record.readiness !== undefined ? { recovery: todoReadinessRecovery(req.spec.verb) } : {}) });
      const id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot); if (artifact === "todo" && record.readiness !== undefined) assertTodoReferences(id, record, entities); if (req.dryRun) return envelope(`state ${artifact} create`, { id, path: targetPath(req.projectRoot, sourceRoot, artifact, id), replay: false }, artifact, record, true);
      let published: { path: string; publishedIdentity?: PublishedTargetIdentity } | undefined;
      try { const result = publishEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact, boundary: definition(artifact).boundary, id, record }); published = result; assertState(pinnedRoot, sourceRoot, sourceBinding); context.assertValid(); return envelope(`state ${artifact} create`, result, artifact, record, false); }
      catch (error) { if (published?.publishedIdentity) context.removeExact(relative(req.projectRoot, published.path), published.publishedIdentity); throw error; }
    }
    const id = String(req.values.id ?? "");
    if (!ID.test(id)) reject({ class: "invalid_request", message: `${artifact} ID '${id}' must be ten lowercase letters`, recovery: `Use a bare ${artifact} ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid.` });
    const entity = selectedById(entities, artifact, id);
    if (artifact === "todo" && req.input && ["update"].includes(req.spec.verb)) {
      const inputViolations = todoInputViolations(req.input as JsonObject, "update");
      if (inputViolations.length) reject({ class: "schema_violation", message: "todo update input is invalid", violations: inputViolations, recovery: todoReadinessRecovery(req.spec.verb) });
    }
    const record = mutationRecord(req, entity.record!, entities); const violations = recordViolations(artifact, record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: `${artifact} entity input is invalid`, violations, ...(artifact === "todo" && record.readiness !== undefined ? { recovery: todoReadinessRecovery(req.spec.verb) } : {}) });
    if (artifact === "todo" && record.readiness !== undefined) assertTodoReferences(id, record, entities);
    if (artifact === "todo") assertTodoPublicAgreement(req.projectRoot, sourceRoot, id, entity.record!, record);
    if (canonicalRecordJson(record) === canonicalRecordJson(entity.record)) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: true }, artifact, record, req.dryRun);
    if (req.dryRun) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: false }, artifact, record, true);
    const request = { projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact, boundary: definition(artifact).boundary, id, expectedRecord: entity.record!, expectedBytes: exactDiscoveredEntityBytes(entity), migrationProvenance: entity.migrationProvenance, record };
    let replacement: { path: string; publishedIdentity?: PublishedTargetIdentity; previousBytes?: string } | undefined;
    try { const result = replaceEntityUnderLock(request); replacement = result; assertState(pinnedRoot, sourceRoot, sourceBinding); context.assertValid(); return envelope(`state ${artifact} ${req.spec.verb}`, result, artifact, record, false); }
    catch (error) { if (replacement?.publishedIdentity && replacement.previousBytes !== undefined) context.restoreExact(relative(req.projectRoot, replacement.path), replacement.publishedIdentity, replacement.previousBytes, entityExactGetMaxBytes(sourceRoot)); throw error; }
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
