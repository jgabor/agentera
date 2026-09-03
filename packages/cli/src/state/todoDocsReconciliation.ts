import { createHash } from "node:crypto";
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
  canonicalEntityEnvelopeBytes,
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
import {
  loadTodoReconciliationActivation,
  todoLegacyRowFingerprint,
  todoReconciliationActivationBytes,
  TODO_RECONCILIATION_ACTIVATION_PATH,
  TODO_RECONCILIATION_ITEM_LIMIT,
  TODO_ACTIVATION_APPLY_COMMAND,
  TODO_ACTIVATION_PREVIEW_COMMAND,
  TODO_ACTIVATION_RISK_LIMIT,
  TODO_OWNER_CORRECTION_APPLY_COMMAND,
  TODO_OWNER_CORRECTION_PREVIEW_COMMAND,
  TODO_REPAIR_APPLY_COMMAND,
  TODO_REPAIR_PREVIEW_COMMAND,
  todoActivationEffect,
  todoOwnerCorrectionEffect,
  todoRepairEffect,
  unchangedTodoActivationEffect,
  type TodoReconciliationActivation,
} from "./todoReconciliationActivation.js";
import { normalizeTodoOwnerCorrectionEvidence, planTodoOwnerCorrection, planTodoRepair } from "./todoReconciliationRepair.js";
import { readTodoMarkdown, renderManagedMarkdown } from "./todoMarkdownProjection.js";
import { inactiveTodoActivationSafety, rejectUnsafeInactiveTodoActivation, unsafeInactiveDuplicateDiagnosis } from "./todoActivationSafety.js";
import { assertTodoSeverityHeadingStructure, todoSeveritySectionForHeading } from "./todoSeverityHeadings.js";
import { parseTodoUpdateBatch, todoUpdateBatchEffectSha256 } from "./todoUpdateBatch.js";
import { parseTodoCreateBatch, resolveTodoCreateBatchRecords, todoCreateBatchEffectSha256 } from "./todoCreateBatch.js";
import { matchesTodoTransitionBatchPostState, parseTodoTransitionBatch, todoTransitionBatchPostStateSha256 } from "./todoTransitionBatch.js";
export const ID = /^[a-z]{10}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const TODO = { artifact: "todo", boundary: "todo_item", order: "severity_then_status_then_markdown_order_then_id" } as const;
export const DOCS = { artifact: "docs", boundary: "documentation_inventory_entry", order: "path_then_id" } as const;
export interface Options {
  sourceRoot?: string;
  publicationContext?: EntityPublicationContext;
  candidate?: () => string;
  interruptAfterTarget?: number;
}
export interface Contract {
  authorityPath: string;
  entityRoot: string;
  defaultLimit: number;
  maximumLimit: number;
  maxUtf8Bytes: number;
}
export function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function relative(root: string, file: string): string {
  return path.relative(path.resolve(root), file).split(path.sep).join("/");
}
export function definition(artifact: "todo" | "docs") {
  return artifact === "todo" ? TODO : DOCS;
}
export function contract(boundary: string, sourceRoot = resolveSourceRoot()): Contract {
  const { authorityPath, document: authority } = loadStateStorageAuthority(sourceRoot);
  const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const entity = (Array.isArray(target.entities) ? target.entities : []).find((value) => mapping(value) && value.boundary === boundary);
  const retrieval = mapping(entity) && mapping(entity.retrieval) ? entity.retrieval : {};
  const positive = (value: unknown, name: string): number => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid ${boundary} ${name} authority`);
    return result;
  };
  if (typeof storage.canonical_root !== "string") throw new Error(`invalid entity authority '${authorityPath}'`);
  return { authorityPath, entityRoot: storage.canonical_root, defaultLimit: positive(retrieval.default_limit, "default_limit"), maximumLimit: positive(retrieval.maximum_limit, "maximum_limit"), maxUtf8Bytes: positive(retrieval.max_utf8_bytes, "max_utf8_bytes") };
}
export function failure(kind: StateFailureClass, artifact: string, message: string, recovery: string, id?: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  const family = kind === "cursor_invalid" || kind === "cursor_snapshot_unavailable" ? entityListFamily(artifact as "todo" | "docs") : undefined;
  return new StateRetrievalFailure(
    { schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { class: kind, message, syntax: family?.syntax ?? `agentera state ${artifact} get --id ID`, example: family?.example ?? `agentera state ${artifact} get --id ${id ?? "qjtrmnpvka"}`, recovery, artifact, ...(id ? { id } : {}) } },
    exitCode,
  );
}
export function relevant(root: string, sourceRoot: string, artifact?: "todo" | "docs", supplied?: EntityDiscoveryResult, sourceBinding?: MigrationSourceBindingContext): DiscoveredEntity[] {
  if (supplied) assertEntityDiscoveryOrigin(root, sourceRoot, supplied);
  const discovery = supplied ?? discoverEntities(root, sourceRoot, sourceBinding);
  const selected = discovery.entities.filter((entity) => [TODO.boundary, DOCS.boundary].includes(entity.boundary as typeof TODO.boundary) || [TODO.artifact, DOCS.artifact].includes(entity.artifact as typeof TODO.artifact));
  const bad = selected.find(({ classification, id, record }) => classification !== "valid" || !id || !record);
  if (bad) throw failure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", artifact ?? bad.artifact ?? "todo", `entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state and resolve every invalid identity or record before retrying.", bad.id ?? undefined);
  return selected;
}
export function selectedById(entities: DiscoveredEntity[], artifact: "todo" | "docs", id: string): DiscoveredEntity {
  if (!ID.test(id)) throw failure("invalid_request", artifact, `${artifact} ID '${id}' must be ten lowercase letters`, `Use a bare ${artifact} ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid.`, id, 2);
  const boundary = definition(artifact).boundary;
  const matches = entities.filter((entity) => entity.boundary === boundary && entity.id === id);
  if (matches.length !== 1) throw failure(matches.length ? "ambiguous" : "not_found", artifact, matches.length ? `${artifact} ID '${id}' has conflicting ownership` : `${artifact} ID '${id}' was not found`, `Run agentera state ${artifact} list and select one canonical ID.`, id);
  return matches[0];
}
export function recordViolations(artifact: "todo" | "docs", record: JsonObject, sourceRoot: string): string[] {
  const boundary = definition(artifact).boundary;
  const violations = [...canonicalEntityRecordViolations(boundary, record, sourceRoot), ...todoDocsRecordViolations(boundary, record, sourceRoot)];
  return [...new Set(violations)];
}
export function assertState(root: string, sourceRoot: string, sourceBinding?: MigrationSourceBindingContext): void {
  const state = validateEntityState(root, sourceRoot, sourceBinding);
  if (!state.valid) reject({ class: "conflict", message: `canonical entity state is invalid: ${state.issues.map(({ message }) => message).join("; ")}`, recovery: "Run agentera check validate state and resolve every identity or record conflict before retrying; no state was changed." });
}
export function markdownSeverity(section: string): string | null {
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
  try {
    pending = inspectTodoReconciliation(root, todoReconciliationBinding(root, sourceRoot));
  } catch (error) {
    if (error instanceof StateWriteInputError) {
      throw failure("unsupported_state", "todo", error.body.message, error.body.recovery ?? "Restore the pending TODO reconciliation journal, then retry this read.", id);
    }
    throw error;
  }
  if (pending.length) throw failure("unsupported_state", "todo", `TODO reconciliation transaction '${pending[0]}' is pending; no mixed TODO state is readable`, "Retry the exact non-dry-run TODO mutation to complete recovery, then repeat this read.", id);
}
export interface TodoPublicSnapshot {
  present: boolean;
  description?: string;
  severity?: string;
  status?: string;
  order?: number;
}
export interface ManagedRow {
  id: string;
  line: number;
  section: string;
  sourceLine: string;
  snapshot: TodoPublicSnapshot;
  item: NonNullable<ReturnType<typeof parseTodoMarkdownListItem>>;
}
export interface LegacyRow {
  line: number;
  section: string;
  sourceLine: string;
  snapshot: TodoPublicSnapshot;
  item: NonNullable<ReturnType<typeof parseTodoMarkdownListItem>>;
}
export interface ManagedRowScan {
  rows: Map<string, ManagedRow>;
  retainedLegacyRows: string[];
  matchedRows: number;
  convertedRows: number;
}
export type TodoEntityView = Pick<DiscoveredEntity, "boundary" | "id" | "record">;
export const RECONCILIATION_VERSION = "agentera.todoReconciliation.v1";
export const TODO_DRIFT_ITEM_LIMIT = 20;
export const PUBLIC_FIELDS = ["description", "severity", "status"] as const;
export interface TodoDriftItem {
  id: string;
  state: "markdown_only" | "entity_only" | "convergent" | "conflict";
  markdown_changed_fields: string[];
  entity_changed_fields: string[];
  conflicting_fields: string[];
}
export interface TodoReadView {
  rows: Map<string, ManagedRow>;
  drift: JsonObject;
}
export function publicSnapshot(record: JsonObject, order?: number): TodoPublicSnapshot {
  return { present: true, description: renderTodoPublicRecord(record), severity: String(record.severity), status: String(record.status), ...(order === undefined ? {} : { order }) };
}
export function baseline(record: JsonObject): TodoPublicSnapshot | null {
  const reconciliation = mapping(record.reconciliation) ? record.reconciliation : null;
  const value = reconciliation?.schema_version === RECONCILIATION_VERSION && mapping(reconciliation.public) ? reconciliation.public : null;
  if (!value || typeof value.present !== "boolean") return null;
  return structuredClone(value) as unknown as TodoPublicSnapshot;
}

