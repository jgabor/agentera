import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { planV1ArtifactsPhase } from "../../src/upgrade/migrateArtifactsV1ToV2.js";
import { detectV1ArtifactPairs } from "../../src/upgrade/migrateArtifactsV2ToV3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function repoPath(...parts: string[]): string {
  return path.join(REPO_ROOT, ...parts);
}

function scanPost30CruftViolations(root: string): string[] {
  const violations: string[] = [];
  const hejSkill = path.join(root, "skills/hej");
  if (fs.existsSync(hejSkill)) {
    violations.push("skills/hej/ bridge directory present");
  }
  const v1Mapping = path.join(root, "references/v1-section-mapping.md");
  if (fs.existsSync(v1Mapping)) {
    violations.push("references/v1-section-mapping.md present");
  }
  const opencodeHej = path.join(root, ".opencode/commands/hej.md");
  if (fs.existsSync(opencodeHej)) {
    violations.push(".opencode/commands/hej.md legacy bridge command present");
  }
  const marketplacePath = path.join(root, ".claude-plugin/marketplace.json");
  if (fs.existsSync(marketplacePath)) {
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
    const pluginNames = (marketplace.plugins ?? []).map((p: { name: string }) => p.name);
    if (pluginNames.includes("status")) {
      violations.push(".claude-plugin/marketplace.json still lists hej plugin");
    }
  }
  const codexPath = path.join(root, ".codex-plugin/plugin.json");
  if (fs.existsSync(codexPath)) {
    const codex = JSON.parse(fs.readFileSync(codexPath, "utf8"));
    const codexSkills = (codex.skillMetadata ?? []).map((s: { name: string }) => s.name);
    if (codexSkills.includes("status")) {
      violations.push(".codex-plugin/plugin.json still lists hej skillMetadata");
    }
  }
  const registryPath = path.join(root, "references/adapters/package-registry.yaml");
  if (fs.existsSync(registryPath)) {
    const registry = YAML.parse(fs.readFileSync(registryPath, "utf8"));
    const versionFiles: string[] = registry.records?.[0]?.docs_targets?.version_files ?? [];
    if (versionFiles.includes("skills/hej/SKILL.md")) {
      violations.push("package-registry docs_targets still lists skills/hej/SKILL.md");
    }
  }
  const bundleVocabPath = path.join(root, "references/cli/bundle-skill-vocabulary.yaml");
  if (fs.existsSync(bundleVocabPath)) {
    const bundleVocab = YAML.parse(fs.readFileSync(bundleVocabPath, "utf8"));
    const conceptOrder: string[] = bundleVocab.canonical_concept_order ?? [];
    for (const retired of ["legacy_hej_bridge", "v1_skill_entry_file"]) {
      if (conceptOrder.includes(retired)) {
        violations.push(`bundle-skill-vocabulary still lists retired concept ${retired}`);
      }
    }
  }
  return violations;
}

describe("v1 legacy cruft removal (post-3.0 boundary)", () => {
  it("pass: repo tree has no post-3.0 bridge surfaces", () => {
    expect(scanPost30CruftViolations(REPO_ROOT)).toEqual([]);
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

  it("pass: migrateArtifactsV1ToV2 remains for Markdown→YAML migration", () => {
    const fixture = repoPath("packages/cli/test/upgrade/fixtures/v2-v1-md-project");
    const project = fixture;
    expect(detectV1ArtifactPairs(project)).toEqual([".agentera/PROGRESS.md"]);
    const phase = planV1ArtifactsPhase(project);
    expect(phase.status).toBe("pending");
    expect(phase.items[0]?.action).toBe("migrate");
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

  it("pass: documentation inventory has no Tier C bridge cleanup items", () => {
    const inventory = fs.readFileSync(repoPath("references/meta/documentation-inventory.md"), "utf8");
    expect(inventory).not.toContain("skills/hej/");
    expect(inventory).not.toContain("v1-section-mapping.md");
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
