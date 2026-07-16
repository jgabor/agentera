import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { hydrateDecisionEntries } from "../../src/cli/commands/state/decisions.js";
import { canonicalRecordJson, decisionOverlayContract } from "../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import {
  composeDecisionRevision,
  decisionRevisionContract,
  decisionRevisionPath,
  decisionRevisionViolations,
  loadDecisionRevision,
  prepareDecisionAmendment,
} from "../../src/state/decisionRevision.js";
import { composeDecisionOverlay, decisionOverlayPath, loadDecisionOverlay } from "../../src/state/decisionOverlay.js";
import { retrieveStateEntry, StateRetrievalFailure } from "../../src/state/directRetrieval.js";
import { listStateEntries } from "../../src/state/listRetrieval.js";
import { startupHistorySummary } from "../../src/state/startupProjection.js";
import { StateWriteInputError } from "../../src/state/write/errors.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-revision-reads-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function baseRecord(number: number): Record<string, unknown> {
  return {
    number,
    date: "2026-07-16",
    question: "Where do decision amendments live?",
    context: "Effective reads must compose base→revisions→overlay.",
    alternatives: [
      { name: "Separate revision authority", status: "chosen" },
      { name: "Mutate the archive", status: "rejected" },
    ],
    choice: "Separate revision authority",
    reasoning: "Immutable archive plus content revisions preserves provenance.",
    confidence: "firm",
    feeds_into: [],
    satisfaction: { state: "open" },
  };
}

function archive(root: string, number: number, record = baseRecord(number)): string {
  const result = publishNumberedArchive(root, "decisions", number, record, { sourceRoot });
  return result.path;
}

function writeRevisionDocument(root: string, document: Record<string, unknown>): string {
  const revisionPath = decisionRevisionPath(root, sourceRoot);
  fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
  fs.writeFileSync(revisionPath, dumpYamlMapping(document), "utf8");
  return revisionPath;
}

function writeOverlay(root: string, overlay: Record<string, unknown>): string {
  const overlayPath = decisionOverlayPath(root, sourceRoot);
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, dumpYamlMapping(overlay), "utf8");
  return overlayPath;
}

