import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { printUpgradeHelp } from "../../src/cli/help.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const APPLY = 'npx -y agentera@next upgrade --channel development --project "$PWD" --yes';
const DRY_RUN = 'npx -y agentera@next upgrade --channel development --project "$PWD" --dry-run';

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
  });

  it("ships no restore workflow in source or bundled upgrade guidance", () => {
    const source = fs.readFileSync(path.join(ROOT, "UPGRADE.md"), "utf8");
    const bundled = fs.readFileSync(path.join(ROOT, "packages/cli/bundle/UPGRADE.md"), "utf8");

    expect(bundled).toBe(source);
    expect(source).not.toContain("upgrade --restore");
    expect(section("UPGRADE.md", "## Upgrading v2 to v3 development channel"))
      .toMatch(/no rollback, restore, non-Git, or partial\s+workflow/);
  });
});
