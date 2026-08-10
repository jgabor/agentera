import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  canonicalDigest,
  GLOSSARY_EVALUATION_SCHEMA_VERSION,
  GLOSSARY_METRIC_IDS,
  glossaryEvaluationAuthorityPath,
  glossaryEvaluationBehaviorFixturePath,
  glossaryEvaluationCaseCounts,
  glossaryEvaluationHoldoutPath,
  glossaryEvaluationLabelDigest,
  loadGlossaryEvaluationAuthority,
  loadGlossaryEvaluationBehaviorFixture,
  loadGlossaryEvaluationHoldout,
  mapping,
  metricRule,
  sha256,
  validateFrozenGlossaryBehaviorFixture,
  validateFrozenGlossaryHoldout,
  validateGlossaryEvaluationAuthority,
  wilsonLowerBound,
  type GlossaryEvaluationCaseCounts,
  type GlossaryMetricId,
  type Mapping,
  type MetricResult,
} from "./glossaryEvaluation.js";

const MAX_SUCCESS_REPORT_UTF8_BYTES = 1_048_576;
const POLICY_PATH = "references/artifacts/glossary-entry-contract.yaml";
const SUCCESS_REPORT_FIELDS = [
  "schemaVersion",
  "status",
  "report",
  "authority",
  "policy",
  "holdout",
  "behavior_fixture",
  "observations",
  "metrics",
  "metrics_sha256",
  "gates",
  "denominator_counts",
] as const;

export interface GlossaryEvaluationSuccessInput {
  returncode: number;
  stdout: string;
}

/** The bounded evaluator result safe to expose publicly or use for authorization. */
export interface GlossaryEvaluationSuccessReport {
  metrics: MetricResult[];
  metrics_sha256: string;
}

type CurrentBindings = {
  authority: Mapping;
  authorityBytes: Buffer;
  holdout: Mapping;
  holdoutBytes: Buffer;
  behavior: Mapping;
  behaviorBytes: Buffer;
  policyBytes: Buffer;
  holdoutCaseCounts: GlossaryEvaluationCaseCounts;
  behaviorCaseCounts: GlossaryEvaluationCaseCounts;
};

function record(value: unknown): Mapping | null {
  return mapping(value);
}

function exactFields(value: Mapping, expected: readonly string[]): boolean {
  const fields = Object.keys(value);
  return fields.length === expected.length && expected.every((field) => Object.hasOwn(value, field));
}

