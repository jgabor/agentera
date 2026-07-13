import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { splitLinesKeepEnds, unifiedDiff } from "../../core/difflib.js";
import { dumpYamlMapping, loadYamlMapping } from "../../core/yaml.js";
import { lintFullArtifactPayload } from "../../cli/commands/lint.js";
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
import { localDate, localTimestamp, nextEntryNumber, nextTaskNumber } from "./assign.js";
import type { OperationSpec, WritableArtifact } from "./operations.js";
import { reject } from "./errors.js";
import { validateArtifactBytes } from "./validate.js";
import { dependencyReadyTasks } from "../../cli/capabilityContext/planState.js";
import type { JsonObject } from "../../core/jsonValue.js";
import {
  publishImmutableFile,
  type ArchivePublicationResult,
} from "../archivePublication.js";
import {
  findArchivedReplay,
  isExactArchiveReplay,
  recoverArchivedEntry,
} from "../archiveReplay.js";
import { discoverNumberedArchives } from "../archiveDiscovery.js";
import {
  updateDecisionOverlay,
} from "../decisionOverlay.js";

export interface StateWriteRequest {
  artifact: WritableArtifact;
  spec: OperationSpec;
  projectRoot: string;
  dryRun: boolean;
  force: boolean;
  values: Record<string, unknown>;
  callerPayload: Record<string, unknown>;
  input: Record<string, unknown> | null;
}

export interface StateWriteEnvelope extends Record<string, unknown> {
  schemaVersion: "agentera.stateWrite.v1";
  status: "pass";
}

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(doc: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return Array.isArray(doc[key])
    ? (doc[key] as unknown[]).filter((v): v is Record<string, unknown> =>
        Boolean(v && typeof v === "object" && !Array.isArray(v)),
      )
    : [];
}

function mappingPath(entry: Record<string, unknown>, field: string): unknown {
  let value: unknown = entry;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

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

function buildProgress(
  doc: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    number: nextEntryNumber(doc, "cycles"),
    timestamp: values.timestamp ?? localTimestamp(),
    type: values.type,
    phase: values.phase,
    what: values.what,
  };
  for (const field of ["inspiration", "discovered", "verified", "next"])
    if (values[field] !== undefined) entry[field] = values[field];
  const context: Record<string, unknown> = { intent: mappingPath(values, "context.intent") };
  for (const field of ["constraints", "unknowns", "scope"]) {
    const value = mappingPath(values, `context.${field}`);
    if (value !== undefined) context[field] = value;
  }
  entry.context = context;
  return entry;
}

function buildDecision(
  doc: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const alternatives = mapping(values.alternatives);
  const rejected = Array.isArray(alternatives.rejected) ? alternatives.rejected : [];
  const entry: Record<string, unknown> = {
    number: nextEntryNumber(doc, "decisions"),
    date: values.date ?? localDate(),
    question: values.question,
    context: values.context,
    alternatives: [
      { name: alternatives.chosen, status: "chosen" },
      ...rejected.map((name) => ({ name, status: "rejected" })),
    ],
    choice: values.choice,
    reasoning: values.reasoning,
    confidence: values.confidence,
  };
  if (values.feeds_into !== undefined) entry.feeds_into = values.feeds_into;
  return entry;
}

function normalizedDecisionPayload(values: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...values };
  const alternatives = mapping(values.alternatives);
  payload.alternatives = [
    { name: alternatives.chosen, status: "chosen" },
    ...(Array.isArray(alternatives.rejected) ? alternatives.rejected : []).map((name) => ({
      name,
      status: "rejected",
    })),
  ];
  return payload;
}

function schemaViolation(violations: string[]): never {
  reject({ class: "schema_violation", message: violations[0], violations });
}

