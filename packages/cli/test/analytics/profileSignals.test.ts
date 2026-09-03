import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ADAPTER_VERSION, contentFingerprint, originIdentity } from "../../src/analytics/extractCorpus/core.js";
import { publishEvidenceTiers } from "../../src/analytics/extractCorpus/evidenceTiers.js";
import { readProfileSignals, resolveProfileEvidence, profileSignalsStatus, assessProfileSufficiency } from "../../src/analytics/profileSignals.js";
import { profileSufficiency } from "../../src/registries/evidenceTierContract.js";
import type { SignalRecord } from "../../src/analytics/extractCorpus/evidenceTiers.js";

type JsonObjectLocal = Record<string, unknown>;

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profile-signals-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a full evidence record shaped like the extraction adapters emit. */
function fullRecord(opts: { sourceId: string; sourceKind?: string; timestamp?: string; sourceProduct?: string; runtime?: string | null; data?: JsonObjectLocal }): JsonObjectLocal {
  const data = opts.data ?? { actor: "user", text: "hello" };
  const record: JsonObjectLocal = {
    source_id: opts.sourceId,
    source_kind: opts.sourceKind ?? "conversation_turn",
    timestamp: opts.timestamp ?? "2026-01-01T00:00:00.000Z",
    project_id: "demo",
    runtime: opts.runtime ?? "opencode",
    source_class: "active_runtime",
    source_product: opts.sourceProduct ?? "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data,
  };
  if (record.source_kind === "conversation_turn" || record.source_kind === "history_prompt") {
    record.session_id = `session-${opts.sourceId}`;
    record.conversation_key = record.session_id;
    record.origin_id = originIdentity(`fixture:${opts.sourceId}`);
    record.content_fingerprint = contentFingerprint(`fixture:${opts.sourceId}`);
    record.author_class = data.actor === "assistant" ? "agent" : "user";
  }
  return record;
}

/** A representative corpus with profile-relevant signal types across families. */
function representativeRecords(): JsonObjectLocal[] {
  return [
    fullRecord({
      sourceId: "a1",
      sourceKind: "instruction_document",
      sourceProduct: "filesystem",
      runtime: "filesystem",
      data: { doc_type: "agents_md" },
    }),
    fullRecord({
      sourceId: "a2",
      sourceKind: "project_config_signal",
      sourceProduct: "filesystem",
      runtime: "filesystem",
      data: { config_type: "package_json" },
    }),
    fullRecord({
      sourceId: "c1",
      sourceKind: "conversation_turn",
      sourceProduct: "opencode",
      runtime: "opencode",
      timestamp: "2026-01-02T10:00:00.000Z",
      data: { actor: "user", signal_type: "decision", text: "decide to keep it" },
    }),
    fullRecord({
      sourceId: "c2",
      sourceKind: "conversation_turn",
      sourceProduct: "opencode",
      runtime: "opencode",
      timestamp: "2026-01-02T10:01:00.000Z",
      data: { actor: "assistant", text: "because" },
    }),
    fullRecord({
      sourceId: "c3",
      sourceKind: "conversation_turn",
      sourceProduct: "codex",
      runtime: "codex",
      timestamp: "2026-01-03T09:00:00.000Z",
      data: { actor: "user", signal_type: "question", text: "why?" },
    }),
    fullRecord({
      sourceId: "c4",
      sourceKind: "conversation_turn",
      sourceProduct: "codex",
      runtime: "codex",
      timestamp: "2026-01-03T09:01:00.000Z",
      data: { actor: "user", signal_type: "correction", text: "no, instead" },
    }),
    fullRecord({
      sourceId: "h1",
      sourceKind: "history_prompt",
      sourceProduct: "claude-code",
      runtime: null,
      timestamp: "2026-01-05T08:00:00.000Z",
      data: { prompt: "old" },
    }),
  ];
}

