import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  glossaryCandidateRevision,
  stableGlossaryTermIdentity,
  unicodeCaselessExact,
} from "../../src/registries/glossaryTermIdentity.js";
import {
  glossaryEntryAuthorityPath,
  personalGlossaryAdmissionContract,
  validateGlossaryEntry,
  validateGlossaryEntryContract,
  type GlossaryAdmissionContext,
} from "../../src/registries/glossaryEntryContract.js";

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
    signal_type: ["correction", "decision", "question"][index]!,
    session_id: session,
    project_id: project,
    content_fingerprint: fingerprint,
    author_class: "user",
  };
}

const conversationContext: GlossaryAdmissionContext = {
  retainedHistory: new Map(
    [0, 1, 2].map((index) => {
      const evidence = conversationEvidence(index);
      return [evidence.evidence_anchor, {
        sourceId: evidence.source_id,
        sourceKind: evidence.source_kind,
        signalType: evidence.signal_type,
        sessionId: evidence.session_id,
        projectId: evidence.project_id,
        contentFingerprint: evidence.content_fingerprint,
        authorClass: evidence.author_class,
      }];
    }),
  ),
};

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
      status: "authority_only",
      replacement: {
        shared_primitive: "shared_primitive",
        personal_owner: "ownership_contracts.personal",
        project_owner: "ownership_contracts.project",
        consumer_precedence: "consumer_boundary.primary_selection",
        project_publication: "ownership_contracts.project.publication",
      },
      admission: { inferred_automatic_admission: "disabled" },
    });
    expect(personalGlossaryAdmissionContract()).toMatchObject({
      conversationSignalTypes: ["correction", "decision", "question", "instruction", "configuration"],
      conversationSourceKinds: ["conversation_turn"],
      conversationAuthorClasses: ["user"],
      conversationMinimumEvidenceCount: 3,
      conversationAdmission: "review_only",
    });
  });

  it.each([
    [
      "replacement authority",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.replacement.project_publication =
          "personal_mining_authority";
      },
      "personal_mining_authority replacement must preserve shared primitive, isolation, consumer precedence, and Build project publication",
    ],
    [
      "term identity",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.term_identity.stable_term_identity.no_unicode_normalization =
          false;
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
      "privacy authority",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.privacy.owner = "project";
      },
      "personal_mining_authority privacy must be user-local, redacted, authenticated, retained, and purgeable",
    ],
    [
      "automatic inference gate",
      (authority: Record<string, any>) => {
        authority.personal_mining_authority.admission.inferred_automatic_admission = "enabled";
      },
      "personal_mining_authority must keep inferred automatic admission disabled and defer quality authority",
    ],
  ])("rejects drift in %s", (_name, mutate, expected) => {
    const pathname = authorityFixture(mutate);
    expect(validateGlossaryEntryContract(pathname)).toContain(expected);
    fs.rmSync(path.dirname(pathname), { recursive: true, force: true });
  });

  it("accepts complete conversation provenance and refuses to truncate its evidence contract", () => {
    expect(validateGlossaryEntry(conversationEntry(), "personal", conversationContext)).toEqual([]);
  });

  it.each([
    ["too few records", [0, 1].map(conversationEvidence), "conversation inference requires at least three complete retained records"],
    [
      "incomplete evidence",
      [0, 1, 2].map(conversationEvidence),
      "conversation inference requires complete provenance evidence",
    ],
    [
      "duplicate origins",
      [conversationEvidence(0), conversationEvidence(0), conversationEvidence(2)],
      "conversation inference requires distinct source identities, anchors, sessions, projects, and content fingerprints",
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
        { ...conversationContext.retainedHistory.get(evidence[2]!.evidence_anchor)!, authorClass: "agent" },
      ),
    };
    expect(validateGlossaryEntry(conversationEntry(evidence), "personal", context)).toContain(
      "provenance.evidence[2] has inadmissible conversation provenance",
    );
  });
});

describe("personal glossary term and candidate identities", () => {
  it("keeps existing Unicode equality while giving caseless spellings one stable identity", () => {
    expect(unicodeCaselessExact("ΟΣ", "ος")).toBe(true);
    expect(stableGlossaryTermIdentity("ΟΣ")).toBe(stableGlossaryTermIdentity("ος"));
    expect(stableGlossaryTermIdentity("K")).toBe(stableGlossaryTermIdentity("K"));
    expect(stableGlossaryTermIdentity("é")).not.toBe(stableGlossaryTermIdentity("e\u0301"));
    expect(stableGlossaryTermIdentity("ß")).not.toBe(stableGlossaryTermIdentity("SS"));
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
    expect(
      glossaryCandidateRevision({ ...base, evidence: [...base.evidence].reverse() }),
    ).toBe(revision);
    expect(glossaryCandidateRevision({ ...base, meaning: "a different meaning" })).not.toBe(revision);
    expect(glossaryCandidateRevision({ ...base, policy_version: "policy-b" })).not.toBe(revision);
    expect(glossaryCandidateRevision({ ...base, generation: "generation-b" })).not.toBe(revision);
  });
});
