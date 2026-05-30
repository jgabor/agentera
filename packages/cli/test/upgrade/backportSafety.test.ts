import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  STATUS_READY_TO_APPLY,
  UPGRADE_PREVIEW_SCHEMA,
  collectV3MigrationOperations,
  previewCrossMajorGuard,
} from "../../src/upgrade/compatibility.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let home: string;
let stdout: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backport-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  stdout = "";
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }),
  );
}

describe("stable channel backport safety", () => {
  it("previewCrossMajorGuard omits v3 migration operations on stable", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const preview = previewCrossMajorGuard({
      appHome,
      sourceRoot: REPO_ROOT,
      env: { HOME: home },
      home,
      channel: "stable",
    });
    expect(preview.channel.channel).toBe("stable");
    expect(preview.channel.distributionMajor).toBe(2);
    expect(collectV3MigrationOperations(preview)).toHaveLength(0);
  });

  it("upgrade --dry-run on stable emits no v3 migration operations in JSON", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const code = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        dryRun: true,
        format: "json",
        channel: "stable",
      },
      { out: (t) => { stdout += t; } },
    );
    expect(code).not.toBe(2);
    const payload = JSON.parse(stdout);
    expect(payload.schemaVersion).toBe(UPGRADE_PREVIEW_SCHEMA);
    expect(collectV3MigrationOperations(payload)).toHaveLength(0);
    expect(payload.lifecycleStatus).not.toBe(STATUS_READY_TO_APPLY);
  });
});
