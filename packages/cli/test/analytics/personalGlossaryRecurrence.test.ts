import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contentFingerprint,
  originIdentity,
  ADAPTER_VERSION,
} from "../../src/analytics/extractCorpus/core.js";
import { glossaryEvidenceSetDigest } from "../../src/registries/glossaryMiningAuthority.js";
import { stableGlossaryTermIdentity } from "../../src/registries/glossaryTermIdentity.js";
import {
  mineRecurringGlossaryCandidates,
  RECURRING_REASONS,
} from "../../src/analytics/personalGlossaryRecurrence.js";
import {
  publishEvidenceTiers,
  resolveEvidenceAnchor,
} from "../../src/analytics/extractCorpus/evidenceTiers.js";

let root: string;
let tiersDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-recurrence-"));
  tiersDir = path.join(root, "profile", "intermediate", "tiers");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

interface RecordOptions {
  projectId?: string;
  origin?: string;
  originId?: string;
  fingerprint?: string;
  contentFingerprint?: string;
  omitOrigin?: boolean;
  omitFingerprint?: boolean;
  sessionId?: string;
  authorClass?: "user" | "agent";
}

function evidenceRecord(
  sourceId: string,
  sourceKind: "instruction_document" | "project_config_signal" | "conversation_turn",
  signalType: "instruction" | "configuration" | "correction" | "decision" | "question",
  data: Record<string, unknown>,
  options: RecordOptions = {},
): Record<string, unknown> {
  const content = String(
    data.text ??
      data.prompt ??
      data.content ??
      (data.signals as string[] | undefined)?.join("\n") ??
      sourceId,
  );
  const record: Record<string, unknown> = {
    source_id: sourceId,
    source_kind: sourceKind,
    timestamp: `2026-08-08T00:00:${String(sourceId.length).padStart(2, "0")}.000Z`,
    project_id: options.projectId ?? `project-${sourceId}`,
    runtime: sourceKind === "conversation_turn" ? "opencode" : "filesystem",
    source_class: sourceKind === "conversation_turn" ? "active_runtime" : "project",
    source_product: sourceKind === "conversation_turn" ? "opencode" : "filesystem",
    active_runtime: sourceKind === "conversation_turn",
    adapter_version: ADAPTER_VERSION,
    data: { ...data, signal_type: signalType },
  };
  if (!options.omitOrigin) {
    record.origin_id = options.originId ?? originIdentity(options.origin ?? `origin:${sourceId}`);
  }
  if (!options.omitFingerprint) {
    record.content_fingerprint =
      options.contentFingerprint ?? options.fingerprint ?? contentFingerprint(content);
  }
  if (sourceKind === "conversation_turn") {
    record.session_id = options.sessionId ?? `session-${sourceId}`;
    record.conversation_key = record.session_id;
    record.author_class = options.authorClass ?? "user";
  }
  return record;
}

function publish(records: Array<Record<string, unknown>>): void {
  publishEvidenceTiers(records, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
}

function generation(): string {
  return (
    JSON.parse(fs.readFileSync(path.join(tiersDir, "current.json"), "utf8")) as {
      generation: string;
    }
  ).generation;
}

function conversationExpectation(sourceIds: string[]) {
  return {
    generation: generation(),
    qualifyingEvidenceAnchors: sourceIds,
    qualifyingEvidenceSetSha256: glossaryEvidenceSetDigest(generation(), sourceIds),
  };
}

function requested(result: ReturnType<typeof mineRecurringGlossaryCandidates>, term: string) {
  return result.candidates.find((candidate) => candidate.capsule.term === term);
}

function abstentionFor(result: ReturnType<typeof mineRecurringGlossaryCandidates>, term: string) {
  return result.abstentions.find((abstention) => abstention.term === term);
}

function candidateForIdentity(
  result: ReturnType<typeof mineRecurringGlossaryCandidates>,
  term: string,
) {
  const identity = stableGlossaryTermIdentity(term);
  return result.candidates.find((candidate) => candidate.capsule.candidate_id === identity);
}

function abstentionForIdentity(
  result: ReturnType<typeof mineRecurringGlossaryCandidates>,
  term: string,
) {
  const identity = stableGlossaryTermIdentity(term);
  return result.abstentions.find((abstention) => abstention.candidate_id === identity);
}

function mineLexicalTerms(terms: readonly string[]) {
  publish([
    evidenceRecord("instruction", "instruction_document", "instruction", {
      content: `Keep ${terms.join(", ")}.`,
    }),
    evidenceRecord("configuration", "project_config_signal", "configuration", {
      signals: [...terms],
    }),
  ]);
  return mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: terms });
}

