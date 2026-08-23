import { createHash } from "node:crypto"; import fs from "node:fs"; import path from "node:path";
import YAML from "yaml"; import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateEntityId, assertEntityDiscoveryOrigin, canonicalEntityEnvelopeBytes, canonicalEntityRecordViolations, discoverEntities, entityExactGetMaxBytes, exactDiscoveredEntityBytes, publishEntityUnderLock, replaceEntityUnderLock, validateEntityState, withEntityWriterLock, type DiscoveredEntity, type EntityDiscoveryResult } from "./entityStorage.js";
import type { EntityPublicationContext, PublishedTargetIdentity } from "./entityPublicationContext.js";
import type { MigrationSourceBindingContext } from "./migrationSourceBinding.js";
import { detectStateModeBinding } from "./stateMode.js";
import { reject, StateWriteInputError } from "./write/errors.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { TODO_SEVERITIES, TODO_STATUSES, todoDocsRecordViolations, todoInputViolations } from "./todoDocsEntityValidation.js";
import { todoReadinessReferenceViolations } from "../registries/todoReadinessContract.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";
import { entityListSelectorFlags, entityListSelectorKey, projectEntityList, resolveEntityListSelector, type EntityListSelectorInput } from "./entityListProjection.js";
import { decodeListCursor, encodeListCursor } from "./listCursor.js";
import { entityListFamily } from "./entityRetrievalHelp.js";
import { shellQuoteArgument } from "../core/shell.js";
import { parseTodoMarkdownListItem, renderTodoPublicRecord } from "../cli/todoMarkdown.js";
import { evaluateTodoReadinessQueue, type TodoReadinessEvaluation } from "../cli/todoReadinessSelection.js";
import { artifactSchemasDir, loadArtifactRecord, registryModelPath, resolveArtifactPath } from "../registries/artifactRegistry.js";
import { inspectTodoReconciliation, publishTodoReconciliation, recoverTodoReconciliation, todoCreateRequestSha256, type TodoReconciliationBinding, type TodoReconciliationTarget } from "./todoReconciliationTransaction.js";
import { loadTodoReconciliationActivation, todoLegacyRowFingerprint, todoReconciliationActivationBytes, TODO_RECONCILIATION_ACTIVATION_PATH, TODO_RECONCILIATION_ITEM_LIMIT, TODO_ACTIVATION_APPLY_COMMAND, TODO_ACTIVATION_PREVIEW_COMMAND, TODO_ACTIVATION_RISK_LIMIT, TODO_OWNER_CORRECTION_APPLY_COMMAND, TODO_OWNER_CORRECTION_PREVIEW_COMMAND, TODO_REPAIR_APPLY_COMMAND, TODO_REPAIR_PREVIEW_COMMAND, todoActivationEffect, todoOwnerCorrectionEffect, todoRepairEffect, unchangedTodoActivationEffect, type TodoReconciliationActivation } from "./todoReconciliationActivation.js";
import { normalizeTodoOwnerCorrectionEvidence, planTodoOwnerCorrection, planTodoRepair } from "./todoReconciliationRepair.js";
import { readTodoMarkdown, renderManagedMarkdown } from "./todoMarkdownProjection.js";
import { inactiveTodoActivationSafety, rejectUnsafeInactiveTodoActivation, unsafeInactiveDuplicateDiagnosis } from "./todoActivationSafety.js";
import { assertTodoSeverityHeadingStructure, todoSeveritySectionForHeading } from "./todoSeverityHeadings.js";
import { parseTodoUpdateBatch, todoUpdateBatchEffectSha256 } from "./todoUpdateBatch.js"; import { parseTodoCreateBatch, resolveTodoCreateBatchRecords, todoCreateBatchEffectSha256 } from "./todoCreateBatch.js"; import { parseTodoTransitionBatch } from "./todoTransitionBatch.js";
const ID = /^[a-z]{10}$/; const SHA256 = /^[a-f0-9]{64}$/;
const TODO = { artifact: "todo", boundary: "todo_item", order: "severity_then_status_then_markdown_order_then_id" } as const; const DOCS = { artifact: "docs", boundary: "documentation_inventory_entry", order: "path_then_id" } as const;
interface Options { sourceRoot?: string; publicationContext?: EntityPublicationContext; candidate?: () => string; interruptAfterTarget?: number } interface Contract { authorityPath: string; entityRoot: string; defaultLimit: number; maximumLimit: number; maxUtf8Bytes: number }
function mapping(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function relative(root: string, file: string): string { return path.relative(path.resolve(root), file).split(path.sep).join("/"); }
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
} function failure(kind: StateFailureClass, artifact: string, message: string, recovery: string, id?: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  const family = kind === "cursor_invalid" || kind === "cursor_snapshot_unavailable" ? entityListFamily(artifact as "todo" | "docs") : undefined;
  return new StateRetrievalFailure({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: family?.syntax ?? `agentera state ${artifact} get --id ID --format json`, example: family?.example ?? `agentera state ${artifact} get --id ${id ?? "qjtrmnpvka"} --format json`, recovery, artifact, ...(id ? { id } : {}) } }, exitCode);
}
export function relevant(root: string, sourceRoot: string, artifact?: "todo" | "docs", supplied?: EntityDiscoveryResult, sourceBinding?: MigrationSourceBindingContext): DiscoveredEntity[] {
  if (supplied) assertEntityDiscoveryOrigin(root, sourceRoot, supplied);
  const discovery = supplied ?? discoverEntities(root, sourceRoot, sourceBinding);
  const selected = discovery.entities.filter((entity) => [TODO.boundary, DOCS.boundary].includes(entity.boundary as typeof TODO.boundary) || [TODO.artifact, DOCS.artifact].includes(entity.artifact as typeof TODO.artifact));
  const bad = selected.find(({ classification, id, record }) => classification !== "valid" || !id || !record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", artifact ?? bad.artifact ?? "todo", `entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state and resolve every invalid identity or record before retrying.", bad.id ?? undefined);
  return selected;
} function selectedById(entities: DiscoveredEntity[], artifact: "todo" | "docs", id: string): DiscoveredEntity {
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
export function todoPublicPath(root: string, sourceRoot: string): string {
  const todo = loadArtifactRecord("todo", artifactSchemasDir(sourceRoot), registryModelPath(sourceRoot));
  if (!todo) throw new Error("artifact registry is missing the canonical 'todo' record");
  return resolveArtifactPath(todo, root, { strictWrite: true });
}
export function todoReconciliationBinding(root: string, sourceRoot: string): TodoReconciliationBinding {
  const publicPath = relative(root, todoPublicPath(root, sourceRoot));
  const docsRecord = loadArtifactRecord("docs", artifactSchemasDir(sourceRoot), registryModelPath(sourceRoot));
  if (!docsRecord) throw new Error("artifact registry is missing the canonical 'docs' record");
  const docs = resolveArtifactPath(docsRecord, root, { strictWrite: true });
  const mapping = fs.existsSync(docs) ? fs.readFileSync(docs) : Buffer.from("<absent>");
  const mappingSha256 = createHash("sha256").update(publicPath).update("\0").update(mapping).digest("hex");
  return { publicPath, mappingSha256 };
}
export function assertTodoReconciliationReadable(root: string, sourceRoot: string, id?: string): void {
  const directory = path.join(root, ".agentera/.todo-reconciliation");
  if (!fs.existsSync(directory) || !fs.readdirSync(directory).some((name) => name.endsWith(".json"))) return;
  let pending: string[];
  try { pending = inspectTodoReconciliation(root, todoReconciliationBinding(root, sourceRoot)); }
  catch (error) {
    if (error instanceof StateWriteInputError) {
      throw failure("unsupported_state", "todo", error.body.message, error.body.recovery ?? "Restore the pending TODO reconciliation journal, then retry this read.", id);
    }
    throw error;
  }
  if (pending.length) throw failure("unsupported_state", "todo", `TODO reconciliation transaction '${pending[0]}' is pending; no mixed TODO state is readable`, "Retry the exact non-dry-run TODO mutation to complete recovery, then repeat this read.", id);
}
interface TodoPublicSnapshot { present: boolean; description?: string; severity?: string; status?: string; order?: number }
export interface ManagedRow { id: string; line: number; section: string; sourceLine: string; snapshot: TodoPublicSnapshot; item: NonNullable<ReturnType<typeof parseTodoMarkdownListItem>> }
interface LegacyRow { line: number; section: string; sourceLine: string; snapshot: TodoPublicSnapshot; item: NonNullable<ReturnType<typeof parseTodoMarkdownListItem>> }
export interface ManagedRowScan { rows: Map<string, ManagedRow>; retainedLegacyRows: string[]; matchedRows: number; convertedRows: number }
type TodoEntityView = Pick<DiscoveredEntity, "boundary" | "id" | "record">;
const RECONCILIATION_VERSION = "agentera.todoReconciliation.v1";
const TODO_DRIFT_ITEM_LIMIT = 20;
const PUBLIC_FIELDS = ["description", "severity", "status"] as const;
interface TodoDriftItem {
  id: string;
  state: "markdown_only" | "entity_only" | "convergent" | "conflict";
  markdown_changed_fields: string[];
  entity_changed_fields: string[];
  conflicting_fields: string[];
}
interface TodoReadView {
  rows: Map<string, ManagedRow>;
  drift: JsonObject;
}
function publicSnapshot(record: JsonObject, order?: number): TodoPublicSnapshot {
  return { present: true, description: renderTodoPublicRecord(record), severity: String(record.severity), status: String(record.status), ...(order === undefined ? {} : { order }) };
}
function baseline(record: JsonObject): TodoPublicSnapshot | null {
  const reconciliation = mapping(record.reconciliation) ? record.reconciliation : null;
  const value = reconciliation?.schema_version === RECONCILIATION_VERSION && mapping(reconciliation.public) ? reconciliation.public : null;
  if (!value || typeof value.present !== "boolean") return null;
  return structuredClone(value) as unknown as TodoPublicSnapshot;
}

function samePublic(left: TodoPublicSnapshot, right: TodoPublicSnapshot, includeOrder = true): boolean {
  const fields = includeOrder ? ["present", "description", "severity", "status", "order"] : ["present", "description", "severity", "status"];
  return fields.every((field) => left[field as keyof TodoPublicSnapshot] === right[field as keyof TodoPublicSnapshot]);
}
function changedPublicFields(
  current: TodoPublicSnapshot,
  prior: TodoPublicSnapshot,
  includeOrder: boolean,
): string[] {
  const fields = includeOrder ? ["present", ...PUBLIC_FIELDS, "order"] : ["present", ...PUBLIC_FIELDS];
  return fields.filter((field) => current[field as keyof TodoPublicSnapshot] !== prior[field as keyof TodoPublicSnapshot]);
}

function todoAuthority(): JsonObject {
  return {
    identity: { owner: "managed_row", field: "id" },
    public: { owner: "markdown", source: "TODO.md", fields: ["description", "severity", "status", "order"] },
    operational: { owner: "agentera", source: "canonical_entity_file", fields: ["readiness", "dependencies", "blocked", "gate", "evidence", "lifecycle"] },
  };
}

export function managedRows(
  markdown: string,
  activation: TodoReconciliationActivation | null,
  entities: readonly TodoEntityView[],
): ManagedRowScan {
  assertTodoSeverityHeadingStructure(markdown); const result = new Map<string, ManagedRow>();
  const order = new Map<string, number>();
  const legacy: LegacyRow[] = [];
  let section: string | null = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const heading = line.trim().match(/^##\s+(.+)$/)?.[1]?.toLowerCase();
    if (heading) section = todoSeveritySectionForHeading(line) ?? (heading === "notes" ? null : section);
    const item = parseTodoMarkdownListItem(line.trim());
    if (!item) return;
    const severity = section ? markdownSeverity(section) : null;
    if (item.id && !severity && section !== "resolved") reject({ class: "conflict", message: `TODO '${item.id}' is outside a managed severity or resolved section`, recovery: `Move '${item.id}' under one declared TODO severity or the resolved section and retry; no state was changed.` });
    if (!section) return;
    const key = section === "resolved" ? "resolved" : severity!;
    const publicOrder = (order.get(key) ?? 0) + 1; order.set(key, publicOrder);
    const row = { line: index, section: key, sourceLine: line, item, snapshot: { present: true, description: item.public_description ?? item.description, ...(section === "resolved" ? {} : { severity: severity! }), status: item.status, order: publicOrder } };
    if (!item.id) { legacy.push(row); return; }
    if (result.has(item.id)) reject({ class: "conflict", message: `TODO.md contains duplicate managed ID '${item.id}'`, recovery: `Keep exactly one managed row with ID '${item.id}' and retry; no state was changed.` });
    result.set(item.id, { ...row, id: item.id });
  });
  const retainedLegacyRows: string[] = []; const matchedRows = result.size; let convertedRows = 0;
  if (activation) {
    const retained = new Set(activation.retained_legacy_rows);
    for (const row of legacy) {
      const fingerprint = todoLegacyRowFingerprint(row.section, row.sourceLine);
      if (retained.delete(fingerprint)) continue;
      reject({
        class: "conflict",
        message: `managed TODO checkbox row at line ${row.line + 1} has no ten-letter ID after reconciliation activation`,
        recovery: `Add '[id:abcdefghij]' with the row's canonical ten-letter entity ID at TODO.md line ${row.line + 1}, or move the row outside managed severity and resolved sections, then retry once; no state was changed.`,
      });
    }
  } else {
    const legacyByFingerprint = new Map<string, LegacyRow[]>();
    for (const row of legacy) {
      const fingerprint = todoLegacyRowFingerprint(row.section, row.sourceLine);
      const duplicates = legacyByFingerprint.get(fingerprint) ?? [];
      duplicates.push(row);
      legacyByFingerprint.set(fingerprint, duplicates);
    }
    const ambiguous = [...legacyByFingerprint.values()].find((rows) => rows.length > 1);
    if (ambiguous) reject({
      class: "conflict",
      message: `pre-activation TODO contains identical ID-less managed rows at lines ${ambiguous.slice(0, TODO_ACTIVATION_RISK_LIMIT).map((row) => row.line + 1).join(", ")}${ambiguous.length > TODO_ACTIVATION_RISK_LIMIT ? `; ${ambiguous.length - TODO_ACTIVATION_RISK_LIMIT} additional lines omitted` : ""}`,
      diagnosis: unsafeInactiveDuplicateDiagnosis(),
      recovery: "Give each identical row its distinct canonical '[id:abcdefghij]' tag or remove the duplicate, then retry once; no state was changed.",
    });
    const claimed = new Set(result.keys());
    for (const row of legacy) {
      const duplicate = entities.find((entity) => entity.boundary === TODO.boundary && entity.id && entity.record && claimed.has(entity.id) && samePublic(publicSnapshot(entity.record), rowSnapshot({ ...row, id: entity.id }, entity.record), false));
      if (duplicate) reject({
        class: "conflict",
        message: `pre-activation TODO row at line ${row.line + 1} duplicates canonical public work`,
        diagnosis: unsafeInactiveDuplicateDiagnosis(),
        recovery: "Restore exactly one public row for each canonical entity before activation, then retry once; no state was changed.",
      });
      const matches = entities.filter((entity) => {
        if (entity.boundary !== TODO.boundary || !entity.id || !entity.record || claimed.has(entity.id)) return false;
        return samePublic(publicSnapshot(entity.record), rowSnapshot({ ...row, id: entity.id }, entity.record), false);
      });
      if (matches.length > 1) reject({
        class: "conflict",
        message: `pre-activation TODO row at line ${row.line + 1} matches multiple canonical entities`,
        diagnosis: unsafeInactiveDuplicateDiagnosis(matches.length),
        recovery: `Add one exact '[id:abcdefghij]' tag to TODO.md line ${row.line + 1} and retry once; no state was changed.`,
      });
      const matched = matches[0];
      if (matched?.id) {
        claimed.add(matched.id);
        result.set(matched.id, { ...row, id: matched.id });
        convertedRows += 1;
        continue;
      }
      const fingerprint = todoLegacyRowFingerprint(row.section, row.sourceLine);
      if (retainedLegacyRows.includes(fingerprint)) reject({
        class: "conflict",
        message: `pre-activation TODO contains duplicate unmatched legacy rows at line ${row.line + 1}`,
        diagnosis: unsafeInactiveDuplicateDiagnosis(),
        recovery: `Give each duplicate row a distinct canonical '[id:abcdefghij]' tag or move it outside managed sections, then retry once; no state was changed.`,
      });
      retainedLegacyRows.push(fingerprint);
    }
  }
  if (result.size > TODO_RECONCILIATION_ITEM_LIMIT || retainedLegacyRows.length > TODO_RECONCILIATION_ITEM_LIMIT) reject({
    class: "conflict",
    message: `TODO.md exceeds the ${TODO_RECONCILIATION_ITEM_LIMIT}-item reconciliation or legacy-activation bound`,
    recovery: `Compact retained resolved rows until each bounded set has at most ${TODO_RECONCILIATION_ITEM_LIMIT} items, then retry once; no state was changed.`,
  });
  return { rows: result, retainedLegacyRows, matchedRows, convertedRows };
}

