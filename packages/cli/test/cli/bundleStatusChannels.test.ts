import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { statusBundleStatus } from "../../src/cli/commands/prime/bundleStatus.js";
import { resetUpdateChannelsAuthorityCache } from "../../src/upgrade/channels.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let home: string;
let prevCwd: string;

function managedV2(appHome: string, marker = "2.7.7"): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env python3\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

beforeEach(() => {
  resetUpdateChannelsAuthorityCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-status-ch-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  prevCwd = process.cwd();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
});

afterEach(() => {
  resetUpdateChannelsAuthorityCache();
  process.chdir(prevCwd);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.AGENTERA_UPDATE_CHANNEL;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bundle-status channel resolution consistency", () => {
  it("doctor and project_integration agree on channel from v3 source CLI", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.app.updateChannel).toBe(state.project_integration.update_channel);
    expect(state.app.updateChannel).toBe("development");
  });

  it("retryCommand uses npx for v3 CLI against v2 managed app", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-retry");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const bundle = statusBundleStatus({ home, installRoot: appHome, env: process.env });
    expect(bundle.retryCommand).not.toBeNull();
    expect(bundle.retryCommand).toMatch(/npx -y/);
    expect(bundle.retryCommand).not.toMatch(/^uv run /);
  });

  it("stable channel uses installed version without false version_mismatch", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome, "2.7.7");
    process.env.AGENTERA_UPDATE_CHANNEL = "stable";
    const project = path.join(tmp, "proj-stable");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const bundle = statusBundleStatus({ home, installRoot: appHome, env: process.env });
    expect(bundle.expectedVersion).toBe("2.7.7");
    expect(bundle.signals.some((s) => s.kind === "version_mismatch")).toBe(false);
    expect(bundle.updateChannel).toBe("stable");
  });

  it("passes crossMajorBoundaryDetected when successor is unannounced", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-detected");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.app.crossMajorBoundaryDetected).toBe(true);
    expect(state.app.crossMajorBoundary).toBe(false);
    expect(state.project_integration.recommendation).toBe("stay");
    expect(state.project_integration.major_boundary_block).toContain("development channel");
  });

  it("crossMajorPending doctor block does not dead-end with approve wording", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-pending");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const bundle = statusBundleStatus({ home, installRoot: appHome, env: process.env });
    const pending = bundle.signals.some((s) => s.kind === "cross_major_pending");
    expect(pending).toBe(true);
    expect(bundle.approval).not.toMatch(/approve app files/i);
    expect(bundle.approval).toContain("no upgrade offered");
  });

  it("uses explicit channel when AGENTERA_UPDATE_CHANNEL is set", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    process.env.AGENTERA_UPDATE_CHANNEL = "stable";
    const project = path.join(tmp, "proj-explicit");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.app.updateChannel).toBe("stable");
    expect(state.project_integration.update_channel).toBe("stable");
  });
});
