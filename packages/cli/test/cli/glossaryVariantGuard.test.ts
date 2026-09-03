import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { scanConfirmedVariantViolations } from "../../src/validate/glossaryVariantGuard.js";
import { assessTerminologyDrift } from "../../src/audit/terminologyDrift.js";
import type { TerminologyDriftFinding } from "../../src/audit/terminologyDrift.js";
import { main } from "../../src/cli/dispatch.js";
import { confirmedVariantGuardContract } from "../../src/registries/glossaryEntryContract.js";

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-glossary-guard-"));
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function publishConfirmedSet(root: string, canonical = "JsonValue", variant = "LegacyJsonValue", concept = "structured value"): string {
  fs.writeFileSync(path.join(root, "terms.ts"), `export type ${canonical} = ${variant};\n`);
  fs.writeFileSync(path.join(root, "terms-extra.ts"), `export type Canonical = ${canonical};\n`);
  const proposal = assessTerminologyDrift({
    projectRoot: root,
    concepts: [
      {
        concept,
        confidence: 84,
        severity: "warning",
        terms: [
          {
            term: canonical,
            evidence: [
              { source_path: "terms.ts", line: 1 },
              { source_path: "terms-extra.ts", line: 1 },
            ],
          },
          { term: variant, evidence: [{ source_path: "terms.ts", line: 1 }] },
        ],
      },
    ],
    deliberateDecisionConcepts: new Set(),
    trackedIssueConcepts: new Set(),
  })[0]!;
  const request = {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal,
    confirmation: {
      proposal_digest: proposal.proposal_digest,
      confirmed_by: "user",
      confirmed_at: "2026-07-26T14:00:00Z",
    },
  };
  const rc = main(["node", "agentera", "state", "glossary", "publish", "--input", "-", "--format", "json", "--project", root], { out: () => {}, err: () => {}, stdin: () => JSON.stringify(request) });
  expect(rc).toBe(0);
  return proposal.proposal_digest;
}

function publishProposal(root: string, proposal: TerminologyDriftFinding): { rc: number; json: any } {
  const request = {
    schema_version: "agentera.glossaryPublicationRequest.v1",
    proposal,
    confirmation: {
      proposal_digest: proposal.proposal_digest,
      confirmed_by: "user",
      confirmed_at: "2026-07-26T14:00:00Z",
    },
  };
  let out = "";
  const rc = main(["node", "agentera", "state", "glossary", "publish", "--input", "-", "--format", "json", "--project", root], {
    out: (text) => {
      out += text;
    },
    err: () => {},
    stdin: () => JSON.stringify(request),
  });
  return { rc, json: JSON.parse(out) };
}

function validateState(root: string): { rc: number; json: any } {
  let out = "";
  const rc = main(["node", "agentera", "check", "validate", "state", "--cwd", root, "--format", "json"], {
    out: (text) => {
      out += text;
    },
    err: () => {},
  });
  return { rc, json: JSON.parse(out) };
}

function snapshot(root: string): Record<string, string> {
  const files: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push([path.relative(root, target), fs.readFileSync(target).toString("hex")]);
    }
  };
  visit(root);
  return Object.fromEntries(files);
}

