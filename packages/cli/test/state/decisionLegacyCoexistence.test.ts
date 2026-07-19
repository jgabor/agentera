import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import { compactYamlFile } from "../../src/hooks/compaction/index.js";
import {
  collectDecisionLegacyCaveats,
  decisionLegacyCoexistence,
  partitionDecisionViolations,
} from "../../src/state/decisionLegacyValidation.js";
import {
  composeDecisionRevision,
  decisionRevisionContract,
  legacyLabelCoexistence,
} from "../../src/state/decisionRevision.js";
import { retrieveStateEntry } from "../../src/state/directRetrieval.js";
import { operationSpec } from "../../src/state/write/operations.js";
import { executeStateWrite, type StateWriteRequest } from "../../src/state/write/transaction.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-legacy-coexistence-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A complete decision record. `confidence` defaults to the current vocabulary
 * (`firm`); tests pass `"high"` to plant an untouched inherited legacy label.
 */
function record(number: number, confidence: string = "firm"): Record<string, unknown> {
  return {
    number,
    date: "2026-07-16",
    question: `Question for decision ${number}?`,
    context: "Legacy coexistence across decision mutations.",
    alternatives: [
      { name: "Separate revision authority", status: "chosen" },
      { name: "Mutate the archive", status: "rejected" },
    ],
    choice: "Separate revision authority",
    reasoning: "Immutable archive plus content revisions preserves provenance.",
    confidence,
    feeds_into: [],
    satisfaction: { state: "open" },
  };
}

/** A confirmed decision record (protected from compaction drop until reviewed). */
function confirmed(number: number, confidence: string = "firm"): Record<string, unknown> {
  return {
    ...record(number, confidence),
    satisfaction: {
      state: "user_confirmed_satisfied",
      user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-16" },
    },
  };
}

function writeProjection(root: string, entries: unknown[]): string {
  const projectionPath = path.join(root, ".agentera", "decisions.yaml");
  fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
  fs.writeFileSync(projectionPath, dumpYamlMapping({ decisions: entries }), "utf8");
  return projectionPath;
}

function archive(root: string, number: number, entry: Record<string, unknown>): string {
  return publishNumberedArchive(root, "decisions", number, entry, { sourceRoot }).path;
}

function appendRequest(
  root: string,
  number: number,
  confidence: string = "firm",
  dryRun = false,
): StateWriteRequest {
  const spec = operationSpec("decisions", "append")!;
  const values = {
    date: "2026-07-16",
    question: `Appended question ${number}?`,
    context: "New current-vocabulary content.",
    alternatives: { chosen: "Append path", rejected: ["Rewrite everything"] },
    choice: "Append path",
    reasoning: "Append keeps untouched inherited legacy labels byte-stable.",
    confidence,
    feeds_into: [],
  };
  return {
    artifact: "decisions",
    spec,
    projectRoot: root,
    dryRun,
    force: false,
    values,
    callerPayload: structuredClone(values),
    input: null,
  };
}

function updateRequest(
  root: string,
  number: number,
  state: string = "provisionally_satisfied",
  dryRun = true,
): StateWriteRequest {
  const spec = operationSpec("decisions", "update")!;
  return {
    artifact: "decisions",
    spec,
    projectRoot: root,
    dryRun,
    force: false,
    values: {
      number,
      satisfaction:
        state === "provisionally_satisfied"
          ? { state, evidence: "writer tests green" }
          : { state },
    },
    callerPayload: {},
    input: null,
  };
}

function amendRequest(
  root: string,
  number: number,
  fields: Record<string, unknown>,
  dryRun = true,
): StateWriteRequest {
  const spec = operationSpec("decisions", "amend")!;
  return {
    artifact: "decisions",
    spec,
    projectRoot: root,
    dryRun,
    force: false,
    values: { number, ...fields },
    callerPayload: structuredClone(fields),
    input: null,
  };
}

interface Captured {
  rc: number;
  out: string;
  err: string;
  json: Record<string, any> | null;
}

function runCli(root: string, args: string[]): Captured {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", "state", ...args, "--project", root], {
    out: (t) => (out += t),
    err: (t) => (err += t),
    stdin: () => "",
  });
  return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

const compatibilityCaveats = (result: Record<string, any>): any[] =>
  result.compatibility?.legacy_caveats ?? [];

const projectionPath = (root: string) => path.join(root, ".agentera", "decisions.yaml");

const readProjection = (root: string) => loadYamlMapping(fs.readFileSync(projectionPath(root), "utf8"));

/* ============================================================ *
 * Criterion 1: untouched inherited legacy labels do not block
 * append, satisfaction update, or amend; they are reported as
 * legacy caveats.
 * ============================================================ */
