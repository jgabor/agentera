import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  createGlossaryAdmissionDecision,
  createGlossaryEvidenceCapsule,
  createGlossaryHostClassificationReceipt,
  createGlossaryPublicationResult,
  createGlossaryReviewRecord,
  validateGlossaryAdmissionDecision,
  validateGlossaryEvidenceCapsule,
  validateGlossaryHostClassificationReceipt,
  validateGlossaryPublicationResult,
  validateGlossaryReviewRecord,
  validatePersonalCandidateContracts,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
} from "../../src/registries/glossaryCandidateContracts.js";
import {
  validateGlossaryEntry,
  validateGlossaryEntryContract,
  type GlossaryAdmissionContext,
} from "../../src/registries/glossaryEntryContract.js";
import {
  glossaryCanonicalSha256,
  glossaryCandidateRevision,
  stableGlossaryTermIdentity,
} from "../../src/registries/glossaryTermIdentity.js";
import { glossaryEvidenceSetDigest } from "../../src/registries/glossaryMiningAuthority.js";
import {
  GLOSSARY_ADMISSION_OUTCOMES,
  GLOSSARY_ADMISSION_REASONS_BY_OUTCOME,
  type GlossaryAdmissionOutcome,
  type GlossaryAdmissionReason,
} from "../../src/registries/glossaryCandidateDecisionAuthority.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const AUTHORITY_PATH = path.join(ROOT, "references/artifacts/glossary-entry-contract.yaml");
const PROJECTION_SHA256 = "a".repeat(64);
const ADMISSION_REASON_PAIRS = GLOSSARY_ADMISSION_OUTCOMES.flatMap((outcome) =>
  GLOSSARY_ADMISSION_REASONS_BY_OUTCOME[outcome].map((reason) => ({ outcome, reason })),
) as Array<{ outcome: GlossaryAdmissionOutcome; reason: GlossaryAdmissionReason }>;
const CONTRADICTORY_REASON_PAIRS = ADMISSION_REASON_PAIRS.flatMap(({ outcome, reason }) =>
  GLOSSARY_ADMISSION_OUTCOMES
    .filter((rejectedOutcome) => rejectedOutcome !== outcome)
    .map((rejectedOutcome) => ({ outcome, reason, rejectedOutcome })),
);

function authority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
}

function explicitEvidence() {
  return [
    {
      source_id: "source-explicit",
      evidence_anchor: "anchor-explicit",
      signal_type: "correction",
    },
  ];
}

function inferredEvidence() {
  return [
    {
      source_id: "source-inferred-b",
      evidence_anchor: "anchor-inferred-b",
      source_kind: "instruction_document",
    },
    {
      source_id: "source-inferred-a",
      evidence_anchor: "anchor-inferred-a",
      source_kind: "project_config_signal",
    },
  ];
}

function conversationEvidence() {
  return [
    {
      source_id: "conversation-source-a",
      evidence_anchor: "conversation-anchor-a",
      source_kind: "conversation_turn",
      signal_type: "correction",
      session_id: "session-a",
      project_id: "project-a",
      content_fingerprint: "a".repeat(64),
      author_class: "user",
    },
    {
      source_id: "conversation-source-b",
      evidence_anchor: "conversation-anchor-b",
      source_kind: "conversation_turn",
      signal_type: "decision",
      session_id: "session-b",
      project_id: "project-b",
      content_fingerprint: "b".repeat(64),
      author_class: "user",
    },
    {
      source_id: "conversation-source-c",
      evidence_anchor: "conversation-anchor-c",
      source_kind: "conversation_turn",
      signal_type: "question",
      session_id: "session-a",
      project_id: "project-a",
      content_fingerprint: "c".repeat(64),
      author_class: "user",
    },
  ];
}

function capsule(overrides: Partial<Parameters<typeof createGlossaryEvidenceCapsule>[0]> = {}) {
  return createGlossaryEvidenceCapsule({
    term: "ship shape",
    meaning: "the complete form of a deliverable",
    scope: "personal",
    provenance_kind: "personal_explicit_definition",
    evidence: explicitEvidence(),
    policy_version: "agentera.personalGlossaryMiningPolicy.v1",
    generation: "generation-a",
    ...overrides,
  });
}

