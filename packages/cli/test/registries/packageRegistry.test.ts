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
import { repoStateFixturePath } from "../helpers/useFixtureProject.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REGISTRY_PATH = path.join(REPO_ROOT, "references/adapters/package-registry.yaml");
const INTERFACE_MODEL_PATH = path.join(
  REPO_ROOT,
  "references/adapters/package-manifest-interface-model.yaml",
);
const PACKAGE_MANIFEST_PATH = path.join(REPO_ROOT, "registry.json");
const CLI_PACKAGE_PATH = path.join(REPO_ROOT, "packages/cli/package.json");
const FIXTURE_DOCS_PATH = path.join(repoStateFixturePath("ok"), ".agentera/docs.yaml");

function registryFixture(): any {
  const data = YAML.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  expect(typeof data).toBe("object");
  return data;
}

function manifestSuiteVersion(): string {
  return JSON.parse(fs.readFileSync(PACKAGE_MANIFEST_PATH, "utf8")).skills[0].version;
}

function scalarStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(scalarStrings);
  }
  return [];
}

describe("package registry", () => {
  it("returns package facts in deterministic order without duplicate ids", () => {
    const registry = loadRegistry(REGISTRY_PATH);

    expect(registry.packageIds).toEqual(["agentera"]);
    expect(registry.suiteVersion()).toBe(manifestSuiteVersion());
    expect(registry.packageIds.length).toBe(new Set(registry.packageIds).size);
    expect(registry.versionSurfaceIds()).toEqual([
      "registry",
      "cli-package",
      "cli-suite-marker",
      "skill-frontmatter",
    ]);
    expect(registry.versionSurfaceIds().length).toBe(new Set(registry.versionSurfaceIds()).size);
    const versions = registry.versionSurfaceValues();
    const developmentVersion = JSON.parse(fs.readFileSync(CLI_PACKAGE_PATH, "utf8")).version;
    expect(developmentVersion).toMatch(/^3\.0\.0-dev\.\d+$/);
    expect(versions["cli-package"]).toBe(developmentVersion);
    expect(new Set(Object.entries(versions)
      .filter(([surface]) => surface !== "cli-package")
      .map(([, version]) => version))).toEqual(new Set(["3.0.0"]));
    const record = registry.get("agentera");
    expect(record.bundle_surfaces.directories.map((d: any) => d.id)).toEqual([
      "skills",
      "references",
    ]);
    expect(record).not.toHaveProperty("runtime_package_manifests");
    expect(record).not.toHaveProperty("package_commands");
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
    malformed.records[0].version_surfaces.surfaces[2].path = "../escape.json";
    malformed.records[0].runtime_package_manifests = { manifests: [] };
    malformed.records[0].version_authority.install_root = "~/.agents/agentera";
    malformed.records[0].identity.lifecycle_events = [];

    const errors = validateRegistryData(malformed, REPO_ROOT);

    expect(errors).toContain("records[0]: missing required group docs_targets");
    expect(errors).toContain("duplicate package id: agentera");
    expect(errors).toContain("records[0].version_surfaces.surfaces: duplicate id registry");
    expect(errors).toContain(
      "records[0].version_surfaces.surfaces[2].path must stay inside repo root",
    );
    expect(errors).toContain("records[0]: unknown group runtime_package_manifests");
    expect(errors).toContain("records[0].version_authority: forbidden install-root field install_root");
    expect(errors).toContain("records[0].identity: forbidden RuntimeAdapter field lifecycle_events");
  });

  it("rejects native manifest and package-command compatibility groups", () => {
    const fixture = registryFixture();
    fixture.records[0].runtime_package_manifests = { manifests: [] };
    fixture.records[0].package_commands = { commands: [] };

    const errors = validateRegistryData(fixture, REPO_ROOT);
    expect(errors).toContain("records[0]: unknown group runtime_package_manifests");
    expect(errors).toContain("records[0]: unknown group package_commands");
  });

  it("keeps bundle values solely in the registry and models directory/file entries structurally", () => {
    const fixture = registryFixture();
    const model = YAML.parse(fs.readFileSync(INTERFACE_MODEL_PATH, "utf8"));
    const bundleModel = model.record.groups.bundle_surfaces;
    const entryContract = bundleModel.entry_contracts.directory_and_file;

    expect(model).not.toHaveProperty("sample_manifest");
    expect(bundleModel.required_fields).toMatchObject({
      directories: "list[object]",
      files: "list[object]",
    });
    expect(entryContract).toEqual({
      applies_to: ["directories", "files"],
      required_fields: ["id", "path"],
      allowed_fields: ["id", "path"],
      field_types: { id: "string", path: "repo_relative_path" },
      uniqueness: {
        id: "global_across_directories_and_files",
        path: "global_across_directories_and_files",
      },
      path_format: "normalized_relative_posix",
      forbidden_path_forms: [
        "posix_absolute",
        "windows_absolute_or_drive_prefixed",
        "backslash",
        "dot_or_dot_dot_segment",
        "leading_dot_slash",
        "trailing_separator",
        "noncanonical_posix_normalization",
      ],
    });
    expect(bundleModel.value_authority).toBe(
      "references/adapters/package-registry.yaml records[*].bundle_surfaces",
    );

    const registryBundle = fixture.records[0].bundle_surfaces;
    const canonicalValues = new Set(
      [...registryBundle.directories, ...registryBundle.files]
        .flatMap((entry: { id: string; path: string }) => [entry.id, entry.path]),
    );
    expect(scalarStrings(bundleModel).filter((value) => canonicalValues.has(value))).toEqual([]);
  });

  it("rejects string-list bundle entries and undeclared entry fields", () => {
    const fixture = registryFixture();
    fixture.records[0].bundle_surfaces.directories = [
      "skills",
      { id: "references", path: "references", native_manifest: false },
    ];

    const errors = validateRegistryData(fixture, REPO_ROOT);
    expect(errors).toContain("records[0].bundle_surfaces.directories[0] must be an object");
    expect(errors).toContain(
      "records[0].bundle_surfaces.directories[1]: unknown field native_manifest",
    );
  });

  it("rejects duplicate ids and paths across bundle directories and files", () => {
    const duplicateId = registryFixture();
    duplicateId.records[0].bundle_surfaces.files[0].id = "skills";
    expect(validateRegistryData(duplicateId, REPO_ROOT)).toContain(
      'records[0].bundle_surfaces.files[0].id "skills" duplicates records[0].bundle_surfaces.directories[0].id; correction: use a unique id across bundle directories and files',
    );

    const duplicatePath = registryFixture();
    duplicatePath.records[0].bundle_surfaces.files[0].path = "skills";
    expect(validateRegistryData(duplicatePath, REPO_ROOT)).toContain(
      'records[0].bundle_surfaces.files[0].path "skills" for id "readme" duplicates records[0].bundle_surfaces.directories[0].path; correction: use a unique path across bundle directories and files',
    );
  });

  it.each([
    "",
    "../outside",
    "./README.md",
    "/tmp/outside",
    "C:/outside/file",
    "C:\\outside\\file",
    "nested\\file",
    "README.md/",
    "nested//file",
  ])("rejects noncanonical bundle path %j", (invalidPath) => {
    const fixture = registryFixture();
    fixture.records[0].bundle_surfaces.files[0].path = invalidPath;

    expect(validateRegistryData(fixture, REPO_ROOT)).toContain(
      `records[0].bundle_surfaces.files[0].path ${JSON.stringify(invalidPath)} for id "readme" is invalid; correction: use a non-empty normalized relative POSIX path without absolute roots, drive prefixes, backslashes, leading './', trailing separators, or '.'/'..' segments`,
    );
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

  it("version projections align with registry docs_targets", () => {
    const registry = loadRegistry(REGISTRY_PATH);
    const docs = YAML.parse(fs.readFileSync(FIXTURE_DOCS_PATH, "utf8"));
    const docsView = registry.consumerView("docs");

    expect(new Set(docsView.docs_targets.version_files)).toEqual(
      new Set(docs.conventions.version_files),
    );
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
    const packageOwned = new Set(["packages/cli/package.json"]);
    for (const target of record.docs_targets.version_files) {
      if (packageOwned.has(target)) continue;
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
