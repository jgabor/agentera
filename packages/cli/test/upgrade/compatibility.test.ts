import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  MAJOR_BOUNDARY_ITEM_TAG,
  STATUS_MANUAL_REVIEW_NEEDED,
  STATUS_NO_CHANGES_NEEDED,
  STATUS_READY_TO_APPLY,
  classifyInstall,
  collectV3MigrationOperations,
  previewCrossMajorGuard,
} from "../../src/upgrade/compatibility.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compat-"));
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedV2(appHome: string, marker = "2.7.0"): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: marker }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

function npxBundleRoot(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "3.0.0-next.1" }] }));
  fs.writeFileSync(path.join(root, NPX_BUNDLE_SENTINEL), JSON.stringify({ schemaVersion: "agentera.npxBundle.v1" }));
}

describe("classifyInstall", () => {
  it("detects v2 managed app-home from bundle marker and scripts/agentera", () => {
    const appHome = path.join(tmp, "v2");
    managedV2(appHome);
    const result = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(result.kind).toBe("v2_managed_app_home");
    expect(result.signals.bundleMarkerAtActiveRoot).toBe(true);
    expect(result.signals.agenteraScriptAtActiveRoot).toBe(true);
    expect(result.activeBundleRoot).toBe(path.join(appHome, "app"));
  });

  it("detects v3 self-contained npm from npx bundle sentinel", () => {
    const root = path.join(tmp, "v3");
    npxBundleRoot(root);
    const result = classifyInstall({ appHome: root, sourceRoot: root });
    expect(result.kind).toBe("v3_self_contained_npm");
    expect(result.signals.npxBundleSentinelAtSourceRoot).toBe(true);
  });

  it("detects source checkout for the repo root", () => {
    const appHome = path.join(tmp, "empty");
    fs.mkdirSync(appHome, { recursive: true });
    const result = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(result.kind).toBe("source_checkout");
    expect(result.signals.gitAtSourceRoot).toBe(true);
    expect(result.signals.skillAtSourceRoot).toBe(true);
  });

  it("detects unknown foreign layouts", () => {
    const appHome = path.join(tmp, "foreign");
    fs.mkdirSync(appHome, { recursive: true });
    fs.writeFileSync(path.join(appHome, "notes.txt"), "not agentera\n");
    const result = classifyInstall({ appHome, sourceRoot: appHome });
    expect(result.kind).toBe("unknown_foreign");
  });
});

describe("previewCrossMajorGuard", () => {
  it("stable channel never surfaces migration items for cross-major v2 home", () => {
    const appHome = path.join(tmp, "v2-stable");
    managedV2(appHome);
    const preview = previewCrossMajorGuard({
      appHome,
      sourceRoot: REPO_ROOT,
      env: { HOME: tmp },
      home: tmp,
      channel: "stable",
    });
    expect(preview.crossMajorBoundary).toBe(true);
    expect([STATUS_MANUAL_REVIEW_NEEDED, STATUS_NO_CHANGES_NEEDED]).toContain(preview.lifecycleStatus);
    expect(preview.lifecycleStatus).not.toBe(STATUS_READY_TO_APPLY);
    expect(collectV3MigrationOperations(preview)).toHaveLength(0);
    expect(preview.upgradeOutcome.kind).toBe("up_to_date");
  });

  it("lists cross-major work on development channel when semver gate allows migration", () => {
    const appHome = path.join(tmp, "v2-dev");
    managedV2(appHome);
    const preview = previewCrossMajorGuard({
      appHome,
      sourceRoot: REPO_ROOT,
      home: tmp,
      channel: "development",
    });
    const ops = collectV3MigrationOperations(preview);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((item) => item.tag === MAJOR_BOUNDARY_ITEM_TAG)).toBe(true);
    expect(ops.map((item) => item.phase).sort()).toEqual(["artifacts", "cleanup", "runtime"]);
    expect(preview.upgradeOutcome.kind).toBe("migration_to_latest_on_channel");
  });
});
