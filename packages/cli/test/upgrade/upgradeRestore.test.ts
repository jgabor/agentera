import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_UP_TO_DATE,
  buildDoctorStatus,
} from "../../src/upgrade/doctor.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  removeUpgradeSnapshot,
  restoreFromSnapshot,
  snapshotManagedApp,
  upgradeSnapshotManifestPath,
} from "../../src/upgrade/upgradeSnapshot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let appHome: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-restore-"));
  appHome = path.join(tmp, "agentera");
  fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedManagedApp(appRoot: string): void {
  fs.mkdirSync(path.join(appRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(appRoot, "scripts", "run"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(appRoot, "registry.json"), "{}");
}

describe("restoreFromSnapshot", () => {
  it("reverses remove-managed-app-home by copying snapshot files back", () => {
    const appRoot = path.join(appHome, "app");
    seedManagedApp(appRoot);

    const snapshotDir = snapshotManagedApp(appRoot, appHome);
    expect(snapshotDir).not.toBeNull();

    fs.rmSync(appRoot, { recursive: true, force: true });
    expect(fs.existsSync(appRoot)).toBe(false);

    const result = restoreFromSnapshot(appHome);

    expect(result.restored).toBe(true);
    expect(result.source).toBe(appRoot);
    expect(result.snapshotDir).toBe(snapshotDir);
    expect(result.fileCount).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(appRoot, "scripts", "run"))).toBe(true);
    expect(fs.readFileSync(path.join(appRoot, "registry.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(snapshotDir!)).toBe(false);
    expect(fs.existsSync(upgradeSnapshotManifestPath(appHome))).toBe(false);
  });

  it("reports 'no snapshot' when the manifest is absent", () => {
    const result = restoreFromSnapshot(appHome);

    expect(result.restored).toBe(false);
    expect(result.source).toBeNull();
    expect(result.snapshotDir).toBeNull();
    expect(result.created).toBeNull();
    expect(result.fileCount).toBe(0);
  });

  it("clears the manifest when the snapshot directory is missing", () => {
    const appRoot = path.join(appHome, "app");
    seedManagedApp(appRoot);
    const snapshotDir = snapshotManagedApp(appRoot, appHome);

    fs.rmSync(snapshotDir!, { recursive: true, force: true });

    const result = restoreFromSnapshot(appHome);

    expect(result.restored).toBe(false);
    expect(result.snapshotDir).toBe(snapshotDir);
    expect(result.source).toBe(appRoot);
    expect(fs.existsSync(upgradeSnapshotManifestPath(appHome))).toBe(false);
    expect(fs.existsSync(snapshotDir!)).toBe(false);
  });

  it("is idempotent — restoring twice returns 'no snapshot' the second time", () => {
    const appRoot = path.join(appHome, "app");
    seedManagedApp(appRoot);
    snapshotManagedApp(appRoot, appHome);

    const first = restoreFromSnapshot(appHome);
    expect(first.restored).toBe(true);

    const second = restoreFromSnapshot(appHome);
    expect(second.restored).toBe(false);
    expect(second.source).toBeNull();
  });
});

describe("removeUpgradeSnapshot + restoreFromSnapshot interplay", () => {
  it("restore is a no-op after removeUpgradeSnapshot clears the manifest", () => {
    const appRoot = path.join(appHome, "app");
    seedManagedApp(appRoot);
    const snapshotDir = snapshotManagedApp(appRoot, appHome);

    removeUpgradeSnapshot(appHome, snapshotDir!);
    const result = restoreFromSnapshot(appHome);

    expect(result.restored).toBe(false);
    expect(result.source).toBeNull();
    expect(result.fileCount).toBe(0);
  });
});

describe("restore", () => {
  it("reversesManagedAppHomeRemoval: after --restore app/ is back and doctor returns up_to_date", () => {
    setSuccessorAnnouncedOverrideForTests(true);
    try {
      const appRoot = path.join(appHome, "app");
      fs.mkdirSync(path.join(appRoot, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(appRoot, "scripts", "agentera"), "#!/usr/bin/env node\n");
      fs.mkdirSync(path.join(appRoot, "skills", "agentera"), { recursive: true });
      fs.writeFileSync(path.join(appRoot, "skills", "agentera", "SKILL.md"), "# skill\n");
      fs.writeFileSync(path.join(appRoot, "registry.json"), "{}");
      fs.writeFileSync(
        path.join(appRoot, BUNDLE_MARKER),
        JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "3.0.0" }),
      );

      snapshotManagedApp(appRoot, appHome);
      fs.rmSync(appRoot, { recursive: true, force: true });
      expect(fs.existsSync(appRoot)).toBe(false);

      const result = restoreFromSnapshot(appHome);
      expect(result.restored).toBe(true);
      expect(fs.existsSync(path.join(appRoot, "registry.json"))).toBe(true);
      expect(fs.existsSync(path.join(appRoot, "skills", "agentera", "SKILL.md"))).toBe(true);

      const status = buildDoctorStatus(appHome, {
        rootSource: "explicit --install-root",
        sourceRoot: REPO_ROOT,
        home: path.join(tmp, "doc-home"),
        project: path.join(tmp, "doc-proj"),
        expectedVersion: "3.0.0",
      });
      expect(status.status).toBe(APP_UP_TO_DATE);
      expect(status.signals).toEqual([]);
    } finally {
      setSuccessorAnnouncedOverrideForTests(null);
    }
  });
});
