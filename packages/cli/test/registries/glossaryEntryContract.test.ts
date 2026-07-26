import { describe, expect, it } from "vitest";

import {
  glossaryEntryAuthorityPath,
  validateGlossaryEntry,
  validateGlossaryEntryContract,
  type GlossaryAdmissionContext,
} from "../../src/registries/glossaryEntryContract.js";

const retainedHistory: GlossaryAdmissionContext = {
  retainedHistory: new Map([
    [
      "anchor-explicit",
      { sourceId: "record-explicit", sourceKind: "conversation_turn", signalType: "correction" },
    ],
    [
      "anchor-instruction",
      {
        sourceId: "record-instruction",
        sourceKind: "instruction_document",
        signalType: "instruction",
      },
    ],
    [
      "anchor-config",
      {
        sourceId: "record-config",
        sourceKind: "project_config_signal",
        signalType: "configuration",
      },
    ],
  ]),
};

function entry(provenance: Record<string, unknown>): Record<string, unknown> {
  return {
    term: "ship shape",
    meaning: "The complete form of a deliverable.",
    confidence: 78,
    permanence: "durable",
    temporal: { observed_at: "2026-07-01", last_confirmed_at: "2026-07-26" },
    provenance,
  };
}

describe("shared glossary entry authority", () => {
  it("derives shared shape, bounded ownership, confidence, and decay rules from existing authorities", () => {
    expect(validateGlossaryEntryContract(glossaryEntryAuthorityPath())).toEqual([]);
  });
});

describe("personal explicit-definition provenance", () => {
  it("admits one allowed retained record and exposes its anchor", () => {
    const candidate = entry({
      kind: "personal_explicit_definition",
      evidence: [
        {
          source_id: "record-explicit",
          evidence_anchor: "anchor-explicit",
          signal_type: "correction",
        },
      ],
    });
    expect(validateGlossaryEntry(candidate, "personal", retainedHistory)).toEqual([]);
    expect(candidate.provenance).toMatchObject({
      evidence: [{ evidence_anchor: "anchor-explicit" }],
    });
  });

  it("rejects an explicit definition whose anchor does not resolve to its claimed record", () => {
    const errors = validateGlossaryEntry(
      entry({
        kind: "personal_explicit_definition",
        evidence: [
          {
            source_id: "different-record",
            evidence_anchor: "anchor-explicit",
            signal_type: "correction",
          },
        ],
      }),
      "personal",
      retainedHistory,
    );
    expect(errors).toContain(
      "provenance.evidence[0].evidence_anchor must resolve to its retained source_id",
    );
  });
});

describe("personal inferred-usage provenance", () => {
  it("admits two independent retained records and exposes both anchors", () => {
    const candidate = entry({
      kind: "personal_inferred_usage",
      evidence: [
        {
          source_id: "record-instruction",
          evidence_anchor: "anchor-instruction",
          source_kind: "instruction_document",
        },
        {
          source_id: "record-config",
          evidence_anchor: "anchor-config",
          source_kind: "project_config_signal",
        },
      ],
    });
    expect(validateGlossaryEntry(candidate, "personal", retainedHistory)).toEqual([]);
    expect((candidate.provenance as { evidence: unknown[] }).evidence).toHaveLength(2);
  });

  it("rejects duplicate anchors even when two evidence rows are supplied", () => {
    const errors = validateGlossaryEntry(
      entry({
        kind: "personal_inferred_usage",
        evidence: [
          {
            source_id: "record-instruction",
            evidence_anchor: "anchor-instruction",
            source_kind: "instruction_document",
          },
          {
            source_id: "record-instruction",
            evidence_anchor: "anchor-instruction",
            source_kind: "instruction_document",
          },
        ],
      }),
      "personal",
      retainedHistory,
    );
    expect(errors).toContain(
      "inferred personal usage requires two distinct retained identities and anchors",
    );
  });
});

describe("project-file provenance", () => {
  it("admits one project-relative source record bound by digest", () => {
    expect(
      validateGlossaryEntry(
        entry({
          kind: "project_file",
          evidence: [{ source_path: "docs/terms.yaml", source_record_sha256: "a".repeat(64) }],
        }),
        "project",
      ),
    ).toEqual([]);
  });

  it("rejects a repository source path that escapes the project", () => {
    const errors = validateGlossaryEntry(
      entry({
        kind: "project_file",
        evidence: [{ source_path: "../terms.yaml", source_record_sha256: "a".repeat(64) }],
      }),
      "project",
    );
    expect(errors).toContain("project source_path must be safe and project-relative");
  });
});

describe("ownership and shared semantics", () => {
  it("excludes project records from personal admission", () => {
    const errors = validateGlossaryEntry(
      entry({
        kind: "project_file",
        evidence: [{ source_path: "terms.yaml", source_record_sha256: "a".repeat(64) }],
      }),
      "personal",
      retainedHistory,
    );
    expect(errors).toContain("personal entries admit only bounded personal-history provenance");
  });

  it("keeps permanence independent while confidence remains an integer", () => {
    const candidate = entry({
      kind: "personal_explicit_definition",
      evidence: [
        {
          source_id: "record-explicit",
          evidence_anchor: "anchor-explicit",
          signal_type: "correction",
        },
      ],
    });
    candidate.confidence = 42;
    candidate.permanence = "stable";
    expect(validateGlossaryEntry(candidate, "personal", retainedHistory)).toEqual([]);
    candidate.confidence = 42.5;
    expect(validateGlossaryEntry(candidate, "personal", retainedHistory)).toContain(
      "confidence must be an integer from protocol CS1-CS5",
    );
    expect(candidate.permanence).toBe("stable");
  });
});
