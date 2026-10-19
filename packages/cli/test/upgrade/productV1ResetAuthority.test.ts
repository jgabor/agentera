import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";

import { PRODUCT_V1_RESET_AUTHORITY_RELATIVE_PATH, assessProductV1Evidence, isProductV1PackageVersion, loadProductV1ResetAuthority, productV1ArtifactPairs, productV1InstallRootCandidate, productV1ProjectTriggerPaths } from "../../src/upgrade/productV1ResetAuthority.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, PRODUCT_V1_RESET_AUTHORITY_RELATIVE_PATH);

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-product-v1-"));
  fs.mkdirSync(path.join(root, ".agentera"));
  return root;
}

function mutatedAuthority(mutate: (data: any) => void): string {
  const data = YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"));
  mutate(data);
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-authority-")), "authority.yaml");
  fs.writeFileSync(target, YAML.stringify(data));
  return target;
}

describe("product v1 reset authority", () => {
  it("owns the historical artifact pairs and declares one bounded owner for every reset effect", () => {
    const authority = loadProductV1ResetAuthority();

    expect(productV1ArtifactPairs()).toEqual(authority.projectArtifacts.map(({ path, currentPath }) => [path, currentPath]));
    expect(productV1ProjectTriggerPaths()).toEqual([".agentera/PROGRESS.md", ".agentera/PLAN.md", ".agentera/DECISIONS.md", ".agentera/HEALTH.md", ".agentera/DOCS.md", ".agentera/DESIGN.md"]);
    expect(new Set(authority.scope.map(({ owner }) => owner)).size).toBe(authority.scope.length);
    expect(authority.scope.map(({ id, action, boundedRoot }) => ({ id, action, boundedRoot }))).toEqual([
      { id: "project.state", action: "delete", boundedRoot: "project" },
      { id: "profile.state", action: "delete", boundedRoot: "profile_root" },
      { id: "installation.state", action: "delete", boundedRoot: "install_root" },
      { id: "runtime.resources", action: "delete", boundedRoot: "runtime_declared_roots" },
      { id: "project.fresh-v3", action: "recreate", boundedRoot: "project" },
      { id: "installation.current-package", action: "recreate", boundedRoot: "install_root" },
      { id: "runtime.canonical-skill", action: "recreate", boundedRoot: "runtime_declared_roots" },
    ]);
  });

  it("does not classify clean v2 or v3 state, including current .v1 schemas, as product v1", () => {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "schemaVersion: agentera.progress.v1\ncycles: []\n");
      fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      expect(productV1ProjectTriggerPaths()).not.toContain(".agentera/progress.yaml");
      expect(productV1ProjectTriggerPaths()).not.toContain(".agentera/state-mode.yaml");
      expect(isProductV1PackageVersion("2.7.9")).toBe(false);
      expect(isProductV1PackageVersion("3.0.0-dev.72")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts only a product-v1 package generation marker", () => {
    expect(isProductV1PackageVersion("1.27.1")).toBe(true);
    expect(isProductV1PackageVersion("agentera.stateMode.v1")).toBe(false);
  });

  it("rejects non-product generation triggers and runtime identity triggers", () => {
    const wrongGeneration = mutatedAuthority((data) => {
      data.trigger_evidence.project_artifacts[0].generation = "current_schema_v1";
    });
    const runtimeTrigger = mutatedAuthority((data) => {
      data.trigger_evidence.runtime_resources.role = "trigger";
    });
    try {
      expect(() => loadProductV1ResetAuthority(wrongGeneration, REPO_ROOT)).toThrow("generation must be product_v1");
      expect(() => loadProductV1ResetAuthority(runtimeTrigger, REPO_ROOT)).toThrow("must remain reset scope");
    } finally {
      fs.rmSync(path.dirname(wrongGeneration), { recursive: true, force: true });
      fs.rmSync(path.dirname(runtimeTrigger), { recursive: true, force: true });
    }
  });

  it("rejects targets outside their declared roots", () => {
    const target = mutatedAuthority((data) => {
      data.scope_inventory[0].targets = ["../outside"];
    });
    try {
      expect(() => loadProductV1ResetAuthority(target, REPO_ROOT)).toThrow("must stay within its declared root");
    } finally {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
    }
  });

  it("reconciles the installation trigger with the package inventory", () => {
    const target = mutatedAuthority((data) => {
      data.trigger_evidence.installation_package.selector = "schemaVersion";
    });
    try {
      expect(() => loadProductV1ResetAuthority(target, REPO_ROOT)).toThrow("package inventory's version authority");
    } finally {
      fs.rmSync(path.dirname(target), { recursive: true, force: true });
    }
  });
});