describe("recurring personal glossary mining", () => {
  it("emits one review candidate with both approved instruction/configuration origins", () => {
    publish([
      evidenceRecord(
        "instruction",
        "instruction_document",
        "instruction",
        { content: "Keep the signal-braid explicit." },
        { projectId: "project-a" },
      ),
      evidenceRecord(
        "configuration",
        "project_config_signal",
        "configuration",
        { signals: ["signal-braid"] },
        { projectId: "project-b" },
      ),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["signal-braid"] });
    const candidate = requested(result, "signal-braid");

    expect(candidate).toBeDefined();
    expect(candidate?.outcome).toBe("review_required");
    expect(candidate?.reason).toBe(RECURRING_REASONS.inferredUsageRequiresReview);
    expect(candidate?.capsule.provenance_kind).toBe("personal_inferred_usage");
    expect(candidate?.capsule.scope).toBe("ambiguous");
    expect(candidate?.capsule.evidence).toEqual([
      {
        source_id: "configuration",
        evidence_anchor: "configuration",
        source_kind: "project_config_signal",
      },
      {
        source_id: "instruction",
        evidence_anchor: "instruction",
        source_kind: "instruction_document",
      },
    ]);
    expect(candidate?.capsule).not.toHaveProperty("admission");
    expect(candidate?.capsule).not.toHaveProperty("decision");
  });

  it("abstains when the instruction/configuration route has copied content", () => {
    const fingerprint = "a".repeat(64);
    publish([
      evidenceRecord(
        "instruction",
        "instruction_document",
        "instruction",
        { content: "Keep signal-braid." },
        { fingerprint, projectId: "project-a" },
      ),
      evidenceRecord(
        "configuration",
        "project_config_signal",
        "configuration",
        { signals: ["signal-braid"] },
        { fingerprint, projectId: "project-b" },
      ),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["signal-braid"] });
    expect(requested(result, "signal-braid")).toBeUndefined();
    expect(result.abstentions).toContainEqual({
      term: "signal-braid",
      candidate_id: expect.any(String),
      reason: RECURRING_REASONS.copiedContent,
    });
  });

  it("abstains when distinct records repeat one transported origin", () => {
    publish([
      evidenceRecord(
        "instruction-a",
        "instruction_document",
        "instruction",
        { content: "Keep signal-braid." },
        { origin: "shared-origin", projectId: "project-a" },
      ),
      evidenceRecord(
        "instruction-b",
        "instruction_document",
        "instruction",
        { content: "Verify signal-braid." },
        { origin: "shared-origin", projectId: "project-b" },
      ),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["signal-braid"] });
    expect(requested(result, "signal-braid")).toBeUndefined();
    expect(abstentionFor(result, "signal-braid")?.reason).toBe(RECURRING_REASONS.copiedContent);
  });

  it("abstains from a conversation recurrence confined to one session", () => {
    const records = [
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-one", projectId: "project-b" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
    ];
    publish(records);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(["turn-a", "turn-b", "turn-c"]),
    });
    expect(requested(result, "orbit")).toBeUndefined();
    expect(abstentionFor(result, "orbit")?.reason).toBe(RECURRING_REASONS.insufficientSessions);
  });

  it("abstains when conversation evidence does not span two projects", () => {
    const records = [
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-two", projectId: "project-a" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-two", projectId: "project-a" },
      ),
    ];
    publish(records);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(["turn-a", "turn-b", "turn-c"]),
    });
    expect(abstentionFor(result, "orbit")?.reason).toBe(RECURRING_REASONS.insufficientProjects);
  });

  it("does not let agent-only conversation text establish a term", () => {
    publish([
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        { sessionId: "session-one", projectId: "project-a", authorClass: "agent" },
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-two", projectId: "project-b", authorClass: "agent" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-two", projectId: "project-a", authorClass: "agent" },
      ),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["orbit"] });
    expect(abstentionFor(result, "orbit")?.reason).toBe(RECURRING_REASONS.agentOnlyEvidence);
  });

  it("requires enough user-authored support when user and agent records are mixed", () => {
    publish([
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-two", projectId: "project-b" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-two", projectId: "project-a", authorClass: "agent" },
      ),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["orbit"] });
    expect(abstentionFor(result, "orbit")?.reason).toBe(RECURRING_REASONS.userAuthorshipRequired);
  });

  it("abstains from project-only configuration context without reading project glossary state", () => {
    publish([
      evidenceRecord(
        "config-a",
        "project_config_signal",
        "configuration",
        { signals: ["project-token"] },
        { projectId: "project-a" },
      ),
      evidenceRecord(
        "config-b",
        "project_config_signal",
        "configuration",
        { signals: ["project-token"] },
        { projectId: "project-a" },
      ),
    ]);
    const trap = path.join(root, "project", ".agentera", "glossary.yaml");
    fs.mkdirSync(path.dirname(trap), { recursive: true });
    fs.writeFileSync(trap, "term: must-not-be-read\n", "utf8");

    const readFile = vi.spyOn(fs, "readFileSync");
    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["project-token"] });
    const trapReads = readFile.mock.calls.filter(([pathname]) =>
      String(pathname).endsWith("glossary.yaml"),
    );
    readFile.mockRestore();
    expect(result.candidates).toEqual([]);
    expect(abstentionFor(result, "project-token")?.reason).toBe(RECURRING_REASONS.projectOnlyScope);
    expect(trapReads).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("glossary.yaml");
    expect(JSON.stringify(result)).not.toContain("must-not-be-read");
  });

  it("classifies project-only conversation groups before constructing a candidate", () => {
    const records = [
      evidenceRecord(
        "project-turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit project decision", scope: "project" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "project-turn-b",
        "conversation_turn",
        "question",
        { text: "orbit project question", scope: "project" },
        { sessionId: "session-two", projectId: "project-b" },
      ),
      evidenceRecord(
        "project-turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit project correction", scope: "project" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
    ];
    publish(records);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(
        records.map((record) => String(record.source_id)),
      ),
    });
    expect(requested(result, "orbit")).toBeUndefined();
    expect(abstentionFor(result, "orbit")?.reason).toBe(RECURRING_REASONS.projectOnlyScope);
  });

  it.each([
    ["missing origin", { omitOrigin: true } as RecordOptions],
    ["invalid fingerprint", { contentFingerprint: "not-a-sha256" } as RecordOptions],
  ])("abstains when %s provenance cannot establish independence", (_name, invalidOptions) => {
    publish([
      evidenceRecord(
        "instruction",
        "instruction_document",
        "instruction",
        { content: "Keep signal-braid." },
        invalidOptions,
      ),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: ["signal-braid"],
      }),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["signal-braid"] });
    expect(requested(result, "signal-braid")).toBeUndefined();
    expect(abstentionFor(result, "signal-braid")?.reason).toBe(RECURRING_REASONS.provenanceMissing);
  });

  it.each([
    ["missing conversation origin", { omitOrigin: true } as RecordOptions],
    ["invalid conversation fingerprint", { contentFingerprint: "not-a-sha256" } as RecordOptions],
  ])("abstains from %s before conversation independence counts", (_name, invalidOptions) => {
    const records = [
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        invalidOptions,
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-two", projectId: "project-b" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
    ];
    publish(records);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(
        records.map((record) => String(record.source_id)),
      ),
    });
    expect(requested(result, "orbit")).toBeUndefined();
    expect(abstentionFor(result, "orbit")?.reason).toBe(RECURRING_REASONS.provenanceMissing);
  });

  it("keeps conflicting meaning in a review-bound candidate", () => {
    publish([
      evidenceRecord("instruction", "instruction_document", "instruction", {
        content: "orbit means a small release",
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: ["orbit means a large release"],
      }),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["orbit"] });
    const candidate = requested(result, "orbit");
    expect(candidate?.outcome).toBe("review_required");
    expect(candidate?.reason).toBe(RECURRING_REASONS.conflictingMeaning);
    expect(candidate?.capsule.scope).toBe("ambiguous");
    expect(candidate?.capsule).not.toHaveProperty("automatic_admission");
  });

  it("retains the complete generation-bound conversation anchor set", () => {
    const records = [
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-two", projectId: "project-b" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
    ];
    publish(records);
    const expected = conversationExpectation(["turn-a", "turn-b", "turn-c"]);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: expected,
    });
    const candidate = requested(result, "orbit");
    expect(candidate?.capsule.provenance_kind).toBe("personal_inferred_conversation");
    expect(candidate?.capsule.evidence).toHaveLength(3);
    expect(candidate?.capsule.evidence.map((item) => item.evidence_anchor).sort()).toEqual([
      "turn-a",
      "turn-b",
      "turn-c",
    ]);
  });

  it("retains valid surplus conversation evidence up to the contract bound", () => {
    const records = Array.from({ length: 100 }, (_, index) =>
      evidenceRecord(
        `surplus-${index}`,
        "conversation_turn",
        index % 2 === 0 ? "decision" : "question",
        { text: `orbit marker ${index}` },
        {
          sessionId: index % 2 === 0 ? "session-one" : "session-two",
          projectId: index % 2 === 0 ? "project-a" : "project-b",
        },
      ),
    );
    publish(records);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(
        records.map((record) => String(record.source_id)),
      ),
    });
    const candidate = requested(result, "orbit");
    expect(candidate?.capsule.evidence).toHaveLength(100);
    expect(candidate?.capsule.evidence.map((item) => item.evidence_anchor).sort()).toEqual(
      records.map((record) => String(record.source_id)).sort(),
    );
  });

  it("keeps sufficient user evidence when an agent corroborates it", () => {
    const userRecords = [
      evidenceRecord(
        "user-a",
        "conversation_turn",
        "decision",
        { text: "orbit user decision" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "user-b",
        "conversation_turn",
        "question",
        { text: "orbit user question" },
        { sessionId: "session-two", projectId: "project-b" },
      ),
      evidenceRecord(
        "user-c",
        "conversation_turn",
        "correction",
        { text: "orbit user correction" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
    ];
    publish([
      ...userRecords,
      evidenceRecord(
        "agent-a",
        "conversation_turn",
        "decision",
        { text: "orbit agent corroboration" },
        { sessionId: "session-two", projectId: "project-b", authorClass: "agent" },
      ),
    ]);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(
        userRecords.map((record) => String(record.source_id)),
      ),
    });
    const candidate = requested(result, "orbit");
    expect(candidate?.outcome).toBe("review_required");
    expect(candidate?.capsule.evidence.map((item) => item.evidence_anchor).sort()).toEqual([
      "user-a",
      "user-b",
      "user-c",
    ]);
    expect(JSON.stringify(candidate)).not.toContain("agent-a");
  });

  it("abstains on an invalid generation-bound conversation anchor set", () => {
    const records = [
      evidenceRecord(
        "turn-a",
        "conversation_turn",
        "decision",
        { text: "orbit decision one" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
      evidenceRecord(
        "turn-b",
        "conversation_turn",
        "question",
        { text: "orbit question two" },
        { sessionId: "session-two", projectId: "project-b" },
      ),
      evidenceRecord(
        "turn-c",
        "conversation_turn",
        "correction",
        { text: "orbit correction three" },
        { sessionId: "session-one", projectId: "project-a" },
      ),
    ];
    publish(records);
    const expected = conversationExpectation(["turn-a", "turn-b", "turn-c"]);
    expected.qualifyingEvidenceAnchors = ["turn-a", "turn-a", "turn-c"];
    expected.qualifyingEvidenceSetSha256 = "f".repeat(64);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: expected,
    });
    expect(requested(result, "orbit")).toBeUndefined();
    expect(abstentionFor(result, "orbit")?.reason).toBe(
      RECURRING_REASONS.conversationEvidenceIncomplete,
    );
  });

  it("returns a stable bound abstention instead of truncating over-bound conversation evidence", () => {
    const records = Array.from({ length: 101 }, (_, index) =>
      evidenceRecord(
        `over-bound-${index}`,
        "conversation_turn",
        index % 2 === 0 ? "decision" : "question",
        { text: `orbit marker ${index}` },
        {
          sessionId: index % 2 === 0 ? "session-one" : "session-two",
          projectId: index % 2 === 0 ? "project-a" : "project-b",
        },
      ),
    );
    publish(records);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: ["orbit"],
      conversationEvidence: conversationExpectation(
        records.map((record) => String(record.source_id)),
      ),
    });
    expect(requested(result, "orbit")).toBeUndefined();
    expect(abstentionFor(result, "orbit")?.reason).toBe(
      RECURRING_REASONS.conversationEvidenceBoundExceeded,
    );
  });

  it("reviews rather than inventing a meaning when scope cues conflict", () => {
    publish([
      evidenceRecord("instruction", "instruction_document", "instruction", {
        content: "orbit project-only usage",
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: ["orbit personal-only usage"],
      }),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["orbit"] });
    const candidate = requested(result, "orbit");
    expect(candidate?.outcome).toBe("review_required");
    expect(candidate?.reason).toBe(RECURRING_REASONS.uncertainScope);
    expect(candidate?.capsule.scope).toBe("ambiguous");
  });

  it("abstains rather than truncating more than two instruction/configuration origins", () => {
    publish([
      evidenceRecord("instruction-a", "instruction_document", "instruction", {
        content: "Keep signal-braid.",
      }),
      evidenceRecord("instruction-b", "instruction_document", "instruction", {
        content: "Verify signal-braid.",
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: ["signal-braid"],
      }),
    ]);

    const result = mineRecurringGlossaryCandidates({ tiersDir, requestedTerms: ["signal-braid"] });
    expect(requested(result, "signal-braid")).toBeUndefined();
    expect(abstentionFor(result, "signal-braid")?.reason).toBe(
      RECURRING_REASONS.tooManyQualifyingOrigins,
    );
  });

  it.each([
    [
      "common grammar and workflow terms",
      ["the", "when", "configuration", "repository"],
      ["theory", "whenever", "configuraptor", "repositorycraft"],
    ],
    [
      "routine frequency terms",
      ["always", "often", "routinely", "usually"],
      ["alwayson", "oftenware", "routinecraft", "usualist"],
    ],
    [
      "exact known command spellings",
      [
        "gitstatus",
        "git-status",
        "git_status",
        "git.status",
        "git/status",
        "git\\status",
        "git status",
        "GIT-STATUS",
        "npmtest",
        "npm-test",
        "npm_test",
        "npm.test",
        "npm/test",
        "npm\\test",
        "npm test",
        "NPM-TEST",
      ],
      ["gitstatusline", "npmtester", "legit-status"],
    ],
    [
      "direct and approved derived path spellings",
      [
        "/tmp/path",
        "src/path.ts",
        "src\\path.ts",
        "SRC/PATH.TS",
        "tmp-path",
        "src_path",
        "node_modules",
      ],
      ["homebrew", "pathfinder", "signal-path"],
    ],
  ])("pairs rejected and eligible boundaries for %s", (_className, noiseTerms, eligibleTerms) => {
    const result = mineLexicalTerms([...noiseTerms, ...eligibleTerms]);

    for (const term of noiseTerms) {
      expect(candidateForIdentity(result, term), term).toBeUndefined();
      expect(abstentionForIdentity(result, term)?.reason, term).toBe(RECURRING_REASONS.noiseTerm);
    }
    for (const term of eligibleTerms) {
      expect(candidateForIdentity(result, term)?.reason, term).toBe(
        RECURRING_REASONS.inferredUsageRequiresReview,
      );
      expect(abstentionForIdentity(result, term), term).toBeUndefined();
    }
  });

  it("rejects leading-dot paths without leaking basenames and preserves non-path near misses", () => {
    const directPath = ".config";
    const nestedPath = "workspace/.config/tool";
    const nearMisses = ["hidden-glyph", "signal-path"];
    publish([
      evidenceRecord("instruction", "instruction_document", "instruction", {
        content: `${directPath}, ${nestedPath}, ${nearMisses.join(", ")}.`,
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: [directPath, nestedPath, ...nearMisses],
      }),
    ]);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: [directPath, nestedPath, ...nearMisses],
    });
    for (const term of [directPath, nestedPath]) {
      expect(candidateForIdentity(result, term), term).toBeUndefined();
      expect(abstentionForIdentity(result, term)?.reason, term).toBe(RECURRING_REASONS.noiseTerm);
    }
    for (const term of nearMisses) {
      expect(candidateForIdentity(result, term)?.reason, term).toBe(
        RECURRING_REASONS.inferredUsageRequiresReview,
      );
    }

    const unfiltered = mineRecurringGlossaryCandidates({ tiersDir });
    expect(unfiltered.candidates.map((candidate) => candidate.capsule.term)).not.toContain(
      "config",
    );
  });

  it("preserves exact precomposed and decomposed terms but rejects a leading combining mark", () => {
    const precomposed = "žargon-λ";
    const decomposed = "z\u030Cargon-λ";
    const leadingMark = "\u030Cargon-λ";
    const decomposedAfterSeparator = "glyph-z\u030C";
    const markImmediatelyAfterSeparator = "glyph-\u030Cz";
    publish([
      evidenceRecord("instruction", "instruction_document", "instruction", {
        content: `Keep \`${precomposed}\`, \`${decomposed}\`, \`${leadingMark}\`, \`${decomposedAfterSeparator}\`, and \`${markImmediatelyAfterSeparator}\` personal.`,
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: [
          precomposed,
          decomposed,
          leadingMark,
          decomposedAfterSeparator,
          markImmediatelyAfterSeparator,
        ],
      }),
    ]);

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      requestedTerms: [
        precomposed,
        decomposed,
        leadingMark,
        decomposedAfterSeparator,
        markImmediatelyAfterSeparator,
      ],
    });
    const precomposedCandidate = requested(result, precomposed);
    const decomposedCandidate = requested(result, decomposed);
    expect(precomposedCandidate?.capsule.term).toBe(precomposed);
    expect(decomposedCandidate?.capsule.term).toBe(decomposed);
    expect(precomposedCandidate?.reason).toBe(RECURRING_REASONS.inferredUsageRequiresReview);
    expect(decomposedCandidate?.reason).toBe(RECURRING_REASONS.inferredUsageRequiresReview);
    expect(precomposedCandidate?.capsule.candidate_id).toBe(
      stableGlossaryTermIdentity(precomposed),
    );
    expect(decomposedCandidate?.capsule.candidate_id).toBe(stableGlossaryTermIdentity(decomposed));
    expect(precomposedCandidate?.capsule.candidate_id).not.toBe(
      decomposedCandidate?.capsule.candidate_id,
    );
    expect(candidateForIdentity(result, leadingMark)).toBeUndefined();
    expect(abstentionForIdentity(result, leadingMark)?.reason).toBe(RECURRING_REASONS.noiseTerm);
    expect(requested(result, decomposedAfterSeparator)?.capsule.term).toBe(
      decomposedAfterSeparator,
    );
    expect(candidateForIdentity(result, markImmediatelyAfterSeparator)).toBeUndefined();
    expect(abstentionForIdentity(result, markImmediatelyAfterSeparator)?.reason).toBe(
      RECURRING_REASONS.noiseTerm,
    );
    expect(result.candidates.map((candidate) => candidate.capsule.term)).not.toContain("argon-λ");
    expect(result.candidates.map((candidate) => candidate.capsule.term)).not.toContain("glyph");
  });

  it("replays identical bounded evidence byte-for-byte", () => {
    const records = [
      evidenceRecord("instruction", "instruction_document", "instruction", {
        content: "Keep signal-braid.",
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: ["signal-braid"],
      }),
    ];
    publish(records);
    const input = { tiersDir, requestedTerms: ["signal-braid"] };
    expect(mineRecurringGlossaryCandidates(input)).toEqual(mineRecurringGlossaryCandidates(input));
  });

  it("does not read a legacy corpus or unbounded history", () => {
    const corpusPath = path.join(root, "profile", "intermediate", "corpus.json");
    fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
    fs.writeFileSync(corpusPath, "legacy sentinel must not be read", "utf8");

    const result = mineRecurringGlossaryCandidates({
      tiersDir,
      corpusPath,
      requestedTerms: ["orbit"],
    });
    expect(result.state).toBe("legacy");
    expect(result.candidates).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("legacy sentinel");
  });

  it("uses only direct bounded anchor resolution", () => {
    publish([
      evidenceRecord("instruction", "instruction_document", "instruction", {
        content: "Keep signal-braid.",
      }),
      evidenceRecord("configuration", "project_config_signal", "configuration", {
        signals: ["signal-braid"],
      }),
    ]);
    const anchors: string[] = [];
    const result = mineRecurringGlossaryCandidates(
      { tiersDir, requestedTerms: ["signal-braid"] },
      (anchor, directory) => {
        anchors.push(anchor);
        return resolveEvidenceAnchor(anchor, directory);
      },
    );
    expect(requested(result, "signal-braid")).toBeDefined();
    expect(anchors.sort()).toEqual(["configuration", "instruction"]);
  });
});
