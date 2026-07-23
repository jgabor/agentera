import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateHybridRoute } from "../../src/eval/hybridRouteEvaluation.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("hybrid route evaluation", () => {
  it("evaluates every visible case with a routing tier and distinct local latency boundaries", () => {
    const report = evaluateHybridRoute(ROOT, {});
    const results = report.results as Array<Record<string, unknown>>;

    expect(report).toMatchObject({
      schemaVersion: "agentera.hybrid_route_evaluation.v1",
      status: "pass",
      aggregate_metrics: { harmful_misroutes: { target: 0, status: "not_measured_without_independent_baseline_and_holdout" } },
      model_context: { model: "gpt-5.6-terra", samples: 0, variance: "not_measured_without_live_reference_host" },
      latency: {
        deterministic_phase1: { target: "25_ms" },
        receipt_validation: { target: "25_ms" },
        semantic_model: { status: "not_measured_without_live_reference_host" },
        end_to_end: { status: "not_measured_without_live_reference_host" },
      },
      prerequisites: {
        live_reference_host: { configured: false, status: "blocked" },
        zero_data_retention: { approved: false, status: "blocked" },
        sealed_holdout: { configured: false, status: "blocked" },
      },
    });
    expect(results).toHaveLength(48);
    expect(results.every((result) => typeof result.case_id === "string" && typeof result.routing_tier === "string")).toBe(true);
    expect(results.some((result) => result.routing_tier === "semantic_receipt_validation")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("How should we divide the import work?");
    expect(JSON.stringify(report)).not.toContain("help me decide: cache or queue");
  });

  it("reports configuration availability without reading credential values", () => {
    const report = evaluateHybridRoute(ROOT, {
      OPENAI_API_KEY: "not-a-real-key",
      AGENTERA_OPENAI_ZDR_APPROVED: "true",
      AGENTERA_ROUTING_HOLDOUT: "/sealed/evaluator-owned-cases",
    });
    expect(report).toMatchObject({
      prerequisites: {
        live_reference_host: { configured: true, status: "configured_not_run" },
        zero_data_retention: { approved: true, status: "approved_not_run" },
        sealed_holdout: { configured: true, status: "configured_not_run" },
        blockers: [],
      },
    });
    expect(JSON.stringify(report)).not.toContain("not-a-real-key");
  });
});
