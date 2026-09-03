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
import {
  DOCS,
  ID,
  SHA256,
  TODO,
  assertState,
  assertTodoReconciliationReadable,
  baseline,
  changedPublicFields,
  contract,
  definition,
  failure,
  importMarkdown,
  inspectTodoReconciliationDrift,
  inspectTodoReadView,
  managedRows,
  mapping,
  relative,
  projectTodoReadEntities,
  publicReadMetadata,
  publicReadRecord,
  publicSnapshot,
  recordViolations,
  relevant,
  selectedById,
  samePublic,
  rowSnapshot,
  todoPublicPath,
  todoReconciliationBinding,
  withBaseline,
  PUBLIC_FIELDS,
  type ManagedRow,
  type ManagedRowScan,
  type Options,
  type TodoEntityView,
  type TodoPublicSnapshot,
  type TodoReadView,
} from "./todoDocsReconciliation.js";
export { assertTodoReconciliationReadable, inspectTodoReconciliationDrift, managedRows, projectTodoReadEntities, relevant, todoPublicPath, todoReconciliationBinding, type ManagedRow, type ManagedRowScan } from "./todoDocsReconciliation.js";
export function inactiveTodoMutation(): never {
  reject({
    class: "conflict",
    message: "TODO reconciliation is inactive; ordinary TODO mutations cannot activate it implicitly",
    syntax: TODO_ACTIVATION_PREVIEW_COMMAND,
    example: TODO_ACTIVATION_APPLY_COMMAND,
    recovery: `Run exactly '${TODO_ACTIVATION_PREVIEW_COMMAND}', review every reported effect, then run exactly '${TODO_ACTIVATION_APPLY_COMMAND}'; no state was changed.`,
  });
}
export function activationEnvelope(effect: JsonObject, dryRun: boolean, replay: boolean, transactionId: string | null, targets: number, recovered: string[]): StateWriteEnvelope {
  return {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state todo activate",
    status: "pass",
    path: TODO_RECONCILIATION_ACTIVATION_PATH,
    artifact: "todo",
    operation: { verb: "activate", dry_run: dryRun, idempotent_replay: replay },
    validation: { status: "pass", violations: [] },
    activation: effect,
    apply_command: TODO_ACTIVATION_APPLY_COMMAND.replace("EFFECT_SHA256", String(effect.effect_sha256)),
    reconciliation: { transaction_id: transactionId, targets, recovered },
  };
}
export function repairEnvelope(effect: JsonObject, dryRun: boolean, replay: boolean, transactionId: string | null, targets: number, recovered: string[]): StateWriteEnvelope {
  return {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state todo repair",
    status: "pass",
    path: TODO_RECONCILIATION_ACTIVATION_PATH,
    artifact: "todo",
    operation: { verb: "repair", dry_run: dryRun, idempotent_replay: replay },
    validation: { status: "pass", violations: [] },
    repair: effect,
    apply_command: TODO_REPAIR_APPLY_COMMAND.replace("EFFECT_SHA256", String(effect.effect_sha256)),
    reconciliation: { transaction_id: transactionId, targets, recovered },
  };
}
export function ownerCorrectionEnvelope(effect: JsonObject, dryRun: boolean, replay: boolean, transactionId: string | null, targets: number, recovered: string[]): StateWriteEnvelope {
  return {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state todo correct-owners",
    status: "pass",
    path: TODO_RECONCILIATION_ACTIVATION_PATH,
    artifact: "todo",
    operation: { verb: "correct-owners", dry_run: dryRun, idempotent_replay: replay },
    validation: { status: "pass", violations: [] },
    correction: effect,
    apply_command: TODO_OWNER_CORRECTION_APPLY_COMMAND.replace("EFFECT_SHA256", String(effect.effect_sha256)),
    reconciliation: { transaction_id: transactionId, targets, recovered },
  };
}
export function envelope(command: string, entity: { id: string; path: string; replay: boolean }, artifact: "todo" | "docs", record: JsonObject, dryRun: boolean): StateWriteEnvelope {
  return { schemaVersion: "agentera.stateWrite.v1", command, status: "pass", path: entity.path, id: entity.id, artifact, record, operation: { verb: command.split(" ").at(-1), dry_run: dryRun, idempotent_replay: entity.replay }, validation: { status: "pass", violations: [] } };
}
export function targetPath(root: string, sourceRoot: string, artifact: "todo" | "docs", id: string): string {
  const model = definition(artifact);
  return path.join(root, contract(model.boundary, sourceRoot).entityRoot, artifact, model.boundary, `${id}.yaml`);
}
export function readinessRecord(value: unknown): JsonObject {
  if (!mapping(value)) return structuredClone(value) as JsonObject;
  const dependencies = Array.isArray(value.dependencies) ? value.dependencies.map((dependency) => (typeof dependency === "string" ? { artifact: "todo", id: dependency } : dependency)) : value.dependencies;
  return { capability: value.capability, reason: value.reason, dependencies: dependencies ?? [], blocked: value.blocked ?? null, gate: value.gate ?? null, queue_rank: value.queue_rank, order_reason: value.order_reason } as JsonObject;
}

