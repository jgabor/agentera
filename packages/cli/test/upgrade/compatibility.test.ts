import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { MAJOR_BOUNDARY_ITEM_TAG, STATUS_MANUAL_REVIEW_NEEDED, STATUS_NO_CHANGES_NEEDED, STATUS_READY_TO_APPLY, __resetDistributionMajorWarnedForTests, classifyInstall, cliDistributionMajor, previewCrossMajorGuard, projectInstallTrack } from "../../src/upgrade/compatibility.js";
import { collectV3MigrationOperations } from "./helpers/collectV3MigrationOperations.js";
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
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: marker }] }));
  fs.writeFileSync(path.join(app, BUNDLE_MARKER), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }));
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

describe("projectInstallTrack", () => {
  it("maps v2 managed app-home to v2", () => {
    const appHome = path.join(tmp, "v2-proj");
    managedV2(appHome);
    const result = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(projectInstallTrack(result.kind)).toBe("v2");
  });

  it("maps v3 self-contained npm to v3", () => {
    const root = path.join(tmp, "v3-proj");
    npxBundleRoot(root);
    const result = classifyInstall({ appHome: root, sourceRoot: root });
    expect(projectInstallTrack(result.kind)).toBe("v3");
  });

  it("maps source checkout to source", () => {
    const appHome = path.join(tmp, "src-proj");
    fs.mkdirSync(appHome, { recursive: true });
    const result = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(projectInstallTrack(result.kind)).toBe("source");
  });

  it("maps unknown foreign to unknown", () => {
    const appHome = path.join(tmp, "unknown-proj");
    fs.mkdirSync(appHome, { recursive: true });
    fs.writeFileSync(path.join(appHome, "notes.txt"), "not agentera\n");
    const result = classifyInstall({ appHome, sourceRoot: appHome });
    expect(projectInstallTrack(result.kind)).toBe("unknown");
  });
});

describe("cliDistributionMajor", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetDistributionMajorWarnedForTests();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("returns 3 from package.json when registry.json version is missing", () => {
    const root = path.join(tmp, "v3-pkg-json");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "agentera", version: "3.0.0-dev.13" }));
    expect(cliDistributionMajor(root)).toBe(3);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("returns 3 from package.json when registry.json is corrupted JSON", () => {
    const root = path.join(tmp, "corrupted-registry");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "registry.json"), "{ corrupted json");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "3.1.0" }));
    expect(cliDistributionMajor(root)).toBe(3);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("returns 2 and warns when both registry.json and package.json are missing", () => {
    const root = path.join(tmp, "both-missing");
    fs.mkdirSync(root, { recursive: true });
    expect(cliDistributionMajor(root)).toBe(2);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain("could not determine distribution major version");
    expect(stderrSpy.mock.calls[0][0]).toContain(root);
  });

  it("returns 2 and warns when package.json has no version field", () => {
    const root = path.join(tmp, "pkg-no-version");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "some-package" }));
    expect(cliDistributionMajor(root)).toBe(2);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 2 and warns when package.json is malformed", () => {
    const root = path.join(tmp, "malformed-pkg");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{ broken");
    expect(cliDistributionMajor(root)).toBe(2);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("returns 2 without warning when registry.json has valid v2 version", () => {
    const root = path.join(tmp, "v2-valid-registry");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
    expect(cliDistributionMajor(root)).toBe(2);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("warns only once for repeated calls on the same unresolved root", () => {
    const root = path.join(tmp, "repeated-calls");
    fs.mkdirSync(root, { recursive: true });
    expect(cliDistributionMajor(root)).toBe(2);
    expect(cliDistributionMajor(root)).toBe(2);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
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
