import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADAPTER_VERSION } from "../../src/analytics/extractCorpus/core.js";
import { evidenceTierBounds } from "../../src/registries/evidenceTierContract.js";
import {
  deriveSignalRecords,
  evidenceTierCompatibility,
  familyOf,
  generationId,
  getFullRecord,
  readCurrentGeneration,
  readSignalTier,
  publishEvidenceTiers,
  resolveEvidenceAnchor,
  selectSignalsForBound,
  shardFullEvidence,
  type FullEvidenceShard,
  type PublicationResult,
  type SignalRecord,
} from "../../src/analytics/extractCorpus/evidenceTiers.js";
// JsonObject re-export sanity (imported via the module under test for fixtures).
type JsonObjectLocal = Record<string, unknown>;
type JsonObject = JsonObjectLocal;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-tiers-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Build a full evidence record shaped like the extraction adapters emit. */
function fullRecord(opts: {
  sourceId: string;
  sourceKind?: string;
  timestamp?: string;
  sourceProduct?: string;
  runtime?: string | null;
  data?: JsonObject;
  sessionId?: string;
}): JsonObjectLocal {
  const r: JsonObjectLocal = {
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
  if (opts.sessionId) {
    r.session_id = opts.sessionId;
    r.conversation_key = opts.sessionId;
  }
  return r;
}

/** A small representative corpus spanning several source families. */
function representativeRecords(): JsonObjectLocal[] {
  return [
    fullRecord({ sourceId: "a1", sourceKind: "instruction_document", sourceProduct: "filesystem", runtime: "filesystem", timestamp: "2026-01-01T00:00:00.000Z", data: { doc_type: "agents_md" } }),
    fullRecord({ sourceId: "a2", sourceKind: "project_config_signal", sourceProduct: "filesystem", runtime: "filesystem", timestamp: "2026-01-01T00:00:01.000Z", data: { config_type: "package_json", signals: ["name=demo"] } }),
    fullRecord({ sourceId: "c1", sourceKind: "conversation_turn", sourceProduct: "opencode", runtime: "opencode", timestamp: "2026-01-02T10:00:00.000Z", data: { actor: "user", signal_type: "question", text: "why?" } }),
    fullRecord({ sourceId: "c2", sourceKind: "conversation_turn", sourceProduct: "opencode", runtime: "opencode", timestamp: "2026-01-02T10:01:00.000Z", data: { actor: "assistant", text: "because" } }),
    fullRecord({ sourceId: "c3", sourceKind: "conversation_turn", sourceProduct: "codex", runtime: "codex", timestamp: "2026-01-03T09:00:00.000Z", data: { actor: "user", signal_type: "decision", text: "decide to keep it" } }),
    fullRecord({ sourceId: "t1", sourceKind: "tool_call", sourceProduct: "cursor", runtime: "cursor", timestamp: "2026-01-04T12:00:00.000Z", data: { tool_name: "edit", arguments: { file: "x" } } }),
    fullRecord({ sourceId: "h1", sourceKind: "history_prompt", sourceProduct: "claude-code", runtime: null, timestamp: "2026-01-05T08:00:00.000Z", data: { prompt: "old" } }),
  ];
}

function publish(records: JsonObjectLocal[], tiersDir = tmp, runtimeStatuses?: JsonObjectLocal[]): PublicationResult {
  return publishEvidenceTiers(records, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    runtimeStatuses: runtimeStatuses as JsonObject[],
    publishedAt: "2026-01-15T00:00:00.000Z",
  });
}

