import { isDeepStrictEqual } from "node:util";

import {
  isExactArchiveReplay,
  recoverArchivedEntry,
} from "../archiveReplay.js";
import { repairHealthDuplicates } from "../healthRepair.js";
import { localDate, localTimestamp, nextEntryNumber, nextTaskNumber } from "./assign.js";
import { reject } from "./errors.js";
import { array, findByNumber, mapping, mappingPath } from "./helpers.js";
import type { StateWriteRequest } from "./operations.js";

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

export function mutateCandidate(
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
    if (req.spec.verb === "repair") {
      if (!req.force) reject({ class: "conflict", message: "health repair requires --force; use --dry-run to preview the edit" });
      const number = Number(req.values.number);
      const keep = req.values.keep === "last" ? "last" : "first";
      const repaired = repairHealthDuplicates(candidate, number, keep);
      if (repaired.removed === 0) reject({ class: "unsupported_target", message: `health audit ${number} has no duplicate current-history rows to repair` });
      return { candidate: repaired.candidate, written: { number, removed_rows: repaired.removed, retained: keep }, assigned: { number, removed_rows: repaired.removed }, replay: false };
    }
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

export { normalizedDecisionPayload };
