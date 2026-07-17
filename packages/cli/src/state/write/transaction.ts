import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { splitLinesKeepEnds, unifiedDiff } from "../../core/difflib.js";
import { dumpYamlMapping, loadYamlMapping } from "../../core/yaml.js";
import {
  compactYamlFile,
  decisionProtectedOverflowCount,
  type CompactResult,
} from "../../hooks/compaction/index.js";
import {
  assertRealpathBoundary,
  loadArtifactRegistry,
  resolveArtifactPath,
} from "../../registries/artifactRegistry.js";
import {
  StateMutationTransaction,
  type StateMutationOptions,
  withStateMutation,
} from "./mutation.js";
import { nextEntryNumber } from "./assign.js";
import type { StateWriteEnvelope, StateWriteRequest, WritableArtifact } from "./operations.js";
export type { StateWriteRequest, StateWriteEnvelope } from "./operations.js";
import { mutateCandidate, normalizedDecisionPayload } from "./candidateMutation.js";
import { array, findByNumber, mapping, schemaViolation } from "./helpers.js";
import { reject } from "./errors.js";
import { validateArtifactBytes } from "./validate.js";
import {
  planEvaluationViolations,
  validatePlanCreateInput,
  validatePlanPublicationCandidate,
} from "./planPublication.js";
import { dependencyReadyTasks } from "../../cli/capabilityContext/planState.js";
import type { JsonObject } from "../../core/jsonValue.js";
import {
  publishImmutableFile,
  type ArchivePublicationResult,
} from "../archivePublication.js";
import { findArchivedReplay } from "../archiveReplay.js";
import { discoverNumberedArchives } from "../archiveDiscovery.js";
import {
  hydrateDecisionRecords,
  updateDecisionOverlay,
} from "../decisionOverlay.js";
import { dispatchDecisionAmendment } from "../decisionRevisionPublication.js";
import {
  decisionLegacyCoexistence,
  gateCandidateDecisions,
  gateCompactedDecisions,
  gateExistingDecisions,
} from "../decisionLegacyValidation.js";
import { repairHealthProjectionBytes } from "../healthRepair.js";
import { executeExperimentPublication } from "./experimentPublication.js";
import { detectStateModeBinding } from "../stateMode.js";
import { appendProgressEntity } from "../progressEntities.js";
import { amendDecisionEntity, appendDecisionEntity, updateDecisionSatisfactionEntity } from "../decisionEntities.js";
import { appendHealthEntity } from "../healthEntities.js";

function readExisting(target: string): { doc: Record<string, unknown>; bytes: string } {
  if (!fs.existsSync(target)) return { doc: {}, bytes: "" };
  const bytes = fs.readFileSync(target, "utf8");
  try {
    return { doc: loadYamlMapping(bytes), bytes };
  } catch (error) {
    throw new Error(
      `cannot parse existing artifact '${target}': ${(error as Error).message}; run agentera check validate artifact before retrying`,
    );
  }
}

function activeKey(artifact: WritableArtifact): string {
  return artifact === "progress"
    ? "cycles"
    : artifact === "decisions"
      ? "decisions"
      : artifact === "health"
        ? "audits"
        : artifact === "experiments"
          ? "experiments"
        : "tasks";
}

function stateSlice(
  artifact: WritableArtifact,
  doc: Record<string, unknown>,
  archivePath?: string,
): Record<string, unknown> {
  if (artifact === "plan") {
    const tasks = array(doc, "tasks");
    return {
      title: mapping(doc.header).title ?? doc.title ?? null,
      status: mapping(doc.header).status ?? doc.status ?? null,
      task_count: tasks.length,
      next_pending_task:
        dependencyReadyTasks(tasks as unknown as JsonObject[]).find((task) => task.status === "pending") ?? null,
      ...(archivePath ? { archive_path: archivePath } : {}),
    };
  }
  const active = array(doc, activeKey(artifact));
  const archive = Array.isArray(doc.archive) ? doc.archive : [];
  return {
    active_count: active.length,
    archive_count: archive.length,
    next_number: nextEntryNumber(doc, activeKey(artifact)),
    ...(archivePath ? { archive_path: archivePath } : {}),
  };
}

function diffText(before: string, after: string, target: string): string {
  return unifiedDiff(splitLinesKeepEnds(before), splitLinesKeepEnds(after), target, target).join(
    "",
  );
}

