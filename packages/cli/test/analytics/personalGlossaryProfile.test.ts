import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  personalProfileGrounding,
  updatePersonalGlossaryProfile,
  type PersonalGlossaryEntry,
} from "../../src/analytics/personalGlossaryProfile.js";
import type { GlossaryAdmissionContext } from "../../src/registries/glossaryEntryContract.js";

const roots: string[] = [];
const baseProfile = "# Decision Profile: Ada\n\n<!-- keep exactly -->\n## Process\n\n### Ship\n`━ conf:91 | perm:durable | first:2026-01-01 | confirmed:2026-07-01 | challenged:—`\n";
const retainedHistory: GlossaryAdmissionContext = {
  retainedHistory: new Map([
    ["anchor-explicit", { sourceId: "source-explicit", sourceKind: "conversation_turn", signalType: "correction" }],
    ["anchor-refresh", { sourceId: "source-refresh", sourceKind: "conversation_turn", signalType: "decision" }],
    ["anchor-instruction", { sourceId: "source-instruction", sourceKind: "instruction_document", signalType: "instruction" }],
    ["anchor-config", { sourceId: "source-config", sourceKind: "project_config_signal", signalType: "configuration" }],
  ]),
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function profilePath(contents = baseProfile): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-profile-"));
  roots.push(root);
  const pathname = path.join(root, "PROFILE.md");
  fs.writeFileSync(pathname, contents);
  return pathname;
}

function explicit(overrides: Partial<PersonalGlossaryEntry> = {}): PersonalGlossaryEntry {
  return {
    term: "ship shape",
    meaning: "The complete form of a deliverable.",
    confidence: 80,
    permanence: "durable",
    temporal: { observed_at: "2026-07-01", last_confirmed_at: "2026-07-01" },
    provenance: {
      kind: "personal_explicit_definition",
      evidence: [{ source_id: "source-explicit", evidence_anchor: "anchor-explicit", signal_type: "correction" }],
    },
    ...overrides,
  } as PersonalGlossaryEntry;
}

function inferred(overrides: Partial<PersonalGlossaryEntry> = {}): PersonalGlossaryEntry {
  return {
    term: "intent seam",
    meaning: "A boundary that preserves declared intent.",
    confidence: 61,
    permanence: "stable",
    temporal: { observed_at: "2026-06-01", last_confirmed_at: "2026-07-01" },
    provenance: {
      kind: "personal_inferred_usage",
      evidence: [
        { source_id: "source-instruction", evidence_anchor: "anchor-instruction", source_kind: "instruction_document" },
        { source_id: "source-config", evidence_anchor: "anchor-config", source_kind: "project_config_signal" },
      ],
    },
    ...overrides,
  } as PersonalGlossaryEntry;
}

function document(pathname: string): any {
  const bytes = fs.readFileSync(pathname, "utf8");
  const match = /```json\n([\s\S]*?)\n```/.exec(bytes);
  if (!match) throw new Error("missing personal glossary JSON");
  return JSON.parse(match[1]);
}

function update(pathname: string, freshEntries: PersonalGlossaryEntry[], asOf = "2026-07-01") {
  return updatePersonalGlossaryProfile({
    profilePath: pathname,
    freshEntries,
    retainedHistory,
    asOf,
  });
}

