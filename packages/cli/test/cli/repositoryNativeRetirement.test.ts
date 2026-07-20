import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const RETIRED_CURRENT_IMPLEMENTATIONS = [
  ".cursor/agents/agentera.md",
  ".cursor/hooks.json",
  ".github/hooks/postToolUse.json",
  ".github/hooks/preToolUse.json",
  ".github/hooks/sessionEnd.json",
  ".github/hooks/sessionStart.json",
  ".opencode/agents/agentera.md",
  ".opencode/commands/agentera.md",
  "hooks/codex-hooks.json",
  "hooks/codex-plugin-hooks.json",
] as const;

const RETIRED_PACKAGE_SURFACES = [
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".github/plugin/plugin.json",
  ".opencode/package.json",
  ".opencode/plugins/agentera.js",
  "agents/openai.yaml",
  "plugin.json",
  "plugins/agentera",
] as const;

const CANONICAL_SHARED_SKILL_DATA = [
  "skills/agentera/SKILL.md",
  "skills/agentera/agents/build.toml",
  "skills/agentera/agents/status.toml",
  "skills/agentera/capabilities/build/schemas/artifacts.yaml",
  "skills/agentera/schemas/artifacts/plan.yaml",
] as const;

const PRESERVED_MIGRATION_AND_HISTORY = [
  ".agentera/archive",
  ".agentera/migrations",
  "packages/cli/src/migrate/v2HandoffManifest.ts",
  "packages/cli/src/upgrade/installedHooksRetirement.ts",
  "packages/cli/src/upgrade/legacyAgentCleanup.ts",
  "packages/cli/src/upgrade/runtimeMigration.ts",
  "packages/cli/test/upgrade/fixtures/v2-runtime-codex-full/.codex/hooks/codex-hooks.json",
  "packages/cli/test/upgrade/fixtures/v2-runtime-cursor-full/home/.cursor/hooks.json",
  "packages/cli/test/upgrade/fixtures/v2-runtime-cursor-full/project/.cursor/hooks.json",
] as const;

describe("repository-native retirement inventory", () => {
  it("has no tracked current integration implementation or standalone OpenCode dependency boundary", () => {
    for (const relative of RETIRED_CURRENT_IMPLEMENTATIONS) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(false);
    }
  });

  it("has no current package or distribution descriptors", () => {
    for (const relative of RETIRED_PACKAGE_SURFACES) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(false);
    }
  });

  it("preserves canonical shared-skill data", () => {
    for (const relative of CANONICAL_SHARED_SKILL_DATA) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(true);
    }
  });

  it("preserves explicitly classified migration readers, fixtures, and history", () => {
    for (const relative of PRESERVED_MIGRATION_AND_HISTORY) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(true);
    }
    expect(fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8")).toContain(
      ".agents/plugins/marketplace.json",
    );
  });
});