function publish(records: JsonObjectLocal[], tiersDir = tmp): { generation: string } {
  const result = publishEvidenceTiers(records, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    runtimeStatuses: [
      {
        runtime: "opencode",
        source_product: "opencode",
        status: "ok",
        source_class: "active_runtime",
        active_runtime: true,
      },
      {
        runtime: "codex",
        source_product: "codex",
        status: "ok",
        source_class: "active_runtime",
        active_runtime: true,
      },
      {
        runtime: "claude-code",
        source_product: "claude-code",
        status: "ok",
        source_class: "historical_import",
        active_runtime: false,
      },
    ],
  });
  return { generation: result.generation };
}

describe("readProfileSignals — bounded input", () => {
  it("reads profile-relevant signals without loading full evidence", () => {
    const records = representativeRecords();
    const publication = publish(records);
    const readFile = vi.spyOn(fs, "readFileSync");
    const result = readProfileSignals(tmp);
    const paths = readFile.mock.calls.map(([file]) => path.resolve(String(file)));
    expect(paths).toContain(path.join(tmp, "generations", publication.generation, "signal.json"));
    expect(paths.filter((file) => file.includes(`${path.sep}full-evidence${path.sep}`))).toEqual([]);
    expect(result.state).toBe("current");
    expect(result.signals.length).toBeGreaterThan(0);
    // Only profile-relevant signal types are returned (no record_identity, no tool_call).
    const types = new Set(result.signals.map((s) => s.signal_type));
    for (const t of types) {
      expect(["decision", "question", "correction", "instruction", "configuration"]).toContain(t);
    }
    // Each signal carries the contract-required fields with evidence_anchor.
    for (const sig of result.signals) {
      expect(sig.evidence_anchor).toBeTruthy();
      expect(sig.source_id).toBe(sig.evidence_anchor);
      expect(sig.source_kind).toBeTruthy();
      expect(sig.timestamp).toBeTruthy();
      expect(sig.source_product).toBeTruthy();
      expect((sig as unknown as Record<string, unknown>).data).toBeUndefined();
    }
  });
});

describe("resolveProfileEvidence — evidence resolution", () => {
  it("resolves a signal's evidence anchor to its retained full record", () => {
    const records = representativeRecords();
    const publication = publish(records);
    const signals = readProfileSignals(tmp);
    const decision = signals.signals.find((s) => s.signal_type === "decision");
    expect(decision).toBeDefined();
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "generations", publication.generation, "manifest.json"), "utf8")) as { shards: Array<{ path: string; source_ids: string[] }> };
    expect(manifest.shards.length).toBeGreaterThan(1);
    const owner = manifest.shards.find((shard) => shard.source_ids.includes(decision!.evidence_anchor));
    expect(owner).toBeDefined();
    const readFile = vi.spyOn(fs, "readFileSync");
    const full = resolveProfileEvidence(decision!.evidence_anchor, tmp);
    const shardReads = readFile.mock.calls.map(([file]) => path.resolve(String(file))).filter((file) => file.includes(`${path.sep}full-evidence${path.sep}`));
    expect(shardReads).toEqual([path.join(tmp, "generations", publication.generation, owner!.path)]);
    expect(full).not.toBeNull();
    expect((full as JsonObjectLocal).source_id).toBe(decision!.evidence_anchor);
    expect((full as JsonObjectLocal).source_kind).toBe("conversation_turn");
    // The full record carries the transcript data the signal tier excluded.
    const data = (full as JsonObjectLocal).data as JsonObjectLocal;
    expect(data.text).toBe("decide to keep it");
  });

  it("returns null for an unresolvable anchor", () => {
    publish(representativeRecords());
    const full = resolveProfileEvidence("nonexistent-id", tmp);
    expect(full).toBeNull();
  });

  it("returns null for an empty anchor", () => {
    publish(representativeRecords());
    const full = resolveProfileEvidence("", tmp);
    expect(full).toBeNull();
  });
});