function slug(value: unknown): string {
  return (
    String(value ?? "plan")
      .replace(/^Plan:\s*/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "plan"
  );
}

function assertWriterBoundary(projectRoot: string, candidate: string, artifactId: string): void {
  try {
    assertRealpathBoundary(projectRoot, candidate, artifactId);
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("artifact '")) reject({ class: "unsupported_target", message });
    throw error;
  }
}

function archivePathFor(projectRoot: string, target: string, doc: Record<string, unknown>, bytes: string): string {
  const header = mapping(doc.header);
  const created = String(header.created ?? "undated").replace(/[^0-9-]/g, "") || "undated";
  const title = header.title ?? doc.title;
  // Archive identity must survive a retry that crosses a calendar boundary.
  const identity = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const archivePath = path.join(
    path.dirname(target),
    "archive",
    `PLAN-${created}-${slug(title)}-${identity}.yaml`,
  );
  assertWriterBoundary(projectRoot, archivePath, "plan archive");
  return archivePath;
}

function decisionRecordForUpdate(
  projectRoot: string,
  doc: Record<string, unknown>,
  number: number,
): Record<string, unknown> | null {
  const current = findByNumber(array(doc, "decisions"), number) ?? findByNumber(array(doc, "archive"), number);
  if (current) return current;
  const archived = discoverNumberedArchives(projectRoot).entries.find(
    (entry) => entry.artifactId === "decisions" && entry.entryNumber === number,
  );
  return archived?.record ?? null;
}

function latestArchivePath(archiveDirectory: string): string | null {
  if (!fs.existsSync(archiveDirectory)) return null;
  const latest = fs
    .readdirSync(archiveDirectory)
    .filter((name) => name.startsWith("PLAN-") && name.endsWith(".yaml"))
    .sort()
    .at(-1);
  return latest ? path.join(archiveDirectory, latest) : null;
}

function canonicalPlanDocumentForWrite(doc: Record<string, unknown>): Record<string, unknown> {
  const header = mapping(doc.header);
  const status = String(header.status ?? "");
  if (status !== "active" && status !== "completed") return doc;
  const canonicalStatus =
    status === "active" || array(doc, "tasks").some((task) => task.status !== "complete")
      ? "open"
      : "complete";
  return { ...doc, header: { ...header, status: canonicalStatus } };
}

function canonicalPlanDocumentForArchive(doc: Record<string, unknown>): Record<string, unknown> {
  const candidate = structuredClone(doc);
  const tasks = array(candidate, "tasks");
  const complete = tasks.length > 0 && tasks.every((task) => task.status === "complete");
  candidate.header = { ...mapping(candidate.header), status: complete ? "complete" : "open" };
  return candidate;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensureArchive(archivePath: string, bytes: string): boolean {
  return publishImmutableFile(archivePath, bytes, {
    onExisting: () => {
      if (fs.readFileSync(archivePath, "utf8") !== bytes)
        reject({
          class: "conflict",
          message: `archive path '${archivePath}' already exists with different content; historical archives are immutable`,
        });
    },
  });
}

function publishStagedPlan(stage: string, target: string): void {
  fs.renameSync(stage, target);
  fsyncDirectory(path.dirname(target));
}

function removeCurrentPlan(target: string): void {
  fs.unlinkSync(target);
  fsyncDirectory(path.dirname(target));
}

function stagingPath(req: StateWriteRequest, target: string): string {
  const dir = req.dryRun ? path.join(req.projectRoot, ".agentera") : path.dirname(target);
  if (!req.dryRun) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `.${path.basename(target)}.writer.${process.pid}.${Date.now()}.tmp`);
}