function rowSnapshot(row: ManagedRow, record: JsonObject): TodoPublicSnapshot {
  return { ...row.snapshot, severity: row.section === "resolved" ? String(record.severity) : row.snapshot.severity };
}

function inspectTodoReadView(
  root: string,
  sourceRoot: string,
  entities: DiscoveredEntity[],
): TodoReadView {
  let activation: TodoReconciliationActivation | null;
  try {
    activation = loadTodoReconciliationActivation(root)?.record ?? null;
  } catch {
    return {
      rows: new Map(),
      drift: {
        schema_version: RECONCILIATION_VERSION,
        status: "invalid_lifecycle",
        read_effect: "none",
        authority: todoAuthority(),
        counts: { managed: 0, drifted: 0, conflicts: 1 },
        items: [],
      },
    };
  }
  if (!activation) {
    return {
      rows: new Map(),
      drift: {
        schema_version: RECONCILIATION_VERSION,
        status: "inactive",
        read_effect: "none",
        authority: todoAuthority(),
        counts: { managed: 0, drifted: 0, conflicts: 0 },
        items: [],
      },
    };
  }
  const todoEntities = entities.filter(({ boundary }) => boundary === TODO.boundary);
  let markdown: string;
  let rows: Map<string, ManagedRow>;
  try {
    markdown = readTodoMarkdown(todoPublicPath(root, sourceRoot)).text;
    rows = managedRows(markdown, activation, todoEntities).rows;
  } catch (error) {
    if (error instanceof StateWriteInputError && /Markdown/i.test(error.body.message)) throw error;
    const diagnosis = error instanceof StateWriteInputError && mapping(error.body.diagnosis) ? error.body.diagnosis : undefined; return {
      rows: new Map(),
      drift: {
        schema_version: RECONCILIATION_VERSION,
        status: "conflict", action_required: true,
        read_effect: "none",
        next_write_boundary: "atomic_reconciliation",
        authority: todoAuthority(),
        counts: { managed: 0, drifted: 0, conflicts: 1 },
        items: [], ...(diagnosis ? { diagnosis } : {}),
      },
    };
  }
  const items: TodoDriftItem[] = [];
  const entityIds = new Set<string>();
  for (const entity of todoEntities) {
    const id = entity.id!;
    entityIds.add(id);
    const current = entity.record!;
    const prior = baseline(current);
    const row = rows.get(id);
    if (!prior) {
      items.push({ id, state: "conflict", markdown_changed_fields: [], entity_changed_fields: [], conflicting_fields: ["baseline"] });
      continue;
    }
    if (!row) {
      if (prior.present) {
        items.push({
          id,
          state: prior.status === "open" ? "conflict" : "markdown_only",
          markdown_changed_fields: ["present"],
          entity_changed_fields: [],
          conflicting_fields: prior.status === "open" ? ["present"] : [],
        });
      }
      continue;
    }
    const markdownPublic = rowSnapshot(row, current);
    const entityPublic = publicSnapshot(current, prior.order);
    const markdownFields = changedPublicFields(markdownPublic, prior, true);
    const entityFields = changedPublicFields(entityPublic, prior, false);
    if (!markdownFields.length && !entityFields.length) continue;
    const conflictingFields = markdownFields.filter((field) =>
      entityFields.includes(field)
      && markdownPublic[field as keyof TodoPublicSnapshot] !== entityPublic[field as keyof TodoPublicSnapshot]);
    items.push({
      id,
      state: conflictingFields.length ? "conflict" : markdownFields.length && entityFields.length ? "convergent" : markdownFields.length ? "markdown_only" : "entity_only",
      markdown_changed_fields: markdownFields,
      entity_changed_fields: entityFields,
      conflicting_fields: conflictingFields,
    });
  }
  for (const id of rows.keys()) {
    if (!entityIds.has(id)) items.push({ id, state: "conflict", markdown_changed_fields: ["identity"], entity_changed_fields: [], conflicting_fields: ["identity"] });
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  const conflicts = items.filter(({ state }) => state === "conflict").length;
  const visibleItems = items.slice(0, TODO_DRIFT_ITEM_LIMIT);
  const omitted = items.length - visibleItems.length;
  return {
    rows,
    drift: {
      schema_version: RECONCILIATION_VERSION,
      status: conflicts ? "conflict" : items.length ? "drift" : "clean",
      read_effect: "none",
      next_write_boundary: "atomic_reconciliation",
      authority: todoAuthority(),
      counts: { managed: rows.size, drifted: items.length, conflicts },
      items: visibleItems as unknown as JsonObject[],
      ...(omitted ? { omitted: true, omitted_count: omitted, omission_reason: "item_limit" } : {}),
    },
  };
}

export function inspectTodoReconciliationDrift(
  root: string,
  sourceRoot = resolveSourceRoot(),
  discovery?: EntityDiscoveryResult,
): JsonObject {
  assertTodoReconciliationReadable(root, sourceRoot);
  return inspectTodoReadView(root, sourceRoot, relevant(root, sourceRoot, "todo", discovery)).drift;
}

export function projectTodoReadEntities(
  root: string,
  sourceRoot = resolveSourceRoot(),
  discovery?: EntityDiscoveryResult,
): Array<{ id: string; artifact: string; record: JsonObject; projectedOrder?: { kind: "managed"; markdownOrder: number } | { kind: "absent" } }> {
  assertTodoReconciliationReadable(root, sourceRoot);
  const entities = relevant(root, sourceRoot, "todo", discovery).filter(({ boundary }) => boundary === TODO.boundary);
  if (entities.length > TODO_RECONCILIATION_ITEM_LIMIT) throw failure(
    "unsupported_state",
    "todo",
    `complete TODO projection exceeds the ${TODO_RECONCILIATION_ITEM_LIMIT}-entity startup bound`,
    "Compact resolved TODO entities within the declared reconciliation bound, then retry this read.",
  );
  const view = inspectTodoReadView(root, sourceRoot, entities);
  const projected = view.drift.status !== "inactive";
  return sorted("todo", entities, view.rows).map((entity) => {
    const row = view.rows.get(entity.id!);
    return {
      id: entity.id!,
      artifact: entity.artifact!,
      record: publicReadRecord(entity.record!, row),
      ...(projected ? {
        projectedOrder: row?.snapshot.order === undefined
          ? { kind: "absent" as const }
          : { kind: "managed" as const, markdownOrder: row.snapshot.order },
      } : {}),
    };
  });
}

function publicReadRecord(record: JsonObject, row?: ManagedRow): JsonObject { return row ? importMarkdown(record, row) : record; }

function publicReadMetadata(record: JsonObject, row?: ManagedRow): JsonObject { const value = row ? rowSnapshot(row, record) : { present: false }; return { ...value, owner: "markdown", source: "TODO.md" } as JsonObject; }

function importMarkdown(record: JsonObject, row: ManagedRow): JsonObject {
  const result = structuredClone(record);
  const description = row.item.public_description ?? row.item.description;
  if (result.title !== undefined) {
    result.kind = row.item.kind ?? result.kind;
    result.target_version = row.item.target_version ?? null;
    result.title = row.item.title ?? description;
  } else result.description = description;
  if (row.section !== "resolved") result.severity = row.snapshot.severity!;
  result.status = row.item.status;
  return result;
}

function withBaseline(record: JsonObject, value: TodoPublicSnapshot): JsonObject { const publicValue = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as JsonObject; return { ...record, reconciliation: { schema_version: RECONCILIATION_VERSION, public: publicValue } }; }

function inactiveTodoMutation(): never { reject({ class: "conflict", message: "TODO reconciliation is inactive; ordinary TODO mutations cannot activate it implicitly", syntax: TODO_ACTIVATION_PREVIEW_COMMAND, example: TODO_ACTIVATION_APPLY_COMMAND, recovery: `Run exactly '${TODO_ACTIVATION_PREVIEW_COMMAND}', review every reported effect, then run exactly '${TODO_ACTIVATION_APPLY_COMMAND}'; no state was changed.` }); }
function activationEnvelope(effect: JsonObject, dryRun: boolean, replay: boolean, transactionId: string | null, targets: number, recovered: string[]): StateWriteEnvelope { return { schemaVersion: "agentera.stateWrite.v1", command: "state todo activate", status: "pass", path: TODO_RECONCILIATION_ACTIVATION_PATH, artifact: "todo", operation: { verb: "activate", dry_run: dryRun, idempotent_replay: replay }, validation: { status: "pass", violations: [] }, activation: effect, apply_command: TODO_ACTIVATION_APPLY_COMMAND.replace("EFFECT_SHA256", String(effect.effect_sha256)), reconciliation: { transaction_id: transactionId, targets, recovered } }; }
function repairEnvelope(effect: JsonObject, dryRun: boolean, replay: boolean, transactionId: string | null, targets: number, recovered: string[]): StateWriteEnvelope { return { schemaVersion: "agentera.stateWrite.v1", command: "state todo repair", status: "pass", path: TODO_RECONCILIATION_ACTIVATION_PATH, artifact: "todo", operation: { verb: "repair", dry_run: dryRun, idempotent_replay: replay }, validation: { status: "pass", violations: [] }, repair: effect, apply_command: TODO_REPAIR_APPLY_COMMAND.replace("EFFECT_SHA256", String(effect.effect_sha256)), reconciliation: { transaction_id: transactionId, targets, recovered } }; }
function ownerCorrectionEnvelope(effect: JsonObject, dryRun: boolean, replay: boolean, transactionId: string | null, targets: number, recovered: string[]): StateWriteEnvelope { return { schemaVersion: "agentera.stateWrite.v1", command: "state todo correct-owners", status: "pass", path: TODO_RECONCILIATION_ACTIVATION_PATH, artifact: "todo", operation: { verb: "correct-owners", dry_run: dryRun, idempotent_replay: replay }, validation: { status: "pass", violations: [] }, correction: effect, apply_command: TODO_OWNER_CORRECTION_APPLY_COMMAND.replace("EFFECT_SHA256", String(effect.effect_sha256)), reconciliation: { transaction_id: transactionId, targets, recovered } }; }
function envelope(command: string, entity: { id: string; path: string; replay: boolean }, artifact: "todo" | "docs", record: JsonObject, dryRun: boolean): StateWriteEnvelope { return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: entity.path, id: entity.id, artifact, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: entity.replay }, validation: { status: "pass", violations: [] } }; }
function targetPath(root: string, sourceRoot: string, artifact: "todo" | "docs", id: string): string {
  const model = definition(artifact); return path.join(root, contract(model.boundary, sourceRoot).entityRoot, artifact, model.boundary, `${id}.yaml`);
}
function readinessRecord(value: unknown): JsonObject {
  if (!mapping(value)) return structuredClone(value) as JsonObject;
  const dependencies = Array.isArray(value.dependencies)
    ? value.dependencies.map((dependency) => typeof dependency === "string" ? { artifact: "todo", id: dependency } : dependency)
    : value.dependencies;
  return {
    capability: value.capability,
    reason: value.reason,
    dependencies: dependencies ?? [],
    blocked: value.blocked ?? null,
    gate: value.gate ?? null,
    queue_rank: value.queue_rank,
    order_reason: value.order_reason,
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

function transitionRecord(req: StateWriteRequest, current: JsonObject, entities: TodoEntityView[]): JsonObject {
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
      recovery: `Retry the exact transition with --severity ${String(current.severity)}, --reason ${shellQuoteArgument(previous.reason)}, and --date ${String(previous.date)}; use a distinct reason or date for a new transition; no state was changed.`,
    });
    record.severity = severity;
  } else if (operation === "resolve") {
    if (current.status !== "open") reject({
      class: "conflict",
      message: "TODO resolve requires an open item",
      recovery: previous?.operation === operation
        ? `Retry the exact transition with --reason ${shellQuoteArgument(previous.reason)} and --date ${String(previous.date)}; no state was changed.`
        : "Use state todo reopen only for a resolved item; no state was changed.",
    });
    record.status = "resolved";
  } else if (operation === "reopen") {
    if (current.status !== "resolved") reject({
      class: "conflict",
      message: "TODO reopen requires a resolved item",
      recovery: previous?.operation === operation
        ? `Retry the exact transition with --reason ${shellQuoteArgument(previous.reason)} and --date ${String(previous.date)}; no state was changed.`
        : "Use state todo resolve for an open item; no state was changed.",
    });
    record.status = "open";
  } else if (operation === "supersede") {
    if (current.status !== "open") reject({
      class: "conflict",
      message: "TODO supersede requires an open item",
      recovery: previous?.operation === operation
        ? `Retry the exact transition with --replacement ${String(previous.replacement)}, --reason ${shellQuoteArgument(previous.reason)}, and --date ${String(previous.date)}; no state was changed.`
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

function mutationRecord(req: StateWriteRequest, current: JsonObject | undefined, entities: TodoEntityView[] = []): JsonObject {
  if (req.artifact === "docs") return structuredClone(req.input ?? {}) as JsonObject;
  if (current && ["set-severity", "supersede", "resolve", "reopen"].includes(req.spec.verb)) return transitionRecord(req, current, entities);
  const payload = todoPayload(req);
  if (req.spec.verb === "create") return { ...structuredClone(payload), status: "open", ...(payload.readiness !== undefined ? { readiness: readinessRecord(payload.readiness) } : {}) } as JsonObject;
  return applyTodoPatch(current ?? {}, payload);
}

function assertTodoReferences(id: string, record: JsonObject, entities: TodoEntityView[]): void {
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

function reconcileTodoRecords(
  entities: DiscoveredEntity[],
  rows: Map<string, ManagedRow>,
  activating: boolean,
): { records: Map<string, JsonObject>; visible: Set<string> } {
  const records = new Map<string, JsonObject>();
  const visible = new Set<string>();
  for (const entity of entities.filter(({ boundary }) => boundary === TODO.boundary)) {
    const id = entity.id!; const current = entity.record!; const row = rows.get(id); const prior = baseline(current);
    if (!prior) {
      if (activating) {
        records.set(id, row ? importMarkdown(current, row) : current);
        if (row || current.status === "open") visible.add(id);
        continue;
      }
      reject({
        class: "conflict",
        message: `TODO '${id}' has no stable reconciliation baseline`,
        recovery: `Restore TODO '${id}' with its last committed reconciliation baseline, or restore the pre-activation state and remove the activation marker, then retry once; no state was changed.`,
      });
    }
    if (!row) {
      if (prior.present && prior.status === "open") reject({
        class: "conflict",
        message: `unchecked TODO '${id}' was removed from TODO.md`,
        recovery: `Restore the unchecked managed row '${id}' or check it resolved before removing it, then retry once; no state was changed.`,
      });
      records.set(id, current); continue;
    }
    const markdown = rowSnapshot(row, current); const entityPublic = publicSnapshot(current, prior.order);
    const markdownFields = changedPublicFields(markdown, prior, true);
    const entityFields = changedPublicFields(entityPublic, prior, false);
    const conflictingFields = markdownFields.filter((field) =>
      entityFields.includes(field)
      && markdown[field as keyof TodoPublicSnapshot] !== entityPublic[field as keyof TodoPublicSnapshot]);
    if (conflictingFields.length) reject({
      class: "conflict",
      message: `TODO.md and Agentera changed public fields divergently for TODO '${id}': ${conflictingFields.join(", ")}`,
      recovery: `Choose one value for each divergent public field of '${id}', make both sides agree, then retry once; no state was changed.`,
    });
    let merged = current;
    if (markdownFields.some((field) => PUBLIC_FIELDS.includes(field as typeof PUBLIC_FIELDS[number]))) {
      const imported = importMarkdown(current, row);
      merged = structuredClone(current);
      if (markdownFields.includes("description")) {
        for (const field of ["description", "kind", "target_version", "title"]) {
          if (imported[field] === undefined) delete merged[field];
          else merged[field] = structuredClone(imported[field]);
        }
      }
      if (markdownFields.includes("severity")) merged.severity = imported.severity;
      if (markdownFields.includes("status")) merged.status = imported.status;
    }
    records.set(id, merged); visible.add(id);
  }
  for (const id of rows.keys()) if (!records.has(id)) reject({ class: "conflict", message: `TODO.md managed ID '${id}' has no canonical entity`, recovery: `Restore the canonical TODO entity for '${id}' or remove the orphaned managed ID, then retry once; no state was changed.` });
  return { records, visible };
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
    const todoBinding = artifact === "todo" ? todoReconciliationBinding(req.projectRoot, sourceRoot) : null;
    const correctingOwners = artifact === "todo" && req.spec.verb === "correct-owners";
    const ownerEvidence = correctingOwners ? normalizeTodoOwnerCorrectionEvidence(req.input ?? {}) : null;
    const batch = artifact === "todo" && req.spec.verb === "update" ? parseTodoUpdateBatch(req.input as JsonObject | null) : null; const createBatch = artifact === "todo" && req.spec.verb === "create" ? parseTodoCreateBatch(req.input as JsonObject | null) : null; const transitionBatch = artifact === "todo" ? parseTodoTransitionBatch(req.input as JsonObject | null, req.spec.verb) : null;
    const pending = todoBinding ? inspectTodoReconciliation(pinnedRoot, todoBinding) : [];
    if (artifact === "todo") assertTodoSeverityHeadingStructure(readTodoMarkdown(todoPublicPath(pinnedRoot, sourceRoot)).text);
    const initialActivation = artifact === "todo" ? loadTodoReconciliationActivation(pinnedRoot) : null;
    if (artifact === "todo" && ["activate", "repair", "correct-owners"].includes(req.spec.verb)) {
      const repairing = req.spec.verb === "repair";
      const previewCommand = correctingOwners ? TODO_OWNER_CORRECTION_PREVIEW_COMMAND : repairing ? TODO_REPAIR_PREVIEW_COMMAND : TODO_ACTIVATION_PREVIEW_COMMAND;
      const applyCommand = correctingOwners ? TODO_OWNER_CORRECTION_APPLY_COMMAND : repairing ? TODO_REPAIR_APPLY_COMMAND : TODO_ACTIVATION_APPLY_COMMAND;
      if (repairing && !initialActivation) reject({ class: "conflict", message: "TODO repair requires an existing reconciliation activation marker", recovery: `Use '${TODO_ACTIVATION_PREVIEW_COMMAND}' for an inactive project; no state was changed.` });
      if (req.dryRun && (req.values.confirmed === true || req.values.effect_sha256 !== undefined)) reject({ class: "mutually_exclusive", message: `TODO ${req.spec.verb} --dry-run cannot include apply confirmation`, recovery: `Run exactly '${previewCommand}' or the preview's exact apply_command; no state was changed.` });
      if (!req.dryRun && (req.values.confirmed !== true || !SHA256.test(String(req.values.effect_sha256 ?? "")))) reject({ class: "missing_argument", message: `TODO ${req.spec.verb} apply requires the preview effect SHA-256 and explicit --yes confirmation`, syntax: previewCommand, example: applyCommand, recovery: `Run exactly '${previewCommand}', review every reported effect, then run its exact apply_command; no state was changed.` });
    } else if (artifact === "todo" && !initialActivation) inactiveTodoMutation();
    if (req.dryRun && pending.length) reject({ class: "conflict", message: `TODO reconciliation transaction '${pending[0]}' requires recovery before dry-run`, recovery: "Retry the exact TODO mutation without --dry-run once to complete recovery; this dry-run changed no state." });
    const createRequest = artifact === "todo" && req.spec.verb === "create" && !createBatch ? mutationRecord(req, undefined) : null;
    const createRequestSha256 = createRequest ? todoCreateRequestSha256(createRequest) : undefined;
    const recoveryReceipts = todoBinding && !req.dryRun
      ? recoverTodoReconciliation(context, sourceRoot, todoBinding, {
          createRequestSha256,
          ...(["activate", "repair", "correct-owners"].includes(req.spec.verb) ? { activationEffectSha256: String(req.values.effect_sha256) } : {}),
          ...(correctingOwners ? { ownerMappingSha256: ownerEvidence!.sha256 } : {}),
          ...(batch || transitionBatch ? { updateBatch: { effectSha256: String(req.values.effect_sha256 ?? ""), input: req.input as JsonObject } } : {}),
          ...(createBatch ? { createBatch: { effectSha256: String(req.values.effect_sha256 ?? ""), input: req.input as JsonObject } } : {}),
          beforeCommit: () => assertState(pinnedRoot, sourceRoot, sourceBinding),
        })
      : [];
    const recovered = recoveryReceipts.map(({ transaction_id }) => transaction_id);
    assertState(pinnedRoot, sourceRoot, sourceBinding);
    context.assertValid();
    const entities = relevant(pinnedRoot, sourceRoot, artifact, undefined, sourceBinding);
    context.assertValid();
    if (artifact === "todo") {
      const recoveredCreate = recoveryReceipts.find((receipt) => receipt.create);
      if (recoveredCreate?.create) {
        const created = selectedById(entities, "todo", recoveredCreate.create.created_id);
        return { ...envelope("state todo create", { id: created.id!, path: created.path, replay: true }, "todo", created.record!, false), reconciliation: { transaction_id: recoveredCreate.transaction_id, targets: 0, recovered } };
      }
      const recoveredBatch = recoveryReceipts.find((receipt) => receipt.update_batch_effect_sha256);
       if (recoveredBatch?.update_batch_effect_sha256 && (batch || transitionBatch)) { const verb = transitionBatch?.verb ?? "update"; const entries = transitionBatch?.entries ?? batch!; return { schemaVersion: "agentera.stateWrite.v1", command: `state todo ${verb}`, status: "pass", artifact: "todo", records: entries.map(({ id }) => ({ id, record: selectedById(entities, "todo", id).record! })), operation: { verb, dry_run: false, idempotent_replay: true }, validation: { status: "pass", violations: [] }, effect_sha256: recoveredBatch.update_batch_effect_sha256, apply_command: null, reconciliation: { transaction_id: recoveredBatch.transaction_id, targets: recoveredBatch.target_count, recovered } }; }
      const recoveredCreateBatch = recoveryReceipts.find((receipt) => receipt.create_batch); if (recoveredCreateBatch?.create_batch && createBatch) return { schemaVersion: "agentera.stateWrite.v1", command: "state todo create", status: "pass", artifact: "todo", records: Object.entries(recoveredCreateBatch.create_batch.local_refs).map(([local_ref, id]) => ({ local_ref, id, record: selectedById(entities, "todo", id).record! })), local_refs: recoveredCreateBatch.create_batch.local_refs, operation: { verb: "create", dry_run: false, idempotent_replay: true }, validation: { status: "pass", violations: [] }, effect_sha256: recoveredCreateBatch.create_batch.effect_sha256, apply_command: null, reconciliation: { transaction_id: recoveredCreateBatch.transaction_id, targets: recoveredCreateBatch.target_count, recovered } };
      const publicFile = todoPublicPath(pinnedRoot, sourceRoot); const publicRelative = todoBinding!.publicPath;
      const publicExists = fs.existsSync(publicFile);
      const loadedMarkdown = readTodoMarkdown(publicFile); const markdownBefore = loadedMarkdown.bytes; const markdown = loadedMarkdown.text;
      const todoEntities = entities.filter(({ boundary }) => boundary === TODO.boundary);
      const loadedActivation = loadTodoReconciliationActivation(pinnedRoot); const activation = loadedActivation?.record ?? null;
      if (req.spec.verb === "activate") {
        if (activation) {
          const effect = unchangedTodoActivationEffect(publicRelative, markdownBefore, activation.retained_legacy_rows.length, activation.effect_sha256);
          if (!req.dryRun && req.values.effect_sha256 !== effect.effect_sha256) reject({ class: "conflict", message: "TODO activation replay does not match the authorized effect", recovery: `Use the exact apply_command returned by ${activation.effect_sha256 ? "the original activation preview" : "the active no-op preview"}; no state was changed.` });
          return activationEnvelope(effect, req.dryRun, true, null, 0, recovered);
        }
        const scan = managedRows(markdown, null, todoEntities); const rows = scan.rows;
        const safety = inactiveTodoActivationSafety(scan, todoEntities);
        if (!safety.safe) rejectUnsafeInactiveTodoActivation(safety);
        const reconciled = reconcileTodoRecords(todoEntities, rows, true);
        for (const [todoId, record] of reconciled.records) {
          const violations = recordViolations("todo", record, sourceRoot);
          if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations });
          if (record.readiness !== undefined) assertTodoReferences(todoId, record, [...reconciled.records].map(([entityId, entityRecord]) => ({ boundary: TODO.boundary, id: entityId, record: entityRecord })));
        }
        const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId))); const rendered = renderManagedMarkdown(markdown, visibleRecords, rows);
        let activationBytesAfter = todoReconciliationActivationBytes(scan.retainedLegacyRows, "0".repeat(64));
        const activationAfter = JSON.parse(activationBytesAfter) as TodoReconciliationActivation; const finalRows = managedRows(rendered, activationAfter, todoEntities).rows;
        for (const [todoId, record] of reconciled.records) {
          const row = finalRows.get(todoId); reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
        }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) }));
        targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter }); targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
        const resurrectedIds = safety.resurrectedIds;
        const preliminaryEffect = todoActivationEffect(scan, targets, publicRelative, markdownBefore, rendered, resurrectedIds); activationBytesAfter = todoReconciliationActivationBytes(scan.retainedLegacyRows, String(preliminaryEffect.effect_sha256));
        targets.find((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH)!.after = activationBytesAfter; const effect = todoActivationEffect(scan, targets, publicRelative, markdownBefore, rendered, resurrectedIds);
        if (effect.effect_sha256 !== preliminaryEffect.effect_sha256) throw new Error("TODO activation effect authorization is not self-consistent");
        if (req.dryRun) return activationEnvelope(effect, true, false, null, (effect.targets as unknown[]).length, recovered);
        if (req.values.effect_sha256 !== effect.effect_sha256) reject({ class: "conflict", message: "TODO activation effects changed after preview", syntax: TODO_ACTIVATION_PREVIEW_COMMAND, example: TODO_ACTIVATION_APPLY_COMMAND, recovery: `Rerun exactly '${TODO_ACTIVATION_PREVIEW_COMMAND}', review the changed bounded effects, then run its new exact apply_command; no state was changed.` });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          activationEffectSha256: String(effect.effect_sha256),
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({ class: "conflict", message: "TODO reconciliation mapping changed during activation publication", recovery: "Preserve the changed docs mapping and retry activation after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid(); return activationEnvelope(effect, false, false, transaction.id, transaction.targetCount, recovered);
      }
      if (req.spec.verb === "correct-owners") { if (activation) {
        if (!req.dryRun && activation.effect_operation === "correct-owners" && activation.effect_sha256 === req.values.effect_sha256 && activation.owner_mapping_sha256 === ownerEvidence!.sha256) {
          const replayEffect = todoOwnerCorrectionEffect({ counts: { matched: 0, converted: 0, retained: 0, duplicate: 0, stale: 0, conflicting: 0 }, items: [], omitted_count: 0 }, ownerEvidence!.sha256, [], publicRelative, markdownBefore, markdown); replayEffect.effect_sha256 = activation.effect_sha256!; return ownerCorrectionEnvelope(replayEffect, false, true, null, 0, recovered);
        }
        reject({ class: "conflict", message: "TODO owner correction requires marker-absent unsafe-inactive state", recovery: "Use state todo repair only for an unsafe active reconciliation, or retry the exact owner-correction apply command when its stored effect and owner mapping match; no state was changed." });
      }
        let unsafe = true; try { unsafe = !inactiveTodoActivationSafety(managedRows(markdown, null, todoEntities), todoEntities).safe; } catch { unsafe = true; }
        if (!unsafe) reject({ class: "conflict", message: "TODO owner correction requires marker-absent unsafe-inactive state", recovery: `Use '${TODO_ACTIVATION_PREVIEW_COMMAND}' for a safe inactive project; no state was changed.` }); const plan = planTodoOwnerCorrection(markdown, todoEntities, ownerEvidence!);
        for (const [todoId, record] of plan.records) { const violations = recordViolations("todo", record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations }); if (record.readiness !== undefined) assertTodoReferences(todoId, record, [...plan.records].map(([entityId, entityRecord]) => ({ boundary: TODO.boundary, id: entityId, record: entityRecord }))); }
        let activationBytesAfter = todoReconciliationActivationBytes([], "0".repeat(64), "correct-owners", ownerEvidence!.sha256); const activationAfter = JSON.parse(activationBytesAfter) as TodoReconciliationActivation; const finalRows = managedRows(plan.rendered, activationAfter, todoEntities).rows;
        for (const [todoId, record] of plan.records) { const row = finalRows.get(todoId); plan.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false })); }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: plan.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) })); targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter }); targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: plan.rendered });
        const preliminaryEffect = todoOwnerCorrectionEffect(plan.diagnosis, ownerEvidence!.sha256, targets, publicRelative, markdownBefore, plan.rendered); activationBytesAfter = todoReconciliationActivationBytes([], String(preliminaryEffect.effect_sha256), "correct-owners", ownerEvidence!.sha256); targets.find((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH)!.after = activationBytesAfter;
        const effect = todoOwnerCorrectionEffect(plan.diagnosis, ownerEvidence!.sha256, targets, publicRelative, markdownBefore, plan.rendered); if (effect.effect_sha256 !== preliminaryEffect.effect_sha256) throw new Error("TODO owner correction effect authorization is not self-consistent");
        if (req.dryRun) return ownerCorrectionEnvelope(effect, true, false, null, (effect.targets as unknown[]).length, recovered); if (req.values.effect_sha256 !== effect.effect_sha256) reject({ class: "conflict", message: "TODO owner correction effects changed after preview", syntax: TODO_OWNER_CORRECTION_PREVIEW_COMMAND, example: TODO_OWNER_CORRECTION_APPLY_COMMAND, recovery: `Rerun exactly '${TODO_OWNER_CORRECTION_PREVIEW_COMMAND}', review the changed bounded effects, then run its new exact apply_command; no state was changed.` });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, { activationEffectSha256: String(effect.effect_sha256), ownerMappingSha256: ownerEvidence!.sha256, interruptAfterTarget: options.interruptAfterTarget, beforeCommit: () => { assertState(pinnedRoot, sourceRoot, sourceBinding); const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot); if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({ class: "conflict", message: "TODO reconciliation mapping changed during owner correction publication", recovery: "Preserve the changed docs mapping and retry owner correction after every transaction target is restored; no mapping bytes were overwritten." }); } });
        context.assertValid(); return ownerCorrectionEnvelope(effect, false, false, transaction.id, transaction.targetCount, recovered);
      }
      if (req.spec.verb === "repair") {
        if (!activation || !loadedActivation) throw new Error("TODO repair lost its required activation marker");
        const plan = planTodoRepair(markdown, activation, todoEntities);
        let activationBytesAfter = todoReconciliationActivationBytes(plan.retainedLegacyRows, "0".repeat(64), "repair");
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: plan.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) }));
        targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: loadedActivation.bytes, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: plan.rendered });
        const substantiveChange = targets.some((target) => target.path !== TODO_RECONCILIATION_ACTIVATION_PATH && (target.before === null || !target.before.equals(Buffer.from(target.after))));
        if (!req.dryRun && !substantiveChange && activation.effect_operation === "repair" && req.values.effect_sha256 === activation.effect_sha256) {
          const replayEffect = todoRepairEffect(plan.diagnosis, [], publicRelative, markdownBefore, markdown,);
          replayEffect.effect_sha256 = activation.effect_sha256!;
          return repairEnvelope(replayEffect, false, true, null, 0, recovered);
        }
        const preliminaryEffect = todoRepairEffect(plan.diagnosis, targets, publicRelative, markdownBefore, plan.rendered);
        activationBytesAfter = todoReconciliationActivationBytes(plan.retainedLegacyRows, String(preliminaryEffect.effect_sha256), "repair");
        targets.find((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH)!.after = activationBytesAfter;
        const effect = todoRepairEffect(plan.diagnosis, targets, publicRelative, markdownBefore, plan.rendered);
        if (effect.effect_sha256 !== preliminaryEffect.effect_sha256) throw new Error("TODO repair effect authorization is not self-consistent");
        if (req.dryRun) return repairEnvelope(effect, true, false, null, (effect.targets as unknown[]).length, recovered);
        if (req.values.effect_sha256 !== effect.effect_sha256) reject({ class: "conflict", message: "TODO repair effects changed after preview", syntax: TODO_REPAIR_PREVIEW_COMMAND, example: TODO_REPAIR_APPLY_COMMAND, recovery: `Rerun exactly '${TODO_REPAIR_PREVIEW_COMMAND}', review the changed bounded effects, then run its new exact apply_command; no state was changed.` });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          activationEffectSha256: String(effect.effect_sha256),
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({ class: "conflict", message: "TODO reconciliation mapping changed during repair publication", recovery: "Preserve the changed docs mapping and retry repair after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid(); return repairEnvelope(effect, false, false, transaction.id, transaction.targetCount, recovered);
      }
      const activating = activation === null; const scan = managedRows(markdown, activation, todoEntities); const rows = scan.rows; const reconciled = reconcileTodoRecords(todoEntities, rows, activating);
      if (createBatch) { if (!req.dryRun && (!req.values.confirmed || !SHA256.test(String(req.values.effect_sha256 ?? "")))) reject({ class: "invalid_request", message: "todo create batch apply requires its preview effect SHA-256 and --yes", recovery: "Run the same batch input with --dry-run, review it, then repeat that input with the returned --effect-sha256 value and --yes; no state was changed." });
        const inputSha256 = createHash("sha256").update(canonicalRecordJson(req.input as JsonObject)).digest("hex"); const prior = todoEntities.filter(({ record }) => mapping(record?.reconciliation) && mapping(record.reconciliation.create_batch) && record.reconciliation.create_batch.input_sha256 === inputSha256); if (prior.length) { const createReceipt = (prior[0]!.record!.reconciliation as JsonObject).create_batch as JsonObject; const localRefs = createReceipt.local_refs as Record<string, string>; if (prior.length !== createBatch.length || prior.some(({ id, record }) => canonicalRecordJson((record!.reconciliation as JsonObject).create_batch) !== canonicalRecordJson(createReceipt) || !Object.values(localRefs).includes(id!)) || req.values.effect_sha256 !== createReceipt.effect_sha256) reject({ class: "conflict", message: "existing TODO create batch receipt is incomplete or does not match this effect authorization", recovery: "Restore the complete original create batch result or use its exact input and effect SHA-256; no state was changed." }); return { schemaVersion: "agentera.stateWrite.v1", command: "state todo create", status: "pass", artifact: "todo", records: createBatch.map(({ local_ref }) => { const id = localRefs[local_ref]!; return { local_ref, id, record: selectedById(todoEntities, "todo", id).record! }; }), local_refs: localRefs, operation: { verb: "create", dry_run: false, idempotent_replay: true }, validation: { status: "pass", violations: [] }, effect_sha256: createReceipt.effect_sha256, apply_command: null, reconciliation: { transaction_id: null, targets: 0, recovered } }; } const allocated = new Set<string>(); const localIds = new Map<string, string>(); for (const { local_ref } of createBatch) { let salt = 0; let id: string; do { const digest = createHash("sha256").update(inputSha256).update("\0").update(local_ref).update("\0").update(String(salt++)).digest(); id = Array.from(digest.subarray(0, 10), (byte) => String.fromCharCode(97 + byte % 26)).join(""); try { id = allocateEntityId(context.pinnedPath(), () => id, sourceRoot); } catch (error) { if (!String((error as Error).message).includes("could not allocate")) throw error; continue; } } while (allocated.has(id)); allocated.add(id); localIds.set(local_ref, id); } const resolved = resolveTodoCreateBatchRecords(createBatch, localIds); for (const { local_ref, record } of resolved) { const id = localIds.get(local_ref)!; reconciled.records.set(id, mutationRecord({ ...req, input: record, values: {}, callerPayload: record }, undefined)); reconciled.visible.add(id); } const referenceEntities: TodoEntityView[] = [...reconciled.records].map(([todoId, record]) => ({ boundary: TODO.boundary, id: todoId, record })); for (const [todoId, record] of reconciled.records) { const violations = recordViolations("todo", record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations, recovery: "Correct the batch record and preview the complete batch again; no state was changed." }); if (record.readiness !== undefined) assertTodoReferences(todoId, record, referenceEntities); }
        const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId))); const rendered = renderManagedMarkdown(markdown, visibleRecords, rows); const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows); const activationAfter = activation ?? JSON.parse(activationBytesAfter) as TodoReconciliationActivation; const finalRows = managedRows(rendered, activationAfter, [...todoEntities, ...[...localIds.values()].map((id) => ({ boundary: TODO.boundary, id, record: reconciled.records.get(id)! } as DiscoveredEntity))]).rows; for (const [todoId, record] of reconciled.records) { const row = finalRows.get(todoId); reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false })); } const localRefs = Object.fromEntries(localIds); const existingTargets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) })); const newTargets: TodoReconciliationTarget[] = [...localIds.values()].map((id) => ({ path: relative(req.projectRoot, targetPath(req.projectRoot, sourceRoot, "todo", id)), before: null, after: "" })); const targets = [...existingTargets, ...newTargets]; if (activating) targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter }); targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered }); const ordered = targets.filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after))).sort((left, right) => Number(left.path === TODO_RECONCILIATION_ACTIVATION_PATH) - Number(right.path === TODO_RECONCILIATION_ACTIVATION_PATH) || Number(left.path === publicRelative) - Number(right.path === publicRelative) || left.path.localeCompare(right.path)); let effectSha256 = todoCreateBatchEffectSha256(req.input as JsonObject, todoBinding!.mappingSha256, localRefs, ordered.filter((target) => !newTargets.includes(target)).map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") }))); const batchReceipt = { effect_sha256: effectSha256, input_sha256: inputSha256, local_refs: localRefs }; for (const [localRef, id] of localIds) { const record = reconciled.records.get(id)!; record.reconciliation = { ...(record.reconciliation as JsonObject), create_batch: batchReceipt }; newTargets.find((target) => target.path.endsWith(`/${id}.yaml`))!.after = canonicalEntityEnvelopeBytes({ id, artifact: "todo", record }); }
        effectSha256 = todoCreateBatchEffectSha256(req.input as JsonObject, todoBinding!.mappingSha256, localRefs, ordered.filter((target) => !newTargets.includes(target)).map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") }))); batchReceipt.effect_sha256 = effectSha256; for (const [, id] of localIds) { const record = reconciled.records.get(id)!; (record.reconciliation as JsonObject).create_batch = batchReceipt; newTargets.find((target) => target.path.endsWith(`/${id}.yaml`))!.after = canonicalEntityEnvelopeBytes({ id, artifact: "todo", record }); } const response = { schemaVersion: "agentera.stateWrite.v1", command: "state todo create", status: "pass", artifact: "todo", records: createBatch.map(({ local_ref }) => ({ local_ref, id: localIds.get(local_ref)!, record: reconciled.records.get(localIds.get(local_ref)!)! })), local_refs: localRefs, operation: { verb: "create", dry_run: req.dryRun, idempotent_replay: false }, validation: { status: "pass", violations: [] }, effect_sha256: effectSha256, apply_command: req.dryRun ? `agentera state todo create --input <same-input> --effect-sha256 ${effectSha256} --yes --format json` : null } as StateWriteEnvelope; if (req.dryRun) return { ...response, reconciliation: { transaction_id: null, targets: targets.length, recovered } }; if (req.values.effect_sha256 !== effectSha256) reject({ class: "conflict", message: "TODO create batch effects changed after preview", recovery: "Rerun the same batch input with --dry-run, review the new bounded effect, then use its exact effect SHA-256; no state was changed." }); const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, { createBatch: batchReceipt, interruptAfterTarget: options.interruptAfterTarget, beforeCommit: () => { assertState(pinnedRoot, sourceRoot, sourceBinding); const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot); if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({ class: "conflict", message: "TODO reconciliation mapping changed during create batch publication", recovery: "Preserve the changed docs mapping and retry after every transaction target is restored; no mapping bytes were overwritten." }); } }); context.assertValid(); return { ...response, reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
      } if (transitionBatch) { const verb = transitionBatch.verb;
        if (!req.dryRun && (!req.values.confirmed || !SHA256.test(String(req.values.effect_sha256 ?? "")))) reject({ class: "invalid_request", message: `todo ${verb} batch apply requires its preview effect SHA-256 and --yes`, recovery: "Run the same batch input with --dry-run, review it, then repeat that input with the returned --effect-sha256 value and --yes; no state was changed." });
        const inputSha256 = createHash("sha256").update(canonicalRecordJson(req.input as JsonObject)).digest("hex"); const priorReceipts = transitionBatch.entries.map(({ id }) => mapping(reconciled.records.get(id)?.reconciliation) ? (reconciled.records.get(id)!.reconciliation as JsonObject).transition_batch : null); if (priorReceipts.every((receipt) => mapping(receipt) && receipt.input_sha256 === inputSha256 && receipt.verb === verb && receipt.effect_sha256 === req.values.effect_sha256)) return { schemaVersion: "agentera.stateWrite.v1", command: `state todo ${verb}`, status: "pass", artifact: "todo", records: transitionBatch.entries.map(({ id }) => ({ id, record: reconciled.records.get(id)! })), operation: { verb, dry_run: false, idempotent_replay: true }, validation: { status: "pass", violations: [] }, effect_sha256: req.values.effect_sha256, apply_command: null, reconciliation: { transaction_id: null, targets: 0, recovered } };
        const requestedRecords: Array<{ id: string; record: JsonObject }> = []; for (const entry of transitionBatch.entries) { selectedById(todoEntities, "todo", entry.id); const values = { id: entry.id, ...(entry.severity ? { severity: entry.severity } : {}), lifecycle: { reason: entry.reason, date: entry.date } }; const record = transitionRecord({ ...req, input: null, values, callerPayload: values }, reconciled.records.get(entry.id)!, todoEntities.map((entity) => ({ ...entity, record: reconciled.records.get(entity.id!)! }))); reconciled.records.set(entry.id, record); requestedRecords.push({ id: entry.id, record }); }
        for (const [todoId, record] of reconciled.records) { const violations = recordViolations("todo", record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: `todo ${verb} batch input is invalid`, violations, recovery: "Correct the complete batch and preview it again; no state was changed." }); } const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId))); const rendered = renderManagedMarkdown(markdown, visibleRecords, rows); const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows); const activationAfter = activation ?? JSON.parse(activationBytesAfter) as TodoReconciliationActivation; const finalRows = managedRows(rendered, activationAfter, todoEntities).rows; for (const [todoId, record] of reconciled.records) { const row = finalRows.get(todoId); reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false })); } const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) })); targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered }); const effectTargets = targets.filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after))).sort((left, right) => Number(left.path === publicRelative) - Number(right.path === publicRelative) || left.path.localeCompare(right.path)); const effectSha256 = todoUpdateBatchEffectSha256(req.input as JsonObject, todoBinding!.mappingSha256, effectTargets.map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") })));
        const response = { schemaVersion: "agentera.stateWrite.v1", command: `state todo ${verb}`, status: "pass", artifact: "todo", records: requestedRecords.map(({ id }) => ({ id, record: reconciled.records.get(id)! })), operation: { verb, dry_run: req.dryRun, idempotent_replay: false }, validation: { status: "pass", violations: [] }, effect_sha256: effectSha256, apply_command: req.dryRun ? `agentera state todo ${verb} --input <same-input> --effect-sha256 ${effectSha256} --yes --format json` : null } as StateWriteEnvelope; if (req.dryRun) return { ...response, reconciliation: { transaction_id: null, targets: targets.length, recovered } }; if (req.values.effect_sha256 !== effectSha256) reject({ class: "conflict", message: `TODO ${verb} batch effects changed after preview`, recovery: "Rerun the same batch input with --dry-run, review the new bounded effect, then use its exact effect SHA-256; no state was changed." }); for (const { id } of transitionBatch.entries) { const record = reconciled.records.get(id)!; record.reconciliation = { ...(record.reconciliation as JsonObject), transition_batch: { verb, input_sha256: inputSha256, effect_sha256: effectSha256 } }; const target = targets.find(({ path }) => path.endsWith(`/${id}.yaml`))!; target.after = canonicalEntityEnvelopeBytes({ id, artifact: "todo", record }); } const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, { updateBatchEffectSha256: effectSha256, interruptAfterTarget: options.interruptAfterTarget, beforeCommit: () => { assertState(pinnedRoot, sourceRoot, sourceBinding); const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot); if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({ class: "conflict", message: `TODO reconciliation mapping changed during ${verb} batch publication`, recovery: "Preserve the changed docs mapping and retry after every transaction target is restored; no mapping bytes were overwritten." }); } }); context.assertValid(); return { ...response, records: transitionBatch.entries.map(({ id }) => ({ id, record: reconciled.records.get(id)! })), reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
      } if (batch) { if (!req.dryRun && (!req.values.confirmed || !SHA256.test(String(req.values.effect_sha256 ?? "")))) reject({ class: "invalid_request", message: "todo update batch apply requires its preview effect SHA-256 and --yes", recovery: "Run the same batch input with --dry-run, review it, then repeat that input with the returned --effect-sha256 value and --yes; no state was changed." }); const requestedRecords: Array<{ id: string; record: JsonObject }> = [];
        for (const { id, patch } of batch) { selectedById(todoEntities, "todo", id); const record = mutationRecord({ ...req, input: patch, values: { id }, callerPayload: patch }, reconciled.records.get(id)!, todoEntities.map((entity) => ({ ...entity, record: reconciled.records.get(entity.id!)! }))); reconciled.records.set(id, record); requestedRecords.push({ id, record }); } const referenceEntities: TodoEntityView[] = [...reconciled.records].map(([todoId, record]) => ({ boundary: TODO.boundary, id: todoId, record })); for (const [todoId, record] of reconciled.records) { const violations = recordViolations("todo", record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations, recovery: "Correct the batch patch and preview the complete batch again; no state was changed." }); if (record.readiness !== undefined) assertTodoReferences(todoId, record, referenceEntities); } const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId)));
        const rendered = renderManagedMarkdown(markdown, visibleRecords, rows); const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows); const activationAfter = activation ?? JSON.parse(activationBytesAfter) as TodoReconciliationActivation; const finalRows = managedRows(rendered, activationAfter, todoEntities).rows; for (const [todoId, record] of reconciled.records) { const row = finalRows.get(todoId); reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false })); }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) }));
        if (activating) targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
        const effectTargets = targets.filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after))).sort((left, right) => Number(left.path === publicRelative) - Number(right.path === publicRelative) || left.path.localeCompare(right.path));
        const effectSha256 = todoUpdateBatchEffectSha256(req.input as JsonObject, todoBinding!.mappingSha256, effectTargets.map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") })));
        const applyCommand = `agentera state todo update --input <same-input> --effect-sha256 ${effectSha256} --yes --format json`; const response = { schemaVersion: "agentera.stateWrite.v1", command: "state todo update", status: "pass", artifact: "todo", records: requestedRecords.map(({ id }) => ({ id, record: reconciled.records.get(id)! })), operation: { verb: "update", dry_run: req.dryRun, idempotent_replay: false }, validation: { status: "pass", violations: [] }, effect_sha256: effectSha256, apply_command: req.dryRun ? applyCommand : null } as StateWriteEnvelope;
        if (req.dryRun) return { ...response, reconciliation: { transaction_id: null, targets: targets.length, recovered } };
        if (req.values.effect_sha256 !== effectSha256) reject({ class: "conflict", message: "TODO update batch effects changed after preview", recovery: "Rerun the same batch input with --dry-run, review the new bounded effect, then use its exact effect SHA-256; no state was changed." });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, { updateBatchEffectSha256: effectSha256, interruptAfterTarget: options.interruptAfterTarget, beforeCommit: () => { assertState(pinnedRoot, sourceRoot, sourceBinding); const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot); if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({ class: "conflict", message: "TODO reconciliation mapping changed during batch publication", recovery: "Preserve the changed docs mapping and retry after every transaction target is restored; no mapping bytes were overwritten." }); } }); context.assertValid(); return { ...response, reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
      }
      let id: string; let requested: JsonObject; let selected: DiscoveredEntity | undefined;
      if (req.spec.verb === "create") {
        if (req.input) {
          const inputViolations = todoInputViolations(req.input as JsonObject, "create");
          if (inputViolations.length) reject({ class: "schema_violation", message: "todo create input is invalid", violations: inputViolations, recovery: todoReadinessRecovery(req.spec.verb) });
        }
        id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot);
        requested = createRequest!;
        reconciled.records.set(id, requested); reconciled.visible.add(id);
      } else {
        id = String(req.values.id ?? "");
        if (!ID.test(id)) reject({ class: "invalid_request", message: `todo ID '${id}' must be ten lowercase letters`, recovery: "Use a bare todo ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid." });
        selected = selectedById(todoEntities, "todo", id);
        if (req.input && req.spec.verb === "update") {
          const inputViolations = todoInputViolations(req.input as JsonObject, "update");
          if (inputViolations.length) reject({ class: "schema_violation", message: "todo update input is invalid", violations: inputViolations, recovery: todoReadinessRecovery(req.spec.verb) });
        }
        requested = mutationRecord(req, reconciled.records.get(id)!, todoEntities.map((entity) => ({ ...entity, record: reconciled.records.get(entity.id!)! })));
        reconciled.records.set(id, requested);
        if (requested.status === "open" || rows.has(id)) reconciled.visible.add(id);
      }
      const referenceEntities: TodoEntityView[] = [...reconciled.records].map(([todoId, record]) => ({ boundary: TODO.boundary, id: todoId, record }));
      for (const [todoId, record] of reconciled.records) {
        const violations = recordViolations("todo", record, sourceRoot);
        if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations, ...(record.readiness !== undefined ? { recovery: todoReadinessRecovery(req.spec.verb) } : {}) });
        if (record.readiness !== undefined) assertTodoReferences(todoId, record, referenceEntities);
      }
      const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId)));
      const rendered = renderManagedMarkdown(markdown, visibleRecords, rows);
      const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows);
      const activationAfter = activation ?? JSON.parse(activationBytesAfter) as TodoReconciliationActivation;
      const finalRows = managedRows(rendered, activationAfter, todoEntities).rows;
      for (const [todoId, record] of reconciled.records) {
        const row = finalRows.get(todoId);
        reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
      }
      requested = reconciled.records.get(id)!;
      const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({ path: entity.relativePath, before: exactDiscoveredEntityBytes(entity), after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }) }));
      if (!selected) targets.push({ path: relative(req.projectRoot, targetPath(req.projectRoot, sourceRoot, "todo", id)), before: null, after: canonicalEntityEnvelopeBytes({ id, artifact: "todo", record: requested }) });
      if (activating) targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter });
      targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
      const changed = targets.some((target) => target.before === null || !target.before.equals(Buffer.from(target.after)));
      if (req.dryRun) return { ...envelope(`state todo ${req.spec.verb}`, { id, path: targetPath(req.projectRoot, sourceRoot, "todo", id), replay: !changed }, "todo", requested, true), reconciliation: { transaction_id: null, targets: targets.length, recovered } };
      const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
        ...(req.spec.verb === "create" ? { create: { created_id: id, request_sha256: createRequestSha256! } } : {}),
        interruptAfterTarget: options.interruptAfterTarget,
        beforeCommit: () => {
          assertState(pinnedRoot, sourceRoot, sourceBinding);
          const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
          if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256) reject({
            class: "conflict",
            message: "TODO reconciliation mapping changed during transaction publication",
            recovery: "Preserve the changed docs mapping and retry the exact TODO mutation after every transaction target is restored; no mapping bytes were overwritten.",
          });
          const currentActivation = fs.existsSync(path.join(pinnedRoot, TODO_RECONCILIATION_ACTIVATION_PATH))
            ? fs.readFileSync(path.join(pinnedRoot, TODO_RECONCILIATION_ACTIVATION_PATH))
            : null;
          if (!currentActivation?.equals(Buffer.from(activationBytesAfter))) reject({
            class: "conflict",
            message: "TODO reconciliation activation changed during transaction publication",
            recovery: `Preserve '${TODO_RECONCILIATION_ACTIVATION_PATH}' and retry the exact TODO mutation after every transaction target is restored; no competing activation bytes were overwritten.`,
          });
        },
      });
      context.assertValid();
      return { ...envelope(`state todo ${req.spec.verb}`, { id, path: targetPath(req.projectRoot, sourceRoot, "todo", id), replay: !changed && recovered.length === 0 }, "todo", requested, false), reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
    }
    if (req.spec.verb === "create") {
      const record = mutationRecord(req, undefined, entities); const violations = recordViolations("docs", record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: "docs entity input is invalid", violations });
      const id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot); if (req.dryRun) return envelope("state docs create", { id, path: targetPath(req.projectRoot, sourceRoot, "docs", id), replay: false }, "docs", record, true);
      let published: { path: string; publishedIdentity?: PublishedTargetIdentity } | undefined;
      try { const result = publishEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact: "docs", boundary: DOCS.boundary, id, record }); published = result; assertState(pinnedRoot, sourceRoot, sourceBinding); context.assertValid(); return envelope("state docs create", result, "docs", record, false); }
      catch (error) { if (published?.publishedIdentity) context.removeExact(relative(req.projectRoot, published.path), published.publishedIdentity, false); throw error; }
    }
    const id = String(req.values.id ?? "");
    if (!ID.test(id)) reject({ class: "invalid_request", message: `${artifact} ID '${id}' must be ten lowercase letters`, recovery: `Use a bare ${artifact} ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid.` });
    const entity = selectedById(entities, artifact, id);
    const record = mutationRecord(req, entity.record!, entities); const violations = recordViolations("docs", record, sourceRoot); if (violations.length) reject({ class: "schema_violation", message: "docs entity input is invalid", violations });
    if (canonicalRecordJson(record) === canonicalRecordJson(entity.record)) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: true }, artifact, record, req.dryRun);
    if (req.dryRun) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: false }, artifact, record, true);
    const request = { projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact, boundary: definition(artifact).boundary, id, expectedRecord: entity.record!, expectedBytes: exactDiscoveredEntityBytes(entity), migrationProvenance: entity.migrationProvenance, record };
    let replacement: { path: string; publishedIdentity?: PublishedTargetIdentity; previousBytes?: string } | undefined;
    try { const result = replaceEntityUnderLock(request); replacement = result; assertState(pinnedRoot, sourceRoot, sourceBinding); context.assertValid(); return envelope(`state ${artifact} ${req.spec.verb}`, result, artifact, record, false); }
    catch (error) { if (replacement?.publishedIdentity && replacement.previousBytes !== undefined) context.restoreExact(relative(req.projectRoot, replacement.path), replacement.publishedIdentity, replacement.previousBytes, entityExactGetMaxBytes(sourceRoot)); throw error; }
  });
}

