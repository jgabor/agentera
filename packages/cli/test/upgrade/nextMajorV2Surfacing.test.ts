import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { cmdDoctor } from "../../src/cli/commands/doctor.js";
import { classifyInstall } from "../../src/upgrade/compatibility.js";
import { APP_UP_TO_DATE, buildDoctorStatus } from "../../src/upgrade/doctor.js";
import {
  NEXT_MAJOR_SECTION_HEADER,
  resolveNextMajorDoctorLines,
} from "../../src/upgrade/nextMajorDoctor.js";
import { resetUpdateChannelsAuthorityCache } from "../../src/upgrade/channels.js";
import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const V2_GUIDE_FRAGMENT = "UPGRADE.md#upgrading-v2-to-v3-development-channel-irreversible";

let tmp: string;

beforeEach(() => {
  resetUpdateChannelsAuthorityCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "next-major-v2-"));
});

afterEach(() => {
  resetUpdateChannelsAuthorityCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function authorityRoot(stableAnnounced: boolean): string {
  const root = path.join(tmp, `auth-${stableAnnounced}`);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "x");
  fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(root, "registry.json"));
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(root, "references"), { recursive: true });
  const channelsPath = path.join(root, "references/cli/update-channels.yaml");
  let channels = fs.readFileSync(channelsPath, "utf8");
  const stableStart = channels.indexOf("  stable:");
  const devStart = channels.indexOf("  development:");
  const stableBlock = channels.slice(stableStart, devStart);
  const patchedStable = stableBlock.replace(
    /\n      announced: (true|false)/,
    `\n      announced: ${stableAnnounced}`,
  );
  channels = channels.slice(0, stableStart) + patchedStable + channels.slice(devStart);
  fs.writeFileSync(channelsPath, channels);
  return root;
}

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

function npxV3Root(root: string, version = "3.0.0-next.4"): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(root, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version }] }),
  );
  fs.writeFileSync(
    path.join(root, NPX_BUNDLE_SENTINEL),
    JSON.stringify({ schemaVersion: "agentera.npxBundle.v1" }),
  );
}

describe("v2 install track successor surfacing (#32)", () => {
  it("pass: v2 install with announced successor surfaces v3 line in doctor next-major section", () => {
    const sourceRoot = authorityRoot(true);
    const appHome = path.join(tmp, "v2-announced");
    managedV2(appHome);
    const install = classifyInstall({ appHome, sourceRoot });
    expect(install.kind).toBe("v2_managed_app_home");

    const lines = resolveNextMajorDoctorLines({
      sourceRoot,
      home: path.join(tmp, "home-v2"),
      channel: "stable",
      install,
      runningVersion: "2.7.7",
    });
    expect(lines).not.toBeNull();
    expect(lines?.[0]).toBe(NEXT_MAJOR_SECTION_HEADER);
    expect(lines?.[1]).toContain("2.7.7");
    expect(lines?.[1]).toContain("stable channel");
    expect(lines?.[2]).toContain("3.0.0");
    expect(lines?.[2]).toContain("development channel");
    expect(lines?.[3]).toContain(V2_GUIDE_FRAGMENT);
    expect(lines?.[4]).toContain("npx -y agentera@next upgrade --dry-run");

    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot,
      home: path.join(tmp, "home-v2"),
      project: path.join(tmp, "proj-v2"),
      expectedVersion: "3.0.0",
    });
    expect(status.status).not.toBe(APP_UP_TO_DATE);
    expect(status.crossMajorBoundary).toBe(true);
    expect(status.dryRunCommand).toContain("agentera@next");

    let doctorText = "";
    cmdDoctor(
      { installRoot: appHome, home: path.join(tmp, "home-v2"), project: path.join(tmp, "proj-v2"), format: "text" },
      { out: (t) => (doctorText += t) },
    );
    expect(doctorText).toContain(NEXT_MAJOR_SECTION_HEADER);
    expect(doctorText.indexOf(NEXT_MAJOR_SECTION_HEADER)).toBeLessThan(
      doctorText.indexOf("Agentera doctor"),
    );
    expect(doctorText).toContain("agentera@next upgrade --dry-run");
    expect(doctorText).toContain(V2_GUIDE_FRAGMENT);
  });

  it("fail: v2 install with unannounced successor omits next-major block and does not offer v3 upgrade", () => {
    const sourceRoot = authorityRoot(false);
    const appHome = path.join(tmp, "v2-unannounced");
    managedV2(appHome);
    const install = classifyInstall({ appHome, sourceRoot });

    expect(
      resolveNextMajorDoctorLines({
        sourceRoot,
        home: path.join(tmp, "home-v2-u"),
        channel: "stable",
        install,
        runningVersion: "2.7.7",
      }),
    ).toBeNull();

    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot,
      home: path.join(tmp, "home-v2-u"),
      project: path.join(tmp, "proj-v2-u"),
      expectedVersion: "3.0.0",
    });
    expect(status.crossMajorBoundary).toBe(false);
    expect(status.dryRunCommand).toBeNull();
    expect(status.signals.some((s) => s.kind === "cross_major_pending")).toBe(true);
  });

  it("pass: v3 install track omits next-major successor block", () => {
    const sourceRoot = authorityRoot(true);
    const appHome = path.join(tmp, "v3-install");
    npxV3Root(appHome);
    const install = classifyInstall({ appHome, sourceRoot });
    expect(install.kind).toBe("v3_self_contained_npm");

    expect(
      resolveNextMajorDoctorLines({
        sourceRoot,
        home: path.join(tmp, "home-v3"),
        channel: "development",
        install,
        runningVersion: "3.0.0-next.4",
      }),
    ).toBeNull();

    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceRoot;
    const state = collectOrientationState({
      home: path.join(tmp, "home-v3"),
      installRoot: appHome,
      env: process.env,
    });
    expect(state.app.status).toBe(APP_UP_TO_DATE);
    expect(
      (state.attention as string[]).some((line) => line.includes("v2 while the CLI is on v3")),
    ).toBe(false);
    delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  });

  it("fail: v3 install track does not surface successor even when stable successor is unannounced", () => {
    const sourceRoot = authorityRoot(false);
    const appHome = path.join(tmp, "v3-unannounced");
    npxV3Root(appHome);
    const install = classifyInstall({ appHome, sourceRoot });

    expect(
      resolveNextMajorDoctorLines({
        sourceRoot,
        home: path.join(tmp, "home-v3-u"),
        channel: "development",
        install,
        runningVersion: "3.0.0-next.4",
      }),
    ).toBeNull();

    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = sourceRoot;
    const state = collectOrientationState({
      home: path.join(tmp, "home-v3-u"),
      installRoot: appHome,
      env: process.env,
    });
    expect(state.project_integration.recommendation).toBe("stay");
    expect(state.project_integration.dry_run_command).toBeNull();
    delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  });
});
