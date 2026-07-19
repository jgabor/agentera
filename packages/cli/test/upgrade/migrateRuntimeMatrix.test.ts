import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { opencodeConfigDir } from "../../src/setup/doctor.js";
import {
  NPX_HOOK_VALIDATE,
  applyMigrationPhases,
  applyRuntimeRewirePhase,
  dryRunMigration,
  planRuntimeRewirePhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  applyRuntimeMigrationItem,
  applyRuntimeMigrationItems,
  type NpxHookCommands,
  type RuntimeMigrationItem,
} from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx } from "./helpers/migrationCtx.js";
import { scanDirectoryForPythonLeftovers } from "./helpers/preservation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const TEST_HOOK_COMMANDS: NpxHookCommands = {
  cliEntrypoint: "agentera",
  validate: "agentera hook validate-artifact",
  cursorSessionStart: "agentera hook cursor-session-start",
  cursorSessionStop: "agentera hook session-stop",
  cursorPreTool: "agentera hook cursor-pre-tool-use",
};

let tmp: string;

function seedHappyPath(sandbox: string): { appHome: string; project: string; home: string } {
  const home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true });
  const appHome = path.join(home, ".local/share/agentera");
  fs.cpSync(path.join(FIXTURES, "v2-app-home"), appHome, { recursive: true });
  const project = path.join(sandbox, "project");
  fs.cpSync(path.join(FIXTURES, "v2-yaml-project"), project, { recursive: true });
  fs.cpSync(path.join(FIXTURES, "v2-runtime-python"), home, { recursive: true });
  return { appHome, project, home };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leftover-v2v3-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("leftoverScan", () => {
  it("finds no python managed refs on rewired codex and cursor configs", () => {
    const { appHome, project, home } = seedHappyPath(tmp);
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    applyMigrationPhases(ctx, preview, ["runtime"]);

    const hits = [
      ...scanDirectoryForPythonLeftovers(path.join(home, ".codex")),
      ...scanDirectoryForPythonLeftovers(path.join(home, ".cursor")),
      ...scanDirectoryForPythonLeftovers(path.join(project, ".cursor")),
    ];
    expect(hits).toEqual([]);

    const codexHooks = fs.readFileSync(path.join(home, ".codex/hooks/codex-hooks.json"), "utf8");
    expect(codexHooks).toContain(NPX_HOOK_VALIDATE);
  });
});

describe("migrateRuntimeMatrix", () => {
  it("reports pending rewire for codex-full fixture", () => {
    const home = path.join(tmp, "home-codex");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-codex-full"), home, { recursive: true });
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, path.join(home, "project"), home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);
    expect(phase.status).toBe("pending");
    expect(phase.items.some((item) => item.runtime === "codex")).toBe(true);
    applyRuntimeRewirePhase(phase, ctx);
    expect(phase.status).toBe("applied");
    const config = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(config).not.toContain("AGENTERA_HOME");
  });

  it("reports pending rewire for cursor-full project and user hooks", () => {
    const home = path.join(tmp, "home-cursor");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-cursor-full/home"), home, { recursive: true });
    const project = path.join(tmp, "project-cursor");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-cursor-full/project"), project, { recursive: true });
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);
    expect(phase.items.filter((item) => item.runtime === "cursor" && item.status === "pending").length).toBeGreaterThan(0);
    applyRuntimeRewirePhase(phase, ctx);
    const projectHooks = fs.readFileSync(path.join(project, ".cursor/hooks.json"), "utf8");
    expect(projectHooks).toContain("npx -y agentera");
    expect(projectHooks).not.toContain("cursor_session_start.py");
  });

  it("reports pending rewire for opencode plugin fixture", () => {
    const home = path.join(tmp, "home-opencode");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-opencode"), home, { recursive: true });
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, path.join(home, "project"), home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);
    expect(phase.items.some((item) => item.runtime === "opencode" && item.status === "pending")).toBe(true);
    applyRuntimeRewirePhase(phase, ctx);
    const plugin = fs.readFileSync(path.join(home, "xdg/opencode/plugins/agentera.js"), "utf8");
    expect(plugin).toContain("npx -y agentera@next");
    expect(plugin).not.toContain("validate_artifact.py");
  });
});

