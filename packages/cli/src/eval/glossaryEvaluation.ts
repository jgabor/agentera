import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  GLOSSARY_OBSERVATIONS_SCHEMA_VERSION,
  validateGlossaryObservations,
} from "./glossaryObservations.js";

export { GLOSSARY_OBSERVATIONS_SCHEMA_VERSION, validateGlossaryObservations } from "./glossaryObservations.js";

type Mapping = Record<string, unknown>;

export const GLOSSARY_EVALUATION_AUTHORITY_SCHEMA_VERSION =
  "agentera.personalGlossaryEvaluationAuthority.v1";
export const GLOSSARY_HOLDOUT_SCHEMA_VERSION = "agentera.personalGlossaryEvaluationHoldout.v1";
export const GLOSSARY_EVALUATION_SCHEMA_VERSION = "agentera.personalGlossaryEvaluation.v1";
export const ONE_SIDED_95_WILSON_Z = 1.6448536269514722;

export const GLOSSARY_METRIC_IDS = [
  "discovery_recall",
  "scope_accuracy",
  "inferred_review_precision",
  "explicit_admission_precision",
] as const;

export type GlossaryMetricId = (typeof GLOSSARY_METRIC_IDS)[number];
export type GlossaryMetricStatus = "pass" | "fail";

export interface BinaryEvaluationExample {
  id: string;
  expected: boolean;
  observed: boolean;
}

export interface ScopeEvaluationExample {
  id: string;
  expected: string;
  observed: string;
}

export interface MetricRule {
  definition: string;
  numerator: string;
  denominator: string;
  denominatorZero: string;
  sampleUnit: string;
  minimumSampleSize: number;
  pointEstimateMinimum: number;
  uncertaintyMethod: string;
  confidence: number;
  lowerBoundMinimum: number;
}

export interface MetricResult {
  metric: GlossaryMetricId;
  numerator: number;
  denominator: number;
  point_estimate: number | null;
  uncertainty: {
    method: string;
    confidence: number;
    lower_bound: number | null;
  };
  thresholds: {
    minimum_sample_size: number;
    point_estimate_minimum: number;
    lower_bound_minimum: number;
  };
  gates: {
    denominator_nonzero: boolean;
    sample_sufficient: boolean;
    point_threshold: boolean;
    uncertainty_threshold: boolean;
  };
  status: GlossaryMetricStatus;
  failure_reasons: string[];
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : [];
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sourcePath(root: string, relative: string): string | null {
  if (!relative || path.isAbsolute(relative)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relative);
  const relativeToRoot = path.relative(resolvedRoot, resolved);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    return null;
  }
  return resolved;
}

export function glossaryEvaluationAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "personal-glossary-evaluation-authority.yaml");
}

export function glossaryEvaluationHoldoutPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "personal-glossary-holdout.yaml");
}

export function glossaryEvaluationObservationsPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "personal-glossary-observations.yaml");
}

export function loadGlossaryEvaluationAuthority(
  root: string = resolveSourceRoot(),
): Mapping {
  return loadYamlMappingFile(glossaryEvaluationAuthorityPath(root));
}

export function loadGlossaryEvaluationHoldout(root: string = resolveSourceRoot()): Mapping {
  return loadYamlMappingFile(glossaryEvaluationHoldoutPath(root));
}

function metricMapping(authority: Mapping, metric: GlossaryMetricId): Mapping | null {
  return mapping(mapping(authority.metrics)?.[metric]);
}

export function metricRule(authority: Mapping, metric: GlossaryMetricId): MetricRule {
  const raw = metricMapping(authority, metric);
  const uncertainty = mapping(raw?.uncertainty);
  if (!raw || !uncertainty) {
    throw new Error(`metric authority is missing ${metric}`);
  }
  return {
    definition: String(raw.definition ?? ""),
    numerator: String(raw.numerator ?? ""),
    denominator: String(raw.denominator ?? ""),
    denominatorZero: String(raw.denominator_zero ?? ""),
    sampleUnit: String(raw.sample_unit ?? ""),
    minimumSampleSize: Number(raw.minimum_sample_size),
    pointEstimateMinimum: Number(raw.point_estimate_minimum),
    uncertaintyMethod: String(uncertainty.method ?? ""),
    confidence: Number(uncertainty.confidence),
    lowerBoundMinimum: Number(uncertainty.lower_bound_minimum),
  };
}

