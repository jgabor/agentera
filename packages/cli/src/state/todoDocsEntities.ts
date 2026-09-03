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
import { inactiveTodoMutation, activationEnvelope, repairEnvelope, ownerCorrectionEnvelope, envelope, targetPath, readinessRecord, legacyTodoPayload, todoPayload, applyTodoPatch, transitionRecord, mutationRecord, assertTodoReferences, todoReadinessRecovery, reconcileTodoRecords } from "./todoDocsWrite.js";
export function mutateTodoDocsEntity(req: StateWriteRequest, options: Options = {}): StateWriteEnvelope {
  const artifact = req.artifact as "todo" | "docs";
  if (artifact !== "todo" && artifact !== "docs") throw new Error("TODO/docs entity mutation received an unsupported artifact");
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  if (!options.publicationContext) {
    const binding = detectStateModeBinding(req.projectRoot, sourceRoot);
    if (binding.mode !== "entities") reject({ class: "unsupported_target", message: `${artifact} entity mutations require the durable entity-mode marker; legacy aggregate behavior is unchanged` });
    try {
      return mutateTodoDocsEntity(req, { ...options, publicationContext: binding.publicationContext });
    } finally {
      binding.publicationContext.close();
    }
  }
  const context = options.publicationContext;
  return withEntityWriterLock(context, () => {
    const pinnedRoot = context.pinnedPath();
    const sourceBinding = { kind: "project", projectRoot: context.validatedRoot } as const;
    context.assertValid();
    const todoBinding = artifact === "todo" ? todoReconciliationBinding(req.projectRoot, sourceRoot) : null;
    const correctingOwners = artifact === "todo" && req.spec.verb === "correct-owners";
    const ownerEvidence = correctingOwners ? normalizeTodoOwnerCorrectionEvidence(req.input ?? {}) : null;
    const batch = artifact === "todo" && req.spec.verb === "update" ? parseTodoUpdateBatch(req.input as JsonObject | null) : null;
    const createBatch = artifact === "todo" && req.spec.verb === "create" ? parseTodoCreateBatch(req.input as JsonObject | null) : null;
    const transitionBatch = artifact === "todo" ? parseTodoTransitionBatch(req.input as JsonObject | null, req.spec.verb) : null;
    const pending = todoBinding ? inspectTodoReconciliation(pinnedRoot, todoBinding) : [];
    if (artifact === "todo") assertTodoSeverityHeadingStructure(readTodoMarkdown(todoPublicPath(pinnedRoot, sourceRoot)).text);
    const initialActivation = artifact === "todo" ? loadTodoReconciliationActivation(pinnedRoot) : null;
    if (artifact === "todo" && ["activate", "repair", "correct-owners"].includes(req.spec.verb)) {
      const repairing = req.spec.verb === "repair";
      const previewCommand = correctingOwners ? TODO_OWNER_CORRECTION_PREVIEW_COMMAND : repairing ? TODO_REPAIR_PREVIEW_COMMAND : TODO_ACTIVATION_PREVIEW_COMMAND;
      const applyCommand = correctingOwners ? TODO_OWNER_CORRECTION_APPLY_COMMAND : repairing ? TODO_REPAIR_APPLY_COMMAND : TODO_ACTIVATION_APPLY_COMMAND;
      if (repairing && !initialActivation) reject({ class: "conflict", message: "TODO repair requires an existing reconciliation activation marker", recovery: `Use '${TODO_ACTIVATION_PREVIEW_COMMAND}' for an inactive project; no state was changed.` });
      if (req.dryRun && (req.values.confirmed === true || req.values.effect_sha256 !== undefined))
        reject({ class: "mutually_exclusive", message: `TODO ${req.spec.verb} --dry-run cannot include apply confirmation`, recovery: `Run exactly '${previewCommand}' or the preview's exact apply_command; no state was changed.` });
      if (!req.dryRun && (req.values.confirmed !== true || !SHA256.test(String(req.values.effect_sha256 ?? ""))))
        reject({
          class: "missing_argument",
          message: `TODO ${req.spec.verb} apply requires the preview effect SHA-256 and explicit --yes confirmation`,
          syntax: previewCommand,
          example: applyCommand,
          recovery: `Run exactly '${previewCommand}', review every reported effect, then run its exact apply_command; no state was changed.`,
        });
    } else if (artifact === "todo" && !initialActivation) inactiveTodoMutation();
    if (req.dryRun && pending.length) reject({ class: "conflict", message: `TODO reconciliation transaction '${pending[0]}' requires recovery before dry-run`, recovery: "Retry the exact TODO mutation without --dry-run once to complete recovery; this dry-run changed no state." });
    const createRequest = artifact === "todo" && req.spec.verb === "create" && !createBatch ? mutationRecord(req, undefined) : null;
    const createRequestSha256 = createRequest ? todoCreateRequestSha256(createRequest) : undefined;
    const recoveryReceipts =
      todoBinding && !req.dryRun
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
      if (recoveredBatch?.update_batch_effect_sha256 && (batch || transitionBatch)) {
        const verb = transitionBatch?.verb ?? "update";
        const entries = transitionBatch?.entries ?? batch!;
        return {
          schemaVersion: "agentera.stateWrite.v1",
          command: `state todo ${verb}`,
          status: "pass",
          artifact: "todo",
          records: entries.map(({ id }) => ({ id, record: selectedById(entities, "todo", id).record! })),
          operation: { verb, dry_run: false, idempotent_replay: true },
          validation: { status: "pass", violations: [] },
          effect_sha256: recoveredBatch.update_batch_effect_sha256,
          apply_command: null,
          reconciliation: { transaction_id: recoveredBatch.transaction_id, targets: recoveredBatch.target_count, recovered },
        };
      }
      const recoveredCreateBatch = recoveryReceipts.find((receipt) => receipt.create_batch);
      if (recoveredCreateBatch?.create_batch && createBatch)
        return {
          schemaVersion: "agentera.stateWrite.v1",
          command: "state todo create",
          status: "pass",
          artifact: "todo",
          records: Object.entries(recoveredCreateBatch.create_batch.local_refs).map(([local_ref, id]) => ({ local_ref, id, record: selectedById(entities, "todo", id).record! })),
          local_refs: recoveredCreateBatch.create_batch.local_refs,
          operation: { verb: "create", dry_run: false, idempotent_replay: true },
          validation: { status: "pass", violations: [] },
          effect_sha256: recoveredCreateBatch.create_batch.effect_sha256,
          apply_command: null,
          reconciliation: { transaction_id: recoveredCreateBatch.transaction_id, targets: recoveredCreateBatch.target_count, recovered },
        };
      const publicFile = todoPublicPath(pinnedRoot, sourceRoot);
      const publicRelative = todoBinding!.publicPath;
      const publicExists = fs.existsSync(publicFile);
      const loadedMarkdown = readTodoMarkdown(publicFile);
      const markdownBefore = loadedMarkdown.bytes;
      const markdown = loadedMarkdown.text;
      const todoEntities = entities.filter(({ boundary }) => boundary === TODO.boundary);
      const loadedActivation = loadTodoReconciliationActivation(pinnedRoot);
      const activation = loadedActivation?.record ?? null;
      if (req.spec.verb === "activate") {
        if (activation) {
          const effect = unchangedTodoActivationEffect(publicRelative, markdownBefore, activation.retained_legacy_rows.length, activation.effect_sha256);
          if (!req.dryRun && req.values.effect_sha256 !== effect.effect_sha256)
            reject({ class: "conflict", message: "TODO activation replay does not match the authorized effect", recovery: `Use the exact apply_command returned by ${activation.effect_sha256 ? "the original activation preview" : "the active no-op preview"}; no state was changed.` });
          return activationEnvelope(effect, req.dryRun, true, null, 0, recovered);
        }
        const scan = managedRows(markdown, null, todoEntities);
        const rows = scan.rows;
        const safety = inactiveTodoActivationSafety(scan, todoEntities);
        if (!safety.safe) rejectUnsafeInactiveTodoActivation(safety);
        const reconciled = reconcileTodoRecords(todoEntities, rows, true);
        for (const [todoId, record] of reconciled.records) {
          const violations = recordViolations("todo", record, sourceRoot);
          if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations });
          if (record.readiness !== undefined)
            assertTodoReferences(
              todoId,
              record,
              [...reconciled.records].map(([entityId, entityRecord]) => ({ boundary: TODO.boundary, id: entityId, record: entityRecord })),
            );
        }
        const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId)));
        const rendered = renderManagedMarkdown(markdown, visibleRecords, rows);
        let activationBytesAfter = todoReconciliationActivationBytes(scan.retainedLegacyRows, "0".repeat(64));
        const activationAfter = JSON.parse(activationBytesAfter) as TodoReconciliationActivation;
        const finalRows = managedRows(rendered, activationAfter, todoEntities).rows;
        for (const [todoId, record] of reconciled.records) {
          const row = finalRows.get(todoId);
          reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
        }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
          path: entity.relativePath,
          before: exactDiscoveredEntityBytes(entity),
          after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
        }));
        targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
        const resurrectedIds = safety.resurrectedIds;
        const preliminaryEffect = todoActivationEffect(scan, targets, publicRelative, markdownBefore, rendered, resurrectedIds);
        activationBytesAfter = todoReconciliationActivationBytes(scan.retainedLegacyRows, String(preliminaryEffect.effect_sha256));
        targets.find((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH)!.after = activationBytesAfter;
        const effect = todoActivationEffect(scan, targets, publicRelative, markdownBefore, rendered, resurrectedIds);
        if (effect.effect_sha256 !== preliminaryEffect.effect_sha256) throw new Error("TODO activation effect authorization is not self-consistent");
        if (req.dryRun) return activationEnvelope(effect, true, false, null, (effect.targets as unknown[]).length, recovered);
        if (req.values.effect_sha256 !== effect.effect_sha256)
          reject({
            class: "conflict",
            message: "TODO activation effects changed after preview",
            syntax: TODO_ACTIVATION_PREVIEW_COMMAND,
            example: TODO_ACTIVATION_APPLY_COMMAND,
            recovery: `Rerun exactly '${TODO_ACTIVATION_PREVIEW_COMMAND}', review the changed bounded effects, then run its new exact apply_command; no state was changed.`,
          });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          activationEffectSha256: String(effect.effect_sha256),
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
              reject({ class: "conflict", message: "TODO reconciliation mapping changed during activation publication", recovery: "Preserve the changed docs mapping and retry activation after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid();
        return activationEnvelope(effect, false, false, transaction.id, transaction.targetCount, recovered);
      }
      if (req.spec.verb === "correct-owners") {
        if (activation) {
          if (!req.dryRun && activation.effect_operation === "correct-owners" && activation.effect_sha256 === req.values.effect_sha256 && activation.owner_mapping_sha256 === ownerEvidence!.sha256) {
            const replayEffect = todoOwnerCorrectionEffect({ counts: { matched: 0, converted: 0, retained: 0, duplicate: 0, stale: 0, conflicting: 0 }, items: [], omitted_count: 0 }, ownerEvidence!.sha256, [], publicRelative, markdownBefore, markdown);
            replayEffect.effect_sha256 = activation.effect_sha256!;
            return ownerCorrectionEnvelope(replayEffect, false, true, null, 0, recovered);
          }
          reject({ class: "conflict", message: "TODO owner correction requires marker-absent unsafe-inactive state", recovery: "Use state todo repair only for an unsafe active reconciliation, or retry the exact owner-correction apply command when its stored effect and owner mapping match; no state was changed." });
        }
        let unsafe = true;
        try {
          unsafe = !inactiveTodoActivationSafety(managedRows(markdown, null, todoEntities), todoEntities).safe;
        } catch {
          unsafe = true;
        }
        if (!unsafe) reject({ class: "conflict", message: "TODO owner correction requires marker-absent unsafe-inactive state", recovery: `Use '${TODO_ACTIVATION_PREVIEW_COMMAND}' for a safe inactive project; no state was changed.` });
        const plan = planTodoOwnerCorrection(markdown, todoEntities, ownerEvidence!);
        for (const [todoId, record] of plan.records) {
          const violations = recordViolations("todo", record, sourceRoot);
          if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations });
          if (record.readiness !== undefined)
            assertTodoReferences(
              todoId,
              record,
              [...plan.records].map(([entityId, entityRecord]) => ({ boundary: TODO.boundary, id: entityId, record: entityRecord })),
            );
        }
        let activationBytesAfter = todoReconciliationActivationBytes([], "0".repeat(64), "correct-owners", ownerEvidence!.sha256);
        const activationAfter = JSON.parse(activationBytesAfter) as TodoReconciliationActivation;
        const finalRows = managedRows(plan.rendered, activationAfter, todoEntities).rows;
        for (const [todoId, record] of plan.records) {
          const row = finalRows.get(todoId);
          plan.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
        }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
          path: entity.relativePath,
          before: exactDiscoveredEntityBytes(entity),
          after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: plan.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
        }));
        targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: plan.rendered });
        const preliminaryEffect = todoOwnerCorrectionEffect(plan.diagnosis, ownerEvidence!.sha256, targets, publicRelative, markdownBefore, plan.rendered);
        activationBytesAfter = todoReconciliationActivationBytes([], String(preliminaryEffect.effect_sha256), "correct-owners", ownerEvidence!.sha256);
        targets.find((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH)!.after = activationBytesAfter;
        const effect = todoOwnerCorrectionEffect(plan.diagnosis, ownerEvidence!.sha256, targets, publicRelative, markdownBefore, plan.rendered);
        if (effect.effect_sha256 !== preliminaryEffect.effect_sha256) throw new Error("TODO owner correction effect authorization is not self-consistent");
        if (req.dryRun) return ownerCorrectionEnvelope(effect, true, false, null, (effect.targets as unknown[]).length, recovered);
        if (req.values.effect_sha256 !== effect.effect_sha256)
          reject({
            class: "conflict",
            message: "TODO owner correction effects changed after preview",
            syntax: TODO_OWNER_CORRECTION_PREVIEW_COMMAND,
            example: TODO_OWNER_CORRECTION_APPLY_COMMAND,
            recovery: `Rerun exactly '${TODO_OWNER_CORRECTION_PREVIEW_COMMAND}', review the changed bounded effects, then run its new exact apply_command; no state was changed.`,
          });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          activationEffectSha256: String(effect.effect_sha256),
          ownerMappingSha256: ownerEvidence!.sha256,
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
              reject({ class: "conflict", message: "TODO reconciliation mapping changed during owner correction publication", recovery: "Preserve the changed docs mapping and retry owner correction after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid();
        return ownerCorrectionEnvelope(effect, false, false, transaction.id, transaction.targetCount, recovered);
      }
      if (req.spec.verb === "repair") {
        if (!activation || !loadedActivation) throw new Error("TODO repair lost its required activation marker");
        const plan = planTodoRepair(markdown, activation, todoEntities);
        let activationBytesAfter = todoReconciliationActivationBytes(plan.retainedLegacyRows, "0".repeat(64), "repair");
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
          path: entity.relativePath,
          before: exactDiscoveredEntityBytes(entity),
          after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: plan.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
        }));
        targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: loadedActivation.bytes, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: plan.rendered });
        const substantiveChange = targets.some((target) => target.path !== TODO_RECONCILIATION_ACTIVATION_PATH && (target.before === null || !target.before.equals(Buffer.from(target.after))));
        if (!req.dryRun && !substantiveChange && activation.effect_operation === "repair" && req.values.effect_sha256 === activation.effect_sha256) {
          const replayEffect = todoRepairEffect(plan.diagnosis, [], publicRelative, markdownBefore, markdown);
          replayEffect.effect_sha256 = activation.effect_sha256!;
          return repairEnvelope(replayEffect, false, true, null, 0, recovered);
        }
        const preliminaryEffect = todoRepairEffect(plan.diagnosis, targets, publicRelative, markdownBefore, plan.rendered);
        activationBytesAfter = todoReconciliationActivationBytes(plan.retainedLegacyRows, String(preliminaryEffect.effect_sha256), "repair");
        targets.find((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH)!.after = activationBytesAfter;
        const effect = todoRepairEffect(plan.diagnosis, targets, publicRelative, markdownBefore, plan.rendered);
        if (effect.effect_sha256 !== preliminaryEffect.effect_sha256) throw new Error("TODO repair effect authorization is not self-consistent");
        if (req.dryRun) return repairEnvelope(effect, true, false, null, (effect.targets as unknown[]).length, recovered);
        if (req.values.effect_sha256 !== effect.effect_sha256)
          reject({
            class: "conflict",
            message: "TODO repair effects changed after preview",
            syntax: TODO_REPAIR_PREVIEW_COMMAND,
            example: TODO_REPAIR_APPLY_COMMAND,
            recovery: `Rerun exactly '${TODO_REPAIR_PREVIEW_COMMAND}', review the changed bounded effects, then run its new exact apply_command; no state was changed.`,
          });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          activationEffectSha256: String(effect.effect_sha256),
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
              reject({ class: "conflict", message: "TODO reconciliation mapping changed during repair publication", recovery: "Preserve the changed docs mapping and retry repair after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid();
        return repairEnvelope(effect, false, false, transaction.id, transaction.targetCount, recovered);
      }
      const activating = activation === null;
      const scan = managedRows(markdown, activation, todoEntities);
      const rows = scan.rows;
      const reconciled = reconcileTodoRecords(todoEntities, rows, activating);
      if (createBatch) {
        if (!req.dryRun && (!req.values.confirmed || !SHA256.test(String(req.values.effect_sha256 ?? ""))))
          reject({ class: "invalid_request", message: "todo create batch apply requires its preview effect SHA-256 and --yes", recovery: "Run the same batch input with --dry-run, review it, then repeat that input with the returned --effect-sha256 value and --yes; no state was changed." });
        const inputSha256 = createHash("sha256")
          .update(canonicalRecordJson(req.input as JsonObject))
          .digest("hex");
        const prior = todoEntities.filter(({ record }) => mapping(record?.reconciliation) && mapping(record.reconciliation.create_batch) && record.reconciliation.create_batch.input_sha256 === inputSha256);
        if (prior.length) {
          const createReceipt = (prior[0]!.record!.reconciliation as JsonObject).create_batch as JsonObject;
          const localRefs = createReceipt.local_refs as Record<string, string>;
          if (prior.length !== createBatch.length || prior.some(({ id, record }) => canonicalRecordJson((record!.reconciliation as JsonObject).create_batch) !== canonicalRecordJson(createReceipt) || !Object.values(localRefs).includes(id!)) || req.values.effect_sha256 !== createReceipt.effect_sha256)
            reject({ class: "conflict", message: "existing TODO create batch receipt is incomplete or does not match this effect authorization", recovery: "Restore the complete original create batch result or use its exact input and effect SHA-256; no state was changed." });
          return {
            schemaVersion: "agentera.stateWrite.v1",
            command: "state todo create",
            status: "pass",
            artifact: "todo",
            records: createBatch.map(({ local_ref }) => {
              const id = localRefs[local_ref]!;
              return { local_ref, id, record: selectedById(todoEntities, "todo", id).record! };
            }),
            local_refs: localRefs,
            operation: { verb: "create", dry_run: false, idempotent_replay: true },
            validation: { status: "pass", violations: [] },
            effect_sha256: createReceipt.effect_sha256,
            apply_command: null,
            reconciliation: { transaction_id: null, targets: 0, recovered },
          };
        }
        const allocated = new Set<string>();
        const localIds = new Map<string, string>();
        for (const { local_ref } of createBatch) {
          let salt = 0;
          let id: string;
          do {
            const digest = createHash("sha256").update(inputSha256).update("\0").update(local_ref).update("\0").update(String(salt++)).digest();
            id = Array.from(digest.subarray(0, 10), (byte) => String.fromCharCode(97 + (byte % 26))).join("");
            try {
              id = allocateEntityId(context.pinnedPath(), () => id, sourceRoot);
            } catch (error) {
              if (!String((error as Error).message).includes("could not allocate")) throw error;
              continue;
            }
          } while (allocated.has(id));
          allocated.add(id);
          localIds.set(local_ref, id);
        }
        const resolved = resolveTodoCreateBatchRecords(createBatch, localIds);
        for (const { local_ref, record } of resolved) {
          const id = localIds.get(local_ref)!;
          reconciled.records.set(id, mutationRecord({ ...req, input: record, values: {}, callerPayload: record }, undefined));
          reconciled.visible.add(id);
        }
        const referenceEntities: TodoEntityView[] = [...reconciled.records].map(([todoId, record]) => ({ boundary: TODO.boundary, id: todoId, record }));
        for (const [todoId, record] of reconciled.records) {
          const violations = recordViolations("todo", record, sourceRoot);
          if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations, recovery: "Correct the batch record and preview the complete batch again; no state was changed." });
          if (record.readiness !== undefined) assertTodoReferences(todoId, record, referenceEntities);
        }
        const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId)));
        const rendered = renderManagedMarkdown(markdown, visibleRecords, rows);
        const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows);
        const activationAfter = activation ?? (JSON.parse(activationBytesAfter) as TodoReconciliationActivation);
        const finalRows = managedRows(rendered, activationAfter, [...todoEntities, ...[...localIds.values()].map((id) => ({ boundary: TODO.boundary, id, record: reconciled.records.get(id)! }) as DiscoveredEntity)]).rows;
        for (const [todoId, record] of reconciled.records) {
          const row = finalRows.get(todoId);
          reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
        }
        const localRefs = Object.fromEntries(localIds);
        const existingTargets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
          path: entity.relativePath,
          before: exactDiscoveredEntityBytes(entity),
          after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
        }));
        const newTargets: TodoReconciliationTarget[] = [...localIds.values()].map((id) => ({ path: relative(req.projectRoot, targetPath(req.projectRoot, sourceRoot, "todo", id)), before: null, after: "" }));
        const targets = [...existingTargets, ...newTargets];
        if (activating) targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
        const ordered = targets
          .filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after)))
          .sort((left, right) => Number(left.path === TODO_RECONCILIATION_ACTIVATION_PATH) - Number(right.path === TODO_RECONCILIATION_ACTIVATION_PATH) || Number(left.path === publicRelative) - Number(right.path === publicRelative) || left.path.localeCompare(right.path));
        let effectSha256 = todoCreateBatchEffectSha256(
          req.input as JsonObject,
          todoBinding!.mappingSha256,
          localRefs,
          ordered.filter((target) => !newTargets.includes(target)).map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") })),
        );
        const batchReceipt = { effect_sha256: effectSha256, input_sha256: inputSha256, local_refs: localRefs };
        for (const [localRef, id] of localIds) {
          const record = reconciled.records.get(id)!;
          record.reconciliation = { ...(record.reconciliation as JsonObject), create_batch: batchReceipt };
          newTargets.find((target) => target.path.endsWith(`/${id}.yaml`))!.after = canonicalEntityEnvelopeBytes({ id, artifact: "todo", record });
        }
        effectSha256 = todoCreateBatchEffectSha256(
          req.input as JsonObject,
          todoBinding!.mappingSha256,
          localRefs,
          ordered.filter((target) => !newTargets.includes(target)).map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") })),
        );
        batchReceipt.effect_sha256 = effectSha256;
        for (const [, id] of localIds) {
          const record = reconciled.records.get(id)!;
          (record.reconciliation as JsonObject).create_batch = batchReceipt;
          newTargets.find((target) => target.path.endsWith(`/${id}.yaml`))!.after = canonicalEntityEnvelopeBytes({ id, artifact: "todo", record });
        }
        const response = {
          schemaVersion: "agentera.stateWrite.v1",
          command: "state todo create",
          status: "pass",
          artifact: "todo",
          records: createBatch.map(({ local_ref }) => ({ local_ref, id: localIds.get(local_ref)!, record: reconciled.records.get(localIds.get(local_ref)!)! })),
          local_refs: localRefs,
          operation: { verb: "create", dry_run: req.dryRun, idempotent_replay: false },
          validation: { status: "pass", violations: [] },
          effect_sha256: effectSha256,
          apply_command: req.dryRun ? `agentera state todo create --input <same-input> --effect-sha256 ${effectSha256} --yes` : null,
        } as StateWriteEnvelope;
        if (req.dryRun) return { ...response, reconciliation: { transaction_id: null, targets: targets.length, recovered } };
        if (req.values.effect_sha256 !== effectSha256) reject({ class: "conflict", message: "TODO create batch effects changed after preview", recovery: "Rerun the same batch input with --dry-run, review the new bounded effect, then use its exact effect SHA-256; no state was changed." });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          createBatch: batchReceipt,
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
              reject({ class: "conflict", message: "TODO reconciliation mapping changed during create batch publication", recovery: "Preserve the changed docs mapping and retry after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid();
        return { ...response, reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
      }
      if (transitionBatch) {
        const verb = transitionBatch.verb;
        if (!req.dryRun && (!req.values.confirmed || !SHA256.test(String(req.values.effect_sha256 ?? ""))))
          reject({ class: "invalid_request", message: `todo ${verb} batch apply requires its preview effect SHA-256 and --yes`, recovery: "Run the same batch input with --dry-run, review it, then repeat that input with the returned --effect-sha256 value and --yes; no state was changed." });
        const inputSha256 = createHash("sha256")
          .update(canonicalRecordJson(req.input as JsonObject))
          .digest("hex");
        const priorReceipts = transitionBatch.entries.map(({ id }) => (mapping(reconciled.records.get(id)?.reconciliation) ? (reconciled.records.get(id)!.reconciliation as JsonObject).transition_batch : null));
        if (priorReceipts.every((receipt) => mapping(receipt) && receipt.input_sha256 === inputSha256 && receipt.verb === verb && receipt.effect_sha256 === req.values.effect_sha256)) {
          const divergent = transitionBatch.entries.find((entry, index) => !matchesTodoTransitionBatchPostState(reconciled.records.get(entry.id)!, priorReceipts[index] as JsonObject, entry, verb));
          if (divergent) reject({ class: "conflict", message: `TODO ${verb} batch member '${divergent.id}' no longer matches its authorized post-state`, recovery: "Preserve the current singleton result and preview a fresh batch from current state; no state was changed." });
          return {
            schemaVersion: "agentera.stateWrite.v1",
            command: `state todo ${verb}`,
            status: "pass",
            artifact: "todo",
            records: transitionBatch.entries.map(({ id }) => ({ id, record: reconciled.records.get(id)! })),
            operation: { verb, dry_run: false, idempotent_replay: true },
            validation: { status: "pass", violations: [] },
            effect_sha256: req.values.effect_sha256,
            apply_command: null,
            reconciliation: { transaction_id: null, targets: 0, recovered },
          };
        }
        for (const { id } of transitionBatch.entries) {
          selectedById(todoEntities, "todo", id);
          if (verb === "resolve" && reconciled.records.get(id)!.status !== "open") reject({ class: "conflict", message: "TODO resolve requires an open item", recovery: "Remove already-resolved items from the batch, then preview the complete open-item batch again; no state was changed." });
        }
        const requestedRecords: Array<{ id: string; record: JsonObject }> = [];
        for (const entry of transitionBatch.entries) {
          const values = { id: entry.id, ...(entry.severity ? { severity: entry.severity } : {}), lifecycle: { reason: entry.reason, date: entry.date } };
          const record = transitionRecord(
            { ...req, input: null, values, callerPayload: values },
            reconciled.records.get(entry.id)!,
            todoEntities.map((entity) => ({ ...entity, record: reconciled.records.get(entity.id!)! })),
          );
          reconciled.records.set(entry.id, record);
          requestedRecords.push({ id: entry.id, record });
        }
        for (const [todoId, record] of reconciled.records) {
          const violations = recordViolations("todo", record, sourceRoot);
          if (violations.length) reject({ class: "schema_violation", message: `todo ${verb} batch input is invalid`, violations, recovery: "Correct the complete batch and preview it again; no state was changed." });
        }
        const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId)));
        const rendered = renderManagedMarkdown(markdown, visibleRecords, rows);
        const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows);
        const activationAfter = activation ?? (JSON.parse(activationBytesAfter) as TodoReconciliationActivation);
        const finalRows = managedRows(rendered, activationAfter, todoEntities).rows;
        for (const [todoId, record] of reconciled.records) {
          const row = finalRows.get(todoId);
          reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
        }
        for (const { id } of transitionBatch.entries) {
          const reconciliation = reconciled.records.get(id)!.reconciliation as JsonObject;
          delete reconciliation.transition_batch;
        }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
          path: entity.relativePath,
          before: exactDiscoveredEntityBytes(entity),
          after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
        }));
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
        const effectTargets = targets.filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after))).sort((left, right) => Number(left.path === publicRelative) - Number(right.path === publicRelative) || left.path.localeCompare(right.path));
        const effectSha256 = todoUpdateBatchEffectSha256(
          req.input as JsonObject,
          todoBinding!.mappingSha256,
          effectTargets.map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") })),
        );
        const response = {
          schemaVersion: "agentera.stateWrite.v1",
          command: `state todo ${verb}`,
          status: "pass",
          artifact: "todo",
          records: requestedRecords.map(({ id }) => ({ id, record: reconciled.records.get(id)! })),
          operation: { verb, dry_run: req.dryRun, idempotent_replay: false },
          validation: { status: "pass", violations: [] },
          effect_sha256: effectSha256,
          apply_command: req.dryRun ? `agentera state todo ${verb} --input <same-input> --effect-sha256 ${effectSha256} --yes` : null,
        } as StateWriteEnvelope;
        if (req.dryRun) return { ...response, reconciliation: { transaction_id: null, targets: targets.length, recovered } };
        if (req.values.effect_sha256 !== effectSha256) reject({ class: "conflict", message: `TODO ${verb} batch effects changed after preview`, recovery: "Rerun the same batch input with --dry-run, review the new bounded effect, then use its exact effect SHA-256; no state was changed." });
        for (const { id } of transitionBatch.entries) {
          const record = reconciled.records.get(id)!;
          record.reconciliation = { ...(record.reconciliation as JsonObject), transition_batch: { verb, input_sha256: inputSha256, effect_sha256: effectSha256, post_state_sha256: todoTransitionBatchPostStateSha256(record) } };
          const target = targets.find(({ path }) => path.endsWith(`/${id}.yaml`))!;
          target.after = canonicalEntityEnvelopeBytes({ id, artifact: "todo", record });
        }
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          updateBatchEffectSha256: effectSha256,
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
              reject({ class: "conflict", message: `TODO reconciliation mapping changed during ${verb} batch publication`, recovery: "Preserve the changed docs mapping and retry after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid();
        return { ...response, records: transitionBatch.entries.map(({ id }) => ({ id, record: reconciled.records.get(id)! })), reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
      }
      if (batch) {
        if (!req.dryRun && (!req.values.confirmed || !SHA256.test(String(req.values.effect_sha256 ?? ""))))
          reject({ class: "invalid_request", message: "todo update batch apply requires its preview effect SHA-256 and --yes", recovery: "Run the same batch input with --dry-run, review it, then repeat that input with the returned --effect-sha256 value and --yes; no state was changed." });
        const requestedRecords: Array<{ id: string; record: JsonObject }> = [];
        for (const { id, patch } of batch) {
          selectedById(todoEntities, "todo", id);
          const record = mutationRecord(
            { ...req, input: patch, values: { id }, callerPayload: patch },
            reconciled.records.get(id)!,
            todoEntities.map((entity) => ({ ...entity, record: reconciled.records.get(entity.id!)! })),
          );
          reconciled.records.set(id, record);
          requestedRecords.push({ id, record });
        }
        const referenceEntities: TodoEntityView[] = [...reconciled.records].map(([todoId, record]) => ({ boundary: TODO.boundary, id: todoId, record }));
        for (const [todoId, record] of reconciled.records) {
          const violations = recordViolations("todo", record, sourceRoot);
          if (violations.length) reject({ class: "schema_violation", message: "todo entity input is invalid", violations, recovery: "Correct the batch patch and preview the complete batch again; no state was changed." });
          if (record.readiness !== undefined) assertTodoReferences(todoId, record, referenceEntities);
        }
        const visibleRecords = new Map([...reconciled.records].filter(([todoId]) => reconciled.visible.has(todoId)));
        const rendered = renderManagedMarkdown(markdown, visibleRecords, rows);
        const activationBytesAfter = activation ? loadedActivation!.bytes.toString("utf8") : todoReconciliationActivationBytes(scan.retainedLegacyRows);
        const activationAfter = activation ?? (JSON.parse(activationBytesAfter) as TodoReconciliationActivation);
        const finalRows = managedRows(rendered, activationAfter, todoEntities).rows;
        for (const [todoId, record] of reconciled.records) {
          const row = finalRows.get(todoId);
          reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
        }
        const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
          path: entity.relativePath,
          before: exactDiscoveredEntityBytes(entity),
          after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
        }));
        if (activating) targets.push({ path: TODO_RECONCILIATION_ACTIVATION_PATH, before: null, after: activationBytesAfter });
        targets.push({ path: publicRelative, before: publicExists ? markdownBefore : null, after: rendered });
        const effectTargets = targets.filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after))).sort((left, right) => Number(left.path === publicRelative) - Number(right.path === publicRelative) || left.path.localeCompare(right.path));
        const effectSha256 = todoUpdateBatchEffectSha256(
          req.input as JsonObject,
          todoBinding!.mappingSha256,
          effectTargets.map((target) => ({ path: target.path, before_sha256: target.before === null ? null : createHash("sha256").update(target.before).digest("hex"), after_sha256: createHash("sha256").update(target.after).digest("hex") })),
        );
        const applyCommand = `agentera state todo update --input <same-input> --effect-sha256 ${effectSha256} --yes`;
        const response = {
          schemaVersion: "agentera.stateWrite.v1",
          command: "state todo update",
          status: "pass",
          artifact: "todo",
          records: requestedRecords.map(({ id }) => ({ id, record: reconciled.records.get(id)! })),
          operation: { verb: "update", dry_run: req.dryRun, idempotent_replay: false },
          validation: { status: "pass", violations: [] },
          effect_sha256: effectSha256,
          apply_command: req.dryRun ? applyCommand : null,
        } as StateWriteEnvelope;
        if (req.dryRun) return { ...response, reconciliation: { transaction_id: null, targets: targets.length, recovered } };
        if (req.values.effect_sha256 !== effectSha256) reject({ class: "conflict", message: "TODO update batch effects changed after preview", recovery: "Rerun the same batch input with --dry-run, review the new bounded effect, then use its exact effect SHA-256; no state was changed." });
        const transaction = publishTodoReconciliation(context, sourceRoot, todoBinding!, targets, {
          updateBatchEffectSha256: effectSha256,
          interruptAfterTarget: options.interruptAfterTarget,
          beforeCommit: () => {
            assertState(pinnedRoot, sourceRoot, sourceBinding);
            const currentBinding = todoReconciliationBinding(req.projectRoot, sourceRoot);
            if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
              reject({ class: "conflict", message: "TODO reconciliation mapping changed during batch publication", recovery: "Preserve the changed docs mapping and retry after every transaction target is restored; no mapping bytes were overwritten." });
          },
        });
        context.assertValid();
        return { ...response, reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
      }
      let id: string;
      let requested: JsonObject;
      let selected: DiscoveredEntity | undefined;
      if (req.spec.verb === "create") {
        if (req.input) {
          const inputViolations = todoInputViolations(req.input as JsonObject, "create");
          if (inputViolations.length) reject({ class: "schema_violation", message: "todo create input is invalid", violations: inputViolations, recovery: todoReadinessRecovery(req.spec.verb) });
        }
        id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot);
        requested = createRequest!;
        reconciled.records.set(id, requested);
        reconciled.visible.add(id);
      } else {
        id = String(req.values.id ?? "");
        if (!ID.test(id)) reject({ class: "invalid_request", message: `todo ID '${id}' must be ten lowercase letters`, recovery: "Use a bare todo ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid." });
        selected = selectedById(todoEntities, "todo", id);
        if (req.input && req.spec.verb === "update") {
          const inputViolations = todoInputViolations(req.input as JsonObject, "update");
          if (inputViolations.length) reject({ class: "schema_violation", message: "todo update input is invalid", violations: inputViolations, recovery: todoReadinessRecovery(req.spec.verb) });
        }
        requested = mutationRecord(
          req,
          reconciled.records.get(id)!,
          todoEntities.map((entity) => ({ ...entity, record: reconciled.records.get(entity.id!)! })),
        );
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
      const activationAfter = activation ?? (JSON.parse(activationBytesAfter) as TodoReconciliationActivation);
      const finalRows = managedRows(rendered, activationAfter, todoEntities).rows;
      for (const [todoId, record] of reconciled.records) {
        const row = finalRows.get(todoId);
        reconciled.records.set(todoId, withBaseline(record, row ? rowSnapshot(row, record) : { present: false }));
      }
      requested = reconciled.records.get(id)!;
      const targets: TodoReconciliationTarget[] = todoEntities.map((entity) => ({
        path: entity.relativePath,
        before: exactDiscoveredEntityBytes(entity),
        after: canonicalEntityEnvelopeBytes({ id: entity.id!, artifact: "todo", record: reconciled.records.get(entity.id!)!, migrationProvenance: entity.migrationProvenance ?? undefined }),
      }));
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
          if (currentBinding.publicPath !== todoBinding!.publicPath || currentBinding.mappingSha256 !== todoBinding!.mappingSha256)
            reject({ class: "conflict", message: "TODO reconciliation mapping changed during transaction publication", recovery: "Preserve the changed docs mapping and retry the exact TODO mutation after every transaction target is restored; no mapping bytes were overwritten." });
          const currentActivation = fs.existsSync(path.join(pinnedRoot, TODO_RECONCILIATION_ACTIVATION_PATH)) ? fs.readFileSync(path.join(pinnedRoot, TODO_RECONCILIATION_ACTIVATION_PATH)) : null;
          if (!currentActivation?.equals(Buffer.from(activationBytesAfter)))
            reject({ class: "conflict", message: "TODO reconciliation activation changed during transaction publication", recovery: `Preserve '${TODO_RECONCILIATION_ACTIVATION_PATH}' and retry the exact TODO mutation after every transaction target is restored; no competing activation bytes were overwritten.` });
        },
      });
      context.assertValid();
      return { ...envelope(`state todo ${req.spec.verb}`, { id, path: targetPath(req.projectRoot, sourceRoot, "todo", id), replay: !changed && recovered.length === 0 }, "todo", requested, false), reconciliation: { transaction_id: transaction.id, targets: transaction.targetCount, recovered } };
    }
    if (req.spec.verb === "create") {
      const record = mutationRecord(req, undefined, entities);
      const violations = recordViolations("docs", record, sourceRoot);
      if (violations.length) reject({ class: "schema_violation", message: "docs entity input is invalid", violations });
      const id = allocateEntityId(context.pinnedPath(), options.candidate, sourceRoot);
      if (req.dryRun) return envelope("state docs create", { id, path: targetPath(req.projectRoot, sourceRoot, "docs", id), replay: false }, "docs", record, true);
      let published: { path: string; publishedIdentity?: PublishedTargetIdentity } | undefined;
      try {
        const result = publishEntityUnderLock({ projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact: "docs", boundary: DOCS.boundary, id, record });
        published = result;
        assertState(pinnedRoot, sourceRoot, sourceBinding);
        context.assertValid();
        return envelope("state docs create", result, "docs", record, false);
      } catch (error) {
        if (published?.publishedIdentity) context.removeExact(relative(req.projectRoot, published.path), published.publishedIdentity, false);
        throw error;
      }
    }
    const id = String(req.values.id ?? "");
    if (!ID.test(id)) reject({ class: "invalid_request", message: `${artifact} ID '${id}' must be ten lowercase letters`, recovery: `Use a bare ${artifact} ID returned by create or list; numeric, prefixed, composite, path, and alias identities are invalid.` });
    const entity = selectedById(entities, artifact, id);
    const record = mutationRecord(req, entity.record!, entities);
    const violations = recordViolations("docs", record, sourceRoot);
    if (violations.length) reject({ class: "schema_violation", message: "docs entity input is invalid", violations });
    if (canonicalRecordJson(record) === canonicalRecordJson(entity.record)) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: true }, artifact, record, req.dryRun);
    if (req.dryRun) return envelope(`state ${artifact} ${req.spec.verb}`, { id, path: entity.path, replay: false }, artifact, record, true);
    const request = { projectRoot: req.projectRoot, sourceRoot, publicationContext: context, artifact, boundary: definition(artifact).boundary, id, expectedRecord: entity.record!, expectedBytes: exactDiscoveredEntityBytes(entity), migrationProvenance: entity.migrationProvenance, record };
    let replacement: { path: string; publishedIdentity?: PublishedTargetIdentity; previousBytes?: string } | undefined;
    try {
      const result = replaceEntityUnderLock(request);
      replacement = result;
      assertState(pinnedRoot, sourceRoot, sourceBinding);
      context.assertValid();
      return envelope(`state ${artifact} ${req.spec.verb}`, result, artifact, record, false);
    } catch (error) {
      if (replacement?.publishedIdentity && replacement.previousBytes !== undefined) context.restoreExact(relative(req.projectRoot, replacement.path), replacement.publishedIdentity, replacement.previousBytes, entityExactGetMaxBytes(sourceRoot));
      throw error;
    }
  });
}