describe("AC1 — publication retains every record within declared bounds", () => {
  it("every full record is retrievable by source_id after publication", () => {
    const records = representativeRecords();
    const result = publish(records);
    for (const r of records) {
      const retrieved = getFullRecord(r.source_id as string, tmp);
      expect(retrieved, `missing ${r.source_id}`).not.toBeNull();
      expect((retrieved as JsonObject).source_id).toBe(r.source_id);
    }
    expect(result.total_records).toBe(records.length);
  });

  it("no full-evidence shard or signal tier exceeds its declared bound", () => {
    const records = representativeRecords();
    const result = publish(records);
    const bounds = evidenceTierBounds();
    const gen = readCurrentGeneration(tmp);
    expect(gen).not.toBeNull();
    for (const shard of (gen!.manifest.shards as FullEvidenceShard[])) {
      expect(shard.bytes, `${shard.path}`).toBeLessThanOrEqual(bounds.shardByteCap);
    }
    expect(result.signal_bytes).toBeLessThanOrEqual(bounds.signalByteCap);
  });

  it("an oversized family splits across numbered sub-shards without dropping records", () => {
    const productFamily = new Map([["opencode", "opencode"]]);
    const big = "x".repeat(2048);
    const records: JsonObjectLocal[] = [];
    for (let i = 0; i < 40; i++) {
      records.push(fullRecord({ sourceId: `big${i}`, sourceProduct: "opencode", runtime: "opencode", timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, data: { big, idx: i } }));
    }
    const smallCap = 8192;
    const shards = shardFullEvidence(records, smallCap, productFamily);
    expect(shards.length, "family must split into >1 shard").toBeGreaterThan(1);
    // Every shard stays under the declared cap.
    for (const shard of shards) expect(shard.bytes).toBeLessThanOrEqual(smallCap);
    // No record is dropped to fit a shard.
    const retained = shards.flatMap((s) => s.records).map((r) => (r as JsonObject).source_id);
    expect(new Set(retained).size).toBe(records.length);
  });
});

describe("AC2 — identical inputs yield stable tier membership and ordering", () => {
  it("reproduces an identical generation id and signal set", () => {
    const records = representativeRecords();
    const r1 = publish(records, path.join(tmp, "g1"));
    const r2 = publish(records, path.join(tmp, "g2"));
    expect(r2.generation).toBe(r1.generation);
    const s1 = readSignalTier(path.join(tmp, "g1"))!.records;
    const s2 = readSignalTier(path.join(tmp, "g2"))!.records;
    expect(s1.map((s) => s.source_id)).toEqual(s2.map((s) => s.source_id));
    expect(s1.map((s) => s.signal_type)).toEqual(s2.map((s) => s.signal_type));
  });

  it("records arriving in different input order still produce the same generation", () => {
    const records = representativeRecords();
    const shuffled = records.slice().reverse();
    const r1 = publish(records, path.join(tmp, "g1"));
    const r2 = publish(shuffled, path.join(tmp, "g2"));
    expect(r2.generation).toBe(r1.generation);
  });

  it("generation id changes when evidence content changes", () => {
    const records = representativeRecords();
    const r1 = publish(records, path.join(tmp, "g1"));
    const altered = records.map((r, i) => (i === 0 ? { ...r, source_id: "a1x" } : r));
    const r2 = publish(altered, path.join(tmp, "g2"));
    expect(r2.generation).not.toBe(r1.generation);
  });
});

