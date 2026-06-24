import { describe, expect, it } from "vitest";

import {
  classifyStartupEvent,
  classifyThresholdEvidence,
  scanRetainedThresholdEvidence,
  scanThresholdEvidence,
} from "../../src/state/startupAnalysis.js";

function corpusFixture(): any {
  return {
    metadata: {
      version: "x",
      runtime_statuses: [{ runtime: "claude-code", status: "ok", reason: "records_extracted", record_count: 3 }],
    },
    records: [
      {
        source_kind: "conversation_turn",
        source_id: "u1",
        session_id: "c1",
        timestamp: "2026-01-01T00:00:00Z",
        data: { actor: "user", content: "/build go" },
      },
      {
        source_kind: "conversation_turn",
        source_id: "a1",
        session_id: "c1",
        timestamp: "2026-01-01T00:00:01Z",
        data: {
          actor: "assistant",
          content:
            "verbosity mismatch: 600 words exceeds 500 budget in `scripts/agentera` at src/foo.py:42 abstraction creep",
        },
      },
      {
        source_kind: "tool_call",
        source_id: "t1",
        session_id: "c1",
        timestamp: "2026-01-01T00:00:02Z",
        data: { tool: "apply_patch", arguments: { path: "src/foo.py" } },
      },
    ],
  };
}

describe("classifyStartupEvent", () => {
  it("classifies a CLI state call from a bash command", () => {
    const [cls, , cmd, artifacts] = classifyStartupEvent({
      source_kind: "tool_call",
      data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } },
    });
    expect(cls).toBe("cli_state_call");
    expect(cmd).toBe("plan");
    expect([...artifacts]).toEqual(["plan"]);
  });

  it("classifies raw artifact access and implementation boundary", () => {
    expect(
      classifyStartupEvent({ source_kind: "tool_call", data: { tool: "read", arguments: { path: ".agentera/decisions.yaml" } } })[0],
    ).toBe("raw_artifact_access");
    expect(
      classifyStartupEvent({ source_kind: "tool_call", data: { tool: "apply_patch", arguments: { path: "x.py" } } })[0],
    ).toBe("implementation_boundary");
    expect(classifyStartupEvent({ source_kind: "conversation_turn" })[0]).toBe("non_state_context");
  });

  it("classifies capability prose reads", () => {
    expect(
      classifyStartupEvent({ source_kind: "tool_call", data: { tool: "read", arguments: { path: "skills/agentera/SKILL.md" } } }),
    ).toEqual(["capability_prose_read", "SKILL.md", null, new Set()]);
  });
});

describe("scanThresholdEvidence", () => {
  it("detects warnings, pairs detail loss with implementation boundary, and stays redacted", () => {
    const scan = scanThresholdEvidence(corpusFixture(), { salt: "SALT" });
    expect(scan.output_envelope).toBe("threshold_evidence_scan_v1");
    expect(scan.counts.warning_events).toBe(1);
    expect(scan.counts.by_warning["self_audit.verbosity"]).toBe(1);
    expect(scan.counts.by_warning["self_audit.abstraction"]).toBe(1);
    const event = scan.warning_events[0];
    expect(event.capability).toBe("build");
    expect(event.conversation).toMatch(/^session:[0-9a-f]{16}$/);
    expect(event.detail_loss_status).toBe("possible_useful_detail_removed");
    expect(event.rewrite_followup.event_class).toBe("implementation_boundary");
  });

  it("classifies repeated false positives into a recommendation", () => {
    const scan = scanThresholdEvidence(corpusFixture(), { salt: "SALT" });
    const cls = classifyThresholdEvidence(scan);
    expect(cls.output_envelope).toBe("threshold_evidence_classification_v1");
    expect(cls.categories.length).toBeGreaterThan(0);
    expect(["no_threshold_change_yet", "consider_minimal_threshold_or_diagnostic_change"]).toContain(
      cls.recommendation.action,
    );
  });
});

describe("scanRetainedThresholdEvidence", () => {
  it("flags a retained plan false-positive signal", () => {
    const retained = scanRetainedThresholdEvidence(
      { plan: "[post-audit-flagged] full plan exceeds budget; 600 words exceeds 500 budget" },
      { salt: "SALT" },
    );
    expect(retained.counts.warning_events).toBe(1);
    const event = retained.warning_events[0];
    expect(event.artifact_label).toBe("plan");
    expect(event.detail_loss_status).toBe("retained_artifact_false_positive_signal");
    expect(event.observed_counts.post_audit_flag_markers).toBe(1);
  });
});