describe("product v1 evidence assessment", () => {
  function locations(): { project: string; installRoot: string; cleanup: () => void } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v1-evidence-"));
    const project = path.join(base, "project");
    const installRoot = path.join(base, "install");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.mkdirSync(installRoot);
    return { project, installRoot, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
  }

  function writeRegistry(installRoot: string, content: unknown): void {
    fs.writeFileSync(path.join(installRoot, "registry.json"), typeof content === "string" ? content : JSON.stringify(content));
  }

  it("reports a v1 installation and a v1 project separately, and nothing for v2 or v3 state", () => {
    const v1 = locations();
    const current = locations();
    try {
      fs.writeFileSync(path.join(v1.project, ".agentera", "PROGRESS.md"), "# Progress\n");
      fs.writeFileSync(path.join(v1.project, ".agentera", "DOCS.md"), "# Docs\n");
      writeRegistry(v1.installRoot, { version: "1", skills: [{ name: "hej", version: "1.27.1" }] });
      expect(assessProductV1Evidence(v1)).toEqual({
        project: [path.join(v1.project, ".agentera", "DOCS.md"), path.join(v1.project, ".agentera", "PROGRESS.md")],
        installation: path.join(v1.installRoot, "registry.json"),
      });
      expect(assessProductV1Evidence({ project: v1.project, installRoot: current.installRoot }).installation).toBeNull();
      expect(assessProductV1Evidence({ project: current.project, installRoot: v1.installRoot })).toEqual({ project: [], installation: path.join(v1.installRoot, "registry.json") });

      fs.writeFileSync(path.join(current.project, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      fs.writeFileSync(path.join(current.project, ".agentera", "progress.yaml"), "schemaVersion: agentera.progress.v1\ncycles: []\n");
      fs.writeFileSync(path.join(current.project, "VISION.md"), "# Vision\n");
      for (const version of ["2.7.9", "3.0.0-dev.72"]) {
        writeRegistry(current.installRoot, { version: "1", skills: [{ name: "agentera", version }] });
        expect(assessProductV1Evidence(current)).toEqual({ project: [], installation: null });
      }
    } finally {
      v1.cleanup();
      current.cleanup();
    }
  });

  it("treats an installation without a reliable v1 signal as non-v1", () => {
    const layout = locations();
    try {
      // Per-skill v1 installs and the v1 profile directory carry no install-root registry.
      fs.mkdirSync(path.join(layout.installRoot, "skills", "hej", ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(layout.installRoot, "skills", "hej", ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.27.1" }));
      fs.writeFileSync(path.join(layout.installRoot, "PROFILE.md"), "# Profile\n");
      expect(assessProductV1Evidence(layout).installation).toBeNull();
      for (const content of ["{not json", { version: "1", skills: [] }, { version: "1", skills: [{ name: "hej" }] }, { version: "1", skills: [{ version: "1.beta" }] }, { version: "1", skills: [{ version: "v1.15.0" }] }]) {
        writeRegistry(layout.installRoot, content);
        expect(assessProductV1Evidence(layout).installation).toBeNull();
      }
      fs.rmSync(path.join(layout.installRoot, "registry.json"));
      fs.mkdirSync(path.join(layout.installRoot, "registry.json"));
      expect(assessProductV1Evidence(layout).installation).toBeNull();
    } finally {
      layout.cleanup();
    }
  });

  it("selects one install root for every reader, skipping empty environment values", () => {
    const home = path.join(os.tmpdir(), "agentera-home");
    expect(productV1InstallRootCandidate("/explicit", { AGENTERA_HOME: "/env" }, home)).toBe("/explicit");
    expect(productV1InstallRootCandidate(null, { AGENTERA_HOME: "/env", AGENTERA_DEFAULT_INSTALL_ROOT: "/default" }, home)).toBe("/env");
    expect(productV1InstallRootCandidate(undefined, { AGENTERA_HOME: "", AGENTERA_DEFAULT_INSTALL_ROOT: "/default" }, home)).toBe("/default");
    expect(productV1InstallRootCandidate(null, { AGENTERA_HOME: "", AGENTERA_DEFAULT_INSTALL_ROOT: "", XDG_DATA_HOME: "/data" }, home)).toEqual(process.platform === "linux" ? "/data/agentera" : expect.any(String));
  });
});
