import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { retrieveStateEntry, StateRetrievalFailure } from "../../src/state/directRetrieval.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];
const artifacts = ["progress", "decisions", "health"] as const;
type Artifact = (typeof artifacts)[number];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-direct-get-"));
  roots.push(root);
  return root;
}

function record(artifact: Artifact, number: number): Record<string, unknown> {
  if (artifact === "progress") {
    return {
      number,
      timestamp: "2026-07-13 15:00",
      type: "test",
      phase: "build",
      what: `Cycle ${number}`,
      context: { intent: "Exercise direct stable-ID retrieval" },
    };
  }
  if (artifact === "decisions") {
    return {
      number,
      date: "2026-07-13",
      question: `Question ${number}`,
      context: "Direct retrieval needs immutable decision context.",
      alternatives: [{ name: "Project state", status: "chosen" }],
      choice: "Project state",
      reasoning: "It preserves local provenance.",
      confidence: "firm",
      satisfaction: { state: "open" },
    };
  }
  return {
    number,
    date: "2026-07-13",
    dimensions: ["retrieval"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { retrieval: "A" },
  };
}

function projectionPath(root: string, artifact: Artifact): string {
  return path.join(root, ".agentera", `${artifact}.yaml`);
}

function writeProjection(root: string, artifact: Artifact, entries: Array<Record<string, unknown>>, archive: unknown[] = []): void {
  fs.mkdirSync(path.dirname(projectionPath(root, artifact)), { recursive: true });
  const collection = artifact === "progress" ? "cycles" : artifact === "decisions" ? "decisions" : "audits";
  fs.writeFileSync(projectionPath(root, artifact), YAML.stringify({ [collection]: entries, archive }));
}

function archive(root: string, artifact: Artifact, number: number): void {
  publishNumberedArchive(root, artifact, number, record(artifact, number), { sourceRoot });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.each(artifacts)("read-only migration fixture retrieval: %s", (artifact) => {
  it("returns an active full record with complete provenance", () => {
    const root = project();
    const current = record(artifact, 1);
    archive(root, artifact, 1);
    writeProjection(root, artifact, [current]);

    const result = retrieveStateEntry(root, artifact, 1, { sourceRoot });

    expect(result.entry).toMatchObject({
      stable_id: `${artifact}:1`,
      artifact_id: artifact,
      entry_number: 1,
      source: "archive",
      detail_availability: "full",
      compatibility: "complete",
    });
    expect(result.entry.record).toMatchObject(current);
    expect(result.entry.provenance).toMatchObject({
      archive: { available: true, verified: true },
      current_projection: { present: true, representation: "full" },
    });
  });

  it("returns an archive-only record without reading unrelated archive files", () => {
    const root = project();
    archive(root, artifact, 1);
    const unrelated = path.join(root, ".agentera", "archive", artifact, "999.yaml");
    fs.writeFileSync(unrelated, "not: a valid archive envelope: [\n");

    const result = retrieveStateEntry(root, artifact, 1, { sourceRoot });

    expect(result.entry.source).toBe("archive");
    expect(result.entry.provenance).toMatchObject({
      archive: { available: true, verified: true },
      current_projection: { present: false, representation: "missing" },
    });
  });

  it("returns a full legacy projection with degraded compatibility when no archive exists", () => {
    const root = project();
    const current = record(artifact, 1);
    writeProjection(root, artifact, [current]);

    const result = retrieveStateEntry(root, artifact, 1, { sourceRoot });

    expect(result.entry).toMatchObject({
      source: "legacy_full",
      detail_availability: "full",
      compatibility: "degraded",
      provenance: {
        archive: { available: false, verified: false },
        current_projection: { present: true, representation: "full" },
      },
    });
    expect(result.entry.record).toMatchObject(current);
  });

  it("retrieves a leading Dnn shorthand as a degraded summary without inferring fields", () => {
    if (artifact !== "decisions") return;
    const root = project();
    const summary = "D76 (feeds into D75 and D77): explicit routing shorthand";
    writeProjection(root, artifact, [], [{ summary }]);

    const result = retrieveStateEntry(root, artifact, 76, { sourceRoot });

    expect(result.entry).toMatchObject({
      stable_id: "decisions:76",
      entry_number: 76,
      source: "legacy_summary",
      detail_availability: "summary",
      compatibility: "degraded",
      record: { summary },
      provenance: {
        archive: { available: false, verified: false },
        current_projection: { representation: "summary" },
      },
    });
  });

  it("rejects unnumbered summaries and incidental Dnn references without ghost identities", () => {
    if (artifact !== "decisions") return;
    const root = project();
    writeProjection(root, artifact, [], ["Staging D3+D4 feeds D75 and D77"]);

    for (const number of [3, 4, 75, 77]) {
      try {
        retrieveStateEntry(root, artifact, number, { sourceRoot });
      } catch (caught) {
        expect((caught as StateRetrievalFailure).body.error.class).toBe("not_found");
        continue;
      }
      throw new Error(`expected no ghost decisions:${number}`);
    }
  });

  it("rejects duplicate current identities instead of selecting one for get", () => {
    const root = project();
    const current = record(artifact, 1);
    writeProjection(root, artifact, [current, structuredClone(current)]);

    expect(() => retrieveStateEntry(root, artifact, 1, { sourceRoot })).toThrowError(/duplicate identity/);
    try {
      retrieveStateEntry(root, artifact, 1, { sourceRoot });
    } catch (caught) {
      expect((caught as StateRetrievalFailure).body.error.class).toBe("ambiguous");
    }
  });

  it("rejects conflicting archive and current content without changing the stable-ID selector", () => {
    const root = project();
    const current = record(artifact, 1);
    archive(root, artifact, 1);
    if (artifact === "progress") current.what = "conflicting current record";
    else if (artifact === "decisions") current.question = "conflicting current record";
    else current.trajectory = "conflicting current record";
    writeProjection(root, artifact, [current]);

    try {
      retrieveStateEntry(root, artifact, 1, { sourceRoot });
    } catch (caught) {
      const failure = caught as StateRetrievalFailure;
      expect(failure.body.error).toMatchObject({
        class: "immutable_conflict",
        stable_id: `${artifact}:1`,
      });
      return;
    }
    throw new Error("expected immutable conflict");
  });

  it("returns the current overlay only where the authority permits it", () => {
    const root = project();
    archive(root, artifact, 1);
    if (artifact === "decisions") {
      const overlay = path.join(root, ".agentera", "overlays", "decisions.yaml");
      fs.mkdirSync(path.dirname(overlay), { recursive: true });
      fs.writeFileSync(
        overlay,
        YAML.stringify({
          "decisions:1": {
            satisfaction: {
              state: "provisionally_satisfied",
              evidence: "retrieval fixture",
            },
          },
        }),
      );
    }

    const result = retrieveStateEntry(root, artifact, 1, { sourceRoot });
    if (artifact === "decisions") {
      expect(result.entry.record.satisfaction).toMatchObject({
        state: "provisionally_satisfied",
        evidence: "retrieval fixture",
        review_needed: true,
      });
      expect(result.entry.provenance).toMatchObject({
        overlay: { applied: true, fields: ["satisfaction.state", "satisfaction.evidence"] },
      });
    } else {
      expect(result.entry.provenance).not.toHaveProperty("overlay");
    }
  });

  it("preserves an absent decision outcome and reports incomplete context metadata", () => {
    if (artifact !== "decisions") return;
    const root = project();
    archive(root, artifact, 1);

    const result = retrieveStateEntry(root, artifact, 1, { sourceRoot });
    const retrieved = result.entry.record;

    expect(retrieved).not.toHaveProperty("outcome");
    expect(retrieved.missing_fields).toContain("outcome");
    expect(retrieved.context_complete).toBe(false);
    expect(retrieved.caveats).toEqual(expect.arrayContaining(["Decision entry is missing one or more full-detail context fields."]));
  });

  it("reports absent IDs as operational not_found diagnostics", () => {
    const root = project();
    const error = expect(() => retrieveStateEntry(root, artifact, 1, { sourceRoot })).toThrow(StateRetrievalFailure);
    void error;
    try {
      retrieveStateEntry(root, artifact, 1, { sourceRoot });
    } catch (caught) {
      expect(caught).toMatchObject({
        exitCode: 1,
        body: {
          schemaVersion: "agentera.stateFailure.v1",
          status: "fail",
          error: {
            class: "not_found",
            syntax: `agentera state ${artifact} get --number N`,
            example: `agentera state ${artifact} get --number 1`,
          },
        },
      });
    }
  });

  it("does not promote a legacy summary to a complete record", () => {
    const root = project();
    fs.mkdirSync(path.dirname(projectionPath(root, artifact)), { recursive: true });
    const collection = artifact === "progress" ? "cycles" : artifact === "decisions" ? "decisions" : "audits";
    fs.writeFileSync(
      projectionPath(root, artifact),
      YAML.stringify({
        [collection]: [],
        archive: [`${artifact === "progress" ? "Cycle" : artifact === "decisions" ? "Decision" : "Audit"} 1 (2026-07-13): summary only`],
      }),
    );

    const failure = (() => {
      try {
        retrieveStateEntry(root, artifact, 1, { sourceRoot });
      } catch (caught) {
        return caught as StateRetrievalFailure;
      }
      throw new Error("expected retrieval failure");
    })();
    expect(failure.body.error).toMatchObject({
      class: "incomplete",
      stable_id: `${artifact}:1`,
      details: { current_representation: "summary" },
    });
  });

  it("reports malformed current state as bounded corrupt diagnostics", () => {
    const root = project();
    fs.mkdirSync(path.dirname(projectionPath(root, artifact)), { recursive: true });
    fs.writeFileSync(projectionPath(root, artifact), "this: [is: malformed\n");

    expect(() => retrieveStateEntry(root, artifact, 1, { sourceRoot })).toThrowError(/cannot parse current/);
    const failure = (() => {
      try {
        retrieveStateEntry(root, artifact, 1, { sourceRoot });
      } catch (caught) {
        return caught as StateRetrievalFailure;
      }
      throw new Error("expected retrieval failure");
    })();
    expect(failure.body.error).toMatchObject({
      class: "corrupt",
      recovery: expect.any(String),
      details: { path: projectionPath(root, artifact) },
    });
  });

  it("reports corrupt requested archive bytes without downgrading them", () => {
    const root = project();
    archive(root, artifact, 1);
    const archivePath = path.join(root, ".agentera", "archive", artifact, "1.yaml");
    const corrupted = YAML.parse(fs.readFileSync(archivePath, "utf8")) as Record<string, any>;
    corrupted.record.corrupted = true;
    fs.writeFileSync(archivePath, YAML.stringify(corrupted));

    const failure = (() => {
      try {
        retrieveStateEntry(root, artifact, 1, { sourceRoot });
      } catch (caught) {
        return caught as StateRetrievalFailure;
      }
      throw new Error("expected retrieval failure");
    })();
    expect(failure.body.error).toMatchObject({
      class: "corrupt",
      stable_id: `${artifact}:1`,
      details: { archive_path: archivePath, rejection: "hash_mismatch" },
    });
  });

  it("reports an unsupported archive schema separately from corruption", () => {
    const root = project();
    archive(root, artifact, 1);
    const archivePath = path.join(root, ".agentera", "archive", artifact, "1.yaml");
    const unsupported = YAML.parse(fs.readFileSync(archivePath, "utf8")) as Record<string, any>;
    unsupported.schemaVersion = "agentera.stateArchiveEntry.v2";
    fs.writeFileSync(archivePath, YAML.stringify(unsupported));

    const failure = (() => {
      try {
        retrieveStateEntry(root, artifact, 1, { sourceRoot });
      } catch (caught) {
        return caught as StateRetrievalFailure;
      }
      throw new Error("expected retrieval failure");
    })();
    expect(failure.body.error).toMatchObject({
      class: "unsupported_state",
      stable_id: `${artifact}:1`,
      details: { archive_path: archivePath, rejection: "invalid_envelope" },
    });
  });
});
