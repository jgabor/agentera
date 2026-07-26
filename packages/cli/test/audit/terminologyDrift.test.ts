import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assessTerminologyDrift } from "../../src/audit/terminologyDrift.js";

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
});
