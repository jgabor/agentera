import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import {
  buildPublishedRevisionRecord,
  decisionRevisionContract,
  decisionRevisionPath,
  findConflictingRevision,
  findPublishedRevision,
  loadDecisionRevision,
  prepareDecisionAmendment,
  projectRevisionOverride,
  publishDecisionAmendment,
} from "../../src/state/decisionRevision.js";
import { retrieveStateEntry } from "../../src/state/directRetrieval.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { operationSpec } from "../../src/state/write/operations.js";
import { InjectedMutationFailure, withStateMutation } from "../../src/state/write/mutation.js";
import { executeStateWrite, type StateWriteRequest } from "../../src/state/write/transaction.js";
import { StateWriteInputError } from "../../src/state/write/errors.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-amend-publication-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function baseRecord(number: number, confidence = "firm"): Record<string, unknown> {
  return {
    number,
    date: "2026-07-16",
    question: `Question for decision ${number}?`,
    context: "Effective reads compose base→revisions→overlay.",
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

function archive(root: string, number: number, record = baseRecord(number)): string {
  return publishNumberedArchive(root, "decisions", number, record, { sourceRoot }).path;
}

function writeProjection(root: string, entries: unknown[]): void {
  const projectionPath = path.join(root, ".agentera", "decisions.yaml");
  fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
  fs.writeFileSync(projectionPath, dumpYamlMapping({ decisions: entries }), "utf8");
}

function revisionPath(root: string): string {
  return decisionRevisionPath(root, sourceRoot);
}

function writeRevisionDocument(root: string, document: Record<string, unknown>): string {
  const target = revisionPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, dumpYamlMapping(document), "utf8");
  return target;
}

function writeRevisionBytes(root: string, bytes: string): string {
  const target = revisionPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, "utf8");
  return bytes;
}