function planLifecycle(
  req: StateWriteRequest,
  target: string,
  existing: { doc: Record<string, unknown>; bytes: string },
  legacyLifecycle = false,
): StateWriteEnvelope {
  if (req.spec.verb === "archive") {
    const archiveDir = path.join(path.dirname(target), "archive");
    assertWriterBoundary(req.projectRoot, archiveDir, "plan archive");
    if (!existing.bytes) {
      const archivePath = latestArchivePath(archiveDir);
      if (!archivePath)
        reject({ class: "unsupported_target", message: "no active plan exists to archive" });
      const archived = readExisting(archivePath);
      return envelope(req, target, {}, mapping(archived.doc.header), {}, true, null, {
        archivePath,
        ...(req.dryRun ? { diff: "", before: {}, after: {} } : {}),
      });
    }
    const status = String(mapping(existing.doc.header).status ?? existing.doc.status ?? "");
    const incomplete =
      status !== "complete" ||
      array(existing.doc, "tasks").some((task) => task.status !== "complete");
    if (incomplete && !req.force)
      reject({
        class: "conflict",
        message: `active plan "${mapping(existing.doc.header).title ?? existing.doc.title ?? "untitled"}" has status ${status || "unknown"} or incomplete tasks; archiving would discard incomplete work`,
        syntax: "agentera state plan archive --force",
      });
    const preserveExactBytes = req.force && !legacyLifecycle;
    const archiveDoc = preserveExactBytes ? existing.doc : canonicalPlanDocumentForArchive(existing.doc);
    const archiveBytes = preserveExactBytes ? existing.bytes : dumpYamlMapping(archiveDoc);
    const archivePath = archivePathFor(req.projectRoot, target, archiveDoc, archiveBytes);
    const predecessorValidation = validatePlanPublicationCandidate(archiveBytes, {
      allowHistoricalBudgetOverflow: req.force,
    });
    if (!req.dryRun) {
      // Archive creation and current-plan removal cannot be one filesystem transaction.
      // The durable archive is published first; retries remove the current plan only after
      // they observe that exact immutable archive.
      ensureArchive(archivePath, archiveBytes);
      removeCurrentPlan(target);
    }
    return envelope(req, target, {}, mapping(archiveDoc.header), {}, false, null, {
      archivePath,
      diff: diffText(existing.bytes, "", target),
      before: existing.doc,
      after: {},
      validationDiagnostics: predecessorValidation.diagnostics,
    });
  }
  const input = structuredClone(req.input ?? {});
  validatePlanCreateInput(input);
  const candidateStatus = String(mapping(input.header).status ?? input.status ?? "");
  if (!candidateStatus)
    reject({ class: "schema_violation", message: "plan create input requires header.status" });
  let archivePath: string | undefined;
  let predecessorBytes: string | null = null;
  if (existing.bytes) {
    const oldStatus = String(mapping(existing.doc.header).status ?? existing.doc.status ?? "");
    const existingWithoutLineage = structuredClone(existing.doc);
    delete existingWithoutLineage.previous_plan_archived;
    const existingHeader = mapping(existingWithoutLineage.header);
    delete existingHeader.id;
    existingWithoutLineage.header = existingHeader;
    const sameWithoutLineage = isDeepStrictEqual(existingWithoutLineage, input);
    if (sameWithoutLineage && !legacyLifecycle) {
      const predecessorBytes = req.force ? existing.bytes : dumpYamlMapping(existing.doc);
      const predecessorValidation = validatePlanPublicationCandidate(predecessorBytes, {
        allowHistoricalBudgetOverflow: req.force,
      });
      return envelope(
        req,
        target,
        existing.doc,
        mapping(existing.doc.header),
        {},
        true,
        null,
        req.dryRun
          ? {
              diff: "",
              before: existing.doc,
              after: existing.doc,
              validationDiagnostics: predecessorValidation.diagnostics,
            }
          : { validationDiagnostics: predecessorValidation.diagnostics },
      );
    }
    if (!sameWithoutLineage) {
      if (oldStatus !== "complete" && !req.force)
        reject({
          class: "conflict",
          message: `active plan "${mapping(existing.doc.header).title ?? existing.doc.title ?? "untitled"}" has status ${oldStatus || "unknown"}; replacing it would discard incomplete work`,
        });
      predecessorBytes = req.force && !legacyLifecycle ? existing.bytes : dumpYamlMapping(existing.doc);
      archivePath = archivePathFor(req.projectRoot, target, existing.doc, predecessorBytes);
      input.previous_plan_archived = path.relative(req.projectRoot, archivePath);
    }
  }
  input.header = { ...mapping(input.header), id: `plan:${randomUUID()}` };
  const bytes = dumpYamlMapping(input);
  const predecessorValidation = predecessorBytes
    ? validatePlanPublicationCandidate(predecessorBytes, { allowHistoricalBudgetOverflow: req.force })
    : { diagnostics: [] };
  validatePlanPublicationCandidate(bytes);
  const finalDoc = loadYamlMapping(bytes);
  if (!req.dryRun) {
    const stage = stagingPath(req, target);
    try {
      fs.writeFileSync(stage, bytes);
      // Archive and current replacement are deliberately two durable operations. If the
      // process stops between them, retry sees the exact archive and converges on this plan.
      if (predecessorBytes && archivePath) ensureArchive(archivePath, predecessorBytes);
      publishStagedPlan(stage, target);
    } finally {
      try {
        fs.unlinkSync(stage);
      } catch {
        /* published or already removed */
      }
    }
  }
  return envelope(req, target, finalDoc, mapping(finalDoc.header), {}, false, null, {
    archivePath,
    diff: diffText(existing.bytes, bytes, target),
    before: existing.doc,
    after: finalDoc,
    validationDiagnostics: predecessorValidation.diagnostics,
  });
}

