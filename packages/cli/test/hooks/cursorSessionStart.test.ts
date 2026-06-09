import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInstallRoot, runCursorSessionStart } from "../../src/hooks/cursorSessionStart.js";
import { resolvePath } from "../../src/core/paths.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-ss-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSetupRoot(root: string): void {
  // Node-era setup evidence: app data surfaces (no Python scripts/hooks).
  for (const entry of ["skills/agentera/SKILL.md", "registry.json"]) {
    fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
    fs.writeFileSync(path.join(root, entry), "fixture\n");
  }
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
}

const PLUGIN = "/opt/agentera-plugin";

describe("resolveInstallRoot", () => {
  it("prefers a managed AGENTERA_HOME env", () => {
    const managed = path.join(tmp, "managed");
    writeSetupRoot(managed);
    const resolved = resolveInstallRoot(path.join(tmp, "project"), {
      env: { AGENTERA_HOME: managed },
      pluginRoot: PLUGIN,
    });
    expect(resolved).toBe(resolvePath(managed));
  });

  it("walks up from the project cwd", () => {
    const managed = path.join(tmp, "checkout");
    writeSetupRoot(managed);
    const project = path.join(managed, "apps", "demo");
    fs.mkdirSync(project, { recursive: true });
    const resolved = resolveInstallRoot(project, { env: {}, pluginRoot: PLUGIN });
    expect(resolved).toBe(resolvePath(managed));
  });

  it("falls back to a managed plugin root when env and walk miss", () => {
    const pluginRoot = path.join(tmp, "plugin");
    writeSetupRoot(pluginRoot);
    const unrelated = path.join(tmp, "unrelated");
    fs.mkdirSync(unrelated);
    const resolved = resolveInstallRoot(unrelated, { env: {}, pluginRoot });
    expect(resolved).toBe(resolvePath(pluginRoot));
  });

  it("falls back to a managed platform default app home", () => {
    const home = path.join(tmp, "home");
    const platformDefault =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "agentera")
        : process.platform === "win32"
          ? path.join(home, "AppData", "Roaming", "agentera")
          : path.join(home, ".local", "share", "agentera");
    writeSetupRoot(platformDefault);
    const unrelated = path.join(tmp, "unrelated");
    fs.mkdirSync(unrelated);
    const emptyPlugin = path.join(tmp, "empty-plugin");
    fs.mkdirSync(emptyPlugin);
    const resolved = resolveInstallRoot(unrelated, {
      env: { HOME: home },
      pluginRoot: emptyPlugin,
    });
    expect(resolved).toBe(resolvePath(platformDefault));
  });

  it("ignores an invalid AGENTERA_HOME and still falls back to the plugin root", () => {
    const pluginRoot = path.join(tmp, "plugin");
    writeSetupRoot(pluginRoot);
    const unrelated = path.join(tmp, "unrelated");
    fs.mkdirSync(unrelated);
    const resolved = resolveInstallRoot(unrelated, {
      env: { AGENTERA_HOME: path.join(tmp, "missing") },
      pluginRoot,
    });
    expect(resolved).toBe(resolvePath(pluginRoot));
  });
});

describe("runCursorSessionStart", () => {
  it("exports AGENTERA_HOME via the plugin fallback", () => {
    const pluginRoot = path.join(tmp, "plugin");
    writeSetupRoot(pluginRoot);
    const unrelated = path.join(tmp, "workspace");
    fs.mkdirSync(unrelated);
    let output = "";
    const code = runCursorSessionStart(JSON.stringify({ cwd: unrelated }), {
      env: { AGENTERA_HOME: undefined } as Record<string, string | undefined>,
      pluginRoot,
      out: (t) => (output = t),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output).env.AGENTERA_HOME).toBe(resolvePath(pluginRoot));
  });

  it("exports AGENTERA_HOME from the platform default when env and walk miss", () => {
    const home = path.join(tmp, "home");
    const platformDefault =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "agentera")
        : process.platform === "win32"
          ? path.join(home, "AppData", "Roaming", "agentera")
          : path.join(home, ".local", "share", "agentera");
    writeSetupRoot(platformDefault);
    const unrelated = path.join(tmp, "workspace");
    fs.mkdirSync(unrelated);
    let output = "";
    const code = runCursorSessionStart(JSON.stringify({ cwd: unrelated }), {
      env: { HOME: home },
      pluginRoot: path.join(tmp, "empty-plugin"),
      out: (t) => (output = t),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output).env.AGENTERA_HOME).toBe(resolvePath(platformDefault));
  });

  it("exports AGENTERA_HOME from a walk-up checkout", () => {
    const managed = path.join(tmp, "checkout");
    writeSetupRoot(managed);
    const project = path.join(managed, "service");
    fs.mkdirSync(project);
    let output = "";
    runCursorSessionStart(JSON.stringify({ cwd: project }), {
      env: {},
      pluginRoot: PLUGIN,
      out: (t) => (output = t),
    });
    expect(JSON.parse(output).env.AGENTERA_HOME).toBe(resolvePath(managed));
  });
});
