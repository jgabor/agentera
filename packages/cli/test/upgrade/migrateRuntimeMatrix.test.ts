import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPX_HOOK_VALIDATE,
  applyMigrationPhases,
  applyRuntimeRewirePhase,
  dryRunMigration,
  planRuntimeRewirePhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
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

function migrationCtx(appHome: string, project: string, home: string, env?: Record<string, string>) {
  return {
    appHome,
    project,
    home,
    sourceRoot: REPO_ROOT,
    channel: "development" as const,
    env: env ?? { ...process.env, HOME: home },
  };
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
    const ctx = migrationCtx(appHome, project, home);
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
    const ctx = migrationCtx(appHome, path.join(home, "project"), home);
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
    const ctx = migrationCtx(appHome, project, home);
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
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") };
    const ctx = migrationCtx(appHome, path.join(home, "project"), home, env);
    const phase = planRuntimeRewirePhase(ctx);
    expect(phase.items.some((item) => item.runtime === "opencode" && item.status === "pending")).toBe(true);
    applyRuntimeRewirePhase(phase, ctx);
    const plugin = fs.readFileSync(path.join(home, "xdg/opencode/plugins/agentera.js"), "utf8");
    expect(plugin).toContain("npx -y agentera@next");
    expect(plugin).not.toContain("validate_artifact.py");
  });
});