const METRIC_SHAPE: Record<GlossaryMetricId, {
  numerator: string;
  denominator: string;
  sampleUnit: string;
  minimumSampleSize: number;
  pointEstimateMinimum: number;
  lowerBoundMinimum: number;
  labels?: readonly string[];
}> = {
  discovery_recall: {
    numerator: "expected_discoverable_true_and_observed_discovered_true",
    denominator: "count_expected_discoverable_true",
    sampleUnit: "labeled_discovery_example",
    minimumSampleSize: 20,
    pointEstimateMinimum: 0.9,
    lowerBoundMinimum: 0.8,
  },
  scope_accuracy: {
    numerator: "expected_scope_equals_observed_scope",
    denominator: "count_all_scope_labeled_examples",
    sampleUnit: "labeled_scope_example",
    minimumSampleSize: 20,
    pointEstimateMinimum: 0.95,
    lowerBoundMinimum: 0.8,
    labels: ["personal", "project", "neither"],
  },
  inferred_review_precision: {
    numerator: "expected_reviewable_true_and_observed_reviewed_true",
    denominator: "count_observed_reviewed_true",
    sampleUnit: "inferred_review_suggestion",
    minimumSampleSize: 20,
    pointEstimateMinimum: 0.95,
    lowerBoundMinimum: 0.8,
  },
  explicit_admission_precision: {
    numerator: "expected_admissible_true_and_observed_admitted_true",
    denominator: "count_observed_admitted_true",
    sampleUnit: "explicit_automatic_admission",
    minimumSampleSize: 50,
    pointEstimateMinimum: 0.99,
    lowerBoundMinimum: 0.9,
  },
};

