import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXPLICIT_GLOSSARY_REASONS,
  classifyExplicitGlossaryLanguage,
  discoverExplicitGlossaryCues,
  mineExplicitGlossaryCandidates,
} from "../../src/analytics/personalGlossaryExplicit.js";
import { admitPersonalGlossaryEvidence } from "../../src/analytics/personalGlossaryAdmission.js";
import { validateGlossaryEvidenceCapsule } from "../../src/registries/glossaryCandidateContracts.js";
import {
  ADAPTER_VERSION,
  contentFingerprint,
  originIdentity,
} from "../../src/analytics/extractCorpus/core.js";
import {
  publishEvidenceTiers,
  resolveEvidenceAnchor,
} from "../../src/analytics/extractCorpus/evidenceTiers.js";

let root: string;
let tiersDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-explicit-"));
  tiersDir = path.join(root, "profile", "intermediate", "tiers");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function record(
  sourceId: string,
  text: string,
  signalType: "correction" | "decision" = "decision",
  actor: "user" | "assistant" | undefined = "user",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    source_id: sourceId,
    source_kind: "conversation_turn",
    timestamp: "2026-08-08T00:00:00.000Z",
    project_id: "explicit-fixture",
    runtime: "opencode",
    source_class: "active_runtime",
    source_product: "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    origin_id: originIdentity(`fixture:${sourceId}`),
    content_fingerprint: contentFingerprint(text),
    session_id: `session-${sourceId}`,
    conversation_key: `session-${sourceId}`,
    data: { text, signal_type: signalType, ...(actor ? { actor } : {}), ...extra },
    ...(!actor || extra.omit_author === true ? {} : { author_class: actor }),
  };
  return result;
}