function entry(
  root: string,
  entity: DiscoveredEntity,
  row?: ManagedRow,
  queueRank?: number,
  actionability?: TodoReadinessEvaluation,
  reconciliation?: JsonObject,
): JsonObject {
  const todo = entity.boundary === TODO.boundary;
  const itemDrift = todo && reconciliation && Array.isArray(reconciliation.items)
    ? reconciliation.items.find((item) => mapping(item) && item.id === entity.id)
    : undefined;
  return {
    id: entity.id!,
    artifact: entity.artifact!,
    record: todo ? publicReadRecord(entity.record!, row) : entity.record!,
    ...(todo ? { public: publicReadMetadata(entity.record!, row) } : {}),
    ...(todo ? { public_order: row?.snapshot.order ?? null } : {}),
    ...(todo ? { readiness: { state: String(publicReadRecord(entity.record!, row).status), blocked: actionability?.outcome === "blocked" } } : {}),
    ...(todo && actionability ? { actionability: { outcome: actionability.outcome, eligible: actionability.eligible } } : {}),
    ...(todo && queueRank !== undefined ? { queue_rank: queueRank } : {}),
    ...(todo && reconciliation ? { reconciliation: { status: String(reconciliation.status), item_status: mapping(itemDrift) ? String(itemDrift.state) : "clean", drifted: Boolean(itemDrift) } } : {}),
    provenance: { storage: "canonical_entity_file", path: relative(root, entity.path), immutable: false },
  };
}
function todoActionability(entities: DiscoveredEntity[], view: TodoReadView, sourceRoot: string): Map<string, TodoReadinessEvaluation> {
  const projected = view.drift.status !== "inactive";
  const evaluations = evaluateTodoReadinessQueue(entities.map((entity) => {
    const row = view.rows.get(entity.id!);
    return {
      id: entity.id!,
      artifact: entity.artifact!,
      record: publicReadRecord(entity.record!, row),
      ...(projected ? { projectedOrder: row?.snapshot.order === undefined ? { kind: "absent" as const } : { kind: "managed" as const, markdownOrder: row.snapshot.order } } : {}),
    };
  }), sourceRoot).evaluations;
  return new Map(evaluations.map((value) => [value.id, value]));
}
function snapshot(root: string, entities: DiscoveredEntity[], rows?: Map<string, ManagedRow>): string { return createHash("sha256").update(canonicalRecordJson(entities.map((entity) => ({ id: entity.id, boundary: entity.boundary, path: relative(root, entity.path), record: entity.record, ...(entity.id && rows?.has(entity.id) ? { public: rowSnapshot(rows.get(entity.id)!, entity.record!) } : {}) })).sort((a, b) => canonicalRecordJson(a).localeCompare(canonicalRecordJson(b))))).digest("hex"); }
function decodeCursor(token: string, root: string, authorityPath: string, artifact: "todo" | "docs", restart: string): JsonObject { try { return decodeListCursor(token, root, authorityPath); } catch { throw failure("cursor_invalid", artifact, `${artifact} cursor is malformed or belongs to another project`, restart); } }