export function legacyTodoPayload(req: StateWriteRequest): JsonObject {
  const values = req.values;
  return { ...(values.severity !== undefined ? { severity: values.severity } : {}), ...(values.description !== undefined ? { description: values.description } : {}), ...(values.readiness !== undefined ? { readiness: readinessRecord(values.readiness) } : {}) } as JsonObject;
}

export function todoPayload(req: StateWriteRequest): JsonObject {
  return req.input ? (structuredClone(req.input) as JsonObject) : legacyTodoPayload(req);
}

export function applyTodoPatch(current: JsonObject, patch: JsonObject): JsonObject {
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

export function transitionRecord(req: StateWriteRequest, current: JsonObject, entities: TodoEntityView[]): JsonObject {
  const lifecycle = mapping(req.values.lifecycle) ? req.values.lifecycle : {};
  const operation = req.spec.verb;
  const reason = String(lifecycle.reason ?? "").trim();
  const date = String(lifecycle.date ?? "");
  const severity = String(req.values.severity ?? "");
  const replacement = String(lifecycle.replacement ?? "");
  const record = structuredClone(current);
  const previous = mapping(current.lifecycle) ? current.lifecycle : null;
  const sameTransition = previous !== null && previous.operation === operation && previous.reason === reason && previous.date === date && (operation === "set-severity" ? current.severity === severity : true) && (operation === "supersede" ? previous.replacement === replacement : previous.replacement === undefined);
  const replayStatus = operation === "resolve" || operation === "supersede" ? "resolved" : operation === "reopen" ? "open" : null;
  if (sameTransition && (replayStatus === null || current.status === replayStatus)) return record;
  if (operation === "set-severity") {
    if (previous?.operation === operation && previous.reason === reason && previous.date === date)
      reject({
        class: "conflict",
        message: "TODO set-severity retry differs from the established transition",
        recovery: `Retry the exact transition with --severity ${String(current.severity)}, --reason ${shellQuoteArgument(previous.reason)}, and --date ${String(previous.date)}; use a distinct reason or date for a new transition; no state was changed.`,
      });
    record.severity = severity;
  } else if (operation === "resolve") {
    if (current.status !== "open")
      reject({
        class: "conflict",
        message: "TODO resolve requires an open item",
        recovery: previous?.operation === operation ? `Retry the exact transition with --reason ${shellQuoteArgument(previous.reason)} and --date ${String(previous.date)}; no state was changed.` : "Use state todo reopen only for a resolved item; no state was changed.",
      });
    record.status = "resolved";
  } else if (operation === "reopen") {
    if (current.status !== "resolved")
      reject({
        class: "conflict",
        message: "TODO reopen requires a resolved item",
        recovery: previous?.operation === operation ? `Retry the exact transition with --reason ${shellQuoteArgument(previous.reason)} and --date ${String(previous.date)}; no state was changed.` : "Use state todo resolve for an open item; no state was changed.",
      });
    record.status = "open";
  } else if (operation === "supersede") {
    if (current.status !== "open")
      reject({
        class: "conflict",
        message: "TODO supersede requires an open item",
        recovery:
          previous?.operation === operation
            ? `Retry the exact transition with --replacement ${String(previous.replacement)}, --reason ${shellQuoteArgument(previous.reason)}, and --date ${String(previous.date)}; no state was changed.`
            : "Reopen the resolved item before establishing a supersession; no state was changed.",
      });
    if (!/^[a-z]{10}$/.test(replacement) || replacement === String(req.values.id)) reject({ class: "schema_violation", message: "supersede replacement must be a distinct bare TODO ID", recovery: "Use an existing ten-letter TODO ID other than the selected item; no state was changed." });
    const target = entities.find((entity) => entity.boundary === TODO.boundary && entity.id === replacement);
    if (!target) reject({ class: "unsupported_target", message: `TODO replacement '${replacement}' was not found`, recovery: "Use an ID returned by agentera state todo list; no state was changed." });
    record.status = "resolved";
  }
  record.lifecycle = { operation, reason, date, ...(lifecycle.replacement !== undefined ? { replacement: String(lifecycle.replacement) } : {}) };
  return record;
}
export function mutationRecord(req: StateWriteRequest, current: JsonObject | undefined, entities: TodoEntityView[] = []): JsonObject {
  if (req.artifact === "docs") return structuredClone(req.input ?? {}) as JsonObject;
  if (current && ["set-severity", "supersede", "resolve", "reopen"].includes(req.spec.verb)) return transitionRecord(req, current, entities);
  const payload = todoPayload(req);
  if (req.spec.verb === "create") return { ...structuredClone(payload), status: "open", ...(payload.readiness !== undefined ? { readiness: readinessRecord(payload.readiness) } : {}) } as JsonObject;
  return applyTodoPatch(current ?? {}, payload);
}

export function assertTodoReferences(id: string, record: JsonObject, entities: TodoEntityView[]): void {
  if (record.readiness === undefined) return;
  const todos = entities.filter((entity) => entity.boundary === TODO.boundary && entity.id && entity.record && entity.id !== id).map((entity) => ({ id: entity.id!, record: entity.record! }));
  todos.push({ id, record });
  const violations = todoReadinessReferenceViolations(id, record.readiness, todos);
  if (violations.length) reject({ class: "schema_violation", message: "todo readiness dependencies are invalid", violations, recovery: "Use bare ten-letter IDs returned by `agentera state todo list`; reference existing TODO items only and remove self-references or cycles, then retry." });
}

export function todoReadinessRecovery(verb: string): string {
  return `Run agentera state todo explain --verb ${verb}, then provide a complete typed TODO record or patch; readiness must include capability, reason, queue_rank, and order_reason together, and dependencies must use IDs returned by agentera state todo list.`;
}

export function reconcileTodoRecords(entities: DiscoveredEntity[], rows: Map<string, ManagedRow>, activating: boolean): { records: Map<string, JsonObject>; visible: Set<string> } {
  const records = new Map<string, JsonObject>();
  const visible = new Set<string>();
  for (const entity of entities.filter(({ boundary }) => boundary === TODO.boundary)) {
    const id = entity.id!;
    const current = entity.record!;
    const row = rows.get(id);
    const prior = baseline(current);
    if (!prior) {
      if (activating) {
        records.set(id, row ? importMarkdown(current, row) : current);
        if (row || current.status === "open") visible.add(id);
        continue;
      }
      reject({ class: "conflict", message: `TODO '${id}' has no stable reconciliation baseline`, recovery: `Restore TODO '${id}' with its last committed reconciliation baseline, or restore the pre-activation state and remove the activation marker, then retry once; no state was changed.` });
    }
    if (!row) {
      if (prior.present && prior.status === "open") reject({ class: "conflict", message: `unchecked TODO '${id}' was removed from TODO.md`, recovery: `Restore the unchecked managed row '${id}' or check it resolved before removing it, then retry once; no state was changed.` });
      records.set(id, current);
      continue;
    }
    const markdown = rowSnapshot(row, current);
    const entityPublic = publicSnapshot(current, prior.order);
    const markdownFields = changedPublicFields(markdown, prior, true);
    const entityFields = changedPublicFields(entityPublic, prior, false);
    const conflictingFields = markdownFields.filter((field) => entityFields.includes(field) && markdown[field as keyof TodoPublicSnapshot] !== entityPublic[field as keyof TodoPublicSnapshot]);
    if (conflictingFields.length) reject({ class: "conflict", message: `TODO.md and Agentera changed public fields divergently for TODO '${id}': ${conflictingFields.join(", ")}`, recovery: `Choose one value for each divergent public field of '${id}', make both sides agree, then retry once; no state was changed.` });
    let merged = current;
    if (markdownFields.some((field) => PUBLIC_FIELDS.includes(field as (typeof PUBLIC_FIELDS)[number]))) {
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
    records.set(id, merged);
    visible.add(id);
  }
  for (const id of rows.keys()) if (!records.has(id)) reject({ class: "conflict", message: `TODO.md managed ID '${id}' has no canonical entity`, recovery: `Restore the canonical TODO entity for '${id}' or remove the orphaned managed ID, then retry once; no state was changed.` });
  return { records, visible };
}