export function validateGlossaryEvaluationAuthority(authority: Mapping): string[] {
  const errors: string[] = [];
  if (authority.schema_version !== GLOSSARY_EVALUATION_AUTHORITY_SCHEMA_VERSION) {
    errors.push("evaluation authority schema_version is invalid");
  }
  if (authority.status !== "active_authority") errors.push("evaluation authority is not active_authority");
  const holdout = mapping(authority.holdout);
  const holdoutLabels = mapping(holdout?.labels);
  const provenance = mapping(holdout?.provenance);
  const synthetic = mapping(provenance?.synthetic);
  const consented = mapping(provenance?.consented);
  const observations = mapping(authority.observations);
  if (!holdout || holdout.status !== "frozen" || holdout.identity !== "content_addressed_fixture_bytes") {
    errors.push("evaluation authority holdout must be a frozen content-addressed fixture");
  }
  if (
    holdout?.path !== "references/analysis/personal-glossary-holdout.yaml" ||
    !isLowerSha256(holdout?.fixture_sha256)
  ) {
    errors.push("evaluation authority holdout path and fixture_sha256 are required");
  }
  if (
    holdoutLabels?.source !== "evaluation_authority" ||
    holdoutLabels?.expected_labels_immutable !== true ||
    holdoutLabels?.relabeling !== "forbidden_after_freeze" ||
    holdoutLabels?.changed_fixture !== "fail_before_metrics" ||
    holdoutLabels?.failure_recording !== "append_only"
  ) {
    errors.push("evaluation authority labels must be immutable and fail before metrics when changed");
  }
  if (
    !strings(provenance?.allowed_record_classes).includes("synthetic") ||
    !strings(provenance?.allowed_record_classes).includes("consented") ||
    provenance?.default_record_class !== "synthetic" ||
    synthetic?.consent !== "not_required_synthetic" ||
    synthetic?.raw_personal_history !== "forbidden" ||
    synthetic?.source_rule !== "generated_or_hand_authored_synthetic_records_only" ||
    consented?.raw_personal_history !== "allowed_only_with_fixture_record_consent" ||
    !sameStrings(consented?.required_fields, ["consent_subject", "consent_receipt", "consented_at"]) ||
    consented?.source_rule !== "each_record_must_bind_to_its_own_consent_provenance" ||
    provenance?.missing_or_invalid !== "reject_before_metrics"
  ) {
    errors.push("evaluation authority provenance must be synthetic by default and consent-bound otherwise");
  }
  if (
    observations?.schema_version !== GLOSSARY_OBSERVATIONS_SCHEMA_VERSION ||
    observations?.source !== "evaluated_behavior_supplied_separately" ||
    !sameStrings(observations?.required_fields, [
      "schema_version",
      "holdout_id",
      "holdout_fixture_sha256",
      "discovery",
      "scope",
      "inferred_review",
      "explicit_admission",
    ]) ||
    observations?.digest_binding !== "holdout_fixture_sha256_must_equal_frozen_fixture_digest" ||
    observations?.coverage !== "exact_frozen_id_set_per_metric" ||
    observations?.missing !== "not_run_non_authorizing" ||
    observations?.invalid !== "reject_before_metrics"
  ) {
    errors.push("evaluation authority must bind separate observations to the frozen holdout and exact IDs");
  }

  for (const metric of GLOSSARY_METRIC_IDS) {
    const shape = METRIC_SHAPE[metric];
    const raw = metricMapping(authority, metric);
    const uncertainty = mapping(raw?.uncertainty);
    const rule = raw ? metricRule(authority, metric) : null;
    if (
      !raw ||
      !nonEmptyString(raw.definition) ||
      raw.numerator !== shape.numerator ||
      raw.denominator !== shape.denominator ||
      raw.denominator_zero !== "fail" ||
      raw.sample_unit !== shape.sampleUnit ||
      (metric === "scope_accuracy" && !sameStrings(raw.labels, ["personal", "project", "neither"])) ||
      !rule ||
      !Number.isInteger(rule.minimumSampleSize) ||
      rule.minimumSampleSize !== shape.minimumSampleSize ||
      !isFiniteNumber(rule.pointEstimateMinimum) ||
      rule.pointEstimateMinimum !== shape.pointEstimateMinimum ||
      uncertainty?.method !== "wilson_lower_bound" ||
      uncertainty?.confidence !== 0.95 ||
      !isFiniteNumber(rule.lowerBoundMinimum) ||
      rule.lowerBoundMinimum !== shape.lowerBoundMinimum
    ) {
      errors.push(`evaluation authority metric ${metric} has invalid definition, denominator, or gate`);
    }
  }

  const uncertainty = mapping(authority.uncertainty);
  if (
    uncertainty?.method !== "one_sided_wilson_lower_bound" ||
    uncertainty?.confidence !== 0.95 ||
    uncertainty?.rounding !== "report_full_precision_compare_unrounded" ||
    !nonEmptyString(uncertainty?.rule)
  ) {
    errors.push("evaluation authority uncertainty must use the one-sided 95% Wilson lower bound");
  }

  const gates = mapping(authority.gates);
  const exploratory = mapping(gates?.exploratory_report);
  const release = mapping(gates?.release_authorizing_gate);
  const inferredAuto = mapping(gates?.inferred_automatic_admission);
  if (
    exploratory?.release_authorizing !== false ||
    release?.release_authorizing !== true ||
    !sameStrings(release?.requirements, [
      "frozen_holdout_digest_matches_authority",
      "observations_exactly_cover_frozen_ids",
      "every_metric_has_a_nonzero_denominator",
      "every_metric_meets_minimum_sample_size",
      "every_metric_meets_point_threshold",
      "every_metric_meets_uncertainty_threshold",
      "inferred_automatic_admission_remains_disabled",
    ]) ||
    !nonEmptyString(exploratory?.rule) ||
    !nonEmptyString(release?.rule) ||
    inferredAuto?.status !== "disabled" ||
    inferredAuto?.measured_result !== "cannot_enable" ||
    !nonEmptyString(inferredAuto?.rule)
  ) {
    errors.push("evaluation authority must distinguish exploratory reports from the release gate");
  }
  const explicitGate = mapping(gates?.explicit_admission);
  const reviewGate = mapping(gates?.inferred_review);
  if (
    explicitGate?.metric !== "explicit_admission_precision" ||
    explicitGate?.outcome !== "explicit_automatic_admission_only" ||
    reviewGate?.metric !== "inferred_review_precision" ||
    reviewGate?.outcome !== "review_suggestions_only" ||
    mapping(authority.preserved_authority)?.shared_primitive !==
      "references/artifacts/glossary-entry-contract.yaml#shared_primitive" ||
    mapping(authority.preserved_authority)?.personal_owner !==
      "references/artifacts/glossary-entry-contract.yaml#ownership_contracts.personal" ||
    mapping(authority.preserved_authority)?.project_owner !==
      "references/artifacts/glossary-entry-contract.yaml#ownership_contracts.project" ||
    mapping(authority.preserved_authority)?.consumer_precedence !==
      "references/artifacts/glossary-entry-contract.yaml#consumer_boundary.primary_selection" ||
    mapping(authority.preserved_authority)?.project_publication !==
      "references/artifacts/glossary-entry-contract.yaml#ownership_contracts.project.publication" ||
    mapping(authority.preserved_authority)?.inferred_automatic_admission !== "disabled"
  ) {
    errors.push("evaluation authority admission gates must preserve review-only inferred outcomes");
  }
  return errors;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

const FORBIDDEN_RECORD_FIELDS = new Set([
  "raw_text",
  "transcript",
  "content",
  "profile_path",
  "personal_history",
]);

function validateRecordProvenance(record: Mapping, source: string, errors: string[]): void {
  const provenance = mapping(record.provenance);
  if (!provenance) {
    errors.push(`${source}.provenance is required`);
    return;
  }
  if (provenance.record_class !== "synthetic" && provenance.record_class !== "consented") {
    errors.push(`${source}.provenance.record_class is not allowed`);
  }
  if (
    provenance.record_class === "synthetic" &&
    (provenance.consent !== "not_required_synthetic" ||
      provenance.contains_personal_history !== false ||
      !nonEmptyString(provenance.source_namespace) ||
      !provenance.source_namespace.startsWith("synthetic://"))
  ) {
    errors.push(`${source}.provenance synthetic record is not privacy-safe`);
  }
  if (
    provenance.record_class === "consented" &&
    (!nonEmptyString(provenance.consent_subject) ||
      !nonEmptyString(provenance.consent_receipt) ||
      !nonEmptyString(provenance.consented_at))
  ) {
    errors.push(`${source}.provenance consented record lacks consent provenance`);
  }
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_RECORD_FIELDS.has(key)) errors.push(`${source} contains forbidden private content field ${key}`);
  }
  for (const key of Object.keys(provenance)) {
    if (FORBIDDEN_RECORD_FIELDS.has(key)) {
      errors.push(`${source}.provenance contains forbidden private content field ${key}`);
    }
  }
}

