import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  calculateDiscoveryRecall,
  calculateExplicitAdmissionPrecision,
  calculateInferredReviewPrecision,
  calculateScopeAccuracy,
  evaluateGlossaryHoldout,
  GLOSSARY_METRIC_IDS,
  loadGlossaryEvaluationAuthority,
  metricRule,
  validateFrozenGlossaryHoldout,
  validateGlossaryEvaluationAuthority,
  validateGlossaryObservations,
  wilsonLowerBound,
  type BinaryEvaluationExample,
  type ScopeEvaluationExample,
} from "../../src/eval/glossaryEvaluation.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(
  ROOT,
  "references/analysis/personal-glossary-evaluation-authority.yaml",
);
const HOLDOUT_PATH = path.join(ROOT, "references/analysis/personal-glossary-holdout.yaml");
const OBSERVATIONS_PATH = path.join(ROOT, "references/analysis/personal-glossary-observations.yaml");

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function authority() {
  return loadGlossaryEvaluationAuthority(ROOT);
}

function binaryExamples(
  count: number,
  successes: number,
): BinaryEvaluationExample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    expected: true,
    observed: index < successes,
  }));
}

function scopeExamples(count: number, successes: number): ScopeEvaluationExample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    expected: "personal",
    observed: index < successes ? "personal" : "project",
  }));
}

function reviewExamples(count: number, successes: number): BinaryEvaluationExample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    expected: index < successes,
    observed: true,
  }));
}

function admissionExamples(count: number, successes: number): BinaryEvaluationExample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    expected: index < successes,
    observed: true,
  }));
}

function tempRootWithCopiedAuthority(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-evaluation-"));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, "references", "analysis"), { recursive: true });
  fs.copyFileSync(AUTHORITY_PATH, path.join(root, "references/analysis/personal-glossary-evaluation-authority.yaml"));
  fs.copyFileSync(HOLDOUT_PATH, path.join(root, "references/analysis/personal-glossary-holdout.yaml"));
  fs.copyFileSync(OBSERVATIONS_PATH, path.join(root, "references/analysis/personal-glossary-observations.yaml"));
  return root;
}

describe("personal glossary evaluation authority", () => {
  it("validates the active authority and keeps all four metric denominators separate", () => {
    const raw = authority();
    expect(validateGlossaryEvaluationAuthority(raw)).toEqual([]);
    const metrics = raw.metrics as Record<string, Record<string, unknown>>;
    expect(metrics.discovery_recall.denominator).toBe("count_expected_discoverable_true");
    expect(metrics.scope_accuracy.denominator).toBe("count_all_scope_labeled_examples");
    expect(metrics.inferred_review_precision.denominator).toBe("count_observed_reviewed_true");
    expect(metrics.explicit_admission_precision.denominator).toBe("count_observed_admitted_true");
    expect(new Set(Object.values(metrics).map((metric) => metric.denominator)).size).toBe(4);
    expect(metrics.discovery_recall.minimum_sample_size).toBe(20);
    expect(metrics.scope_accuracy.point_estimate_minimum).toBe(0.95);
    expect(metrics.inferred_review_precision.point_estimate_minimum).toBe(0.95);
    expect(metrics.explicit_admission_precision.point_estimate_minimum).toBe(0.99);
    expect(
      (metrics.explicit_admission_precision.uncertainty as Record<string, unknown>).lower_bound_minimum,
    ).toBe(0.9);
  });

  it("requires observations before it can authorize a release gate", () => {
    const report = evaluateGlossaryHoldout(ROOT);
    expect(report).toMatchObject({
      status: "not_run",
      report: { release_gate: { release_authorizing: false, status: "not_run" } },
      observations: { status: "not_supplied" },
    });
    expect(report.metrics).toEqual([]);
  });

  it("runs the frozen synthetic corpus as a passing release-gate evaluation", () => {
    const report = evaluateGlossaryHoldout(ROOT, OBSERVATIONS_PATH);
    expect(report).toMatchObject({
      schemaVersion: "agentera.personalGlossaryEvaluation.v1",
      status: "pass",
      holdout: {
        status: "frozen",
        case_counts: { discovery: 20, scope: 20, inferred_review: 21, explicit_admission: 100 },
      },
      report: { release_gate: { release_authorizing: true, status: "pass" } },
      gates: { inferred_automatic_admission: { status: "disabled", enabled: false } },
    });
    const metrics = report.metrics as Array<Record<string, unknown>>;
    expect(metrics).toHaveLength(4);
    expect(metrics.every((metric) => metric.status === "pass")).toBe(true);
    expect(metrics.find((metric) => metric.metric === "inferred_review_precision")).toMatchObject({
      numerator: 19,
      denominator: 20,
      point_estimate: 0.95,
      uncertainty: { lower_bound: 0.8039927632259837 },
    });
    expect(metrics.find((metric) => metric.metric === "explicit_admission_precision")).toMatchObject({
      numerator: 99,
      denominator: 100,
      point_estimate: 0.99,
    });
    expect((report.report as Record<string, unknown>).exploratory).toMatchObject({ release_authorizing: false });
  });
});