function same(value: unknown, expected: unknown): boolean {
  try {
    return canonicalDigest(value) === canonicalDigest(expected);
  } catch {
    return false;
  }
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function currentBindings(root: string): CurrentBindings | null {
  try {
    const authorityPath = glossaryEvaluationAuthorityPath(root);
    const holdoutPath = glossaryEvaluationHoldoutPath(root);
    const behaviorPath = glossaryEvaluationBehaviorFixturePath(root);
    const authorityBytes = fs.readFileSync(authorityPath);
    const holdoutBytes = fs.readFileSync(holdoutPath);
    const behaviorBytes = fs.readFileSync(behaviorPath);
    const authority = loadGlossaryEvaluationAuthority(root);
    const holdout = loadGlossaryEvaluationHoldout(root);
    const behavior = loadGlossaryEvaluationBehaviorFixture(root);
    if (
      validateGlossaryEvaluationAuthority(authority).length > 0 ||
      validateFrozenGlossaryHoldout(authority, holdout, holdoutBytes).length > 0 ||
      validateFrozenGlossaryBehaviorFixture(authority, holdout, behavior, behaviorBytes).length > 0
    ) {
      return null;
    }
    return {
      authority,
      authorityBytes,
      holdout,
      holdoutBytes,
      behavior,
      behaviorBytes,
      policyBytes: fs.readFileSync(path.join(root, POLICY_PATH)),
      holdoutCaseCounts: glossaryEvaluationCaseCounts(holdout),
      behaviorCaseCounts: glossaryEvaluationCaseCounts(behavior),
    };
  } catch {
    return null;
  }
}

function passedMetric(
  value: unknown,
  expectedMetric: GlossaryMetricId,
  authority: Mapping,
): MetricResult | null {
  const source = record(value);
  if (source === null || source.metric !== expectedMetric) return null;
  const uncertainty = record(source.uncertainty);
  const thresholds = record(source.thresholds);
  const gates = record(source.gates);
  if (uncertainty === null || thresholds === null || gates === null) return null;

  const numerator = source.numerator;
  const denominator = source.denominator;
  const pointEstimate = source.point_estimate;
  const lowerBound = uncertainty.lower_bound;
  const rule = metricRule(authority, expectedMetric);
  if (
    !nonNegativeInteger(numerator) ||
    !positiveInteger(denominator) ||
    numerator > denominator ||
    !probability(pointEstimate) ||
    !probability(lowerBound) ||
    pointEstimate !== numerator / denominator ||
    lowerBound !== wilsonLowerBound(numerator, denominator, rule.confidence) ||
    denominator < rule.minimumSampleSize ||
    pointEstimate < rule.pointEstimateMinimum ||
    lowerBound < rule.lowerBoundMinimum ||
    uncertainty.method !== rule.uncertaintyMethod ||
    uncertainty.confidence !== rule.confidence ||
    uncertainty.one_sided !== true ||
    thresholds.minimum_sample_size !== rule.minimumSampleSize ||
    thresholds.point_estimate_minimum !== rule.pointEstimateMinimum ||
    thresholds.lower_bound_minimum !== rule.lowerBoundMinimum ||
    gates.denominator_nonzero !== true ||
    gates.sample_sufficient !== true ||
    gates.point_threshold !== true ||
    gates.uncertainty_threshold !== true ||
    source.status !== "pass" ||
    !Array.isArray(source.failure_reasons) ||
    source.failure_reasons.length !== 0
  ) {
    return null;
  }
  const metric: MetricResult = {
    metric: expectedMetric,
    numerator,
    denominator,
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
      denominator_nonzero: true,
      sample_sufficient: true,
      point_threshold: true,
      uncertainty_threshold: true,
    },
    status: "pass",
    failure_reasons: [],
  };
  return same(source, metric) ? metric : null;
}

function validObservationSeams(value: unknown, counts: GlossaryEvaluationCaseCounts): boolean {
  const seams = Array.isArray(value) ? value : null;
  const expected = [
    ["discovery_recall", "discovery", "mineExplicitGlossaryCandidates", false],
    ["scope_accuracy", "scope", "mineExplicitGlossaryCandidates", true],
    ["inferred_review_precision", "inferred_review", "mineRecurringGlossaryCandidates+personalGlossaryDecision.v2", false],
    ["explicit_admission_precision", "explicit_admission", "mineExplicitGlossaryCandidates+personalGlossaryDecision.v2", false],
  ] as const;
  if (seams === null || seams.length !== expected.length) return false;
  return expected.every(([metric, family, producer, hasAbstentions], index) => {
    const seam = record(seams[index]);
    if (seam === null || !exactFields(seam, hasAbstentions
      ? ["metric", "producer", "cases", "candidates", "abstentions"]
      : ["metric", "producer", "cases", "candidates"])) return false;
    const candidates = seam.candidates;
    const abstentions = seam.abstentions;
    return seam.metric === metric &&
      seam.producer === producer &&
      seam.cases === counts[family] &&
      nonNegativeInteger(candidates) &&
      candidates <= counts[family] &&
      (!hasAbstentions || (
        nonNegativeInteger(abstentions) &&
        candidates + abstentions <= counts[family]
      ));
  });
}

