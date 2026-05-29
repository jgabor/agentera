import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildNoRuntimeStartupIntermediate,
  buildStartupIntermediate,
  extractStartupIntermediateFromCorpusFile,
  persistStartupBenchmark,
  previousBenchmarkWatermark,
} from "../../src/state/startupAnalysis.js";

const CONTRACT = {
  version: "vT",
  boundary: { committed_at: "2025-01-01T00:00:00Z", source: "test-boundary", commit: "abc123" },
};

function corpus(): any {
  return {
    metadata: {
      runtime_statuses: [{ runtime: "claude-code", status: "ok", reason: "records_extracted", record_count: 2 }],
      adapter_version: "adapterX",
    },
    records: [
      { source_kind: "conversation_turn", runtime: "claude-code", source_id: "u1", session_id: "c1", timestamp: "2026-02-01T00:00:00Z", data: { actor: "user", content: "/realisera build it" } },
      { source_kind: "tool_call", runtime: "claude-code", source_id: "t1", session_id: "c1", timestamp: "2026-02-01T00:00:01Z", data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } } },
    ],
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "startup-bench-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildStartupIntermediate", () => {
  it("produces the analysis envelope with boundary + runtime metadata", () => {
    const inter = buildStartupIntermediate(corpus(), { salt: "SALT", contract: CONTRACT });
    expect(inter.output_envelope).toBe("startup_state_analysis_v1");
    expect(inter.boundary_commit).toBe("abc123");
    expect(inter.corpus_adapter_version).toBe("adapterX");
    expect(inter.total_records_read).toBe(2);
    expect(inter.runtime_record_counts).toEqual({ "claude-code": 2 });
    expect(inter.benchmark_window_started_after).toBe("2025-01-01T00:00:00+00:00");
  });

  it("buildNoRuntimeStartupIntermediate skips runtime stores", () => {
    const inter = buildNoRuntimeStartupIntermediate({ contract: CONTRACT });
    expect(inter.runtime_coverage[0].status).toBe("skipped");
    expect(inter.total_records_read).toBe(0);
    expect(inter.benchmark_mode).toBe("since_previous_benchmark");
  });
});

describe("extractStartupIntermediateFromCorpusFile", () => {
  it("reads a corpus file and optionally writes a redacted intermediate", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    fs.writeFileSync(corpusPath, JSON.stringify(corpus()));
    const outPath = path.join(tmp, "out", "intermediate.json");
    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: CONTRACT, outputPath: outPath });
    expect(inter.total_records_read).toBe(2);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.readFileSync(outPath, "utf8").endsWith("\n")).toBe(true);
  });

  it("degrades gracefully on an unreadable corpus file", () => {
    const corpusPath = path.join(tmp, "bad.json");
    fs.writeFileSync(corpusPath, "not json{");
    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: CONTRACT });
    expect(inter.total_records_read).toBe(0);
    expect(inter.runtime_coverage[0].runtime).toBe("local-corpus");
  });
});

describe("persistStartupBenchmark", () => {
  function metrics(redundant: number): any {
    return {
      contract_version: "vT",
      benchmark_mode: "full_boundary_snapshot",
      generated_at: "FIXED",
      token_estimator_version: "approx_bytes_div_4_v1",
      estimated_redundant_raw_tokens: redundant,
      estimated_raw_after_cli_tokens: 20,
      estimated_raw_after_cli_tokens_by_artifact: {},
      estimated_redundant_raw_tokens_by_artifact: {},
      runtime_record_counts: { "claude-code": 1 },
      runtime_coverage: [{ runtime: "claude-code", status: "ok", reason: "records_extracted" }],
      startup_recommendation: { action: "close_without_implementation" },
    };
  }

  it("appends history and computes tokens-saved vs the previous run", () => {
    const dir = path.join(tmp, "bench");
    persistStartupBenchmark(metrics(10), dir);
    const after = persistStartupBenchmark(metrics(4), dir);

    const history = fs.readFileSync(path.join(dir, "runs.jsonl"), "utf8").trim().split("\n");
    expect(history.length).toBe(2);
    const structured = JSON.parse(fs.readFileSync(after.structured, "utf8"));
    expect(structured.estimated_tokens_saved_vs_previous).toBe(6);
    expect(structured.estimated_tokens_saved_vs_previous_null_reason).toBeNull();
    expect(fs.existsSync(path.join(dir, "latest-report.md"))).toBe(true);
  });

  it("watermark lookup matches by runtime scope", () => {
    const dir = path.join(tmp, "bench2");
    const m = { ...metrics(5), benchmark_watermark_at: "2026-03-01T00:00:00+00:00" };
    persistStartupBenchmark(m, dir);
    const wm = previousBenchmarkWatermark(dir, ["claude-code"]);
    expect(wm).not.toBeNull();
    expect(previousBenchmarkWatermark(dir, ["opencode"])).toBeNull();
  });
});
