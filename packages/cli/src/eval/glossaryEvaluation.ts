import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";

export type Mapping = Record<string, unknown>;

export const GLOSSARY_EVALUATION_AUTHORITY_SCHEMA_VERSION = "agentera.personalGlossaryEvaluationAuthority.v1";
export const GLOSSARY_HOLDOUT_SCHEMA_VERSION = "agentera.personalGlossaryEvaluationHoldout.v1";
export const GLOSSARY_BEHAVIOR_FIXTURE_SCHEMA_VERSION = "agentera.personalGlossaryEvaluationBehaviorFixture.v1";
export const GLOSSARY_OBSERVATIONS_SCHEMA_VERSION = "agentera.personalGlossaryEvaluationObservations.v2";
export const GLOSSARY_EVALUATION_SCHEMA_VERSION = "agentera.personalGlossaryEvaluation.v1";
export const ONE_SIDED_95_WILSON_Z = 1.6448536269514722;

export const GLOSSARY_METRIC_IDS = ["discovery_recall", "scope_accuracy", "inferred_review_precision", "explicit_admission_precision"] as const;

export const GLOSSARY_EVALUATION_CASE_SET_IDS = ["discovery", "scope", "inferred_review", "explicit_admission"] as const;

export type GlossaryMetricId = (typeof GLOSSARY_METRIC_IDS)[number];
export type GlossaryEvaluationCaseSetId = (typeof GLOSSARY_EVALUATION_CASE_SET_IDS)[number];
export type GlossaryEvaluationCaseCounts = Record<GlossaryEvaluationCaseSetId, number>;
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
    one_sided: true;
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

const MAX_BEHAVIOR_FIXTURE_UTF8_BYTES = 65_536;
const MAX_BEHAVIOR_FIXTURE_ALIASES = 256;
const FORBIDDEN_PRIVATE_FIELDS = new Set(["raw_text", "transcript", "content", "profile_path", "personal_history", "secret", "password", "api_key", "credential"]);
const FORBIDDEN_LABEL_FIELDS = /^(?:expected_|observed_|label$|labels$)/u;

export function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : [];
}

export function mappings(value: unknown): Mapping[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = mapping(item);
        return record === null ? [] : [record];
      })
    : [];
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Mapping)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function canonicalDigest(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)));
}

/** Count the contract-owned frozen cases in each glossary evaluation family. */
export function glossaryEvaluationCaseCounts(value: Mapping): GlossaryEvaluationCaseCounts {
  return Object.fromEntries(GLOSSARY_EVALUATION_CASE_SET_IDS.map((key) => [key, Array.isArray(value[key]) ? value[key].length : 0])) as GlossaryEvaluationCaseCounts;
}

/** Digest the frozen labels without carrying them into evaluator output. */
export function glossaryEvaluationLabelDigest(holdout: Mapping): string {
  return canonicalDigest(
    Object.fromEntries([
      [
        "discovery",
        mappings(holdout.discovery).map(({ id, expected_discoverable }) => ({
          id,
          expected_discoverable,
        })),
      ],
      ["scope", mappings(holdout.scope).map(({ id, expected_scope }) => ({ id, expected_scope }))],
      [
        "inferred_review",
        mappings(holdout.inferred_review).map(({ id, expected_reviewable }) => ({
          id,
          expected_reviewable,
        })),
      ],
      [
        "explicit_admission",
        mappings(holdout.explicit_admission).map(({ id, expected_admissible }) => ({
          id,
          expected_admissible,
        })),
      ],
    ]),
  );
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function exactFields(record: Mapping, expected: readonly string[], source: string, errors: string[]): void {
  for (const field of Object.keys(record)) {
    if (!expected.includes(field)) errors.push(`${source}.${field} is not an allowed field`);
  }
  for (const field of expected) {
    if (!(field in record)) errors.push(`${source}.${field} is required`);
  }
}

export function glossaryEvaluationAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "personal-glossary-evaluation-authority.yaml");
}

export function glossaryEvaluationHoldoutPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "personal-glossary-holdout.yaml");
}