describe("migrationCtx env isolation", () => {
  it("default env does not inherit the developer XDG_CONFIG_HOME", () => {
    const devXdg = process.env.XDG_CONFIG_HOME;
    const home = path.join(tmp, "isolated-home");
    fs.mkdirSync(home, { recursive: true });
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(home, "project"), home, REPO_ROOT);
    const configDir = opencodeConfigDir(ctx.home, ctx.env ?? {});
    expect(configDir).toBe(path.join(home, "xdg", "opencode"));
    if (devXdg) {
      expect(configDir).not.toBe(path.join(devXdg, "opencode"));
    }
    expect(configDir.startsWith(home)).toBe(true);
  });
});

describe("runtime", () => {
  it.each([
    ["copy-plugin", "file"],
    ["copy-agent", "file"],
    ["copy-command", "file"],
    ["link-skill", "directory"],
  ] as const)("rejects retired %s at the direct apply boundary without touching user files", (action, targetKind) => {
    const root = path.join(tmp, action);
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const sentinel = path.join(root, "keep.txt");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(sentinel, "keep\n");
    if (targetKind === "directory") {
      fs.mkdirSync(source);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "owned.txt"), "owned\n");
    } else {
      fs.writeFileSync(source, "managed replacement\n");
      fs.writeFileSync(target, "user target\n");
    }
    const targetInode = fs.lstatSync(target).ino;
    const sentinelInode = fs.lstatSync(sentinel).ino;
    const item = {
      status: "pending",
      action,
      runtime: "test",
      source,
      target,
      message: "test",
    } as unknown as RuntimeMigrationItem;

    applyRuntimeMigrationItem(item, TEST_HOOK_COMMANDS);

    expect(item.status).toBe("failed");
    expect(item.message).toBe(`unsupported runtime migration action: ${action}`);
    expect(fs.readdirSync(root).sort()).toEqual(["keep.txt", "source", "target"]);
    expect(fs.lstatSync(target).ino).toBe(targetInode);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(sentinel).ino).toBe(sentinelInode);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep\n");
    if (targetKind === "directory") {
      expect(fs.readdirSync(target)).toEqual(["owned.txt"]);
      expect(fs.readFileSync(path.join(target, "owned.txt"), "utf8")).toBe("owned\n");
    } else {
      expect(fs.readFileSync(target, "utf8")).toBe("user target\n");
    }
  });

  it("rejects an unknown pending action without touching its target", () => {
    const home = path.join(tmp, "unknown-action-home");
    const target = path.join(home, "owned-target");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(target, "user content\n");
    const item = {
      status: "pending" as const,
      action: "unknown-action",
      runtime: "test",
      source: path.join(home, "source"),
      target,
      message: "test",
    };

    applyRuntimeMigrationItems([item], migrationCtx(path.join(home, "app"), path.join(home, "project"), home, REPO_ROOT));

    expect(item.status).toBe("failed");
    expect(item.message).toBe("unsupported runtime migration action: unknown-action");
    expect(fs.readFileSync(target, "utf8")).toBe("user content\n");
    expectTypeOf(item.action).not.toEqualTypeOf<RuntimeMigrationItem["action"]>();
  });

  it("mixedVersionsReconcile: per-runtime rewire is planned independently for codex and cursor configs", () => {
    const home = path.join(tmp, "home-mixed");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-codex-full"), home, { recursive: true });
    const project = path.join(tmp, "project-mixed");
    fs.cpSync(path.join(FIXTURES, "v2-runtime-cursor-full", "project"), project, { recursive: true });
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);

    const pendingRuntimes = new Set(
      phase.items
        .filter((i) => i.status === "pending" && i.action === "rewire-runtime")
        .map((i) => i.runtime),
    );
    expect(pendingRuntimes.has("codex")).toBe(true);
    expect(pendingRuntimes.has("cursor")).toBe(true);

    applyRuntimeRewirePhase(phase, ctx);
    expect(phase.status).toBe("applied");

    const codexConfig = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(codexConfig).not.toContain("AGENTERA_HOME");
    const codexHooksPath = path.join(home, ".codex", "hooks", "codex-hooks.json");
    expect(fs.existsSync(codexHooksPath)).toBe(false);
    const cursorHooks = fs.readFileSync(path.join(project, ".cursor", "hooks.json"), "utf8");
    expect(cursorHooks).toContain("npx -y agentera");
    expect(cursorHooks).not.toContain("cursor_session_start.py");
  });
});
