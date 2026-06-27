import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activeAppModel } from "../../src/cli/appContext.js";
import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { resolvePath } from "../../src/core/paths.js";
import { resolveArtifactPath, type ArtifactRecord } from "../../src/registries/artifactRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const V2_APP_HOME_FIXTURE = path.join(__dirname, "../upgrade/fixtures/v2-app-home");

function profileRecord(defaultPath: string): ArtifactRecord {
  return {
    artifactId: "profile",
    displayName: "PROFILE.md",
    defaultPath,
    producers: new Set(),
    consumers: new Set(),
    artifactType: "global",
    scope: "user",
    pathTemplate: null,
    docsYamlCanOverridePath: false,
  };
}

function seedBundle(root: string, opts: { sentinel: boolean }): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "9.9.9" }] }));
  if (opts.sentinel) {
    fs.writeFileSync(
      path.join(root, ".agentera-npx-bundle.json"),
      JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "9.9.9" }),
    );
  }
}

describe("split-brain activeAppModel", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "split-brain-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers local checkout skillRoot when AGENTERA_HOME points at a v2 fixture app", () => {
    const v2AppHome = path.join(tmp, "v2-app-home");
    fs.cpSync(V2_APP_HOME_FIXTURE, v2AppHome, { recursive: true });
    const model = activeAppModel({
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
      AGENTERA_HOME: v2AppHome,
      HOME: tmp,
    });
    expect(resolvePath(model.skillRoot)).toBe(resolvePath(path.join(REPO_ROOT, "skills", "agentera")));
    expect(resolvePath(model.appHome)).toBe(resolvePath(v2AppHome));
    expect(resolvePath(model.runtimeRoot)).toBe(resolvePath(REPO_ROOT));
  });

  it("keeps the npx-bundle branch when no AGENTERA_HOME is set", () => {
    const bundle = path.join(tmp, "bundle");
    seedBundle(bundle, { sentinel: true });
    const model = activeAppModel({ AGENTERA_BOOTSTRAP_SOURCE_ROOT: bundle });
    const real = resolvePath(bundle);
    expect(model.appHomeSource).toBe("bundled app");
    expect(resolvePath(model.authoritativeRoot)).toBe(real);
    expect(resolvePath(model.skillRoot)).toBe(path.join(real, "skills", "agentera"));
    expect(resolvePath(model.appHome)).toBe(real);
  });
});

describe("split-brain resolveArtifactPath env fallback", () => {
  const projectRoot = "/tmp/project";

  it("expands $PROFILERA_PROFILE_DIR/ when only PROFILERA_PROFILE_DIR is set", () => {
    const record = profileRecord("$PROFILERA_PROFILE_DIR/PROFILE.md");
    const resolved = resolveArtifactPath(record, projectRoot, null, {
      PROFILERA_PROFILE_DIR: "/legacy/profile",
    });
    expect(resolved).toBe(path.join("/legacy/profile", "PROFILE.md"));
  });

  it("prefers AGENTERA_PROFILE_DIR over PROFILERA_PROFILE_DIR when both are set", () => {
    const record = profileRecord("$PROFILERA_PROFILE_DIR/PROFILE.md");
    const resolved = resolveArtifactPath(record, projectRoot, null, {
      AGENTERA_PROFILE_DIR: "/v3/profile",
      PROFILERA_PROFILE_DIR: "/legacy/profile",
    });
    expect(resolved).toBe(path.join("/v3/profile", "PROFILE.md"));
  });
});

describe("split-brain prime profile env fallback (G1)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "split-brain-prime-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports profile loaded when only PROFILERA_PROFILE_DIR is set", () => {
    const profileDir = path.join(tmp, "profile");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, "PROFILE.md"), "# Profile\n");
    const v2AppHome = path.join(tmp, "v2-app-home");
    fs.cpSync(V2_APP_HOME_FIXTURE, v2AppHome, { recursive: true });
    const state = collectOrientationState({
      home: tmp,
      env: {
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
        AGENTERA_HOME: v2AppHome,
        PROFILERA_PROFILE_DIR: profileDir,
        HOME: tmp,
      },
    });
    expect(state.profile_status).toBe("loaded");
    expect(state.profile).toBe(path.join(profileDir, "PROFILE.md"));
  });
});
