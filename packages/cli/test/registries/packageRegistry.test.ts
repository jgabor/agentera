import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  PackageRegistry,
  RegistryError,
  loadRegistry,
  validateRegistryData,
} from "../../src/registries/packageRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REGISTRY_PATH = path.join(REPO_ROOT, "references/adapters/package-registry.yaml");
const PACKAGE_MANIFEST_PATH = path.join(REPO_ROOT, "registry.json");

function registryFixture(): any {
  const data = YAML.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  expect(typeof data).toBe("object");
  return data;
}

function manifestSuiteVersion(): string {
  return JSON.parse(fs.readFileSync(PACKAGE_MANIFEST_PATH, "utf8")).skills[0].version;
}

describe("package registry", () => {
  it("returns package facts in deterministic order without duplicate ids", () => {
    const registry = loadRegistry(REGISTRY_PATH);

    expect(registry.packageIds).toEqual(["agentera"]);
    expect(registry.suiteVersion()).toBe(manifestSuiteVersion());
    expect(registry.packageIds.length).toBe(new Set(registry.packageIds).size);
    expect(registry.versionSurfaceIds()).toEqual([
      "registry",
      "python-project",
      "copilot-root",
      "copilot-repository",
      "codex-plugin",
      "claude-marketplace-metadata",
      "claude-marketplace-plugins",
      "opencode-plugin-marker",
    ]);
    expect(registry.versionSurfaceIds().length).toBe(new Set(registry.versionSurfaceIds()).size);
    expect(registry.runtimeManifestIds()).toEqual([
      "copilot-root-manifest",
      "copilot-repository-manifest",
      "codex-plugin-manifest",
      "cursor-plugin-manifest",
      "claude-marketplace-manifest",
      "opencode-package-manifest",
    ]);
    const record = registry.get("agentera");
    expect(record.bundle_surfaces.directories.slice(0, 3).map((d: any) => d.id)).toEqual([
      "skills",
      "scripts",
      "hooks",
    ]);
    expect(record.package_commands.commands.map((c: any) => c.id)).toEqual([
      "remove-legacy-skills",
      "install-agentera-skill-claude",
      "install-agentera-skill-opencode",
    ]);
    expect(record.docs_targets.version_files.at(-1)).toBe("registry.json");
  });

  it("gives clear diagnostics for known and unknown ids", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    expect(registry.get("agentera").identity.skill_path).toBe("skills/agentera");
    expect(() => registry.get("ghost")).toThrow(RegistryError);
    try {
      registry.get("ghost");
    } catch (err) {
      expect((err as Error).message).toBe("unknown package id: ghost");
    }
  });

  it("reports malformed fixtures clearly", () => {
    const fixture = registryFixture();
    const malformed = structuredClone(fixture);
    delete malformed.records[0].docs_targets;
    malformed.records.push(structuredClone(fixture.records[0]));
    malformed.records[0].version_surfaces.surfaces[1].id = "registry";
    malformed.records[0].version_surfaces.surfaces[2].path = "missing/plugin.json";
    malformed.records[0].package_commands.commands[1].argv =
      "npx skills add jgabor/agentera -g -a claude-code --skill agentera -y";
    malformed.records[0].version_authority.install_root = "~/.agents/agentera";
    malformed.records[0].identity.lifecycle_events = [];

    const errors = validateRegistryData(malformed, REPO_ROOT);

    expect(errors).toContain("records[0]: missing required group docs_targets");
    expect(errors).toContain("duplicate package id: agentera");
    expect(errors).toContain("records[0].version_surfaces.surfaces: duplicate id registry");
    expect(errors).toContain(
      "records[0].version_surfaces.surfaces[2].path unknown path: missing/plugin.json",
    );
    expect(errors).toContain("records[0].package_commands.commands[1].argv must be a list of strings");
    expect(errors).toContain("records[0].version_authority: forbidden install-root field install_root");
    expect(errors).toContain("records[0].identity: forbidden RuntimeAdapter field lifecycle_events");
  });

  it("consumer views share changed fixture facts", () => {
    const fixture = registryFixture();
    const changed = structuredClone(fixture);
    changed.records[0].identity.name = "agentera-canary";

    expect(validateRegistryData(changed, REPO_ROOT)).toEqual([]);
    const registry = new PackageRegistry(changed.records, REPO_ROOT);

    const observed: Record<string, string> = {};
    for (const consumer of ["validator", "upgrade", "docs", "tests"]) {
      observed[consumer] = registry.consumerView(consumer, "agentera").identity.name;
    }
    expect(observed).toEqual({
      validator: "agentera-canary",
      upgrade: "agentera-canary",
      docs: "agentera-canary",
      tests: "agentera-canary",
    });
  });

  it("consumer views do not hide changed package facts", () => {
    const fixture = registryFixture();
    const changed = structuredClone(fixture);
    changed.records[0].version_authority.future_authority_change_requires =
      "explicit ADR plus migration plan";

    expect(validateRegistryData(changed, REPO_ROOT)).toEqual([]);
    const registry = new PackageRegistry(changed.records, REPO_ROOT);

    const observed = new Set<string>();
    for (const consumer of ["validator", "upgrade", "docs", "tests"]) {
      observed.add(registry.consumerView(consumer, "agentera").version_authority.future_authority_change_requires);
    }
    expect([...observed]).toEqual(["explicit ADR plus migration plan"]);
  });

  it("separates non-version-bearing runtime manifests from version surfaces", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const nonVersion = registry.nonVersionBearingRuntimeManifests();
    expect(nonVersion.map((m) => m.path)).toEqual([".opencode/package.json"]);
    expect(
      registry.get("agentera").version_surfaces.surfaces.map((s: any) => s.path),
    ).not.toContain(".opencode/package.json");
    expect(validateRegistryData(registryFixture(), REPO_ROOT)).toEqual([]);
  });

  it("rejects a missing non-version-bearing runtime manifest", () => {
    const fixture = registryFixture();
    fixture.records[0].runtime_package_manifests.manifests =
      fixture.records[0].runtime_package_manifests.manifests.filter(
        (m: any) => m.version_bearing === true,
      );
    const errors = validateRegistryData(fixture, REPO_ROOT);
    expect(errors).toContain(
      "records[0].runtime_package_manifests.manifests must include non-version-bearing runtime package manifests separately",
    );
  });

  it("manifest projections align with registry docs_targets", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const docs = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, ".agentera/docs.yaml"), "utf8"));
    const docsView = registry.consumerView("docs");

    expect(new Set(docsView.docs_targets.version_files)).toEqual(
      new Set(docs.conventions.version_files),
    );
    const registryExcluded = new Set(docsView.docs_targets.excluded_version_files);
    const nonVersionPaths = new Set(registry.nonVersionBearingRuntimeManifests().map((m) => m.path));
    expect(registryExcluded).toEqual(nonVersionPaths);
    for (const target of docsView.docs_targets.index_targets) {
      expect(fs.existsSync(path.join(REPO_ROOT, target)), `index target missing: ${target}`).toBe(true);
    }
  });

  it("docs version targets are present in packaged bundle surfaces", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const record = registry.get("agentera");
    const bundleDirs: string[] = record.bundle_surfaces.directories.map((e: any) => e.path);
    const bundleFiles = new Set<string>(record.bundle_surfaces.files.map((e: any) => e.path));

    const missing: string[] = [];
    for (const target of record.docs_targets.version_files) {
      const isUnderDir = bundleDirs.some((dir) => {
        const rel = path.relative(dir, target);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      });
      if (bundleFiles.has(target) || isUnderDir) {
        continue;
      }
      missing.push(target);
    }
    expect(missing).toEqual([]);
  });
});