function validatePlanPublicationCandidate(bytes: string): void {
  const lint = lintFullArtifactPayload("plan", bytes);
  const lintViolations = (lint.checks as Array<Record<string, string>>)
    .filter((check) => check.status === "fail")
    .map(
      (check) =>
        `strict prose lint ${check.name}: ${check.detail}; action: ${check.action}`,
    );
  const schemaViolations = validateArtifactBytes("plan", bytes).map(
    (violation) => `schema validation: ${violation}`,
  );
  const violations = [...lintViolations, ...schemaViolations];
  if (violations.length === 0) return;
  reject({
    class: "schema_violation",
    message: "plan publication candidate failed strict prose lint or schema validation; correct the reported violations and retry",
    violations,
    syntax: "agentera state plan create --input plan.yaml --format json",
    example: "agentera state plan create --input plan.yaml --format json",
  });
}

function findByNumber(
  entries: Record<string, unknown>[],
  number: number,
): Record<string, unknown> | undefined {
  return entries.find((entry) => Number(entry.number) === number);
}

function mutateCandidate(
  req: StateWriteRequest,
  doc: Record<string, unknown>,
  recovered?: Record<string, unknown>,
): {
  candidate: Record<string, unknown>;
  written: Record<string, unknown>;
  assigned: Record<string, unknown>;
  replay: boolean;
} {
  const candidate = structuredClone(doc);
  if (req.artifact === "progress") {
    const payload = req.callerPayload;
    const entries = array(candidate, "cycles");
    const replay = entries.find((entry) => isExactArchiveReplay(entry, payload));
    if (replay)
      return {
        candidate,
        written: replay,
        assigned: { number: replay.number, timestamp: replay.timestamp },
        replay: true,
      };
    if (recovered) {
      recoverArchivedEntry(candidate, "cycles", entries, recovered, true);
      return {
        candidate,
        written: recovered,
        assigned: { number: recovered.number, timestamp: recovered.timestamp },
        replay: true,
      };
    }
    const entry = buildProgress(candidate, req.values);
    candidate.cycles = [entry, ...entries];
    return {
      candidate,
      written: entry,
      assigned: { number: entry.number, timestamp: entry.timestamp },
      replay: false,
    };
  }
  if (req.artifact === "decisions" && req.spec.verb === "append") {
    const entries = array(candidate, "decisions");
    const payload = normalizedDecisionPayload(req.callerPayload);
    const replay = entries.find((entry) => isExactArchiveReplay(entry, payload));
    if (replay) {
      const entry = replay;
      return {
        candidate,
        written: entry,
        assigned: { number: entry.number, date: entry.date },
        replay: true,
      };
    }
    if (recovered) {
      recoverArchivedEntry(candidate, "decisions", entries, recovered, false);
      return {
        candidate,
        written: recovered,
        assigned: { number: recovered.number, date: recovered.date },
        replay: true,
      };
    }
    const entry = buildDecision(candidate, req.values);
    candidate.decisions = [...entries, entry];
    return {
      candidate,
      written: entry,
      assigned: { number: entry.number, date: entry.date },
      replay: false,
    };
  }
  if (req.artifact === "health") {
    if (req.input && ("audits" in req.input || "archive" in req.input)) {
      reject({
        class: "schema_violation",
        message: "health append input must be one audit entry, not a whole health artifact",
        violations: ["remove audits/archive wrapper fields"],
      });
    }
    const entries = array(candidate, "audits");
    const payload = req.callerPayload;
    const replay = entries.find((entry) => isExactArchiveReplay(entry, payload));
    if (replay) {
      const entry = replay;
      return {
        candidate,
        written: entry,
        assigned: { number: entry.number, date: entry.date },
        replay: true,
      };
    }
    if (recovered) {
      recoverArchivedEntry(candidate, "audits", entries, recovered, false);
      return {
        candidate,
        written: recovered,
        assigned: { number: recovered.number, date: recovered.date },
        replay: true,
      };
    }
    const entry = {
      number: nextEntryNumber(candidate, "audits"),
      date: req.input?.date ?? localDate(),
      ...req.input,
    };
    candidate.audits = [...entries, entry];
    return {
      candidate,
      written: entry,
      assigned: { number: entry.number, date: entry.date },
      replay: false,
    };
  }
  const tasks = array(candidate, "tasks");
  if (req.spec.verb === "append") {
    const sameName = tasks.find((task) => task.name === req.values.name);
    const payload = req.callerPayload;
    if (sameName) {
      if (isExactArchiveReplay(sameName, payload))
        return {
          candidate,
          written: sameName,
          assigned: { number: sameName.number },
          replay: true,
        };
      reject({
        class: "conflict",
        message: `plan task "${req.values.name}" exists with different fields; use 'state plan update --task ${sameName.number}' to modify it`,
      });
    }
    const entry: Record<string, unknown> = {
      number: nextTaskNumber(candidate),
      name: req.values.name,
      status: req.values.status ?? "pending",
    };
    for (const field of ["depends_on", "acceptance"])
      if (req.values[field] !== undefined) entry[field] = req.values[field];
    candidate.tasks = [...tasks, entry];
    return { candidate, written: entry, assigned: { number: entry.number }, replay: false };
  }
  if (req.spec.verb === "update") {
    const number = Number(req.values.task);
    const entry = findByNumber(tasks, number);
    if (!entry)
      reject({ class: "unsupported_target", message: `no plan task with number ${number}` });
    let changed = false;
    for (const field of [
      "name",
      "depends_on",
      "acceptance",
      "status",
      "evidence",
      "blocked_reason",
    ]) {
      if (req.values[field] !== undefined && !isDeepStrictEqual(entry[field], req.values[field])) {
        entry[field] = req.values[field];
        changed = true;
      }
    }
    if (req.values.surprise !== undefined) {
      const current = String(candidate.surprises ?? "").trim();
      const surprise = String(req.values.surprise);
      if (!current.split("\n").includes(surprise)) {
        candidate.surprises = current ? `${current}\n${surprise}` : surprise;
        changed = true;
      }
    }
    return { candidate, written: entry, assigned: { number }, replay: !changed };
  }
  if (req.spec.verb === "set-plan-status") {
    const status = String(req.values.status);
    if (status === "complete" && tasks.some((task) => task.status !== "complete")) {
      reject({
        class: "conflict",
        message: "plan cannot be marked complete while incomplete tasks remain",
      });
    }
    const header = mapping(candidate.header);
    const replay = header.status === status;
    header.status = status;
    candidate.header = header;
    return { candidate, written: header, assigned: {}, replay };
  }
  if (req.spec.verb === "set-status") {
    const taskNumber = Number(req.values.task);
    const status = String(req.values.status);
    if (!["complete", "in_progress", "pending", "blocked"].includes(status))
      reject({
        class: "invalid_choice",
        message: `argument --status: invalid choice: '${status}'`,
        valid_values: ["complete", "in_progress", "pending", "blocked"],
      });
    const entry = findByNumber(tasks, taskNumber);
    if (!entry)
      reject({ class: "unsupported_target", message: `no plan task with number ${taskNumber}` });
    const replay = entry.status === status;
    entry.status = status;
    return { candidate, written: entry, assigned: { number: taskNumber }, replay };
  }
  if (req.spec.verb === "record-evaluation") {
    const taskNumber = Number(req.values.task);
    const entry = findByNumber(tasks, taskNumber);
    if (!entry)
      reject({ class: "unsupported_target", message: `no plan task with number ${taskNumber}` });
    const evaluationInput = mapping(req.values.evaluation);
    const attemptId = String(evaluationInput.attempt_id ?? "").trim();
    const verdict = String(evaluationInput.verdict ?? "");
    const provenance = String(evaluationInput.provenance ?? "").trim();
    const failureEvidence = String(evaluationInput.failure_evidence ?? "").trim();
    if (!attemptId || !provenance)
      reject({ class: "schema_violation", message: "evaluation requires non-empty --attempt-id and --provenance" });
    if (verdict === "fail" && !failureEvidence)
      reject({ class: "schema_violation", message: "a failed evaluation requires non-empty --failure-evidence" });
    if (verdict === "pass" && failureEvidence)
      reject({ class: "schema_violation", message: "--failure-evidence applies only to a failed evaluation" });
    const prior = mapping(entry.evaluation);
    const priorProvenance = mapping(prior.provenance);
    if (priorProvenance.attempt_id === attemptId) {
      const replay =
        prior.last_verdict === verdict &&
        priorProvenance.source === provenance &&
        (verdict !== "fail" || prior.last_failure_evidence === failureEvidence);
      if (!replay)
        reject({
          class: "conflict",
          message: `evaluation attempt '${attemptId}' already exists with different result data`,
        });
      return {
        candidate,
        written: entry,
        assigned: { number: taskNumber, attempt_count: prior.attempt_count ?? 0 },
        replay: true,
      };
    }
    if (["complete", "blocked"].includes(String(entry.status ?? "")))
      reject({ class: "conflict", message: `plan task ${taskNumber} is ${entry.status} and cannot accept another evaluation` });
    const attemptCount = Number(prior.attempt_count ?? 0);
    const failureCount = Number(prior.failure_count ?? 0);
    if (!Number.isInteger(attemptCount) || attemptCount < 0 || !Number.isInteger(failureCount) || failureCount < 0)
      reject({ class: "schema_violation", message: `plan task ${taskNumber} has malformed evaluation state` });
    if (verdict === "fail" && failureCount >= 2)
      reject({ class: "conflict", message: `plan task ${taskNumber} has exhausted its evaluation retry budget` });
    const nextFailureCount = failureCount + (verdict === "fail" ? 1 : 0);
    entry.evaluation = {
      attempt_count: attemptCount + 1,
      failure_count: nextFailureCount,
      last_verdict: verdict,
      last_failure_evidence: verdict === "fail" ? failureEvidence : prior.last_failure_evidence ?? null,
      provenance: {
        attempt_id: attemptId,
        source: provenance,
        recorded_at: localTimestamp(),
        writer_command: "agentera state plan record-evaluation",
      },
    };
    if (nextFailureCount >= 2) entry.status = "blocked";
    return {
      candidate,
      written: entry,
      assigned: {
        number: taskNumber,
        attempt_count: attemptCount + 1,
        failure_count: nextFailureCount,
      },
      replay: false,
    };
  }
  throw new Error(`unsupported transaction ${req.artifact} ${req.spec.verb}`);
}

