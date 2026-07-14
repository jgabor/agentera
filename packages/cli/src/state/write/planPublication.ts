import { dumpYamlMapping, loadYamlMapping } from "../../core/yaml.js";
import { lintFullArtifactPayload } from "../../cli/commands/lint.js";
import { reject } from "./errors.js";
import { validateArtifactBytes } from "./validate.js";

interface HistoricalPlanBudgetClassification {
  eligible: boolean;
  reason: string;
}

export interface PlanPublicationValidation {
  diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function validatePlanCreateInput(input: Record<string, unknown>): void {
  const header = isRecord(input.header) ? input.header : {};
  if (header.id !== undefined) {
    reject({
      class: "schema_violation",
      message: "plan create header.id is CLI-owned and must be omitted",
      violations: ["header.id is assigned by the validated plan writer"],
    });
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter(isRecord) : [];
  const numbers = tasks.map((task) => Number(task.number));
  const expected = tasks.map((_, index) => index + 1);
  if (numbers.some((number, index) => number !== expected[index])) {
    reject({
      class: "schema_violation",
      message: "plan create task numbers must be unique and sequential starting from 1",
      violations: ["PV1: task numbers must equal 1..N"],
    });
  }
  if (header.status === "complete" && tasks.some((task) => task.status !== "complete")) {
    reject({
      class: "schema_violation",
      message: "a complete plan cannot contain incomplete tasks",
      violations: ["header.status complete requires every task complete"],
    });
  }
}

export function planEvaluationViolations(doc: Record<string, unknown>): string[] {
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const violations: string[] = [];
  const allowed = new Set([
    "attempt_count",
    "failure_count",
    "last_verdict",
    "last_failure_evidence",
    "provenance",
  ]);

  tasks.forEach((task, index) => {
    if (!isRecord(task) || task.evaluation === undefined) return;
    const prefix = `tasks[${index}].evaluation`;
    if (!isRecord(task.evaluation)) {
      violations.push(`plan: '${prefix}' must be a mapping`);
      return;
    }
    const evaluation = task.evaluation;
    for (const field of Object.keys(evaluation)) {
      if (!allowed.has(field)) violations.push(`plan: unsupported field '${prefix}.${field}'`);
    }
    const attemptCount = evaluation.attempt_count;
    const failureCount = evaluation.failure_count;
    if (!Number.isInteger(attemptCount) || Number(attemptCount) < 1)
      violations.push(`plan: '${prefix}.attempt_count' must be a positive integer`);
    if (!Number.isInteger(failureCount) || Number(failureCount) < 0)
      violations.push(`plan: '${prefix}.failure_count' must be a non-negative integer`);
    if (
      Number.isInteger(attemptCount) &&
      Number.isInteger(failureCount) &&
      Number(failureCount) > Number(attemptCount)
    )
      violations.push(`plan: '${prefix}.failure_count' cannot exceed attempt_count`);

    const verdict = evaluation.last_verdict;
    if (verdict !== "pass" && verdict !== "fail")
      violations.push(`plan: '${prefix}.last_verdict' must be pass or fail`);
    const failureEvidence = evaluation.last_failure_evidence;
    if (failureEvidence !== null && typeof failureEvidence !== "string")
      violations.push(`plan: '${prefix}.last_failure_evidence' must be a string or null`);
    if (verdict === "fail" && (typeof failureEvidence !== "string" || !failureEvidence.trim()))
      violations.push(`plan: '${prefix}.last_failure_evidence' is required for a failed evaluation`);

    if (!isRecord(evaluation.provenance)) {
      violations.push(`plan: '${prefix}.provenance' must be a mapping`);
    } else {
      for (const field of ["attempt_id", "source", "recorded_at", "writer_command"]) {
        const value = evaluation.provenance[field];
        if (typeof value !== "string" || !value.trim())
          violations.push(`plan: '${prefix}.provenance.${field}' must be a non-empty string`);
      }
      if (evaluation.provenance.writer_command !== "agentera state plan record-evaluation")
        violations.push(`plan: '${prefix}.provenance.writer_command' must identify the evaluation writer`);
    }

    if (Number(failureCount) >= 2 && task.status !== "blocked")
      violations.push(`plan: '${prefix}' with two failed evaluations requires task status blocked`);
  });
  return violations;
}

function withoutCliOwnedPlanLifecycleFields(doc: Record<string, unknown>): Record<string, unknown> {
  const candidate = structuredClone(doc);
  delete candidate.previous_plan_archived;
  const tasks = Array.isArray(candidate.tasks) ? candidate.tasks : [];
  for (const task of tasks) {
    if (isRecord(task)) delete task.evaluation;
  }
  return candidate;
}

function classifyHistoricalPlanBudgetOverflow(bytes: string): HistoricalPlanBudgetClassification {
  const lint = lintFullArtifactPayload("plan", bytes);
  const failures = (lint.checks as Array<Record<string, string>>).filter((check) => check.status === "fail");
  if (failures.length === 0)
    return { eligible: false, reason: "the predecessor does not have a full-file budget failure" };
  if (failures.some((check) => check.name !== "verbosity"))
    return { eligible: false, reason: "the predecessor has strict lint failures beyond full-file verbosity" };

  let doc: Record<string, unknown>;
  try {
    doc = loadYamlMapping(bytes);
  } catch {
    return { eligible: false, reason: "the predecessor YAML is malformed" };
  }
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const hasOwnedMetadata =
    Object.prototype.hasOwnProperty.call(doc, "previous_plan_archived") ||
    tasks.some((task) => isRecord(task) && Object.prototype.hasOwnProperty.call(task, "evaluation"));
  if (!hasOwnedMetadata)
    return { eligible: false, reason: "the full-file overflow is not attributable to CLI-owned plan metadata" };
  const evaluationViolations = planEvaluationViolations(doc);
  if (evaluationViolations.length > 0)
    return { eligible: false, reason: `CLI-owned evaluation metadata is malformed: ${evaluationViolations[0]}` };

  const stripped = dumpYamlMapping(withoutCliOwnedPlanLifecycleFields(doc));
  const strippedLint = lintFullArtifactPayload("plan", stripped);
  if (strippedLint.status !== "pass")
    return { eligible: false, reason: "user-authored plan content still exceeds the full-file budget" };
  return {
    eligible: true,
    reason: "full-file overflow is attributable only to CLI-owned plan lineage/evaluation metadata",
  };
}

export function validatePlanPublicationCandidate(
  bytes: string,
  options: { allowHistoricalBudgetOverflow?: boolean } = {},
): PlanPublicationValidation {
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
  let document: Record<string, unknown> = {};
  try {
    document = loadYamlMapping(bytes);
  } catch {
    // The schema validator owns malformed-YAML diagnostics.
  }
  const evaluationViolations = planEvaluationViolations(document).map(
    (violation) => `schema validation: ${violation}`,
  );
  let historical: HistoricalPlanBudgetClassification | null = null;
  if (options.allowHistoricalBudgetOverflow && lintViolations.length > 0) {
    historical = classifyHistoricalPlanBudgetOverflow(bytes);
    if (!historical.eligible) lintViolations.push(`historical predecessor exception rejected: ${historical.reason}`);
  }
  const effectiveLintViolations = historical?.eligible
    ? lintViolations.filter((violation) => !violation.startsWith("strict prose lint verbosity"))
    : lintViolations;
  const effectiveViolations = [...effectiveLintViolations, ...schemaViolations, ...evaluationViolations];
  if (effectiveViolations.length === 0)
    return {
      diagnostics: historical?.eligible
        ? [`historical predecessor accepted: ${historical.reason}; exact predecessor bytes preserved`]
        : [],
    };
  reject({
    class: "schema_violation",
    message: "plan publication candidate failed strict prose lint or schema validation; correct the reported violations and retry",
    violations: effectiveViolations,
    syntax: "agentera state plan create --input plan.yaml --format json",
    example: "agentera state plan create --input plan.yaml --format json",
  });
}