describe("assessProfileSufficiency — insufficiency reporting", () => {
  it("reports sufficient when the tier is uncapped (retained == total)", () => {
    const records = representativeRecords();
    publish(records);
    const read = readProfileSignals(tmp);
    expect(read.sufficiency.sufficient).toBe(true);
    expect(read.sufficiency.capped).toBe(false);
    expect(read.sufficiency.reason).toContain("uncapped");
  });

  it("reports insufficient when a family retention drops below the threshold", () => {
    // Simulate a capped tier where a family retained 0 of its intended signals.
    const selection = {
      total: 10,
      retained: 3,
      capped: true,
      per_family: [
        { family: "opencode", total: 8, retained: 3 },
        { family: "codex", total: 2, retained: 0 },
      ],
    };
    // Retained profile-relevant signals: only opencode's 3, no codex.
    const signals: SignalRecord[] = [
      {
        source_id: "s1",
        source_kind: "conversation_turn",
        signal_type: "decision",
        timestamp: "t1",
        project_id: "p",
        runtime: "opencode",
        source_product: "opencode",
        evidence_anchor: "s1",
      },
      {
        source_id: "s2",
        source_kind: "conversation_turn",
        signal_type: "question",
        timestamp: "t2",
        project_id: "p",
        runtime: "opencode",
        source_product: "opencode",
        evidence_anchor: "s2",
      },
      {
        source_id: "s3",
        source_kind: "instruction_document",
        signal_type: "instruction",
        timestamp: "t3",
        project_id: "p",
        runtime: "filesystem",
        source_product: "opencode",
        evidence_anchor: "s3",
      },
    ];
    const assessment = assessProfileSufficiency(selection, signals);
    expect(assessment.sufficient).toBe(false);
    expect(assessment.capped).toBe(true);
    expect(assessment.reason).toContain("insufficient");
    // The insufficiency names the underrepresented family.
    expect(assessment.reason).toContain("opencode");
  });

  it("shows insufficiency without fabricated confidence in the reason", () => {
    const selection = {
      total: 5,
      retained: 0,
      capped: true,
      per_family: [{ family: "opencode", total: 5, retained: 0 }],
    };
    const signals: SignalRecord[] = [];
    const assessment = assessProfileSufficiency(selection, signals);
    expect(assessment.sufficient).toBe(false);
    // The reason must not claim sufficiency. "insufficient" is fine —
    // the word "sufficient" must not appear as a standalone positive claim.
    expect(assessment.reason).not.toMatch(/\bsufficient\b/);
  });

  it("a family with zero intended signals is not a violation", () => {
    const selection = { total: 5, retained: 3, capped: false, per_family: [] };
    const signals: SignalRecord[] = [
      {
        source_id: "s1",
        source_kind: "conversation_turn",
        signal_type: "decision",
        timestamp: "t1",
        project_id: "p",
        runtime: "opencode",
        source_product: "opencode",
        evidence_anchor: "s1",
      },
    ];
    const assessment = assessProfileSufficiency(selection, signals);
    // Uncapped: always sufficient regardless of family presence.
    expect(assessment.sufficient).toBe(true);
  });
});