function receiptFor(candidate: GlossaryEvidenceCapsule = capsule()): GlossaryHostClassificationReceipt {
  return createGlossaryHostClassificationReceipt({
    capsule: candidate,
    candidate_projection_sha256: PROJECTION_SHA256,
    classification: {
      term: candidate.term,
      meaning: candidate.meaning,
      scope: candidate.scope,
      permanence: "durable",
      consistency: "consistent",
      confidence: 78,
    },
  });
}

function resealDecision(value: Record<string, unknown>): Record<string, unknown> {
  const { decision_sha256: _decisionSha256, ...body } = value;
  return { ...body, decision_sha256: glossaryCanonicalSha256(body) };
}

function personalEntry() {
  return {
    term: "ship shape",
    meaning: "the complete form of a deliverable",
    confidence: 78,
    permanence: "durable",
    temporal: { observed_at: "2026-08-08", last_confirmed_at: "2026-08-08" },
    provenance: {
      kind: "personal_explicit_definition",
      evidence: [
        {
          source_id: "source-explicit",
          evidence_anchor: "anchor-explicit",
          signal_type: "correction",
        },
      ],
    },
  };
}

const retainedHistory: GlossaryAdmissionContext = {
  retainedHistory: new Map([
    ["anchor-explicit", { sourceId: "source-explicit", sourceKind: "conversation_turn", signalType: "correction" }],
  ]),
};

