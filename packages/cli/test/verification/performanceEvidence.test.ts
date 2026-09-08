import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { measurementProfile, normalizedLatencyAdvisory, performanceAuthority, validateDevelopmentResourceEvidence, validatePerformanceEvidence } from "../../scripts/performance-evidence.mjs";
import { performanceEvidence, performanceObservationFixture, refreshPerformanceEvidence } from "../helpers/performanceEvidence.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const definition = YAML.parse(fs.readFileSync(path.join(root, "references/analysis/verification-policy.yaml"), "utf8")).owners.performance;
const validate = (evidence: any) => validatePerformanceEvidence(JSON.stringify(evidence), definition, root);

describe("canonical performance enforcement", () => {
  it("selects closed full/development profiles and rejects development in full consumers", () => {
    expect(measurementProfile().repetitions).toBe(5);
    expect(measurementProfile("development").repetitions).toBe(1);
    expect(() => measurementProfile("fast")).toThrow(/unknown measurement profile/);
    const development = performanceEvidence("development");
    expect(development.samples).toHaveLength(7);
    expect(validateDevelopmentResourceEvidence(JSON.stringify(development), definition, root)).toEqual([]);
    expect(validate(development).join(";")).toContain("expected exactly one");
    expect(() => normalizedLatencyAdvisory({ samples: 7, maxima: development.maxima }, performanceAuthority(root))).toThrow(/sample count/);
    development.schemaVersion = measurementProfile().schemaVersion;
    expect(validate(development).join(";")).toContain("not full qualification");
    expect(validate(development).join(";")).toContain("expected 35 samples");
    expect(validateDevelopmentResourceEvidence(JSON.stringify(performanceEvidence()), definition, root).length).toBeGreaterThan(0);
  });
  it.each(["heap", "output", "startup_output", "missing", "duplicate", "baseline", "inspector", "provenance"])("development rejects %s defects at the evidence boundary", (defect) => {
    const evidence: any = performanceEvidence("development");
    const sample = evidence.samples.find((sample: any) => sample.operation === (defect === "startup_output" ? "startup" : "exact_get"));
    if (defect === "heap") {
      sample.heapDeltaBytes = evidence.limits.exact_get.max_heap_delta_bytes + 1;
      sample.peakHeapBytes = sample.baselineHeapBytes + sample.heapDeltaBytes;
    }
    if (defect === "output") sample.outputBytes = evidence.limits.exact_get.max_utf8_bytes + 1;
    if (defect === "startup_output") sample.outputBytes = performanceAuthority(root).budgets.startup.surfaces.prime_dashboard.max_utf8_bytes + 1;
    if (defect === "missing") evidence.samples.pop();
    if (defect === "duplicate") evidence.samples.push(evidence.samples[0]);
    if (defect === "baseline") evidence.measurement.heapBaseline = {};
    if (defect === "inspector") sample.inspectorSamples = 1;
    if (defect === "provenance") delete evidence.profile;
    refreshPerformanceEvidence(evidence);
    expect(validateDevelopmentResourceEvidence(JSON.stringify(evidence), definition, root).length).toBeGreaterThan(0);
  });
  it("development reports latency overruns without making them an SLO", () => {
    const evidence = performanceEvidence("development");
    for (const sample of evidence.samples) sample.elapsedMs = 100000;
    refreshPerformanceEvidence(evidence);
    expect(validateDevelopmentResourceEvidence(JSON.stringify(evidence), definition, root)).toEqual([]);
  });
  it("accepts all seven advisory target overruns with accurate five-repeat summaries", () => {
    const evidence: any = performanceEvidence();
    expect(evidence.samples).toHaveLength(35);
    for (const sample of evidence.samples.filter((sample: any) => sample.repetition === 1)) {
      const target = sample.operation === "exact_get" ? "exact_get" : `${sample.operation}_${sample.scale}`;
      sample.elapsedMs = evidence.limits[target].max_latency_ms + 330.53;
    }
    refreshPerformanceEvidence(evidence);
    expect(validate(evidence)).toEqual([]);
    expect(evidence.latencyAdvisory.exact_get).toEqual({
      targetMs: 1000,
      maxObservedMs: 1330.53,
      exceededRepetitions: 1,
    });
    expect(Object.values(evidence.latencyAdvisory).every((entry: any) => entry.exceededRepetitions === 1)).toBe(true);
    const legacy = structuredClone(evidence);
    delete legacy.latencyAdvisory;
    expect(validate(legacy)).toEqual([]);
  });
  it.each(["heap", "output", "startup_output"])("independently rejects %s excess despite pass and fake enforcement", (metric) => {
    const evidence: any = performanceEvidence();
    evidence.enforcement = { latency: "advisory", heap: "advisory", bytes: "advisory" };
    const sample = evidence.samples.find((sample: any) => sample.operation === (metric === "startup_output" ? "startup" : "exact_get"));
    if (metric === "heap") {
      sample.heapDeltaBytes = evidence.limits.exact_get.max_heap_delta_bytes + 1;
      sample.peakHeapBytes = sample.baselineHeapBytes + sample.heapDeltaBytes;
    } else sample.outputBytes = metric === "startup_output" ? performanceAuthority(root).budgets.startup.surfaces.prime_dashboard.max_utf8_bytes + 1 : evidence.limits.exact_get.max_utf8_bytes + 1;
    refreshPerformanceEvidence(evidence);
    expect(validate(evidence).join(";")).toContain("blocking heap/output");
  });
  it.each([undefined, -1, NaN, Infinity, "1"])("rejects invalid elapsed %s even with refreshed maxima", (value) => {
    const evidence: any = performanceEvidence();
    evidence.samples[0].elapsedMs = value;
    refreshPerformanceEvidence(evidence);
    expect(validate(evidence).length).toBeGreaterThan(0);
  });
  it.each(["targetMs", "maxObservedMs", "exceededRepetitions"])("rejects wrong advisory %s", (field) => {
    const evidence: any = performanceEvidence();
    evidence.latencyAdvisory.exact_get[field] += 1;
    expect(validate(evidence)).toContain("latency advisory does not match the declared samples and targets");
  });
  it.each(["duplicate", "missing", "runtime", "inspector", "baseline", "process"])("retains rejection of %s defects", (defect) => {
    const evidence: any = performanceEvidence();
    if (defect === "duplicate") evidence.samples[1].repetition = 1;
    if (defect === "missing") evidence.samples.pop();
    if (defect === "runtime") delete evidence.runner.v8;
    if (defect === "inspector") evidence.samples[0].inspectorSamples = 1;
    if (defect === "baseline") evidence.measurement.heapBaseline = {};
    if (defect === "process") evidence.samples[0].status = "fail";
    refreshPerformanceEvidence(evidence);
    expect(validate(evidence).length).toBeGreaterThan(0);
  });
  it("fails closed on malformed canonical classification", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "performance-policy-"));
    try {
      const authority = performanceAuthority(root);
      authority.entity_target.measurement_contract.enforcement.heap = "advisory";
      fs.mkdirSync(path.join(temporary, "references/artifacts"), { recursive: true });
      fs.writeFileSync(path.join(temporary, "references/artifacts/state-storage-authority.yaml"), YAML.stringify(authority));
      expect(validatePerformanceEvidence(JSON.stringify(performanceEvidence()), definition, temporary)).toContain("invalid canonical performance enforcement policy");
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  it("keeps old passing normalized v1 receipts only when zero overruns are provable", () => {
    const evidence: any = performanceObservationFixture().evidence;
    delete evidence.latencyAdvisory;
    expect(normalizedLatencyAdvisory(evidence, performanceAuthority(root)).exact_get.exceededRepetitions).toBe(0);
    evidence.maxima.exact_get.maxElapsedMs = 1330.53;
    expect(() => normalizedLatencyAdvisory(evidence, performanceAuthority(root))).toThrow("invalid latency advisory");
  });
  it("requires zero overruns when the raw-derived maximum equals its target", () => {
    const raw: any = performanceEvidence();
    raw.samples.find((sample: any) => sample.operation === "exact_get").elapsedMs = raw.limits.exact_get.max_latency_ms;
    refreshPerformanceEvidence(raw);
    expect(validate(raw)).toEqual([]);
    const normalized = {
      samples: raw.samples.length,
      maxima: raw.maxima,
      latencyAdvisory: raw.latencyAdvisory,
    };
    expect(normalizedLatencyAdvisory(normalized, performanceAuthority(root)).exact_get.exceededRepetitions).toBe(0);
    normalized.latencyAdvisory.exact_get.exceededRepetitions = 1;
    expect(() => normalizedLatencyAdvisory(normalized, performanceAuthority(root))).toThrow("invalid latency advisory");
    expect(validate(raw)).toContain("latency advisory does not match the declared samples and targets");
    delete normalized.latencyAdvisory;
    expect(normalizedLatencyAdvisory(normalized, performanceAuthority(root)).exact_get.exceededRepetitions).toBe(0);
  });
  it.each(["targetMs", "maxObservedMs", "exceededRepetitions", "coverage", "heap", "output"])("guards normalized receipt %s", (field) => {
    const evidence: any = performanceObservationFixture().evidence;
    if (field === "coverage") evidence.samples = 34;
    else if (field === "heap") evidence.maxima.exact_get.maxHeapDeltaBytes = 67108865;
    else if (field === "output") evidence.maxima.exact_get.maxOutputBytes = 1048577;
    else evidence.latencyAdvisory.exact_get[field] += 1;
    expect(() => normalizedLatencyAdvisory(evidence, performanceAuthority(root))).toThrow();
  });
});