export function glossaryEvaluationBehaviorFixturePath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "analysis", "personal-glossary-evaluation-corpus.yaml");
}

export function loadGlossaryEvaluationAuthority(root: string = resolveSourceRoot()): Mapping {
  return loadYamlMappingFile(glossaryEvaluationAuthorityPath(root));
}

export function loadGlossaryEvaluationHoldout(root: string = resolveSourceRoot()): Mapping {
  return loadYamlMappingFile(glossaryEvaluationHoldoutPath(root));
}

export function loadGlossaryEvaluationBehaviorFixture(root: string = resolveSourceRoot()): Mapping {
  const bytes = fs.readFileSync(glossaryEvaluationBehaviorFixturePath(root));
  return parseGlossaryEvaluationBehaviorFixture(bytes);
}

function parseGlossaryEvaluationBehaviorFixture(bytes: Buffer): Mapping {
  if (bytes.length > MAX_BEHAVIOR_FIXTURE_UTF8_BYTES) {
    throw new Error("behavior fixture exceeds its UTF-8 bound");
  }
  const value = YAML.parse(bytes.toString("utf8"), { maxAliasCount: MAX_BEHAVIOR_FIXTURE_ALIASES });
  const parsed = mapping(value);
  if (parsed === null) throw new Error("YAML root must be a mapping");
  return parsed;
}

function metricMapping(authority: Mapping, metric: GlossaryMetricId): Mapping | null {
  return mapping(mapping(authority.metrics)?.[metric]);
}