function validateCaseList(
  holdout: Mapping,
  key: string,
  requiredFields: readonly string[],
  checkFields: (record: Mapping, source: string, errors: string[]) => void,
  seenIds: Set<string>,
  seenSourceIds: Set<string>,
  errors: string[],
): Mapping[] {
  const records = holdout[key];
  if (!Array.isArray(records)) {
    errors.push(`holdout.${key} must be a list`);
    return [];
  }
  const mappings: Mapping[] = [];
  for (const [index, value] of records.entries()) {
    const source = `holdout.${key}[${index}]`;
    const record = mapping(value);
    if (!record) {
      errors.push(`${source} must be a mapping`);
      continue;
    }
    const id = record.id;
    const sourceId = record.source_id;
    if (!nonEmptyString(id) || seenIds.has(id)) errors.push(`${source}.id must be unique and non-empty`);
    if (!nonEmptyString(sourceId) || seenSourceIds.has(sourceId)) {
      errors.push(`${source}.source_id must be unique and non-empty`);
    }
    if (nonEmptyString(id)) seenIds.add(id);
    if (nonEmptyString(sourceId)) seenSourceIds.add(sourceId);
    const allowedFields = new Set(requiredFields);
    for (const field of Object.keys(record)) {
      if (!allowedFields.has(field)) errors.push(`${source}.${field} is not an allowed field`);
    }
    for (const field of requiredFields) {
      if (!(field in record)) errors.push(`${source}.${field} is required`);
    }
    validateRecordProvenance(record, source, errors);
    checkFields(record, source, errors);
    mappings.push(record);
  }
  return mappings;
}

function booleanField(record: Mapping, field: string, source: string, errors: string[]): void {
  if (typeof record[field] !== "boolean") errors.push(`${source}.${field} must be boolean`);
}

