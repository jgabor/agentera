import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { detectStateMode } from "../../src/state/stateMode.js";
import { FORWARD_MANIFEST } from "../../src/state/entityCutover.js";
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

function applyUpgrade(
  root: string,
  appHome: string,
  home: string,
  only?: readonly ("artifacts" | "runtime" | "cleanup")[],
  format: "text" | "json" = "text",
  verification?: Parameters<typeof cmdUpgrade>[2],
): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = cmdUpgrade({ installRoot: appHome, home, project: root, channel: "development", yes: true, only, format }, { out: (value) => { out += value; }, err: (value) => { err += value; } }, verification);
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
      if (entry.isSymbolicLink()) result[path.relative(root, absolute).split(path.sep).join("/")] = `link:${fs.readlinkSync(absolute)}`;
      else if (entry.isDirectory()) visit(absolute);
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
  delete process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE;
  setSuccessorAnnouncedOverrideForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("one-way Git entity cutover", () => {
  it("cuts over a clean tracked v2 project without consuming or deleting migration inputs", () => {
    const root = project();
    const appHome = managedV2(root);
    initializeGit(root);
    const sourceBefore = new Map([
      [".agentera/plan.yaml", fs.readFileSync(path.join(root, ".agentera/plan.yaml"))],
      [".agentera/progress.yaml", fs.readFileSync(path.join(root, ".agentera/progress.yaml"))],
    ]);
    const home = root;

    const applied = applyUpgrade(root, appHome, home);

    expect(applied).toMatchObject({ code: 0, err: "" });
    expect(applied.out).toBe("Agentera upgraded this project from v2 to v3; state and startup validation passed.\n");
    expect(applied.out).not.toMatch(/manifest|migration|receipt|snapshot|rollback|operation[_ -]?id/i);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    for (const [relative, bytes] of sourceBefore) expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/migrations/entities"))).toBe(false);
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
    expect(refused.err).toContain("Recover the tracked v2 checkout with Git and retry");
    expect(refused.err).not.toMatch(/rollback|migration[_ -]?id|manifest|receipt|snapshot/i);
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

  it("accepts exact partial targets and continues at the first missing path", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-stage-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "entity_published";

    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    const partial = files(path.join(root, ".agentera/entities"));
    expect(partial).toHaveLength(1);
    const exact = path.join(root, ".agentera/entities", partial[0]);
    const inode = fs.statSync(exact, { bigint: true }).ino;
    delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;

    const initial = applyUpgrade(root, appHome, home);
    expect(initial.code, initial.err).toBe(0);
    expect(fs.statSync(exact, { bigint: true }).ino).toBe(inode);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
  }, 30_000);

  it("stops at a divergent target and names its path without activating", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-forward-"));
    roots.push(home);
    const appHome = managedV2(home);
    const sourceBefore = fs.readFileSync(path.join(root, ".agentera/progress.yaml"));
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "entity_published";

    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    const relative = files(path.join(root, ".agentera/entities"))[0];
    fs.writeFileSync(path.join(root, ".agentera/entities", relative), "divergent target\n");
    delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;

    const failed = applyUpgrade(root, appHome, home);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain(`.agentera/entities/${relative}`);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".agentera/progress.yaml"))).toEqual(sourceBefore);
  }, 30_000);

  it("leaves the marker absent when its last publication step fails", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-marker-fault-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "before_marker";

    const failed = applyUpgrade(root, appHome, home);

    expect(failed.code).not.toBe(0);
    expect(files(path.join(root, ".agentera/entities")).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  }, 30_000);

  it("keeps recovery forward when cleanup fails after entity authority activates", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-post-marker-failure-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE = "1";

    const failed = applyUpgrade(root, appHome, home);

    expect(failed.code).toBe(1);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(failed.err).toContain("Rerun the same upgrade command to continue forward");
    expect(failed.err).not.toMatch(/Recover the tracked v2 checkout with Git|no v3 authority was activated/i);
  }, 30_000);

  it("activates valid entities before handing off blocked runtime work", () => {
    const root = project();
    const hooks = path.join(root, ".codex/hooks/codex-hooks.json");
    fs.mkdirSync(path.dirname(hooks), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex/config.toml"), '[plugins."agentera@agentera"]\nenabled = true\n');
    fs.writeFileSync(hooks, '{"user":"hooks/validate_artifact.py"}\n');
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-runtime-blocked-"));
    roots.push(home);
    const appHome = managedV2(home);
    const resourceBefore = fs.readFileSync(hooks);

    const failed = applyUpgrade(root, appHome, home);

    expect(failed.code).toBe(1);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(fs.readFileSync(hooks)).toEqual(resourceBefore);
    expect(failed.err).toContain("action-required after entity activation");
    expect(failed.err).toContain(".codex/hooks/codex-hooks.json");
  }, 30_000);

  it("keeps entity authority active across normal writes and repeated upgrade", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-noop-"));
    roots.push(home);
    const appHome = managedV2(home);
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    const markerBefore = fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"));

    expect(capture(root, ["state", "progress", "append", "--type", "fix", "--phase", "build", "--what", "post-cutover write", "--intent", "prove entity authority", "--format", "json"]).code).toBe(0);
    expect(capture(root, ["state", "progress", "list", "--format", "json"]).code).toBe(0);
    managedV2(home);

    const repeated = applyUpgrade(root, appHome, home, undefined, "json");
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.out)).toEqual({
      phase: "complete",
      startup_validation: { status: "passed" },
      state_validation: { entity_count: expect.any(Number), issue_count: 0, status: "passed" },
      status: "success",
    });
    expect(fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"))).toEqual(markerBefore);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    expect(capture(root, ["state", "progress", "list", "--format", "json"]).out).toContain("post-cutover write");
  }, 30_000);

  it.each([
    ["state", { state_validation: { status: "failed", entity_count: 2, issue_count: 1 }, startup_validation: { status: "passed" } }],
    ["startup", { state_validation: { status: "passed", entity_count: 2, issue_count: 0 }, startup_validation: { status: "failed" } }],
  ])("exits nonzero with bounded forward guidance when %s validation fails", (_name, result) => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-verify-failure-"));
    roots.push(home);
    const appHome = managedV2(home);

    const failed = applyUpgrade(root, appHome, home, undefined, "json", {
      verifyOneWayUpgrade: () => result,
    });

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toEqual({ phase: "verification", status: "failed", ...result });
    expect(failed.err).toContain("Rerun the same upgrade command to continue forward");
    expect(failed.err).not.toMatch(/rollback|migration[_ -]?id|manifest|receipt|snapshot/i);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
  }, 30_000);

  it("does not let successful verification mask missing entity authority", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-masked-success-"));
    roots.push(home);
    const appHome = managedV2(home);

    const failed = applyUpgrade(root, appHome, home, undefined, "json", {
      verifyOneWayUpgrade: () => {
        fs.rmSync(path.join(root, ".agentera/state-mode.yaml"));
        return {
          state_validation: { status: "passed", entity_count: 2, issue_count: 0 },
          startup_validation: { status: "passed" },
        };
      },
    });

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({ phase: "apply", status: "failed" });
  }, 30_000);

  it("exposes preview only and has no entity recovery or cross-major restore commands", () => {
    const root = project();
    const entityHelp = capture(root, ["state", "migrate", "entities", "--help"]);
    expect(entityHelp.code).toBe(0);
    expect(entityHelp.out).toContain("--dry-run");
    expect(entityHelp.out).not.toMatch(/--(?:apply|resume|rollback)/);
    for (const args of [["--apply"], ["--resume", "deadbeef"], ["--rollback", "deadbeef"]]) {
      const rejected = capture(root, ["state", "migrate", "entities", ...args]);
      expect(rejected.code).toBe(1);
      expect(rejected.err).toContain("upgrade --channel development");
      expect(rejected.err).toContain("--yes");
    }
    expect(capture(root, ["upgrade", "--restore"]).code).toBe(2);
  });
});