function entry(root: string, entity: DiscoveredEntity, row?: ManagedRow, queueRank?: number, actionability?: TodoReadinessEvaluation, reconciliation?: JsonObject): JsonObject {
  const todo = entity.boundary === TODO.boundary;
  const itemDrift = todo && reconciliation && Array.isArray(reconciliation.items) ? reconciliation.items.find((item) => mapping(item) && item.id === entity.id) : undefined;
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
  const evaluations = evaluateTodoReadinessQueue(
    entities.map((entity) => {
      const row = view.rows.get(entity.id!);
      return { id: entity.id!, artifact: entity.artifact!, record: publicReadRecord(entity.record!, row), ...(projected ? { projectedOrder: row?.snapshot.order === undefined ? { kind: "absent" as const } : { kind: "managed" as const, markdownOrder: row.snapshot.order } } : {}) };
    }),
    sourceRoot,
  ).evaluations;
  return new Map(evaluations.map((value) => [value.id, value]));
}
function snapshot(root: string, entities: DiscoveredEntity[], rows?: Map<string, ManagedRow>): string {
  return createHash("sha256")
    .update(
      canonicalRecordJson(
        entities
          .map((entity) => ({ id: entity.id, boundary: entity.boundary, path: relative(root, entity.path), record: entity.record, ...(entity.id && rows?.has(entity.id) ? { public: rowSnapshot(rows.get(entity.id)!, entity.record!) } : {}) }))
          .sort((a, b) => canonicalRecordJson(a).localeCompare(canonicalRecordJson(b))),
      ),
    )
    .digest("hex");
}
function decodeCursor(token: string, root: string, authorityPath: string, artifact: "todo" | "docs", restart: string): JsonObject {
  try {
    return decodeListCursor(token, root, authorityPath);
  } catch {
    throw failure("cursor_invalid", artifact, `${artifact} cursor is malformed or belongs to another project`, restart);
  }
}

