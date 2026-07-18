import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { detectStateMode } from "../../src/state/stateMode.js";
import { FORWARD_MANIFEST, MIGRATION_STAGING } from "../../src/state/entityCutover.js";
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

function applyUpgrade(root: string, appHome: string, home: string, only?: readonly ("artifacts" | "runtime" | "cleanup")[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = cmdUpgrade({ installRoot: appHome, home, project: root, channel: "development", yes: true, only }, { out: (value) => { out += value; }, err: (value) => { err += value; } });
  return { code, out, err };
}

function capture(root: string, args: string[]): { code: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const code = main(["node", "agentera", ...args], { out: (value) => { out += value; }, err: (value) => { err += value; } });
    return { code, out, err };
  } finally {
    process.chdir(previous);
  }
}

function treeBytes(root: string, relative = "."): Record<string, string> {
  const result: Record<string, string> = {};
  const base = path.join(root, relative);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result[path.relative(root, absolute).split(path.sep).join("/")] = fs.readFileSync(absolute).toString("base64");
    }
  };
  if (fs.existsSync(base)) visit(base);
  return result;
}

function files(root: string): string[] {
  return Object.keys(treeBytes(root)).sort();
}

beforeEach(() => {
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = SOURCE_ROOT;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;
  setSuccessorAnnouncedOverrideForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("one-way Git entity cutover", () => {
  it("cuts over a clean tracked v2 project without consuming or deleting migration inputs", () => {
    const root = project();
    initializeGit(root);
    const sourceBefore = new Map([
      [".agentera/plan.yaml", fs.readFileSync(path.join(root, ".agentera/plan.yaml"))],
      [".agentera/progress.yaml", fs.readFileSync(path.join(root, ".agentera/progress.yaml"))],
    ]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-home-"));
    roots.push(home);
    const appHome = managedV2(home);

    const applied = applyUpgrade(root, appHome, home);

    expect(applied).toMatchObject({ code: 0, err: "" });
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    for (const [relative, bytes] of sourceBefore) expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
    const manifest = YAML.parse(fs.readFileSync(path.join(root, FORWARD_MANIFEST), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(["marker", "phase", "schemaVersion", "source", "targets"]);
    expect(manifest.phase).toBe("entities_published");
    expect(manifest.source).toEqual({ head: git(root, "rev-parse", "HEAD"), source_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), preview_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(manifest.targets.length).toBeGreaterThan(0);
    expect(files(path.join(root, ".agentera/migrations/entities"))).toEqual(["forward.yaml"]);
    expect(fs.existsSync(path.join(root, MIGRATION_STAGING))).toBe(false);
    expect(files(root).some((file) => /(?:snapshot|journal|receipts)/.test(file))).toBe(false);
    expect(capture(root, ["state", "plan", "list", "--format", "json"])).toMatchObject({ code: 0 });
  }, 30_000);

  it.each([
    ["ignored migration input", (root: string) => { fs.writeFileSync(path.join(root, ".gitignore"), ".agentera/progress.yaml\n"); initializeGit(root); }],
    ["untracked migration input", (root: string) => { const file = path.join(root, ".agentera/progress.yaml"); const bytes = fs.readFileSync(file); fs.rmSync(file); initializeGit(root); fs.writeFileSync(file, bytes); }],
    ["staged migration input", (root: string) => { initializeGit(root); fs.appendFileSync(path.join(root, ".agentera/plan.yaml"), "# staged\n"); git(root, "add", ".agentera/plan.yaml"); }],
    ["modified migration input", (root: string) => { initializeGit(root); fs.appendFileSync(path.join(root, ".agentera/plan.yaml"), "# modified\n"); }],
    ["renamed migration input", (root: string) => { initializeGit(root); git(root, "mv", ".agentera/progress.yaml", ".agentera/progress-renamed.yaml"); }],
    ["unsafe migration input", (root: string) => { initializeGit(root); fs.rmSync(path.join(root, ".agentera/progress.yaml")); fs.symlinkSync("plan.yaml", path.join(root, ".agentera/progress.yaml")); }],
    ["unsupported tracked source", (root: string) => { fs.mkdirSync(path.join(root, ".agentera/archive/progress"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/archive/progress/not-a-number.yaml"), "record: {}\n"); initializeGit(root); }],
    ["unrelated dirty checkout", (root: string) => { initializeGit(root); fs.writeFileSync(path.join(root, "notes.txt"), "dirty\n"); }],
  ])("refuses %s before every selected effect", (_label, arrange) => {
    const root = project();
    arrange(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-refusal-"));
    roots.push(home);
    const appHome = managedV2(home);
    const projectBefore = treeBytes(root);
    const appBefore = treeBytes(appHome);

    const refused = applyUpgrade(root, appHome, home);

    expect(refused.code).not.toBe(0);
    expect(treeBytes(root)).toEqual(projectBefore);
    expect(treeBytes(appHome)).toEqual(appBefore);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
  }, 30_000);

  it("refuses non-Git and every partial cross-major apply", () => {
    for (const only of [undefined, ["artifacts"] as const, ["runtime"] as const, ["cleanup"] as const]) {
      const root = project();
      if (only) initializeGit(root);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-shape-"));
      roots.push(home);
      const appHome = managedV2(home);
      const before = treeBytes(root);

      const refused = applyUpgrade(root, appHome, home, only);

      expect(refused.code).not.toBe(0);
      expect(treeBytes(root)).toEqual(before);
      expect(fs.existsSync(path.join(appHome, "app"))).toBe(true);
    }
  }, 30_000);

  it("discards only known pre-publication staging and recomputes it from HEAD", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-stage-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "staging_built";

    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, MIGRATION_STAGING))).toBe(true);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    const staged = files(path.join(root, MIGRATION_STAGING)).find((file) => file.endsWith(".yaml"))!;
    fs.writeFileSync(path.join(root, MIGRATION_STAGING, staged), "tampered staging\n");
    delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;

    const initial = applyUpgrade(root, appHome, home);
    expect(initial.code, initial.err).toBe(0);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(fs.existsSync(path.join(root, MIGRATION_STAGING))).toBe(false);
  }, 30_000);

  it("validates published canonical bytes and completes forward without replacing them", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-forward-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "entities_published";

    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    const canonical = files(path.join(root, ".agentera/entities"));
    expect(canonical.length).toBeGreaterThan(0);
    const identities = new Map(canonical.map((relative) => {
      const absolute = path.join(root, ".agentera/entities", relative);
      return [relative, { ino: fs.statSync(absolute, { bigint: true }).ino, bytes: fs.readFileSync(absolute) }];
    }));
    delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;

    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    for (const [relative, expected] of identities) {
      const absolute = path.join(root, ".agentera/entities", relative);
      expect(fs.statSync(absolute, { bigint: true }).ino).toBe(expected.ino);
      expect(fs.readFileSync(absolute)).toEqual(expected.bytes);
    }
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
  }, 30_000);

  it("keeps entity authority active across normal writes and repeated upgrade", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-noop-"));
    roots.push(home);
    const appHome = managedV2(home);
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    const markerBefore = fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"));
    const manifestBefore = fs.readFileSync(path.join(root, FORWARD_MANIFEST));

    expect(capture(root, ["state", "progress", "append", "--type", "fix", "--phase", "build", "--what", "post-cutover write", "--intent", "prove entity authority", "--format", "json"]).code).toBe(0);
    expect(capture(root, ["state", "progress", "list", "--format", "json"]).code).toBe(0);
    managedV2(home);

    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    expect(fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"))).toEqual(markerBefore);
    expect(fs.readFileSync(path.join(root, FORWARD_MANIFEST))).toEqual(manifestBefore);
    expect(capture(root, ["state", "progress", "list", "--format", "json"]).out).toContain("post-cutover write");
  }, 30_000);

  it("exposes preview only and has no entity recovery or cross-major restore commands", () => {
    const root = project();
    const entityHelp = capture(root, ["state", "migrate", "entities", "--help"]);
    expect(entityHelp.code).toBe(0);
    expect(entityHelp.out).toContain("--dry-run");
    expect(entityHelp.out).not.toMatch(/--(?:apply|resume|rollback)/);
    for (const args of [["--apply"], ["--resume", "deadbeef"], ["--rollback", "deadbeef"]]) {
      expect(capture(root, ["state", "migrate", "entities", ...args]).code).toBe(2);
    }
    expect(capture(root, ["upgrade", "--restore"]).code).toBe(2);
  });
});