function validBindings(source: Mapping, bindings: CurrentBindings): boolean {
  const expectedAuthority = {
    schema_version: bindings.authority.schema_version,
    path: "references/analysis/personal-glossary-evaluation-authority.yaml",
    sha256: sha256(bindings.authorityBytes),
  };
  const expectedPolicy = { path: POLICY_PATH, sha256: sha256(bindings.policyBytes) };
  const expectedHoldout = {
    id: bindings.holdout.holdout_id,
    status: bindings.holdout.status,
    fixture_sha256: sha256(bindings.holdoutBytes),
    labels_sha256: glossaryEvaluationLabelDigest(bindings.holdout),
    provenance: bindings.holdout.provenance,
    case_counts: bindings.holdoutCaseCounts,
  };
  const expectedBehavior = {
    id: bindings.behavior.fixture_id,
    status: bindings.behavior.status,
    path: "references/analysis/personal-glossary-evaluation-corpus.yaml",
    fixture_sha256: sha256(bindings.behaviorBytes),
    provenance: bindings.behavior.provenance,
    case_counts: bindings.behaviorCaseCounts,
  };
  const observations = record(source.observations);
  return same(source.authority, expectedAuthority) &&
    same(source.policy, expectedPolicy) &&
    same(source.holdout, expectedHoldout) &&
    same(source.behavior_fixture, expectedBehavior) &&
    observations !== null &&
    exactFields(observations, [
      "schema_version",
      "source",
      "sha256",
      "holdout_fixture_sha256",
      "behavior_fixture_sha256",
      "case_counts",
      "seams",
      "effects",
    ]) &&
    observations.schema_version === "agentera.personalGlossaryEvaluationObservations.v2" &&
    observations.source === "current_product_behavior" &&
    isLowerSha256(observations.sha256) &&
    observations.holdout_fixture_sha256 === expectedHoldout.fixture_sha256 &&
    observations.behavior_fixture_sha256 === expectedBehavior.fixture_sha256 &&
    same(observations.case_counts, bindings.holdoutCaseCounts) &&
    same(observations.effects, []) &&
    validObservationSeams(observations.seams, bindings.holdoutCaseCounts);
}

function validReleaseReport(source: Mapping, metrics: MetricResult[]): boolean {
  const expectedReport = {
    exploratory: { release_authorizing: false, status: "report_only", metrics },
    release_gate: {
      release_authorizing: true,
      release_authorized: true,
      status: "pass",
      failure_reasons: [],
    },
  };
  const expectedGates = {
    explicit_admission: {
      metric: "explicit_admission_precision",
      status: "pass",
      qualification_blocker: true,
      outcome: "explicit_automatic_admission_only",
    },
    inferred_review: {
      metric: "inferred_review_precision",
      status: "pass",
      outcome: "review_suggestions_only",
    },
    inferred_automatic_admission: {
      status: "disabled",
      enabled: false,
      measured_result: "cannot_enable",
    },
    release_authorizing: "pass",
  };
  const denominatorCounts = Object.fromEntries(
    metrics.map(({ metric, denominator }) => [metric, denominator]),
  );
  return same(source.report, expectedReport) &&
    same(source.gates, expectedGates) &&
    same(source.denominator_counts, denominatorCounts);
}

/**
 * Accept only the current, complete, successful glossary evaluator report.
 * This parser reads authority inputs but never imports or runs the evaluator.
 */
export function validateGlossaryEvaluationSuccessReport(
  result: GlossaryEvaluationSuccessInput,
  root: string = resolveSourceRoot(),
): GlossaryEvaluationSuccessReport | null {
  if (result.returncode !== 0 || Buffer.byteLength(result.stdout, "utf8") > MAX_SUCCESS_REPORT_UTF8_BYTES) {
    return null;
  }
  let source: Mapping | null;
  try {
    source = record(JSON.parse(result.stdout));
  } catch {
    return null;
  }
  if (
    source === null ||
    !exactFields(source, SUCCESS_REPORT_FIELDS) ||
    source.schemaVersion !== GLOSSARY_EVALUATION_SCHEMA_VERSION ||
    source.status !== "pass"
  ) {
    return null;
  }
  const bindings = currentBindings(root);
  if (bindings === null || !validBindings(source, bindings)) return null;

  const sourceMetrics = source.metrics;
  if (!Array.isArray(sourceMetrics) || sourceMetrics.length !== GLOSSARY_METRIC_IDS.length) return null;
  const metrics: MetricResult[] = [];
  for (const [index, metric] of GLOSSARY_METRIC_IDS.entries()) {
    const passed = passedMetric(sourceMetrics[index], metric, bindings.authority);
    if (passed === null) return null;
    metrics.push(passed);
  }
  const metricsSha256 = source.metrics_sha256;
  if (
    !isLowerSha256(metricsSha256) ||
    metricsSha256 !== canonicalDigest(metrics) ||
    canonicalDigest(sourceMetrics) !== canonicalDigest(metrics) ||
    !validReleaseReport(source, metrics)
  ) {
    return null;
  }
  return { metrics, metrics_sha256: metricsSha256 };
}
