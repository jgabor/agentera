import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { resetUpdateChannelsAuthorityCache } from "../../src/upgrade/channels.js";
import { isStableSuccessorAnnounced } from "../../src/upgrade/nextMajorDoctor.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let home: string;
let prevCwd: string;

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }),
  );
}

beforeEach(() => {
  resetUpdateChannelsAuthorityCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-ch-"));
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
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prime channel-aware migration and app_home gates", () => {
  it("v1_migration commands use npm entrypoints, not uvx", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera", "PROGRESS.md"), "# progress\n");
    process.chdir(project);

    const state = collectOrientationState({ home, env: process.env });
    expect(state.v1_migration.detected).toBe(true);
    expect(state.v1_migration.dry_run_command).toContain("npx -y agentera@next");
    expect(state.v1_migration.dry_run_command).not.toContain("uvx");
    expect(state.v1_migration.apply_command).toContain("--yes");
  });

  it("does not suggest v2→v3 preview while stable successor is unannounced", () => {
    const unannouncedRoot = path.join(tmp, "unannounced-prime");
    fs.mkdirSync(path.join(unannouncedRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(unannouncedRoot, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(unannouncedRoot, "skills", "agentera", "SKILL.md"), "x");
    fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(unannouncedRoot, "registry.json"));
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(unannouncedRoot, "references"), { recursive: true });
    const channelsPath = path.join(unannouncedRoot, "references/cli/update-channels.yaml");
    let channels = fs.readFileSync(channelsPath, "utf8");
    const stableStart = channels.indexOf("  stable:");
    const devStart = channels.indexOf("  development:");
    const stableBlock = channels.slice(stableStart, devStart);
    channels =
      channels.slice(0, stableStart) +
      stableBlock.replace(/\n      announced: (true|false)/, "\n      announced: false") +
      channels.slice(devStart);
    fs.writeFileSync(channelsPath, channels);
    resetUpdateChannelsAuthorityCache();
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = unannouncedRoot;

    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.app.crossMajorBoundary).toBe(false);
    expect(state.project_integration.recommendation).toBe("stay");
    const crossMajorAttention = (state.attention as string[]).find((line) =>
      line.includes("v2 while the CLI is on v3"),
    );
    expect(crossMajorAttention).toBeUndefined();
  });

  it("attention suggests explicit v2→v3 preview when successor is announced", () => {
    const authorityRoot = path.join(tmp, "announced");
    fs.mkdirSync(path.join(authorityRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(authorityRoot, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(authorityRoot, "skills", "agentera", "SKILL.md"), "x");
    fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(authorityRoot, "registry.json"));
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(authorityRoot, "references"), { recursive: true });
    const channelsPath = path.join(authorityRoot, "references/cli/update-channels.yaml");
    const channels = fs
      .readFileSync(channelsPath, "utf8")
      .replace("announced: false", "announced: true");
    fs.writeFileSync(channelsPath, channels);
    resetUpdateChannelsAuthorityCache();
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = authorityRoot;
    process.env.AGENTERA_UPDATE_CHANNEL = "development";

    const appHome = process.env.AGENTERA_HOME as string;
    managedV2(appHome);
    const project = path.join(tmp, "proj-announced");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    expect(isStableSuccessorAnnounced(authorityRoot, "stable")).toBe(true);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.project_integration.recommendation).toBe("upgrade");
    const crossMajorAttention = (state.attention as string[]).find((line) =>
      line.includes("v2 while the CLI is on v3"),
    );
    expect(crossMajorAttention).toBeTruthy();
    expect(crossMajorAttention).toContain("agentera@next");
    expect(crossMajorAttention).not.toContain("--target-major");
    expect(crossMajorAttention).not.toContain("--project");
    expect(crossMajorAttention).not.toContain("app files outdated");
  });

  it("feat/v3 source checkout with no v2 managed app recommends stay with no upgrade command", () => {
    const project = path.join(tmp, "proj-source-only");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, env: process.env });
    expect(state.project_integration.recommendation).toBe("stay");
    expect(state.project_integration.dry_run_command).toBeNull();
    expect(state.project_integration.apply_command).toBeNull();
    expect(state.project_integration.pending_runtime).toBe(0);
  });
});
