import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  glossaryEntryAuthorityPath,
  validateGlossaryEntry,
  validateGlossaryEntryContract,
  validateGlossaryCapabilityImplementationClaim,
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

const CAPABILITY_FIXTURES = YAML.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/glossary-deferred-capabilities.yaml",
    ),
    "utf8",
  ),
).cases as Array<{
  capability: string;
  valid_declaration: string;
  false_implementation_claim: string;
}>;

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

function malformedAuthority(mutate: (authority: Record<string, any>) => void): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glossary-contract-"));
  const pathname = path.join(directory, "authority.yaml");
  const authority = YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8")) as Record<
    string,
    any
  >;
  mutate(authority);
  fs.writeFileSync(pathname, YAML.stringify(authority), "utf8");
  return pathname;
}

describe("shared glossary entry authority", () => {
  it("derives shared shape, bounded ownership, confidence, and decay rules from existing authorities", () => {
    expect(validateGlossaryEntryContract(glossaryEntryAuthorityPath())).toEqual([]);
  });

  it("rejects a primitive with the shared term removed", () => {
    const pathname = malformedAuthority((authority) => {
      authority.shared_primitive.required_fields =
        authority.shared_primitive.required_fields.filter((field: string) => field !== "term");
      delete authority.shared_primitive.fields.term;
    });
    expect(validateGlossaryEntryContract(pathname)).toEqual(
      expect.arrayContaining([
        "shared_primitive.required_fields must define the canonical entry shape once",
        "shared_primitive.fields.term is required",
      ]),
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("rejects explicit-definition evidence count drift", () => {
    const pathname = malformedAuthority((authority) => {
      authority.provenance_variants.personal_explicit_definition.evidence_count = 2;
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "personal_explicit_definition.evidence_count must be 1",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("rejects removal of the bounded personal-history rule", () => {
    const pathname = malformedAuthority((authority) => {
      delete authority.ownership_contracts.personal.input.bounded_rule;
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "personal input bounded_rule is required",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each([
    [
      "active profile synthesis",
      (authority: Record<string, any>) => {
        authority.deferred_capability_contracts.profile.implementation = "implemented";
      },
      "profile glossary synthesis must remain deferred and derive personal entry policy from shared contracts",
    ],
    [
      "active audit confirmation",
      (authority: Record<string, any>) => {
        authority.deferred_capability_contracts.audit.confirmation.status = "implemented";
      },
      "audit glossary output, confirmation, and separated evidence inputs must remain deferred",
    ],
    [
      "persisted exact-collision precedence",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.exact_collision.persistence = "allowed";
      },
      "exact collisions must defer project precedence to consumption without persistence or suppression",
    ],
    [
      "automatic inferred-equivalence merge",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.inferred_semantic_equivalence.automatic_merge = "allowed";
      },
      "inferred equivalence must defer to user review without merge, suppression, or precedence",
    ],
  ])("rejects %s", (_name, mutate, expected) => {
    const pathname = malformedAuthority(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(expected);
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each(CAPABILITY_FIXTURES)(
    "accepts the deferred $capability declaration",
    ({ capability, valid_declaration }) => {
      expect(
        validateGlossaryCapabilityImplementationClaim(capability, valid_declaration),
      ).toEqual([]);
    },
  );

  it.each(CAPABILITY_FIXTURES)(
    "rejects the false $capability implementation claim",
    ({ capability, false_implementation_claim }) => {
      expect(
        validateGlossaryCapabilityImplementationClaim(
          capability,
          false_implementation_claim,
        ),
      ).toEqual([
        `${capability} glossary behavior is declared_deferred; implemented is a false implementation claim`,
      ]);
    },
  );
});

describe("persisted glossary entry boundary", () => {
  it("admits an entry without deferred consumer fields", () => {
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

  it("rejects every consumer-only persisted field declared by the authority", () => {
    for (const field of ["precedence", "collision", "review"]) {
      const candidate = entry({
        kind: "project_file",
        evidence: [{ source_path: "docs/terms.yaml", source_record_sha256: "a".repeat(64) }],
      });
      candidate[field] = "deferred";
      expect(validateGlossaryEntry(candidate, "project")).toContain(
        `entry contains forbidden persisted fields: ${field}`,
      );
    }
  });

  it("accepts a real ISO calendar date", () => {
    const candidate = entry({
      kind: "project_file",
      evidence: [{ source_path: "docs/terms.yaml", source_record_sha256: "a".repeat(64) }],
    });
    (candidate.temporal as Record<string, unknown>).observed_at = "2024-02-29";
    expect(validateGlossaryEntry(candidate, "project")).toEqual([]);
  });

  it("rejects a date-shaped value that is not a calendar date", () => {
    const candidate = entry({
      kind: "project_file",
      evidence: [{ source_path: "docs/terms.yaml", source_record_sha256: "a".repeat(64) }],
    });
    (candidate.temporal as Record<string, unknown>).observed_at = "2026-99-99";
    expect(validateGlossaryEntry(candidate, "project")).toContain(
      "temporal.observed_at must be an ISO date",
    );
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

  it("admits a Windows-separated project-relative source path", () => {
    expect(
      validateGlossaryEntry(
        entry({
          kind: "project_file",
          evidence: [{ source_path: "docs\\terms.yaml", source_record_sha256: "a".repeat(64) }],
        }),
        "project",
      ),
    ).toEqual([]);
  });

  it("rejects a Windows-absolute project source path on every host platform", () => {
    const errors = validateGlossaryEntry(
      entry({
        kind: "project_file",
        evidence: [{ source_path: "C:\\secret\\terms.yaml", source_record_sha256: "a".repeat(64) }],
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

  it("rejects project-only fields attached to otherwise valid personal evidence", () => {
    const errors = validateGlossaryEntry(
      entry({
        kind: "personal_explicit_definition",
        evidence: [
          {
            source_id: "record-explicit",
            evidence_anchor: "anchor-explicit",
            signal_type: "correction",
            source_path: "docs/terms.yaml",
            source_record_sha256: "a".repeat(64),
          },
        ],
      }),
      "personal",
      retainedHistory,
    );
    expect(errors).toContain(
      "provenance.evidence[0] contains fields forbidden for personal_explicit_definition: source_path, source_record_sha256",
    );
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
