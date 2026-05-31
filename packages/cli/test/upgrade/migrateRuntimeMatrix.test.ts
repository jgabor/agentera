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
    const preview = dryRunMigration({ appHome, project, home });
    applyMigrationPhases({ appHome, project, home }, preview, ["runtime"]);

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
    const phase = planRuntimeRewirePhase({
      appHome,
      project: path.join(home, "project"),
      home,
    });
    expect(phase.status).toBe("pending");
    expect(phase.items.some((item) => item.runtime === "codex")).toBe(true);
    applyRuntimeRewirePhase(phase);
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
    const phase = planRuntimeRewirePhase({ appHome, project, home });
    expect(phase.items.filter((item) => item.runtime === "cursor" && item.status === "pending").length).toBeGreaterThan(0);
    applyRuntimeRewirePhase(phase);
    const projectHooks = fs.readFileSync(path.join(project, ".cursor/hooks.json"), "utf8");
    expect(projectHooks).toContain("npx -y agentera");
    expect(projectHooks).not.toContain("cursor_session_start.py");
  });
});
