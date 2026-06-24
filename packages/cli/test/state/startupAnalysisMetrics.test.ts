import { describe, expect, it } from "vitest";

import {
  aggregateStartupMetrics,
  classifyStartupRecords,
} from "../../src/state/startupAnalysis.js";

const CONTRACT = {
  version: "vT",
  boundary: { committed_at: "2025-01-01T00:00:00Z", source: "test-boundary" },
  degradation_reasons: [],
};

function corpus(): any {
  return {
    records: [
      { source_kind: "conversation_turn", source_id: "u1", session_id: "c1", timestamp: "2026-02-01T00:00:00Z", data: { actor: "user", content: "/build build it" } },
      { source_kind: "tool_call", source_id: "t1", session_id: "c1", timestamp: "2026-02-01T00:00:01Z", data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } } },
      { source_kind: "tool_call", source_id: "t2", session_id: "c1", timestamp: "2026-02-01T00:00:02Z", data: { tool: "read", arguments: { path: ".agentera/plan.yaml" } } },
      { source_kind: "tool_call", source_id: "t3", session_id: "c1", timestamp: "2026-02-01T00:00:03Z", data: { tool: "read", arguments: { path: ".agentera/health.yaml" } } },
      { source_kind: "tool_call", source_id: "t4", session_id: "c1", timestamp: "2026-02-01T00:00:04Z", data: { tool: "apply_patch", arguments: { path: "x.py" } } },
    ],
  };
}

function metrics(): any {
  const inter = classifyStartupRecords(corpus(), { salt: "SALT", contract: CONTRACT });
  inter.output_envelope = "startup_state_analysis_v1";
  inter.total_records_read = corpus().records.length;
  inter.runtime_coverage = [{ runtime: "claude-code", status: "ok", reason: "records_extracted", record_count: 5 }];
  return aggregateStartupMetrics(inter);
}

describe("aggregateStartupMetrics", () => {
  it("produces the corrected metrics envelope", () => {
    const m = metrics();
    expect(m.output_envelope).toBe("startup_state_metrics_v1");
    expect(m.total_state_sequences).toBe(1);
    expect(m.total_cli_state_calls).toBe(1);
    expect(m.total_raw_artifact_access_after_cli).toBe(2);
    expect(m.total_redundant_raw_artifact_accesses).toBe(1);
    expect(m.token_estimator_version).toBe("approx_bytes_div_4_v1");
    expect(m.per_capability_state_counts.build.state_sequences).toBe(1);
    expect(m.cli_state_command_counts.plan).toBe(1);
    expect(m.raw_artifact_access_after_cli_counts).toEqual({ health: 1, plan: 1 });
    expect(m.redundant_raw_artifact_access_counts).toEqual({ plan: 1 });
  });

  it("emits null passthrough fields and a startup recommendation", () => {
    const m = metrics();
    expect(m.boundary_commit).toBeNull();
    expect(m.benchmark_watermark_at).toBeNull();
    expect(m.corpus_adapter_version).toBeNull();
    expect(typeof m.startup_recommendation.action).toBe("string");
    expect(typeof m.implementation_recommended).toBe("boolean");
  });

  it("flags insufficient evidence when there are no sequences", () => {
    const m = aggregateStartupMetrics({ state_gathering_sequences: [], degradations: [] });
    expect(m.total_state_sequences).toBe(0);
    expect(m.confidence_caveats).toContain("insufficient_post_2_3_state_sequences");
    expect(m.insufficient_evidence_reason).toBe("no_post_2_3_state_sequences");
    expect(m.startup_recommendation.action).toBe("close_without_implementation");
  });
});
