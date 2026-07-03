import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrationPhases, dryRunMigration } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  acquireUpgradeLock,
  releaseUpgradeLock,
  upgradeLockPath,
} from "../../src/upgrade/upgradeLock.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let appHome: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-lock-"));
  appHome = path.join(tmp, "agentera");
  fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeLiveLock(): void {
  fs.writeFileSync(
    upgradeLockPath(appHome),
    JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
  );
}

function writeStaleLock(): void {
  fs.writeFileSync(
    upgradeLockPath(appHome),
    JSON.stringify({ pid: 999999, started: new Date().toISOString() }),
  );
}

describe("acquireUpgradeLock", () => {
  it("creates a lock file with the current PID", () => {
    acquireUpgradeLock(appHome);
    const lockPath = upgradeLockPath(appHome);
    expect(fs.existsSync(lockPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    expect(data.pid).toBe(process.pid);
    expect(data.started).toBeDefined();
    releaseUpgradeLock(appHome);
  });

  it("throws when a live lock exists", () => {
    writeLiveLock();
    const lockPath = upgradeLockPath(appHome);
    expect(() => acquireUpgradeLock(appHome)).toThrow("upgrade in progress");
    expect(() => acquireUpgradeLock(appHome)).toThrow(String(process.pid));
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("reclaims a stale lock from a dead PID", () => {
    writeStaleLock();
    acquireUpgradeLock(appHome);
    const data = JSON.parse(fs.readFileSync(upgradeLockPath(appHome), "utf8"));
    expect(data.pid).toBe(process.pid);
    releaseUpgradeLock(appHome);
  });

  it("treats a corrupt lock file as stale", () => {
    fs.writeFileSync(upgradeLockPath(appHome), "{not valid json");
    acquireUpgradeLock(appHome);
    const data = JSON.parse(fs.readFileSync(upgradeLockPath(appHome), "utf8"));
    expect(data.pid).toBe(process.pid);
    releaseUpgradeLock(appHome);
  });
});

describe("releaseUpgradeLock", () => {
  it("removes the lock file", () => {
    acquireUpgradeLock(appHome);
    expect(fs.existsSync(upgradeLockPath(appHome))).toBe(true);
    releaseUpgradeLock(appHome);
    expect(fs.existsSync(upgradeLockPath(appHome))).toBe(false);
  });

  it("is safe to call when no lock exists", () => {
    expect(() => releaseUpgradeLock(appHome)).not.toThrow();
  });
});

describe("applyMigrationPhases lock integration", () => {
  it("removes the lock on successful completion", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home"));
    const appRoot = copyFixture("v2-app-home", path.join(home, "agentera"));
    const project = copyFixture("v2-yaml-project", path.join(home, "project"));
    const ctx = migrationCtx(appRoot, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    applyMigrationPhases(ctx, preview, ["runtime"]);

    expect(fs.existsSync(upgradeLockPath(appRoot))).toBe(false);
  });

  it("blocks a concurrent run when a live lock exists", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home2"));
    const appRoot = copyFixture("v2-app-home", path.join(home, "agentera"));
    const project = copyFixture("v2-yaml-project", path.join(home, "project"));
    const ctx = migrationCtx(appRoot, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);

    fs.mkdirSync(path.join(appRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(
      upgradeLockPath(appRoot),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    );

    expect(() => applyMigrationPhases(ctx, preview, ["runtime"])).toThrow("upgrade in progress");
    expect(fs.existsSync(upgradeLockPath(appRoot))).toBe(true);
  });

  it("reclaims a stale lock before proceeding", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home3"));
    const appRoot = copyFixture("v2-app-home", path.join(home, "agentera"));
    const project = copyFixture("v2-yaml-project", path.join(home, "project"));
    const ctx = migrationCtx(appRoot, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);

    fs.mkdirSync(path.join(appRoot, ".agentera"), { recursive: true });
    fs.writeFileSync(
      upgradeLockPath(appRoot),
      JSON.stringify({ pid: 999999, started: new Date().toISOString() }),
    );

    applyMigrationPhases(ctx, preview, ["runtime"]);
    expect(fs.existsSync(upgradeLockPath(appRoot))).toBe(false);
  });
});

describe("concurrency", () => {
  it("lockReleasedOnExit: the lock is released when apply throws before completion", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home-throw"));
    const appRoot = copyFixture("v2-app-home", path.join(home, "agentera"));
    const project = copyFixture("v2-yaml-project", path.join(home, "project"));
    const ctx = migrationCtx(appRoot, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);

    const throwingCtx = { ...ctx, channel: "bogus" };

    expect(() => applyMigrationPhases(throwingCtx, preview, ["runtime"])).toThrow();
    expect(fs.existsSync(upgradeLockPath(appRoot))).toBe(false);
  });
});