export function samePublic(left: TodoPublicSnapshot, right: TodoPublicSnapshot, includeOrder = true): boolean {
  const fields = includeOrder ? ["present", "description", "severity", "status", "order"] : ["present", "description", "severity", "status"];
  return fields.every((field) => left[field as keyof TodoPublicSnapshot] === right[field as keyof TodoPublicSnapshot]);
}
export function changedPublicFields(current: TodoPublicSnapshot, prior: TodoPublicSnapshot, includeOrder: boolean): string[] {
  const fields = includeOrder ? ["present", ...PUBLIC_FIELDS, "order"] : ["present", ...PUBLIC_FIELDS];
  return fields.filter((field) => current[field as keyof TodoPublicSnapshot] !== prior[field as keyof TodoPublicSnapshot]);
}

export function todoAuthority(): JsonObject {
  return { identity: { owner: "managed_row", field: "id" }, public: { owner: "markdown", source: "TODO.md", fields: ["description", "severity", "status", "order"] }, operational: { owner: "agentera", source: "canonical_entity_file", fields: ["readiness", "dependencies", "blocked", "gate", "evidence", "lifecycle"] } };
}

export function managedRows(markdown: string, activation: TodoReconciliationActivation | null, entities: readonly TodoEntityView[]): ManagedRowScan {
  assertTodoSeverityHeadingStructure(markdown);
  const result = new Map<string, ManagedRow>();
  const order = new Map<string, number>();
  const legacy: LegacyRow[] = [];
  let section: string | null = null;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const heading = line
      .trim()
      .match(/^##\s+(.+)$/)?.[1]
      ?.toLowerCase();
    if (heading) section = todoSeveritySectionForHeading(line) ?? (heading === "notes" ? null : section);
    const item = parseTodoMarkdownListItem(line.trim());
    if (!item) return;
    const severity = section ? markdownSeverity(section) : null;
    if (item.id && !severity && section !== "resolved") reject({ class: "conflict", message: `TODO '${item.id}' is outside a managed severity or resolved section`, recovery: `Move '${item.id}' under one declared TODO severity or the resolved section and retry; no state was changed.` });
    if (!section) return;
    const key = section === "resolved" ? "resolved" : severity!;
    const publicOrder = (order.get(key) ?? 0) + 1;
    order.set(key, publicOrder);
    const row = { line: index, section: key, sourceLine: line, item, snapshot: { present: true, description: item.public_description ?? item.description, ...(section === "resolved" ? {} : { severity: severity! }), status: item.status, order: publicOrder } };
    if (!item.id) {
      legacy.push(row);
      return;
    }
    if (result.has(item.id)) reject({ class: "conflict", message: `TODO.md contains duplicate managed ID '${item.id}'`, recovery: `Keep exactly one managed row with ID '${item.id}' and retry; no state was changed.` });
    result.set(item.id, { ...row, id: item.id });
  });
  const retainedLegacyRows: string[] = [];
  const matchedRows = result.size;
  let convertedRows = 0;
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
    if (ambiguous)
      reject({
        class: "conflict",
        message: `pre-activation TODO contains identical ID-less managed rows at lines ${ambiguous
          .slice(0, TODO_ACTIVATION_RISK_LIMIT)
          .map((row) => row.line + 1)
          .join(", ")}${ambiguous.length > TODO_ACTIVATION_RISK_LIMIT ? `; ${ambiguous.length - TODO_ACTIVATION_RISK_LIMIT} additional lines omitted` : ""}`,
        diagnosis: unsafeInactiveDuplicateDiagnosis(),
        recovery: "Give each identical row its distinct canonical '[id:abcdefghij]' tag or remove the duplicate, then retry once; no state was changed.",
      });
    const claimed = new Set(result.keys());
    for (const row of legacy) {
      const duplicate = entities.find((entity) => entity.boundary === TODO.boundary && entity.id && entity.record && claimed.has(entity.id) && samePublic(publicSnapshot(entity.record), rowSnapshot({ ...row, id: entity.id }, entity.record), false));
      if (duplicate) reject({ class: "conflict", message: `pre-activation TODO row at line ${row.line + 1} duplicates canonical public work`, diagnosis: unsafeInactiveDuplicateDiagnosis(), recovery: "Restore exactly one public row for each canonical entity before activation, then retry once; no state was changed." });
      const matches = entities.filter((entity) => {
        if (entity.boundary !== TODO.boundary || !entity.id || !entity.record || claimed.has(entity.id)) return false;
        return samePublic(publicSnapshot(entity.record), rowSnapshot({ ...row, id: entity.id }, entity.record), false);
      });
      if (matches.length > 1)
        reject({ class: "conflict", message: `pre-activation TODO row at line ${row.line + 1} matches multiple canonical entities`, diagnosis: unsafeInactiveDuplicateDiagnosis(matches.length), recovery: `Add one exact '[id:abcdefghij]' tag to TODO.md line ${row.line + 1} and retry once; no state was changed.` });
      const matched = matches[0];
      if (matched?.id) {
        claimed.add(matched.id);
        result.set(matched.id, { ...row, id: matched.id });
        convertedRows += 1;
        continue;
      }
      const fingerprint = todoLegacyRowFingerprint(row.section, row.sourceLine);
      if (retainedLegacyRows.includes(fingerprint))
        reject({
          class: "conflict",
          message: `pre-activation TODO contains duplicate unmatched legacy rows at line ${row.line + 1}`,
          diagnosis: unsafeInactiveDuplicateDiagnosis(),
          recovery: `Give each duplicate row a distinct canonical '[id:abcdefghij]' tag or move it outside managed sections, then retry once; no state was changed.`,
        });
      retainedLegacyRows.push(fingerprint);
    }
  }
  if (result.size > TODO_RECONCILIATION_ITEM_LIMIT || retainedLegacyRows.length > TODO_RECONCILIATION_ITEM_LIMIT)
    reject({ class: "conflict", message: `TODO.md exceeds the ${TODO_RECONCILIATION_ITEM_LIMIT}-item reconciliation or legacy-activation bound`, recovery: `Compact retained resolved rows until each bounded set has at most ${TODO_RECONCILIATION_ITEM_LIMIT} items, then retry once; no state was changed.` });
  return { rows: result, retainedLegacyRows, matchedRows, convertedRows };
}

