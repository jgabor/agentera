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
  planStaleCommandCleanupItems,
  resolveNpxHookCommands,
} from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let home: string;

const MANAGED_HEJ = [
  "---",
  'description: "hej bridge"',
  "agentera_managed: true",
  "---",
  "Bridge to the agentera skill\n",
].join("\n");

const MANAGED_LIRA = [
  "---",
  'description: "lira todo"',
  "agentera_managed: true",
  "---",
  "Todo bridge command\n",
].join("\n");

const MANAGED_AGENTERA = [
  "---",
  'description: "agentera"',
  "agentera_managed: true",
  "---",
  "Load and execute the agentera skill for this project.\n",
].join("\n");

const UNMANAGED_BRAINSTORM = [
  "---",
  'description: "user brainstorm"',
  "---",
  "User-owned brainstorm command\n",
].join("\n");

const UNMANAGED_HEJ = "# user-authored hej\n";

function writeCommand(commandsDir: string, name: string, body: string): string {
  fs.mkdirSync(commandsDir, { recursive: true });
  const p = path.join(commandsDir, `${name}.md`);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

function commandsDirFor(home: string): string {
  return path.join(opencodeConfigDir(home, sandboxMigrationEnv(home, REPO_ROOT)), "commands");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-command-cleanup-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("planStaleCommandCleanupItems", () => {
  it("targets managed hej.md but skips unmanaged brainstorm.md", () => {
    const commandsDir = commandsDirFor(home);
    writeCommand(commandsDir, "hej", MANAGED_HEJ);
    writeCommand(commandsDir, "brainstorm", UNMANAGED_BRAINSTORM);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleCommandCleanupItems(ctx, items);

    expect(items).toHaveLength(1);
    expect(items[0]?.action).toBe("remove-stale-command");
    expect(items[0]?.runtime).toBe("opencode");
    expect(items[0]?.status).toBe("pending");
    expect(items[0]?.source).toBe(path.join(commandsDir, "hej.md"));
    expect(items.some((item) => item.source?.endsWith("brainstorm.md"))).toBe(false);
  });

  it("does not target agentera.md (it is in OPENCODE_COMMAND_NAMES)", () => {
    const commandsDir = commandsDirFor(home);
    writeCommand(commandsDir, "agentera", MANAGED_AGENTERA);
    writeCommand(commandsDir, "hej", MANAGED_HEJ);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleCommandCleanupItems(ctx, items);

    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe(path.join(commandsDir, "hej.md"));
    expect(items.some((item) => item.source?.endsWith("agentera.md"))).toBe(false);
  });

  it("targets multiple stale managed commands", () => {
    const commandsDir = commandsDirFor(home);
    writeCommand(commandsDir, "hej", MANAGED_HEJ);
    writeCommand(commandsDir, "lira.todo", MANAGED_LIRA);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleCommandCleanupItems(ctx, items);

    expect(items).toHaveLength(2);
    expect(items.some((item) => item.source?.endsWith("hej.md"))).toBe(true);
    expect(items.some((item) => item.source?.endsWith("lira.todo.md"))).toBe(true);
  });

  it("skips unmanaged files even if the name is a stale verb", () => {
    const commandsDir = commandsDirFor(home);
    writeCommand(commandsDir, "hej", UNMANAGED_HEJ);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleCommandCleanupItems(ctx, items);

    expect(items).toEqual([]);
  });

  it("is a no-op when the commands dir does not exist", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleCommandCleanupItems(ctx, items);
    expect(items).toEqual([]);
  });

  it("skips non-.md files", () => {
    const commandsDir = commandsDirFor(home);
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, "hej.txt"), MANAGED_HEJ, "utf8");

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items: MigrationPhaseItem[] = [];
    planStaleCommandCleanupItems(ctx, items);
    expect(items).toEqual([]);
  });

  it("pushes into an existing items array without clearing it", () => {
    const commandsDir = commandsDirFor(home);
    writeCommand(commandsDir, "hej", MANAGED_HEJ);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const existing: MigrationPhaseItem[] = [
      { status: "noop", action: "configure", runtime: "opencode", message: "prev" },
    ];
    planStaleCommandCleanupItems(ctx, existing);
    expect(existing).toHaveLength(2);
    expect(existing[0]?.action).toBe("configure");
    expect(existing[1]?.action).toBe("remove-stale-command");
  });
});