function activeKey(artifact: WritableArtifact): string {
  return artifact === "progress"
    ? "cycles"
    : artifact === "decisions"
      ? "decisions"
      : artifact === "health"
        ? "audits"
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

function validatePlanCreateInput(input: Record<string, unknown>): void {
  const tasks = array(input, "tasks");
  const numbers = tasks.map((task) => Number(task.number));
  const expected = tasks.map((_, index) => index + 1);
  if (!isDeepStrictEqual(numbers, expected)) {
    reject({
      class: "schema_violation",
      message: "plan create task numbers must be unique and sequential starting from 1",
      violations: ["PV1: task numbers must equal 1..N"],
    });
  }
  if (
    mapping(input.header).status === "complete" &&
    tasks.some((task) => task.status !== "complete")
  ) {
    reject({
      class: "schema_violation",
      message: "a complete plan cannot contain incomplete tasks",
      violations: ["header.status complete requires every task complete"],
    });
  }
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
    const archiveDoc = canonicalPlanDocumentForArchive(existing.doc);
    const archiveBytes = dumpYamlMapping(archiveDoc);
    const archivePath = archivePathFor(req.projectRoot, target, archiveDoc, archiveBytes);
    validatePlanPublicationCandidate(archiveBytes);
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
    const sameWithoutLineage = isDeepStrictEqual(existingWithoutLineage, input);
    if (sameWithoutLineage && !legacyLifecycle) {
      validatePlanPublicationCandidate(dumpYamlMapping(existing.doc));
      return envelope(
        req,
        target,
        existing.doc,
        mapping(existing.doc.header),
        {},
        true,
        null,
        req.dryRun ? { diff: "", before: existing.doc, after: existing.doc } : {},
      );
    }
    if (!sameWithoutLineage) {
      if (oldStatus !== "complete" && !req.force)
        reject({
          class: "conflict",
          message: `active plan "${mapping(existing.doc.header).title ?? existing.doc.title ?? "untitled"}" has status ${oldStatus || "unknown"}; replacing it would discard incomplete work`,
        });
      predecessorBytes = dumpYamlMapping(existing.doc);
      archivePath = archivePathFor(req.projectRoot, target, existing.doc, predecessorBytes);
      input.previous_plan_archived = path.relative(req.projectRoot, archivePath);
    }
  }
  const bytes = dumpYamlMapping(input);
  if (predecessorBytes) validatePlanPublicationCandidate(predecessorBytes);
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
    validation: { status: "pass", violations: [] },
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
  assertWriterBoundary(req.projectRoot, path.join(req.projectRoot, ".agentera"), "writer lock");
  const planPublication =
    req.artifact === "plan" && ["archive", "create"].includes(req.spec.verb);
  if (req.dryRun && planPublication) return executeStateWriteUnlocked(req);
  return withStateMutation(
    req.projectRoot,
    (transaction) => executeStateWriteUnlocked(req, transaction),
    options,
  );
}