describe("separate metric calculations", () => {
  const authorityRecord = authority();
  const rules = Object.fromEntries(
    GLOSSARY_METRIC_IDS.map((metric) => [metric, metricRule(authorityRecord, metric)]),
  ) as Record<string, ReturnType<typeof metricRule>>;

  it("passes and fails discovery recall with its positive-label denominator", () => {
    expect(calculateDiscoveryRecall(binaryExamples(20, 20), rules.discovery_recall).status).toBe("pass");
    expect(calculateDiscoveryRecall(binaryExamples(20, 17), rules.discovery_recall)).toMatchObject({
      status: "fail",
      numerator: 17,
      denominator: 20,
      failure_reasons: expect.arrayContaining(["point_threshold"]),
    });
  });

  it("passes and fails scope accuracy with the all-example denominator", () => {
    expect(calculateScopeAccuracy(scopeExamples(100, 95), rules.scope_accuracy).status).toBe("pass");
    expect(calculateScopeAccuracy(scopeExamples(100, 94), rules.scope_accuracy)).toMatchObject({
      status: "fail",
      numerator: 94,
      denominator: 100,
      failure_reasons: expect.arrayContaining(["point_threshold"]),
    });
  });

  it("passes and fails inferred-review precision among review suggestions", () => {
    expect(
      calculateInferredReviewPrecision(reviewExamples(20, 20), rules.inferred_review_precision).status,
    ).toBe("pass");
    expect(calculateInferredReviewPrecision(reviewExamples(20, 18), rules.inferred_review_precision)).toMatchObject({
      status: "fail",
      numerator: 18,
      denominator: 20,
      failure_reasons: expect.arrayContaining(["point_threshold"]),
    });
  });

  it("passes and fails explicit-admission precision among admissions", () => {
    expect(
      calculateExplicitAdmissionPrecision(admissionExamples(100, 99), rules.explicit_admission_precision).status,
    ).toBe("pass");
    expect(calculateExplicitAdmissionPrecision(admissionExamples(100, 98), rules.explicit_admission_precision)).toMatchObject({
      status: "fail",
      numerator: 98,
      denominator: 100,
      failure_reasons: expect.arrayContaining(["point_threshold"]),
    });
  });

  it("fails closed for zero denominators and insufficient samples", () => {
    const zeroReview = calculateInferredReviewPrecision(
      [{ id: "no-suggestion", expected: true, observed: false }],
      rules.inferred_review_precision,
    );
    expect(zeroReview).toMatchObject({ status: "fail", denominator: 0, point_estimate: null });
    expect(zeroReview.failure_reasons).toContain("denominator_zero");
    expect(calculateDiscoveryRecall(binaryExamples(19, 19), rules.discovery_recall).failure_reasons).toContain(
      "insufficient_sample",
    );
    expect(calculateExplicitAdmissionPrecision(admissionExamples(49, 49), rules.explicit_admission_precision).failure_reasons).toContain(
      "insufficient_sample",
    );
  });

  it("uses the exact one-sided 95% Wilson critical value", () => {
    expect(wilsonLowerBound(19, 20)).toBe(0.8039927632259837);
  });

  it("uses the threshold boundary and the unrounded Wilson lower bound", () => {
    expect(calculateScopeAccuracy(scopeExamples(100, 95), rules.scope_accuracy).point_estimate).toBe(0.95);
    expect(calculateScopeAccuracy(scopeExamples(100, 95), rules.scope_accuracy).status).toBe("pass");
    expect(calculateScopeAccuracy(scopeExamples(100, 94), rules.scope_accuracy).status).toBe("fail");
    expect(wilsonLowerBound(99, 100)).toBeGreaterThan(0.9);
    expect(wilsonLowerBound(98, 100)).toBeGreaterThan(0.9);
  });
});

