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
import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { tiersDirForCorpusPath } from "../../src/analytics/extractCorpus/tierReader.js";
import { evidenceTierBounds } from "../../src/registries/evidenceTierContract.js";

const CONTRACT = {
  version: "vT",
  boundary: { committed_at: "2025-01-01T00:00:00Z", source: "test-boundary", commit: "abc123" },
};

function corpus(): any {
  return {
    metadata: {
      runtime_statuses: [{ runtime: "codex", status: "ok", reason: "records_extracted", record_count: 2 }],
      adapter_version: "adapterX",
    },
    records: [
      { source_kind: "conversation_turn", runtime: "codex", source_id: "u1", session_id: "c1", timestamp: "2026-02-01T00:00:00Z", data: { actor: "user", content: "/build build it" } },
      { source_kind: "tool_call", runtime: "codex", source_id: "t1", session_id: "c1", timestamp: "2026-02-01T00:00:01Z", data: { tool: "bash", arguments: { command: "uv run scripts/agentera plan" } } },
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
    expect(inter.runtime_record_counts).toEqual({ codex: 2 });
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

  it("degrades with the projected reason and recovery for a corrupt legacy corpus", () => {
    const corpusPath = path.join(tmp, "bad.json");
    fs.writeFileSync(corpusPath, "not json{");
    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: CONTRACT });
    expect(inter.total_records_read).toBe(0);
    const cov = inter.runtime_coverage[0];
    expect(cov.runtime).toBe("local-corpus");
    expect(cov.reason).toBe("unreadable_or_schema_divergent");
    expect(cov.recovery).toBeTruthy();
  });

  it("never loads an oversized legacy corpus whole and degrades with oversized reason", () => {
    const corpusPath = path.join(tmp, "huge.json");
    const bounds = evidenceTierBounds();
    const fd = fs.openSync(corpusPath, "w");
    fs.ftruncateSync(fd, bounds.readerByteCap + 1);
    fs.closeSync(fd);
    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: CONTRACT });
    expect(inter.total_records_read).toBe(0);
    const cov = inter.runtime_coverage[0];
    expect(cov.runtime).toBe("local-corpus");
    expect(cov.reason).toBe("oversized");
    expect(cov.recovery).toBeTruthy();
    // Recovery guidance must say "do not load" not "try harder".
    expect(cov.recovery).toMatch(/do not/i);
  });

  it("degrades with no_evidence and preserved recovery when no corpus or tiers exist", () => {
    const corpusPath = path.join(tmp, "never-existed.json");
    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: CONTRACT });
    expect(inter.total_records_read).toBe(0);
    const cov = inter.runtime_coverage[0];
    expect(cov.runtime).toBe("local-corpus");
    expect(cov.reason).toBe("no_evidence");
    expect(cov.recovery).toBeTruthy();
    // The recovery field survives the boundedRuntimeStatus normalization.
    expect(typeof cov.recovery).toBe("string");
    expect(cov.recovery!.length).toBeGreaterThan(0);
  });

  it("reads from bounded tiers when published, without reading the monolithic corpus", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    const records = [
      { source_kind: "conversation_turn", source_id: "u1", session_id: "c1", conversation_key: "c1", origin_id: originIdentity("fixture:u1"), content_fingerprint: contentFingerprint("/build build it"), author_class: "user", project_id: "agentera", timestamp: "2026-02-01T00:00:00.000Z", runtime: "codex", source_class: "active_runtime", source_product: "codex", active_runtime: true, adapter_version: ADAPTER_VERSION, data: { actor: "user", content: "/build build it" } },
      { source_kind: "tool_call", source_id: "t1", session_id: "c1", project_id: "agentera", timestamp: "2026-02-01T00:00:01.000Z", runtime: "codex", source_class: "active_runtime", source_product: "codex", active_runtime: true, adapter_version: ADAPTER_VERSION, data: { tool: "bash", arguments: { command: "echo hello" } } },
    ];
    const runtimeStatuses = [
      { runtime: "codex", source_product: "codex", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
    ];
    publishEvidenceTiers(records, {
      tiersDir: tiersDirForCorpusPath(corpusPath),
      adapterVersion: ADAPTER_VERSION,
      runtimeStatuses,
      publishedAt: "2026-01-15T00:00:00.000Z",
      corpusMetadata: {
        extracted_at: "2026-01-15T00:00:00Z",
        runtime_statuses: runtimeStatuses,
        coverage_envelope: {
          available_runtimes: ["codex"],
          selected_runtimes: ["codex"],
          available_but_not_selected: [],
        },
      },
    });
    const outPath = path.join(tmp, "out", "intermediate.json");
    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: CONTRACT, outputPath: outPath });
    expect(inter.total_records_read).toBe(2);
    expect(fs.existsSync(outPath)).toBe(true);
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
      runtime_record_counts: { codex: 1 },
      runtime_coverage: [{ runtime: "codex", status: "ok", reason: "records_extracted" }],
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
    const wm = previousBenchmarkWatermark(dir, ["codex"]);
    expect(wm).not.toBeNull();
    expect(previousBenchmarkWatermark(dir, ["opencode"])).toBeNull();
  });
});
