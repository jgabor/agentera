import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opencodeConfigDir } from "../../src/setup/doctor.js";
import {
  NPX_HOOK_VALIDATE,
  applyMigrationPhases,
  applyRuntimeRewirePhase,
  dryRunMigration,
  planRuntimeRewirePhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { applyRuntimeMigrationItem } from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx } from "./helpers/migrationCtx.js";
import { scanDirectoryForPythonLeftovers } from "./helpers/preservation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

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

describe("applyRuntimeMigrationItem link-skill", () => {
  const commands = {
    hookValidate: "npx -y agentera@next hooks validate",
    cliEntrypoint: "npx -y agentera@next",
    sessionStart: "npx -y agentera@next hooks session-start",
    sessionStop: "npx -y agentera@next hooks session-stop",
  };

  it("replaces a pre-existing regular file at the target with a symlink", () => {
    const sandbox = path.join(tmp, "link-file");
    const source = path.join(sandbox, "skill-src");
    const target = path.join(sandbox, "skills", "agentera");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "# skill\n");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "stale file\n");

    const item = {
      status: "pending" as const,
      action: "link-skill" as const,
      runtime: "opencode",
      source,
      target,
      message: "test",
    };
    applyRuntimeMigrationItem(item, commands);
    expect(item.status).toBe("applied");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(target)).toBe(source);
  });

  it("replaces a pre-existing dangling symlink at the target", () => {
    const sandbox = path.join(tmp, "link-dangling");
    const source = path.join(sandbox, "skill-src");
    const target = path.join(sandbox, "skills", "agentera");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "# skill\n");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.join(sandbox, "missing-skill-dir"), target);

    const item = {
      status: "pending" as const,
      action: "link-skill" as const,
      runtime: "opencode",
      source,
      target,
      message: "test",
    };
    applyRuntimeMigrationItem(item, commands);
    expect(item.status).toBe("applied");
    expect(fs.readlinkSync(target)).toBe(source);
    expect(fs.existsSync(path.join(source, "SKILL.md"))).toBe(true);
  });
});