export function validateFrozenGlossaryHoldout(
  authority: Mapping,
  holdout: Mapping,
  fixtureBytes?: string | Buffer,
): string[] {
  const errors: string[] = [];
  if (holdout.schema_version !== GLOSSARY_HOLDOUT_SCHEMA_VERSION) {
    errors.push("holdout schema_version is invalid");
  }
  if (holdout.status !== "frozen" || !nonEmptyString(holdout.holdout_id)) {
    errors.push("holdout must have a frozen holdout_id");
  }
  const provenance = mapping(holdout.provenance);
  if (
    provenance?.record_class !== "synthetic" ||
    provenance?.consent !== "not_required_synthetic" ||
    provenance?.contains_personal_history !== false ||
    !nonEmptyString(provenance?.source) ||
    !nonEmptyString(provenance?.source_ref) ||
    provenance?.owner !== "evaluation_authority"
  ) {
    errors.push("holdout provenance must identify a synthetic, privacy-safe authority source");
  }
  const labelFreeze = mapping(holdout.label_freeze);
  if (
    labelFreeze?.expected_labels_immutable !== true ||
    labelFreeze?.relabeling !== "forbidden_after_freeze" ||
    labelFreeze?.failure_recording !== "append_only" ||
    labelFreeze?.changed_fixture !== "fail_before_metrics"
  ) {
    errors.push("holdout labels must be frozen, append-only, and non-relabelable");
  }
  if (fixtureBytes !== undefined) {
    const expected = mapping(authority.holdout)?.fixture_sha256;
    if (!isLowerSha256(expected) || sha256(fixtureBytes) !== expected) {
      errors.push("holdout fixture digest does not match evaluation authority");
    }
  }

  const seenIds = new Set<string>();
  const seenSourceIds = new Set<string>();
  const scopeLabels = strings(metricMapping(authority, "scope_accuracy")?.labels);
  validateCaseList(
    holdout,
    "discovery",
    ["id", "source_id", "expected_discoverable", "provenance"],
    (record, source, caseErrors) => {
      booleanField(record, "expected_discoverable", source, caseErrors);
    },
    seenIds,
    seenSourceIds,
    errors,
  );
  validateCaseList(
    holdout,
    "scope",
    ["id", "source_id", "expected_scope", "provenance"],
    (record, source, caseErrors) => {
      if (!nonEmptyString(record.expected_scope)) {
        caseErrors.push(`${source}.expected_scope must be a non-empty string`);
      } else if (!scopeLabels.includes(record.expected_scope)) {
        caseErrors.push(`${source}.scope labels are not in the authority label set`);
      }
    },
    seenIds,
    seenSourceIds,
    errors,
  );
  validateCaseList(
    holdout,
    "inferred_review",
    ["id", "source_id", "expected_reviewable", "provenance"],
    (record, source, caseErrors) => {
      booleanField(record, "expected_reviewable", source, caseErrors);
    },
    seenIds,
    seenSourceIds,
    errors,
  );
  validateCaseList(
    holdout,
    "explicit_admission",
    ["id", "source_id", "expected_admissible", "provenance"],
    (record, source, caseErrors) => {
      booleanField(record, "expected_admissible", source, caseErrors);
    },
    seenIds,
    seenSourceIds,
    errors,
  );
  return errors;
}

/** One-sided 95% Wilson lower bound. The authority fixes confidence at 0.95. */
export function wilsonLowerBound(successes: number, denominator: number, confidence = 0.95): number | null {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(denominator) ||
    successes < 0 ||
    denominator <= 0 ||
    successes > denominator ||
    confidence !== 0.95
  ) {
    return null;
  }
  const z = ONE_SIDED_95_WILSON_Z;
  const proportion = successes / denominator;
  const zSquared = z * z;
  const scale = 1 + zSquared / denominator;
  const centre = proportion + zSquared / (2 * denominator);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion)) / denominator + zSquared / (4 * denominator * denominator),
  );
  return (centre - margin) / scale;
}

export function calculateMetric(
  metric: GlossaryMetricId,
  numerator: number,
  denominator: number,
  rule: MetricRule,
): MetricResult {
  const denominatorNonzero = Number.isInteger(denominator) && denominator > 0;
  const validCounts =
    denominatorNonzero &&
    Number.isInteger(numerator) &&
    numerator >= 0 &&
    numerator <= denominator;
  const pointEstimate = validCounts ? numerator / denominator : null;
  const lowerBound = validCounts ? wilsonLowerBound(numerator, denominator, rule.confidence) : null;
  const sampleSufficient = validCounts && denominator >= rule.minimumSampleSize;
  const pointThreshold = pointEstimate !== null && pointEstimate >= rule.pointEstimateMinimum;
  const uncertaintyThreshold = lowerBound !== null && lowerBound >= rule.lowerBoundMinimum;
  const failureReasons: string[] = [];
  if (!denominatorNonzero) failureReasons.push("denominator_zero");
  if (denominatorNonzero && !validCounts) failureReasons.push("invalid_counts");
  if (validCounts && !sampleSufficient) failureReasons.push("insufficient_sample");
  if (validCounts && !pointThreshold) failureReasons.push("point_threshold");
  if (validCounts && !uncertaintyThreshold) failureReasons.push("uncertainty_threshold");
  return {
    metric,
    numerator: validCounts ? numerator : 0,
    denominator: denominatorNonzero ? denominator : 0,
    point_estimate: pointEstimate,
    uncertainty: {
      method: rule.uncertaintyMethod,
      confidence: rule.confidence,
      lower_bound: lowerBound,
    },
    thresholds: {
      minimum_sample_size: rule.minimumSampleSize,
      point_estimate_minimum: rule.pointEstimateMinimum,
      lower_bound_minimum: rule.lowerBoundMinimum,
    },
    gates: {
      denominator_nonzero: denominatorNonzero,
      sample_sufficient: sampleSufficient,
      point_threshold: pointThreshold,
      uncertainty_threshold: uncertaintyThreshold,
    },
    status:
      denominatorNonzero &&
      validCounts &&
      sampleSufficient &&
      pointThreshold &&
      uncertaintyThreshold
        ? "pass"
        : "fail",
    failure_reasons: failureReasons,
  };
}

