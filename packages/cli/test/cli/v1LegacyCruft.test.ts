import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { detectV1ArtifactPairs } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  scanPost30CruftViolations,
} from "../../src/validate/v1LegacyCruft.js";
import { assessTerminologyDrift } from "../../src/audit/terminologyDrift.js";
import type { TerminologyDriftFinding } from "../../src/audit/terminologyDrift.js";
import { main } from "../../src/cli/dispatch.js";
import { confirmedVariantGuardContract } from "../../src/registries/glossaryEntryContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-cruft-"));
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function publishConfirmedSet(
  root: string,
  canonical = "JsonValue",
  variant = "LegacyJsonValue",
  concept = "structured value",
): string {
  fs.writeFileSync(path.join(root, "terms.ts"), `export type ${canonical} = ${variant};\n`);
  fs.writeFileSync(path.join(root, "terms-extra.ts"), `export type Canonical = ${canonical};\n`);
  const proposal = assessTerminologyDrift({
    projectRoot: root,
    concepts: [{
      concept,
      confidence: 84,
      severity: "warning",
      terms: [
        { term: canonical, evidence: [
          { source_path: "terms.ts", line: 1 },
          { source_path: "terms-extra.ts", line: 1 },
        ] },
        { term: variant, evidence: [{ source_path: "terms.ts", line: 1 }] },
      ],
    }],
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
  const rc = main(
    ["node", "agentera", "state", "glossary", "publish", "--input", "-", "--format", "json", "--project", root],
    { out: () => {}, err: () => {}, stdin: () => JSON.stringify(request) },
  );
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
  const rc = main(
    ["node", "agentera", "state", "glossary", "publish", "--input", "-", "--format", "json", "--project", root],
    { out: (text) => { out += text; }, err: () => {}, stdin: () => JSON.stringify(request) },
  );
  return { rc, json: JSON.parse(out) };
}

describe("v1 legacy cruft removal (post-3.0 boundary)", () => {
  it("pass: repo tree has no post-3.0 bridge surfaces", () => {
    expect(scanPost30CruftViolations(REPO_ROOT)).toEqual([]);
  });

  it("passes without a glossary and preserves the existing fixed guard behavior", () => {
    const root = project();
    try {
      expect(scanPost30CruftViolations(root)).toEqual([]);
      fs.mkdirSync(path.join(root, "skills/hej"), { recursive: true });
      expect(scanPost30CruftViolations(root)).toContain("skills/hej/ bridge directory present");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed project glossary state with recovery", () => {
    const root = project();
    try {
      fs.writeFileSync(path.join(root, ".agentera/glossary.yaml"), "schema_version: wrong\napprovals: []\nentries: []\n");
      const violations = scanPost30CruftViolations(root);
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
      const violations = scanPost30CruftViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("LegacyJsonValue");
      expect(violations[0]).toContain("JsonValue");
      expect(violations[0]).toContain("src/reintroduced.ts:1");
      expect(violations[0]).toContain(`approval ${digest}`);
      expect(violations[0]).toContain("terms.ts:1");
      expect(violations[0]).toContain("pnpm -C packages/cli exec vitest run test/cli/v1LegacyCruft.test.ts");
      expect(scanPost30CruftViolations(root)).toEqual(violations);
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

      const violations = scanPost30CruftViolations(root);
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
      fs.writeFileSync(
        target,
        [`type A = ${variant}Suffix;`, `type B = Prefix${variant};`, `type C = ${variant}\u200Cnext;`].join("\n"),
      );
      expect(scanPost30CruftViolations(root)).toEqual([]);

      fs.writeFileSync(target, `const value = (${variant});\n`);
      const violations = scanPost30CruftViolations(root);
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
        concepts: [{
          concept: "request envelope",
          confidence: 84,
          severity: "warning",
          terms: [
            { term: "RequestEnvelope", evidence: [
              { source_path: "request.ts", line: 1 },
              { source_path: "request-extra.ts", line: 1 },
            ] },
            { term: "LegacyJsonValue", evidence: [{ source_path: "request.ts", line: 1 }] },
          ],
        }],
        deliberateDecisionConcepts: new Set(),
        trackedIssueConcepts: new Set(),
      })[0]!;
      expect(publishProposal(root, overlapping).rc).not.toBe(0);
      fs.rmSync(path.join(root, "request.ts"));
      fs.rmSync(path.join(root, "request-extra.ts"));
      fs.mkdirSync(path.join(root, "src"));
      fs.writeFileSync(path.join(root, "src/reintroduced.ts"), "LegacyJsonValue\n");

      const violations = scanPost30CruftViolations(root);
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
      fs.writeFileSync(
        path.join(root, "negative.ts"),
        "type A = legacyJsonValue; type B = LegacyJsonValueSuffix; type C = JsonValue;\n",
      );
      expect(scanPost30CruftViolations(root)).toEqual([]);
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
      const violations = scanPost30CruftViolations(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("targeted/source.ts:1");
      for (const directory of excluded) {
        expect(violations.join("\n")).not.toContain(`${directory}/nested/generated.ts`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fail: scan flags reintroduced skills/hej bridge directory", () => {
    const tmp = fs.mkdtempSync(path.join(repoPath("packages/cli/test/cli"), "v1-cruft-"));
    try {
      fs.mkdirSync(path.join(tmp, "skills/hej"), { recursive: true });
      expect(scanPost30CruftViolations(tmp)).toContain("skills/hej/ bridge directory present");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pass: v1-section-mapping.md is absent from references/", () => {
    expect(fs.existsSync(repoPath("references/v1-section-mapping.md"))).toBe(false);
  });

  it("fail: scan flags reintroduced v1-section-mapping.md", () => {
    const tmp = fs.mkdtempSync(path.join(repoPath("packages/cli/test/cli"), "v1-cruft-"));
    try {
      fs.mkdirSync(path.join(tmp, "references"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "references/v1-section-mapping.md"), "# stale\n", "utf8");
      expect(scanPost30CruftViolations(tmp)).toContain("references/v1-section-mapping.md present");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pass: v1 Markdown is detectable but has no conversion implementation", () => {
    const fixture = repoPath("packages/cli/test/upgrade/fixtures/v2-v1-md-project");
    expect(detectV1ArtifactPairs(fixture)).toEqual([".agentera/PROGRESS.md"]);
    expect(fs.existsSync(repoPath("packages/cli/src/upgrade/migrateArtifactsV1ToV2.ts"))).toBe(false);
  });

  it("fail: scan flags marketplace hej plugin reintroduction", () => {
    const tmp = fs.mkdtempSync(path.join(repoPath("packages/cli/test/cli"), "v1-cruft-"));
    try {
      fs.mkdirSync(path.join(tmp, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".claude-plugin/marketplace.json"),
        JSON.stringify({ metadata: { version: "3.0.0" }, plugins: [{ name: "status" }] }),
        "utf8",
      );
      expect(scanPost30CruftViolations(tmp)).toContain(
        ".claude-plugin/marketplace.json still lists hej plugin",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fail: scan flags codex hej skillMetadata reintroduction", () => {
    const tmp = fs.mkdtempSync(path.join(repoPath("packages/cli/test/cli"), "v1-cruft-"));
    try {
      fs.mkdirSync(path.join(tmp, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".codex-plugin/plugin.json"),
        JSON.stringify({ skillMetadata: [{ name: "status" }] }),
        "utf8",
      );
      expect(scanPost30CruftViolations(tmp)).toContain(
        ".codex-plugin/plugin.json still lists hej skillMetadata",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pass: package-registry docs_targets omit skills/hej/SKILL.md", () => {
    const registry = YAML.parse(fs.readFileSync(repoPath("references/adapters/package-registry.yaml"), "utf8"));
    const versionFiles: string[] = registry.records[0].docs_targets.version_files;
    expect(versionFiles).not.toContain("skills/hej/SKILL.md");
    expect(versionFiles).toContain("skills/agentera/SKILL.md");
  });

  it("fail: scan flags package-registry skills/hej version file", () => {
    const tmp = fs.mkdtempSync(path.join(repoPath("packages/cli/test/cli"), "v1-cruft-"));
    try {
      fs.mkdirSync(path.join(tmp, "references/adapters"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "references/adapters/package-registry.yaml"),
        YAML.stringify({
          records: [{ docs_targets: { version_files: ["skills/hej/SKILL.md"] } }],
        }),
        "utf8",
      );
      expect(scanPost30CruftViolations(tmp)).toContain(
        "package-registry docs_targets still lists skills/hej/SKILL.md",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