function sorted(artifact: "todo" | "docs", entities: DiscoveredEntity[], rows?: Map<string, ManagedRow>): DiscoveredEntity[] {
  const selected = entities.filter(({ boundary }) => boundary === definition(artifact).boundary);
  if (artifact === "docs") return selected.sort((a, b) => String(a.record!.path).localeCompare(String(b.record!.path)) || a.id!.localeCompare(b.id!));
  return selected.sort((a, b) => {
    const left = publicReadRecord(a.record!, rows?.get(a.id!));
    const right = publicReadRecord(b.record!, rows?.get(b.id!));
    return (
      TODO_SEVERITIES.indexOf(left.severity as (typeof TODO_SEVERITIES)[number]) - TODO_SEVERITIES.indexOf(right.severity as (typeof TODO_SEVERITIES)[number]) ||
      TODO_STATUSES.indexOf(left.status as (typeof TODO_STATUSES)[number]) - TODO_STATUSES.indexOf(right.status as (typeof TODO_STATUSES)[number]) ||
      (rows?.get(a.id!)?.snapshot.order ?? Number.MAX_SAFE_INTEGER) - (rows?.get(b.id!)?.snapshot.order ?? Number.MAX_SAFE_INTEGER) ||
      a.id!.localeCompare(b.id!)
    );
  });
}