export function metricRule(authority: Mapping, metric: GlossaryMetricId): MetricRule {
  const raw = metricMapping(authority, metric);
  const uncertainty = mapping(raw?.uncertainty);
  if (!raw || !uncertainty) throw new Error(`metric authority is missing ${metric}`);
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

const METRIC_SHAPE: Record<
  GlossaryMetricId,
  {
    numerator: string;
    denominator: string;
    sampleUnit: string;
    minimumSampleSize: number;
    pointEstimateMinimum: number;
    lowerBoundMinimum: number;
    labels?: readonly string[];
  }
> = {
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
  if (authority.status !== "active_authority") {
    errors.push("evaluation authority is not active_authority");
  }
  const holdout = mapping(authority.holdout);
  const holdoutLabels = mapping(holdout?.labels);
  const provenance = mapping(holdout?.provenance);
  const synthetic = mapping(provenance?.synthetic);
  const consented = mapping(provenance?.consented);
  const observations = mapping(authority.observations);
  const behaviorFixture = mapping(observations?.behavior_fixture);
  const results = mapping(authority.results);
  const metricsDigest = mapping(results?.metrics_sha256);
  if (!holdout || holdout.status !== "frozen" || holdout.identity !== "content_addressed_fixture_bytes") {
    errors.push("evaluation authority holdout must be a frozen content-addressed fixture");
  }
  if (holdout?.path !== "references/analysis/personal-glossary-holdout.yaml" || !isLowerSha256(holdout?.fixture_sha256)) {
    errors.push("evaluation authority holdout path and fixture_sha256 are required");
  }
  if (holdoutLabels?.source !== "evaluation_authority" || holdoutLabels?.expected_labels_immutable !== true || holdoutLabels?.relabeling !== "forbidden_after_freeze" || holdoutLabels?.changed_fixture !== "fail_before_metrics" || holdoutLabels?.failure_recording !== "append_only") {
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
    observations?.source !== "current_product_behavior" ||
    !sameStrings(observations?.required_fields, ["schema_version", "holdout_id", "holdout_fixture_sha256", "behavior_fixture_sha256", "discovery", "scope", "inferred_review", "explicit_admission"]) ||
    observations?.digest_binding !== "holdout_fixture_sha256_must_equal_frozen_fixture_digest" ||
    observations?.coverage !== "exact_frozen_id_set_per_metric" ||
    observations?.missing !== "not_run_non_authorizing" ||
    observations?.invalid !== "reject_before_metrics"
  ) {
    errors.push("evaluation authority observations must come from current product behavior");
  }
  if (behaviorFixture?.path !== "references/analysis/personal-glossary-evaluation-corpus.yaml" || !isLowerSha256(behaviorFixture?.fixture_sha256) || behaviorFixture?.status !== "frozen" || behaviorFixture?.identity !== "content_addressed_fixture_bytes" || behaviorFixture?.provenance !== "synthetic_only") {
    errors.push("evaluation authority behavior fixture must be frozen, content-addressed, and synthetic-only");
  }
  if (metricsDigest?.field !== "metrics_sha256" || metricsDigest?.algorithm !== "sha256(canonical_json_metrics_array)") {
    errors.push("evaluation authority results must bind the canonical metric array digest");
  }
  for (const metric of GLOSSARY_METRIC_IDS) {
    const raw = metricMapping(authority, metric);
    const uncertainty = mapping(raw?.uncertainty);
    const expected = METRIC_SHAPE[metric];
    if (
      !raw ||
      raw.numerator !== expected.numerator ||
      raw.denominator !== expected.denominator ||
      raw.sample_unit !== expected.sampleUnit ||
      raw.minimum_sample_size !== expected.minimumSampleSize ||
      raw.point_estimate_minimum !== expected.pointEstimateMinimum ||
      raw.denominator_zero !== "fail" ||
      uncertainty?.method !== "wilson_lower_bound" ||
      uncertainty?.confidence !== 0.95 ||
      uncertainty?.lower_bound_minimum !== expected.lowerBoundMinimum ||
      (expected.labels !== undefined && !sameStrings(raw.labels, expected.labels))
    ) {
      errors.push(`evaluation authority metric ${metric} does not preserve its approved denominator or threshold`);
    }
  }
  const uncertainty = mapping(authority.uncertainty);
  const gates = mapping(authority.gates);
  const releaseGate = mapping(gates?.release_authorizing_gate);
  const inferredAuto = mapping(gates?.inferred_automatic_admission);
  if (
    uncertainty?.method !== "one_sided_wilson_lower_bound" ||
    uncertainty?.confidence !== 0.95 ||
    !nonEmptyString(uncertainty?.rule) ||
    uncertainty?.rounding !== "report_full_precision_compare_unrounded" ||
    gates === null ||
    mapping(gates?.exploratory_report)?.release_authorizing !== false ||
    releaseGate?.release_authorizing !== true ||
    !sameStrings(releaseGate?.requirements, [
      "frozen_holdout_digest_matches_authority",
      "observations_exactly_cover_frozen_ids",
      "every_metric_has_a_nonzero_denominator",
      "every_metric_meets_minimum_sample_size",
      "every_metric_meets_point_threshold",
      "every_metric_meets_uncertainty_threshold",
      "inferred_automatic_admission_remains_disabled",
    ]) ||
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
    mapping(authority.preserved_authority)?.shared_primitive !== "references/artifacts/glossary-entry-contract.yaml#shared_primitive" ||
    mapping(authority.preserved_authority)?.personal_owner !== "references/artifacts/glossary-entry-contract.yaml#ownership_contracts.personal" ||
    mapping(authority.preserved_authority)?.project_owner !== "references/artifacts/glossary-entry-contract.yaml#ownership_contracts.project" ||
    mapping(authority.preserved_authority)?.consumer_precedence !== "references/artifacts/glossary-entry-contract.yaml#consumer_boundary.primary_selection" ||
    mapping(authority.preserved_authority)?.project_publication !== "references/artifacts/glossary-entry-contract.yaml#ownership_contracts.project.publication" ||
    mapping(authority.preserved_authority)?.inferred_automatic_admission !== "disabled"
  ) {
    errors.push("evaluation authority admission gates must preserve review-only inferred outcomes");
  }
  return errors;
}

function validateRecordProvenance(record: Mapping, source: string, errors: string[], sourceNamespace: string, syntheticOnly = false): void {
  const provenance = mapping(record.provenance);
  if (!provenance) {
    errors.push(`${source}.provenance is required`);
    return;
  }
  if (provenance.record_class !== "synthetic" && provenance.record_class !== "consented") {
    errors.push(`${source}.provenance.record_class is not allowed`);
  }
  if (provenance.record_class === "synthetic" && (provenance.consent !== "not_required_synthetic" || provenance.contains_personal_history !== false || !nonEmptyString(provenance.source_namespace) || !provenance.source_namespace.startsWith(sourceNamespace))) {
    errors.push(`${source}.provenance synthetic record is not privacy-safe`);
  }
  if (provenance.record_class === "consented" && (!nonEmptyString(provenance.consent_subject) || !nonEmptyString(provenance.consent_receipt) || !nonEmptyString(provenance.consented_at))) {
    errors.push(`${source}.provenance consented record lacks consent provenance`);
  }
  if (syntheticOnly && provenance.record_class !== "synthetic") {
    errors.push(`${source}.provenance must be synthetic`);
  }
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_PRIVATE_FIELDS.has(key)) {
      errors.push(`${source} contains forbidden private content field ${key}`);
    }
  }
  for (const key of Object.keys(provenance)) {
    if (FORBIDDEN_PRIVATE_FIELDS.has(key)) {
      errors.push(`${source}.provenance contains forbidden private content field ${key}`);
    }
  }
}