describe("whole-artifact prevalidation tolerates untouched inherited legacy confidence", () => {
  it("append over an artifact carrying an inherited legacy 'high' succeeds and reports the caveat", () => {
    const root = project();
    writeProjection(root, [record(1, "high")]);

    const result = executeStateWrite(appendRequest(root, 2, "firm", true));

    expect(result.status).toBe("pass");
    expect(result.operation).toMatchObject({ verb: "append", dry_run: true });
    const caveats = compatibilityCaveats(result as Record<string, any>);
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toMatchObject({ number: 1, label: "high", source: "active" });
    expect(caveats[0].caveat).toContain("explicit legacy state");
  });

  it("satisfaction update over an artifact carrying an inherited legacy 'high' succeeds and reports the caveat", () => {
    const root = project();
    writeProjection(root, [record(7, "high")]);

    const result = executeStateWrite(updateRequest(root, 7, "provisionally_satisfied", true));

    expect(result.status).toBe("pass");
    const caveats = compatibilityCaveats(result as Record<string, any>);
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toMatchObject({ number: 7, label: "high" });
  });

  it("amend (non-confidence field) over an inherited legacy 'high' base succeeds and reports the caveat", () => {
    const root = project();
    writeProjection(root, [record(11, "high")]);

    const result = executeStateWrite(amendRequest(root, 11, { choice: "amended choice" }, true));

    expect(result.status).toBe("pass");
    const amendment = (result as Record<string, any>).amendment as Record<string, any>;
    expect(amendment.effective.confidence).toBe("high");
    expect(amendment.provenance.amended_fields).toEqual(["choice"]);
    const caveats = compatibilityCaveats(result as Record<string, any>);
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toMatchObject({ number: 11, label: "high", source: "active" });
  });
});

/* ============================================================ *
 * Prevalidation rejection: tolerance is confidence-only under
 * explicit authority. A non-confidence schema violation still
 * blocks append and update.
 * ============================================================ */
describe("prevalidation blocks non-confidence schema violations (tolerance is confidence-only)", () => {
  it("append is blocked when an existing record carries a missing required field", () => {
    const root = project();
    // A legacy record missing the required `choice` field is NOT a tolerated
    // confidence label; the whole-artifact prevalidation gate must still block.
    const broken = record(1, "high");
    delete broken.choice;
    writeProjection(root, [broken]);

    expect(() => executeStateWrite(appendRequest(root, 2, "firm", true))).toThrow(
      /existing artifact .* is schema-invalid/,
    );
    // No projection bytes were modified.
    expect(readProjection(root).decisions).toHaveLength(1);
  });

  it("satisfaction update is blocked when an existing record carries a missing required field", () => {
    const root = project();
    const broken = record(4, "high");
    delete broken.question;
    writeProjection(root, [broken]);

    expect(() => executeStateWrite(updateRequest(root, 4, "open", true))).toThrow(
      /existing artifact .* is schema-invalid/,
    );
  });
});

/* ============================================================ *
 * Criterion 2 + target validation: unsupported confidence on
 * new/amended content fails before side effects.
 * ============================================================ */
describe("target validation rejects unsupported confidence on new/amended content", () => {
  it("append with a new legacy 'high' confidence is rejected before any file is written", () => {
    const root = project();
    writeProjection(root, [record(1, "firm")]);

    // Programmatic caller bypasses CLI parse-time validation, so the candidate
    // gate (touched = new record's number) must reject the new content.
    expect(() => executeStateWrite(appendRequest(root, 2, "high", false))).toThrow(
      /invalid value 'high' for 'decisions\[1\]\.confidence'/,
    );
    // No numbered archive for the rejected new record, projection unchanged.
    expect(readProjection(root).decisions).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".agentera", "archive", "decisions", "2.yaml"))).toBe(false);
  });

  it("append --confidence high is rejected at parse time before side effects (CLI path)", () => {
    const root = project();
    writeProjection(root, [record(1, "firm")]);
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");

    const result = runCli(root, [
      "decisions",
      "append",
      "--question",
      "New high?",
      "--context",
      "ctx",
      "--alternative-chosen",
      "a",
      "--choice",
      "a",
      "--reasoning",
      "r",
      "--confidence",
      "high",
      "--format",
      "json",
    ]);

    expect(result.rc).toBe(2);
    expect(result.json?.error.class).toBe("invalid_choice");
    expect(result.json?.error.valid_values).toEqual(["firm", "provisional", "exploratory"]);
    expect(readProjection(root).decisions).toHaveLength(1);
  });

  it("amend with a new legacy 'high' confidence is rejected before any side effect", () => {
    const root = project();
    writeProjection(root, [record(9, "high")]);

    expect(() => executeStateWrite(amendRequest(root, 9, { confidence: "high" }, true))).toThrow(
      /requires current vocabulary/,
    );
    expect(fs.existsSync(path.join(root, ".agentera", "revisions", "decisions.yaml"))).toBe(false);
  });
});

