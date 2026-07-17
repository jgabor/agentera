import { localTimestamp } from "./assign.js";
import { reject } from "./errors.js";

function mapping(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function mutatePlanTaskEvaluation(
  task: Record<string, unknown>,
  inputValue: unknown,
  taskLabel: string,
): { replay: boolean; attemptCount: number; failureCount: number } {
  const input = mapping(inputValue);
  const attemptId = String(input.attempt_id ?? "").trim();
  const verdict = String(input.verdict ?? "");
  const provenance = String(input.provenance ?? "").trim();
  const failureEvidence = String(input.failure_evidence ?? "").trim();
  if (!attemptId || !provenance)
    reject({ class: "schema_violation", message: "evaluation requires non-empty --attempt-id and --provenance" });
  if (verdict === "fail" && !failureEvidence)
    reject({ class: "schema_violation", message: "a failed evaluation requires non-empty --failure-evidence" });
  if (verdict === "pass" && failureEvidence)
    reject({ class: "schema_violation", message: "--failure-evidence applies only to a failed evaluation" });

  const prior = mapping(task.evaluation);
  const priorProvenance = mapping(prior.provenance);
  if (priorProvenance.attempt_id === attemptId) {
    const replay = prior.last_verdict === verdict
      && priorProvenance.source === provenance
      && (verdict !== "fail" || prior.last_failure_evidence === failureEvidence);
    if (!replay)
      reject({ class: "conflict", message: `evaluation attempt '${attemptId}' already exists with different result data` });
    return { replay: true, attemptCount: Number(prior.attempt_count ?? 0), failureCount: Number(prior.failure_count ?? 0) };
  }
  if (["complete", "blocked"].includes(String(task.status ?? "")))
    reject({ class: "conflict", message: `${taskLabel} is ${task.status} and cannot accept another evaluation` });
  const attemptCount = Number(prior.attempt_count ?? 0);
  const failureCount = Number(prior.failure_count ?? 0);
  if (!Number.isInteger(attemptCount) || attemptCount < 0 || !Number.isInteger(failureCount) || failureCount < 0)
    reject({ class: "schema_violation", message: `${taskLabel} has malformed evaluation state` });
  if (verdict === "fail" && failureCount >= 2)
    reject({ class: "conflict", message: `${taskLabel} has exhausted its evaluation retry budget` });
  const nextFailureCount = failureCount + (verdict === "fail" ? 1 : 0);
  task.evaluation = {
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
  if (nextFailureCount >= 2) task.status = "blocked";
  return { replay: false, attemptCount: attemptCount + 1, failureCount: nextFailureCount };
}

export function planEvaluationMetadataViolations(value: unknown, prefix: string, taskStatus?: unknown): string[] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return [`plan: '${prefix}' must be a mapping`];
  const evaluation = value as Record<string, unknown>;
  const violations: string[] = [];
  const allowed = new Set(["attempt_count", "failure_count", "last_verdict", "last_failure_evidence", "provenance"]);
  for (const field of Object.keys(evaluation))
    if (!allowed.has(field)) violations.push(`plan: unsupported field '${prefix}.${field}'`);
  const attemptCount = evaluation.attempt_count;
  const failureCount = evaluation.failure_count;
  if (!Number.isInteger(attemptCount) || Number(attemptCount) < 1)
    violations.push(`plan: '${prefix}.attempt_count' must be a positive integer`);
  if (!Number.isInteger(failureCount) || Number(failureCount) < 0)
    violations.push(`plan: '${prefix}.failure_count' must be a non-negative integer`);
  if (Number.isInteger(attemptCount) && Number.isInteger(failureCount) && Number(failureCount) > Number(attemptCount))
    violations.push(`plan: '${prefix}.failure_count' cannot exceed attempt_count`);
  const verdict = evaluation.last_verdict;
  if (verdict !== "pass" && verdict !== "fail")
    violations.push(`plan: '${prefix}.last_verdict' must be pass or fail`);
  const evidence = evaluation.last_failure_evidence;
  if (evidence !== null && typeof evidence !== "string")
    violations.push(`plan: '${prefix}.last_failure_evidence' must be a string or null`);
  if (verdict === "fail" && (typeof evidence !== "string" || !evidence.trim()))
    violations.push(`plan: '${prefix}.last_failure_evidence' is required for a failed evaluation`);
  const provenance = mapping(evaluation.provenance);
  if (Object.keys(provenance).length === 0)
    violations.push(`plan: '${prefix}.provenance' must be a mapping`);
  else {
    for (const field of ["attempt_id", "source", "recorded_at", "writer_command"])
      if (typeof provenance[field] !== "string" || !String(provenance[field]).trim())
        violations.push(`plan: '${prefix}.provenance.${field}' must be a non-empty string`);
    if (provenance.writer_command !== "agentera state plan record-evaluation")
      violations.push(`plan: '${prefix}.provenance.writer_command' must identify the evaluation writer`);
  }
  if (Number(failureCount) >= 2 && taskStatus !== "blocked")
    violations.push(`plan: '${prefix}' with two failed evaluations requires task status blocked`);
  return violations;
}

export function planTaskRecordViolations(task: Record<string, unknown>, prefix = "plan task"): string[] {
  const violations: string[] = [];
  if (typeof task.name !== "string" || !task.name.trim()) violations.push(`${prefix}: name must be a non-empty string`);
  if (!["pending", "in_progress", "complete", "blocked", "skipped"].includes(String(task.status)))
    violations.push(`${prefix}: status must be pending, in_progress, complete, blocked, or skipped`);
  for (const field of ["depends_on", "acceptance"])
    if (!Array.isArray(task[field]) || !(task[field] as unknown[]).every((value) => typeof value === "string"))
      violations.push(`${prefix}: ${field} must be a string list`);
  return [...violations, ...planEvaluationMetadataViolations(task.evaluation, `${prefix}.evaluation`, task.status)];
}