function validateCaseList(holdout: Mapping, key: string, requiredFields: readonly string[], checkFields: (record: Mapping, source: string, errors: string[]) => void, seenIds: Set<string>, seenSourceIds: Set<string>, errors: string[]): void {
  const records = holdout[key];
  if (!Array.isArray(records)) {
    errors.push(`holdout.${key} must be a list`);
    return;
  }
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
    exactFields(record, requiredFields, source, errors);
    validateRecordProvenance(record, source, errors, "synthetic://personal-glossary/");
    checkFields(record, source, errors);
  }
}

export function validateFrozenGlossaryHoldout(authority: Mapping, holdout: Mapping, fixtureBytes?: string | Buffer): string[] {
  const errors: string[] = [];
  if (holdout.schema_version !== GLOSSARY_HOLDOUT_SCHEMA_VERSION) {
    errors.push("holdout schema_version is invalid");
  }
  if (holdout.status !== "frozen" || !nonEmptyString(holdout.holdout_id)) {
    errors.push("holdout must have a frozen holdout_id");
  }
  const provenance = mapping(holdout.provenance);
  if (provenance?.record_class !== "synthetic" || provenance?.consent !== "not_required_synthetic" || provenance?.contains_personal_history !== false || !nonEmptyString(provenance?.source) || !nonEmptyString(provenance?.source_ref) || provenance?.owner !== "evaluation_authority") {
    errors.push("holdout provenance must identify a synthetic, privacy-safe authority source");
  }
  const labelFreeze = mapping(holdout.label_freeze);
  if (labelFreeze?.expected_labels_immutable !== true || labelFreeze?.relabeling !== "forbidden_after_freeze" || labelFreeze?.failure_recording !== "append_only" || labelFreeze?.changed_fixture !== "fail_before_metrics") {
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
      if (typeof record.expected_discoverable !== "boolean") {
        caseErrors.push(`${source}.expected_discoverable must be boolean`);
      }
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
      if (!nonEmptyString(record.expected_scope) || !scopeLabels.includes(record.expected_scope)) {
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
      if (typeof record.expected_reviewable !== "boolean") {
        caseErrors.push(`${source}.expected_reviewable must be boolean`);
      }
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
      if (typeof record.expected_admissible !== "boolean") {
        caseErrors.push(`${source}.expected_admissible must be boolean`);
      }
    },
    seenIds,
    seenSourceIds,
    errors,
  );
  return errors;
}

function behaviorIds(value: unknown): Set<string> {
  return new Set(mappings(value).flatMap((record) => (nonEmptyString(record.id) ? [record.id] : [])));
}

function sameIdSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function validateBehaviorTextCase(record: Mapping, source: string, errors: string[], allowActor: boolean): void {
  const allowed = new Set(["id", "text", "provenance", ...(allowActor ? ["actor"] : [])]);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) errors.push(`${source}.${field} is not an allowed field`);
  }
  for (const field of ["id", "text", "provenance"]) {
    if (!(field in record)) errors.push(`${source}.${field} is required`);
  }
  if (!nonEmptyString(record.id)) errors.push(`${source}.id must be a non-empty string`);
  if (!nonEmptyString(record.text) || Buffer.byteLength(record.text, "utf8") > 4096) {
    errors.push(`${source}.text must be a bounded non-empty string`);
  }
  if (allowActor && record.actor !== undefined && record.actor !== "user" && record.actor !== "agent") {
    errors.push(`${source}.actor must be user or agent when supplied`);
  }
  validateRecordProvenance(record, source, errors, "synthetic://personal-glossary-evaluation/", true);
}

function validateBehaviorInferredCase(record: Mapping, source: string, errors: string[]): void {
  exactFields(record, ["id", "term", "sources", "provenance"], source, errors);
  if (!nonEmptyString(record.id)) errors.push(`${source}.id must be a non-empty string`);
  if (!nonEmptyString(record.term) || Buffer.byteLength(record.term, "utf8") > 256) {
    errors.push(`${source}.term must be a bounded non-empty string`);
  }
  if (!Array.isArray(record.sources) || record.sources.length === 0) {
    errors.push(`${source}.sources must be a non-empty list`);
  } else {
    for (const [index, item] of record.sources.entries()) {
      const sourceRecord = mapping(item);
      const itemSource = `${source}.sources[${index}]`;
      if (!sourceRecord) {
        errors.push(`${itemSource} must be a mapping`);
        continue;
      }
      exactFields(sourceRecord, ["source_kind", "text"], itemSource, errors);
      if (!["instruction_document", "project_config_signal", "conversation_turn"].includes(String(sourceRecord.source_kind))) {
        errors.push(`${itemSource}.source_kind is not supported`);
      }
      if (!nonEmptyString(sourceRecord.text) || Buffer.byteLength(sourceRecord.text, "utf8") > 4096) {
        errors.push(`${itemSource}.text must be a bounded non-empty string`);
      }
    }
  }
  validateRecordProvenance(record, source, errors, "synthetic://personal-glossary-evaluation/", true);
}

function validateBehaviorLabelsAbsent(value: unknown, source: string, errors: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateBehaviorLabelsAbsent(item, `${source}[${index}]`, errors));
    return;
  }
  const record = mapping(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if (FORBIDDEN_LABEL_FIELDS.test(key)) {
      errors.push(`${source}.${key} must not supply a label or observation`);
    }
    validateBehaviorLabelsAbsent(item, `${source}.${key}`, errors);
  }
}

function validateBehaviorList(fixture: Mapping, holdout: Mapping, key: GlossaryMetricId extends never ? never : "discovery" | "scope" | "inferred_review" | "explicit_admission", validate: (record: Mapping, source: string, errors: string[]) => void, errors: string[]): void {
  const records = fixture[key];
  if (!Array.isArray(records)) {
    errors.push(`behavior_fixture.${key} must be a list`);
    return;
  }
  const seen = new Set<string>();
  for (const [index, item] of records.entries()) {
    const source = `behavior_fixture.${key}[${index}]`;
    const record = mapping(item);
    if (!record) {
      errors.push(`${source} must be a mapping`);
      continue;
    }
    validate(record, source, errors);
    if (nonEmptyString(record.id)) {
      if (seen.has(record.id)) errors.push(`${source}.id is duplicated`);
      seen.add(record.id);
    }
  }
  const holdoutIds = behaviorIds(holdout[key]);
  if (!sameIdSet(seen, holdoutIds)) {
    errors.push(`behavior_fixture.${key} must exactly cover frozen holdout ids`);
  }
}

