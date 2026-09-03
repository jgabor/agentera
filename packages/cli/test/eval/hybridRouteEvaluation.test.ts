import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateHybridRoute } from "../../src/eval/hybridRouteEvaluation.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

describe("hybrid route evaluation", () => {
  it("evaluates every frozen case with tier attribution and distinct local latency boundaries", () => {
    const report = evaluateHybridRoute(ROOT);
    const results = report.results as Array<Record<string, unknown>>;

    expect(report).toMatchObject({
      schemaVersion: "agentera.hybrid_route_evaluation.v1",
      status: "pass",
      aggregate_metrics: {
        harmful_misroutes: {
          scope: "deterministic_and_receipt_validation_conformance",
          target: 0,
          observed: 0,
          status: "pass",
        },
      },
      model_context: { status: "unmeasured", reason: "host_dependent", samples: 0 },
      latency: {
        deterministic_phase1: { target: "25_ms" },
        receipt_validation: { target: "25_ms" },
        semantic_model: { status: "unmeasured", reason: "host_dependent" },
        end_to_end: { status: "unmeasured", reason: "host_dependent" },
      },
    });
    expect(results).toHaveLength(51);
    expect(results.every((result) => typeof result.case_id === "string" && typeof result.routing_tier === "string" && ["deterministic", "receipt_validation"].includes(result.evaluation_tier as string))).toBe(true);
    expect(results.every((result) => result.harmful_misroute === false)).toBe(true);
    expect(results.some((result) => result.routing_tier === "semantic_receipt_validation")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("How should we divide the import work?");
    expect(JSON.stringify(report)).not.toContain("help me decide: cache or queue");
  });

  it("attributes a failing synthetic expectation to the deterministic tier", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-routing-evaluation-"));
    try {
      for (const directory of ["fixtures", "references", "skills"]) fs.cpSync(path.join(ROOT, directory), path.join(root, directory), { recursive: true });
      const corpusPath = path.join(root, "fixtures/routing/hybrid-corpus.yaml");
      const corpus = fs
        .readFileSync(corpusPath, "utf8")
        .replace(
          'id: DEV-PHRASE-STATUS, partition: development, request: "show project briefing for the checkout", expected: { phase1: deterministic_selection, tier: phrase, capability: status }',
          'id: DEV-PHRASE-STATUS, partition: development, request: "show project briefing for the checkout", expected: { phase1: deterministic_selection, tier: phrase, capability: vision }',
        );
      fs.writeFileSync(corpusPath, corpus);

      const report = evaluateHybridRoute(root);
      const failure = (report.results as Array<Record<string, unknown>>).find((result) => result.case_id === "DEV-PHRASE-STATUS");
      expect(report).toMatchObject({
        status: "fail",
        aggregate_metrics: { harmful_misroutes: { observed: 1, status: "fail" } },
      });
      expect(failure).toMatchObject({
        status: "fail",
        evaluation_tier: "deterministic",
        failure_tier: "deterministic",
        harmful_misroute: true,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("has no credential, privacy-approval, or hidden-corpus prerequisite on active surfaces", () => {
    const activeSurfaces = ["TODO.md", "references/cli/hybrid-route-contract.yaml", "references/adapters/package-registry.yaml", "skills/agentera/SKILL.md", "packages/cli/src/eval/hybridRouteEvaluation.ts"];
    const activeText = activeSurfaces.map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
    expect(activeText).not.toMatch(/OPENAI_API_KEY|ZDR|reference_host|holdout_manifest|evaluator-owned/u);
  });
});
