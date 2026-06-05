import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { classifyInstall } from "../../src/upgrade/compatibility.js";
import { resolveUpdateChannel } from "../../src/upgrade/channels.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import {
  classifyUpgradeOutcome,
  parseSemverMajor,
  resolveLatestOnChannel,
  resolveRunningVersion,
  setVersionCatalogForTests,
} from "../../src/upgrade/versionResolution.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ver-"));
  setVersionCatalogForTests({
    stable: "3.1.6",
    development: "4.2.1",
  });
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setVersionCatalogForTests(null);
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
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

describe("parseSemverMajor", () => {
  it("reads leading major version", () => {
    expect(parseSemverMajor("3.1.3")).toBe(3);
    expect(parseSemverMajor("3.0.0-dev.0")).toBe(3);
  });
});

describe("classifyUpgradeOutcome", () => {
  it("classifies forward major upgrade on development channel", () => {
    const appHome = path.join(tmp, "empty");
    fs.mkdirSync(appHome, { recursive: true });
    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(install.kind).toBe("source_checkout");
    const channel = resolveUpdateChannel({ sourceRoot: REPO_ROOT, channel: "development", home: tmp });
    const outcome = classifyUpgradeOutcome({
      appHome,
      sourceRoot: REPO_ROOT,
      install,
      channel,
      catalog: { stable: "3.1.6", development: "4.0.2" },
    });
    expect(outcome.kind).toBe("forward_major_upgrade");
    expect(outcome.latestOnChannel).toBe("4.0.2");
  });

  it("treats v2 managed layout as up_to_date when successor is unannounced", () => {
    setSuccessorAnnouncedOverrideForTests(false);
    const appHome = path.join(tmp, "v2-unannounced");
    managedV2(appHome, "2.7.7");
    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    const channel = resolveUpdateChannel({ sourceRoot: REPO_ROOT, channel: "development", home: tmp });
    const outcome = classifyUpgradeOutcome({
      appHome,
      sourceRoot: REPO_ROOT,
      install,
      channel,
      catalog: { stable: "2.7.7", development: "3.0.0" },
    });
    expect(outcome.kind).toBe("up_to_date");
    expect(outcome.message).toContain("not announced");
  });

  it("classifies v2 managed layout migration to latest on development channel", () => {
    const appHome = path.join(tmp, "v2");
    managedV2(appHome, "2.7.7");
    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    const channel = resolveUpdateChannel({ sourceRoot: REPO_ROOT, channel: "development", home: tmp });
    const outcome = classifyUpgradeOutcome({
      appHome,
      sourceRoot: REPO_ROOT,
      install,
      channel,
      catalog: { stable: "2.7.7", development: "3.0.0-dev.0" },
    });
    expect(outcome.kind).toBe("migration_to_latest_on_channel");
    expect(outcome.migrationTargetVersion).toBe("3.0.0-dev.0");
  });

  it("blocks downgrade to v2 permanently", () => {
    const appHome = path.join(tmp, "v3");
    fs.mkdirSync(path.join(appHome, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, "skills", "agentera", "SKILL.md"), "x");
    fs.writeFileSync(
      path.join(appHome, BUNDLE_MARKER),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "3.1.3" }),
    );
    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    const channel = resolveUpdateChannel({ sourceRoot: REPO_ROOT, channel: "stable", home: tmp });
    const outcome = classifyUpgradeOutcome({
      appHome,
      sourceRoot: REPO_ROOT,
      install,
      channel,
      catalog: { stable: "2.7.7", development: "3.0.0-dev.0" },
    });
    expect(outcome.kind).toBe("blocked_downgrade_to_v2");
  });

  it("classifies channel line mismatch for dev build on stable channel", () => {
    const appHome = path.join(tmp, "v4dev");
    fs.mkdirSync(path.join(appHome, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, "skills", "agentera", "SKILL.md"), "x");
    fs.writeFileSync(
      path.join(appHome, BUNDLE_MARKER),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "4.2.1" }),
    );
    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    const channel = resolveUpdateChannel({ sourceRoot: REPO_ROOT, channel: "stable", home: tmp });
    const outcome = classifyUpgradeOutcome({
      appHome,
      sourceRoot: REPO_ROOT,
      install,
      channel,
      catalog: { stable: "3.1.6", development: "4.2.1" },
    });
    expect(outcome.kind).toBe("channel_line_mismatch");
  });
});

describe("resolveRunningVersion", () => {
  it("reads bundle marker version for v2 managed app-home", () => {
    const appHome = path.join(tmp, "v2");
    managedV2(appHome, "2.7.7");
    const install = classifyInstall({ appHome, sourceRoot: REPO_ROOT });
    expect(
      resolveRunningVersion({ appHome, sourceRoot: REPO_ROOT, install }),
    ).toBe("2.7.7");
  });
});

describe("resolveLatestOnChannel", () => {
  it("uses injectable catalog without network", () => {
    const channel = resolveUpdateChannel({ sourceRoot: REPO_ROOT, channel: "development", home: tmp });
    expect(
      resolveLatestOnChannel(channel, REPO_ROOT, { stable: "2.7.7", development: "3.0.0-dev.0" }),
    ).toBe("3.0.0-dev.0");
  });
});
