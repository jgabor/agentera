import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  glossaryCandidateRevision,
  stableGlossaryTermIdentity,
  unicodeCaselessExact,
} from "../../src/registries/glossaryTermIdentity.js";
import {
  classifyPersonalMiningConsent,
  glossaryEvidenceSetDigest,
  personalReviewApprovalReceiptDigest,
  personalReviewApprovalReplayStatus,
  personalReviewDispositionLifecycle,
  projectPersonalReviewRetention,
  validatePersonalReviewApprovalReceipt,
} from "../../src/registries/glossaryMiningAuthority.js";
import {
  glossaryEntryAuthorityPath,
  personalGlossaryAdmissionContract,
  validateGlossaryEntry,
  validateGlossaryEntryContract,
  type GlossaryAdmissionContext,
} from "../../src/registries/glossaryEntryContract.js";
import { personalGlossaryCandidateProjectionContract } from "../../src/registries/glossaryCandidateProjectionContract.js";

function authorityFixture(mutate?: (authority: Record<string, any>) => void): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glossary-mining-authority-"));
  const pathname = path.join(directory, "authority.yaml");
  const authority = YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8")) as Record<
    string,
    any
  >;
  mutate?.(authority);
  fs.writeFileSync(pathname, YAML.stringify(authority), "utf8");
  return pathname;
}

function conversationEvidence(index: number): Record<string, string> {
  const session = index === 0 ? "session-one" : index === 1 ? "session-two" : "session-one";
  const project = index === 0 ? "project-one" : "project-two";
  const fingerprint = String.fromCharCode("a".charCodeAt(0) + index).repeat(64);
  return {
    source_id: `conversation-source-${index}`,
    evidence_anchor: `conversation-anchor-${index}`,
    source_kind: "conversation_turn",
    signal_type: ["correction", "decision", "question", "instruction"][index]!,
    session_id: session,
    project_id: project,
    content_fingerprint: fingerprint,
    author_class: "user",
  };
}

function conversationContextFor(
  retainedIndexes: number[],
  expectedIndexes = retainedIndexes,
): GlossaryAdmissionContext {
  const expectedAnchors = expectedIndexes.map(
    (index) => conversationEvidence(index).evidence_anchor,
  );
  return {
    retainedHistory: new Map(
      retainedIndexes.map((index) => {
        const evidence = conversationEvidence(index);
        return [
          evidence.evidence_anchor,
          {
            sourceId: evidence.source_id,
            sourceKind: evidence.source_kind,
            signalType: evidence.signal_type,
            sessionId: evidence.session_id,
            projectId: evidence.project_id,
            contentFingerprint: evidence.content_fingerprint,
            authorClass: evidence.author_class,
          },
        ] as const;
      }),
    ),
    conversationEvidence: {
      generation: "generation-a",
      qualifyingEvidenceAnchors: expectedAnchors,
      qualifyingEvidenceSetSha256: glossaryEvidenceSetDigest("generation-a", expectedAnchors),
    },
  };
}

const conversationContext = conversationContextFor([0, 1, 2]);

function conversationEntry(evidence = [0, 1, 2].map(conversationEvidence)) {
  return {
    term: "cycle",
    meaning: "one bounded implementation pass",
    confidence: 70,
    permanence: "durable",
    temporal: { observed_at: "2026-08-07", last_confirmed_at: "2026-08-07" },
    provenance: {
      kind: "personal_inferred_conversation",
      evidence_complete: true,
      evidence,
    },
  };
}

