import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aggregateStartupMetrics,
  classifyStartupRecords,
  renderStartupReport,
  writeStartupReports,
} from "../../src/state/startupAnalysis.js";

const CONTRACT = {
  version: "vT",
  boundary: { committed_at: "2025-01-01T00:00:00Z", source: "test-boundary" },
  degradation_reasons: [],
};

function metrics(): any {
  const corpus = {
    records: [
      { source_kind: "conversation_turn", source_id: "u1", session_id: "c1", timestamp: "2026-02-01T00:00:00Z", data: { actor: "user", content: "/build build it" } },
      { source_kind: "tool_call", source_id: "t1", session_id: "c1", timestamp: "2026-02-01T00:00:01Z", data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } } },
      { source_kind: "tool_call", source_id: "t2", session_id: "c1", timestamp: "2026-02-01T00:00:02Z", data: { tool: "read", arguments: { path: ".agentera/plan.yaml" } } },
      { source_kind: "tool_call", source_id: "t4", session_id: "c1", timestamp: "2026-02-01T00:00:04Z", data: { tool: "apply_patch", arguments: { path: "x.py" } } },
    ],
  };
  const inter = classifyStartupRecords(corpus, { salt: "SALT", contract: CONTRACT });
  inter.output_envelope = "startup_state_analysis_v1";
  inter.total_records_read = corpus.records.length;
  inter.runtime_coverage = [{ runtime: "claude-code", status: "ok", reason: "records_extracted", record_count: 4 }];
  const m = aggregateStartupMetrics(inter);
  m.generated_at = "FIXED";
  return m;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "startup-report-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("renderStartupReport", () => {
  it("renders the privacy-preserving markdown report with Python float formatting", () => {
    const md = renderStartupReport(metrics());
    expect(md).toContain("# Agentera Startup State-Access Analysis");
    expect(md).toContain("- Boundary commit: `None`"); // null -> Python None
    expect(md).toContain("- Raw-after-CLI sequence rate: `1.0`"); // float, not 1
    expect(md).toContain("| build | 1 | 1 |");
    expect(md).toContain("## Recommendation");
  });
});

describe("writeStartupReports", () => {
  it("writes JSON + markdown with Python-faithful float rendering", () => {
    const paths = writeStartupReports(metrics(), tmp);
    expect(paths.structured.endsWith("startup-overhead-report.json")).toBe(true);
    expect(paths.human_readable.endsWith("startup-overhead-report.md")).toBe(true);
    const json = fs.readFileSync(paths.structured, "utf8");
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain('"raw_after_cli_sequence_rate": 1.0');
    expect(json).toContain('"boundary_commit": null');
    // Parses back to a value-equal structure.
    const parsed = JSON.parse(json);
    expect(parsed.output_envelope).toBe("startup_state_metrics_v1");
    expect(parsed.raw_after_cli_sequence_rate).toBe(1);
  });
});
