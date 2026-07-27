import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessTerminologyDrift,
  terminologyProposalDigest,
  validateTerminologyProposal,
} from "../../src/audit/terminologyDrift.js";

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminology-drift-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const pathname = path.join(root, relative);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, content, "utf8");
  }
  return root;
}

function snapshot(root: string): string {
  const records: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(pathname);
      else
        records.push(
          `${path.relative(root, pathname)}:${crypto.createHash("sha256").update(fs.readFileSync(pathname)).digest("hex")}`,
        );
    }
  };
  visit(root);
  return records.join("\n");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("read-only terminology-drift findings", () => {
  it("proposes the best-supported project term, cites every variant, and reports personal divergence without writes", () => {
    const root = fixture({
      "src/value.ts": "export type JsonValue = string | number;\n",
      "src/config.ts": "export type Dict = Record<string, any>;\n",
      "docs/model.md": "Use JsonValue at the serialization boundary.\n",
    });
    const before = snapshot(root);

    const findings = assessTerminologyDrift({
      projectRoot: root,
      concepts: [
        {
          concept: "structured-value",
          confidence: 82,
          severity: "warning",
          terms: [
            {
              term: "JsonValue",
              evidence: [
                { source_path: "src/value.ts", line: 1 },
                { source_path: "docs/model.md", line: 1 },
              ],
            },
            { term: "Dict", evidence: [{ source_path: "src/config.ts", line: 1 }] },
            { term: "Record<string, any>", evidence: [{ source_path: "src/config.ts", line: 1 }] },
          ],
        },
      ],
      personalTerms: new Map([["structured-value", "Mapping"]]),
      deliberateDecisionConcepts: new Set(),
      trackedIssueConcepts: new Set(),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      family: "terminology_drift",
      concept: "structured-value",
      proposed_canonical_term: "JsonValue",
      severity: "warning",
      confidence: 82,
      proposal_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      personal_divergence: { personal_term: "Mapping", project_term: "JsonValue" },
    });
    expect(findings[0].variants.map((variant) => variant.term)).toEqual([
      "Dict",
      "Record<string, any>",
    ]);
    expect(
      findings[0].variants.every((variant) =>
        variant.evidence.every(
          (item) =>
            item.source_path.length > 0 &&
            item.line === 1 &&
            /^[a-f0-9]{64}$/.test(item.source_record_sha256),
        ),
      ),
    ).toBe(true);
    expect(snapshot(root)).toBe(before);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it("derives the same proposal digest from equivalent evidence and variant ordering", () => {
    const base: any = {
      family: "terminology_drift",
      concept: "structured-value",
      proposed_canonical_term: "JsonValue",
      canonical_evidence: [
        { source_path: "z.ts", line: 2, source_record_sha256: "b".repeat(64) },
        { source_path: "a.ts", line: 1, source_record_sha256: "a".repeat(64) },
      ],
      variants: [
        { term: "Record", evidence: [{ source_path: "r.ts", line: 3, source_record_sha256: "c".repeat(64) }] },
        { term: "Dict", evidence: [{ source_path: "d.ts", line: 4, source_record_sha256: "d".repeat(64) }] },
      ],
      severity: "warning",
      confidence: 82,
    };
    const reordered = {
      ...base,
      canonical_evidence: [...base.canonical_evidence].reverse(),
      variants: [...base.variants].reverse(),
    };

    expect(terminologyProposalDigest(base)).toBe(terminologyProposalDigest(reordered));
    expect(terminologyProposalDigest({ ...base, confidence: 83 })).not.toBe(
      terminologyProposalDigest(base),
    );
  });

  it("shares canonical ranking, evidence identity, and severity validation with publication", () => {
    const root = fixture({ "terms.ts": "export type JsonValue = Dict;\n" });
    const emitted = assessTerminologyDrift({
      projectRoot: root,
      concepts: [{
        concept: "structured-value",
        confidence: 60,
        severity: "warning",
        terms: [
          { term: "JsonValue", evidence: [{ source_path: "terms.ts", line: 1 }] },
          { term: "Dict", evidence: [{ source_path: "terms.ts", line: 1 }] },
        ],
      }],
      deliberateDecisionConcepts: new Set(),
      trackedIssueConcepts: new Set(),
    })[0]!;
    expect(emitted.severity).toBe("info");
    expect(validateTerminologyProposal(emitted)).toEqual({ proposal: emitted, violations: [] });

    const impossibleSeverity = { ...emitted, severity: "warning" };
    impossibleSeverity.proposal_digest = terminologyProposalDigest(impossibleSeverity);
    expect(validateTerminologyProposal(impossibleSeverity).violations).toContain(
      "confidence below 70 requires info severity",
    );

    const duplicateEvidence = structuredClone(emitted);
    duplicateEvidence.canonical_evidence.push(duplicateEvidence.canonical_evidence[0]!);
    duplicateEvidence.proposal_digest = terminologyProposalDigest(duplicateEvidence);
    expect(validateTerminologyProposal(duplicateEvidence).violations).toContain(
      "canonical_evidence identities must be distinct",
    );

    const greekDuplicate = structuredClone(emitted);
    greekDuplicate.proposed_canonical_term = "ΟΣ";
    greekDuplicate.variants[0]!.term = "οσ";
    greekDuplicate.proposal_digest = terminologyProposalDigest(greekDuplicate);
    expect(validateTerminologyProposal(greekDuplicate).violations).toContain(
      "proposal term identities must be Unicode caseless-exact unique",
    );
  });

  it("filters no-drift, weak, deliberate, tracked, and unsupported evidence without fabricating profile usage or writes", () => {
    const root = fixture({
      "src/terms.ts": [
        "export type StableName = string;",
        "export type WeakAlias = StableName;",
        "export type DecidedAlias = StableName;",
        "export type TrackedAlias = StableName;",
      ].join("\n"),
    });
    const before = snapshot(root);
    const terms = (term: string, line: number) => [
      { term: "StableName", evidence: [{ source_path: "src/terms.ts", line: 1 }] },
      { term, evidence: [{ source_path: "src/terms.ts", line }] },
    ];

    const findings = assessTerminologyDrift({
      projectRoot: root,
      concepts: [
        {
          concept: "no-drift",
          confidence: 90,
          severity: "warning",
          terms: [terms("unused", 1)[0]],
        },
        { concept: "weak", confidence: 49, severity: "warning", terms: terms("WeakAlias", 2) },
        {
          concept: "decided",
          confidence: 90,
          severity: "warning",
          terms: terms("DecidedAlias", 3),
        },
        {
          concept: "tracked",
          confidence: 90,
          severity: "warning",
          terms: terms("TrackedAlias", 4),
        },
        {
          concept: "unsupported",
          confidence: 90,
          severity: "warning",
          terms: terms("MissingAlias", 4),
        },
      ],
      deliberateDecisionConcepts: new Set(["decided"]),
      trackedIssueConcepts: new Set(["tracked"]),
    });

    expect(findings).toEqual([]);
    expect(snapshot(root)).toBe(before);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });

  it("counts path aliases for one resolved file and line as one evidence anchor", () => {
    const root = fixture({ "terms.ts": "export type Canonical = Variant;\n" });
    const before = snapshot(root);

    const findings = assessTerminologyDrift({
      projectRoot: root,
      concepts: [
        {
          concept: "path-alias",
          confidence: 90,
          severity: "warning",
          terms: [
            { term: "Canonical", evidence: [{ source_path: "terms.ts", line: 1 }] },
            {
              term: "Variant",
              evidence: [
                { source_path: "terms.ts", line: 1 },
                { source_path: "./terms.ts", line: 1 },
              ],
            },
          ],
        },
      ],
      deliberateDecisionConcepts: new Set(),
      trackedIssueConcepts: new Set(),
    });

    expect(findings[0].proposed_canonical_term).toBe("Canonical");
    expect(findings[0].variants).toEqual([
      {
        term: "Variant",
        evidence: [expect.objectContaining({ source_path: "terms.ts", line: 1 })],
      },
    ]);
    expect(snapshot(root)).toBe(before);
  });

  it("consolidates case-insensitive duplicate term candidates before ranking", () => {
    const root = fixture({ "terms.ts": "export type Alpha = Zulu | zulu;\n" });

    const findings = assessTerminologyDrift({
      projectRoot: root,
      concepts: [
        {
          concept: "duplicate-term",
          confidence: 90,
          severity: "warning",
          terms: [
            { term: "Alpha", evidence: [{ source_path: "terms.ts", line: 1 }] },
            { term: "Zulu", evidence: [{ source_path: "terms.ts", line: 1 }] },
            { term: "zulu", evidence: [{ source_path: "terms.ts", line: 1 }] },
          ],
        },
      ],
      deliberateDecisionConcepts: new Set(),
      trackedIssueConcepts: new Set(),
    });

    expect(findings[0].proposed_canonical_term).toBe("Alpha");
    expect(findings[0].variants.map((variant) => variant.term)).toEqual(["Zulu"]);
  });

  it("does not accept Dict evidence found only inside Dictionary", () => {
    const root = fixture({ "terms.ts": "export type Dictionary = JsonValue;\n" });

    expect(
      assessTerminologyDrift({
        projectRoot: root,
        concepts: [
          {
            concept: "term-boundary",
            confidence: 90,
            severity: "warning",
            terms: [
              { term: "JsonValue", evidence: [{ source_path: "terms.ts", line: 1 }] },
              { term: "Dict", evidence: [{ source_path: "terms.ts", line: 1 }] },
            ],
          },
        ],
        deliberateDecisionConcepts: new Set(),
        trackedIssueConcepts: new Set(),
      }),
    ).toEqual([]);
  });

  it("shares decomposed ID_Continue boundaries with confirmed-variant scanning", () => {
    const term = "e\u0301";
    const root = fixture({ "terms.ts": `export type é = ${term}Suffix;\n` });
    const assess = () =>
      assessTerminologyDrift({
        projectRoot: root,
        concepts: [
          {
            concept: "decomposed-boundary",
            confidence: 90,
            severity: "warning",
            terms: [
              { term: "é", evidence: [{ source_path: "terms.ts", line: 1 }] },
              { term, evidence: [{ source_path: "terms.ts", line: 1 }] },
            ],
          },
        ],
        deliberateDecisionConcepts: new Set(),
        trackedIssueConcepts: new Set(),
      });

    expect(assess()).toEqual([]);
    fs.writeFileSync(path.join(root, "terms.ts"), `export type é = (${term});\n`);
    expect(assess()).toHaveLength(1);
  });

  it("emits valid drift without fabricating absent profile evidence or mutating files", () => {
    const root = fixture({ "terms.ts": "export type JsonValue = Dict;\n" });
    const before = snapshot(root);

    const findings = assessTerminologyDrift({
      projectRoot: root,
      concepts: [
        {
          concept: "absent-profile",
          confidence: 90,
          severity: "warning",
          terms: [
            { term: "JsonValue", evidence: [{ source_path: "terms.ts", line: 1 }] },
            { term: "Dict", evidence: [{ source_path: "terms.ts", line: 1 }] },
          ],
        },
      ],
      deliberateDecisionConcepts: new Set(),
      trackedIssueConcepts: new Set(),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).not.toHaveProperty("personal_divergence");
    expect(snapshot(root)).toBe(before);
    expect(fs.existsSync(path.join(root, ".agentera/glossary.yaml"))).toBe(false);
  });
});
