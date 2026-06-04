import { describe, expect, it } from "vitest";

import { classifyStartupRecords } from "../../src/state/startupAnalysis.js";

const CONTRACT = {
  version: "vT",
  boundary: { committed_at: "2025-01-01T00:00:00Z", source: "test-boundary" },
  degradation_reasons: [],
};

function corpus(): any {
  return {
    records: [
      { source_kind: "conversation_turn", source_id: "u1", session_id: "c1", timestamp: "2026-02-01T00:00:00Z", data: { actor: "user", content: "/realisera build it" } },
      { source_kind: "tool_call", source_id: "t1", session_id: "c1", timestamp: "2026-02-01T00:00:01Z", data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } } },
      { source_kind: "tool_call", source_id: "t2", session_id: "c1", timestamp: "2026-02-01T00:00:02Z", data: { tool: "read", arguments: { path: ".agentera/plan.yaml" } } },
      { source_kind: "tool_call", source_id: "t3", session_id: "c1", timestamp: "2026-02-01T00:00:03Z", data: { tool: "read", arguments: { path: ".agentera/health.yaml" } } },
      { source_kind: "tool_call", source_id: "t4", session_id: "c1", timestamp: "2026-02-01T00:00:04Z", data: { tool: "apply_patch", arguments: { path: "x.py" } } },
      { source_kind: "conversation_turn", source_id: "u2", session_id: "c3", timestamp: "2026-02-02T00:00:00Z", data: { actor: "user", content: "/planera the feature" } },
      { source_kind: "conversation_turn", source_id: "a2", session_id: "c3", timestamp: "2026-02-02T00:00:01Z", data: { actor: "assistant", content: "thinking" } },
      { source_kind: "conversation_turn", source_id: "u3", session_id: "c3", timestamp: "2026-02-02T00:00:02Z", data: { actor: "user", content: "thanks" } },
      { source_kind: "tool_call", source_id: "old", session_id: "c4", timestamp: "2020-01-01T00:00:00Z", data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } } },
    ],
  };
}

describe("classifyStartupRecords", () => {
  it("builds a state-gathering sequence and detects redundant raw access", () => {
    const result = classifyStartupRecords(corpus(), { salt: "SALT", contract: CONTRACT });
    expect(result.contract_version).toBe("vT");
    expect(result.boundary_source).toBe("test-boundary");
    expect(result.state_gathering_sequences.length).toBe(1);
    const seq = result.state_gathering_sequences[0];
    expect(seq.capability).toBe("realisera");
    expect(seq.counts.cli_state_call).toBe(1);
    expect(seq.counts.raw_artifact_access).toBe(2);
    expect(seq.counts.implementation_boundary).toBe(1);
    expect(seq.cli_artifact_labels).toEqual(["plan"]);
    // plan.yaml read after `agentera plan` is redundant; health.yaml is not.
    expect(seq.redundant_raw_artifact_labels).toEqual(["plan"]);
    expect(Object.keys(seq.estimated_raw_after_cli_tokens_by_artifact).sort()).toEqual(["health", "plan"]);
  });

  it("records pre-boundary and no-state-sequence degradations", () => {
    const result = classifyStartupRecords(corpus(), { salt: "SALT", contract: CONTRACT });
    const reasons = result.degradations.map((d: any) => d.reason);
    expect(reasons).toContain("pre_boundary_record");
    expect(reasons).toContain("no_agentera_state_sequence");
  });

  it("flags transcript-bearing records for privacy redaction", () => {
    const c = { records: [{ source_kind: "tool_call", source_id: "x", session_id: "c", timestamp: "2026-02-01T00:00:00Z", transcript: "raw" }] };
    const result = classifyStartupRecords(c, { salt: "SALT", contract: CONTRACT });
    expect(result.degradations[0].reason).toBe("privacy_redaction_required");
  });
});