describe("personal PROFILE.md glossary output", () => {
  it("first-renders one deterministic independent section with exact shared fields and anchor cardinality", () => {
    const pathname = profilePath();
    update(pathname, [explicit(), inferred()]);
    const bytes = fs.readFileSync(pathname, "utf8");
    const parsed = document(pathname);

    expect(bytes.startsWith(baseProfile)).toBe(true);
    expect(bytes.match(/## Glossary/g)).toHaveLength(1);
    expect(parsed.schema_version).toBe("agentera.personalGlossarySection.v1");
    expect(parsed.entries.map((entry: any) => Object.keys(entry))).toEqual([
      ["term", "meaning", "confidence", "permanence", "temporal", "provenance"],
      ["term", "meaning", "confidence", "permanence", "temporal", "provenance"],
    ]);
    expect(parsed.entries[0].provenance.evidence).toHaveLength(2);
    expect(parsed.entries[1].provenance.evidence).toHaveLength(1);
  });

  it("replaces only its owned bytes and preserves decision-pattern confidence exactly", () => {
    const pathname = profilePath();
    update(pathname, [explicit()]);
    const before = fs.readFileSync(pathname, "utf8");
    const start = before.indexOf("<!-- agentera:personal-glossary:start -->");
    const end = before.indexOf("<!-- agentera:personal-glossary:end -->") + "<!-- agentera:personal-glossary:end -->".length;
    const nonGlossary = before.slice(0, start) + before.slice(end);
    update(pathname, [explicit({ confidence: 88 })], "2026-07-02");
    const bytes = fs.readFileSync(pathname, "utf8");
    const replacedStart = bytes.indexOf("<!-- agentera:personal-glossary:start -->");
    const replacedEnd = bytes.indexOf("<!-- agentera:personal-glossary:end -->") + "<!-- agentera:personal-glossary:end -->".length;
    expect(bytes.slice(0, replacedStart) + bytes.slice(replacedEnd)).toBe(nonGlossary);
    expect(bytes).toContain("`━ conf:91 | perm:durable");
  });

  it.each([
    ["explicit", explicit({ provenance: { kind: "personal_explicit_definition", evidence: [] } as any }), /exactly one/],
    ["inferred", inferred({ provenance: { kind: "personal_inferred_usage", evidence: [{ source_id: "source-instruction", evidence_anchor: "anchor-instruction", source_kind: "instruction_document" }] } as any }), /exactly two/],
  ])("rejects invalid %s anchor cardinality before effects", (_kind, entry, expected) => {
    const pathname = profilePath();
    expect(() => update(pathname, [entry])).toThrow(expected);
    expect(fs.readFileSync(pathname, "utf8")).toBe(baseProfile);
  });

  it("rejects malformed, duplicate, and unowned Glossary boundaries before effects", () => {
    const cases = [
      `${baseProfile}\n<!-- agentera:personal-glossary:start -->\n## Glossary\n`,
      `${baseProfile}\n## Glossary\nmanual\n`,
      `${baseProfile}\n<!-- agentera:personal-glossary:start -->\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n<!-- agentera:personal-glossary:end -->\n<!-- agentera:personal-glossary:start -->\n## Glossary\n`,
    ];
    for (const original of cases) {
      const pathname = profilePath(original);
      expect(() => update(pathname, [explicit()])).toThrow(/Glossary section/);
      expect(fs.readFileSync(pathname, "utf8")).toBe(original);
    }
  });

  it("rejects case-insensitive duplicates and divergent established meaning before effects", () => {
    const duplicatePath = profilePath();
    expect(() => update(duplicatePath, [explicit(), explicit({ term: "SHIP SHAPE" })])).toThrow(/duplicate/i);
    expect(fs.readFileSync(duplicatePath, "utf8")).toBe(baseProfile);

    const conflictPath = profilePath();
    update(conflictPath, [explicit()]);
    const established = fs.readFileSync(conflictPath, "utf8");
    expect(() => update(conflictPath, [explicit({ term: "Ship Shape", meaning: "A weaker divergent meaning.", confidence: 31 })], "2026-07-02")).toThrow(/conflict/i);
    expect(fs.readFileSync(conflictPath, "utf8")).toBe(established);
  });

  it("uses Unicode caseless identity without normalizing distinct spellings", () => {
    const duplicatePath = profilePath();
    expect(() => update(duplicatePath, [
      explicit({ term: "ΟΣ" }),
      inferred({ term: "οσ" }),
    ])).toThrow(/duplicate/i);
    expect(fs.readFileSync(duplicatePath, "utf8")).toBe(baseProfile);

    const refreshPath = profilePath();
    update(refreshPath, [explicit({ term: "ΟΣ" })]);
    update(refreshPath, [explicit({
      term: "οσ",
      confidence: 91,
      provenance: {
        kind: "personal_explicit_definition",
        evidence: [{ source_id: "source-refresh", evidence_anchor: "anchor-refresh", signal_type: "decision" }],
      },
    })], "2026-07-02");
    expect(document(refreshPath).entries).toMatchObject([{ term: "ΟΣ", confidence: 91 }]);

    const distinctPath = profilePath();
    update(distinctPath, [explicit({ term: "é" }), inferred({ term: "e\u0301" })]);
    expect(document(distinctPath).entries.map((entry: any) => entry.term).sort()).toEqual(["é", "e\u0301"].sort());
  });

  it("is invariant to a project-glossary trap path", () => {
    const pathname = profilePath();
    const trap = path.join(path.dirname(pathname), ".agentera", "glossary.yaml");
    fs.mkdirSync(trap, { recursive: true });
    expect(() => update(pathname, [explicit()])).not.toThrow();
  });

  it("excludes exactly the validated owned range and preserves all other profile bytes", () => {
    const pathname = profilePath();
    update(pathname, [explicit()]);
    const stored = fs.readFileSync(pathname, "utf8");
    const start = stored.indexOf("<!-- agentera:personal-glossary:start -->");
    const end = stored.indexOf("<!-- agentera:personal-glossary:end -->", start)
      + "<!-- agentera:personal-glossary:end -->".length;
    expect(personalProfileGrounding(stored)).toBe(`${stored.slice(0, start)}${stored.slice(end)}`);
    expect(personalProfileGrounding(stored)).not.toContain("ship shape");
  });
});

describe("personal glossary lifecycle", () => {
  it.each([
    ["stable", 72],
    ["durable", 49],
    ["situational", 20],
  ] as const)("retains and decays %s entries with unchanged permanence", (permanence, expected) => {
    const pathname = profilePath();
    update(pathname, [explicit({ permanence, confidence: 80 })]);
    update(pathname, [], "2026-10-09");
    expect(document(pathname).entries[0]).toMatchObject({ confidence: expected, permanence });
  });

  it("applies the floor without deleting an old entry", () => {
    const pathname = profilePath();
    update(pathname, [explicit({ permanence: "situational", confidence: 21 })]);
    update(pathname, [], "2036-07-01");
    expect(document(pathname).entries).toMatchObject([{ term: "ship shape", confidence: 20, permanence: "situational" }]);
  });

  it("is same-date idempotent and derives later decay from the retained basis, not rendered confidence", () => {
    const pathname = profilePath();
    update(pathname, [explicit({ permanence: "durable", confidence: 80 })]);
    update(pathname, [], "2026-10-09");
    const once = fs.readFileSync(pathname, "utf8");
    const replay = update(pathname, [], "2026-10-09");
    expect(fs.readFileSync(pathname, "utf8")).toBe(once);
    expect(replay.changed).toBe(false);
    update(pathname, [], "2027-01-17");
    expect(document(pathname).entries[0].confidence).toBe(29);
  });

  it("refreshes matching fresh evidence while preserving establishment and permanence", () => {
    const pathname = profilePath();
    update(pathname, [explicit({ permanence: "stable", confidence: 42 })]);
    const fresh = explicit({
      term: "SHIP SHAPE",
      confidence: 91,
      permanence: "situational",
      temporal: { observed_at: "2026-07-10", last_confirmed_at: "2026-07-10" },
      provenance: {
        kind: "personal_explicit_definition",
        evidence: [{ source_id: "source-refresh", evidence_anchor: "anchor-refresh", signal_type: "decision" }],
      },
    });
    update(pathname, [fresh], "2026-07-10");
    const refreshed = fs.readFileSync(pathname, "utf8");
    expect(document(pathname).entries[0]).toMatchObject({
      term: "ship shape",
      confidence: 91,
      permanence: "stable",
      temporal: { observed_at: "2026-07-01", last_confirmed_at: "2026-07-10" },
      provenance: { evidence: [{ evidence_anchor: "anchor-refresh" }] },
    });
    expect(update(pathname, [fresh], "2026-07-10").changed).toBe(false);
    expect(fs.readFileSync(pathname, "utf8")).toBe(refreshed);
  });
});