function amendRequest(
  root: string,
  number: number,
  fields: Record<string, unknown>,
  dryRun = false,
): StateWriteRequest {
  const spec = operationSpec("decisions", "amend");
  if (!spec) throw new Error("decisions amend operation is unavailable");
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

function effective(root: string, number: number) {
  const result = retrieveStateEntry(root, "decisions", number, { sourceRoot });
  return result.entry;
}

/* ============================================================ *
 * Criterion 1: dry-run reports effects without writing any file.
 * ============================================================ */
describe("amendment dry-run projects effects without side effects", () => {
  it("reports the exact revision, effective record, and projection effect and writes nothing", () => {
    const root = project();
    archive(root, 7, baseRecord(7));
    const beforeProjection = fs.existsSync(path.join(root, ".agentera", "decisions.yaml"))
      ? fs.readFileSync(path.join(root, ".agentera", "decisions.yaml"))
      : Buffer.alloc(0);

    const result = executeStateWrite(
      amendRequest(root, 7, { choice: "Revised choice", reasoning: "Revised reasoning", confidence: "firm" }, true),
    );

    expect(result.status).toBe("pass");
    expect(result.operation).toMatchObject({ verb: "amend", dry_run: true, idempotent_replay: false });
    const amendment = (result as Record<string, unknown>).amendment as Record<string, any>;
    expect(amendment.published).toBe(false);
    expect(amendment.effective.choice).toBe("Revised choice");
    expect(amendment.effective.reasoning).toBe("Revised reasoning");
    expect(amendment.effective.question).toBe("Question for decision 7?");
    expect(amendment.projection_effect.rewritten).toBe(false);
    // The projection representation reflects the prepared base's projection
    // state (full when a numbered archive carries the complete record), never
    // rewritten by an amendment.
    expect(["full", "summary", "missing", "absent"]).toContain(amendment.projection_effect.representation);
    expect(amendment.revision.base_sha256).toHaveLength(64);
    expect(amendment.revision.provenance).toBe("historical_revision");
    expect(amendment.revision.choice).toBe("Revised choice");
    // The revision carries only the amended content paths the caller supplied.
    expect(Object.keys(amendment.revision).sort()).toEqual(
      ["base_sha256", "choice", "confidence", "date", "provenance", "reasoning"].sort(),
    );
    // No file changed.
    expect(fs.existsSync(revisionPath(root))).toBe(false);
    expect(
      fs.existsSync(path.join(root, ".agentera", "decisions.yaml"))
        ? fs.readFileSync(path.join(root, ".agentera", "decisions.yaml"))
        : Buffer.alloc(0),
    ).toEqual(beforeProjection);
  });
});

/* ============================================================ *
 * Criterion 2: apply yields immutable evidence, effective detail, and an
 * agreeing projection representation.
 * ============================================================ */
describe("amendment apply yields agreeing evidence, effective detail, and projection", () => {
  it("publishes immutable revision evidence and the composed read agrees with the full projection", () => {
    const root = project();
    archive(root, 7, baseRecord(7));

    const result = executeStateWrite(
      amendRequest(root, 7, { choice: "Revised choice", reasoning: "Revised reasoning", confidence: "firm" }),
    );

    expect(result.status).toBe("pass");
    expect(result.operation).toMatchObject({ idempotent_replay: false });
    const amendment = (result as Record<string, unknown>).amendment as Record<string, any>;
    expect(amendment.published).toBe(true);

    // Immutable revision evidence is recorded in the revision document.
    const document = loadDecisionRevision(root, sourceRoot);
    const revisions = document["decisions:7"];
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      provenance: "historical_revision",
      choice: "Revised choice",
      reasoning: "Revised reasoning",
      confidence: "firm",
    });
    expect(revisions[0].base_sha256).toHaveLength(64);

    // Re-reading composes base→revision→overlay and agrees with the projection.
    const entry = effective(root, 7);
    expect(entry.record.choice).toBe("Revised choice");
    expect(entry.record.reasoning).toBe("Revised reasoning");
    expect(entry.record.question).toBe("Question for decision 7?");
    expect(entry.detail_availability).toBe("full");
    expect(entry.provenance.revision).toMatchObject({ applied: true, revisions: 1 });
  });

  it("agrees when the projection carries a full legacy record that seeds a degraded base", () => {
    const root = project();
    writeProjection(root, [baseRecord(11, "provisional")]);

    const result = executeStateWrite(
      amendRequest(root, 11, { choice: "Amended for legacy base", confidence: "firm" }),
    );

    expect(result.status).toBe("pass");
    const amendment = (result as Record<string, unknown>).amendment as Record<string, any>;
    expect(amendment.published).toBe(true);
    expect(amendment.provenance.base).toBe("degraded_projection");

    const entry = effective(root, 11);
    // The amended choice composes over the (unchanged) legacy base record.
    expect(entry.record.choice).toBe("Amended for legacy base");
    expect(entry.record.confidence).toBe("firm");
    expect(entry.provenance.revision).toMatchObject({ applied: true, base_provenance: "degraded_projection" });
  });

  it("leaves the decisions projection bytes byte-for-byte unchanged after a successful apply", () => {
    // The design contract is "the decisions projection is never rewritten by
    // an amendment; effective detail composes base→revisions→overlay." A
    // successful apply must touch only the revision document, leaving every
    // byte of `.agentera/decisions.yaml` identical — including any unrelated
    // observer record carried alongside the amended decision.
    const root = project();
    archive(root, 7, baseRecord(7));
    writeProjection(root, [
      baseRecord(7),
      { ...baseRecord(8, "provisional"), reasoning: "unrelated observer record" },
    ]);
    const projectionPath = path.join(root, ".agentera", "decisions.yaml");
    const beforeProjection = fs.readFileSync(projectionPath, "utf8");
    const beforeRevisions = fs.existsSync(revisionPath(root))
      ? fs.readFileSync(revisionPath(root), "utf8")
      : "";

    const result = executeStateWrite(
      amendRequest(root, 7, { choice: "byte-stable apply", confidence: "firm" }),
    );

    expect(result.status).toBe("pass");
    // The decisions projection is byte-for-byte unchanged — not reserialized.
    expect(fs.readFileSync(projectionPath, "utf8")).toBe(beforeProjection);
    // Only the revision document grows with immutable amendment evidence.
    const afterRevisions = fs.readFileSync(revisionPath(root), "utf8");
    expect(afterRevisions.length).toBeGreaterThan(beforeRevisions.length);
    const revisionDoc = loadYamlMapping(afterRevisions);
    expect(revisionDoc["decisions:7"]).toEqual([
      expect.objectContaining({ choice: "byte-stable apply", confidence: "firm" }),
    ]);
    // The unrelated observer record is never referenced by the amendment.
    expect(revisionDoc["decisions:8"]).toBeUndefined();
    // And the amended content never lands in the projection bytes.
    expect(fs.readFileSync(projectionPath, "utf8")).not.toContain("byte-stable apply");
  });
});