describe("personal glossary mining authority", () => {
  it("passes the complete authority and preserves the existing ownership boundaries", () => {
    expect(validateGlossaryEntryContract(glossaryEntryAuthorityPath())).toEqual([]);
    const authority = YAML.parse(fs.readFileSync(glossaryEntryAuthorityPath(), "utf8"));
    expect(authority.personal_mining_authority).toMatchObject({
      status: "active_partial",
      explicit_discovery: {
        status: "active",
        grammar: { forms: expect.any(Array) },
        adjacent_direct_reference_exclusion: {
          references: [
            "this_definition",
            "this_term",
            "this_meaning",
            "following_definition",
            "following_term",
            "following_meaning",
          ],
          qualifiers: ["question", "example", "future", "hypothetical"],
          binding: {
            preceding_sentence: "following_reference_only",
            following_sentence: "this_reference_only",
            exact_literal_term: "either_direction",
          },
        },
      },
      replacement: {
        shared_primitive: "shared_primitive",
        personal_owner: "ownership_contracts.personal",
        project_owner: "ownership_contracts.project",
        consumer_precedence: "consumer_boundary.primary_selection",
        project_publication: "ownership_contracts.project.publication",
      },
      admission: { inferred_automatic_admission: "disabled" },
      candidate_projection: {
        status: "active",
        selection: {
          candidates_max: 50,
          source_families: {
            explicit: ["personal_explicit_definition"],
            recurring: ["personal_inferred_usage", "personal_inferred_conversation"],
          },
        },
      },
    });
    expect(personalGlossaryAdmissionContract()).toMatchObject({
      conversationSignalTypes: [
        "correction",
        "decision",
        "question",
        "instruction",
        "configuration",
      ],
      conversationSourceKinds: ["conversation_turn"],
      conversationAuthorClasses: ["user"],
      conversationExpectedEvidenceContextFields: [
        "generation",
        "qualifying_evidence_anchors",
        "qualifying_evidence_set_sha256",
      ],
      explicitGrammarIds: [
        "quoted_means",
        "definition_list_colon",
        "acronym_stands_for",
        "acronym_parenthetical",
        "by_i_mean",
        "use_for",
        "use_to_mean",
        "refers_to",
        "clarification_prefer_to_mean",
        "correction_means",
      ],
      explicitProvenanceFields: [
        "source_id",
        "evidence_anchor",
        "source_kind",
        "signal_type",
        "origin_id",
        "content_fingerprint",
        "author_class",
        "session_id",
        "project_id",
      ],
      conversationMinimumEvidenceCount: 3,
      conversationCompletenessAuthority: "expected_qualifying_anchor_set_exact_match",
      conversationAdmission: "review_only",
    });
    expect(personalGlossaryCandidateProjectionContract()).toMatchObject({
      schemaVersion: "agentera.personalGlossaryCandidateProjection.v1",
      candidatesMax: 50,
      projectIdsMaxPerCandidate: 100,
      sourceExcerptMaxUtf8Bytes: 4096,
      pendingExcerptDays: 30,
      storageFile: "candidate-projection.json",
    });
  });

  it.each([
    [
      "explicit discovery runtime",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.explicit_discovery.runtime = "wrong-runtime";
      },
      "personal_mining_authority explicit discovery must declare the active ten-form bounded grammar",
    ],
    [
      "explicit definition-list grammar",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.explicit_discovery.grammar.forms[1].bare_multiword_term_without_marker =
          "accept";
      },
      "personal_mining_authority explicit discovery must declare the active ten-form bounded grammar",
    ],
    [
      "adjacent direct-reference binding",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.explicit_discovery.adjacent_direct_reference_exclusion.binding.preceding_sentence =
          "either_direction";
      },
      "personal_mining_authority explicit discovery must declare the active ten-form bounded grammar",
    ],
    [
      "explicit source provenance",
      (authority: Record<string, any>) => {
        authority.provenance_variants.personal_explicit_definition.source_provenance.required_fields =
          ["source_id"];
      },
      "personal_explicit_definition source provenance must require complete conversation identity",
    ],
    [
      "replacement authority",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.replacement.project_publication =
          "personal_mining_authority";
      },
      "personal_mining_authority replacement must preserve shared primitive, isolation, consumer precedence, and Build project publication",
    ],
    [
      "candidate projection cap",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.candidate_projection.selection.candidates_max = 51;
      },
      "personal_mining_authority candidate projection must bound deterministic allocation, diversity, safe excerpts, retention, and user-local replay",
    ],
    [
      "candidate projection diversity",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.candidate_projection.selection.source_families.recurring =
          [];
      },
      "personal_mining_authority candidate projection must bound deterministic allocation, diversity, safe excerpts, retention, and user-local replay",
    ],
    [
      "candidate projection tie break",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.candidate_projection.selection.tie_break =
          "source-order";
      },
      "personal_mining_authority candidate projection must bound deterministic allocation, diversity, safe excerpts, retention, and user-local replay",
    ],
    [
      "candidate projection excerpt redaction",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.candidate_projection.excerpts.source_max_utf8_bytes = 0;
      },
      "personal_mining_authority candidate projection must bound deterministic allocation, diversity, safe excerpts, retention, and user-local replay",
    ],
    [
      "candidate projection retention purge",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.candidate_projection.retention.purge = "project";
      },
      "personal_mining_authority candidate projection must bound deterministic allocation, diversity, safe excerpts, retention, and user-local replay",
    ],
    [
      "candidate projection replay persistence",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.candidate_projection.persistence.replay = "overwrite";
      },
      "personal_mining_authority candidate projection must bound deterministic allocation, diversity, safe excerpts, retention, and user-local replay",
    ],
    [
      "term identity",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.term_identity.stable_term_identity.no_unicode_normalization = false;
      },
      "personal_mining_authority term identity must preserve Unicode caseless-exact no-normalization semantics and stable identity runtime",
    ],
    [
      "conversation provenance",
      (authority: Record<string, any>) => {
        authority.provenance_variants.personal_inferred_conversation.minimum_evidence_count = 2;
      },
      "personal_mining_authority provenance must append explicit complete conversation evidence without altering the two-record variant",
    ],
    [
      "consent lifecycle",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.consent_lifecycle.policy = "refresh_on_profile_full";
      },
      "personal_mining_authority consent lifecycle must reuse existing generations and define present, absent, stale, and degraded recovery",
    ],
    [
      "consent precedence",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.consent_lifecycle.discriminator.order = [
          "present",
          "degraded",
          "stale",
          "absent",
        ];
      },
      "personal_mining_authority consent lifecycle must reuse existing generations and define present, absent, stale, and degraded recovery",
    ],
    [
      "inherent boundedness rule",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.consent_lifecycle.discriminator.boundedness_rule =
          "all bounded generations are degraded";
      },
      "personal_mining_authority consent lifecycle must reuse existing generations and define present, absent, stale, and degraded recovery",
    ],
    [
      "privacy authority",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.privacy.owner = "project";
      },
      "personal_mining_authority privacy must be user-local, redacted, authenticated, retained, and purgeable",
    ],
    [
      "trusted receipt issuer",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.privacy.reviews.authentication.issuer = "agent";
      },
      "personal_mining_authority privacy must be user-local, redacted, authenticated, retained, and purgeable",
    ],
    [
      "receipt replay rule",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.privacy.reviews.authentication.replay.exact_replay =
          "always_accept";
      },
      "personal_mining_authority privacy must be user-local, redacted, authenticated, retained, and purgeable",
    ],
    [
      "automatic inference gate",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.admission.inferred_automatic_admission = "enabled";
      },
      "personal_mining_authority must keep inferred automatic admission disabled and bind the evaluation authority",
    ],
  ])("rejects drift in %s", (_name, mutate, expected) => {
    const pathname = authorityFixture(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(expected);
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("accepts complete conversation provenance and refuses to truncate its evidence contract", () => {
    expect(validateGlossaryEntry(conversationEntry(), "personal", conversationContext)).toEqual([]);
  });

  it("accepts a four-record conversation set only when every expected anchor is present", () => {
    const context = conversationContextFor([0, 1, 2, 3]);
    expect(
      validateGlossaryEntry(
        conversationEntry([0, 1, 2, 3].map(conversationEvidence)),
        "personal",
        context,
      ),
    ).toEqual([]);
  });

  it("rejects a four-record set that omits one expected anchor even when completeness is asserted", () => {
    const context = conversationContextFor([0, 1, 2, 3, 4], [0, 1, 2, 3]);
    const errors = validateGlossaryEntry(
      conversationEntry([0, 1, 2, 4].map(conversationEvidence)),
      "personal",
      context,
    );
    expect(errors).toContain(
      "conversation inference evidence must exactly match the generation-bound anchor set",
    );
  });

  it("rejects a four-record set with a duplicate at any list length", () => {
    const context = conversationContextFor([0, 1, 2, 3]);
    const errors = validateGlossaryEntry(
      conversationEntry([0, 1, 2, 2].map(conversationEvidence)),
      "personal",
      context,
    );
    expect(errors).toContain(
      "conversation inference rejects duplicate source, anchor, or content identities",
    );
  });

  it("rejects a conversation entry without a generation-bound expected set or with a bad set digest", () => {
    expect(validateGlossaryEntry(conversationEntry(), "personal")).toContain(
      "conversation inference requires generation-bound expected evidence",
    );
    const context = conversationContextFor([0, 1, 2]);
    const badDigestContext = {
      ...context,
      conversationEvidence: {
        ...context.conversationEvidence!,
        qualifyingEvidenceSetSha256: "f".repeat(64),
      },
    };
    expect(validateGlossaryEntry(conversationEntry(), "personal", badDigestContext)).toContain(
      "conversation inference expected evidence digest is invalid",
    );
  });

  it.each([
    [
      "too few records",
      [0, 1].map(conversationEvidence),
      "conversation inference requires at least three complete retained records",
    ],
    [
      "incomplete evidence",
      [0, 1, 2].map(conversationEvidence),
      "conversation inference requires complete provenance evidence",
    ],
    [
      "duplicate origins",
      [conversationEvidence(0), conversationEvidence(0), conversationEvidence(2)],
      "conversation inference rejects duplicate source, anchor, or content identities",
    ],
  ])("rejects conversation provenance with %s", (_name, evidence, expected) => {
    const entry = conversationEntry(evidence);
    if (_name === "incomplete evidence") entry.provenance.evidence_complete = false;
    expect(validateGlossaryEntry(entry, "personal", conversationContext)).toContain(expected);
  });

  it("rejects agent-authored conversation evidence as an establishing source", () => {
    const evidence = [0, 1, 2].map(conversationEvidence);
    evidence[2]!.author_class = "agent";
    const context = {
      retainedHistory: new Map(conversationContext.retainedHistory).set(
        evidence[2]!.evidence_anchor,
        {
          ...conversationContext.retainedHistory.get(evidence[2]!.evidence_anchor)!,
          authorClass: "agent",
        },
      ),
      conversationEvidence: conversationContext.conversationEvidence,
    };
    expect(validateGlossaryEntry(conversationEntry(evidence), "personal", context)).toContain(
      "provenance.evidence[2] has inadmissible conversation provenance",
    );
  });
});

describe("personal glossary consent discriminator", () => {
  it.each([
    [
      "present",
      {
        consentStatus: "valid",
        generationStatus: "current",
        coverageStatus: "complete",
        signalTierBounded: true,
      },
    ],
    [
      "absent",
      {
        consentStatus: "absent",
        generationStatus: "current",
        coverageStatus: "complete",
        signalTierBounded: true,
      },
    ],
    [
      "absent when generation is missing",
      {
        consentStatus: "valid",
        generationStatus: "absent",
        coverageStatus: "complete",
        signalTierBounded: true,
      },
    ],
    [
      "stale",
      {
        consentStatus: "stale",
        generationStatus: "current",
        coverageStatus: "complete",
        signalTierBounded: true,
      },
    ],
    [
      "stale when generation is stale",
      {
        consentStatus: "valid",
        generationStatus: "stale",
        coverageStatus: "complete",
        signalTierBounded: true,
      },
    ],
    [
      "degraded after cap selection",
      {
        consentStatus: "valid",
        generationStatus: "current",
        coverageStatus: "cap_selected",
        signalTierBounded: true,
      },
    ],
    [
      "degraded after truncation",
      {
        consentStatus: "valid",
        generationStatus: "current",
        coverageStatus: "truncated",
        signalTierBounded: true,
      },
    ],
    [
      "degraded after flagged incompleteness",
      {
        consentStatus: "valid",
        generationStatus: "current",
        coverageStatus: "flagged_incomplete",
        signalTierBounded: true,
      },
    ],
  ])("classifies %s as one mutually exclusive state", (expected, input) => {
    expect(classifyPersonalMiningConsent(input as any)).toBe(expected.split(" ")[0]);
  });

  it("does not degrade inherent signal-tier boundedness when coverage is complete", () => {
    expect(
      classifyPersonalMiningConsent({
        consentStatus: "valid",
        generationStatus: "current",
        coverageStatus: "complete",
        signalTierBounded: true,
      }),
    ).toBe("present");
  });

  it.each([
    {
      consentStatus: "unknown",
      generationStatus: "current",
      coverageStatus: "complete",
      signalTierBounded: true,
    },
    {
      consentStatus: "valid",
      generationStatus: "unknown",
      coverageStatus: "complete",
      signalTierBounded: true,
    },
    {
      consentStatus: "valid",
      generationStatus: "current",
      coverageStatus: "unknown",
      signalTierBounded: true,
    },
    {
      consentStatus: "valid",
      generationStatus: "current",
      coverageStatus: "complete",
      signalTierBounded: "yes",
    },
  ])("rejects invalid discriminator input %j", (input) => {
    expect(() => classifyPersonalMiningConsent(input as any)).toThrow(
      "consent discriminator input is invalid",
    );
  });

  it("uses the ordered precedence absent, stale, degraded, then present", () => {
    expect(
      classifyPersonalMiningConsent({
        consentStatus: "absent",
        generationStatus: "stale",
        coverageStatus: "cap_selected",
        signalTierBounded: true,
      }),
    ).toBe("absent");
    expect(
      classifyPersonalMiningConsent({
        consentStatus: "stale",
        generationStatus: "current",
        coverageStatus: "cap_selected",
        signalTierBounded: true,
      }),
    ).toBe("stale");
    expect(
      classifyPersonalMiningConsent({
        consentStatus: "valid",
        generationStatus: "current",
        coverageStatus: "cap_selected",
        signalTierBounded: true,
      }),
    ).toBe("degraded");
  });
});

const reviewKeyPair = generateKeyPairSync("ed25519");
const reviewNow = new Date("2026-08-07T12:00:00.000Z");
const reviewVerification = {
  currentUserSubject: "user:current",
  candidateId: "candidate-a",
  candidateRevision: "revision-a",
  generation: "generation-a",
  now: reviewNow,
  trustedHostPublicKey: reviewKeyPair.publicKey,
};

function reviewReceipt(overrides: Record<string, string> = {}): Record<string, string> {
  const { signature: signatureOverride, ...overriddenFields } = overrides;
  const unsigned = {
    schema_version: "agentera.personalGlossaryReviewApproval.v1",
    issuer: "agentera-local-host",
    subject: "user:current",
    trusted_channel: "agentera-local-host-ipc",
    candidate_id: "candidate-a",
    candidate_revision: "revision-a",
    generation: "generation-a",
    disposition: "accept",
    disposed_at: "2026-08-07T11:59:00.000Z",
    expires_at: "2026-08-07T12:04:00.000Z",
    nonce: "nonce-a",
    ...overriddenFields,
  };
  const payload = JSON.stringify(unsigned);
  return {
    ...unsigned,
    signature:
      signatureOverride ??
      sign(null, Buffer.from(payload, "utf8"), reviewKeyPair.privateKey).toString("base64url"),
  };
}

describe("personal glossary review approval receipts", () => {
  it("accepts a trusted signed receipt with concrete current-user bindings", () => {
    const receipt = reviewReceipt();
    expect(validatePersonalReviewApprovalReceipt(receipt, reviewVerification)).toEqual([]);
    expect(personalReviewApprovalReplayStatus(receipt)).toBe("new");
  });

  it.each([
    ["issuer", { issuer: "agent" }, "review approval receipt issuer is not trusted"],
    [
      "subject",
      { subject: "agent" },
      "review approval receipt subject is not the trusted current user",
    ],
    [
      "channel",
      { trusted_channel: "untrusted-channel" },
      "review approval receipt trusted channel is invalid",
    ],
    [
      "candidate binding",
      { candidate_id: "candidate-b" },
      "review approval receipt candidate binding is invalid",
    ],
    [
      "revision binding",
      { candidate_revision: "revision-b" },
      "review approval receipt revision binding is invalid",
    ],
    [
      "generation binding",
      { generation: "generation-b" },
      "review approval receipt generation binding is invalid",
    ],
    [
      "stale freshness",
      { disposed_at: "2026-08-07T11:54:00.000Z" },
      "review approval receipt is stale",
    ],
    [
      "expired freshness",
      { expires_at: "2026-08-07T11:59:30.000Z" },
      "review approval receipt expires_at is not current",
    ],
    [
      "forged signature",
      { signature: "Zm9yZ2Vk" },
      "review approval receipt signature is not from the trusted host",
    ],
  ])("rejects a receipt with invalid %s", (_name, overrides, expected) => {
    expect(
      validatePersonalReviewApprovalReceipt(reviewReceipt(overrides), reviewVerification),
    ).toContain(expected);
  });

  it("allows only an exact replay as a no-op and rejects a changed nonce replay", () => {
    const receipt = reviewReceipt();
    const consumed = new Map([[receipt.nonce, personalReviewApprovalReceiptDigest(receipt)]]);
    expect(personalReviewApprovalReplayStatus(receipt, consumed)).toBe("exact_replay");
    expect(
      validatePersonalReviewApprovalReceipt(receipt, {
        ...reviewVerification,
        consumedReceiptDigests: consumed,
      }),
    ).toEqual([]);
    const changed = reviewReceipt({ nonce: receipt.nonce, disposition: "reject" });
    expect(personalReviewApprovalReplayStatus(changed, consumed)).toBe("conflicting_replay");
    expect(
      validatePersonalReviewApprovalReceipt(changed, {
        ...reviewVerification,
        consumedReceiptDigests: consumed,
      }),
    ).toContain("review approval receipt nonce was replayed with changed content");
  });

  it("maps terminal dispositions and enforces retention and purge boundaries", () => {
    expect(personalReviewDispositionLifecycle("accept")).toBe("terminal");
    expect(personalReviewDispositionLifecycle("correct")).toBe("terminal");
    expect(personalReviewDispositionLifecycle("reject")).toBe("terminal");
    expect(personalReviewDispositionLifecycle("defer")).toBe("pending");
    expect(projectPersonalReviewRetention("defer", 29)).toEqual({
      excerpt: "retained",
      metadata: "retained",
    });
    expect(projectPersonalReviewRetention("defer", 30)).toEqual({
      excerpt: "expired",
      metadata: "retained",
    });
    expect(projectPersonalReviewRetention("accept", 0)).toEqual({
      excerpt: "purged",
      metadata: "retained",
    });
    expect(projectPersonalReviewRetention("accept", 89)).toEqual({
      excerpt: "purged",
      metadata: "retained",
    });
    expect(projectPersonalReviewRetention("accept", 90)).toEqual({
      excerpt: "purged",
      metadata: "expired",
    });
    expect(projectPersonalReviewRetention("defer", 1, true)).toEqual({
      excerpt: "purged",
      metadata: "purged",
    });
    expect(projectPersonalReviewRetention("accept", 1, true)).toEqual({
      excerpt: "purged",
      metadata: "purged",
    });
  });

  it("rejects invalid retention transitions", () => {
    expect(() => personalReviewDispositionLifecycle("unknown" as any)).toThrow(
      "review disposition is invalid",
    );
    expect(() => projectPersonalReviewRetention("defer", -1)).toThrow(
      "review age must be non-negative",
    );
  });
});

describe("personal glossary term and candidate identities", () => {
  it.each([
    ["Ship Shape", "sHIP sHAPE"],
    ["ΟΣ", "οσ"],
    ["ΟΣ", "ος"],
    ["𐐀", "𐐨"],
    ["A+B (draft)?", "a+b (DRAFT)?"],
    ["line\nTERM\u0000", "LINE\nterm\u0000"],
  ])("gives existing caseless-equal vector %j and %j one stable identity", (left, right) => {
    expect(unicodeCaselessExact(left, right)).toBe(true);
    expect(stableGlossaryTermIdentity(left)).toBe(stableGlossaryTermIdentity(right));
  });

  it.each([
    ["é", "e\u0301"],
    ["resume", "résumé"],
    ["i", "İ"],
    ["I", "ı"],
    ["ß", "SS"],
    [".*", "anything"],
    ["[term]", "t"],
    ["line\nterm", "line\nterm\n"],
  ])("keeps existing distinct vector %j and %j on separate identities", (left, right) => {
    expect(unicodeCaselessExact(left, right)).toBe(false);
    expect(stableGlossaryTermIdentity(left)).not.toBe(stableGlossaryTermIdentity(right));
  });

  it("binds a separate candidate revision to meaning, evidence, policy, and generation", () => {
    const base = {
      stable_term_identity: stableGlossaryTermIdentity("cycle"),
      meaning: "one bounded implementation pass",
      scope: "personal" as const,
      evidence: [
        { source_id: "source-b", evidence_anchor: "anchor-b" },
        { source_id: "source-a", evidence_anchor: "anchor-a" },
      ],
      policy_version: "agentera.personalGlossaryMiningPolicy.v1",
      generation: "generation-a",
    };
    const revision = glossaryCandidateRevision(base);
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(glossaryCandidateRevision({ ...base, evidence: [...base.evidence].reverse() })).toBe(
      revision,
    );
    expect(glossaryCandidateRevision({ ...base, meaning: "a different meaning" })).not.toBe(
      revision,
    );
    expect(glossaryCandidateRevision({ ...base, policy_version: "policy-b" })).not.toBe(revision);
    expect(glossaryCandidateRevision({ ...base, generation: "generation-b" })).not.toBe(revision);
  });
});