function envelope(
  req: StateWriteRequest,
  target: string,
  finalDoc: Record<string, unknown>,
  written: Record<string, unknown>,
  assigned: Record<string, unknown>,
  replay: boolean,
  compaction: CompactResult | null,
  extra: {
    archivePath?: string;
    protectedOverflowCount?: number;
    validationDiagnostics?: string[];
    compatibilityCaveats?: ReturnType<typeof gateExistingDecisions>;
    diff?: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  } = {},
): StateWriteEnvelope {
  const result: StateWriteEnvelope = {
    schemaVersion: "agentera.stateWrite.v1",
    command: `state ${req.artifact} ${req.spec.verb}`,
    status: "pass",
    artifact: req.artifact,
    path: target,
    operation: {
      verb: req.spec.verb,
      dry_run: req.dryRun,
      idempotent_replay: replay,
      forced: req.force,
    },
    assigned,
    written,
    state: stateSlice(req.artifact, finalDoc, extra.archivePath),
    validation: {
      status: "pass",
      violations: [],
      ...(extra.validationDiagnostics && extra.validationDiagnostics.length > 0
        ? { diagnostics: extra.validationDiagnostics }
        : {}),
    },
    ...(extra.compatibilityCaveats?.length
      ? { compatibility: { legacy_caveats: extra.compatibilityCaveats } } : {}),
    compaction:
      compaction && req.artifact === "decisions"
        ? { ...compaction, protected_overflow_count: extra.protectedOverflowCount ?? 0 }
        : compaction,
  };
  if (req.dryRun && extra.diff !== undefined) {
    result.diff = extra.diff;
    result.before = extra.before ?? {};
    result.after = extra.after ?? finalDoc;
  }
  return result;
}

export function executeStateWrite(
  req: StateWriteRequest,
  options: StateMutationOptions = {},
): StateWriteEnvelope {
  const progressMode = req.artifact === "progress" && req.spec.verb === "append"
    ? detectStateModeBinding(req.projectRoot)
    : null;
  const decisionMode = req.artifact === "decisions" && ["append", "update", "amend"].includes(req.spec.verb)
    ? detectStateModeBinding(req.projectRoot)
    : null;
  const healthMode = req.artifact === "health" && ["append", "repair"].includes(req.spec.verb)
    ? detectStateModeBinding(req.projectRoot)
    : null;
  if (progressMode?.mode === "entities") {
    try {
      return appendProgressEntity(req, {
        publicationContext: progressMode.publicationContext,
      });
    } finally {
      progressMode.publicationContext.close();
    }
  }
  if (decisionMode?.mode === "entities") {
    try {
      const publicationContext = decisionMode.publicationContext;
      if (req.spec.verb === "append") return appendDecisionEntity(req, { publicationContext });
      if (req.spec.verb === "update") return updateDecisionSatisfactionEntity(req, { publicationContext });
      return amendDecisionEntity(req, { publicationContext });
    } finally {
      decisionMode.publicationContext.close();
    }
  }
  if (healthMode?.mode === "entities") {
    try {
      if (req.spec.verb === "repair") reject({
        class: "unsupported_target",
        message: "canonical health audit entities are immutable and cannot be row-deduplicated; run agentera check validate state to diagnose malformed or duplicate ownership before repairing entity files",
      });
      return appendHealthEntity(req, { publicationContext: healthMode.publicationContext });
    } finally {
      healthMode.publicationContext.close();
    }
  }
  if (req.artifact === "decisions" && req.spec.verb === "amend") {
    return dispatchDecisionAmendment(req, options);
  }
  assertWriterBoundary(req.projectRoot, path.join(req.projectRoot, ".agentera"), "writer lock");
  const planPublication =
    req.artifact === "plan" && ["archive", "create"].includes(req.spec.verb);
  if (req.dryRun && planPublication) return executeStateWriteUnlocked(req);
  return withStateMutation(
    req.projectRoot,
    (transaction) => executeStateWriteUnlocked(req, transaction),
    options,
    progressMode?.root ?? healthMode?.root,
  );
}