/* ============================================================ *
 * Criterion 3: amend one full decision preserves unrelated canonical values
 * and bytes; refuse when a safe target-only change cannot be proven.
 * ============================================================ */
describe("amendment record-local byte preservation across representative shapes", () => {
  it("preserves an unrelated decision's comments, block scalars, quoting, and compacted bytes", () => {
    const root = project();
    const archived1 = archive(root, 1, baseRecord(1));
    const archived2 = archive(root, 2, baseRecord(2, "provisional"));
    void archived1;
    void archived2;

    // A revision document with representative shapes for decision 2: a comment,
    // a block-scalar reasoning, a quoted value, and a compacted flow mapping
    // provenance. Decision 2's base carries a legacy confidence label (untouched).
    writeRevisionBytes(
      root,
      [
        'decisions:2:',
        "  # preserved comment for decision two",
        "  - reasoning: |",
        "      multi-line block scalar",
        "      preserved verbatim",
        '    choice: "quoted choice"',
        "    provenance: historical_revision",
        '    date: "2026-07-02"',
        `    base_sha256: ${sha256(baseRecord(2, "provisional"))}`,
      ].join("\n") + "\n",
    );
    const beforeBytes = fs.readFileSync(revisionPath(root), "utf8");

    // Amend decision 1 (choice only); decision 2 must be byte-for-byte preserved.
    const result = executeStateWrite(amendRequest(root, 1, { choice: "new choice one", confidence: "firm" }));
    expect(result.status).toBe("pass");

    const afterBytes = fs.readFileSync(revisionPath(root), "utf8");
    const afterDoc = loadYamlMapping(afterBytes);
    // Decision 1 received the new revision.
    expect(afterDoc["decisions:1"]).toEqual([
      expect.objectContaining({ choice: "new choice one", base_sha256: expect.any(String) }),
    ]);
    // Decision 2's canonical value is unchanged (unchanged-byte proof).
    expect(canonicalRecordJson(afterDoc["decisions:2"])).toEqual(
      canonicalRecordJson(loadYamlMapping(beforeBytes)["decisions:2"]),
    );
    // ...and the representative shapes (comment, block scalar, quoting) are
    // preserved verbatim within decision 2's slice of the after bytes.
    const twoSlice = extractEntry(afterBytes, "decisions:2");
    expect(twoSlice).toContain("# preserved comment for decision two");
    expect(twoSlice).toContain("multi-line block scalar\n      preserved verbatim");
    expect(twoSlice).toContain('choice: "quoted choice"');
    expect(twoSlice).toContain(`base_sha256: ${sha256(baseRecord(2, "provisional"))}`);
  });

  it("refuses without side effects when the revision document is not a parseable mapping", () => {
    const root = project();
    archive(root, 3, baseRecord(3));
    writeRevisionBytes(root, "- not a mapping\n");

    expect(() =>
      executeStateWrite(amendRequest(root, 3, { choice: "x", confidence: "firm" })),
    ).toThrowError(/broken revision document|safe record-local byte boundary/);
    // The malformed document bytes are preserved.
    expect(fs.readFileSync(revisionPath(root), "utf8")).toBe("- not a mapping\n");
  });
});

/* ============================================================ *
 * Criterion 5: conflict refusals preserve existing bytes and return retry/repair.
 * ============================================================ */
