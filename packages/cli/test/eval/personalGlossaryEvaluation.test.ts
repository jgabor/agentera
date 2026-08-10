import crypto from "node:crypto";
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
  canonicalDigest,
  GLOSSARY_METRIC_IDS,
  loadGlossaryEvaluationAuthority,
  loadGlossaryEvaluationBehaviorFixture,
  metricRule,
  validateFrozenGlossaryBehaviorFixture,
  validateFrozenGlossaryHoldout,
  validateGlossaryEvaluationAuthority,
  validateGlossaryObservations,
  wilsonLowerBound,
  type BinaryEvaluationExample,
  type ScopeEvaluationExample,
} from "../../src/eval/glossaryEvaluation.js";
import { validateGlossaryEvaluationSuccessReport } from "../../src/eval/glossaryEvaluationSuccessReport.js";
import {
  evaluateGlossaryBehavior,
  evaluateGlossaryHoldout,
  main,
} from "../../src/eval/glossaryEvaluationRunner.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const ANALYSIS = path.join(ROOT, "references", "analysis");
const AUTHORITY_PATH = path.join(ANALYSIS, "personal-glossary-evaluation-authority.yaml");
const HOLDOUT_PATH = path.join(ANALYSIS, "personal-glossary-holdout.yaml");
const BEHAVIOR_PATH = path.join(ANALYSIS, "personal-glossary-evaluation-corpus.yaml");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function authority() {
  return loadGlossaryEvaluationAuthority(ROOT);
}

function binaryExamples(count: number, successes: number): BinaryEvaluationExample[] {
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

function copiedEvaluationRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-evaluation-"));
  temporaryRoots.push(root);
  const analysis = path.join(root, "references", "analysis");
  fs.mkdirSync(analysis, { recursive: true });
  for (const name of [
    "personal-glossary-evaluation-authority.yaml",
    "personal-glossary-holdout.yaml",
    "personal-glossary-evaluation-corpus.yaml",
  ]) {
    fs.copyFileSync(path.join(ANALYSIS, name), path.join(analysis, name));
  }
  return root;
}

function updateBehaviorDigest(root: string): void {
  const authorityPath = path.join(root, "references", "analysis", "personal-glossary-evaluation-authority.yaml");
  const behaviorPath = path.join(root, "references", "analysis", "personal-glossary-evaluation-corpus.yaml");
  const authorityRecord = YAML.parse(fs.readFileSync(authorityPath, "utf8")) as Record<string, any>;
  authorityRecord.observations.behavior_fixture.fixture_sha256 = sha256(fs.readFileSync(behaviorPath));
  fs.writeFileSync(authorityPath, YAML.stringify(authorityRecord), "utf8");
}

function observationsFor(holdout: Record<string, any>, behaviorBytes: Buffer): Record<string, any> {
  const execution = evaluateGlossaryBehavior(loadGlossaryEvaluationBehaviorFixture(ROOT));
  return {
    schema_version: "agentera.personalGlossaryEvaluationObservations.v2",
    holdout_id: holdout.holdout_id,
    holdout_fixture_sha256: sha256(fs.readFileSync(HOLDOUT_PATH)),
    behavior_fixture_sha256: sha256(behaviorBytes),
    discovery: execution.discovery,
    scope: execution.scope,
    inferred_review: execution.inferred_review,
    explicit_admission: execution.explicit_admission,
  };
}

