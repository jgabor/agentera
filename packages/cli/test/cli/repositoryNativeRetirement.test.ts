import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
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
  "packages/cli/src/registries/runtimeAdapterRegistry.ts",
] as const;

const RETIRED_PACKAGE_SURFACES = [
  ".agents/plugins/marketplace.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".github/plugin/plugin.json",
  ".opencode/plugins/agentera.js",
  "agents/openai.yaml",
  "plugin.json",
  "plugins/agentera",
] as const;

const LOCAL_OPENCODE_PACKAGE = ".opencode/package.json";

const RETIRED_CURRENT_DESCRIPTOR_DIRECTORY = "skills/agentera/agents";

const CANONICAL_SHARED_SKILL_DATA = [
  "skills/agentera/SKILL.md",
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

const RETAINED_LIFECYCLE_REFERENCES = [
  "references/adapters/runtime-lifecycle-authority.yaml",
  "references/adapters/runtime-lifecycle-adapters.yaml",
  "references/adapters/runtime-lifecycle-operation-contract.yaml",
  "references/adapters/runtime-retired-resources.yaml",
] as const;

const RETIRED_ADAPTER_REFERENCES = [
  "references/adapters/runtime-adapter-characterization.md",
  "references/adapters/runtime-adapter-interface-model.yaml",
  "references/adapters/runtime-adapter-registry.yaml",
  "references/adapters/runtime-feature-parity.md",
  "references/adapters/opencode.md",
  "references/adapters/cursor.md",
] as const;

function sourceFiles(directory = path.join(ROOT, "packages/cli/src")): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

function relative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function tracked(relativePath: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], { cwd: ROOT }).status === 0;
}

function hasCurrentDescriptorDirectory(root: string): boolean {
  return fs.existsSync(path.join(root, RETIRED_CURRENT_DESCRIPTOR_DIRECTORY));
}

function moduleReferences(source: string): string[] {
  const targets: string[] = [];
  for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)) {
    targets.push(match[1]);
  }
  return targets;
}

function resolveTypeScriptImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.resolve(path.dirname(importer), specifier.replace(/\.js$/, ".ts"));
  return relative(resolved);
}