export function calculateDiscoveryRecall(
  examples: readonly BinaryEvaluationExample[],
  rule: MetricRule,
): MetricResult {
  const eligible = examples.filter((example) => example.expected);
  return calculateMetric(
    "discovery_recall",
    eligible.filter((example) => example.observed).length,
    eligible.length,
    rule,
  );
}

export function calculateScopeAccuracy(
  examples: readonly ScopeEvaluationExample[],
  rule: MetricRule,
): MetricResult {
  return calculateMetric(
    "scope_accuracy",
    examples.filter((example) => example.expected === example.observed).length,
    examples.length,
    rule,
  );
}

export function calculateInferredReviewPrecision(
  examples: readonly BinaryEvaluationExample[],
  rule: MetricRule,
): MetricResult {
  const suggestions = examples.filter((example) => example.observed);
  return calculateMetric(
    "inferred_review_precision",
    suggestions.filter((example) => example.expected).length,
    suggestions.length,
    rule,
  );
}

export function calculateExplicitAdmissionPrecision(
  examples: readonly BinaryEvaluationExample[],
  rule: MetricRule,
): MetricResult {
  const admissions = examples.filter((example) => example.observed);
  return calculateMetric(
    "explicit_admission_precision",
    admissions.filter((example) => example.expected).length,
    admissions.length,
    rule,
  );
}

function binaryExamples(
  holdout: Mapping,
  observations: Mapping,
  key: string,
  expected: string,
  observed: string,
): BinaryEvaluationExample[] {
  const records = Array.isArray(holdout[key]) ? holdout[key] : [];
  const observedRecords = Array.isArray(observations[key]) ? observations[key] : [];
  const observedById = new Map(
    observedRecords.flatMap((value) => {
      const record = mapping(value);
      return record && nonEmptyString(record.id) ? [[record.id, record]] as const : [];
    }),
  );
  return records.flatMap((value) => {
    const record = mapping(value);
    const evaluated = record && nonEmptyString(record.id) ? observedById.get(record.id) : undefined;
    if (!record || !evaluated || !nonEmptyString(record.id) || typeof record[expected] !== "boolean" || typeof evaluated[observed] !== "boolean") {
      return [];
    }
    return [{ id: record.id, expected: record[expected] as boolean, observed: evaluated[observed] as boolean }];
  });
}

function scopeExamples(holdout: Mapping, observations: Mapping): ScopeEvaluationExample[] {
  const records = Array.isArray(holdout.scope) ? holdout.scope : [];
  const observedRecords = Array.isArray(observations.scope) ? observations.scope : [];
  const observedById = new Map(
    observedRecords.flatMap((value) => {
      const record = mapping(value);
      return record && nonEmptyString(record.id) ? [[record.id, record]] as const : [];
    }),
  );
  return records.flatMap((value) => {
    const record = mapping(value);
    const evaluated = record && nonEmptyString(record.id) ? observedById.get(record.id) : undefined;
    if (!record || !evaluated || !nonEmptyString(record.id) || !nonEmptyString(record.expected_scope) || !nonEmptyString(evaluated.observed_scope)) {
      return [];
    }
    return [{ id: record.id, expected: record.expected_scope, observed: evaluated.observed_scope }];
  });
}

function metricCounts(results: readonly MetricResult[]): Record<string, number> {
  return Object.fromEntries(results.map((result) => [result.metric, result.denominator]));
}