describe("amendment conflict boundaries", () => {
  it("detects a duplicate revision with the same slot but different content and refuses without side effects", () => {
    const root = project();
    archive(root, 8, baseRecord(8));
    // First amendment succeeds.
    const first = executeStateWrite(amendRequest(root, 8, { choice: "first", confidence: "firm" }));
    expect(first.status).toBe("pass");

    // A second amendment on the same day against the same base but different content.
    expect(() =>
      executeStateWrite(amendRequest(root, 8, { choice: "second", confidence: "firm" })),
    ).toThrowError(/ambiguous/);
    const doc = loadDecisionRevision(root, sourceRoot);
    expect(doc["decisions:8"]).toHaveLength(1);
    expect(doc["decisions:8"][0].choice).toBe("first");
  });

  it("refuses to claim success when a degraded_projection base drifted before verify", () => {
    const root = project();
    // Seed a full legacy projection record so the amendment prep bootstraps a
    // degraded base; capture the preparation against its current hash.
    writeProjection(root, [baseRecord(9, "provisional")]);
    const stalePrep = prepareDecisionAmendment(root, 9, { choice: "drifted", confidence: "firm" }, { sourceRoot });
    const originalHash = stalePrep.base.sha256;
    expect(originalHash).toHaveLength(64);

    // Mutate the projection record so a re-read now derives a different hash.
    writeProjection(root, [baseRecord(9, "firm")]);

    // Publishing with the stale preparation publishes the revision evidence
    // first, then the projection-consistency check catches the drift and
    // refuses to claim success (preserving the published revision).
    expect(() =>
      withStateMutation(root, (tx) =>
        publishDecisionAmendment(root, stalePrep, { transaction: tx, dryRun: false, sourceRoot }),
      ),
    ).toThrowError(/projection base changed|stale base|projection changed/);

    // The revision evidence was published before the verify refusal. After
    // reconciling the projection drift (restoring the original base record), a
    // retry idempotently replays the already-published revision without
    // duplicating it.
    writeProjection(root, [baseRecord(9, "provisional")]);
    const retry = executeStateWrite(
      amendRequest(root, 9, { choice: "drifted", confidence: "firm" }),
    );
    expect(retry.operation).toMatchObject({ idempotent_replay: true });
    const doc = loadDecisionRevision(root, sourceRoot);
    expect(doc["decisions:9"]).toHaveLength(1);
    expect(doc["decisions:9"][0]).toMatchObject({ choice: "drifted", confidence: "firm" });
  });

  it("refuses an unsafe target identity where the revision entry is not an ordered list", () => {
    const root = project();
    archive(root, 4, baseRecord(4));
    writeRevisionBytes(root, 'decisions:4: "scalar not a list"\n');
    expect(() =>
      executeStateWrite(amendRequest(root, 4, { choice: "x", confidence: "firm" })),
    ).toThrowError(/broken revision document|safe record-local byte boundary/);
    expect(fs.readFileSync(revisionPath(root), "utf8")).toBe('decisions:4: "scalar not a list"\n');
  });
});

/* ============================================================ *
 * Criterion 4 + 6: every publication boundary has pre-publication,
 * partial-publication, retry, idempotent replay, and conflict assertions.
 * ============================================================ */
