import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import auditInstructions from "../../src/capabilities/audit/instructions.js";
import {
  confirmedVariantGuardContract,
  glossaryConsumerContract,
  glossaryEntryAuthorityPath,
  personalGlossaryOutputContract,
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
  it("derives shared shape, active personal output, bounded ownership, confidence, and decay rules from existing authorities", () => {
    expect(validateGlossaryEntryContract(glossaryEntryAuthorityPath())).toEqual([]);
    const authority = YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8"));
    expect(authority.ownership_contracts.personal.implementation).toMatchObject({
      status: "active_partial",
      active: expect.arrayContaining(["profile_full_rendering", "profile_persistence"]),
      inactive: ["lookup"],
    });
    expect(authority.deferred_capability_contracts.profile).toMatchObject({
      implementation: "active_partial",
      inactive_behavior: ["lookup"],
      forbidden_current_claims: ["lookup", "project_glossary_consumption"],
    });
    expect(personalGlossaryOutputContract()).toEqual({
      command: "agentera report profile-glossary",
      requestSchemaVersion: "agentera.personalGlossaryUpdateRequest.v1",
      sectionSchemaVersion: "agentera.personalGlossarySection.v1",
      outputStatuses: ["changed", "unchanged_replay", "dry_run_candidate"],
    });
  });

  it("keeps audit read-only while build owns confirmed project publication", () => {
    const authority = YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8"));
    const audit = authority.deferred_capability_contracts.audit;
    expect(audit).toMatchObject({
      implementation: "active_partial",
      active_behavior: "terminology_drift_finding_generation",
      finding_family: { status: "implemented", mutation: "forbidden" },
      proposal_output: {
        implementation: "active",
        digest: "ownership_contracts.project.proposal_digest",
      },
    });
    expect(authority.deferred_capability_contracts.build_publication).toMatchObject({
      capabilities: ["build"],
      implementation: "active",
      active_behavior: "ownership_contracts.project.publication",
    });
    expect(authority.ownership_contracts.project).toMatchObject({
      implementation: {
        status: "active",
        active: ["audit_proposal_digest", "build_publication", "confirmed_variant_guard"],
        inactive: ["lookup", "precedence", "semantic_equivalence_review"],
      },
      confirmed_variant_guard: {
        matching: "exact_case_sensitive_boundary_aware_literal",
      },
    });
    expect(confirmedVariantGuardContract().excludedDirectories).toEqual([
      ".agentera",
      ".agentera-generated",
      ".cache",
      ".git",
      ".next",
      ".pnpm",
      ".turbo",
      ".venv",
      ".vite",
      "build",
      "bundle",
      "coverage",
      "dist",
      "node_modules",
      "target",
      "vendor",
    ]);
    expect(
      authority.ownership_contracts.project.publication.persisted_document.terminology_set_identity,
    ).toMatchObject({
      normalization: "lowercase",
      uniqueness: "global_across_complete_document",
    });
  });

  it("aligns authority, Audit validation, and shipped instructions on active publication and deferred consumers", () => {
    const authority = fs.readFileSync(glossaryEntryAuthorityPath(), "utf8");
    const validation = fs.readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../skills/agentera/capabilities/audit/schemas/validation.yaml",
      ),
      "utf8",
    );
    for (const surface of [authority, validation, auditInstructions]) {
      expect(surface).toMatch(
        /Audit remains mutation-free|mutation-free, read-only|mutation-free and read-only/,
      );
      expect(surface).toMatch(/Build project-glossary\s+publication is active/);
      expect(surface).toMatch(/lookup[\s\S]*precedence[\s\S]*semantic-equivalence review/);
      expect(surface).toMatch(
        /profile mutation|personal-profile mutation|personal-profile\s+mutation/,
      );
      expect(surface).toMatch(/docs-mapping\s+mutation/);
      expect(surface).not.toMatch(/project glossary production and persistence.*deferred/i);
    }
  });

  it("loads one active consumer contract while every consumer implementation remains deferred", () => {
    expect(glossaryConsumerContract()).toEqual({
      contractStatus: "active",
      implementation: {
        acquisition: "declared_deferred",
        advice_resolution: "declared_deferred",
        capability_integrations: "declared_deferred",
      },
      outcomes: [
        "invalid_or_unavailable_project",
        "equivalent_exact_collision",
        "divergent_exact_collision",
        "project_only",
        "proven_project_gap",
        "inferred_equivalence",
        "invalid_or_unavailable_personal",
        "no_applicable_entry",
      ],
      refreshRequired: expect.arrayContaining([
        "initial_meaning_sensitive_input",
        "later_user_requirement_change_that_can_change_meaning",
        "later_user_intent_change_that_can_change_meaning",
      ]),
      refreshNotRequired: expect.arrayContaining([
        "unrelated_conversation_turn",
        "background_state_reread",
      ]),
      transientAllowed: ["outcome", "applicable_meaning", "applicable_owner", "review", "tension"],
      durableAllowed: [
        "caveat_id",
        "event",
        "capability",
        "reason",
        "ownership_state",
        "transition_id",
      ],
      caveatOwner: "build",
      caveatChannel: "progress",
      caveatEvents: ["current", "resolved", "superseded"],
      caveatExpiration: "none",
      downstreamGateStatus: "blocked_until_contract_valid",
    });
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
      "deferred profile output",
      (authority: Record<string, any>) => {
        authority.deferred_capability_contracts.profile.inactive_behavior = [
          "rendering",
          "persistence",
          "lookup",
        ];
      },
      "profile glossary rendering and persistence must be active while lookup remains deferred",
    ],
    [
      "mutable audit proposal",
      (authority: Record<string, any>) => {
        authority.deferred_capability_contracts.audit.proposal_output.implementation = "mutable";
      },
      "audit findings and proposal digests must be active and read-only",
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
    [
      "an incomplete consumer outcome matrix",
      (authority: Record<string, any>) => {
        delete authority.consumer_boundary.outcome_matrix.proven_project_gap;
      },
      "consumer_boundary outcome matrix and primary_selection must define all eight ordered collision, gap, review, absence, and invalid-input outcomes",
    ],
    [
      "malformed project state as gap proof",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.project_state.gap_proving_states.push("malformed");
      },
      "consumer_boundary judgments must separate deterministic exact identity and valid gaps from host-reviewed inferred equivalence and invalid project state",
    ],
    [
      "background rereads as governed refresh events",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.refresh_events.required.push("background_state_reread");
      },
      "consumer_boundary.refresh_events must require meaning-sensitive initial and changed intent inputs and exclude unrelated turns and background rereads",
    ],
    [
      "private definitions on durable surfaces",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.disclosure.durable_surfaces.allowed.push("personal_definition");
      },
      "consumer_boundary.disclosure must bound transient advice and exclude definitions, anchors, paths, raw sections, unrelated entries, and provenance from durable output and errors",
    ],
    [
      "Plan as the durable caveat writer",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.durable_owner = "plan";
      },
      "consumer_boundary.autonomous_caveat must use Build-owned progress evidence with an opaque identity, current/resolved/superseded transitions, Plan handoff, and explicit no-expiration",
    ],
    [
      "clock-based caveat expiration",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.lifecycle.expiration = "30_days";
      },
      "consumer_boundary.autonomous_caveat must use Build-owned progress evidence with an opaque identity, current/resolved/superseded transitions, Plan handoff, and explicit no-expiration",
    ],
    [
      "consumer advice as project publication authority",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.publication_isolation.project_publication_authority =
          "consumer_boundary";
      },
      "consumer_boundary.publication_isolation must keep advice and caveat lifecycle separate from Build-owned digest-confirmed publication and approval",
    ],
    [
      "an unblocked contradictory downstream gate",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.downstream_gate.status = "ready";
      },
      "consumer_boundary.downstream_gate must block integration with section-specific validation and an actionable local command",
    ],
  ])("rejects %s", (_name, mutate, expected) => {
    const pathname = malformedAuthority(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(expected);
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("rejects overlapping primary outcome predicates", () => {
    const pathname = malformedAuthority((authority) => {
      authority.consumer_boundary.outcome_matrix.no_applicable_entry.match.inferred_candidate.push(
        "present",
      );
    });
    expect(validateGlossaryEntryContract(pathname)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^consumer_boundary\.primary_selection must be exhaustive and non-overlapping: .*matched \[inferred_equivalence, no_applicable_entry\].*rerun agentera check validate vocabularyAuthority --format json$/,
        ),
      ]),
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("rejects an unexpectedly unclassified primary input state", () => {
    const pathname = malformedAuthority((authority) => {
      authority.consumer_boundary.outcome_matrix.no_applicable_entry.match.inferred_candidate = [];
    });
    expect(validateGlossaryEntryContract(pathname)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^consumer_boundary\.primary_selection must be exhaustive and non-overlapping: .*matched \[\].*rerun agentera check validate vocabularyAuthority --format json$/,
        ),
      ]),
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each(CAPABILITY_FIXTURES)(
    "accepts the deferred $capability declaration",
    ({ capability, valid_declaration }) => {
      expect(validateGlossaryCapabilityImplementationClaim(capability, valid_declaration)).toEqual(
        [],
      );
    },
  );

  it.each(CAPABILITY_FIXTURES)(
    "rejects the false $capability implementation claim",
    ({ capability, valid_declaration, false_implementation_claim }) => {
      expect(
        validateGlossaryCapabilityImplementationClaim(capability, false_implementation_claim),
      ).toEqual([
        `${capability} glossary behavior is ${valid_declaration}; implemented is a false implementation claim`,
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