describe("planStaleCommandCleanupItems wiring", () => {
  it("appears in planRuntimeMigrationItems under the runtime phase", () => {
    const commandsDir = commandsDirFor(home);
    writeCommand(commandsDir, "hej", MANAGED_HEJ);
    writeCommand(commandsDir, "brainstorm", UNMANAGED_BRAINSTORM);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const stale = items.filter((item) => item.action === "remove-stale-command");

    expect(stale).toHaveLength(1);
    expect(stale[0]?.source).toBe(path.join(commandsDir, "hej.md"));
    expect(stale[0]?.status).toBe("pending");
    expect(items.some((item) => item.source?.endsWith("brainstorm.md"))).toBe(false);
  });

  it("does not appear when there are no stale managed commands", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const stale = items.filter((item) => item.action === "remove-stale-command");
    expect(stale).toEqual([]);
  });
});

describe("applyRuntimeMigrationItem remove-stale-command", () => {
  it("preserves a marker-owned command replaced after preview", () => {
    const commandsDir = commandsDirFor(home);
    const command = writeCommand(commandsDir, "hej", MANAGED_HEJ);
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const item = planRuntimeMigrationItems(ctx).find((candidate) => candidate.source === command)!;
    fs.unlinkSync(command);
    fs.writeFileSync(command, UNMANAGED_HEJ);

    applyRuntimeMigrationItem(item, resolveNpxHookCommands(ctx));

    expect(item.status).toBe("blocked");
    expect(fs.readFileSync(command, "utf8")).toBe(UNMANAGED_HEJ);
  });

  it("removes the stale managed command file and marks applied", () => {
    const commandsDir = commandsDirFor(home);
    const hejPath = writeCommand(commandsDir, "hej", MANAGED_HEJ);
    writeCommand(commandsDir, "brainstorm", UNMANAGED_BRAINSTORM);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const stale = items.find((item) => item.action === "remove-stale-command")!;
    const commands = resolveNpxHookCommands(ctx);

    applyRuntimeMigrationItem(stale, commands);

    expect(stale.status).toBe("applied");
    expect(stale.message).toContain("hej.md");
    expect(fs.existsSync(hejPath)).toBe(false);
    expect(fs.existsSync(path.join(commandsDir, "brainstorm.md"))).toBe(true);
  });

  it("is a noop when the stale command is already absent", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const commands = resolveNpxHookCommands(ctx);
    const item: MigrationPhaseItem = {
      status: "pending",
      action: "remove-stale-command",
      runtime: "opencode",
      source: path.join(tmp, "missing.md"),
      message: "will remove stale managed command missing.md",
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
      action: "remove-stale-command",
      runtime: "opencode",
      message: "will remove stale managed command",
    };

    applyRuntimeMigrationItem(item, commands);

    expect(item.status).toBe("failed");
    expect(item.message).toContain("missing source");
  });

  it("skips non-pending items", () => {
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const commands = resolveNpxHookCommands(ctx);
    const item: MigrationPhaseItem = {
      status: "noop",
      action: "remove-stale-command",
      runtime: "opencode",
      source: path.join(tmp, "irrelevant.md"),
      message: "should not change",
    };

    applyRuntimeMigrationItem(item, commands);

    expect(item.status).toBe("noop");
    expect(item.message).toBe("should not change");
  });
});

describe("applyRuntimeMigrationItems integration", () => {
  it("removes stale managed commands and preserves unmanaged ones", () => {
    const commandsDir = commandsDirFor(home);
    const hejPath = writeCommand(commandsDir, "hej", MANAGED_HEJ);
    writeCommand(commandsDir, "brainstorm", UNMANAGED_BRAINSTORM);
    writeCommand(commandsDir, "agentera", MANAGED_AGENTERA);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    applyRuntimeMigrationItems(items, ctx);

    expect(fs.existsSync(hejPath)).toBe(false);
    expect(fs.existsSync(path.join(commandsDir, "brainstorm.md"))).toBe(true);
    const stale = items.filter((item) => item.action === "remove-stale-command");
    expect(stale.every((item) => item.status === "applied")).toBe(true);
  });

  it("is idempotent: second run produces no pending stale-command items", () => {
    const commandsDir = commandsDirFor(home);
    const hejPath = writeCommand(commandsDir, "hej", MANAGED_HEJ);

    const ctx = migrationCtx(path.join(home, "agentera"), path.join(tmp, "project"), home, REPO_ROOT);

    const firstPlan = planRuntimeMigrationItems(ctx);
    applyRuntimeMigrationItems(firstPlan, ctx);
    expect(fs.existsSync(hejPath)).toBe(false);

    const secondPlan = planRuntimeMigrationItems(ctx);
    const stale = secondPlan.filter((item) => item.action === "remove-stale-command");
    expect(stale).toEqual([]);
  });
});