function executeStateWriteUnlocked(
  req: StateWriteRequest,
  transaction?: StateMutationTransaction,
): StateWriteEnvelope {
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
  if (existing.bytes) {
    const validationBytes = req.artifact === "plan" ? dumpYamlMapping(existing.doc) : existing.bytes;
    const violations = validateArtifactBytes(req.artifact, validationBytes);
    if (violations.length) {
      throw new Error(
        `existing artifact '${target}' is schema-invalid: ${violations.join("; ")}; repair it before retrying`,
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
      { diff: diffText(before, after, update.path), before: update.before, after: update.after },
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
      },
    );
  }
  const candidateBytes = dumpYamlMapping(mutated.candidate);
  const candidateViolations = validateArtifactBytes(req.artifact, candidateBytes);
  if (candidateViolations.length) schemaViolation(candidateViolations);
  const stage = req.dryRun
    ? stagingPath(req, target)
    : transaction?.stageProjection(target, candidateBytes);
  if (!stage) throw new Error("state mutation transaction is unavailable");
  let compaction: CompactResult | null = null;
  const protectedOverflowCount =
    req.artifact === "decisions"
      ? decisionProtectedOverflowCount(
          array(mutated.candidate, "decisions"),
          array(mutated.candidate, "archive"),
        )
      : 0;
  const skipProtectedDecisionCompaction =
    req.artifact === "decisions" && req.spec.compacts && protectedOverflowCount > 0;
  try {
    if (req.dryRun) fs.writeFileSync(stage, candidateBytes);
    if (req.spec.compacts && !skipProtectedDecisionCompaction) {
      compaction = compactYamlFile(stage, req.artifact);
    } else if (skipProtectedDecisionCompaction) {
      const active = array(mutated.candidate, "decisions");
      const archive = array(mutated.candidate, "archive");
      compaction = {
        full_before: active.length,
        oneline_before: archive.length,
        full_after: active.length,
        oneline_after: archive.length,
        dropped: 0,
        changed: false,
        protected_overflow_count: protectedOverflowCount,
      };
    }
    const finalBytes = fs.readFileSync(stage, "utf8");
    const finalViolations = validateArtifactBytes(req.artifact, finalBytes);
    if (finalViolations.length)
      throw new Error(`writer/compactor invariant failure: ${finalViolations.join("; ")}`);
    if (!req.dryRun) transaction?.syncStaged(stage);
    const finalDoc = loadYamlMapping(finalBytes);
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
        { diff, before: existing.doc, after: finalDoc, protectedOverflowCount },
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
      { ...(archive ? { archivePath: archive.path } : {}), protectedOverflowCount },
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