function sorted(artifact: "todo" | "docs", entities: DiscoveredEntity[], rows?: Map<string, ManagedRow>): DiscoveredEntity[] {
  const selected = entities.filter(({ boundary }) => boundary === definition(artifact).boundary);
  if (artifact === "docs") return selected.sort((a, b) => String(a.record!.path).localeCompare(String(b.record!.path)) || a.id!.localeCompare(b.id!));
  return selected.sort((a, b) => {
    const left = publicReadRecord(a.record!, rows?.get(a.id!)); const right = publicReadRecord(b.record!, rows?.get(b.id!));
    return TODO_SEVERITIES.indexOf(left.severity as typeof TODO_SEVERITIES[number]) - TODO_SEVERITIES.indexOf(right.severity as typeof TODO_SEVERITIES[number])
      || TODO_STATUSES.indexOf(left.status as typeof TODO_STATUSES[number]) - TODO_STATUSES.indexOf(right.status as typeof TODO_STATUSES[number])
      || (rows?.get(a.id!)?.snapshot.order ?? Number.MAX_SAFE_INTEGER) - (rows?.get(b.id!)?.snapshot.order ?? Number.MAX_SAFE_INTEGER)
      || a.id!.localeCompare(b.id!);
  });
}

export function getTodoDocsEntity(root: string, artifact: "todo" | "docs", id: string, sourceRoot = resolveSourceRoot()): JsonObject {
  if (artifact === "todo") assertTodoReconciliationReadable(root, sourceRoot, id);
  const entities = relevant(root, sourceRoot, artifact);
  const entity = selectedById(entities, artifact, id);
  const view = artifact === "todo" ? inspectTodoReadView(root, sourceRoot, entities) : null;
  const actionability = view ? todoActionability(sorted("todo", entities, view.rows), view, sourceRoot).get(id) : undefined;
  return { schemaVersion: "agentera.stateGet.v1", command: `state ${artifact} get`, status: "ok", entry: entry(root, entity, view?.rows.get(id), undefined, actionability, view?.drift), ...(view ? { reconciliation: view.drift } : {}), source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entity" } };
}

export function listTodoDocsEntities(root: string, artifact: "todo" | "docs", limit?: number, cursor?: string, filters: JsonObject = {}, options: { sourceRoot?: string; format?: string; reservedUtf8Bytes?: number; discovery?: EntityDiscoveryResult; selector?: EntityListSelectorInput } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot(); const declared = contract(definition(artifact).boundary, sourceRoot); const take = limit ?? declared.defaultLimit;
  if (artifact === "todo") assertTodoReconciliationReadable(root, sourceRoot);
  if (!Number.isSafeInteger(take) || take < 1 || take > declared.maximumLimit) throw failure("invalid_request", artifact, `${artifact} list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.", undefined, 2);
  const all = relevant(root, sourceRoot, artifact, options.discovery).filter(({ boundary }) => boundary === definition(artifact).boundary);
  const view = artifact === "todo" ? inspectTodoReadView(root, sourceRoot, all) : null;
  let selected = sorted(artifact, all, view?.rows);
  const queueRanks = artifact === "todo" ? new Map(selected.map((entity, index) => [entity.id!, index + 1])) : new Map<string, number>();
  const actionability = artifact === "todo" ? todoActionability(selected, view!, sourceRoot) : new Map<string, TodoReadinessEvaluation>();
  if (artifact === "todo") selected = selected.filter((entity) => { const record = publicReadRecord(entity.record!, view?.rows.get(entity.id!)); return (!filters.severity || record.severity === filters.severity) && (!filters.status || record.status === filters.status); });
  if (artifact === "docs") selected = selected.filter((entity) => (!filters.status || entity.record!.status === filters.status) && (!filters.topic || [entity.record!.document, entity.record!.path, entity.record!.status].some((value) => String(value).toLowerCase().includes(String(filters.topic).toLowerCase()))));
  const format = options.format ?? "json"; const outputBudget = declared.maxUtf8Bytes - (options.reservedUtf8Bytes ?? 0); if (outputBudget < 1024) throw failure("unsupported_state", artifact, `${artifact} singleton metadata leaves no room for a bounded entity view`, "Reduce the authority-owned singleton metadata within its declared artifact budget.");
  const projectionOptions = { family: artifact, artifact, boundary: definition(artifact).boundary, format, maxUtf8Bytes: outputBudget, selector: options.selector };
  const selector = resolveEntityListSelector(options.selector, selected.map((entity) => entry(root, entity, view?.rows.get(entity.id!), queueRanks.get(entity.id!), actionability.get(entity.id!), view?.drift)), projectionOptions); const selectorKey = entityListSelectorKey(selector);
  const filterOrder = artifact === "todo" ? ["severity", "status"] : ["topic", "status"]; const filterFlags = filterOrder.flatMap((name) => filters[name] === undefined ? [] : [` --${name} ${shellQuoteArgument(filters[name])}`]).join(""); const selectorFlags = entityListSelectorFlags(selector); const restart = `agentera state ${artifact} list${filterFlags}${selectorFlags} --limit ${take} --format json`;
  const snap = snapshot(root, all, view?.rows); let start = 0;
  if (cursor) {
    const value = decodeCursor(cursor, root, declared.authorityPath, artifact, restart);
    if (artifact === "todo") {
      if (value.limit === undefined) throw failure("cursor_invalid", artifact, "todo cursor lacks the required effective limit binding", restart);
      if (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > declared.maximumLimit) throw failure("cursor_invalid", artifact, "todo cursor has an invalid effective limit binding", restart);
      if (value.limit !== take) throw failure("cursor_invalid", artifact, `todo cursor is bound to --limit ${value.limit}, not --limit ${take}`, restart);
      if (value.selector !== selectorKey) throw failure("cursor_invalid", artifact, "todo cursor selectors do not match this request", restart);
      if (value.order !== TODO.order) throw failure("cursor_invalid", artifact, "todo cursor order does not match this request", restart);
      if (canonicalRecordJson(value.filters) !== canonicalRecordJson(filters)) throw failure("cursor_invalid", artifact, "todo cursor filters do not match this request", restart);
      if (value.snapshot_id !== snap) throw failure("cursor_snapshot_unavailable", artifact, "todo cursor snapshot is no longer available", restart);
      const found = selected.findIndex(({ id }) => id === value.after);
      if (found < 0) throw failure("cursor_snapshot_unavailable", artifact, "todo cursor continuation identity is no longer available", restart);
      start = found + 1;
    } else {
      if (value.selector !== selectorKey) throw failure("cursor_invalid", artifact, `${artifact} cursor selectors do not match this request`, "Repeat the original selector, or omit --cursor to restart from current state.");
      if (value.snapshot_id !== snap || value.order !== DOCS.order || canonicalRecordJson(value.filters) !== canonicalRecordJson(filters)) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} state or filters changed after this cursor snapshot`, "Repeat the original filters, or omit --cursor to restart from current state.");
      const found = selected.findIndex(({ id }) => id === value.after);
      if (found < 0) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} cursor continuation is unavailable`, "Omit --cursor to restart.");
      start = found + 1;
    }
  }
  const page = selected.slice(start, start + take);
  const response = (): JsonObject => { const remaining = selected.length - start - page.length; const next = remaining && page.length ? encodeListCursor({ snapshot_id: snap, order: definition(artifact).order, filters, selector: selectorKey, after: page.at(-1)!.id!, ...(artifact === "todo" ? { limit: take } : {}) }, root, declared.authorityPath) : undefined; return { schemaVersion: "agentera.stateList.v1", command: `state ${artifact} list`, status: remaining ? "degraded" : "ok", entries: page.map((entity) => entry(root, entity, view?.rows.get(entity.id!), queueRanks.get(entity.id!), actionability.get(entity.id!), view?.drift)), ...(view ? { reconciliation: view.drift } : {}), counts: { total: selected.length, returned: page.length, remaining }, order: definition(artifact).order, filters, snapshot: { id: snap, first_page: !cursor, has_more: Boolean(remaining), candidate_count: selected.length }, source: { artifact, authority: "canonical_entity_files", root: declared.entityRoot }, source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full", cursor: "opaque_snapshot_cursor" }, retrieval: { ...(next ? { continue: `agentera state ${artifact} list${filterFlags}${selectorFlags} --limit ${take} --cursor ${next} --format json` } : {}) }, ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: "page_limit", next_cursor: next } : {}) }; };
  return projectEntityList(response(), selector, projectionOptions);
}