function failureReport(errors: string[], authorityPath: string, holdoutPath: string): JsonObject {
  return {
    schemaVersion: GLOSSARY_EVALUATION_SCHEMA_VERSION,
    status: "fail",
    report: {
      exploratory: { release_authorizing: false, status: "not_run" },
      release_gate: { release_authorizing: true, status: "fail", failure_reasons: errors },
    },
    authority: { path: authorityPath },
    holdout: { path: holdoutPath, status: "not_verified" },
    metrics: [],
    gates: {
      release_authorizing: "fail_closed",
      inferred_automatic_admission: { status: "disabled", enabled: false },
    },
    errors,
  } as unknown as JsonObject;
}

function notRunReport(
  authorityPath: string,
  holdoutPath: string,
  holdout: Mapping,
  fixtureDigest: string,
): JsonObject {
  return {
    schemaVersion: GLOSSARY_EVALUATION_SCHEMA_VERSION,
    status: "not_run",
    report: {
      exploratory: { release_authorizing: false, status: "not_run" },
      release_gate: {
        release_authorizing: false,
        release_authorized: false,
        status: "not_run",
        failure_reasons: ["observations_required"],
      },
    },
    authority: { path: authorityPath },
    holdout: {
      id: holdout.holdout_id,
      status: holdout.status,
      fixture_sha256: fixtureDigest,
      case_counts: {
        discovery: Array.isArray(holdout.discovery) ? holdout.discovery.length : 0,
        scope: Array.isArray(holdout.scope) ? holdout.scope.length : 0,
        inferred_review: Array.isArray(holdout.inferred_review) ? holdout.inferred_review.length : 0,
        explicit_admission: Array.isArray(holdout.explicit_admission) ? holdout.explicit_admission.length : 0,
      },
    },
    observations: { status: "not_supplied" },
    metrics: [],
    gates: {
      release_authorizing: "not_run",
      inferred_automatic_admission: { status: "disabled", enabled: false, measured_result: "cannot_enable" },
    },
  } as unknown as JsonObject;
}

function observationPath(root: string, supplied: string): string {
  return path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(root, supplied);
}

