import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import { detectV1ArtifactPairs, V1_ARTIFACT_PAIRS } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  PRODUCT_V1_RESET_AUTHORITY_RELATIVE_PATH,
  isProductV1PackageVersion,
  loadProductV1ResetAuthority,
  productV1ProjectTriggerPaths,
} from "../../src/upgrade/productV1ResetAuthority.js";

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

    expect(V1_ARTIFACT_PAIRS).toEqual(authority.projectArtifacts.map(({ path, currentPath }) => [path, currentPath]));
    expect(productV1ProjectTriggerPaths()).toEqual([
      ".agentera/PROGRESS.md",
      ".agentera/PLAN.md",
      ".agentera/DECISIONS.md",
      ".agentera/HEALTH.md",
      ".agentera/DOCS.md",
      ".agentera/DESIGN.md",
    ]);
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
      expect(detectV1ArtifactPairs(root)).toEqual([]);
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
