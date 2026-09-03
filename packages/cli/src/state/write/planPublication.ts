import { dumpYamlMapping, loadYamlMapping } from "../../core/yaml.js";
import { lintFullArtifactPayload } from "../../cli/commands/lint.js";
import { reject } from "./errors.js";
import { planEvaluationMetadataViolations } from "./planEvaluation.js";
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

function canonicalCreateLocalOrdinal(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const ordinal = Number(value);
  return Number.isSafeInteger(ordinal) ? value : null;
}

export function normalizeAndValidatePlanCreateInput(input: Record<string, unknown>): void {
  const header = isRecord(input.header) ? input.header : {};
  if (header.id !== undefined) {
    reject({
      class: "schema_violation",
      message: "plan create header.id is CLI-owned and must be omitted",
      violations: ["header.id is assigned by the validated plan writer"],
    });
  }
  if (header.status === "archived") {
    reject({
      class: "schema_violation",
      message: "plan create cannot publish an archived plan",
      violations: ["header.status archived is owned by agentera state plan archive"],
    });
  }
  const tasks = Array.isArray(input.tasks) ? input.tasks.filter(isRecord) : [];
  if (tasks.some((task) => task.status === "superseded")) {
    reject({
      class: "schema_violation",
      message: "plan create cannot publish superseded tasks",
      violations: ["superseded task relationships are assigned only by agentera state plan supersede"],
    });
  }
  const numbers = tasks.map((task) => Number(task.number));
  const expected = tasks.map((_, index) => index + 1);
  if (numbers.some((number, index) => number !== expected[index])) {
    reject({
      class: "schema_violation",
      message: "plan create task ordinals must be unique and sequential starting from 1 within this atomic input",
      violations: ["PV1: create-local task ordinals must equal 1..N and are removed before entity publication"],
    });
  }
  const declaredOrdinals = new Set(expected.map(String));
  for (const [taskIndex, task] of tasks.entries()) {
    if (task.depends_on === undefined) continue;
    if (!Array.isArray(task.depends_on)) continue;
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const [dependencyIndex, dependency] of task.depends_on.entries()) {
      const ordinal = canonicalCreateLocalOrdinal(dependency);
      const location = `tasks[${taskIndex}].depends_on[${dependencyIndex}]`;
      if (!ordinal) {
        reject({
          class: "schema_violation",
          message: `${location} must be a positive integer or canonical numeric string create-local ordinal`,
          violations: ["PV4: zero, negative, fractional, nonnumeric, noncanonical, and unsafe dependency ordinals are invalid"],
        });
      }
      if (seen.has(ordinal)) {
        reject({
          class: "schema_violation",
          message: `${location} duplicates create-local dependency ordinal '${ordinal}'`,
          violations: ["PV4: each task dependency ordinal must be unique within that task"],
        });
      }
      if (!declaredOrdinals.has(ordinal)) {
        reject({
          class: "schema_violation",
          message: `${location} create-local dependency ordinal '${ordinal}' does not resolve within the atomic plan input`,
          violations: ["PV4: every dependency must reference a task declared in the same complete create document"],
        });
      }
      seen.add(ordinal);
      normalized.push(ordinal);
    }
    task.depends_on = normalized;
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
  return tasks.flatMap((task, index) => (isRecord(task) ? planEvaluationMetadataViolations(task.evaluation, `tasks[${index}].evaluation`, task.status) : []));
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
  if (failures.length === 0) return { eligible: false, reason: "the predecessor does not have a full-file budget failure" };
  if (failures.some((check) => check.name !== "verbosity"))
    return {
      eligible: false,
      reason: "the predecessor has strict lint failures beyond full-file verbosity",
    };

  let doc: Record<string, unknown>;
  try {
    doc = loadYamlMapping(bytes);
  } catch {
    return { eligible: false, reason: "the predecessor YAML is malformed" };
  }
  const tasks = Array.isArray(doc.tasks) ? doc.tasks : [];
  const hasOwnedMetadata = Object.prototype.hasOwnProperty.call(doc, "previous_plan_archived") || tasks.some((task) => isRecord(task) && Object.prototype.hasOwnProperty.call(task, "evaluation"));
  if (!hasOwnedMetadata)
    return {
      eligible: false,
      reason: "the full-file overflow is not attributable to CLI-owned plan metadata",
    };
  const evaluationViolations = planEvaluationViolations(doc);
  if (evaluationViolations.length > 0)
    return {
      eligible: false,
      reason: `CLI-owned evaluation metadata is malformed: ${evaluationViolations[0]}`,
    };

  const stripped = dumpYamlMapping(withoutCliOwnedPlanLifecycleFields(doc));
  const strippedLint = lintFullArtifactPayload("plan", stripped);
  if (strippedLint.status !== "pass")
    return {
      eligible: false,
      reason: "user-authored plan content still exceeds the full-file budget",
    };
  return {
    eligible: true,
    reason: "full-file overflow is attributable only to CLI-owned plan lineage/evaluation metadata",
  };
}

export function validatePlanPublicationCandidate(bytes: string, options: { allowHistoricalBudgetOverflow?: boolean } = {}): PlanPublicationValidation {
  const lint = lintFullArtifactPayload("plan", bytes);
  const lintViolations = (lint.checks as Array<Record<string, string>>).filter((check) => check.status === "fail").map((check) => `strict prose lint ${check.name}: ${check.detail}; action: ${check.action}`);
  const schemaViolations = validateArtifactBytes("plan", bytes).map((violation) => `schema validation: ${violation}`);
  let document: Record<string, unknown> = {};
  try {
    document = loadYamlMapping(bytes);
  } catch {
    // The schema validator owns malformed-YAML diagnostics.
  }
  const evaluationViolations = planEvaluationViolations(document).map((violation) => `schema validation: ${violation}`);
  let historical: HistoricalPlanBudgetClassification | null = null;
  if (options.allowHistoricalBudgetOverflow && lintViolations.length > 0) {
    historical = classifyHistoricalPlanBudgetOverflow(bytes);
    if (!historical.eligible) lintViolations.push(`historical predecessor exception rejected: ${historical.reason}`);
  }
  const effectiveLintViolations = historical?.eligible ? lintViolations.filter((violation) => !violation.startsWith("strict prose lint verbosity")) : lintViolations;
  const effectiveViolations = [...effectiveLintViolations, ...schemaViolations, ...evaluationViolations];
  if (effectiveViolations.length === 0)
    return {
      diagnostics: historical?.eligible ? [`historical predecessor accepted: ${historical.reason}; exact predecessor bytes preserved`] : [],
    };
  reject({
    class: "schema_violation",
    message: "plan publication candidate failed strict prose lint or schema validation; correct the reported violations and retry",
    violations: effectiveViolations,
    syntax: "agentera state plan create --input plan.yaml",
    example: "agentera state plan create --input plan.yaml",
  });
}