describe("assessProfileSufficiency — distribution threshold (Unknown 2)", () => {
  it("meets the threshold on an uncapped representative corpus", () => {
    const records = representativeRecords();
    publish(records);
    const read = readProfileSignals(tmp);
    expect(read.sufficiency.sufficient).toBe(true);
    // Per-family retention should be 1.0 for all families when uncapped.
    for (const fam of read.sufficiency.per_family) {
      expect(fam.retention).toBe(1);
      expect(fam.sufficient).toBe(true);
    }
  });

  it("threshold matches the contract minimum_family_retention", () => {
    const records = representativeRecords();
    publish(records);
    const read = readProfileSignals(tmp);
    const contractThreshold = profileSufficiency().minimumFamilyRetention;
    expect(read.sufficiency.threshold).toBe(contractThreshold);
  });

  it("reports insufficient when proportional selection drops a family below threshold", () => {
    // Simulate a capped tier where codex retained 1 of 10 (10% < 50% threshold).
    const selection = {
      total: 20,
      retained: 5,
      capped: true,
      per_family: [
        { family: "opencode", total: 10, retained: 4 },
        { family: "codex", total: 10, retained: 1 },
      ],
    };
    const signals: SignalRecord[] = [
      // opencode retained 4 profile-relevant signals
      {
        source_id: "s1",
        source_kind: "conversation_turn",
        signal_type: "decision",
        timestamp: "t1",
        project_id: "p",
        runtime: "opencode",
        source_product: "opencode",
        evidence_anchor: "s1",
      },
      {
        source_id: "s2",
        source_kind: "conversation_turn",
        signal_type: "question",
        timestamp: "t2",
        project_id: "p",
        runtime: "opencode",
        source_product: "opencode",
        evidence_anchor: "s2",
      },
      {
        source_id: "s3",
        source_kind: "instruction_document",
        signal_type: "instruction",
        timestamp: "t3",
        project_id: "p",
        runtime: "filesystem",
        source_product: "opencode",
        evidence_anchor: "s3",
      },
      {
        source_id: "s4",
        source_kind: "project_config_signal",
        signal_type: "configuration",
        timestamp: "t4",
        project_id: "p",
        runtime: "filesystem",
        source_product: "opencode",
        evidence_anchor: "s4",
      },
      // codex retained 1 of its intended 10 — below 50% threshold
      {
        source_id: "s5",
        source_kind: "conversation_turn",
        signal_type: "decision",
        timestamp: "t5",
        project_id: "p",
        runtime: "codex",
        source_product: "codex",
        evidence_anchor: "s5",
      },
    ];
    const assessment = assessProfileSufficiency(selection, signals);
    expect(assessment.sufficient).toBe(false);
    const codexFamily = assessment.per_family.find((f) => f.family === "codex");
    expect(codexFamily).toBeDefined();
    expect(codexFamily!.retention).toBeLessThan(assessment.threshold);
    expect(codexFamily!.sufficient).toBe(false);
  });
});

describe("profileSignalsStatus — context status surfacing", () => {
  it("surfaces current state and sufficiency when tiers are published", () => {
    const records = representativeRecords();
    const tiersDir = path.join(tmp, "intermediate", "tiers");
    publish(records, tiersDir);
    const status = profileSignalsStatus({ AGENTERA_PROFILE_DIR: tmp, HOME: tmp }, "linux");
    expect(status.state).toBe("current");
    expect(status.tiers_dir).toBe(tiersDir);
    expect(status.signal_count).toBeGreaterThan(0);
    expect(status.sufficiency).not.toBeNull();
    expect(status.sufficiency!.sufficient).toBe(true);
  });

  it("surfaces missing state when no tiers are published", () => {
    const status = profileSignalsStatus({ AGENTERA_PROFILE_DIR: tmp, HOME: tmp }, "linux");
    expect(status.state).toBe("missing");
    expect(status.signal_count).toBe(0);
    expect(status.sufficiency).toBeNull();
    expect(status.recovery).toBeTruthy();
  });

  it("surfaces legacy state when a monolithic corpus exists without tiers", () => {
    // Create a small legacy corpus.json without tiers.
    const intermediateDir = path.join(tmp, "intermediate");
    fs.mkdirSync(intermediateDir, { recursive: true });
    fs.writeFileSync(path.join(intermediateDir, "corpus.json"), JSON.stringify({ metadata: {}, records: [] }));
    const status = profileSignalsStatus({ AGENTERA_PROFILE_DIR: tmp, HOME: tmp }, "linux");
    expect(status.state).toBe("legacy");
    expect(status.sufficiency).toBeNull();
    expect(status.recovery).toContain("refresh");
  });
});

describe("absence of monolithic corpus.json output", () => {
  it("does not write corpus.json when tiers are published", () => {
    const records = representativeRecords();
    publish(records);
    // The tiers dir is tmp; the co-located corpus.json path would be
    // tmp/../corpus.json (parent of tiers). Verify it does not exist.
    const corpusPath = path.join(path.dirname(tmp), "corpus.json");
    expect(fs.existsSync(corpusPath)).toBe(false);
  });
});