export function getTodoDocsEntity(root: string, artifact: "todo" | "docs", id: string, sourceRoot = resolveSourceRoot()): JsonObject {
  if (artifact === "todo") assertTodoReconciliationReadable(root, sourceRoot, id);
  const entities = relevant(root, sourceRoot, artifact);
  const entity = selectedById(entities, artifact, id);
  const view = artifact === "todo" ? inspectTodoReadView(root, sourceRoot, entities) : null;
  const actionability = view ? todoActionability(sorted("todo", entities, view.rows), view, sourceRoot).get(id) : undefined;
  return {
    schemaVersion: "agentera.stateGet.v1",
    command: `state ${artifact} get`,
    status: "ok",
    entry: entry(root, entity, view?.rows.get(id), undefined, actionability, view?.drift),
    ...(view ? { reconciliation: view.drift } : {}),
    source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full_entity" },
  };
}

export function listTodoDocsEntities(root: string, artifact: "todo" | "docs", limit?: number, cursor?: string, filters: JsonObject = {}, options: { sourceRoot?: string; format?: string; reservedUtf8Bytes?: number; discovery?: EntityDiscoveryResult; selector?: EntityListSelectorInput } = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const declared = contract(definition(artifact).boundary, sourceRoot);
  const take = limit ?? declared.defaultLimit;
  if (artifact === "todo") assertTodoReconciliationReadable(root, sourceRoot);
  if (!Number.isSafeInteger(take) || take < 1 || take > declared.maximumLimit) throw failure("invalid_request", artifact, `${artifact} list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.", undefined, 2);
  const all = relevant(root, sourceRoot, artifact, options.discovery).filter(({ boundary }) => boundary === definition(artifact).boundary);
  const view = artifact === "todo" ? inspectTodoReadView(root, sourceRoot, all) : null;
  let selected = sorted(artifact, all, view?.rows);
  const queueRanks = artifact === "todo" ? new Map(selected.map((entity, index) => [entity.id!, index + 1])) : new Map<string, number>();
  const actionability = artifact === "todo" ? todoActionability(selected, view!, sourceRoot) : new Map<string, TodoReadinessEvaluation>();
  if (artifact === "todo")
    selected = selected.filter((entity) => {
      const record = publicReadRecord(entity.record!, view?.rows.get(entity.id!));
      return (!filters.severity || record.severity === filters.severity) && (!filters.status || record.status === filters.status);
    });
  if (artifact === "docs") selected = selected.filter((entity) => (!filters.status || entity.record!.status === filters.status) && (!filters.topic || [entity.record!.document, entity.record!.path, entity.record!.status].some((value) => String(value).toLowerCase().includes(String(filters.topic).toLowerCase()))));
  const format = options.format ?? "json";
  const outputBudget = declared.maxUtf8Bytes - (options.reservedUtf8Bytes ?? 0);
  if (outputBudget < 1024) throw failure("unsupported_state", artifact, `${artifact} singleton metadata leaves no room for a bounded entity view`, "Reduce the authority-owned singleton metadata within its declared artifact budget.");
  const projectionOptions = { family: artifact, artifact, boundary: definition(artifact).boundary, format, maxUtf8Bytes: outputBudget, selector: options.selector };
  const selector = resolveEntityListSelector(
    options.selector,
    selected.map((entity) => entry(root, entity, view?.rows.get(entity.id!), queueRanks.get(entity.id!), actionability.get(entity.id!), view?.drift)),
    projectionOptions,
  );
  const selectorKey = entityListSelectorKey(selector);
  const filterOrder = artifact === "todo" ? ["severity", "status"] : ["topic", "status"];
  const filterFlags = filterOrder.flatMap((name) => (filters[name] === undefined ? [] : [` --${name} ${shellQuoteArgument(filters[name])}`])).join("");
  const selectorFlags = entityListSelectorFlags(selector);
  const restart = `agentera state ${artifact} list${filterFlags}${selectorFlags} --limit ${take}`;
  const snap = snapshot(root, all, view?.rows);
  let start = 0;
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
      if (value.snapshot_id !== snap || value.order !== DOCS.order || canonicalRecordJson(value.filters) !== canonicalRecordJson(filters))
        throw failure("cursor_snapshot_unavailable", artifact, `${artifact} state or filters changed after this cursor snapshot`, "Repeat the original filters, or omit --cursor to restart from current state.");
      const found = selected.findIndex(({ id }) => id === value.after);
      if (found < 0) throw failure("cursor_snapshot_unavailable", artifact, `${artifact} cursor continuation is unavailable`, "Omit --cursor to restart.");
      start = found + 1;
    }
  }
  const page = selected.slice(start, start + take);
  const response = (): JsonObject => {
    const remaining = selected.length - start - page.length;
    const next = remaining && page.length ? encodeListCursor({ snapshot_id: snap, order: definition(artifact).order, filters, selector: selectorKey, after: page.at(-1)!.id!, ...(artifact === "todo" ? { limit: take } : {}) }, root, declared.authorityPath) : undefined;
    return {
      schemaVersion: "agentera.stateList.v1",
      command: `state ${artifact} list`,
      status: remaining ? "degraded" : "ok",
      entries: page.map((entity) => entry(root, entity, view?.rows.get(entity.id!), queueRanks.get(entity.id!), actionability.get(entity.id!), view?.drift)),
      ...(view ? { reconciliation: view.drift } : {}),
      counts: { total: selected.length, returned: page.length, remaining },
      order: definition(artifact).order,
      filters,
      snapshot: { id: snap, first_page: !cursor, has_more: Boolean(remaining), candidate_count: selected.length },
      source: { artifact, authority: "canonical_entity_files", root: declared.entityRoot },
      source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "full", cursor: "opaque_snapshot_cursor" },
      retrieval: { ...(next ? { continue: `agentera state ${artifact} list${filterFlags}${selectorFlags} --limit ${take} --cursor ${next}` } : {}) },
      ...(remaining ? { omitted: true, omitted_count: remaining, omission_reason: "page_limit", next_cursor: next } : {}),
    };
  };
  return projectEntityList(response(), selector, projectionOptions);
}