describe("AC3 — no consumer observes a partially published generation", () => {
  it("a missing current pointer before publication resolves to missing/legacy", () => {
    expect(readCurrentGeneration(tmp)).toBeNull();
    const compat = evidenceTierCompatibility(tmp);
    expect(compat.state).toBe("missing");
  });

  it("legacy monolithic corpus.json without tiers reports legacy state", () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, "corpus.json"), '{"metadata":{},"records":[]}');
    const compat = evidenceTierCompatibility(tmp, path.join(tmp, "corpus.json"));
    expect(compat.state).toBe("legacy");
  });

  it("an interrupted publication (no current swap) leaves no partial generation visible", () => {
    const records = representativeRecords();
    const result = publish(records); // establishes a current generation
    const firstGen = result.generation;
    // Simulate interruption: stage a new generation dir without swapping current.
    const stagedDir = path.join(tmp, ".staging", `interrupted.${process.pid}.${Date.now()}`);
    fs.mkdirSync(path.join(stagedDir, "full-evidence"), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, "manifest.json"), '{"schema_version":"agentera.evidenceTiers.v1"}');
    // The current pointer still references the faithful generation.
    const current = readCurrentGeneration(tmp);
    expect(current?.pointer.generation).toBe(firstGen);
    // Retrieval still serves the complete prior generation.
    expect(getFullRecord("c1", tmp)).not.toBeNull();
  });

  it("a second refresh atomically supersedes the prior generation", () => {
    const records = representativeRecords();
    const r1 = publish(records, path.join(tmp, "t"));
    expect(r1.superseded_generation).toBeNull();
    const more = [...records, fullRecord({ sourceId: "c4", sourceProduct: "opencode", runtime: "opencode", timestamp: "2026-02-01T00:00:00.000Z", data: { actor: "user", signal_type: "correction", text: "no, actually" } })];
    const r2 = publishEvidenceTiers(more, { tiersDir: path.join(tmp, "t"), adapterVersion: ADAPTER_VERSION, publishedAt: "2026-01-16T00:00:00.000Z" });
    expect(r2.superseded_generation).toBe(r1.generation);
    expect(getFullRecord("c4", path.join(tmp, "t"))).not.toBeNull();
  });
});

describe("AC4 — a bounded signal's identity resolves to retained full evidence", () => {
  it("every signal evidence_anchor resolves to its full record", () => {
    const records = representativeRecords();
    publish(records);
    const { records: signals } = readSignalTier(tmp)!;
    for (const s of signals) {
      const full = resolveEvidenceAnchor(s.evidence_anchor, tmp);
      expect(full, `anchor ${s.evidence_anchor} did not resolve`).not.toBeNull();
      expect((full as JsonObject).source_id).toBe(s.source_id);
    }
  });

  it("a signal's own source_id resolves to the same full record (no invented identity)", () => {
    const records = representativeRecords();
    publish(records);
    const { records: signals } = readSignalTier(tmp)!;
    for (const s of signals) {
      expect(getFullRecord(s.source_id, tmp)).not.toBeNull();
    }
  });
});

