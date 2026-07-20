import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

const fixture = inject("packageFixture");
const checkoutPackageRoot = path.resolve(import.meta.dirname, "../..");

function stageFakeRepo(options: { omitSkills?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-copy-bundle-safety-"));
  if (!options.omitSkills) {
    fs.mkdirSync(path.join(root, "skills/agentera/schemas/artifacts"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills/agentera/SKILL.md"), "# Fixture\n");
    fs.writeFileSync(
      path.join(root, "skills/agentera/schemas/artifacts/experiments.yaml"),
      "meta:\n  name: experiments\n",
    );
  }
  fs.mkdirSync(path.join(root, "references/adapters"), { recursive: true });
  fs.mkdirSync(path.join(root, "references/artifacts"), { recursive: true });
  fs.copyFileSync(
    path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
    path.join(root, "references/adapters/package-registry.yaml"),
  );
  fs.writeFileSync(
    path.join(root, "references/artifacts/state-storage-authority.yaml"),
    "schema_version: fixture.authority.v1\n",
  );
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [] }));
  for (const name of ["README.md", "UPGRADE.md", "CHANGELOG.md", "DESIGN.md", "LICENSE"])
    fs.writeFileSync(path.join(root, name), "fixture\n");

  const packageRoot = path.join(root, "packages/cli");
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  fs.cpSync(path.join(fixture.packageRoot, "dist"), path.join(packageRoot, "dist"), { recursive: true });
  fs.symlinkSync(path.join(fixture.packageRoot, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
  fs.copyFileSync(
    path.join(checkoutPackageRoot, "scripts/copy-bundle.mjs"),
    path.join(packageRoot, "scripts/copy-bundle.mjs"),
  );
  fs.copyFileSync(path.join(fixture.packageRoot, "package.json"), path.join(packageRoot, "package.json"));
  return root;
}

function registryPath(root: string): string {
  return path.join(root, "references/adapters/package-registry.yaml");
}

function mutateRegistry(root: string, mutate: (registry: any) => void): void {
  const registry = YAML.parse(fs.readFileSync(registryPath(root), "utf8"));
  mutate(registry);
  fs.writeFileSync(registryPath(root), YAML.stringify(registry));
}

function protectedState(root: string): { bundle: string; outside: string } {
  const bundle = path.join(root, "packages/cli/bundle/preserved.txt");
  const outside = path.join(root, "outside-sentinel.txt");
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(bundle, "bundle-before\n");
  fs.writeFileSync(outside, "outside-before\n");
  return { bundle, outside };
}

function expectProtected(paths: { bundle: string; outside: string }): void {
  expect(fs.readFileSync(paths.bundle, "utf8")).toBe("bundle-before\n");
  expect(fs.readFileSync(paths.outside, "utf8")).toBe("outside-before\n");
}

function runCopyBundle(root: string) {
  const env = { ...process.env };
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  return spawnSync(process.execPath, [path.join(root, "packages/cli/scripts/copy-bundle.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

function expectBoundaryFailure(root: string, state: { bundle: string; outside: string }, message: string): void {
  const result = runCopyBundle(root);
  expect(result.status, `package copy boundary unexpectedly passed:\n${result.stdout}`).not.toBe(0);
  expect(result.stderr, "package copy boundary omitted its failure reason").toContain(message);
  expectProtected(state);
}

describe("copy-bundle filesystem safety", () => {
  it("rejects a missing declared source before bundle side effects", () => {
    const root = stageFakeRepo({ omitSkills: true });
    try {
      const state = protectedState(root);
      expectBoundaryFailure(root, state, 'source id "skills" path "skills" is missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid registry shape and escaping paths before bundle side effects", () => {
    for (const scenario of [
      {
        mutate: (registry: any) => { registry.records[0].bundle_surfaces.directories = ["skills"]; },
        message: "records[0].bundle_surfaces.directories[0] must be an object",
      },
      {
        mutate: (registry: any) => { registry.records[0].bundle_surfaces.files[0].path = "../outside"; },
        message: 'files[0].path "../outside" for id "readme" is invalid',
      },
    ]) {
      const root = stageFakeRepo();
      try {
        const state = protectedState(root);
        mutateRegistry(root, scenario.mutate);
        expectBoundaryFailure(root, state, scenario.message);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects a source symlink that resolves outside the source root before side effects", () => {
    const root = stageFakeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-copy-bundle-outside-"));
    try {
      const state = protectedState(root);
      fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside-source-before\n");
      fs.rmSync(path.join(root, "skills"), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(root, "skills"), "dir");
      expectBoundaryFailure(
        root,
        state,
        'source id "skills" path "skills" resolves outside source root',
      );
      expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8"))
        .toBe("outside-source-before\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects recursive and explicit duplicate destinations before bundle side effects", () => {
    const root = stageFakeRepo();
    try {
      const state = protectedState(root);
      mutateRegistry(root, (registry) => {
        registry.records[0].bundle_surfaces.files.push({
          id: "nested-skill",
          path: "skills/agentera/SKILL.md",
        });
      });
      expectBoundaryFailure(
        root,
        state,
        'destination id "nested-skill" path "skills/agentera/SKILL.md" duplicates id "skills" path "skills/agentera/SKILL.md"',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