function writeProjection(root: string, entries: unknown[]): void {
  const projectionPath = path.join(root, ".agentera", "decisions.yaml");
  fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
  fs.writeFileSync(projectionPath, YAML.stringify({ decisions: entries }), "utf8");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

const REVISION_PATH = (root: string) => path.join(root, ".agentera", "revisions", "decisions.yaml");
const OVERLAY_PATH = (root: string) => path.join(root, ".agentera", "overlays", "decisions.yaml");

describe("revision composition: base→revisions→overlay", () => {
  it("applies ordered amendable fields over an immutable base and leaves identity and temporal paths intact", () => {
    const base = baseRecord(7) as Record<string, unknown>;
    const contract = decisionRevisionContract(sourceRoot);
    const revisions = [
      { choice: "Separate revision authority (amended)", provenance: "historical_revision" as const, date: "2026-08-01" },
      { reasoning: "Revised reasoning composes after the base.", provenance: "historical_revision" as const, date: "2026-08-02" },
    ];

    const composed = composeDecisionRevision(base, revisions, { contract });

    expect(composed.applied).toBe(true);
    expect(composed.fields).toEqual(["choice", "reasoning"]);
    expect(composed.revisions).toHaveLength(2);
    expect(composed.revisions[0]).toMatchObject({ index: 0, fields: ["choice"], provenance: "historical_revision" });
    expect(composed.revisions[1]).toMatchObject({ index: 1, fields: ["reasoning"] });
    // Identity and temporal paths are never amended.
    expect(composed.record.number).toBe(7);
    expect(composed.record.date).toBe("2026-07-16");
    // First revision overwrites choice, second overwrites reasoning.
    expect(composed.record.choice).toBe("Separate revision authority (amended)");
    expect(composed.record.reasoning).toBe("Revised reasoning composes after the base.");
    // Untouched amendable fields are preserved from the base.
    expect(composed.record.question).toBe(base.question);
    expect(composed.broken_hash).toBe(false);
  });

  it("keeps the satisfaction overlay authority independent and ordered after content composition", () => {
    const base = baseRecord(7) as Record<string, unknown>;
    const contract = decisionRevisionContract(sourceRoot);
    // A revision never touches satisfaction.
    const revised = composeDecisionRevision(base, [{ choice: "amended choice" }], { contract });
    expect(revised.record.satisfaction).toMatchObject({ state: "open" });

    // The overlay composes the revised record, not the base.
    const overlayContract = decisionOverlayContract(sourceRoot);
    const hydrated = composeDecisionOverlay(
      revised.record,
      { satisfaction: { state: "provisionally_satisfied", evidence: "post-revision evidence" } },
      overlayContract,
    );
    expect(hydrated.choice).toBe("amended choice");
    expect(hydrated.satisfaction).toMatchObject({ state: "provisionally_satisfied", evidence: "post-revision evidence" });
  });

  it("marks broken_hash when the recorded base_sha256 drifts from the actual base", () => {
    const base = baseRecord(7) as Record<string, unknown>;
    const contract = decisionRevisionContract(sourceRoot);
    const wrongHash = "0".repeat(64);
    const revisions = [
      { choice: "drifted", provenance: "historical_revision" as const, base_sha256: wrongHash },
    ];

    expect(composeDecisionRevision(base, revisions, { contract, baseSha256: sha256(base) }).broken_hash).toBe(true);
    expect(composeDecisionRevision(base, revisions, { contract, baseSha256: wrongHash }).broken_hash).toBe(false);
  });

  it("returns an unmodified base with applied=false when no revisions exist", () => {
    const base = baseRecord(7) as Record<string, unknown>;
    const contract = decisionRevisionContract(sourceRoot);
    const empty = composeDecisionRevision(base, [], { contract });
    expect(empty.applied).toBe(false);
    expect(empty.fields).toEqual([]);
    expect(empty.revisions).toEqual([]);
    expect(empty.record).toEqual(base);
    expect(empty.broken_hash).toBe(false);
  });
});

describe("revision-backed effective decision reads", () => {
  it("composes base→revisions→overlay for the exact/get consumer with truthful provenance", () => {
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    const baseHash = sha256(record);
    writeRevisionDocument(root, {
      "decisions:1": [{ choice: "amended choice", provenance: "historical_revision", base_sha256: baseHash, date: "2026-08-01" }],
    });
    writeOverlay(root, {
      "decisions:1": { satisfaction: { state: "provisionally_satisfied", evidence: "post-revision evidence" } },
    });

    const result = retrieveStateEntry(root, "decisions", 1, { sourceRoot });

    expect(result.entry.record.choice).toBe("amended choice");
    expect(result.entry.record.satisfaction).toMatchObject({ state: "provisionally_satisfied", evidence: "post-revision evidence" });
    expect(result.entry.provenance).toMatchObject({
      archive: { available: true, verified: true, record_sha256: baseHash },
      revision: { applied: true, fields: ["choice"], revisions: 1, broken_hash: false, base_provenance: "historical_archive" },
      overlay: { applied: true, fields: ["satisfaction.state", "satisfaction.evidence"] },
    });
    expect(result.entry.compatibility).toBe("complete");
    expect(result.entry.detail_availability).toBe("full");
  });

  it("reports broken hash as degraded detail for the exact/get consumer rather than reconstructing", () => {
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    writeRevisionDocument(root, {
      "decisions:1": [{ choice: "drifted", provenance: "historical_revision", base_sha256: "0".repeat(64) }],
    });

    const result = retrieveStateEntry(root, "decisions", 1, { sourceRoot });

    expect(result.entry.provenance.revision).toMatchObject({ applied: true, broken_hash: true });
    expect(result.entry.compatibility).toBe("degraded");
    expect(result.entry.detail_availability).toBe("summary");
  });

  it("uses degraded_projection provenance when a complete legacy full projection seeds the base", () => {
    const root = project();
    const record = baseRecord(1);
    writeProjection(root, [record]);
    const baseHash = sha256(record);
    writeRevisionDocument(root, {
      "decisions:1": [{ choice: "amended via legacy base", provenance: "historical_revision", base_sha256: baseHash, date: "2026-08-01" }],
    });

    const result = retrieveStateEntry(root, "decisions", 1, { sourceRoot });

    expect(result.entry.source).toBe("legacy_full");
    expect(result.entry.record.choice).toBe("amended via legacy base");
    expect(result.entry.provenance.revision).toMatchObject({
      applied: true,
      base_provenance: "degraded_projection",
      broken_hash: false,
    });
    expect(result.entry.compatibility).toBe("degraded");
  });

  it("surfaces a corrupt revision document as a bounded corrupt failure for the exact/get consumer", () => {
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    const revisionPath = REVISION_PATH(root);
    fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
    fs.writeFileSync(revisionPath, "this: [is: malformed\n", "utf8");

    const failure = (() => {
      try {
        retrieveStateEntry(root, "decisions", 1, { sourceRoot });
      } catch (caught) {
        return caught as StateRetrievalFailure;
      }
      throw new Error("expected retrieval failure");
    })();
    expect(failure.body.error).toMatchObject({ class: "corrupt" });
    expect(failure.body.error.details).toMatchObject({ path: revisionPath });
  });

  it("degrades consistently for startup and compaction consumers when the revision document is corrupt", () => {
    // Passive projection consumers (prime startup attention and 10/40/50
    // compaction) must degrade to base values without revision annotation so
    // a corrupt amendment ledger never blocks orientation or maintenance.
    // Detail consumers (exact/get, list) surface the same corruption as a
    // bounded `corrupt` failure (covered by the prior test and
    // `decisionAmendmentPublication` refusal contract); amend refuses with
    // explicit recovery guidance. The startup/compaction silent-degradation
    // path is the consistency contract asserted here.
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    writeProjection(root, [record]);
    const revisionPath = REVISION_PATH(root);
    fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
    fs.writeFileSync(revisionPath, "this: [is: malformed\n", "utf8");

    // Startup consumer degrades silently: it returns the bounded decision row
    // with no revision annotation rather than blocking prime.
    const history = startupHistorySummary(root, "decisions", sourceRoot);
    const historyEntry = (history.entries as unknown as Record<string, unknown>[])[0];
    expect(historyEntry).toMatchObject({ entry_number: 1, addressable: true });
    expect((historyEntry.provenance as Record<string, unknown>)?.revision).toBeUndefined();

    // Compaction consumer degrades silently: plain overlay hydration never
    // throws on a corrupt revision document, so the active record keeps its
    // base bytes through a 10/40/50 pass rather than reconstructing detail.
    const decisionsOnDisk = loadYamlMapping(
      fs.readFileSync(path.join(root, ".agentera", "decisions.yaml"), "utf8"),
    ).decisions as unknown[];
    const hydrated = hydrateDecisionEntries(decisionsOnDisk, root);
    expect(hydrated[0]).toMatchObject({ choice: record.choice, confidence: record.confidence });
  });

  it("reflects revised content in the bounded list summary and revision provenance", () => {
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    writeRevisionDocument(root, {
      "decisions:1": [{ choice: "amended choice for list", provenance: "historical_revision", base_sha256: sha256(record), date: "2026-08-01" }],
    });

    const list = listStateEntries(root, "decisions", 20, {}, undefined, { sourceRoot });
    const entry = (list.entries as unknown as Record<string, unknown>[])[0];

    expect(entry.revision_applied).toBe(true);
    expect((entry.provenance as Record<string, unknown>).revision).toMatchObject({
      applied: true,
      fields: ["choice"],
      revisions: 1,
      base_provenance: "historical_archive",
    });
    // The bounded summary reflects the revised choice, not the stale base.
    expect(entry.summary).toMatchObject({ choice: "amended choice for list" });
  });

  it("annotates bounded startup decision entries with revision provenance", () => {
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    writeRevisionDocument(root, {
      "decisions:1": [{ choice: "amended startup choice", provenance: "historical_revision", base_sha256: sha256(record), date: "2026-08-01" }],
    });

    const history = startupHistorySummary(root, "decisions", sourceRoot);
    const entry = (history.entries as unknown as Record<string, unknown>[])[0];
    const provenance = entry.provenance as Record<string, unknown>;
    const revision = provenance.revision as Record<string, unknown>;

    expect(revision).toMatchObject({ applied: true, fields: ["choice"], revisions: 1 });
  });

  it("composes revisions before the satisfaction overlay in the compaction consumer", () => {
    const root = project();
    const record = baseRecord(1);
    writeProjection(root, [record]);
    writeRevisionDocument(root, {
      "decisions:1": [{ choice: "amended before overlay", provenance: "historical_revision", base_sha256: sha256(record), date: "2026-08-01" }],
    });
    writeOverlay(root, {
      "decisions:1": { satisfaction: { state: "provisionally_satisfied", evidence: "compaction overlay" } },
    });

    const hydrated = hydrateDecisionEntries(loadYamlMapping(fs.readFileSync(path.join(root, ".agentera", "decisions.yaml"), "utf8")).decisions as unknown[], root);
    const effective = hydrated[0];

    // Content amendment composed first, then the satisfaction overlay.
    expect(effective.choice).toBe("amended before overlay");
    expect(effective.satisfaction).toMatchObject({ state: "provisionally_satisfied", evidence: "compaction overlay" });
  });

  it("keeps the overlay authority independently mutable when no revisions exist", () => {
    const root = project();
    const record = baseRecord(1);
    archive(root, 1, record);
    writeOverlay(root, {
      "decisions:1": { satisfaction: { state: "user_confirmed_satisfied", user_confirmation: { confirmed_by: "user", confirmed_at: "2026-08-01T12:00:00Z" } } },
    });

    const result = retrieveStateEntry(root, "decisions", 1, { sourceRoot });

    expect(result.entry.record.satisfaction).toMatchObject({ state: "user_confirmed_satisfied" });
    expect(result.entry.provenance.revision).toMatchObject({ applied: false });
    expect(result.entry.provenance.overlay).toMatchObject({ applied: true });
  });
});

describe("amendment preparation: target selection and legacy bootstrap", () => {
  it("selects an amenable target from a verified numbered archive with historical_archive provenance", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    const baseHash = sha256(record);

    const preparation = prepareDecisionAmendment(root, 53, { choice: "further amended choice" }, { sourceRoot });

    expect(preparation.number).toBe(53);
    expect(preparation.base).toMatchObject({
      record: record,
      sha256: baseHash,
      provenance: "historical_archive",
      source: "archive",
    });
    expect(preparation.effective.choice).toBe("further amended choice");
    expect(preparation.replay).toBe(false);
    expect(preparation.provenance).toMatchObject({
      base: "historical_archive",
      archive: { available: true, verified: true, record_sha256: baseHash },
      existing_revisions: 0,
      amended_fields: ["choice"],
    });
  });

  it("bootstraps a hash-verified degraded_projection base from a complete legacy projection (never historical_archive)", () => {
    const root = project();
    const record = baseRecord(87);
    writeProjection(root, [record]);
    const baseHash = sha256(record);

    const preparation = prepareDecisionAmendment(root, 87, { reasoning: "legacy base amendment" }, { sourceRoot });

    expect(preparation.base).toMatchObject({
      sha256: baseHash,
      provenance: "degraded_projection",
      source: "legacy_full",
    });
    expect(preparation.base.provenance).not.toBe("historical_archive");
    expect(preparation.provenance.base).toBe("degraded_projection");
    expect(preparation.effective.reasoning).toBe("legacy base amendment");
  });

  it("composes existing revisions into the effective record and detects an identical replay", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    const baseHash = sha256(record);
    writeRevisionDocument(root, {
      "decisions:53": [{ choice: "first amendment", provenance: "historical_revision", base_sha256: baseHash, date: "2026-08-01" }],
    });

    const replay = prepareDecisionAmendment(root, 53, { choice: "first amendment" }, { sourceRoot });

    // Identical re-submission is an idempotent replay.
    expect(replay.replay).toBe(true);
    expect(replay.effective.choice).toBe("first amendment");
    expect(replay.provenance.existing_revisions).toBe(1);
    expect(replay.provenance.archive.record_sha256).toBe(baseHash);
  });

  it("refuses a summary-only legacy target as unsupported (missing fields are never reconstructed)", () => {
    const root = project();
    // A summary-style decision in the active projection (number via explicit
    // identity, but missing required content fields) cannot be hash-verified.
    writeProjection(root, [{ number: 88, summary: "D88 (2026-07-16): summary only" }]);

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 88, { choice: "x" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("unsupported_target");
    expect(failure.body.message).toContain("summary");
    expect(failure.body.recovery).toContain("numbered archive");
  });

  it("refuses an ambiguous legacy projection target (duplicate identity)", () => {
    const root = project();
    const record = baseRecord(53);
    writeProjection(root, [record, structuredClone(record)]);

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 53, { choice: "x" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("conflict");
    expect(failure.body.message).toContain("multiple conflicting current projection");
  });

  it("refuses a missing decision target (no archive, no projection)", () => {
    const root = project();

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 999, { choice: "x" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("unsupported_target");
    expect(failure.body.message).toContain("999");
    expect(failure.body.message).toContain("no numbered archive");
  });

  it("refuses a broken-hash target where an existing revision claims a drifted base", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    writeRevisionDocument(root, {
      "decisions:53": [{ choice: "drifted", provenance: "historical_revision", base_sha256: "0".repeat(64) }],
    });

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 53, { choice: "retry" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("conflict");
    expect(failure.body.message).toContain("base hash");
    expect(failure.body.recovery).toContain("reconcile the base drift");
  });

  it("refuses a conflicting target whose numbered archive is corrupt", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    const archivePath = path.join(root, ".agentera", "archive", "decisions", "53.yaml");
    const corrupted = YAML.parse(fs.readFileSync(archivePath, "utf8")) as Record<string, unknown>;
    const corruptRecord = (corrupted.record as Record<string, unknown>);
    corruptRecord.context = "mutated";
    fs.writeFileSync(archivePath, YAML.stringify(corrupted));

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 53, { choice: "x" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("conflict");
    expect(failure.body.message).toContain("broken numbered archive");
  });

  it("refuses a target whose revision document is broken", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    const revisionPath = REVISION_PATH(root);
    fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
    fs.writeFileSync(revisionPath, "this: [is: malformed\n", "utf8");

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 53, { choice: "x" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("conflict");
    expect(failure.body.message).toContain("revision document");
    expect(failure.body.recovery).toContain("repair");
  });

  it("refuses an unsupported amended confidence label before side effects", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 53, { confidence: "high" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("invalid_choice");
    expect(failure.body.valid_values).toEqual(["firm", "provisional", "exploratory"]);
  });

  it("refuses amendment with no amendable content fields", () => {
    const root = project();
    archive(root, 53, baseRecord(53));

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 53, {}, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("missing_argument");
    expect(failure.body.recovery).toContain("question");
  });

  it("refuses amendment against a non-positive decision number", () => {
    const root = project();

    const failure = (() => {
      try {
        prepareDecisionAmendment(root, 0, { choice: "x" }, { sourceRoot });
      } catch (caught) {
        return caught as StateWriteInputError;
      }
      throw new Error("expected preparation refusal");
    })();
    expect(failure.body.class).toBe("invalid_request");
  });
});

describe("revision authority: immutability, separation, and load validation", () => {
  it("keeps the revision document keyed by stable decision identity and refuses stray meta keys", () => {
    const violations = decisionRevisionViolations({
      "decisions:53": [{ choice: "ok", provenance: "historical_revision" }],
      "decisions:0": [{ choice: "ok" }],
      "decisions:not-a-number": [{ choice: "ok" }],
      "not-decisions:53": [{ choice: "ok" }],
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("decisions:0 is not a valid"),
        expect.stringContaining("decisions:not-a-number is not a valid"),
        expect.stringContaining("not-decisions:53 is not a valid"),
      ]),
    );
  });

  it("refuses a revision claiming historical_archive provenance", () => {
    const violations = decisionRevisionViolations({
      "decisions:53": [{ choice: "ok", provenance: "historical_archive" }],
    });
    expect(violations).toEqual(expect.arrayContaining([expect.stringContaining("must never claim historical_archive provenance")]));
  });

  it("refuses a revision that touches an overlay mutable path", () => {
    const violations = decisionRevisionViolations({
      "decisions:53": [{ choice: "ok", "satisfaction.state": "open" }],
    });
    expect(violations).toEqual(expect.arrayContaining([expect.stringContaining("not an amendable content path or revision meta key")]));
  });

  it("refuses a revision that amends no content field (provenance alone is not a revision)", () => {
    const violations = decisionRevisionViolations({
      "decisions:53": [{ provenance: "historical_revision", date: "2026-08-01" }],
    });
    expect(violations).toEqual(expect.arrayContaining([expect.stringContaining("must amend at least one content field")]));
  });

  it("refuses to load a revision document that places an identity path inside a revision", () => {
    const root = project();
    writeRevisionDocument(root, {
      "decisions:53": [{ number: 99, choice: "ok" }],
    });

    expect(() => loadDecisionRevision(root, sourceRoot)).toThrow(/not an amendable content path/);
  });

  it("preserves Task 1 immutability: appending a decision never creates a revision or overlay document", () => {
    const root = project();
    archive(root, 1, baseRecord(1));

    // No revision and no overlay document is created by publication alone.
    expect(fs.existsSync(REVISION_PATH(root))).toBe(false);
    expect(fs.existsSync(OVERLAY_PATH(root))).toBe(false);

    // The overlay loader and revision loader both report empty state.
    expect(loadDecisionOverlay(root, sourceRoot)).toEqual({});
    expect(loadDecisionRevision(root, sourceRoot)).toEqual({});
  });
});

describe("replay protection: effective record over drift", () => {
  it("treats a non-identical re-submission of an amended field as a new revision, not a replay", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    const baseHash = sha256(record);
    writeRevisionDocument(root, {
      "decisions:53": [{ choice: "first amendment", provenance: "historical_revision", base_sha256: baseHash, date: "2026-08-01" }],
    });

    const preparation = prepareDecisionAmendment(root, 53, { choice: "second amendment" }, { sourceRoot });

    expect(preparation.replay).toBe(false);
    expect(preparation.effective.choice).toBe("second amendment");
    expect(preparation.provenance.existing_revisions).toBe(1);
  });

  it("composes requested amendments over multiple existing revisions in declared order", () => {
    const root = project();
    const record = baseRecord(53);
    archive(root, 53, record);
    const baseHash = sha256(record);
    writeRevisionDocument(root, {
      "decisions:53": [
        { choice: "first", provenance: "historical_revision", base_sha256: baseHash, date: "2026-08-01" },
        { reasoning: "second revision reasoning", provenance: "historical_revision", date: "2026-08-02" },
      ],
    });

    const preparation = prepareDecisionAmendment(root, 53, { confidence: "provisional" }, { sourceRoot });

    expect(preparation.effective.choice).toBe("first");
    expect(preparation.effective.reasoning).toBe("second revision reasoning");
    expect(preparation.effective.confidence).toBe("provisional");
    expect(preparation.provenance.existing_revisions).toBe(2);
    expect(preparation.provenance.amended_fields).toEqual(["confidence"]);
  });
});