describe("Unknown 1 — deterministic signal bound and selection", () => {
  it("derives a signal for every full record with a classified signal_type where applicable", () => {
    const signals = deriveSignalRecords(representativeRecords());
    const byId = new Map(signals.map((s) => [s.source_id, s] as const));
    expect(byId.get("a1")!.signal_type).toBe("instruction");
    expect(byId.get("a2")!.signal_type).toBe("configuration");
    expect(byId.get("c1")!.signal_type).toBe("question");
    expect(byId.get("c3")!.signal_type).toBe("decision");
    expect(byId.get("c2")!.signal_type).toBe("record_identity");
    expect(byId.get("t1")!.signal_type).toBe("record_identity");
    expect(byId.get("h1")!.signal_type).toBe("record_identity");
    // Every signal anchors back to its full record.
    for (const s of signals) expect(s.evidence_anchor).toBe(s.source_id);
  });

  it("retains every signal when the tier fits the cap (natural outcome)", () => {
    const signals = deriveSignalRecords(representativeRecords());
    const { records, selection } = selectSignalsForBound(signals, evidenceTierBounds().signalByteCap);
    expect(selection.capped).toBe(false);
    expect(records.length).toBe(signals.length);
  });

  it("applies proportional-per-family selection preserving >=1 per family when capped", () => {
    const signals: SignalRecord[] = [];
    // opencode has the most, codex fewer, cursor one. Under a tiny cap.
    for (let i = 0; i < 200; i++) signals.push({ source_id: `op${i}`, source_kind: "conversation_turn", signal_type: "decision", timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, project_id: "p", runtime: "opencode", source_product: "opencode", evidence_anchor: `op${i}` });
    for (let i = 0; i < 50; i++) signals.push({ source_id: `co${i}`, source_kind: "conversation_turn", signal_type: "question", timestamp: `2026-01-02T00:00:${String(i % 60).padStart(2, "0")}.000Z`, project_id: "p", runtime: "codex", source_product: "codex", evidence_anchor: `co${i}` });
    signals.push({ source_id: "cu1", source_kind: "tool_call", signal_type: "record_identity", timestamp: "2026-01-03T00:00:00.000Z", project_id: "p", runtime: "cursor", source_product: "cursor", evidence_anchor: "cu1" });
    const cap = 4096;
    const { records, selection } = selectSignalsForBound(signals, cap);
    expect(selection.capped).toBe(true);
    expect(records.length).toBeLessThan(signals.length);
    const families = new Set(records.map((s) => s.source_product));
    // No supported source is silently truncated to zero.
    expect(families.has("opencode")).toBe(true);
    expect(families.has("codex")).toBe(true);
    expect(families.has("cursor")).toBe(true);
    // Selected bytes stay under the cap.
    expect(Buffer.byteLength(JSON.stringify({ records }), "utf-8")).toBeLessThanOrEqual(cap);
  });

  it("selection is deterministic: same input reproduces identical membership and order", () => {
    const signals: SignalRecord[] = [];
    for (let i = 0; i < 100; i++) signals.push({ source_id: `op${i}`, source_kind: "conversation_turn", signal_type: "decision", timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`, project_id: "p", runtime: "opencode", source_product: "opencode", evidence_anchor: `op${i}` });
    const cap = 2048;
    const a = selectSignalsForBound(signals, cap);
    const b = selectSignalsForBound(signals.slice().reverse(), cap);
    expect(b.records.map((s) => s.source_id)).toEqual(a.records.map((s) => s.source_id));
  });
});

describe("family sharding + compatibility states", () => {
  it("shards group records by projected source family", () => {
    const bounds = evidenceTierBounds();
    const productFamily = new Map([
      ["opencode", "opencode"],
      ["codex", "codex"],
      ["cursor", "cursor"],
      ["claude-code", "claude-code"],
      ["filesystem", "filesystem"],
    ]);
    const shards = shardFullEvidence(representativeRecords(), bounds.shardByteCap, productFamily);
    const families = [...new Set(shards.map((s) => s.family))].sort();
    expect(families).toEqual(["claude-code", "codex", "cursor", "filesystem", "opencode"]);
    expect(familyOf(fullRecord({ sourceId: "z", sourceProduct: "filesystem", runtime: "filesystem" }), productFamily)).toBe("filesystem");
  });

  it("reports incomplete state when a supported family was skipped/sparse", () => {
    const records = representativeRecords();
    const runtimeStatuses: JsonObjectLocal[] = [
      { runtime: "codex", source_product: "codex", source_class: "active_runtime", active_runtime: true, status: "sparse", reason: "no_candidate_files", store_path: "/codex" },
      { runtime: "opencode", source_product: "opencode", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
    ];
    publish(records, tmp, runtimeStatuses);
    const compat = evidenceTierCompatibility(tmp);
    expect(compat.state).toBe("incomplete");
    if (compat.state === "incomplete") {
      expect(compat.detail.some((d) => d.includes("codex"))).toBe(true);
    }
  });

  it("reports current when every supported family is available and accepted", () => {
    const records = representativeRecords();
    const runtimeStatuses: JsonObjectLocal[] = [
      { runtime: "opencode", source_product: "opencode", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
      { runtime: "cursor", source_product: "cursor", source_class: "active_runtime", active_runtime: true, status: "available", reason: "candidate_files_found" },
    ];
    publish(records, tmp, runtimeStatuses);
    expect(evidenceTierCompatibility(tmp).state).toBe("current");
  });
});

describe("publication contract — generation identity", () => {
  it("generationId is content-addressable and deterministic", () => {
    const records = representativeRecords();
    const bounds = evidenceTierBounds();
    const a = generationId(records, ADAPTER_VERSION, bounds.shardByteCap, bounds.signalByteCap);
    const b = generationId(records.slice().reverse(), ADAPTER_VERSION, bounds.shardByteCap, bounds.signalByteCap);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(b).toBe(a);
  });
});
