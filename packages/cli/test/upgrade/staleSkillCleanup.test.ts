import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opencodeConfigDir } from "../../src/setup/opencode.js";
import type { MigrationPhaseItem } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  applyRuntimeMigrationItem,
  applyRuntimeMigrationItems,
  planRuntimeMigrationItems,
  planStaleSkillCleanupItems,
  resolveNpxHookCommands,
} from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let home: string;

function skillsDirFor(home: string): string {
  return path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "skills");
}

function makeSkillDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}`);
  return dir;
}

function makeSymlink(skillsDir: string, name: string, target: string): string {
  fs.mkdirSync(skillsDir, { recursive: true });
  const linkPath = path.join(skillsDir, name);
  fs.symlinkSync(target, linkPath);
  return linkPath;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-skill-cleanup-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("planStaleSkillCleanupItems", () => {
  it("targets dangling agentera-managed hej but skips valid agentera and user-owned", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");

    const hejTarget = path.join(agenteraApp, "hej");
    const hejLink = makeSymlink(skillsDir, "hej", hejTarget);

    const agenteraSource = makeSkillDir(agenteraApp, "agentera");
    makeSymlink(skillsDir, "agentera", agenteraSource);

    const userSource = makeSkillDir(path.join(tmp, "user-tools"), "my-skill");
    makeSymlink(skillsDir, "my-skill", userSource);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleSkillCleanupItems(ctx, items);

    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe("remove-stale-skill");
    expect(items[0]?.runtime).toBe("opencode");
    expect(items[0]?.status).toBe("pending");
    expect(items[0]?.source).toBe(hejLink);
    expect(items.some((item) => path.basename(item.source ?? "") === "agentera")).toBe(false);
    expect(items.some((item) => path.basename(item.source ?? "") === "my-skill")).toBe(false);
  });

  it("targets a non-dangling agentera-managed symlink not in OPENCODE_SKILL_NAMES", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");
    const oldSkillSource = makeSkillDir(agenteraApp, "old-skill");
    const link = makeSymlink(skillsDir, "old-skill", oldSkillSource);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleSkillCleanupItems(ctx, items);

    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe("remove-stale-skill");
    expect(items[0]?.source).toBe(link);
  });

  it("skips user-owned symlinks even when dangling", () => {
    const skillsDir = skillsDirFor(home);
    makeSymlink(skillsDir, "my-broken", path.join(tmp, "nope", "my-skill"));

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleSkillCleanupItems(ctx, items);

    expect(items).toEqual([]);
  });

  it("skips non-symlink entries (real directories)", () => {
    const skillsDir = skillsDirFor(home);
    fs.mkdirSync(path.join(skillsDir, "real-dir"), { recursive: true });

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleSkillCleanupItems(ctx, items);

    expect(items).toEqual([]);
  });

  it("is a no-op when the skills dir does not exist", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleSkillCleanupItems(ctx, items);
    expect(items).toEqual([]);
  });

  it("pushes into an existing items array without clearing it", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");
    makeSymlink(skillsDir, "hej", path.join(agenteraApp, "hej"));

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const existing: MigrationPhaseItem[] = [
      { status: "noop", action: "configure", runtime: "claude", message: "prev" },
    ];
    planStaleSkillCleanupItems(ctx, existing);
    expect(existing).toHaveLength(2);
    expect(existing[0]?.action).toBe("configure");
    expect(existing[1]?.action).toBe("remove-stale-skill");
  });
});

describe("planStaleSkillCleanupItems wiring", () => {
  it("appears in planRuntimeMigrationItems under the runtime phase", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");
    const hejLink = makeSymlink(skillsDir, "hej", path.join(agenteraApp, "hej"));

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const stale = items.filter((item) => item.action === "remove-stale-skill");

    expect(stale).toHaveLength(1);
    expect(stale[0]?.source).toBe(hejLink);
    expect(stale[0]?.status).toBe("pending");
  });

  it("does not appear when there are no stale skill symlinks", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const stale = items.filter((item) => item.action === "remove-stale-skill");
    expect(stale).toEqual([]);
  });
});

describe("applyRuntimeMigrationItem remove-stale-skill", () => {
  it("removes the dangling symlink and marks applied", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");
    const hejLink = makeSymlink(skillsDir, "hej", path.join(agenteraApp, "hej"));

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const stale = items.find((item) => item.action === "remove-stale-skill")!;
    const commands = resolveNpxHookCommands(ctx);

    applyRuntimeMigrationItem(stale, commands);

    expect(stale.status).toBe("applied");
    expect(stale.message).toContain("hej");
    expect(fs.existsSync(hejLink)).toBe(false);
  });

  it("preserves valid agentera and user-owned symlinks during apply", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");

    const hejLink = makeSymlink(skillsDir, "hej", path.join(agenteraApp, "hej"));
    const agenteraSource = makeSkillDir(agenteraApp, "agentera");
    const agenteraLink = makeSymlink(skillsDir, "agentera", agenteraSource);
    const userSource = makeSkillDir(path.join(tmp, "user-tools"), "my-skill");
    const userLink = makeSymlink(skillsDir, "my-skill", userSource);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    applyRuntimeMigrationItems(items, ctx);

    expect(fs.existsSync(hejLink)).toBe(false);
    expect(fs.lstatSync(agenteraLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(userLink).isSymbolicLink()).toBe(true);
  });

  it("is a noop when the stale skill is already absent", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const commands = resolveNpxHookCommands(ctx);
    const item: MigrationPhaseItem = {
      status: "pending",
      action: "remove-stale-skill",
      runtime: "opencode",
      source: path.join(skillsDirFor(home), "missing"),
      message: "will remove stale skill symlink missing",
    };

    applyRuntimeMigrationItem(item, commands);

    expect(item.status).toBe("noop");
    expect(item.message).toContain("already absent");
  });

  it("fails when source is missing", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const commands = resolveNpxHookCommands(ctx);
    const item: MigrationPhaseItem = {
      status: "pending",
      action: "remove-stale-skill",
      runtime: "opencode",
      message: "will remove stale skill symlink",
    };

    applyRuntimeMigrationItem(item, commands);

    expect(item.status).toBe("failed");
    expect(item.message).toContain("missing source");
  });

  it("is a noop when the path is not a symlink", () => {
    const skillsDir = skillsDirFor(home);
    fs.mkdirSync(skillsDir, { recursive: true });
    const realDir = path.join(skillsDir, "real-dir");
    fs.mkdirSync(realDir, { recursive: true });

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const commands = resolveNpxHookCommands(ctx);
    const item: MigrationPhaseItem = {
      status: "pending",
      action: "remove-stale-skill",
      runtime: "opencode",
      source: realDir,
      message: "will remove stale skill symlink real-dir",
    };

    applyRuntimeMigrationItem(item, commands);

    expect(item.status).toBe("noop");
    expect(item.message).toContain("not a symlink");
    expect(fs.existsSync(realDir)).toBe(true);
  });

  it("skips non-pending items", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const commands = resolveNpxHookCommands(ctx);
    const item: MigrationPhaseItem = {
      status: "noop",
      action: "remove-stale-skill",
      runtime: "opencode",
      source: path.join(tmp, "irrelevant"),
      message: "should not change",
    };

    applyRuntimeMigrationItem(item, commands);

    expect(item.status).toBe("noop");
    expect(item.message).toBe("should not change");
  });
});

describe("applyRuntimeMigrationItems integration", () => {
  it("removes stale skill symlinks and preserves valid ones", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");

    const hejLink = makeSymlink(skillsDir, "hej", path.join(agenteraApp, "hej"));
    const agenteraSource = makeSkillDir(agenteraApp, "agentera");
    const agenteraLink = makeSymlink(skillsDir, "agentera", agenteraSource);
    const userSource = makeSkillDir(path.join(tmp, "user-tools"), "my-skill");
    const userLink = makeSymlink(skillsDir, "my-skill", userSource);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    applyRuntimeMigrationItems(items, ctx);

    expect(fs.existsSync(hejLink)).toBe(false);
    expect(fs.lstatSync(agenteraLink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(userLink).isSymbolicLink()).toBe(true);
    const stale = items.filter((item) => item.action === "remove-stale-skill");
    expect(stale.every((item) => item.status === "applied")).toBe(true);
  });

  it("is idempotent: second run produces no pending stale-skill items", () => {
    const skillsDir = skillsDirFor(home);
    const agenteraApp = path.join(tmp, "agentera-app", "skills");
    const hejLink = makeSymlink(skillsDir, "hej", path.join(agenteraApp, "hej"));

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);

    const firstPlan = planRuntimeMigrationItems(ctx);
    applyRuntimeMigrationItems(firstPlan, ctx);
    expect(fs.existsSync(hejLink)).toBe(false);

    const secondPlan = planRuntimeMigrationItems(ctx);
    const stale = secondPlan.filter((item) => item.action === "remove-stale-skill");
    expect(stale).toEqual([]);
  });
});