function executeStateWriteUnlocked(
  req: StateWriteRequest,
  transaction?: StateMutationTransaction,
): StateWriteEnvelope {
  if (req.artifact === "experiments" && req.spec.verb === "publish")
    return executeExperimentPublication(req, transaction);
  const record = loadArtifactRegistry().get(req.artifact);
  if (!record) throw new Error(`artifact '${req.artifact}' is not registered`);
  let target: string;
  try {
    target = resolveArtifactPath(record, req.projectRoot, { strictWrite: true });
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("artifact '")) reject({ class: "unsupported_target", message });
    throw error;
  }
  const existing = readExisting(target);
  const legacyLifecycle =
    req.artifact === "plan" && ["active", "completed"].includes(String(mapping(existing.doc.header).status ?? ""));
  if (legacyLifecycle) existing.doc = canonicalPlanDocumentForWrite(existing.doc);
  const decisionCoexistence = req.artifact === "decisions" ? decisionLegacyCoexistence() : null;
  let decisionLegacyCaveats: ReturnType<typeof gateExistingDecisions> = [];
  if (existing.bytes) {
    const validationBytes = req.artifact === "plan" ? dumpYamlMapping(existing.doc) : existing.bytes;
    const violations = validateArtifactBytes(req.artifact, validationBytes);
    if (violations.length) decisionLegacyCaveats = gateExistingDecisions(violations, existing.doc, decisionCoexistence, target);
    if (req.artifact === "plan") {
      const evaluationViolations = planEvaluationViolations(existing.doc);
      if (evaluationViolations.length > 0)
        throw new Error(
          `existing artifact '${target}' is schema-invalid: ${evaluationViolations.join("; ")}; repair it before retrying`,
        );
    }
  }
  if (req.artifact === "decisions" && req.spec.verb === "update") {
    const number = Number(req.values.number);
    if (!Number.isSafeInteger(number) || number < 1)
      reject({
        class: "schema_violation",
        message: "decision update requires a positive decision number",
        syntax: "agentera state decisions update --number N --satisfaction-state STATE --format json",
        example:
          "agentera state decisions update --number 53 --satisfaction-state open --format json",
      });
    const record = decisionRecordForUpdate(req.projectRoot, existing.doc, number);
    if (!record)
      reject({
        class: "unsupported_target",
        message: `no decision with number ${number}; numbered archive or current projection record is required`,
        syntax: "agentera state decisions update --number N --satisfaction-state STATE --format json",
        example:
          "agentera state decisions update --number 53 --satisfaction-state open --format json",
      });
    if (!transaction) throw new Error("state mutation transaction is unavailable");
    const update = updateDecisionOverlay(
      req.projectRoot,
      number,
      req.values.satisfaction,
      record.satisfaction,
      transaction,
      !req.dryRun,
    );
    const before = dumpYamlMapping(update.before);
    const after = dumpYamlMapping(update.after);
    return envelope(
      req,
      update.path,
      existing.doc,
      { satisfaction: update.satisfaction },
      { number },
      update.replay,
      null,
      { diff: diffText(before, after, update.path), before: update.before, after: update.after, compatibilityCaveats: decisionLegacyCaveats },
    );
  }
  if (req.artifact === "plan" && ["archive", "create"].includes(req.spec.verb))
    return planLifecycle(req, target, existing, legacyLifecycle);
  if (!existing.bytes && req.artifact === "plan")
    reject({
      class: "unsupported_target",
      message: "no active plan exists; create one before appending a task",
      example: "agentera state plan create --input plan.yaml",
    });
  const numberedAppend =
    req.spec.verb === "append" && ["progress", "decisions", "health"].includes(req.artifact);
  const replayPayload =
    req.artifact === "decisions"
      ? normalizedDecisionPayload(req.callerPayload)
      : req.callerPayload;
  const mutated = mutateCandidate(
    req,
    existing.doc,
    numberedAppend ? findArchivedReplay(req.projectRoot, req.artifact, replayPayload) : undefined,
  );
  if (mutated.replay && isDeepStrictEqual(mutated.candidate, existing.doc)) {
    let archive: ArchivePublicationResult | undefined;
    if (numberedAppend && !req.dryRun) {
      if (!transaction) throw new Error("state mutation transaction is unavailable");
      archive = transaction.publishArchive(
        req.artifact,
        Number(mutated.written.number),
        mutated.written as JsonObject,
      );
    }
    return envelope(
      req,
      target,
      mutated.candidate,
      mutated.written,
      mutated.assigned,
      true,
      null,
      {
        ...(archive ? { archivePath: archive.path } : {}),
        ...(req.dryRun ? { diff: "", before: existing.doc, after: mutated.candidate } : {}),
        compatibilityCaveats: decisionLegacyCaveats,
      },
    );
  }
  const repairedBytes = req.artifact === "health" && req.spec.verb === "repair"
    ? repairHealthProjectionBytes(existing.bytes, Number(req.values.number), req.values.keep === "last" ? "last" : "first")
    : null;
  if (repairedBytes && repairedBytes.removed === 0)
    reject({ class: "unsupported_target", message: `health audit ${Number(req.values.number)} has no duplicate current-history rows to repair` });
  const candidateBytes = repairedBytes?.bytes ?? dumpYamlMapping(mutated.candidate);
  const candidateViolations = validateArtifactBytes(req.artifact, candidateBytes);
  decisionLegacyCaveats = gateCandidateDecisions(candidateViolations, mutated.candidate, decisionCoexistence, Number(mutated.written.number), schemaViolation);
  const stage = req.dryRun
    ? stagingPath(req, target)
    : transaction?.stageProjection(target, candidateBytes);
  if (!stage) throw new Error("state mutation transaction is unavailable");
  let compaction: CompactResult | null = null;
  const protectedOverflowCount =
    req.artifact === "decisions"
      ? decisionProtectedOverflowCount(
          hydrateDecisionRecords(array(mutated.candidate, "decisions") as unknown as JsonObject[], req.projectRoot),
          hydrateDecisionRecords(array(mutated.candidate, "archive") as unknown as JsonObject[], req.projectRoot),
        )
      : 0;
  try {
    if (req.dryRun) fs.writeFileSync(stage, candidateBytes);
    if (req.spec.compacts) {
      compaction = compactYamlFile(stage, req.artifact, req.projectRoot);
    }
    const finalBytes = fs.readFileSync(stage, "utf8");
    const finalViolations = validateArtifactBytes(req.artifact, finalBytes);
    const finalDoc = loadYamlMapping(finalBytes);
    decisionLegacyCaveats = gateCompactedDecisions(finalViolations, finalDoc, decisionCoexistence, Number(mutated.written.number));
    if (!req.dryRun) transaction?.syncStaged(stage);
    const diff = diffText(existing.bytes, finalBytes, target);
    if (req.dryRun) {
      return envelope(
        req,
        target,
        finalDoc,
        mutated.written,
        mutated.assigned,
        false,
        compaction,
        { diff, before: existing.doc, after: finalDoc, protectedOverflowCount, compatibilityCaveats: decisionLegacyCaveats },
      );
    }
    const archive = numberedAppend
      ? transaction?.publishArchive(
          req.artifact,
          Number(mutated.written.number),
          mutated.written as JsonObject,
        )
      : undefined;
    if (!req.dryRun) transaction?.publishProjection(stage, target);
    return envelope(
      req,
      target,
      finalDoc,
      mutated.written,
      mutated.assigned,
      mutated.replay,
      compaction,
      { ...(archive ? { archivePath: archive.path } : {}), protectedOverflowCount, compatibilityCaveats: decisionLegacyCaveats },
    );
  } finally {
    try {
      if (req.dryRun) fs.unlinkSync(stage);
      else transaction?.removeStage(stage);
    } catch {
      /* stage published or absent */
    }
  }
}
