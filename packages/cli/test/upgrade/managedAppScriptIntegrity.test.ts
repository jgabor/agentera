import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUNDLE_MARKER,
} from "../../src/state/installRoot.js";
import {
  MANAGED_APP_SCRIPT_PATH,
  NODE_SHEBANG,
  PYTHON_SHEBANG,
  UV_SCRIPT_SHEBANG,
  managedAppScriptContent,
  platformDefaultAppHome as helperPlatformDefaultAppHome,
  scriptBody,
  scriptShebang,
  writeManagedAppStub,
} from "../helpers/managedAppStub.js";

let tmp: string;
let priorXdg: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "managed-app-stub-"));
  priorXdg = process.env.XDG_DATA_HOME;
});

afterEach(() => {
  if (priorXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("managed app script stub integrity", () => {
  it("PASS: a valid Python write preserves shebang and content correctly", () => {
    const appHome = path.join(tmp, "app-home");
    writeManagedAppStub(appHome, { runtime: "python", marker: "2.7.0" });

    const scriptPath = path.join(appHome, MANAGED_APP_SCRIPT_PATH);
    const content = fs.readFileSync(scriptPath, "utf8");
    const firstLine = content.split("\n")[0];

    expect(firstLine).toBe(PYTHON_SHEBANG);
    expect(content).toContain("sub.add_parser");
    expect(content).not.toContain(NODE_SHEBANG);
    expect(fs.statSync(scriptPath).size).toBeGreaterThan(PYTHON_SHEBANG.length);
  });

  it("PASS: a valid Node write preserves shebang and content correctly", () => {
    const appHome = path.join(tmp, "app-home-node");
    writeManagedAppStub(appHome, { runtime: "node", marker: "3.0.0" });

    const scriptPath = path.join(appHome, MANAGED_APP_SCRIPT_PATH);
    const content = fs.readFileSync(scriptPath, "utf8");
    const firstLine = content.split("\n")[0];

    expect(firstLine).toBe(NODE_SHEBANG);
    expect(content).not.toContain("sub.add_parser");
    expect(fs.statSync(scriptPath).size).toBeGreaterThan(NODE_SHEBANG.length);
  });

  it("FAIL: managedAppScriptContent never mixes a Node shebang with Python body", () => {
    const pythonContent = managedAppScriptContent("python");
    const nodeContent = managedAppScriptContent("node");

    const pythonFirstLine = pythonContent.split("\n")[0];
    const nodeFirstLine = nodeContent.split("\n")[0];

    expect(pythonFirstLine).toBe(PYTHON_SHEBANG);
    expect(pythonContent).not.toContain(NODE_SHEBANG);
    expect(pythonContent).toContain(scriptBody("python"));

    expect(nodeFirstLine).toBe(NODE_SHEBANG);
    expect(nodeContent).not.toContain(PYTHON_SHEBANG);
    expect(nodeContent).toContain(scriptBody("node"));
  });

  it("FAIL: scriptShebang and scriptBody are always runtime-consistent", () => {
    expect(scriptShebang("python")).toBe(PYTHON_SHEBANG);
    expect(scriptBody("python")).not.toMatch(/void 0/);

    expect(scriptShebang("node")).toBe(NODE_SHEBANG);
    expect(scriptBody("node")).not.toMatch(/sub\.add_parser/);
  });

  it("FAIL: a Python stub with a UV-script shebang is accepted as Python", () => {
    const appHome = path.join(tmp, "uv-app-home");
    const uvContent = `${UV_SCRIPT_SHEBANG}\n# /// script\n# dependencies: []\n# ///\nsub.add_parser('hej')\n`;
    writeManagedAppStub(appHome, { runtime: "python", scriptContent: uvContent, marker: null });

    const scriptPath = path.join(appHome, MANAGED_APP_SCRIPT_PATH);
    const content = fs.readFileSync(scriptPath, "utf8");
    const firstLine = content.split("\n")[0];

    expect(firstLine).toBe(UV_SCRIPT_SHEBANG);
    expect(content).toContain("sub.add_parser");
    expect(content).not.toContain(NODE_SHEBANG);
  });
});

describe("platformDefaultAppHome isolation from XDG_DATA_HOME", () => {
  it("PASS: resolves under the provided home even when XDG_DATA_HOME is set", () => {
    const realXdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    process.env.XDG_DATA_HOME = realXdg;

    const fakeHome = path.join(tmp, "fake-home");
    const resolved = helperPlatformDefaultAppHome(fakeHome);

    expect(resolved.startsWith(fakeHome)).toBe(true);
    expect(resolved.startsWith(realXdg)).toBe(false);
  });

  it("PASS: writing a stub through the helper never touches the real XDG_DATA_HOME path", () => {
    const realXdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
    process.env.XDG_DATA_HOME = realXdg;

    const fakeHome = path.join(tmp, "fake-home");
    const appHome = helperPlatformDefaultAppHome(fakeHome);
    writeManagedAppStub(appHome, { runtime: "python", marker: "v1" });

    expect(appHome.startsWith(realXdg)).toBe(false);
    expect(appHome.startsWith(fakeHome)).toBe(true);

    const stubScript = path.join(appHome, MANAGED_APP_SCRIPT_PATH);
    expect(fs.existsSync(stubScript)).toBe(true);
    const content = fs.readFileSync(stubScript, "utf8");
    expect(content.split("\n")[0]).toBe(PYTHON_SHEBANG);
  });

  it("PASS: does not overwrite an existing valid script", () => {
    const appHome = path.join(tmp, "existing");
    const existingContent = `${UV_SCRIPT_SHEBANG}\n# v2 managed script\nsub.add_parser('hej')\n`;
    writeManagedAppStub(appHome, { runtime: "python", scriptContent: existingContent, marker: "2.7.0" });

    const scriptPath = path.join(appHome, MANAGED_APP_SCRIPT_PATH);
    const before = fs.readFileSync(scriptPath, "utf8");

    writeManagedAppStub(appHome, { runtime: "python", scriptContent: existingContent, marker: "2.7.0" });
    const after = fs.readFileSync(scriptPath, "utf8");

    expect(after).toBe(before);
    expect(after.split("\n")[0]).toBe(UV_SCRIPT_SHEBANG);
  });
});

describe("managed app stub bundle marker and registry", () => {
  it("PASS: writes a valid bundle marker alongside the script", () => {
    const appHome = path.join(tmp, "marker-home");
    writeManagedAppStub(appHome, { runtime: "python", marker: "2.7.0" });

    const markerPath = path.join(appHome, "app", BUNDLE_MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(marker.schemaVersion).toBe("agentera.bundle.v1");
    expect(marker.version).toBe("2.7.0");
  });

  it("PASS: omits the bundle marker when marker is null", () => {
    const appHome = path.join(tmp, "no-marker");
    writeManagedAppStub(appHome, { runtime: "python", marker: null });

    const markerPath = path.join(appHome, "app", BUNDLE_MARKER);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
