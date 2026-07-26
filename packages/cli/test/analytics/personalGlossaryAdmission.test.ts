import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  admitPersonalGlossaryEvidence,
  classifyExplicitGlossaryLanguage,
} from "../../src/analytics/personalGlossaryAdmission.js";
import { ADAPTER_VERSION } from "../../src/analytics/extractCorpus/core.js";
import {
  publishEvidenceTiers,
  resolveEvidenceAnchor,
} from "../../src/analytics/extractCorpus/evidenceTiers.js";

let root: string;
let tiersDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "personal-glossary-admission-"));
  tiersDir = path.join(root, "profile", "intermediate", "tiers");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function record(
  sourceId: string,
  sourceKind: string,
  signalType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source_id: sourceId,
    source_kind: sourceKind,
    timestamp: `2026-07-2${sourceId.length}T00:00:00.000Z`,
    project_id: "personal-evidence",
    runtime:
      sourceKind.includes("document") || sourceKind.includes("config") ? "filesystem" : "opencode",
    source_class: "active_runtime",
    source_product:
      sourceKind.includes("document") || sourceKind.includes("config") ? "filesystem" : "opencode",
    active_runtime: true,
    adapter_version: ADAPTER_VERSION,
    data: { ...data, signal_type: signalType },
  };
}

function publish(records: Array<Record<string, unknown>>): void {
  publishEvidenceTiers(records, {
    tiersDir,
    adapterVersion: ADAPTER_VERSION,
    publishedAt: "2026-07-26T00:00:00.000Z",
  });
}

describe("explicit personal glossary classification", () => {
  it.each([
    ["Actually, `ship shape` means the complete form of a deliverable.", "ship shape"],
    ['To clarify, I prefer "ship shape" to mean the complete form of a deliverable.', "ship shape"],
  ])("classifies supported correction or clarification language", (text, term) => {
    expect(classifyExplicitGlossaryLanguage(text)).toMatchObject({
      term,
      meaning: "the complete form of a deliverable",
    });
  });

  it("abstains from unrelated correction language", () => {
    expect(classifyExplicitGlossaryLanguage("Actually, use the smaller patch instead.")).toBeNull();
  });
});

describe("bounded personal evidence admission", () => {
  it("admits one explicit definition and resolves only authority-selected anchors", () => {
    publish([
      record("explicit", "conversation_turn", "correction", {
        actor: "user",
        text: "Actually, `ship shape` means the complete form of a deliverable.",
      }),
      record("unrelated", "conversation_turn", "question", {
        actor: "user",
        text: "Why did the test fail?",
      }),
    ]);
    const resolved: string[] = [];
    const result = admitPersonalGlossaryEvidence(
      { tiersDir, requestedTerms: [] },
      (anchor, directory) => {
        resolved.push(anchor);
        return resolveEvidenceAnchor(anchor, directory);
      },
    );

    expect(result.status).toBe("admitted");
    expect(result.candidates).toEqual([
      {
        kind: "personal_explicit_definition",
        term: "ship shape",
        meaning: "the complete form of a deliverable",
        evidence: [
          { source_id: "explicit", evidence_anchor: "explicit", signal_type: "correction" },
        ],
      },
    ]);
    expect(resolved).toEqual(["explicit"]);
  });

  it("admits supported clarification language from one decision anchor", () => {
    publish([
      record("clarification", "conversation_turn", "decision", {
        actor: "user",
        text: "To clarify, I prefer `ship shape` to mean the complete form of a deliverable.",
      }),
    ]);

    const result = admitPersonalGlossaryEvidence({ tiersDir, requestedTerms: [] });
    expect(result.candidates).toEqual([
      {
        kind: "personal_explicit_definition",
        term: "ship shape",
        meaning: "the complete form of a deliverable",
        evidence: [
          {
            source_id: "clarification",
            evidence_anchor: "clarification",
            signal_type: "decision",
          },
        ],
      },
    ]);
  });

  it("admits inferred recurrence only from two distinct instruction/config identities", () => {
    publish([
      record("instruction", "instruction_document", "instruction", {
        content: "Keep the ship shape small and independently verifiable.",
      }),
      record("configuration", "project_config_signal", "configuration", {
        signals: ["workflow:ship-shape", "policy=ship shape"],
      }),
    ]);

    const result = admitPersonalGlossaryEvidence({ tiersDir, requestedTerms: ["ship shape"] });
    expect(result.status).toBe("admitted");
    expect(result.candidates).toEqual([
      {
        kind: "personal_inferred_usage",
        term: "ship shape",
        evidence: [
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
        ],
      },
    ]);
  });

  it("rejects duplicate inferred identity and reports deterministic insufficiency", () => {
    publish([
      record("instruction", "instruction_document", "instruction", {
        content: "Ship shape means the deliverable form. Repeat ship shape here.",
      }),
    ]);

    const result = admitPersonalGlossaryEvidence({
      tiersDir,
      requestedTerms: ["ship shape", "ship shape"],
    });
    expect(result.status).toBe("insufficient");
    expect(result.candidates).toEqual([]);
    expect(result.recovery).toContain("another distinct qualifying record");
  });

  it.each(["missing", "legacy", "corrupt"] as const)(
    "returns deterministic recovery without claims for %s evidence",
    (state) => {
      const corpusPath = path.join(root, "profile", "intermediate", "corpus.json");
      if (state === "legacy") {
        fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
        fs.writeFileSync(corpusPath, "not read", "utf8");
      } else if (state === "corrupt") {
        publish([
          record("explicit", "conversation_turn", "correction", { text: "Actually, `x` means y." }),
        ]);
        const pointer = JSON.parse(
          fs.readFileSync(path.join(tiersDir, "current.json"), "utf8"),
        ) as { generation: string };
        fs.writeFileSync(
          path.join(tiersDir, "generations", pointer.generation, "signal.json"),
          "{",
          "utf8",
        );
      }

      const result = admitPersonalGlossaryEvidence({
        tiersDir,
        corpusPath,
        requestedTerms: ["ship shape"],
      });
      expect(result.state).toBe(state);
      expect(result.status).toBe("unavailable");
      expect(result.candidates).toEqual([]);
      expect(result.recovery).toBeTruthy();
    },
  );

  it("is invariant to project glossary presence and never returns its path or records", () => {
    publish([
      record("explicit", "conversation_turn", "correction", {
        text: "Actually, `ship shape` means the complete form of a deliverable.",
      }),
    ]);
    const input = { tiersDir, requestedTerms: [] };
    const absent = admitPersonalGlossaryEvidence(input);
    const glossaryPath = path.join(root, "project", ".agentera", "glossary.yaml");
    fs.mkdirSync(path.dirname(glossaryPath), { recursive: true });
    fs.writeFileSync(glossaryPath, "entries:\n  - term: forbidden-project-record\n", "utf8");
    const present = admitPersonalGlossaryEvidence(input);

    expect(present).toEqual(absent);
    expect(JSON.stringify(present)).not.toContain("glossary.yaml");
    expect(JSON.stringify(present)).not.toContain("forbidden-project-record");
  });
});