export function validateFrozenGlossaryBehaviorFixture(authority: Mapping, holdout: Mapping, fixture: Mapping, fixtureBytes?: string | Buffer): string[] {
  const errors: string[] = [];
  if (fixture.schema_version !== GLOSSARY_BEHAVIOR_FIXTURE_SCHEMA_VERSION) {
    errors.push("behavior fixture schema_version is invalid");
  }
  if (fixture.fixture_id !== "personal-glossary-synthetic-behavior-v1" || fixture.status !== "frozen") {
    errors.push("behavior fixture must have the frozen synthetic identity");
  }
  exactFields(fixture, ["schema_version", "fixture_id", "status", "provenance", "synthetic_record_provenance", "discovery", "scope", "inferred_review", "explicit_admission"], "behavior_fixture", errors);
  const provenance = mapping(fixture.provenance);
  if (
    provenance?.record_class !== "synthetic" ||
    provenance?.consent !== "not_required_synthetic" ||
    provenance?.contains_personal_history !== false ||
    !nonEmptyString(provenance?.source) ||
    !nonEmptyString(provenance?.source_ref) ||
    provenance?.owner !== "evaluation_authority" ||
    provenance?.privacy_rule !== "no_raw_personal_history_or_transcript_content"
  ) {
    errors.push("behavior fixture provenance must identify synthetic privacy-safe product inputs");
  }
  if (fixtureBytes !== undefined) {
    const expected = mapping(mapping(authority.observations)?.behavior_fixture)?.fixture_sha256;
    if (!isLowerSha256(expected) || sha256(fixtureBytes) !== expected) {
      errors.push("behavior fixture digest does not match evaluation authority");
    }
  }
  validateBehaviorLabelsAbsent(fixture, "behavior_fixture", errors);
  validateBehaviorList(
    fixture,
    holdout,
    "discovery",
    (record, source, caseErrors) => {
      validateBehaviorTextCase(record, source, caseErrors, false);
    },
    errors,
  );
  validateBehaviorList(
    fixture,
    holdout,
    "scope",
    (record, source, caseErrors) => {
      validateBehaviorTextCase(record, source, caseErrors, true);
    },
    errors,
  );
  validateBehaviorList(fixture, holdout, "inferred_review", validateBehaviorInferredCase, errors);
  validateBehaviorList(
    fixture,
    holdout,
    "explicit_admission",
    (record, source, caseErrors) => {
      validateBehaviorTextCase(record, source, caseErrors, false);
    },
    errors,
  );
  return errors;
}

type ObservationSpec = {
  key: "discovery" | "scope" | "inferred_review" | "explicit_admission";
  observedField: string;
  kind: "boolean" | "scope";
};

const OBSERVATION_SPECS: readonly ObservationSpec[] = [
  { key: "discovery", observedField: "observed_discovered", kind: "boolean" },
  { key: "scope", observedField: "observed_scope", kind: "scope" },
  { key: "inferred_review", observedField: "observed_reviewed", kind: "boolean" },
  { key: "explicit_admission", observedField: "observed_admitted", kind: "boolean" },
];