export function evaluateGlossaryHoldout(
  root: string = resolveSourceRoot(),
  observationsPath?: string,
): JsonObject {
  const authorityPath = glossaryEvaluationAuthorityPath(root);
  let authority: Mapping;
  try {
    authority = loadYamlMappingFile(authorityPath);
  } catch (error) {
    return failureReport([`cannot load evaluation authority: ${(error as Error).message}`], authorityPath, glossaryEvaluationHoldoutPath(root));
  }
  const authorityErrors = validateGlossaryEvaluationAuthority(authority);
  const holdoutRelative = mapping(authority.holdout)?.path;
  const holdoutPath = nonEmptyString(holdoutRelative) ? sourcePath(root, holdoutRelative) : null;
  if (!holdoutPath) {
    return failureReport([...authorityErrors, "evaluation authority holdout path is outside the source root"], authorityPath, glossaryEvaluationHoldoutPath(root));
  }
  let fixtureBytes: Buffer;
  let holdout: Mapping;
  try {
    fixtureBytes = fs.readFileSync(holdoutPath);
    holdout = loadYamlMappingFile(holdoutPath);
  } catch (error) {
    return failureReport([...authorityErrors, `cannot load frozen holdout: ${(error as Error).message}`], authorityPath, holdoutPath);
  }
  const holdoutErrors = validateFrozenGlossaryHoldout(authority, holdout, fixtureBytes);
  const errors = [...authorityErrors, ...holdoutErrors];
  if (errors.length > 0) return failureReport(errors, authorityPath, holdoutPath);

  const fixtureDigest = sha256(fixtureBytes);
  if (!observationsPath) return notRunReport(authorityPath, holdoutPath, holdout, fixtureDigest);

  const suppliedObservationsPath = observationPath(root, observationsPath);
  let observations: Mapping;
  let observationsBytes: Buffer;
  try {
    const canonicalObservationsPath = glossaryEvaluationObservationsPath(root);
    observationsBytes = suppliedObservationsPath === canonicalObservationsPath
      ? fs.readFileSync(canonicalObservationsPath)
      : fs.readFileSync(suppliedObservationsPath);
    observations = suppliedObservationsPath === canonicalObservationsPath
      ? loadYamlMappingFile(canonicalObservationsPath)
      : loadYamlMappingFile(suppliedObservationsPath);
  } catch (error) {
    return failureReport(
      [`cannot load evaluated observations: ${(error as Error).message}`],
      authorityPath,
      holdoutPath,
    );
  }
  const observationErrors = validateGlossaryObservations(authority, holdout, observations);
  if (observationErrors.length > 0) {
    return failureReport(observationErrors, authorityPath, holdoutPath);
  }

  const results = [
    calculateDiscoveryRecall(
      binaryExamples(holdout, observations, "discovery", "expected_discoverable", "observed_discovered"),
      metricRule(authority, "discovery_recall"),
    ),
    calculateScopeAccuracy(scopeExamples(holdout, observations), metricRule(authority, "scope_accuracy")),
    calculateInferredReviewPrecision(
      binaryExamples(holdout, observations, "inferred_review", "expected_reviewable", "observed_reviewed"),
      metricRule(authority, "inferred_review_precision"),
    ),
    calculateExplicitAdmissionPrecision(
      binaryExamples(holdout, observations, "explicit_admission", "expected_admissible", "observed_admitted"),
      metricRule(authority, "explicit_admission_precision"),
    ),
  ];
  const inferredAutomaticAdmission = mapping(mapping(authority.gates)?.inferred_automatic_admission);
  const autoAdmissionDisabled = inferredAutomaticAdmission?.status === "disabled";
  const metricsPass = results.every((result) => result.status === "pass");
  const releaseGatePass = metricsPass && autoAdmissionDisabled;
  return {
    schemaVersion: GLOSSARY_EVALUATION_SCHEMA_VERSION,
    status: releaseGatePass ? "pass" : "fail",
    report: {
      exploratory: {
        release_authorizing: false,
        status: "report_only",
        metrics: results,
      },
      release_gate: {
        release_authorizing: true,
        release_authorized: releaseGatePass,
        status: releaseGatePass ? "pass" : "fail",
        requirements: {
          frozen_holdout_digest_matches_authority: true,
          observations_exactly_cover_frozen_ids: true,
          every_metric_has_a_nonzero_denominator: results.every((result) => result.gates.denominator_nonzero),
          every_metric_meets_minimum_sample_size: results.every((result) => result.gates.sample_sufficient),
          every_metric_meets_point_threshold: results.every((result) => result.gates.point_threshold),
          every_metric_meets_uncertainty_threshold: results.every((result) => result.gates.uncertainty_threshold),
          inferred_automatic_admission_remains_disabled: autoAdmissionDisabled,
        },
      },
    },
    authority: {
      schema_version: authority.schema_version,
      sha256: sha256(fs.readFileSync(authorityPath)),
      path: authorityPath,
    },
    holdout: {
      id: holdout.holdout_id,
      status: holdout.status,
      fixture_sha256: sha256(fixtureBytes),
      provenance: holdout.provenance as JsonObject,
      case_counts: {
        discovery: Array.isArray(holdout.discovery) ? holdout.discovery.length : 0,
        scope: Array.isArray(holdout.scope) ? holdout.scope.length : 0,
        inferred_review: Array.isArray(holdout.inferred_review) ? holdout.inferred_review.length : 0,
        explicit_admission: Array.isArray(holdout.explicit_admission) ? holdout.explicit_admission.length : 0,
      },
    },
    observations: {
      schema_version: observations.schema_version,
      path: suppliedObservationsPath,
      sha256: sha256(observationsBytes),
      holdout_fixture_sha256: observations.holdout_fixture_sha256,
    },
    metrics: results,
    gates: {
      explicit_admission: {
        metric: "explicit_admission_precision",
        status: results[3].status,
        outcome: "explicit_automatic_admission_only",
      },
      inferred_review: {
        metric: "inferred_review_precision",
        status: results[2].status,
        outcome: "review_suggestions_only",
      },
      inferred_automatic_admission: {
        status: "disabled",
        enabled: false,
        measured_result: "cannot_enable",
      },
      release_authorizing: releaseGatePass ? "pass" : "fail_closed",
    },
    denominator_counts: metricCounts(results),
  } as unknown as JsonObject;
}

export function main(
  observationsPath?: string,
  out: (line: string) => void = (line) => process.stdout.write(line),
  root: string = resolveSourceRoot(),
): number {
  const report = evaluateGlossaryHoldout(root, observationsPath);
  out(JSON.stringify(report, null, 2) + "\n");
  return report.status === "pass" ? 0 : 1;
}