describe("personal glossary product evaluation", () => {
  it("runs frozen synthetic inputs through current production seams reproducibly", () => {
    const rawAuthority = authority();
    const holdout = YAML.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as Record<string, unknown>;
    const behavior = loadGlossaryEvaluationBehaviorFixture(ROOT);
    expect(validateGlossaryEvaluationAuthority(rawAuthority)).toEqual([]);
    expect(validateFrozenGlossaryHoldout(rawAuthority, holdout, fs.readFileSync(HOLDOUT_PATH))).toEqual([]);
    expect(validateFrozenGlossaryBehaviorFixture(rawAuthority, holdout, behavior, fs.readFileSync(BEHAVIOR_PATH))).toEqual([]);
    expect(JSON.stringify(behavior)).not.toMatch(/expected_|observed_|"labels"/u);

    const first = evaluateGlossaryHoldout(ROOT);
    const second = evaluateGlossaryHoldout(ROOT);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "pass",
      policy: { path: "references/artifacts/glossary-entry-contract.yaml", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      holdout: {
        status: "frozen",
        labels_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        provenance: { record_class: "synthetic", contains_personal_history: false },
        case_counts: { discovery: 20, scope: 20, inferred_review: 21, explicit_admission: 100 },
      },
      behavior_fixture: {
        status: "frozen",
        provenance: { record_class: "synthetic", contains_personal_history: false },
      },
      observations: {
        source: "current_product_behavior",
        effects: [],
        seams: [
          { producer: "mineExplicitGlossaryCandidates" },
          { producer: "mineExplicitGlossaryCandidates" },
          { producer: "mineRecurringGlossaryCandidates+personalGlossaryDecision.v2" },
          { producer: "mineExplicitGlossaryCandidates+personalGlossaryDecision.v2" },
        ],
      },
      gates: {
        explicit_admission: { status: "pass", qualification_blocker: true },
        inferred_review: { status: "pass", outcome: "review_suggestions_only" },
        inferred_automatic_admission: { status: "disabled", enabled: false },
        release_authorizing: "pass",
      },
    });
    const metrics = first.metrics as Array<Record<string, any>>;
    expect(first.metrics_sha256).toBe(canonicalDigest(metrics));
    expect(validateGlossaryEvaluationSuccessReport({ returncode: 0, stdout: JSON.stringify(first) }, ROOT)).toEqual({
      metrics,
      metrics_sha256: first.metrics_sha256,
    });
    const stale = structuredClone(first) as Record<string, any>;
    stale.authority.sha256 = "0".repeat(64);
    expect(validateGlossaryEvaluationSuccessReport({ returncode: 0, stdout: JSON.stringify(stale) }, ROOT)).toBeNull();
    expect(metrics[0]).toMatchObject({ metric: "discovery_recall", numerator: 20, denominator: 20, point_estimate: 1, status: "pass" });
    expect(metrics[1]).toMatchObject({ metric: "scope_accuracy", numerator: 20, denominator: 20, point_estimate: 1, status: "pass" });
    expect(metrics[2]).toMatchObject({ metric: "inferred_review_precision", numerator: 19, denominator: 20, point_estimate: 0.95, uncertainty: { one_sided: true, lower_bound: 0.8039927632259837 }, status: "pass" });
    expect(metrics[3]).toMatchObject({ metric: "explicit_admission_precision", numerator: 99, denominator: 100, point_estimate: 0.99, uncertainty: { one_sided: true, lower_bound: 0.9564182264659439 }, status: "pass" });
    expect(JSON.stringify(first)).not.toContain("synthetic automatic meaning 001");
    expect(JSON.stringify(first)).not.toContain(os.tmpdir());

    const labels = holdout as Record<string, Array<Record<string, unknown>>>;
    expect(labels.inferred_review.find(({ id }) => id === "review-20")?.expected_reviewable).toBe(false);
    expect(labels.explicit_admission.find(({ id }) => id === "admission-100")?.expected_admissible).toBe(false);
    expect((behavior.inferred_review as Array<Record<string, any>>).find(({ id }) => id === "review-20")?.sources)
      .toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("deprecated") })]));
    expect((behavior.explicit_admission as Array<Record<string, unknown>>).find(({ id }) => id === "admission-100")?.text)
      .toContain("exclude this legacy alias");
    const execution = evaluateGlossaryBehavior(behavior);
    expect(execution.inferred_review.map(({ id }) => id)).toEqual(
      (behavior.inferred_review as Array<Record<string, unknown>>).map(({ id }) => id),
    );
    // The 100 admission cases exceed one projection's 50-candidate contract bound.
    expect(execution.explicit_admission.map(({ id }) => id)).toEqual(
      (behavior.explicit_admission as Array<Record<string, unknown>>).map(({ id }) => id),
    );
    expect(execution.inferred_review.find(({ id }) => id === "review-20")).toEqual({ id: "review-20", observed_reviewed: true });
    expect(execution.explicit_admission.find(({ id }) => id === "admission-100")).toEqual({ id: "admission-100", observed_admitted: true });
  });

  it("fails the explicit qualification gate from changed product observations without relabeling", () => {
    const root = copiedEvaluationRoot();
    const holdoutPath = path.join(root, "references", "analysis", "personal-glossary-holdout.yaml");
    const behaviorPath = path.join(root, "references", "analysis", "personal-glossary-evaluation-corpus.yaml");
    const originalLabels = fs.readFileSync(holdoutPath);
    const baseline = evaluateGlossaryHoldout(root) as Record<string, any>;
    const behavior = YAML.parse(fs.readFileSync(behaviorPath, "utf8"), { maxAliasCount: 256 }) as Record<string, any>;
    for (const record of behavior.explicit_admission.slice(0, 50)) {
      record.text = `Is \`${record.id}\` an automatic glossary admission?`;
    }
    behavior.inferred_review[20].sources.push({
      source_kind: "project_config_signal",
      text: behavior.inferred_review[20].term,
    });
    fs.writeFileSync(behaviorPath, YAML.stringify(behavior), "utf8");
    updateBehaviorDigest(root);

    let output = "";
    expect(main((line) => { output += line; }, root)).toBe(1);
    const report = JSON.parse(output);
    expect(fs.readFileSync(holdoutPath)).toEqual(originalLabels);
    expect(report).toMatchObject({
      status: "fail",
      report: { release_gate: { release_authorizing: true, release_authorized: false, status: "fail" } },
      gates: {
        explicit_admission: { status: "fail", qualification_blocker: true },
        inferred_review: { status: "fail", outcome: "review_suggestions_only" },
        inferred_automatic_admission: { status: "disabled", enabled: false },
        release_authorizing: "fail_closed",
      },
    });
    const metrics = report.metrics as Array<Record<string, any>>;
    expect(report.metrics_sha256).toBe(canonicalDigest(metrics));
    expect(report.metrics_sha256).not.toBe(baseline.metrics_sha256);
    expect(metrics.find((metric) => metric.metric === "explicit_admission_precision")).toMatchObject({
      numerator: 49,
      denominator: 50,
      point_estimate: 0.98,
      status: "fail",
      failure_reasons: expect.arrayContaining(["point_threshold"]),
    });
    expect(metrics.find((metric) => metric.metric === "inferred_review_precision")).toMatchObject({
      numerator: 19,
      denominator: 21,
      status: "fail",
    });
    expect(output).toContain('"release_authorizing": "fail_closed"');
  });

  it("fails before metrics when frozen holdout or corpus digests drift", () => {
    const root = copiedEvaluationRoot();
    const holdoutPath = path.join(root, "references", "analysis", "personal-glossary-holdout.yaml");
    fs.writeFileSync(
      holdoutPath,
      fs.readFileSync(holdoutPath, "utf8").replace("expected_discoverable: true", "expected_discoverable: false"),
      "utf8",
    );
    const report = evaluateGlossaryHoldout(root);
    expect(report).toMatchObject({ status: "fail", metrics: [] });
    expect(JSON.stringify(report)).toContain("holdout fixture digest does not match evaluation authority");

    const corpusRoot = copiedEvaluationRoot();
    const corpusPath = path.join(corpusRoot, "references", "analysis", "personal-glossary-evaluation-corpus.yaml");
    fs.appendFileSync(corpusPath, "\n# changed frozen behavior bytes\n");
    const corpusReport = evaluateGlossaryHoldout(corpusRoot);
    expect(corpusReport).toMatchObject({ status: "fail", metrics: [] });
    expect(JSON.stringify(corpusReport)).toContain("behavior fixture digest does not match evaluation authority");

    const behavior = structuredClone(loadGlossaryEvaluationBehaviorFixture(ROOT));
    const canonicalHoldout = YAML.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as Record<string, unknown>;
    (behavior.discovery as Array<Record<string, unknown>>)[0]!.provenance = {
      record_class: "consented",
      consent_subject: "synthetic-user",
    };
    expect(validateFrozenGlossaryBehaviorFixture(authority(), canonicalHoldout, behavior)).toContain(
      "behavior_fixture.discovery[0].provenance must be synthetic",
    );
  });

  it("rejects missing, unknown, and duplicate runtime observation identifiers", () => {
    const holdout = YAML.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as Record<string, any>;
    const observed = observationsFor(holdout, fs.readFileSync(BEHAVIOR_PATH));

    const missing = structuredClone(observed);
    missing.discovery.pop();
    expect(validateGlossaryObservations(authority(), holdout, missing)).toContain(
      "observations.discovery is missing frozen id discovery-20",
    );

    const unknown = structuredClone(observed);
    unknown.discovery[0].id = "unknown-discovery";
    expect(validateGlossaryObservations(authority(), holdout, unknown)).toContain(
      "observations.discovery[0].id is unknown to the frozen holdout",
    );

    const duplicate = structuredClone(observed);
    duplicate.discovery[1].id = duplicate.discovery[0].id;
    expect(validateGlossaryObservations(authority(), holdout, duplicate)).toContain(
      "observations.discovery[1].id is duplicated",
    );
  });
});