/* ============================================================ *
 * Criterion 3: no implicit normalization. Appending current-vocabulary
 * content preserves the untouched inherited legacy label byte- and
 * value-semantically.
 * ============================================================ */
describe("append preserves untouched inherited legacy labels without coercion", () => {
  it("publishes a new firm record alongside an unchanged legacy 'high' record", () => {
    const root = project();
    const before = writeProjection(root, [record(1, "high")]);

    const result = executeStateWrite(appendRequest(root, 2, "firm", false));

    expect(result.status).toBe("pass");
    const doc = readProjection(root);
    const decisions = doc.decisions as Record<string, unknown>[];
    expect(decisions).toHaveLength(2);
    // The untouched inherited legacy record is byte- and value-stable.
    expect(decisions[0]).toMatchObject({ number: 1, confidence: "high" });
    // The new record carries the current vocabulary.
    expect(decisions[1]).toMatchObject({ number: 2, confidence: "firm" });
    // The legacy record's slice is preserved verbatim in the published bytes.
    const after = fs.readFileSync(projectionPath(root), "utf8");
    expect(after).toContain("confidence: high");
    expect(after).toContain("confidence: firm");
    expect(before).not.toContain("confidence: firm");
  });
});

/* ============================================================ *
 * Criterion 4: current-valid artifacts preserve established append
 * behavior, compaction tolerance, and machine-readable caveats.
 * ============================================================ */
describe("compaction preserves untouched inherited legacy confidence without coercion", () => {
  it("does not throw on an artifact whose only violations are legacy confidence labels", () => {
    const root = project();
    writeProjection(root, [record(1, "high"), record(2, "firm")]);

    // Standalone compaction gate tolerates the legacy label (no throw, no
    // coercion); the active full-detail record keeps its 'high' value.
    const result = compactYamlFile(projectionPath(root), "decisions", root);
    expect(result.changed).toBe(false);
    const decisions = (readProjection(root).decisions as Record<string, unknown>[]);
    expect(decisions[0]).toMatchObject({ number: 1, confidence: "high" });
    expect(decisions[1]).toMatchObject({ number: 2, confidence: "firm" });
  });

  it("writer compaction keeps a legacy 'high' full-detail record byte-stable alongside new content", () => {
    const root = project();
    // Eleven confirmed legacy 'high' records: appending a twelfth (firm) trips
    // the 10/40/50 full-detail threshold and runs compaction. Without numbered
    // archives to verify the overflow entries, the gate retains them as
    // full-detail — the legacy labels survive unchanged in the active tier.
    writeProjection(
      root,
      Array.from({ length: 11 }, (_, i) => confirmed(i + 1, "high")),
    );

    const result = executeStateWrite(appendRequest(root, 12, "firm", false));

    expect(result.status).toBe("pass");
    const doc = readProjection(root);
    const active = doc.decisions as Record<string, unknown>[];
    // Every legacy record survived with its 'high' value — no coercion.
    for (const entry of active) {
      if (Number(entry.number) !== 12) {
        expect(entry.confidence).toBe("high");
      }
    }
    // The new current-vocabulary record is present and not coerced.
    expect(active.some((e) => Number(e.number) === 12 && e.confidence === "firm")).toBe(true);
    // Caveats truthfully report the surviving untouched legacy labels.
    const caveats = compatibilityCaveats(result as Record<string, any>);
    expect(caveats.length).toBeGreaterThan(0);
    expect(caveats.every((c) => c.label === "high")).toBe(true);
  });
});

/* ============================================================ *
 * Criterion 4 + 5: current-valid artifacts preserve archive
 * ordering, overlay separation, and established read composition.
 * ============================================================ */
