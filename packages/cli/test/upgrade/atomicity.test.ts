import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { writeFileAtomic } from "../../src/upgrade/atomicWriter.js";
import {
  dryRunMigration,
  type MigrationPhaseItem,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { applyRuntimeMigrationItem } from "../../src/upgrade/runtimeMigration.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  restoreFromSnapshot,
  snapshotManagedApp,
} from "../../src/upgrade/upgradeSnapshot.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atomicity-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function enospcError(): NodeJS.ErrnoException {
  const err = new Error("write ENOSPC: no space left on device") as NodeJS.ErrnoException;
  err.code = "ENOSPC";
  return err;
}

function seedManagedApp(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "# skill\n");
  fs.writeFileSync(path.join(app, "registry.json"), "{}");
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.9" }),
  );
}

const npxCommands = {
  cliEntrypoint: "npx -y agentera@next",
  validate: "npx -y agentera@next hook validate-artifact",
  cursorSessionStart: "npx -y agentera@next hook cursor-session-start",
  cursorSessionStop: "npx -y agentera@next hook session-stop",
  cursorPreTool: "npx -y agentera@next hook cursor-pre-tool-use",
};

describe("atomicity", () => {
  it("renameUnderKill: a failed write leaves the existing target old-content, never partial", () => {
    const target = path.join(tmp, "out.txt");
    fs.writeFileSync(target, "old content");

    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw enospcError();
    });

    expect(() => writeFileAtomic(target, "new content")).toThrow();

    expect(fs.readFileSync(target, "utf8")).toBe("old content");
    expect(fs.readdirSync(tmp).some((e) => e.includes(".tmp."))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("renameUnderENOSPC: tmp is created, rename fails, and the original file is intact", () => {
    const target = path.join(tmp, "out.txt");
    fs.writeFileSync(target, "old content");

    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw enospcError();
    });

    expect(() => writeFileAtomic(target, "new content")).toThrow();

    expect(fs.readFileSync(target, "utf8")).toBe("old content");
    expect(fs.readdirSync(tmp).some((e) => e.includes(".tmp."))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rmUnderKillSnapshot: interrupted app/ removal keeps the snapshot; restore reverses and re-plan upgrades", () => {
    const appHome = path.join(tmp, "agentera");
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, ".agentera", "progress.yaml"), "cycles: []\n");
    seedManagedApp(appHome);
    const appRoot = path.join(appHome, "app");

    const snapshotDir = snapshotManagedApp(appRoot, appHome);
    expect(snapshotDir).not.toBeNull();
    expect(fs.existsSync(snapshotDir!)).toBe(true);

    fs.rmSync(appRoot, { recursive: true, force: true });
    expect(fs.existsSync(appRoot)).toBe(false);

    const restore = restoreFromSnapshot(appHome);
    expect(restore.restored).toBe(true);
    expect(restore.fileCount).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(appRoot, "registry.json"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "skills", "agentera", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(snapshotDir!)).toBe(false);

    const ctx = migrationCtx(appHome, appHome, tmp, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    const removeItem = preview.cleanup.items.find((i) => i.action === "remove-managed-app-home");
    expect(removeItem).toBeDefined();
    expect(removeItem!.status).toBe("pending");
  });

  it("diskFullMidCopy: a mid-copy ENOSPC marks the item failed; a re-run after space recovers succeeds", () => {
    const source = path.join(tmp, "plugin-src.js");
    const target = path.join(tmp, "config", "plugins", "agentera.js");
    fs.writeFileSync(source, "module.exports = () => {};\n");

    const buildItem = (): MigrationPhaseItem => ({
      status: "pending",
      action: "copy-plugin",
      runtime: "opencode",
      source,
      target,
      message: "will copy managed OpenCode plugin",
    });

    const failed = buildItem();
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw enospcError();
    });
    applyRuntimeMigrationItem(failed, npxCommands);
    expect(failed.status).toBe("failed");
    expect(failed.message).toMatch(/copy-plugin failed/);
    expect(fs.existsSync(target)).toBe(false);

    const retry = buildItem();
    applyRuntimeMigrationItem(retry, npxCommands);
    expect(retry.status).toBe("applied");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(source, "utf8"));
  });
});
