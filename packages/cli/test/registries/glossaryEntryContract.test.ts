import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import auditInstructions from "../../src/capabilities/audit/instructions.js";
import { glossaryCaveatContract } from "../../src/registries/glossaryCaveatContract.js";
import { glossaryAdviceContract } from "../../src/registries/glossaryAdviceContract.js";
import {
  confirmedVariantGuardContract,
  glossaryConsumerContract,
  glossaryEntryAuthorityPath,
  personalGlossaryOutputContract,
  personalProfileGroundingContract,
  validateGlossaryEntry,
  validateGlossaryEntryContract,
  validateGlossaryCapabilityImplementationClaim,
  type GlossaryAdmissionContext,
} from "../../src/registries/glossaryEntryContract.js";
import { personalGlossaryProfileFullContract } from "../../src/registries/glossaryProfileFullContract.js";

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
  it("projects every glossary owner only from its exact code-owned source value", () => {
    expect(personalGlossaryOutputContract().command).toBe("agentera report personal-glossary-publish");
    expect(personalProfileGroundingContract()).toMatchObject({
      command: "agentera report profile-grounding",
      repairRecovery: "Use the Profile capability to repair or regenerate PROFILE.md, then retry `agentera report profile-grounding`; no profile bytes were changed.",
      absentRecovery: "Use the Profile capability to generate PROFILE.md, then retry agentera report profile-grounding.",
    });
    expect(glossaryAdviceContract().command).toBe("agentera report glossary-advice --input REQUEST");

    const mutations: Array<{
      name: string;
      mutate: (authority: Record<string, any>) => void;
      load: (pathname: string) => unknown;
    }> = [
      {
        name: "profile output command",
        mutate: (authority) => { authority.ownership_contracts.personal.profile_output.command.canonical += " --force"; },
        load: (pathname) => personalGlossaryOutputContract(pathname),
      },
      {
        name: "profile grounding command",
        mutate: (authority) => { authority.consumer_boundary.profile_grounding.command += " garbage"; },
        load: (pathname) => personalProfileGroundingContract(pathname),
      },
      {
        name: "profile grounding repair",
        mutate: (authority) => { authority.consumer_boundary.profile_grounding.recovery.repair += " changed"; },
        load: (pathname) => personalProfileGroundingContract(pathname),
      },
      {
        name: "profile grounding absent",
        mutate: (authority) => { authority.consumer_boundary.profile_grounding.recovery.absent = `x${authority.consumer_boundary.profile_grounding.recovery.absent}`; },
        load: (pathname) => personalProfileGroundingContract(pathname),
      },
      {
        name: "advice command",
        mutate: (authority) => { authority.consumer_boundary.advice_resolution.invocation.command = "npx -y agentera@latest report glossary-advice --input REQUEST"; },
        load: (pathname) => glossaryAdviceContract(pathname),
      },
    ];
    for (const mutation of mutations) {
      const pathname = malformedAuthority(mutation.mutate);
      expect(() => mutation.load(pathname), mutation.name).toThrow(/invalid development command projection/);
      fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
    }
  });

  it("derives shared shape, active personal output, bounded ownership, confidence, and decay rules from existing authorities", () => {
    expect(validateGlossaryEntryContract(glossaryEntryAuthorityPath())).toEqual([]);
    const authority = YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8"));
    expect(authority.ownership_contracts.personal.implementation).toMatchObject({
      status: "active_partial",
      active: expect.arrayContaining([
        "public_receipt_construction",
        "authorized_personal_publication",
        "profile_section_persistence",
      ]),
      inactive: ["lookup"],
    });
    expect(authority.deferred_capability_contracts.profile).toMatchObject({
      implementation: "active_partial",
      active_behavior: [
        "ownership_contracts.personal.admission",
        "personal_mining_authority.profile_full",
      ],
      inactive_behavior: ["lookup"],
      forbidden_current_claims: ["lookup", "project_glossary_consumption"],
    });
    expect(personalGlossaryProfileFullContract()).toEqual({
      candidateListLimit: 20,
      questionReviewMaximum: 3,
    });
    expect(personalGlossaryOutputContract()).toEqual({
      command: "agentera report personal-glossary-publish",
      requestSchemaVersion: "agentera.personalGlossaryPublishRequest.v1",
      requestFields: ["schema_version", "receipt", "decision", "as_of"],
      requestOptionalFields: ["review_authorization"],
      maxRequestUtf8Bytes: 16_384,
      resultSchemaVersion: "agentera.personalGlossaryPublicationResult.v1",
      resultFields: [
        "schema_version",
        "owner",
        "candidate_id",
        "candidate_revision",
        "candidate_capsule_sha256",
        "decision_sha256",
        "review_record_sha256",
        "generation",
        "policy_version",
        "status",
        "profile_section_sha256",
        "published_at",
        "result_sha256",
      ],
      maxResultUtf8Bytes: 4_096,
      sectionSchemaVersion: "agentera.personalGlossarySection.v1",
      outputStatuses: ["changed", "unchanged_replay", "dry_run_candidate"],
      reviewAuthorizationFields: ["review_id", "review_record_sha256"],
      reviewAuthorizationDispositions: ["accept", "correct"],
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
      normalization: "unicode_caseless_exact_no_normalization",
      uniqueness: "global_across_complete_document",
    });
  });

  it.each([
    [
      "a non-positive candidate-list limit",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.profile_full.existing_generation.list_limit = 0;
      },
    ],
    [
      "an arbitrary question-review limit",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.profile_full.review.question_channel_maximum = 4;
      },
    ],
  ])("fails closed when Profile Full authority has %s", (_name, mutate) => {
    const pathname = malformedAuthority(mutate);
    expect(() => personalGlossaryProfileFullContract(pathname)).toThrow(
      "personal glossary Profile Full contract is unavailable",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("aligns active Build, Discuss, Plan, and prime consumption with mutation-free Audit", () => {
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
      expect(surface).toMatch(
        /profile mutation|personal-profile mutation|personal-profile\s+mutation/i,
      );
      expect(surface).toMatch(/docs-mapping\s+mutation/);
      expect(surface).not.toMatch(/project glossary production and persistence.*deferred/i);
    }
    for (const surface of [validation, auditInstructions]) {
      expect(surface).toMatch(/active read-only advice path/);
      expect(surface).not.toMatch(/glossary consumers remain deferred/);
    }
    expect(authority).toMatch(/Build, Discuss, Plan, and prime bounded glossary consumption are active/);
    expect(authority).not.toContain("prime: declared_deferred");
    expect(authority).not.toContain("forbidden_current_claims: [prime_projection]");
  });

  it("loads active bounded acquisition and Build/Discuss/Plan/prime integration", () => {
    expect(glossaryConsumerContract()).toEqual({
      contractStatus: "active",
      implementation: {
        acquisition: "active",
        advice_resolution: "active",
      },
      capabilityIntegrations: {
        build: "active",
        discuss: "active",
        plan: "active",
        prime: "active",
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
      transientAllowed: [
        "outcome",
        "applicable_meaning",
        "applicable_owner",
        "review",
        "tension",
        "advisory",
      ],
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
    expect(glossaryCaveatContract()).toMatchObject({
      currentAppendCallerFields: ["event", "reason", "ownership_state"],
      currentAppendCallerFixedValues: { event: "current" },
      currentAppendWriterFields: ["caveat_id", "capability", "transition_id"],
      currentAppendWriterFixedValues: { capability: "build", transition_id: null },
      allowedCurrentPairs: [
        { reason: "inferred_equivalence", ownershipState: "review_required" },
        { reason: "inferred_equivalence", ownershipState: "project_governs_exact" },
        { reason: "authority_unavailable", ownershipState: "authority_unavailable" },
        { reason: "personal_input_unavailable", ownershipState: "authority_unavailable" },
      ],
      primeSourceArtifact: "progress",
      primeSourceBoundary: "progress_cycle",
      primeSourceCapability: "build",
      primePublicAttentionLimit: 6,
      primeReservedGlossarySlots: 1,
    });
  });

  it.each([
    [
      "entry bound",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.acquisition.bounds.max_entries = 101;
      },
    ],
    [
      "project identity",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.acquisition.project.identity = "alternate_glossary";
      },
    ],
    [
      "docs no-follow boundary",
      (authority: Record<string, any>) => {
        delete authority.consumer_boundary.acquisition.project.docs_override_read;
      },
    ],
    [
      "private output",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.acquisition.output.entry_fields.push("provenance");
      },
    ],
  ])("rejects acquisition contract drift in %s", (_label, mutate) => {
    const pathname = malformedAuthority(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "consumer_boundary.acquisition must define canonical bounded independent project and personal reads with sanitized term/meaning/owner output",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each([
    [
      "runtime",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.advice_resolution.runtime = "private/runtime";
      },
    ],
    [
      "host relation",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.advice_resolution.input.host_review.relations.push("fuzzy");
      },
    ],
    [
      "private output",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.advice_resolution.output.fields.push("candidate_term");
      },
    ],
    [
      "failure vocabulary",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.advice_resolution.failure.classes.push("raw_error");
      },
    ],
  ])("rejects advice-resolution contract drift in %s", (_label, mutate) => {
    const pathname = malformedAuthority(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "consumer_boundary.advice_resolution must define the active bounded read-only runtime, host-review input, transient output, and privacy-safe failure contract",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("accepts the bounded no-review selected-term transport", () => {
    expect(validateGlossaryEntryContract()).not.toContain(
      "consumer_boundary.selected_term_transport must authorize bounded no-review file or stdin input without argv content, output echo, host review, persistence, or shared Build stdin",
    );
  });

  it.each([
    [
      "argv term content",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.selected_term_transport.privacy.selected_term_in_argv =
          "allowed";
      },
    ],
    [
      "term echo",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.selected_term_transport.failure.selected_term_echo = "allowed";
      },
    ],
    [
      "shared Build stdin",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.selected_term_transport.coexistence.shared_stdin = "allowed";
      },
    ],
    [
      "host review",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.selected_term_transport.review.host_review = "allowed";
      },
    ],
  ])("rejects selected-term transport drift in %s", (_label, mutate) => {
    const pathname = malformedAuthority(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "consumer_boundary.selected_term_transport must authorize bounded no-review file or stdin input without argv content, output echo, host review, persistence, or shared Build stdin",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
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

  it("rejects a confirmed-variant guard detached from the active state validator", () => {
    const pathname = malformedAuthority((authority) => {
      authority.ownership_contracts.project.confirmed_variant_guard.owner =
        "packages/cli/src/validate/glossaryVariantGuard.ts#scanConfirmedVariantViolations";
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "confirmed variant guard must run through the active state validator and reuse validated project glossary pairs with bounded exclusions",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("rejects drift from the shared Unicode caseless-exact identity runtime", () => {
    const pathname = malformedAuthority((authority) => {
      authority.consumer_boundary.deterministic_judgments.term_identity_runtime =
        "packages/cli/src/registries/other.ts#lowercase";
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "consumer_boundary judgments must separate deterministic exact identity and valid gaps from host-reviewed inferred equivalence and invalid project state",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("rejects drift from the shared exact-case terminology occurrence runtime", () => {
    const pathname = malformedAuthority((authority) => {
      authority.term_occurrence.identifier_continuation = "letters_and_numbers";
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      "term_occurrence must define one exact-case escaped literal matcher with ECMAScript identifier-continuation boundaries",
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each([
    [
      "inactive Profile Full integration",
      (authority: Record<string, any>) => {
        authority.deferred_capability_contracts.profile.inactive_behavior = [
          "rendering",
          "persistence",
          "lookup",
        ];
      },
      "profile glossary synthesis must reuse existing consented input and only canonical authorized personal publication",
    ],
    [
      "unbounded Profile Full questions",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.profile_full.review.question_channel_maximum = 4;
      },
      "personal_mining_authority Profile Full integration must reuse one existing consent-bound generation, preserve base output, bound review, and publish only explicit authorization",
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
      "Plan conflict persistence",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.plan_integration.forbidden_effects =
          authority.consumer_boundary.plan_integration.forbidden_effects.filter(
            (effect: string) => effect !== "plan_conflict",
          );
      },
      "consumer_boundary.plan_integration must define deterministic mode, ordered review, autonomous abstention, and an emitted event/reason/state writer intent",
    ],
    [
      "ambiguous mode inferred as autonomous",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.plan_integration.mode.signals.unknown_or_ambiguous.result =
          "autonomous";
      },
      "consumer_boundary.plan_integration must define deterministic mode, ordered review, autonomous abstention, and an emitted event/reason/state writer intent",
    ],
    [
      "interactive finalization before review",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.plan_integration.interaction.review.interactive_sequence.reverse();
      },
      "consumer_boundary.plan_integration must define deterministic mode, ordered review, autonomous abstention, and an emitted event/reason/state writer intent",
    ],
    [
      "Plan-owned caveat identity",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.plan_integration.autonomous_handoff_intent.caller_fields.push(
          "caveat_id",
        );
      },
      "consumer_boundary.plan_integration must define deterministic mode, ordered review, autonomous abstention, and an emitted event/reason/state writer intent",
    ],
    [
      "invalid Plan reason-state cross-pair",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.allowed_current_pairs.push(
          { reason: "personal_input_unavailable", ownership_state: "project_governs_exact" },
        );
      },
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
    ],
    [
      "personal-unavailable exact project handoff",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.plan_integration.exact_project_personal_unavailable.autonomous_handoff_intent =
          "emitted";
      },
      "consumer_boundary.plan_integration must separate exact-project personal-input advice from unresolved autonomous handoff",
    ],
    [
      "personal definition in Plan artifacts",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.disclosure.plan_artifacts.forbidden_content =
          authority.consumer_boundary.disclosure.plan_artifacts.forbidden_content.filter(
            (field: string) => field !== "personal_glossary_definition",
          );
      },
      "consumer_boundary.disclosure must forbid private glossary content in every durable Plan surface while allowing user-authored terms and derived requirements",
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
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
    ],
    [
      "clock-based caveat expiration",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.lifecycle.expiration = "30_days";
      },
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
    ],
    [
      "non-progress prime caveat source",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.prime_projection.source.artifact = "plan";
      },
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
    ],
    [
      "unreserved prime attention capacity",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.prime_projection.capacity.reserved_glossary_slots = 0;
      },
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
    ],
    [
      "path-leaking malformed prime diagnostics",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.autonomous_caveat.prime_projection.malformed_evidence.forbidden_diagnostic_content = [];
      },
      "consumer_boundary.autonomous_caveat must define Build-owned progress evidence, exact pairs, lifecycle, and bounded active prime projection",
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
    [
      "a downstream gate that omits selected-term transport authority",
      (authority: Record<string, any>) => {
        authority.consumer_boundary.downstream_gate.required_sections =
          authority.consumer_boundary.downstream_gate.required_sections.filter(
            (section: string) => section !== "consumer_boundary.selected_term_transport",
          );
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
          /^consumer_boundary\.primary_selection must be exhaustive and non-overlapping: .*matched \[inferred_equivalence, no_applicable_entry\].*rerun agentera check validate vocabularyAuthority$/,
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
          /^consumer_boundary\.primary_selection must be exhaustive and non-overlapping: .*matched \[\].*rerun agentera check validate vocabularyAuthority$/,
        ),
      ]),
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each([
    ["judgment", "equivalent_exact_collision", "host_reviewed", "deterministic"],
    ["selected_owner", "no_applicable_entry", "personal", "none"],
    ["selected_meaning", "equivalent_exact_collision", "personal", "project"],
    ["review", "divergent_exact_collision", "required_when_meaning_sensitive", "none"],
    ["tension", "no_applicable_entry", "inferred_equivalence", "none"],
  ])(
    "rejects contradictory primary outcome %s semantics",
    (field, outcomeName, contradictory, expected) => {
      const pathname = malformedAuthority((authority) => {
        authority.consumer_boundary.outcome_matrix[outcomeName][field] = contradictory;
      });
      expect(validateGlossaryEntryContract(pathname)).toContain(
        `consumer_boundary.outcome_matrix.${outcomeName}.${field} must be ${JSON.stringify(expected)} (found ${JSON.stringify(contradictory)}); restore the canonical primary-outcome semantics and rerun agentera check validate vocabularyAuthority`,
      );
      fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
    },
  );

  it.each([
    ["judgment", "deterministic"],
    ["selected_owner", "project"],
    ["selected_meaning", "project"],
    ["review", "none"],
    ["tension", "none"],
  ])("rejects a missing primary outcome %s field", (field, expected) => {
    const pathname = malformedAuthority((authority) => {
      delete authority.consumer_boundary.outcome_matrix.equivalent_exact_collision[field];
    });
    expect(validateGlossaryEntryContract(pathname)).toContain(
      `consumer_boundary.outcome_matrix.equivalent_exact_collision.${field} must be ${JSON.stringify(expected)} (found missing); restore the canonical primary-outcome semantics and rerun agentera check validate vocabularyAuthority`,
    );
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it.each(CAPABILITY_FIXTURES)(
    "accepts the governed $capability declaration",
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
