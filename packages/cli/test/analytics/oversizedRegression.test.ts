import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADAPTER_VERSION } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers, readSignalTier } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { tiersDirForCorpusPath } from "../../src/analytics/extractCorpus/tierReader.js";
import { assessProfileSufficiency, readProfileSignals } from "../../src/analytics/profileSignals.js";
import { MAX_CORPUS_READ_BYTES, usageMain } from "../../src/analytics/usageStats.js";
import { statsExistingCorpusStatus } from "../../src/cli/commands/report.js";
import { evidenceTierBounds } from "../../src/registries/evidenceTierContract.js";
import { extractStartupIntermediateFromCorpusFile } from "../../src/state/startupAnalysis/benchmark.js";

type JsonObjectLocal = Record<string, unknown>;

const STARTUP_CONTRACT = {
  version: "vT",
  boundary: { committed_at: "2026-01-01T00:00:00Z", source: "test-boundary", commit: "abc123" },
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oversized-regression-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A small bounded corpus published as tiers under the corpus path's sibling. */
function publishSmallTier(corpusPath: string): { signalCount: number; shardCount: number; signalBytes: number; totalRecords: number } {
  const records: JsonObjectLocal[] = [
    { source_id: "u1", source_kind: "conversation_turn", signal_type: "question", timestamp: "2026-02-01T00:00:00.000Z", project_id: "agentera", runtime: "opencode", source_class: "active_runtime", source_product: "opencode", active_runtime: true, adapter_version: ADAPTER_VERSION, data: { actor: "user", text: "/build do it" } },
    { source_id: "u2", source_kind: "instruction_document", timestamp: "2026-02-01T00:00:01.000Z", project_id: "agentera", runtime: "filesystem", source_class: "project", source_product: "filesystem", active_runtime: false, adapter_version: ADAPTER_VERSION, data: { doc_type: "agents_md" } },
  ];
  const runtimeStatuses = [
    { runtime: "opencode", source_product: "opencode", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
  ];
  const result = publishEvidenceTiers(records, {
    tiersDir: tiersDirForCorpusPath(corpusPath),
    adapterVersion: ADAPTER_VERSION,
    runtimeStatuses: runtimeStatuses as unknown as JsonObjectLocal[],
    publishedAt: "2026-02-01T00:00:00.000Z",
    corpusMetadata: {
      extracted_at: "2026-02-01T00:00:00Z",
      runtime_statuses: runtimeStatuses,
      coverage_envelope: { available_runtimes: ["opencode"], selected_runtimes: ["opencode"], available_but_not_selected: [] },
    },
  });
  return { signalCount: result.signal_count, shardCount: result.shard_count, signalBytes: result.signal_bytes, totalRecords: result.total_records };
}

describe("oversized regression evidence (Task 5 closeout)", () => {
  // This suite records the concrete oversized-regression evidence required by
  // Plan Task 5 acceptance criterion 3: declared shard/signal sizes, observed
  // bounded artifact sizes, and supported command outcomes. Oversized state is
  // simulated with sparse ftruncate files and a synthetic capped selection —
  // never a huge checked-in corpus.

  it("declares tier bounds from the authority contract and observes bounded artifact sizes", () => {
    // Declared shard/signal/reader sizes (the authority contract is the source).
    const bounds = evidenceTierBounds();
    expect(bounds.shardByteCap).toBe(67108864); // 64 MiB
    expect(bounds.signalByteCap).toBe(67108864);
    expect(bounds.readerByteCap).toBe(67108864);

    // Observed bounded artifacts for a small published tier.
    const corpusPath = path.join(tmp, "corpus.json");
    const observed = publishSmallTier(corpusPath);
    expect(observed.totalRecords).toBe(2);
    expect(observed.shardCount).toBeGreaterThanOrEqual(1);
    expect(observed.signalCount).toBeGreaterThanOrEqual(1);
    expect(observed.signalBytes).toBeLessThanOrEqual(bounds.signalByteCap);

    const tier = readSignalTier(tiersDirForCorpusPath(corpusPath));
    expect(tier).not.toBeNull();
    for (const shard of tier!.manifest.shards) {
      expect(shard.bytes).toBeLessThanOrEqual(bounds.shardByteCap);
    }
  });

  it("usage analytics degrades with guidance instead of loading an oversized legacy corpus", () => {
    // Sparse oversized fixture: ftruncate does not allocate 64 MiB on disk.
    const corpusPath = path.join(tmp, "corpus.json");
    const fd = fs.openSync(corpusPath, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);

    let err = "";
    const rc = usageMain(["--corpus", corpusPath, "--json"], {
      out: () => undefined,
      err: (t) => (err += t),
    });
    expect(rc).not.toBe(0);
    expect(err).toContain("too large to load");
    expect(err).toContain("stats refresh --consent local-history");
  });

  it("report status classifies an oversized legacy corpus as stale with tier_state legacy", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    const fd = fs.openSync(corpusPath, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);

    const status = statsExistingCorpusStatus(corpusPath);
    expect(status.status).toBe("stale");
    expect(status.tier_state).toBe("legacy");
    expect(String(status.reason)).toContain("too large to load");
  });

  it("startup analysis never loads an oversized legacy corpus whole and reports the oversized reason", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    const fd = fs.openSync(corpusPath, "w");
    fs.ftruncateSync(fd, MAX_CORPUS_READ_BYTES + 1);
    fs.closeSync(fd);

    const inter = extractStartupIntermediateFromCorpusFile(corpusPath, { salt: "SALT", contract: STARTUP_CONTRACT });
    expect(inter.total_records_read).toBe(0);
    const cov = inter.runtime_coverage[0];
    expect(cov.runtime).toBe("local-corpus");
    expect(cov.reason).toBe("oversized");
    expect(cov.recovery).toMatch(/do not/i);
  });

  it("profile synthesis reports insufficiency without fabricating confidence on a capped tier", () => {
    // Synthetic capped selection: a family retained 0 of its intended signals.
    const selection = { total: 5, retained: 0, capped: true, per_family: [{ family: "opencode", total: 5, retained: 0 }] };
    const signals = [
      { source_id: "u1", source_kind: "conversation_turn", signal_type: "decision", timestamp: "2026-02-01T00:00:00.000Z", project_id: "p", runtime: "opencode", source_product: "opencode", evidence_anchor: "u1" },
    ];
    const assessment = assessProfileSufficiency(selection, signals as never);
    expect(assessment.sufficient).toBe(false);
    expect(assessment.capped).toBe(true);
    // The reason must surface the underrepresented family, not a positive claim.
    expect(assessment.reason.toLowerCase()).toContain("insufficient");
    expect(assessment.reason).not.toMatch(/\bsufficient\b/);
  });

  it("profile bounded_signals context reads state and sufficiency from a published tier", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    publishSmallTier(corpusPath);
    const read = readProfileSignals(tiersDirForCorpusPath(corpusPath), corpusPath);
    expect(read.state).toBe("current");
    expect(read.profile_signal_count).toBeGreaterThan(0);
    expect(read.sufficiency.sufficient).toBe(true);
    expect(read.sufficiency.capped).toBe(false);
  });
});