describe("amendment publication recovery boundaries", () => {
  const boundaries = ["staged-write", "revision-publication", "directory-sync", "projection-consistency"] as const;

  it.each(boundaries)("converges on retry with stable revision identity after the %s boundary", (boundary) => {
    const root = project();
    archive(root, 5, baseRecord(5));

    const req = amendRequest(root, 5, { choice: "recovered choice", confidence: "firm" });

    // Partial-publication: the boundary throws after its partial work.
    expect(() => executeStateWrite(req, { failAfter: boundary })).toThrowError(
      expect.objectContaining<Partial<InjectedMutationFailure>>({ boundary }),
    );

    // No mixed state: the projection was never rewritten by the amendment.
    expect(fs.existsSync(path.join(root, ".agentera", "decisions.yaml"))).toBe(false);

    const revisionPublishedBeforeRetry = fs.existsSync(revisionPath(root));
    if (revisionPublishedBeforeRetry) {
      // The revision already landed before the boundary; the staged file is gone.
      const doc = loadYamlMapping(fs.readFileSync(revisionPath(root), "utf8"));
      expect((doc["decisions:5"] as unknown[])).toHaveLength(1);
    }

    // Retry converges without duplicates or mixed state.
    const retry = executeStateWrite(req);
    expect(retry.status).toBe("pass");
    const retryAmendment = (retry as Record<string, unknown>).amendment as Record<string, any>;
    // The revision identity is stable: an already-published revision is an idempotent replay.
    expect(retry.operation).toMatchObject({ idempotent_replay: revisionPublishedBeforeRetry });
    expect(retryAmendment.published).toBe(!revisionPublishedBeforeRetry);

    // Final state: exactly one revision, stable identity.
    const doc = loadDecisionRevision(root, sourceRoot);
    expect(doc["decisions:5"]).toHaveLength(1);
    expect(doc["decisions:5"][0]).toMatchObject({ choice: "recovered choice", confidence: "firm" });
    // The composed read reflects the amendment in every case.
    expect(effective(root, 5).record.choice).toBe("recovered choice");
  });

  it("replays idempotently when the exact revision is already published", () => {
    const root = project();
    archive(root, 6, baseRecord(6));

    const first = executeStateWrite(amendRequest(root, 6, { choice: "once", confidence: "firm" }));
    expect(first.operation).toMatchObject({ idempotent_replay: false });
    const publishedRevision = ((first as Record<string, unknown>).amendment as Record<string, any>).revision;
    const docAfter = fs.readFileSync(revisionPath(root), "utf8");

    // Same content -> idempotent replay, no byte change.
    const replay = executeStateWrite(amendRequest(root, 6, { choice: "once", confidence: "firm" }));
    expect(replay.operation).toMatchObject({ idempotent_replay: true });
    expect(fs.readFileSync(revisionPath(root), "utf8")).toBe(docAfter);
    expect(loadDecisionRevision(root, sourceRoot)["decisions:6"]).toHaveLength(1);

    // The published revision identity is stable.
    expect(((replay as Record<string, unknown>).amendment as Record<string, any>).revision).toEqual(publishedRevision);
  });
});

/* ============================================================ *
 * CLI surface: dry-run and apply via the typed writer dispatch.
 * ============================================================ */
describe("amendment CLI dispatch", () => {
  it("applies an amendment through the typed writer and composes on re-read", () => {
    const root = project();
    archive(root, 12, baseRecord(12));

    const dry = runCli(root, [
      "decisions", "amend", "--number", "12", "--choice", "cli amended", "--confidence", "firm", "--dry-run", "--format", "json",
    ]);
    expect(dry.rc).toBe(0);
    expect(dry.json?.operation).toMatchObject({ dry_run: true });
    expect(fs.existsSync(revisionPath(root))).toBe(false);

    const applied = runCli(root, [
      "decisions", "amend", "--number", "12", "--alternative-chosen", "cli amended",
      "--alternative-rejected", "rejected alt", "--choice", "cli amended", "--confidence", "firm", "--format", "json",
    ]);
    expect(applied.rc).toBe(0);
    expect(applied.json?.operation).toMatchObject({ idempotent_replay: false });
    expect(applied.json?.written.choice).toBe("cli amended");
    expect(applied.json?.written.alternatives).toEqual([
      { name: "cli amended", status: "chosen" },
      { name: "rejected alt", status: "rejected" },
    ]);

    const entry = effective(root, 12);
    expect(entry.record.choice).toBe("cli amended");
    expect(entry.record.alternatives).toEqual([
      { name: "cli amended", status: "chosen" },
      { name: "rejected alt", status: "rejected" },
    ]);
  });
});

/* ============================================================ *
 * Direct unit coverage of the projection and identity helpers.
 * ============================================================ */