export function rowSnapshot(row: ManagedRow, record: JsonObject): TodoPublicSnapshot {
  return { ...row.snapshot, severity: row.section === "resolved" ? String(record.severity) : row.snapshot.severity };
}

export function inspectTodoReadView(root: string, sourceRoot: string, entities: DiscoveredEntity[]): TodoReadView {
  let activation: TodoReconciliationActivation | null;
  try {
    activation = loadTodoReconciliationActivation(root)?.record ?? null;
  } catch {
    return { rows: new Map(), drift: { schema_version: RECONCILIATION_VERSION, status: "invalid_lifecycle", read_effect: "none", authority: todoAuthority(), counts: { managed: 0, drifted: 0, conflicts: 1 }, items: [] } };
  }
  if (!activation) {
    return { rows: new Map(), drift: { schema_version: RECONCILIATION_VERSION, status: "inactive", read_effect: "none", authority: todoAuthority(), counts: { managed: 0, drifted: 0, conflicts: 0 }, items: [] } };
  }
  const todoEntities = entities.filter(({ boundary }) => boundary === TODO.boundary);
  let markdown: string;
  let rows: Map<string, ManagedRow>;
  try {
    markdown = readTodoMarkdown(todoPublicPath(root, sourceRoot)).text;
    rows = managedRows(markdown, activation, todoEntities).rows;
  } catch (error) {
    if (error instanceof StateWriteInputError && /Markdown/i.test(error.body.message)) throw error;
    const diagnosis = error instanceof StateWriteInputError && mapping(error.body.diagnosis) ? error.body.diagnosis : undefined;
    return { rows: new Map(), drift: { schema_version: RECONCILIATION_VERSION, status: "conflict", action_required: true, read_effect: "none", next_write_boundary: "atomic_reconciliation", authority: todoAuthority(), counts: { managed: 0, drifted: 0, conflicts: 1 }, items: [], ...(diagnosis ? { diagnosis } : {}) } };
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
        items.push({ id, state: prior.status === "open" ? "conflict" : "markdown_only", markdown_changed_fields: ["present"], entity_changed_fields: [], conflicting_fields: prior.status === "open" ? ["present"] : [] });
      }
      continue;
    }
    const markdownPublic = rowSnapshot(row, current);
    const entityPublic = publicSnapshot(current, prior.order);
    const markdownFields = changedPublicFields(markdownPublic, prior, true);
    const entityFields = changedPublicFields(entityPublic, prior, false);
    if (!markdownFields.length && !entityFields.length) continue;
    const conflictingFields = markdownFields.filter((field) => entityFields.includes(field) && markdownPublic[field as keyof TodoPublicSnapshot] !== entityPublic[field as keyof TodoPublicSnapshot]);
    items.push({ id, state: conflictingFields.length ? "conflict" : markdownFields.length && entityFields.length ? "convergent" : markdownFields.length ? "markdown_only" : "entity_only", markdown_changed_fields: markdownFields, entity_changed_fields: entityFields, conflicting_fields: conflictingFields });
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