describe("confirmed glossary variant guard", () => {
  it("passes through the active state validator without a glossary or mutation", () => {
    const root = project();
    try {
      const before = snapshot(root);
      expect(scanConfirmedVariantViolations(root)).toEqual([]);
      expect(validateState(root)).toMatchObject({
        rc: 0,
        json: { command: "check validate state", status: "pass", valid: true, issues: [] },
      });
      expect(snapshot(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes through the active state validator when variants remain only in retained evidence", () => {
    const root = project();
    try {
      publishConfirmedSet(root);
      const before = snapshot(root);
      expect(validateState(root)).toMatchObject({
        rc: 0,
        json: { status: "pass", valid: true, issue_count: 0, issues: [] },
      });
      expect(snapshot(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed project glossary state with recovery", () => {
    const root = project();
    try {
      fs.writeFileSync(path.join(root, ".agentera/glossary.yaml"), "schema_version: wrong\napprovals: []\nentries: []\n");
      const violations = scanConfirmedVariantViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatch(/glossary.*malformed.*state glossary publish/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a reintroduced confirmed variant once with canonical evidence and correction", () => {
    const root = project();
    try {
      const digest = publishConfirmedSet(root);
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/reintroduced.ts"), "type T = LegacyJsonValue | LegacyJsonValue;\n");
      const violations = scanConfirmedVariantViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("LegacyJsonValue");
      expect(violations[0]).toContain("JsonValue");
      expect(violations[0]).toContain("src/reintroduced.ts:1");
      expect(violations[0]).toContain(`approval ${digest}`);
      expect(violations[0]).toContain("terms.ts:1");
      expect(violations[0]).toContain("npx -y agentera@next check validate state");
      expect(scanConfirmedVariantViolations(root)).toEqual(violations);
      const validation = validateState(root);
      expect(validation.rc).toBe(1);
      expect(validation.json).toMatchObject({ status: "fail", valid: false, issue_count: 1 });
      expect(validation.json.issues[0]).toMatchObject({
        code: "confirmed_glossary_variant",
        artifact: "glossary",
      });
      expect(validation.json.issues[0].message).toContain("canonical term 'JsonValue'");
      expect(validation.json.issues[0].message).toContain("src/reintroduced.ts:1");
      expect(validation.json.issues[0].message).toContain("Correction: replace 'LegacyJsonValue' with 'JsonValue'");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["Greek sigma control", "ΟΣ", "οσx"],
    ["Turkish dotted-I", "İ", "i\u0307"],
    ["composed/decomposed accent", "é", "e\u0301"],
    ["regex metacharacter", "A+B", "A*B"],
    ["non-BMP", "𐐀", "𐐨x"],
  ])("scans an accepted caseless-distinct %s variant", (label, canonical, variant) => {
    const root = project();
    try {
      publishConfirmedSet(root, canonical, variant, label);
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/reintroduced.ts"), `type Reintroduced = ${variant};\n`);

      const violations = scanConfirmedVariantViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(`confirmed variant '${variant}'`);
      expect(violations[0]).toContain(`canonical term '${canonical}'`);
      expect(violations[0]).toContain("src/reintroduced.ts:1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a decomposed variant inside ID_Continue identifiers", () => {
    const root = project();
    const variant = "e\u0301";
    try {
      publishConfirmedSet(root, "é", variant, "decomposed boundary");
      fs.mkdirSync(path.join(root, "src"));
      const target = path.join(root, "src/reintroduced.ts");
      fs.writeFileSync(target, [`type A = ${variant}Suffix;`, `type B = Prefix${variant};`, `type C = ${variant}\u200Cnext;`].join("\n"));
      expect(scanConfirmedVariantViolations(root)).toEqual([]);

      fs.writeFileSync(target, `const value = (${variant});\n`);
      const violations = scanConfirmedVariantViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("src/reintroduced.ts:1");
      expect(violations[0]).toContain(`confirmed variant '${variant}'`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cannot accept the Audit collision experiment or emit contradictory guard corrections", () => {
    const root = project();
    try {
      publishConfirmedSet(root);
      fs.writeFileSync(path.join(root, "request.ts"), "export type RequestEnvelope = LegacyJsonValue;\n");
      fs.writeFileSync(path.join(root, "request-extra.ts"), "export type RequestEnvelope = string;\n");
      const overlapping = assessTerminologyDrift({
        projectRoot: root,
        concepts: [
          {
            concept: "request envelope",
            confidence: 84,
            severity: "warning",
            terms: [
              {
                term: "RequestEnvelope",
                evidence: [
                  { source_path: "request.ts", line: 1 },
                  { source_path: "request-extra.ts", line: 1 },
                ],
              },
              { term: "LegacyJsonValue", evidence: [{ source_path: "request.ts", line: 1 }] },
            ],
          },
        ],
        deliberateDecisionConcepts: new Set(),
        trackedIssueConcepts: new Set(),
      })[0]!;
      expect(publishProposal(root, overlapping).rc).not.toBe(0);
      fs.rmSync(path.join(root, "request.ts"));
      fs.rmSync(path.join(root, "request-extra.ts"));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/reintroduced.ts"), "LegacyJsonValue\n");

      const violations = scanConfirmedVariantViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("canonical term 'JsonValue'");
      expect(violations[0]).not.toContain("RequestEnvelope");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exact case-sensitive boundaries and does not treat the canonical term as a variant", () => {
    const root = project();
    try {
      publishConfirmedSet(root);
      fs.writeFileSync(path.join(root, "negative.ts"), "type A = legacyJsonValue; type B = LegacyJsonValueSuffix; type C = JsonValue;\n");
      expect(scanConfirmedVariantViolations(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes every authority-declared directory by exact basename but scans a nearby source name", () => {
    const root = project();
    try {
      publishConfirmedSet(root);
      const excluded = confirmedVariantGuardContract().excludedDirectories;
      expect(excluded).toContain(".venv");
      expect(excluded).toContain(".vite");
      expect(excluded).toContain("target");
      for (const directory of excluded) {
        const target = path.join(root, directory, "nested", "generated.ts");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "LegacyJsonValue\n");
      }
      const nearby = path.join(root, "targeted", "source.ts");
      fs.mkdirSync(path.dirname(nearby), { recursive: true });
      fs.writeFileSync(nearby, "LegacyJsonValue\n");
      const violations = scanConfirmedVariantViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("targeted/source.ts:1");
      for (const directory of excluded) {
        expect(violations.join("\n")).not.toContain(`${directory}/nested/generated.ts`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
