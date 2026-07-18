import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { main } from "../../src/cli/dispatch.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { detectStateMode } from "../../src/state/stateMode.js";
import {
  applyPreparedEntityMigrationForUpgrade,
  prepareEntityMigrationForUpgrade,
} from "../../src/state/entityMigrationApply.js";
import { previewEntityMigration } from "../../src/state/entityMigrationPreview.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURE = path.join(import.meta.dirname, "fixtures/v2-yaml-project");
const roots: string[] = [];

function managedV2(home: string): string {
  const appHome = path.join(home, "agentera");
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts/agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills/agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills/agentera/SKILL.md"), "x");
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
  fs.writeFileSync(path.join(app, BUNDLE_MARKER), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }));
  return appHome;
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-cutover-"));
  roots.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function initializeGit(root: string): void {
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Upgrade Test");
  git(root, "config", "user.email", "upgrade@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "v2 state");
}

function applyUpgrade(root: string, appHome: string, home: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = cmdUpgrade({ installRoot: appHome, home, project: root, channel: "development", yes: true }, { out: (value) => { out += value; }, err: (value) => { err += value; } });
  return { code, out, err };
}

beforeEach(() => {
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = SOURCE_ROOT;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("upgrade-owned entity cutover", () => {
  it.each([false, true])("applies validated marker-last cutover and retains legacy recovery evidence (git=%s)", (withGit) => {
    const root = project();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-home-"));
    roots.push(home);
    const appHome = managedV2(home);
    const source = fs.readFileSync(path.join(root, ".agentera/plan.yaml"));
    if (withGit) initializeGit(root);

    const applied = applyUpgrade(root, appHome, home);
    expect(applied.code, applied.err || applied.out).toBe(0);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(fs.readFileSync(path.join(root, ".agentera/plan.yaml"))).toEqual(source);
    expect(fs.readdirSync(path.join(root, ".agentera/entities/plan/plan")).length).toBe(1);
    const [operation] = fs.readdirSync(path.join(root, ".agentera/migrations/entities"));
    for (const evidence of ["journal.yaml", "manifest.yaml", "snapshot.yaml"]) {
      expect(fs.existsSync(path.join(root, ".agentera/migrations/entities", operation, evidence))).toBe(true);
    }
  }, 30_000);

  it("refuses a source/worktree change after internal preparation without publication", () => {
    const root = project();
    initializeGit(root);
    const prepared = prepareEntityMigrationForUpgrade(root, SOURCE_ROOT);
    fs.appendFileSync(path.join(root, ".agentera/plan.yaml"), "# stale\n");

    expect(() => applyPreparedEntityMigrationForUpgrade(prepared)).toThrow(/changed|worktree|tracked/i);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  });

  it("leaves low-level Git apply behind its explicit approval seam", () => {
    const root = project();
    initializeGit(root);
    const preview = previewEntityMigration(root, SOURCE_ROOT);
    let out = "";
    const result = main(["node", "agentera", "state", "migrate", "entities", "--project", root, "--apply", "--force", "--source-fingerprint", preview.source_fingerprint, "--preview-digest", preview.preview_digest, "--format", "json"], { out: (value) => { out += value; }, err: () => {} });
    expect(result).not.toBe(0);
    expect(JSON.parse(out).error.class).toBe("approval_required");
  });
});