export function inspectTodoReconciliationDrift(root: string, sourceRoot = resolveSourceRoot(), discovery?: EntityDiscoveryResult): JsonObject {
  assertTodoReconciliationReadable(root, sourceRoot);
  return inspectTodoReadView(root, sourceRoot, relevant(root, sourceRoot, "todo", discovery)).drift;
}

export function projectTodoReadEntities(root: string, sourceRoot = resolveSourceRoot(), discovery?: EntityDiscoveryResult): Array<{ id: string; artifact: string; record: JsonObject; projectedOrder?: { kind: "managed"; markdownOrder: number } | { kind: "absent" } }> {
  assertTodoReconciliationReadable(root, sourceRoot);
  const entities = relevant(root, sourceRoot, "todo", discovery).filter(({ boundary }) => boundary === TODO.boundary);
  if (entities.length > TODO_RECONCILIATION_ITEM_LIMIT) throw failure("unsupported_state", "todo", `complete TODO projection exceeds the ${TODO_RECONCILIATION_ITEM_LIMIT}-entity startup bound`, "Compact resolved TODO entities within the declared reconciliation bound, then retry this read.");
  const view = inspectTodoReadView(root, sourceRoot, entities);
  const projected = view.drift.status !== "inactive";
  const sorted = entities
    .filter(({ boundary }) => boundary === TODO.boundary)
    .sort((a, b) => {
      const left = publicReadRecord(a.record!, view.rows.get(a.id!));
      const right = publicReadRecord(b.record!, view.rows.get(b.id!));
      return (
        TODO_SEVERITIES.indexOf(left.severity as (typeof TODO_SEVERITIES)[number]) - TODO_SEVERITIES.indexOf(right.severity as (typeof TODO_SEVERITIES)[number]) ||
        TODO_STATUSES.indexOf(left.status as (typeof TODO_STATUSES)[number]) - TODO_STATUSES.indexOf(right.status as (typeof TODO_STATUSES)[number]) ||
        (view.rows.get(a.id!)?.snapshot.order ?? Number.MAX_SAFE_INTEGER) - (view.rows.get(b.id!)?.snapshot.order ?? Number.MAX_SAFE_INTEGER) ||
        a.id!.localeCompare(b.id!)
      );
    });
  return sorted.map((entity) => {
    const row = view.rows.get(entity.id!);
    return { id: entity.id!, artifact: entity.artifact!, record: publicReadRecord(entity.record!, row), ...(projected ? { projectedOrder: row?.snapshot.order === undefined ? { kind: "absent" as const } : { kind: "managed" as const, markdownOrder: row.snapshot.order } } : {}) };
  });
}

export function publicReadRecord(record: JsonObject, row?: ManagedRow): JsonObject {
  return row ? importMarkdown(record, row) : record;
}

export function publicReadMetadata(record: JsonObject, row?: ManagedRow): JsonObject {
  const value = row ? rowSnapshot(row, record) : { present: false };
  return { ...value, owner: "markdown", source: "TODO.md" } as JsonObject;
}

export function importMarkdown(record: JsonObject, row: ManagedRow): JsonObject {
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

export function withBaseline(record: JsonObject, value: TodoPublicSnapshot): JsonObject {
  const publicValue = Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as JsonObject;
  const transitionBatch = mapping(record.reconciliation) && mapping(record.reconciliation.transition_batch) ? structuredClone(record.reconciliation.transition_batch) : null;
  return { ...record, reconciliation: { schema_version: RECONCILIATION_VERSION, public: publicValue, ...(transitionBatch ? { transition_batch: transitionBatch } : {}) } };
}