function publish(records: Array<Record<string, unknown>>): void {
  publishEvidenceTiers(records as any, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
}

describe("deterministic explicit cue recognition", () => {
  it.each([
    [
      '"ship shape" means the complete form of a deliverable.',
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "Definition: ship shape: the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "API stands for application programming interface.",
      "API",
      "application programming interface",
    ],
    [
      "By ship shape I mean the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "Use ship shape to mean the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "Use ship shape for the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "To clarify, ship shape refers to the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "To clarify, I prefer `ship shape` to mean the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "Correction: `ship shape` means the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    ["API (Application Programming Interface).", "API", "Application Programming Interface"],
  ])("recognizes %j", (text, term, meaning) => {
    expect(discoverExplicitGlossaryCues(text)).toContainEqual({
      term,
      meaning,
      term_span: expect.any(Object),
      meaning_span: expect.any(Object),
    });
    expect(classifyExplicitGlossaryLanguage(text)).toEqual({ term, meaning });
  });

  it("keeps punctuation, multiline meaning, combining marks, and multiple list entries exact", () => {
    const text =
      "`café`: first line: with detail\nsecond line\nAPI: Application Programming Interface.";
    const cues = discoverExplicitGlossaryCues(text);
    expect(cues.map(({ term, meaning }) => [term, meaning])).toEqual([
      ["API", "Application Programming Interface"],
      ["café", "first line: with detail\nsecond line"],
    ]);
    const cafe = cues.find((cue) => cue.term === "café")!;
    expect(cafe.term_span.end - cafe.term_span.start).toBe(Buffer.byteLength("café", "utf8"));
    expect(cafe.meaning).toContain(":");
  });

  it.each([
    [
      "`ship shape`: the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      '"ship shape": the complete form of a deliverable.',
      "ship shape",
      "the complete form of a deliverable",
    ],
    ["API: Application Programming Interface.", "API", "Application Programming Interface"],
    [
      "Definition: ship shape: the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "Term: ship shape: the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
    [
      "- Definition: ship shape: the complete form of a deliverable.",
      "ship shape",
      "the complete form of a deliverable",
    ],
  ])("accepts the bounded colon form %j", (text, term, meaning) => {
    expect(discoverExplicitGlossaryCues(text)).toEqual([
      expect.objectContaining({ term, meaning }),
    ]);
  });

  it.each([
    "API:\n  Application Programming Interface.",
    "- API:\n  Application Programming Interface.",
    "* `ship shape`:\n  the complete form of a deliverable.",
    "Definition: ship shape:\n  the complete form of a deliverable.",
    "- Term: ship shape:\n  the complete form of a deliverable.",
    "Definition:\n  API: Application Programming Interface.",
    "- Definition:\n  - API: Application Programming Interface.",
  ])("rejects a colon form whose meaning starts on a later line %j", (text) => {
    expect(discoverExplicitGlossaryCues(text)).toEqual([]);
  });

  it("keeps a bounded inline meaning with exact multiline continuation spans", () => {
    const text = "`café`: starts inline\ncontinues with detail.";
    const [cue] = discoverExplicitGlossaryCues(text);
    expect(cue).toEqual({
      term: "café",
      meaning: "starts inline\ncontinues with detail",
      term_span: {
        start: Buffer.byteLength("`", "utf8"),
        end: Buffer.byteLength("`café", "utf8"),
      },
      meaning_span: {
        start: Buffer.byteLength("`café`: ", "utf8"),
        end: Buffer.byteLength("`café`: starts inline\ncontinues with detail", "utf8"),
      },
    });
    expect(
      Buffer.from(text, "utf8").subarray(cue!.meaning_span.start, cue!.meaning_span.end).toString(),
    ).toBe("starts inline\ncontinues with detail");
  });

  it("applies the existing meaning bound to inline-plus-continuation colon forms", () => {
    expect(discoverExplicitGlossaryCues(`\`bounded\`: starts inline\n${"m".repeat(4097)}`)).toEqual(
      [],
    );
  });

  it.each([
    ["For example, `ship shape` means a complete form.", EXPLICIT_GLOSSARY_REASONS.exampleContext],
    ["`ship shape` does not mean a complete form.", EXPLICIT_GLOSSARY_REASONS.negatedDefinition],
    [
      "If `ship shape` means a complete form, continue.",
      EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition,
    ],
    ["Sarcasm: `ship shape` means a complete form /s", EXPLICIT_GLOSSARY_REASONS.sarcasmMarker],
    [
      "According to Alice, `ship shape` means a complete form.",
      EXPLICIT_GLOSSARY_REASONS.attributedQuotation,
    ],
    ["Alice: `ship shape` means a complete form.", EXPLICIT_GLOSSARY_REASONS.attributedQuotation],
    [
      "`ship shape` means an old form. I retract that definition.",
      EXPLICIT_GLOSSARY_REASONS.retractedDefinition,
    ],
    [
      "In this repository, `ship shape` means a repository-only form.",
      EXPLICIT_GLOSSARY_REASONS.projectOnlyScope,
    ],
  ])("rejects %j with %s", (text) => {
    expect(discoverExplicitGlossaryCues(text)).toEqual([]);
  });

  it("keeps an explicitly personal usage cue eligible", () => {
    expect(
      classifyExplicitGlossaryLanguage("I use `ship shape` to mean my complete form."),
    ).toEqual({
      term: "ship shape",
      meaning: "my complete form",
    });
  });

  it.each([
    "status: active",
    "name: configured value",
    "Notes: rollout plan",
    "RFC 2119: requirement language",
    "build status: active",
    "last updated: today",
    "release notes: next steps",
    "Meeting at 12:30",
    "Deploy at 09:45 tomorrow",
    "cache policy: active",
    "Note: ship shape: the complete form of a deliverable",
    "12:30 UTC",
    "https://example.test: source",
    "# Heading: ordinary text",
    "## API: Application Programming Interface",
    "citation [1]: quoted source",
    "[RFC 2119]: requirement language",
    "API stands for application binary interface.",
    "API: Application Binary Interface",
    '"ship shape" short for a complete form.',
  ])("rejects high-risk or unsupported syntax %j", (text) => {
    expect(discoverExplicitGlossaryCues(text)).toEqual([]);
  });

  it.each([
    [
      "Is the following definition correct? `ship shape`: a complete form.",
      EXPLICIT_GLOSSARY_REASONS.indirectQuestion,
    ],
    [
      "For example, the following term is illustrative. `ship shape`: a complete form.",
      EXPLICIT_GLOSSARY_REASONS.exampleContext,
    ],
    [
      "The following meaning will apply later. `ship shape`: a complete form.",
      EXPLICIT_GLOSSARY_REASONS.futureDefinition,
    ],
    [
      "If the following definition applies, continue. `ship shape`: a complete form.",
      EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition,
    ],
    [
      "`ship shape`: a complete form. This definition is only an example.",
      EXPLICIT_GLOSSARY_REASONS.exampleContext,
    ],
  ])("rejects an adjacent direct qualifier in %j", (text) => {
    expect(discoverExplicitGlossaryCues(text)).toEqual([]);
  });

  const directionalQualifiers = [
    ["question", "Is the following definition correct?", "Is this definition correct?"],
    [
      "example",
      "For example, the following term is illustrative.",
      "For example, this term is illustrative.",
    ],
    ["future", "The following meaning will apply later.", "This meaning will apply later."],
    [
      "hypothetical",
      "If the following definition applies, continue.",
      "If this definition applies, continue.",
    ],
  ] as const;

  it.each(directionalQualifiers)(
    "binds a preceding %s following-reference only to the next cue",
    (_label, followingReference) => {
      const text = `\`alpha\`: first meaning.\n${followingReference}\n\`beta\`: second meaning.`;
      expect(discoverExplicitGlossaryCues(text).map(({ term }) => term)).toEqual(["alpha"]);
    },
  );

  it.each(directionalQualifiers)(
    "binds a following %s this-reference only to the previous cue",
    (_label, _followingReference, thisReference) => {
      const text = `\`alpha\`: first meaning.\n${thisReference}\n\`beta\`: second meaning.`;
      expect(discoverExplicitGlossaryCues(text).map(({ term }) => term)).toEqual(["beta"]);
    },
  );

  it.each([
    ["question", "Is the release ready?"],
    ["example", "For example, the release notes changed."],
    ["future", "The deployment rule will change later."],
    ["hypothetical", "If tests pass, deploy."],
  ])("keeps both cues around unrelated middle %s prose", (_label, middle) => {
    const text = `\`alpha\`: first meaning.\n${middle}\n\`beta\`: second meaning.`;
    expect(discoverExplicitGlossaryCues(text).map(({ term }) => term)).toEqual(["alpha", "beta"]);
  });

  it.each([
    ["previous cue", "Is alpha correct?", ["beta"]],
    ["next cue", "Is beta correct?", ["alpha"]],
  ])("keeps exact literal-term binding for the %s", (_label, middle, expectedTerms) => {
    const text = `\`alpha\`: first meaning.\n${middle}\n\`beta\`: second meaning.`;
    expect(discoverExplicitGlossaryCues(text).map(({ term }) => term)).toEqual(expectedTerms);
  });

  it.each([
    "Is the release ready? `ship shape`: a complete form.",
    "For example, the release notes changed. `ship shape`: a complete form.",
    "The deployment rule will change later. `ship shape`: a complete form.",
    "If tests pass, deploy. `ship shape`: a complete form.",
  ])("keeps a definition after unrelated adjacent prose %j", (text) => {
    expect(discoverExplicitGlossaryCues(text)).toEqual([
      expect.objectContaining({ term: "ship shape", meaning: "a complete form" }),
    ]);
  });

  it("rejects adjacent project scope while retaining a directly personal definition", () => {
    expect(
      discoverExplicitGlossaryCues(
        'In this repository, the following definition applies. "ship shape" means a project form.',
      ),
    ).toEqual([]);
    expect(
      discoverExplicitGlossaryCues(
        '"ship shape" means a complete form. This definition is for the project.',
      ),
    ).toEqual([]);
    expect(
      classifyExplicitGlossaryLanguage(
        'I use "ship shape" to mean my complete form. This project has other terms.',
      ),
    ).toEqual({ term: "ship shape", meaning: "my complete form" });
  });

  it("does not let an unrelated retraction suppress a valid definition", () => {
    for (const text of [
      '"ship shape" means a complete form. I retract the project plan.',
      '"ship shape" means a complete form. I retract that unrelated note.',
    ]) {
      expect(discoverExplicitGlossaryCues(text)).toEqual([
        expect.objectContaining({ term: "ship shape", meaning: "a complete form" }),
      ]);
    }
  });

  it("does not treat two meanings for one same-anchor term as one definition", () => {
    expect(
      classifyExplicitGlossaryLanguage(
        '"ship shape" means one form. "ship shape" refers to another form.',
      ),
    ).toBeNull();
  });
});

describe("bounded explicit evidence mining", () => {
  it("emits exact spans and one resolved user anchor in a capsule", () => {
    const text = "Actually, `ship shape` means the complete form: with detail.";
    publish([record("explicit", text, "correction")]);
    const resolved: string[] = [];
    const result = mineExplicitGlossaryCandidates({ tiersDir }, (anchor, directory) => {
      resolved.push(anchor);
      return resolveEvidenceAnchor(anchor, directory);
    });
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.capsule).toMatchObject({
      term: "ship shape",
      meaning: "the complete form: with detail",
      scope: "personal",
      provenance_kind: "personal_explicit_definition",
      evidence: [{ source_id: "explicit", evidence_anchor: "explicit", signal_type: "correction" }],
      evidence_complete: true,
    });
    expect(validateGlossaryEvidenceCapsule(candidate.capsule)).toEqual([]);
    expect(candidate.term_span).toEqual({
      start: Buffer.byteLength("Actually, `", "utf8"),
      end: Buffer.byteLength("Actually, `ship shape", "utf8"),
    });
    expect(candidate.meaning_span).toEqual({
      start: Buffer.byteLength("Actually, `ship shape` means ", "utf8"),
      end: Buffer.byteLength("Actually, `ship shape` means the complete form: with detail", "utf8"),
    });
    expect(resolved).toEqual(["explicit"]);
  });

  it("gives agent, injected, and unknown provenance a stable authorship exclusion", () => {
    publish([
      record("agent", "`ship shape` means agent text.", "decision", "assistant"),
      record("injected", "`ship shape` means injected text.", "decision", "user", {
        injected: true,
      }),
      record("unknown", "`ship shape` means unknown text.", "decision", "user", {
        omit_author: true,
      }),
    ]);
    const result = mineExplicitGlossaryCandidates({ tiersDir });
    expect(result.candidates).toEqual([]);
    expect(result.abstentions.map(({ source_id, reason }) => [source_id, reason])).toEqual([
      ["agent", EXPLICIT_GLOSSARY_REASONS.userAuthorshipRequired],
      ["injected", EXPLICIT_GLOSSARY_REASONS.userAuthorshipRequired],
      ["unknown", EXPLICIT_GLOSSARY_REASONS.provenanceIncomplete],
    ]);
  });

  it("abstains before parsing when required source provenance is incomplete", () => {
    const incomplete = record("incomplete", '"ship shape" means a form.');
    delete incomplete.origin_id;
    publish([incomplete]);
    const result = mineExplicitGlossaryCandidates({ tiersDir });
    expect(result.candidates).toEqual([]);
    expect(result.abstentions).toEqual([
      {
        term: null,
        candidate_id: null,
        source_id: "incomplete",
        evidence_anchor: "incomplete",
        reason: EXPLICIT_GLOSSARY_REASONS.provenanceIncomplete,
      },
    ]);
  });

  it("rejects project-qualified definitions without a project glossary input", () => {
    publish([record("project", "In this repository, `ship shape` means a project form.")]);
    const resultWithoutGlossary = mineExplicitGlossaryCandidates({ tiersDir });
    const glossaryPath = path.join(root, "project", ".agentera", "glossary.yaml");
    fs.mkdirSync(path.dirname(glossaryPath), { recursive: true });
    fs.writeFileSync(glossaryPath, "entries:\n  - term: forbidden\n", "utf8");
    const resultWithGlossary = mineExplicitGlossaryCandidates({ tiersDir });
    expect(resultWithGlossary).toEqual(resultWithoutGlossary);
    expect(JSON.stringify(resultWithGlossary)).not.toContain("glossary.yaml");
    expect(resultWithGlossary.abstentions[0]?.reason).toBe(
      EXPLICIT_GLOSSARY_REASONS.projectOnlyScope,
    );
  });

  it("keeps the existing admission seam from admitting project or agent definitions", () => {
    publish([
      record("project-admission", "In this project, `ship shape` means a project form."),
      record("agent-admission", "`agent term` means agent text.", "decision", "assistant"),
    ]);
    const result = admitPersonalGlossaryEvidence({ tiersDir, requestedTerms: [] });
    expect(result.status).toBe("insufficient");
    expect(result.candidates).toEqual([]);
  });

  it("assigns one stable exclusion to the bounded colon rejection matrix", () => {
    const rejected = [
      ["notes", "Notes: rollout plan"],
      ["rfc-label", "RFC 2119: requirement language"],
      ["build-status", "build status: active"],
      ["last-updated", "last updated: today"],
      ["release-notes", "release notes: next steps"],
      ["meeting-time", "Meeting at 12:30"],
      ["time-sibling", "Deploy at 09:45 tomorrow"],
      ["config-sibling", "cache policy: active"],
      ["unsupported-marker", "Note: ship shape: the complete form of a deliverable"],
      ["url", "https://example.test: source"],
      ["heading", "## API: Application Programming Interface"],
      ["citation", "[RFC 2119]: requirement language"],
      ["bad-acronym", "API: Application Binary Interface"],
    ] as const;
    publish(rejected.map(([id, text]) => record(id, text)));
    const result = mineExplicitGlossaryCandidates({ tiersDir });
    expect(result.candidates).toEqual([]);
    expect(new Map(result.abstentions.map(({ source_id, reason }) => [source_id, reason]))).toEqual(
      new Map(rejected.map(([id]) => [id, EXPLICIT_GLOSSARY_REASONS.unsafeSyntax])),
    );
  });

  it("reports one stable exclusion reason for each explicit boundary", () => {
    const cases: Array<[string, string, string]> = [
      [
        "example",
        "For example, `example term` means copied text.",
        EXPLICIT_GLOSSARY_REASONS.exampleContext,
      ],
      [
        "negation",
        "`negated term` does not mean copied text.",
        EXPLICIT_GLOSSARY_REASONS.negatedDefinition,
      ],
      [
        "question",
        "Does `question term` mean copied text?",
        EXPLICIT_GLOSSARY_REASONS.questionDefinition,
      ],
      [
        "indirect question",
        "I wonder whether `indirect term` means copied text.",
        EXPLICIT_GLOSSARY_REASONS.indirectQuestion,
      ],
      [
        "future",
        "I will use `future term` to mean copied text later.",
        EXPLICIT_GLOSSARY_REASONS.futureDefinition,
      ],
      [
        "hypothetical",
        "If `hypothetical term` means copied text, continue.",
        EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition,
      ],
      [
        "sarcasm",
        "Sarcasm: `sarcastic term` means copied text /s",
        EXPLICIT_GLOSSARY_REASONS.sarcasmMarker,
      ],
      [
        "attribution",
        "According to Alice, `attributed term` means copied text.",
        EXPLICIT_GLOSSARY_REASONS.attributedQuotation,
      ],
      [
        "retraction",
        "`retracted term` means old text. I retract that definition.",
        EXPLICIT_GLOSSARY_REASONS.retractedDefinition,
      ],
      [
        "project",
        "In this repository, `project term` means project text.",
        EXPLICIT_GLOSSARY_REASONS.projectOnlyScope,
      ],
      [
        "adjacent project before",
        "In this repository, the following definition applies. `before term` means project text.",
        EXPLICIT_GLOSSARY_REASONS.projectOnlyScope,
      ],
      [
        "adjacent project after",
        "`after term` means project text. This definition is for the project.",
        EXPLICIT_GLOSSARY_REASONS.projectOnlyScope,
      ],
      [
        "adjacent question",
        "Is the following definition correct? `adjacent question term`: copied text.",
        EXPLICIT_GLOSSARY_REASONS.indirectQuestion,
      ],
      [
        "adjacent example",
        "For example, the following term is illustrative. `adjacent example term`: copied text.",
        EXPLICIT_GLOSSARY_REASONS.exampleContext,
      ],
      [
        "adjacent future",
        "The following meaning will apply later. `adjacent future term`: copied text.",
        EXPLICIT_GLOSSARY_REASONS.futureDefinition,
      ],
      [
        "adjacent hypothetical",
        "If the following definition applies, continue. `adjacent hypothetical term`: copied text.",
        EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition,
      ],
      [
        "uncertain scope",
        "In this repository, I use `uncertain term` to mean mixed text.",
        EXPLICIT_GLOSSARY_REASONS.uncertainScope,
      ],
      [
        "malformed",
        '"malformed term means malformed text.',
        EXPLICIT_GLOSSARY_REASONS.malformedSpan,
      ],
      ["empty term", '"" means missing term.', EXPLICIT_GLOSSARY_REASONS.emptyTerm],
      ["empty meaning", '"missing meaning" means', EXPLICIT_GLOSSARY_REASONS.emptyMeaning],
    ];
    publish(cases.map(([id, text]) => record(id, text)));
    const result = mineExplicitGlossaryCandidates({ tiersDir });
    expect(result.candidates).toEqual([]);
    expect(new Map(result.abstentions.map(({ source_id, reason }) => [source_id, reason]))).toEqual(
      new Map(cases.map(([id, _text, reason]) => [id, reason])),
    );
  });

  it("handles duplicate cues, conflicts, and deterministic replay order", () => {
    publish([
      record("z-definition", '"z term" means z meaning.'),
      record("a-duplicate", '"same term" means one. "same term" means one.'),
      record("b-conflict", '"conflict" means one. "conflict" refers to two.'),
    ]);
    const first = mineExplicitGlossaryCandidates({ tiersDir });
    const second = mineExplicitGlossaryCandidates({ tiersDir });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.candidates.map(({ capsule }) => capsule.term)).toEqual(["same term", "z term"]);
    expect(first.abstentions).toContainEqual(
      expect.objectContaining({
        source_id: "b-conflict",
        reason: EXPLICIT_GLOSSARY_REASONS.conflictingMeaning,
      }),
    );
  });

  it("deduplicates same meanings across anchors and abstains on global conflicts", () => {
    publish([
      record("b-same", '"same term" means one form.'),
      record("a-same", '"same term" means one form.'),
      record("a-conflict", '"conflict term" means one form.'),
      record("b-conflict", '"conflict term" means another form.'),
    ]);
    const result = mineExplicitGlossaryCandidates({ tiersDir });
    expect(result.candidates.map(({ capsule }) => capsule.term)).toEqual(["same term"]);
    expect(result.candidates[0]?.capsule.evidence).toEqual([
      { source_id: "a-same", evidence_anchor: "a-same", signal_type: "decision" },
    ]);
    expect(
      result.abstentions.filter(
        ({ reason }) => reason === EXPLICIT_GLOSSARY_REASONS.conflictingMeaning,
      ),
    ).toEqual([
      expect.objectContaining({ source_id: "a-conflict", term: "conflict term" }),
      expect.objectContaining({ source_id: "b-conflict", term: "conflict term" }),
    ]);
  });

  it.each([
    [
      "unresolved",
      (_anchor: string, _directory: string) => null,
      EXPLICIT_GLOSSARY_REASONS.unresolvedAnchor,
    ],
    [
      "stale",
      (anchor: string) => ({
        source_id: `${anchor}-stale`,
        source_kind: "conversation_turn",
        data: { text: "`x` means y", signal_type: "decision" },
      }),
      EXPLICIT_GLOSSARY_REASONS.staleAnchor,
    ],
  ])("fails closed for a %s direct anchor", (_label, resolver, reason) => {
    publish([record("anchor", "`ship shape` means a form.")]);
    const result = mineExplicitGlossaryCandidates({ tiersDir }, resolver as any);
    expect(result.candidates).toEqual([]);
    expect(result.abstentions).toEqual([
      {
        term: null,
        candidate_id: null,
        source_id: "anchor",
        evidence_anchor: "anchor",
        reason,
      },
    ]);
  });

  it("reports empty and over-bound spans instead of truncating them", () => {
    publish([
      record("empty", "`empty` means ."),
      record("large-term", `\`${"t".repeat(257)}\` means a meaning.`),
      record("large-meaning", `\`large meaning\` means ${"m".repeat(4097)}.`),
    ]);
    const result = mineExplicitGlossaryCandidates({ tiersDir });
    expect(result.candidates).toEqual([]);
    expect(result.abstentions.map(({ source_id, reason }) => [source_id, reason])).toEqual([
      ["empty", EXPLICIT_GLOSSARY_REASONS.emptyMeaning],
      ["large-meaning", EXPLICIT_GLOSSARY_REASONS.meaningBoundExceeded],
      ["large-term", EXPLICIT_GLOSSARY_REASONS.termBoundExceeded],
    ]);
  });
});