describe("separate metric calculations", () => {
  const authorityRecord = authority();
  const rules = Object.fromEntries(
    GLOSSARY_METRIC_IDS.map((metric) => [metric, metricRule(authorityRecord, metric)]),
  ) as Record<string, ReturnType<typeof metricRule>>;

  it("passes and fails every authority-owned denominator and point threshold", () => {
    expect(calculateDiscoveryRecall(binaryExamples(20, 20), rules.discovery_recall).status).toBe("pass");
    expect(calculateDiscoveryRecall(binaryExamples(20, 17), rules.discovery_recall).status).toBe("fail");
    expect(calculateScopeAccuracy(scopeExamples(100, 95), rules.scope_accuracy).status).toBe("pass");
    expect(calculateScopeAccuracy(scopeExamples(100, 94), rules.scope_accuracy).status).toBe("fail");
    expect(calculateInferredReviewPrecision(reviewExamples(20, 20), rules.inferred_review_precision).status).toBe("pass");
    expect(calculateInferredReviewPrecision(reviewExamples(20, 18), rules.inferred_review_precision).status).toBe("fail");
    expect(calculateExplicitAdmissionPrecision(admissionExamples(100, 99), rules.explicit_admission_precision).status).toBe("pass");
    expect(calculateExplicitAdmissionPrecision(admissionExamples(100, 98), rules.explicit_admission_precision).status).toBe("fail");
  });

  it("fails closed for every zero denominator and reports one-sided uncertainty", () => {
    const zeroes = [
      calculateDiscoveryRecall([], rules.discovery_recall),
      calculateScopeAccuracy([], rules.scope_accuracy),
      calculateInferredReviewPrecision([], rules.inferred_review_precision),
      calculateExplicitAdmissionPrecision([], rules.explicit_admission_precision),
    ];
    for (const result of zeroes) {
      expect(result).toMatchObject({ status: "fail", denominator: 0, point_estimate: null });
      expect(result.failure_reasons).toContain("denominator_zero");
    }
    expect(wilsonLowerBound(19, 20)).toBe(0.8039927632259837);
    expect(calculateDiscoveryRecall(binaryExamples(20, 18), rules.discovery_recall).failure_reasons).toContain(
      "uncertainty_threshold",
    );
  });

  it("fails each metric when its eligible sample is below the authority minimum", () => {
    const insufficient = [
      calculateDiscoveryRecall(binaryExamples(19, 19), rules.discovery_recall),
      calculateScopeAccuracy(scopeExamples(19, 19), rules.scope_accuracy),
      calculateInferredReviewPrecision(reviewExamples(19, 19), rules.inferred_review_precision),
      calculateExplicitAdmissionPrecision(admissionExamples(49, 49), rules.explicit_admission_precision),
    ];
    for (const result of insufficient) {
      expect(result).toMatchObject({ status: "fail", gates: { sample_sufficient: false } });
      expect(result.failure_reasons).toContain("insufficient_sample");
    }
  });
});