describe("read composition preserves untouched inherited legacy confidence", () => {
  it("composes revisions over a legacy 'high' base without coercing the untouched label", () => {
    const root = project();
    const base = record(3, "high");
    const contract = decisionRevisionContract(sourceRoot);

    const composed = composeDecisionRevision(base, [], { contract });
    expect(composed.record.confidence).toBe("high");
    expect(composed.applied).toBe(false);

    const amended = composeDecisionRevision(
      base,
      [{ date: "2026-07-16", provenance: "historical_revision", base_sha256: "", choice: "x" }],
      { contract },
    );
    // Amending a non-confidence field leaves the untouched legacy label intact.
    expect(amended.record.confidence).toBe("high");
    expect(amended.record.choice).toBe("x");
    expect(amended.fields).toEqual(["choice"]);
  });

  it("retrieveStateEntry returns an untouched inherited legacy label unchanged from a verified archive base", () => {
    const root = project();
    // A verified numbered archive (current vocabulary) plus a projection copy
    // carrying an untouched legacy label: the read composes the verified base.
    const baseRecord = record(5, "firm");
    archive(root, 5, baseRecord);
    writeProjection(root, [{ ...record(5, "high") }]);

    const entry = retrieveStateEntry(root, "decisions", 5, { sourceRoot }).entry;

    // The verified archive record carries the current vocabulary; the legacy
    // projection label was never coerced and the read did not normalize it.
    expect(entry.record.confidence).toBe("firm");
    expect(entry.detail_availability).toBe("full");
    expect(entry.compatibility).toBe("complete");
  });
});

/* ============================================================ *
 * Criterion 4: archive ordering holds for current-valid artifacts
 * with legacy labels present (no normalization reorders bytes).
 * ============================================================ */
describe("archive ordering and overlay separation hold alongside legacy labels", () => {
  it("appends to a legacy artifact with archive entries preserving ascending order", () => {
    const root = project();
    const withArchive = {
      ...record(1, "high"),
    };
    const doc = {
      decisions: [withArchive],
      archive: [
        { summary: "Decision 0 (2026-07-01): older legacy", number: 0 },
      ],
    };
    const projectionPath = path.join(root, ".agentera", "decisions.yaml");
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(projectionPath, dumpYamlMapping(doc), "utf8");

    const result = executeStateWrite(appendRequest(root, 2, "firm", false));

    expect(result.status).toBe("pass");
    const after = readProjection(root);
    const archive = after.archive as Record<string, unknown>[];
    const decisions = after.decisions as Record<string, unknown>[];
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({ number: 2, confidence: "firm" });
    // Archive entry is preserved unchanged (overlay/archive separation).
    expect(archive).toHaveLength(1);
    expect(archive[0]).toMatchObject({ number: 0 });
  });
});

/* ============================================================ *
 * Focused unit coverage for the partition helper itself.
 * ============================================================ */
describe("partitionDecisionViolations", () => {
  const coexistence = legacyLabelCoexistence(sourceRoot);

  it("tolerates an untouched legacy confidence violation and reports the caveat", () => {
    const doc = { decisions: [record(1, "high")] };
    const violations = [
      "decisions: invalid value 'high' for 'decisions[0].confidence' (expected one of: firm, provisional, exploratory)",
    ];
    const partition = partitionDecisionViolations(violations, doc, coexistence, new Set());
    expect(partition.blocking).toEqual([]);
    expect(partition.legacy_caveats).toHaveLength(1);
    expect(partition.legacy_caveats[0]).toMatchObject({ number: 1, label: "high", source: "active" });
  });

  it("keeps a touched (new/amended) confidence violation blocking", () => {
    const doc = { decisions: [record(2, "high")] };
    const violations = [
      "decisions: invalid value 'high' for 'decisions[0].confidence' (expected one of: firm, provisional, exploratory)",
    ];
    const partition = partitionDecisionViolations(violations, doc, coexistence, new Set([2]));
    expect(partition.blocking).toEqual(violations);
    expect(partition.legacy_caveats).toEqual([]);
  });

  it("keeps a non-confidence violation blocking (tolerance is confidence-only)", () => {
    const doc = { decisions: [record(1, "high")] };
    const violations = [
      "decisions: invalid value 'done' for 'decisions[0].satisfaction.state' (expected one of: open, provisionally_satisfied, user_confirmed_satisfied)",
    ];
    const partition = partitionDecisionViolations(violations, doc, coexistence, new Set());
    expect(partition.blocking).toEqual(violations);
    expect(partition.legacy_caveats).toEqual([]);
  });

  it("collectDecisionLegacyCaveats scans active and archive lists", () => {
    const doc = {
      decisions: [record(1, "high"), record(2, "firm")],
      archive: [{ ...record(3, "high"), summary: "Decision 3: legacy" }],
    };
    const caveats = collectDecisionLegacyCaveats(doc, decisionLegacyCoexistence(sourceRoot));
    expect(caveats).toHaveLength(2);
    expect(caveats.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(caveats.find((c) => c.number === 3)?.source).toBe("archive");
    expect(caveats.find((c) => c.number === 1)?.source).toBe("active");
  });
});
