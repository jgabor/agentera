import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { printUpgradeHelp } from "../../src/cli/help.js";
import { buildSchemaPayload } from "../../src/cli/commands/schema.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const APPLY = 'npx -y agentera@next upgrade --channel development --project "$PWD" --yes';
const DRY_RUN = 'npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run';
const STALE_CURRENT_CLEANUP_PHRASE = /\bClaude(?:-only| resource)? cleanup\b/i;

function section(file: string, heading: string): string {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`${heading} is missing from ${file}`);
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

describe("v2-to-v3 one-command guidance", () => {
  it("keeps help, upgrade guidance, skill guidance, and authority on one public contract", () => {
    const help = printUpgradeHelp();
    const guide = section("UPGRADE.md", "## Upgrading v2 to v3 development channel");
    const skill = section("skills/agentera/SKILL.md", "### Upgrade from v2 to v3 development");
    const authority = YAML.parse(fs.readFileSync(path.join(ROOT, "references/artifacts/state-storage-authority.yaml"), "utf8"));
    const schema = JSON.stringify(buildSchemaPayload());

    for (const surface of [help, guide, skill]) {
      expect(surface).toContain(APPLY);
      expect(surface).toContain(DRY_RUN);
      expect(surface).toMatch(/tracked by Git|Git worktree/);
      expect(surface).toMatch(/unchanged at [`"]?HEAD|tracked and unchanged at HEAD/);
      expect(surface).toMatch(/one-way/);
      expect(surface).toMatch(/no rollback|returning to v2 is unsupported/);
      expect(surface).toContain("restore");
      expect(surface).toContain("non-Git");
      expect(surface).toMatch(/partial|--only cannot be used/);
      expect(surface).not.toContain("state migrate entities");
      expect(surface).not.toMatch(/migration[_ -]id|source fingerprint|preview digest|receipt|staging/i);
    }

    expect(authority.entity_migration.invocation).toMatchObject({
      explicit_apply: "full_upgrade_yes_only",
      read_only_command: DRY_RUN,
      apply_command: APPLY,
    });
    expect(authority.entity_migration.internal_migration_diagnostic).toBe(true);
    expect(buildSchemaPayload()).not.toHaveProperty("entity_migration");
    expect(schema).not.toMatch(/state_migration|state_backfill|entity_migration|state migrate entities/);
  });

  it("ships no restore workflow in source upgrade guidance", () => {
    const source = fs.readFileSync(path.join(ROOT, "UPGRADE.md"), "utf8");

    expect(source).not.toContain("upgrade --restore");
    expect(section("UPGRADE.md", "## Upgrading v2 to v3 development channel"))
      .toMatch(/no rollback, restore, non-Git, or partial\s+workflow/);
  });

  it("keeps current cleanup narratives native while preserving Claude-specific examples and history", () => {
    const activeIntegration = section("UPGRADE.md", "## Active integration");
    expect(activeIntegration).toContain("no\ncurrent-runtime selector or installation behavior");
    expect(activeIntegration).toContain("only automatic\nnative-resource operation is bounded retirement of the proven historical\nOpenCode plugin");
    expect(activeIntegration).not.toContain("no\ncurrent-runtime selector or native-resource operation set");
    const currentUpgradeNarratives = [
      activeIntegration,
      section("UPGRADE.md", "## Verification and recovery"),
      section("UPGRADE.md", "## Mutation ownership"),
      section("CHANGELOG.md", "## [Unreleased]"),
    ];

    for (const narrative of currentUpgradeNarratives) {
      expect(narrative).toContain("native Agentera resource cleanup");
      expect(narrative).not.toMatch(STALE_CURRENT_CLEANUP_PHRASE);
    }

    for (const phrase of ["Claude cleanup", "Claude-only cleanup", "Claude resource cleanup"]) {
      expect(phrase).toMatch(STALE_CURRENT_CLEANUP_PHRASE);
    }
    for (const allowed of [
      "claude.agentera-skill-link",
      "--import-source claude",
      "optional Claude live-smoke",
      "Claude Code historical transcript import",
    ]) {
      expect(allowed).not.toMatch(STALE_CURRENT_CLEANUP_PHRASE);
    }
    const cleanupGuide = section("UPGRADE.md", "## Native Agentera resource cleanup");
    expect(cleanupGuide).toContain("claude.agentera-skill-link");
    expect(cleanupGuide).toContain("--import-source claude");
    expect(section("CHANGELOG.md", "## [2.2.0] · 2026-05-07"))
      .toContain("optional Claude live-smoke");
  });
});