/** Validate runtime observations after current product behavior has produced them. */
export function validateGlossaryObservations(authority: Mapping, holdout: Mapping, observations: Mapping): string[] {
  const errors: string[] = [];
  if (observations.schema_version !== GLOSSARY_OBSERVATIONS_SCHEMA_VERSION) {
    errors.push("observations schema_version is invalid");
  }
  if (observations.holdout_id !== holdout.holdout_id) {
    errors.push("observations holdout_id does not match the frozen holdout");
  }
  const expectedHoldoutDigest = mapping(authority.holdout)?.fixture_sha256;
  if (!isLowerSha256(observations.holdout_fixture_sha256) || observations.holdout_fixture_sha256 !== expectedHoldoutDigest) {
    errors.push("observations holdout_fixture_sha256 does not match the frozen holdout digest");
  }
  const expectedBehaviorDigest = mapping(mapping(authority.observations)?.behavior_fixture)?.fixture_sha256;
  if (!isLowerSha256(observations.behavior_fixture_sha256) || observations.behavior_fixture_sha256 !== expectedBehaviorDigest) {
    errors.push("observations behavior_fixture_sha256 does not match the frozen behavior fixture digest");
  }
  const allowedTopLevel = new Set(["schema_version", "holdout_id", "holdout_fixture_sha256", "behavior_fixture_sha256", ...OBSERVATION_SPECS.map(({ key }) => key)]);
  for (const field of Object.keys(observations)) {
    if (!allowedTopLevel.has(field)) errors.push(`observations.${field} is not an allowed field`);
  }
  const scopeLabels = strings(metricMapping(authority, "scope_accuracy")?.labels);
  for (const { key, observedField, kind } of OBSERVATION_SPECS) {
    const expectedIds = behaviorIds(holdout[key]);
    const records = observations[key];
    if (!Array.isArray(records)) {
      errors.push(`observations.${key} must be a list`);
      continue;
    }
    const seen = new Set<string>();
    for (const [index, value] of records.entries()) {
      const source = `observations.${key}[${index}]`;
      const record = mapping(value);
      if (!record) {
        errors.push(`${source} must be a mapping`);
        continue;
      }
      exactFields(record, ["id", observedField], source, errors);
      if (!nonEmptyString(record.id) || !expectedIds.has(record.id)) {
        errors.push(`${source}.id is unknown to the frozen holdout`);
      } else if (seen.has(record.id)) {
        errors.push(`${source}.id is duplicated`);
      } else {
        seen.add(record.id);
      }
      if (kind === "boolean" && typeof record[observedField] !== "boolean") {
        errors.push(`${source}.${observedField} must be boolean`);
      }
      if (kind === "scope" && !scopeLabels.includes(String(record[observedField] ?? ""))) {
        errors.push(`${source}.${observedField} is not an allowed scope label`);
      }
    }
    for (const expectedId of expectedIds) {
      if (!seen.has(expectedId)) errors.push(`observations.${key} is missing frozen id ${expectedId}`);
    }
  }
  return errors;
}

/** One-sided 95% Wilson lower bound. The authority fixes confidence at 0.95. */
export function wilsonLowerBound(successes: number, denominator: number, confidence = 0.95): number | null {
  if (!Number.isInteger(successes) || !Number.isInteger(denominator) || successes < 0 || denominator <= 0 || successes > denominator || confidence !== 0.95) {
    return null;
  }
  const z = ONE_SIDED_95_WILSON_Z;
  const zSquared = z * z;
  const estimate = successes / denominator;
  const center = estimate + zSquared / (2 * denominator);
  const margin = z * Math.sqrt((estimate * (1 - estimate)) / denominator + zSquared / (4 * denominator * denominator));
  return (center - margin) / (1 + zSquared / denominator);
}

function calculateMetric(metric: GlossaryMetricId, numerator: number, denominator: number, rule: MetricRule): MetricResult {
  const denominatorNonzero = Number.isInteger(denominator) && denominator > 0;
  const validCounts = denominatorNonzero && Number.isInteger(numerator) && numerator >= 0 && numerator <= denominator;
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
      one_sided: true,
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
    status: denominatorNonzero && validCounts && sampleSufficient && pointThreshold && uncertaintyThreshold ? "pass" : "fail",
    failure_reasons: failureReasons,
  };
}

export function calculateDiscoveryRecall(examples: readonly BinaryEvaluationExample[], rule: MetricRule): MetricResult {
  const eligible = examples.filter((example) => example.expected);
  return calculateMetric("discovery_recall", eligible.filter((example) => example.observed).length, eligible.length, rule);
}

export function calculateScopeAccuracy(examples: readonly ScopeEvaluationExample[], rule: MetricRule): MetricResult {
  return calculateMetric("scope_accuracy", examples.filter((example) => example.expected === example.observed).length, examples.length, rule);
}

export function calculateInferredReviewPrecision(examples: readonly BinaryEvaluationExample[], rule: MetricRule): MetricResult {
  const suggestions = examples.filter((example) => example.observed);
  return calculateMetric("inferred_review_precision", suggestions.filter((example) => example.expected).length, suggestions.length, rule);
}

export function calculateExplicitAdmissionPrecision(examples: readonly BinaryEvaluationExample[], rule: MetricRule): MetricResult {
  const admissions = examples.filter((example) => example.observed);
  return calculateMetric("explicit_admission_precision", admissions.filter((example) => example.expected).length, admissions.length, rule);
}