describe("holdout privacy and label immutability", () => {
  it("rejects a changed expected label before calculating metrics", () => {
    const root = tempRootWithCopiedAuthority();
    const holdoutPath = path.join(root, "references/analysis/personal-glossary-holdout.yaml");
    const altered = fs.readFileSync(holdoutPath, "utf8").replace(
      "expected_discoverable: true",
      "expected_discoverable: false",
    );
    fs.writeFileSync(holdoutPath, altered, "utf8");
    const report = evaluateGlossaryHoldout(root, "references/analysis/personal-glossary-observations.yaml");
    expect(report).toMatchObject({
      status: "fail",
      report: { release_gate: { release_authorizing: true, status: "fail" } },
    });
    expect(JSON.stringify(report)).toContain("holdout fixture digest does not match evaluation authority");
    expect(report.metrics).toEqual([]);
  });

  it("rejects non-synthetic provenance without consent provenance", () => {
    const rawAuthority = authority();
    const holdout = YAML.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as Record<string, unknown>;
    const provenance = holdout.provenance as Record<string, unknown>;
    provenance.record_class = "imported";
    const errors = validateFrozenGlossaryHoldout(rawAuthority, holdout);
    expect(errors).toContain("holdout provenance must identify a synthetic, privacy-safe authority source");
    expect(errors.some((error) => error.includes("provenance.record_class is not allowed"))).toBe(false);
  });

  it("requires per-record consent fields when a record is not synthetic", () => {
    const rawAuthority = authority();
    const holdout = YAML.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as Record<string, any>;
    holdout.discovery[0].provenance.record_class = "consented";
    const errors = validateFrozenGlossaryHoldout(rawAuthority, holdout);
    expect(errors).toContain("holdout.discovery[0].provenance consented record lacks consent provenance");
  });

  it("keeps expected labels in the frozen holdout and observations separate", () => {
    const rawAuthority = authority();
    const holdout = YAML.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as Record<string, any>;
    const observations = YAML.parse(fs.readFileSync(OBSERVATIONS_PATH, "utf8")) as Record<string, any>;
    expect(validateFrozenGlossaryHoldout(rawAuthority, holdout)).toEqual([]);
    expect(validateGlossaryObservations(rawAuthority, holdout, observations)).toEqual([]);
    expect(JSON.stringify(holdout)).not.toContain("observed_");
  });

  it("rejects incomplete observations before calculating metrics", () => {
    const root = tempRootWithCopiedAuthority();
    const observationsPath = path.join(root, "references/analysis/personal-glossary-observations.yaml");
    const observations = YAML.parse(fs.readFileSync(observationsPath, "utf8")) as Record<string, any>;
    observations.discovery.pop();
    fs.writeFileSync(observationsPath, YAML.stringify(observations), "utf8");
    const report = evaluateGlossaryHoldout(root, observationsPath);
    expect(report).toMatchObject({ status: "fail", metrics: [] });
    expect(JSON.stringify(report)).toContain("observations.discovery is missing frozen id discovery-20");
  });

  it("rejects observation digest drift before calculating metrics", () => {
    const root = tempRootWithCopiedAuthority();
    const observationsPath = path.join(root, "references/analysis/personal-glossary-observations.yaml");
    const observations = YAML.parse(fs.readFileSync(observationsPath, "utf8")) as Record<string, any>;
    observations.holdout_fixture_sha256 = "0".repeat(64);
    fs.writeFileSync(observationsPath, YAML.stringify(observations), "utf8");
    const report = evaluateGlossaryHoldout(root, observationsPath);
    expect(report).toMatchObject({ status: "fail", metrics: [] });
    expect(JSON.stringify(report)).toContain(
      "observations holdout_fixture_sha256 does not match the frozen holdout digest",
    );
  });

  it("keeps inferred automatic admission disabled even when all measured gates pass", () => {
    const report = evaluateGlossaryHoldout(ROOT, OBSERVATIONS_PATH);
    expect(report.gates).toMatchObject({ inferred_automatic_admission: { status: "disabled", enabled: false } });
    const mutated = structuredClone(authority()) as Record<string, any>;
    (mutated.gates as Record<string, any>).inferred_automatic_admission.status = "enabled";
    expect(validateGlossaryEvaluationAuthority(mutated)).toContain(
      "evaluation authority must distinguish exploratory reports from the release gate",
    );
  });
});
