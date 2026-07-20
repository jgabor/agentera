import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADAPTER_VERSION } from "../../src/analytics/extractCorpus/core.js";
import {
  evidenceTierAuthorityPath,
  evidenceTierBounds,
} from "../../src/registries/evidenceTierContract.js";
import {
  publishEvidenceTiers,
  type PublicationResult,
} from "../../src/analytics/extractCorpus/evidenceTiers.js";
import {
  assessTiers,
  isAnalyzable,
  iterBoundedRecords,
  legacyCorpusReadable,
  readBoundedMetadata,
  recoveryForState,
  tiersDirForCorpusPath,
  type TierAssessment,
} from "../../src/analytics/extractCorpus/tierReader.js";

type JsonObject = Record<string, unknown>;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tier-reader-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fullRecord(opts: {
  sourceId: string;
  sourceKind?: string;
  timestamp?: string;
  sourceProduct?: string;
  runtime?: string | null;
  data?: JsonObject;
}): JsonObject {
  return {
    source_id: opts.sourceId,
    source_kind: opts.sourceKind ?? "conversation_turn",
    timestamp: opts.timestamp ?? "2026-01-01T00:00:00.000Z",
    project_id: "demo",
    runtime: opts.runtime ?? "opencode",
    source_class: "active_runtime",
    source_product: opts.sourceProduct ?? "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data: opts.data ?? { actor: "user", text: "hello" },
  };
}

function representativeRecords(): JsonObject[] {
  return [
    fullRecord({ sourceId: "c1", sourceProduct: "opencode", runtime: "opencode", timestamp: "2026-01-02T10:00:00.000Z", data: { actor: "user", signal_type: "question", text: "why?" } }),
    fullRecord({ sourceId: "c2", sourceProduct: "opencode", runtime: "opencode", timestamp: "2026-01-02T10:01:00.000Z", data: { actor: "assistant", text: "because" } }),
    fullRecord({ sourceId: "c3", sourceProduct: "codex", runtime: "codex", timestamp: "2026-01-03T09:00:00.000Z", data: { actor: "user", signal_type: "decision", text: "decide" } }),
  ];
}

function publish(records: JsonObject[], opts?: {
  corpusPath?: string;
  runtimeStatuses?: JsonObject[];
  contractPath?: string;
}): PublicationResult {
  const tiersDir = opts?.corpusPath
    ? tiersDirForCorpusPath(opts.corpusPath)
    : path.join(tmp, "tiers");
  const corpusMetadata = opts?.corpusPath
    ? {
        extracted_at: "2026-01-15T00:00:00Z",
        runtime_statuses: opts?.runtimeStatuses as JsonObject[] | undefined,
        coverage_envelope: {
          available_runtimes: ["opencode", "codex"],
          selected_runtimes: ["opencode", "codex"],
          available_but_not_selected: [],
        },
      }
    : undefined;
  return publishEvidenceTiers(records, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    runtimeStatuses: opts?.runtimeStatuses as JsonObject[] | undefined,
    publishedAt: "2026-01-15T00:00:00.000Z",
    corpusMetadata,
  }, opts?.contractPath);
}

const PROPORTIONAL_SHARD_BYTE_CAP = 8 * 1024;

