import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCleanupPhase, planCleanupPhase } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  removeUpgradeSnapshot,
  snapshotDirectory,
  snapshotManagedApp,
  upgradeSnapshotManifestPath,
} from "../../src/upgrade/upgradeSnapshot.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-snapshot-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("snapshotDirectory", () => {
  it("recursively copies directory contents", () => {
    const src = path.join(tmp, "src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "alpha");
    fs.writeFileSync(path.join(src, "sub", "b.txt"), "beta");
    const dest = path.join(tmp, "dest");
    snapshotDirectory(src, dest);
    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf8")).toBe("alpha");
    expect(fs.readFileSync(path.join(dest, "sub", "b.txt"), "utf8")).toBe("beta");
  });

  it("is a no-op when source does not exist", () => {
    snapshotDirectory(path.join(tmp, "missing"), path.join(tmp, "dest"));
    expect(fs.existsSync(path.join(tmp, "dest"))).toBe(false);
  });
});

describe("snapshotManagedApp", () => {
  it("creates a snapshot under appHome/.agentera/ and writes a manifest", () => {
    const appHome = path.join(tmp, "agentera");
    const appRoot = path.join(appHome, "app");
    fs.mkdirSync(path.join(appRoot, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(appRoot, "scripts", "run"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(appRoot, "registry.json"), "{}");

    const snapshotDir = snapshotManagedApp(appRoot, appHome);
    expect(snapshotDir).not.toBeNull();
    expect(snapshotDir).toContain(".agentera");
    expect(fs.existsSync(snapshotDir!)).toBe(true);
    expect(fs.readFileSync(path.join(snapshotDir!, "scripts", "run"), "utf8")).toContain("#!/bin/sh");
    expect(fs.readFileSync(path.join(snapshotDir!, "registry.json"), "utf8")).toBe("{}");

    const manifestPath = upgradeSnapshotManifestPath(appHome);
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.path).toBe(snapshotDir);
    expect(manifest.created).toBeDefined();
  });

  it("returns null when the managed app root does not exist", () => {
    const result = snapshotManagedApp(path.join(tmp, "missing"), path.join(tmp, "agentera"));
    expect(result).toBeNull();
  });
});

describe("removeUpgradeSnapshot", () => {
  it("removes the snapshot directory and manifest", () => {
    const appHome = path.join(tmp, "agentera");
    const appRoot = path.join(appHome, "app");
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, "marker"), "x");
    const snapshotDir = snapshotManagedApp(appRoot, appHome);
    expect(fs.existsSync(snapshotDir!)).toBe(true);

    removeUpgradeSnapshot(appHome, snapshotDir!);
    expect(fs.existsSync(snapshotDir!)).toBe(false);
    expect(fs.existsSync(upgradeSnapshotManifestPath(appHome))).toBe(false);
  });

  it("is safe when the snapshot is already absent", () => {
    const appHome = path.join(tmp, "agentera");
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    expect(() => removeUpgradeSnapshot(appHome, path.join(appHome, ".agentera", "upgrade-snapshot-0"))).not.toThrow();
  });
});

describe("applyCleanupPhase snapshot integration", () => {
  it("snapshots app/ before removal and cleans up on success", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "app-home-snap"));
    const ctx = migrationCtx(appHome, appHome, tmp, REPO_ROOT);
    const preview = planCleanupPhase(ctx);
    applyCleanupPhase(preview, ctx);

    expect(preview.status).toBe("applied");
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);

    const agenteraDir = path.join(appHome, ".agentera");
    const snapshotDirs = fs.existsSync(agenteraDir)
      ? fs.readdirSync(agenteraDir).filter((e) => e.startsWith("upgrade-snapshot-") && !e.endsWith(".json"))
      : [];
    expect(snapshotDirs.length).toBe(0);
    expect(fs.existsSync(upgradeSnapshotManifestPath(appHome))).toBe(false);
  });
});