describe("repository-native retirement inventory", () => {
  it("has no current integration implementation", () => {
    for (const relative of RETIRED_CURRENT_IMPLEMENTATIONS) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(false);
    }
  });

  it("has no retired package or distribution descriptors", () => {
    for (const relative of RETIRED_PACKAGE_SURFACES) {
      expect(fs.existsSync(path.join(ROOT, relative)), relative).toBe(false);
    }
  });

  it("does not retain the local OpenCode dependency boundary in source", () => {
    expect(tracked(LOCAL_OPENCODE_PACKAGE)).toBe(false);
  });

  it("has no current native descriptor directory", () => {
    expect(hasCurrentDescriptorDirectory(ROOT)).toBe(false);
  });

  it("flags a reintroduced current descriptor directory while allowing migration-only history", () => {
    const root = fs.mkdtempSync(path.join(import.meta.dirname, "native-descriptor-"));
    try {
      fs.mkdirSync(path.join(root, ".agentera/archive/legacy/skills/agentera/agents"), { recursive: true });
      fs.writeFileSync(path.join(root, ".agentera/archive/legacy/skills/agentera/agents/build.toml"), "historical\n");
      expect(hasCurrentDescriptorDirectory(root)).toBe(false);

      fs.mkdirSync(path.join(root, RETIRED_CURRENT_DESCRIPTOR_DIRECTORY), { recursive: true });
      expect(hasCurrentDescriptorDirectory(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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

  it("retains only the closed migration lifecycle reference set", () => {
    for (const reference of RETAINED_LIFECYCLE_REFERENCES) {
      expect(fs.existsSync(path.join(ROOT, reference)), reference).toBe(true);
    }
    for (const reference of RETIRED_ADAPTER_REFERENCES) {
      expect(fs.existsSync(path.join(ROOT, reference)), reference).toBe(false);
    }

    const authority = YAML.parse(fs.readFileSync(path.join(ROOT, RETAINED_LIFECYCLE_REFERENCES[0]), "utf8"));
    expect(authority).toMatchObject({ status: "migration_only_authority", active_runtimes: [] });
    const adapters = YAML.parse(fs.readFileSync(path.join(ROOT, RETAINED_LIFECYCLE_REFERENCES[1]), "utf8"));
    expect(adapters).toMatchObject({
      status: "migration_only_contract",
      native_policy: { execution: "forbidden" },
      shared_resources: [],
      managed_resources: [],
      adapters: [],
    });
    const operations = YAML.parse(fs.readFileSync(path.join(ROOT, RETAINED_LIFECYCLE_REFERENCES[2]), "utf8"));
    expect(operations).toMatchObject({
      status: "migration_only_contract",
      native_policy: { install_update_auth_trust_operations: "forbidden" },
    });
    const cleanup = YAML.parse(fs.readFileSync(path.join(ROOT, RETAINED_LIFECYCLE_REFERENCES[3]), "utf8"));
    expect(cleanup).toMatchObject({
      status: "resource_retirement_contract",
      policy: { selection: "native_agentera_resource_only" },
      cutover_deletion_inventory: {
        schema_version: "agentera.v2CutoverDeletionInventory.v1",
        approval_gate: "approved_stable_cutover",
        policy: "delete_only_after_approved_stable_cutover",
      },
    });
    const deletionEntries = cleanup.cutover_deletion_inventory.entries as Array<{ path: string }>;
    expect(deletionEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "packages/cli/src/upgrade/runtimeMigration.ts" }),
      expect.objectContaining({ path: "packages/cli/shim/lib/exec.mjs" }),
      expect.objectContaining({ path: "packages/cli/test/upgrade/fixtures/v2-*" }),
    ]));
    for (const entry of deletionEntries) {
      if (entry.path.endsWith("*")) continue;
      expect(fs.existsSync(path.join(ROOT, entry.path)), entry.path).toBe(true);
    }
  });

  it("closes normal entrypoints to exact migration, cleanup, and ownership edges", () => {
    const files = sourceFiles();
    const edges = files.flatMap((file) => {
      const importer = relative(file);
      if (importer.startsWith("packages/cli/src/runtime/")) return [];
      return moduleReferences(fs.readFileSync(file, "utf8"))
        .map((specifier) => resolveTypeScriptImport(file, specifier))
        .filter((target): target is string => target !== null && (
          /^packages\/cli\/src\/runtime\/(?:lifecycle[^/]+|nativeResourceCleanup)\.ts$/.test(target)
          || target === "packages/cli/src/upgrade/lifecycleUpgrade.ts"
        ))
        .map((target) => `${importer} -> ${target}`);
    }).sort();
    expect(edges).toEqual([
      "packages/cli/src/cli/dispatch/lifecycle.ts -> packages/cli/src/runtime/nativeResourceCleanup.ts",
      "packages/cli/src/migrate/v2HandoffManifest.ts -> packages/cli/src/runtime/lifecycleOwnershipJournal.ts",
      "packages/cli/src/upgrade/appContentRefresh.ts -> packages/cli/src/runtime/lifecyclePublication.ts",
      "packages/cli/src/upgrade/doctor.ts -> packages/cli/src/runtime/lifecycleOwnershipJournal.ts",
      "packages/cli/src/upgrade/lifecycleUpgrade.ts -> packages/cli/src/runtime/lifecycleOperations.ts",
      "packages/cli/src/upgrade/lifecycleUpgrade.ts -> packages/cli/src/runtime/lifecycleOwnershipJournal.ts",
      "packages/cli/src/upgrade/lifecycleUpgrade.ts -> packages/cli/src/runtime/lifecyclePublication.ts",
      "packages/cli/src/upgrade/lifecycleUpgrade.ts -> packages/cli/src/runtime/nativeResourceCleanup.ts",
      "packages/cli/src/upgrade/migrationPublication.ts -> packages/cli/src/runtime/lifecyclePublication.ts",
      "packages/cli/src/upgrade/retiredResourceDiagnostics.ts -> packages/cli/src/runtime/nativeResourceCleanup.ts",
      "packages/cli/src/upgrade/upgradeOrchestrator.ts -> packages/cli/src/upgrade/lifecycleUpgrade.ts",
      "packages/cli/src/validate/activationConjunction.ts -> packages/cli/src/runtime/lifecycleAuthority.ts",
      "packages/cli/src/validate/activationConjunction.ts -> packages/cli/src/runtime/nativeResourceCleanup.ts",
    ]);

    const referenceOwners = Object.fromEntries(RETAINED_LIFECYCLE_REFERENCES.map((reference) => [
      reference,
      files.filter((file) => fs.readFileSync(file, "utf8").includes(reference)).map(relative).sort(),
    ]));
    expect(referenceOwners).toEqual({
      "references/adapters/runtime-lifecycle-authority.yaml": [
        "packages/cli/src/runtime/lifecycleAuthority.ts",
        "packages/cli/src/validate/activationConjunction.ts",
      ],
      "references/adapters/runtime-lifecycle-adapters.yaml": [
        "packages/cli/src/runtime/lifecycleAuthority.ts",
      ],
      "references/adapters/runtime-lifecycle-operation-contract.yaml": [
        "packages/cli/src/runtime/lifecycleOperations.ts",
      ],
      "references/adapters/runtime-retired-resources.yaml": [
        "packages/cli/src/runtime/lifecycleAuthority.ts",
        "packages/cli/src/validate/activationConjunction.ts",
      ],
    });

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const stale of RETIRED_ADAPTER_REFERENCES) {
        expect(source, `${relative(file)} reads ${stale}`).not.toContain(stale);
      }
      expect(source, `${relative(file)} references retired RuntimeAdapter registry`).not.toContain(
        "runtimeAdapterRegistry",
      );
    }
  });
});