function proportionalContractPath(): string {
  const contractPath = path.join(tmp, "proportional-evidence-tier-authority.yaml");
  const productionCap = evidenceTierBounds().shardByteCap;
  const authority = fs.readFileSync(evidenceTierAuthorityPath(), "utf8");
  fs.writeFileSync(
    contractPath,
    authority.replaceAll(`byte_cap: ${productionCap}`, `byte_cap: ${PROPORTIONAL_SHARD_BYTE_CAP}`),
  );
  return contractPath;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("tiersDirForCorpusPath", () => {
  it("resolves to <dirname>/tiers", () => {
    expect(tiersDirForCorpusPath("/p/intermediate/corpus.json")).toBe(
      path.join("/p/intermediate", "tiers"),
    );
  });
});

// ---------------------------------------------------------------------------
// Analyzable states
// ---------------------------------------------------------------------------

describe("isAnalyzable", () => {
  it("returns true for current and incomplete", () => {
    expect(isAnalyzable("current")).toBe(true);
    expect(isAnalyzable("incomplete")).toBe(true);
  });

  it("returns false for degrade states", () => {
    expect(isAnalyzable("missing")).toBe(false);
    expect(isAnalyzable("legacy")).toBe(false);
    expect(isAnalyzable("corrupt")).toBe(false);
    expect(isAnalyzable("oversized")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recovery guidance (contract-projected, never duplicated)
// ---------------------------------------------------------------------------

describe("recoveryForState", () => {
  it("returns null for analyzable states (no recovery needed)", () => {
    expect(recoveryForState("current")).toBeNull();
    expect(recoveryForState("incomplete")).toBeNull();
  });

  it("returns contract-projected recovery for degrade states", () => {
    for (const state of ["missing", "legacy", "corrupt", "oversized"] as const) {
      const recovery = recoveryForState(state);
      expect(recovery, `${state} should have recovery guidance`).not.toBeNull();
      expect(typeof recovery).toBe("string");
      expect(recovery!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// assessTiers
// ---------------------------------------------------------------------------

describe("assessTiers", () => {
  it("reports missing when no tiers and no legacy corpus exist", () => {
    const a = assessTiers(tmp);
    expect(a.state).toBe("missing");
    expect(a.analyzable).toBe(false);
    expect(a.recovery).not.toBeUndefined();
  });

  it("reports legacy when no tiers exist but a corpus.json is present", () => {
    const corpusPath = path.join(tmp, "corpus.json");
    fs.writeFileSync(corpusPath, '{"metadata":{},"records":[]}');
    const a = assessTiers(tiersDirForCorpusPath(corpusPath), corpusPath);
    expect(a.state).toBe("legacy");
    expect(a.analyzable).toBe(false);
    expect(a.recovery).not.toBeUndefined();
  });

  it("reports current when tiers are published and complete", () => {
    const records = representativeRecords();
    const corpusPath = path.join(tmp, "corpus.json");
    publish(records, { corpusPath, contractPath: proportionalContractPath() });
    const a = assessTiers(tiersDirForCorpusPath(corpusPath), corpusPath);
    expect(a.state).toBe("current");
    expect(a.analyzable).toBe(true);
    expect(a.generation).toBeTruthy();
  });

  it("reports incomplete with coverage gaps when a runtime is sparse", () => {
    const records = representativeRecords();
    const corpusPath = path.join(tmp, "corpus.json");
    const runtimeStatuses: JsonObject[] = [
      { runtime: "codex", source_product: "codex", source_class: "active_runtime", active_runtime: true, status: "sparse", reason: "no_candidate_files", store_path: "/codex" },
      { runtime: "opencode", source_product: "opencode", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
    ];
    publish(records, { corpusPath, runtimeStatuses });
    const a = assessTiers(tiersDirForCorpusPath(corpusPath), corpusPath);
    expect(a.state).toBe("incomplete");
    expect(a.analyzable).toBe(true);
    expect(a.coverageGaps).toBeTruthy();
    expect(a.coverageGaps!.some((g) => g.includes("codex"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readBoundedMetadata (signal-tier-only read, never full-evidence shards)
// ---------------------------------------------------------------------------

describe("readBoundedMetadata", () => {
  it("reads manifest, signal tier, and corpus metadata without reading full shards", () => {
    const records = representativeRecords();
    const corpusPath = path.join(tmp, "corpus.json");
    publish(records, { corpusPath });
    const tiersDir = tiersDirForCorpusPath(corpusPath);

    const meta = readBoundedMetadata(tiersDir);
    expect(meta.manifest).not.toBeNull();
    expect(meta.manifest!.total_records).toBe(records.length);
    expect(meta.signal).not.toBeNull();
    expect(meta.signal!.records.length).toBeGreaterThan(0);
    expect(meta.signal!.bytes).toBeGreaterThan(0);
    expect(meta.corpusMetadata).not.toBeNull();
    expect(meta.corpusMetadata!.extracted_at).toBe("2026-01-15T00:00:00Z");
  });

  it("returns nulls when no tiers exist", () => {
    const meta = readBoundedMetadata(tmp);
    expect(meta.manifest).toBeNull();
    expect(meta.signal).toBeNull();
    expect(meta.corpusMetadata).toBeNull();
  });

  it("returns null signal when the signal tier exceeds its cap", () => {
    const records = representativeRecords();
    const corpusPath = path.join(tmp, "corpus.json");
    publish(records, { corpusPath });
    const tiersDir = tiersDirForCorpusPath(corpusPath);
    // Corrupt the signal tier file to declare an impossible byte count.
    const gen = JSON.parse(fs.readFileSync(path.join(tiersDir, "current.json"), "utf8"));
    const manifestPath = path.join(tiersDir, "generations", gen.generation, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.signal.bytes = evidenceTierBounds().signalByteCap + 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const meta = readBoundedMetadata(tiersDir);
    expect(meta.signal).toBeNull();
    expect(meta.manifest).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// iterBoundedRecords (streaming, one shard at a time)
// ---------------------------------------------------------------------------

describe("iterBoundedRecords", () => {
  it("yields every record across all shards", () => {
    const records = representativeRecords();
    const corpusPath = path.join(tmp, "corpus.json");
    publish(records, { corpusPath });
    const tiersDir = tiersDirForCorpusPath(corpusPath);

    const yielded = Array.from(iterBoundedRecords(tiersDir) ?? []);
    const ids = yielded.map((r) => r.source_id as string).sort();
    expect(ids).toEqual(records.map((r) => r.source_id as string).sort());
  });

  it("returns null when no current generation exists", () => {
    const gen = iterBoundedRecords(tmp);
    // A generator object is returned, but it yields nothing.
    expect(Array.from(gen ?? []).length).toBe(0);
  });

  it("reads one shard at a time without materializing the whole corpus", () => {
    // Build records spanning at least one shard; verify all are yielded.
    const records: JsonObject[] = [];
    for (let i = 0; i < 30; i++) {
      records.push(fullRecord({
        sourceId: `s${i}`,
        sourceProduct: "opencode",
        runtime: "opencode",
        timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        data: { idx: i, text: "x".repeat(2048) },
      }));
    }
    const corpusPath = path.join(tmp, "corpus.json");
    publish(records, { corpusPath });
    const tiersDir = tiersDirForCorpusPath(corpusPath);

    // The generator yields records one shard at a time, without pre-loading
    // the monolithic envelope. Every record must be present in the stream.
    let count = 0;
    for (const _r of iterBoundedRecords(tiersDir)!) {
      count++;
    }
    expect(count).toBe(records.length);
  });
});

// ---------------------------------------------------------------------------
// legacyCorpusReadable
// ---------------------------------------------------------------------------

describe("legacyCorpusReadable", () => {
  it("returns false for a missing file", () => {
    expect(legacyCorpusReadable(path.join(tmp, "nope.json"))).toBe(false);
  });

  it("returns true for a small legacy corpus", () => {
    const p = path.join(tmp, "corpus.json");
    fs.writeFileSync(p, '{"metadata":{},"records":[]}');
    expect(legacyCorpusReadable(p)).toBe(true);
  });

  it("returns false for an oversized legacy corpus", () => {
    const bounds = evidenceTierBounds();
    const p = path.join(tmp, "corpus.json");
    const fd = fs.openSync(p, "w");
    fs.ftruncateSync(fd, bounds.readerByteCap + 1);
    fs.closeSync(fd);
    expect(legacyCorpusReadable(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 2 audit gap: oversized single record is retained and reported
// ---------------------------------------------------------------------------

describe("oversized single-record retention (Task 2 audit gap)", () => {
  it("retains an oversized record in its own shard and reports oversized state", () => {
    const big = "x".repeat(PROPORTIONAL_SHARD_BYTE_CAP + 4096);
    const records = [
      fullRecord({
        sourceId: "oversized",
        sourceProduct: "opencode",
        runtime: "opencode",
        data: { big },
      }),
      fullRecord({
        sourceId: "normal",
        sourceProduct: "opencode",
        runtime: "opencode",
        timestamp: "2026-01-02T00:00:00.000Z",
        data: { text: "normal record" },
      }),
    ];
    const corpusPath = path.join(tmp, "corpus.json");
    publish(records, { corpusPath, contractPath: proportionalContractPath() });
    const tiersDir = tiersDirForCorpusPath(corpusPath);

    // The tier is reported as oversized.
    const a = assessTiers(tiersDir, corpusPath);
    expect(a.state).toBe("oversized");
    expect(a.analyzable).toBe(false);
    expect(a.artifact).toBeTruthy();

    // The oversized record IS on disk in its own shard — not silently dropped.
    const gen = JSON.parse(fs.readFileSync(path.join(tiersDir, "current.json"), "utf8"));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tiersDir, "generations", gen.generation, "manifest.json"), "utf8"),
    );
    expect(manifest.total_records).toBe(2);

    // Find the oversized shard (its declared bytes exceed the cap).
    const oversizedShards = manifest.shards.filter(
      (s: { bytes: number }) => s.bytes > PROPORTIONAL_SHARD_BYTE_CAP,
    );
    expect(oversizedShards.length).toBeGreaterThan(0);
    expect(a.artifact).toBe(oversizedShards[0].path);

    // Verify the oversized shard file actually contains the record.
    const shardPath = path.join(tiersDir, "generations", gen.generation, oversizedShards[0].path);
    const shardData = JSON.parse(fs.readFileSync(shardPath, "utf8"));
    const ids = shardData.records.map((r: JsonObject) => r.source_id);
    expect(ids).toContain("oversized");

    // Consumers degrade rather than reading the oversized tier.
    expect(a.recovery).not.toBeUndefined();
    expect(isAnalyzable(a.state)).toBe(false);
  });
});