describe("layered personal glossary candidate contracts", () => {
  it("has five complete layers with distinct owners and passes the authority validator", () => {
    const model = authority();
    const layers = model.candidate_contracts.layers as Record<string, any>;
    expect(Object.keys(layers)).toEqual([
      "evidence_capsule",
      "host_classification_receipt",
      "cli_decision",
      "review_record",
      "publication_result",
    ]);
    expect(new Set(Object.values(layers).map((layer) => layer.owner)).size).toBe(5);
    expect(validatePersonalCandidateContracts(model)).toEqual([]);
    expect(validateGlossaryEntryContract()).toEqual([]);
  });

  it.each([
    ["duplicate owner", (model: Record<string, any>) => {
      model.candidate_contracts.layers.host_classification_receipt.owner =
        model.candidate_contracts.layers.evidence_capsule.owner;
    }, "candidate contract layer owners must be distinct and authoritative"],
    ["missing field", (model: Record<string, any>) => {
      model.candidate_contracts.layers.review_record.required_fields =
        model.candidate_contracts.layers.review_record.required_fields.filter((field: string) => field !== "policy_version");
    }, "candidate_contracts.layers.review_record.required_fields must be exact and unique"],
    ["unbounded evidence", (model: Record<string, any>) => {
      model.candidate_contracts.bounds.evidence_records_max = 0;
    }, "candidate_contracts.bounds must preserve the declared candidate limits"],
    ["missing inferred distinctness", (model: Record<string, any>) => {
      delete model.provenance_variants.personal_inferred_usage.distinctness;
    }, "personal_inferred_usage must require two distinct source IDs and evidence anchors"],
    ["contradictory outcome reason", (model: Record<string, any>) => {
      model.candidate_contracts.layers.cli_decision.reason_codes_by_outcome.abstain.push("classification_changed");
    }, "CLI decision reasons must declare the approved outcome/reason pairs"],
  ])("rejects %s authority boundary", (_name, mutate, expected) => {
    const model = authority();
    mutate(model);
    expect(validatePersonalCandidateContracts(model)).toContain(expected);
  });

  it("canonicalizes evidence order and binds the current stable and revision helpers", () => {
    const first = capsule({
      provenance_kind: "personal_inferred_usage",
      evidence: inferredEvidence(),
    });
    const reordered = capsule({
      provenance_kind: "personal_inferred_usage",
      evidence: [...inferredEvidence()].reverse(),
    });
    expect(first.capsule_sha256).toBe(reordered.capsule_sha256);
    expect(validateGlossaryEvidenceCapsule(first)).toEqual([]);
    expect(first.candidate_revision).toBe(reordered.candidate_revision);
    expect(first.candidate_id).toBe(stableGlossaryTermIdentity("SHIP SHAPE"));
    expect(first.candidate_revision).toBe(
      glossaryCandidateRevision({
        stable_term_identity: first.candidate_id,
        meaning: first.meaning,
        scope: first.scope,
        evidence: first.evidence,
        policy_version: first.policy_version,
        generation: first.generation,
      }),
    );
  });

  it("rejects exact duplicate canonical evidence records without weakening other provenance variants", () => {
    const stable = stableGlossaryTermIdentity("ship shape");
    expect(() => glossaryCandidateRevision({
      stable_term_identity: stable,
      meaning: "meaning",
      scope: "personal",
      evidence: [
        { source_id: "source-a", evidence_anchor: "anchor-a" },
        { evidence_anchor: "anchor-a", source_id: "source-a" },
      ],
      policy_version: "policy",
      generation: "generation",
    })).toThrow("duplicate canonical evidence records");

    expect(validateGlossaryEvidenceCapsule(capsule())).toEqual([]);
    expect(validateGlossaryEvidenceCapsule(capsule({
      provenance_kind: "personal_inferred_conversation",
      evidence: conversationEvidence(),
    }))).toEqual([]);
  });

  it("requires two independent source IDs and anchors for inferred usage", () => {
    const valid = capsule({
      provenance_kind: "personal_inferred_usage",
      evidence: inferredEvidence(),
    });
    expect(validateGlossaryEvidenceCapsule(valid)).toEqual([]);

    const oneSource = valid.evidence.map((item) => ({ ...item, source_id: "source-one" }));
    const candidateRevision = glossaryCandidateRevision({
      stable_term_identity: valid.candidate_id,
      meaning: valid.meaning,
      scope: valid.scope,
      evidence: oneSource,
      policy_version: valid.policy_version,
      generation: valid.generation,
    });
    const invalid = {
      ...valid,
      evidence: oneSource,
      candidate_revision: candidateRevision,
      evidence_set_sha256: glossaryEvidenceSetDigest(
        valid.generation,
        oneSource.map((item) => item.evidence_anchor),
      ),
    } as Record<string, unknown>;
    delete invalid.capsule_sha256;
    invalid.capsule_sha256 = glossaryCanonicalSha256(invalid);
    expect(validateGlossaryEvidenceCapsule(invalid)).toContain(
      "evidence_capsule.evidence requires 2 distinct source_id",
    );
  });

  it("keeps stable term identity while changing revision for meaning, evidence, policy, and generation", () => {
    const base = capsule();
    const variants = [
      capsule({ meaning: "a different deliverable form" }),
      capsule({ evidence: [{ source_id: "source-explicit-2", evidence_anchor: "anchor-explicit-2", signal_type: "decision" }] }),
      capsule({ policy_version: "agentera.personalGlossaryMiningPolicy.v2" }),
      capsule({ generation: "generation-b" }),
    ];
    for (const variant of variants) {
      expect(variant.candidate_id).toBe(base.candidate_id);
      expect(variant.candidate_revision).not.toBe(base.candidate_revision);
    }
    expect(capsule({ term: "SHIP SHAPE" }).candidate_id).toBe(base.candidate_id);
  });

  it("rejects stale capsule bindings, missing fields, extra fields, bad scope, and oversized meaning", () => {
    const candidate = capsule();
    const stale = { ...candidate, generation: "generation-stale" };
    expect(validateGlossaryEvidenceCapsule(stale)).toContain(
      "evidence_capsule.capsule_sha256 does not match canonical capsule bytes",
    );

    const missing = { ...candidate } as Record<string, unknown>;
    delete missing.policy_version;
    expect(validateGlossaryEvidenceCapsule(missing)).toContain(
      "candidate_contracts.layers.evidence_capsule is missing fields: policy_version",
    );

    const extra = { ...candidate, admission: "automatic_admission" };
    expect(validateGlossaryEvidenceCapsule(extra)).toContain(
      "candidate_contracts.layers.evidence_capsule contains fields outside its contract: admission",
    );

    const badScope = { ...candidate, scope: "unknown" };
    expect(validateGlossaryEvidenceCapsule(badScope)).toContain("evidence_capsule.scope is invalid");

    const oversized = { ...candidate, meaning: "x".repeat(4097) };
    expect(validateGlossaryEvidenceCapsule(oversized)).toContain(
      "evidence_capsule.meaning is outside its bound",
    );
  });

  it("keeps host classification semantic and rejects admission or mutation authority", () => {
    const candidate = capsule();
    const receipt = receiptFor(candidate);
    const context = { candidateProjectionSha256: receipt.candidate_projection_sha256 };
    expect(validateGlossaryHostClassificationReceipt(receipt, candidate, context)).toEqual([]);

    const forbidden = { ...receipt, admission: "automatic_admission" };
    expect(validateGlossaryHostClassificationReceipt(forbidden, candidate, context)).toContain(
      "candidate_contracts.layers.host_classification_receipt contains fields outside its contract: admission",
    );

    const nested = {
      ...receipt,
      classification: { ...receipt.classification, mutation: "write" },
    };
    expect(validateGlossaryHostClassificationReceipt(nested, candidate, context)).toContain(
      "host_classification_receipt.classification contains fields outside its contract: mutation",
    );

    const badConfidence = {
      ...receipt,
      classification: { ...receipt.classification, confidence: 101 },
    };
    expect(validateGlossaryHostClassificationReceipt(badConfidence, candidate, context)).toContain(
      "host_classification_receipt.classification.confidence must be an integer from shared_primitive.fields.confidence",
    );

    const badConsistency = {
      ...receipt,
      classification: { ...receipt.classification, consistency: "made-up" },
    };
    expect(validateGlossaryHostClassificationReceipt(badConsistency, candidate, context)).toContain(
      "host_classification_receipt.classification.consistency is invalid",
    );

    const mismatch = { ...receipt, candidate_revision: "f".repeat(64) };
    expect(validateGlossaryHostClassificationReceipt(mismatch, candidate, context)).toContain(
      "host_classification_receipt.candidate_revision does not match the capsule",
    );

    const staleProjection = { ...receipt, candidate_projection_sha256: "b".repeat(64) };
    expect(validateGlossaryHostClassificationReceipt(staleProjection, candidate, context)).toContain(
      "host_classification_receipt.candidate_projection_sha256 does not match the current projection",
    );
  });

  it("lets the CLI own admission outcomes and keeps inferred automatic admission disabled", () => {
    const candidate = capsule();
    const receipt = receiptFor(candidate);
    const decision = createGlossaryAdmissionDecision({
      capsule: candidate,
      receipt,
      outcome: "automatic_admission",
      reason: "explicit_current_authorized",
    });
    expect(validateGlossaryAdmissionDecision(decision, candidate, receipt)).toEqual([]);

    const changedClassification = createGlossaryHostClassificationReceipt({
      capsule: candidate,
      candidate_projection_sha256: PROJECTION_SHA256,
      classification: {
        term: candidate.term,
        meaning: "a different semantic meaning",
        scope: "ambiguous",
        permanence: "durable",
        consistency: "consistent",
        confidence: 100,
      },
    });
    expect(() =>
      createGlossaryAdmissionDecision({
        capsule: candidate,
        receipt: changedClassification,
        outcome: "automatic_admission",
        reason: "explicit_current_authorized",
      }),
    ).toThrow("cli_decision automatic_admission requires the exact personal consistent capsule classification");

    const inferred = capsule({
      provenance_kind: "personal_inferred_usage",
      evidence: inferredEvidence(),
    });
    const inferredReceipt = receiptFor(inferred);
    const inferredDecision = {
      ...decision,
      candidate_id: inferred.candidate_id,
      candidate_revision: inferred.candidate_revision,
      candidate_capsule_sha256: inferred.capsule_sha256,
      candidate_projection_sha256: inferredReceipt.candidate_projection_sha256,
      host_receipt_sha256: inferredReceipt.receipt_sha256,
      classification_contract_version: inferredReceipt.schema_version,
      semantic_fingerprint: inferredReceipt.semantic_fingerprint,
      generation: inferred.generation,
      policy_version: inferred.policy_version,
      decision_sha256: "0".repeat(64),
    };
    expect(validateGlossaryAdmissionDecision(inferredDecision, inferred, inferredReceipt)).toContain(
      "cli_decision automatic_admission is disabled for inferred provenance",
    );

    const extra = { ...decision, project_publication: true };
    expect(validateGlossaryAdmissionDecision(extra, candidate, receipt)).toContain(
      "candidate_contracts.layers.cli_decision contains fields outside its contract: project_publication",
    );

    const badOutcome = { ...decision, outcome: "publish" };
    expect(validateGlossaryAdmissionDecision(badOutcome, candidate, receipt)).toContain(
      "cli_decision.outcome is invalid",
    );
  });

  it.each(ADMISSION_REASON_PAIRS)("accepts the authority-owned $outcome/$reason pair", ({ outcome, reason }) => {
    const candidate = capsule();
    const receipt = receiptFor(candidate);
    const decision = createGlossaryAdmissionDecision({ capsule: candidate, receipt, outcome, reason });
    expect(validateGlossaryAdmissionDecision(decision, candidate, receipt)).toEqual([]);
  });

  it.each(CONTRADICTORY_REASON_PAIRS)("rejects digest-valid $rejectedOutcome/$reason for $outcome", ({ outcome, reason, rejectedOutcome }) => {
    const candidate = capsule();
    const receipt = receiptFor(candidate);
    const valid = createGlossaryAdmissionDecision({ capsule: candidate, receipt, outcome, reason });
    const contradictory = resealDecision({ ...valid, outcome: rejectedOutcome });
    expect(validateGlossaryAdmissionDecision(contradictory, candidate, receipt)).toContain(
      "cli_decision.reason is not allowed for cli_decision.outcome",
    );
  });

  it("binds review lifecycle and personal publication without changing the shared entry contract", () => {
    const candidate = capsule();
    const receipt = receiptFor(candidate);
    const decision = createGlossaryAdmissionDecision({
      capsule: candidate,
      receipt,
      outcome: "review_required",
      reason: "classification_changed",
    });
    const review = createGlossaryReviewRecord({
      capsule: candidate,
      receipt,
      decision,
      disposition: "accept",
      corrected_meaning: null,
      disposed_at: "2026-08-08T02:00:00Z",
      expires_at: "2026-08-08T03:00:00Z",
    });
    expect(validateGlossaryReviewRecord(review, candidate, receipt, decision)).toEqual([]);
    const publication = createGlossaryPublicationResult({
      capsule: candidate,
      receipt,
      decision,
      review,
      status: "changed",
      profile_section_sha256: "1".repeat(64),
      published_at: "2026-08-08T02:01:00Z",
    });
    expect(validateGlossaryPublicationResult(publication, candidate, receipt, decision, review)).toEqual([]);
    expect(validateGlossaryEntry(personalEntry(), "personal", retainedHistory)).toEqual([]);

    const invalidReview = { ...review, policy_version: "stale-policy" };
    expect(validateGlossaryReviewRecord(invalidReview, candidate, receipt, decision)).toContain(
      "review_record.policy_version does not match its source layer",
    );
    const badDisposition = { ...review, disposition: "approve" };
    expect(validateGlossaryReviewRecord(badDisposition, candidate, receipt, decision)).toContain(
      "review_record.disposition is invalid",
    );
    const invalidPublication = { ...publication, project_glossary: true };
    expect(validateGlossaryPublicationResult(invalidPublication, candidate, receipt, decision, review)).toContain(
      "candidate_contracts.layers.publication_result contains fields outside its contract: project_glossary",
    );
    const badStatus = { ...publication, status: "published" };
    expect(validateGlossaryPublicationResult(badStatus, candidate, receipt, decision, review)).toContain(
      "publication_result.status is not an existing profile output status",
    );
  });

  it("preserves project precedence and publication references through the shared invariant", () => {
    const model = authority();
    expect(model.candidate_contracts.shared_invariance).toEqual({
      shared_primitive: "shared_primitive",
      consumer_precedence: "consumer_boundary.primary_selection",
      project_publication: "ownership_contracts.project.publication",
      personal_project_isolation: "ownership_contracts.personal.admission.isolation_rule",
      rule: expect.any(String),
    });
    expect(model.consumer_boundary.exact_collision.behavior).toBe("project_precedence_at_consumption");
    expect(model.ownership_contracts.project.publication.owner).toBe("build");
  });
});