describe("amendment projection and identity helpers", () => {
  it("projects a record-local override for a fresh document and preserves unrelated entries", () => {
    const root = project();
    const bytes = writeRevisionBytes(
      root,
      [
        'decisions:1:',
        "  - choice: one",
        "    provenance: historical_revision",
        '    date: "2026-07-01"',
        `    base_sha256: ${"a".repeat(64)}`,
        'decisions:2:',
        "  - choice: two",
        "    provenance: historical_revision",
        '    date: "2026-07-02"',
        `    base_sha256: ${"b".repeat(64)}`,
      ].join("\n") + "\n",
    );
    const beforeTwo = extractEntry(bytes, "decisions:2");

    const projection = projectRevisionOverride(
      fs.readFileSync(revisionPath(root), "utf8"),
      "decisions:1",
      [
        { choice: "one-amended", provenance: "historical_revision", date: "2026-07-03", base_sha256: "a".repeat(64) },
        { choice: "one", provenance: "historical_revision", date: "2026-07-01", base_sha256: "a".repeat(64) },
      ],
      decisionRevisionContract(sourceRoot),
    );

    expect(projection.safe).toBe(true);
    if (projection.safe) {
      expect(extractEntry(projection.bytes, "decisions:2")).toBe(beforeTwo);
      // Decision 1's list is replaced wholesale with the amended order.
      expect(extractEntry(projection.bytes, "decisions:1")).toContain("one-amended");
    }
  });

  it("builds a revision record carrying only amended fields plus provenance", () => {
    const root = project();
    archive(root, 13, baseRecord(13));
    const preparation = prepareDecisionAmendment(root, 13, { choice: "x", confidence: "firm" }, { sourceRoot });
    const built = buildPublishedRevisionRecord(preparation, { date: "2026-08-01" });
    expect(built.record.date).toBe("2026-08-01");
    expect(built.record.provenance).toBe("historical_revision");
    expect(built.record.base_sha256).toBe(preparation.base.sha256);
    expect(built.record.choice).toBe("x");
    expect(built.record.confidence).toBe("firm");
    expect(Object.keys(built.record).sort()).toEqual(
      ["base_sha256", "choice", "confidence", "date", "provenance"].sort(),
    );
    expect(built.identity).toHaveLength(64);
    expect(findPublishedRevision(preparation.revisions, built.identity)).toBeNull();
    // Identical revision content -> replay, not conflict.
    expect(findPublishedRevision([{ ...built.record }], built.identity)).not.toBeNull();
    // Same date+base_sha256, different amendable content -> conflict.
    expect(
      findConflictingRevision([{ ...built.record, choice: "y" }], built.record),
    ).toMatchObject({ index: 0, revision: expect.objectContaining({ choice: "y" }) });
    // Same date but different base -> no conflict, just distinct revisions.
    expect(
      findConflictingRevision(
        [{ ...built.record, choice: "y", base_sha256: "b".repeat(64) }],
        built.record,
      ),
    ).toBeNull();
  });

  it("publishes through the function API with a custom date and replays identically", () => {
    const root = project();
    archive(root, 14, baseRecord(14));
    const preparation = prepareDecisionAmendment(root, 14, { choice: "fn", confidence: "firm" }, { sourceRoot });

    const first = publishDecisionAmendment(root, preparation, {
      dryRun: true,
      date: "2026-09-01",
      sourceRoot,
    });
    expect(first.dry_run).toBe(true);
    expect(first.published).toBe(false);
    expect(first.revision.date).toBe("2026-09-01");
    expect(fs.existsSync(revisionPath(root))).toBe(false);

    // A real apply needs a transaction; exercise the function path directly.
    const prep2 = prepareDecisionAmendment(root, 14, { choice: "fn", confidence: "firm" }, { sourceRoot });
    expect(() => publishDecisionAmendment(root, prep2, { dryRun: false, date: "2026-09-01", sourceRoot })).toThrow(
      StateWriteInputError,
    );
  });
});

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalRecordJson(value), "utf8").digest("hex");
}

function extractEntry(bytes: string, stableId: string): string {
  const start = bytes.indexOf(stableId);
  if (start < 0) return "";
  const remainder = bytes.slice(start);
  // Find the next stable-ID marker (`\n<word>:<digits>:`) after our entry's
  // marker line, so the slice stops at the start of the next entry.
  const nextMarkerOffset = remainder.slice(stableId.length).search(/\n[a-z][a-z0-9_-]*:\d+:/);
  return nextMarkerOffset === -1
    ? remainder
    : remainder.slice(0, stableId.length + nextMarkerOffset);
}
