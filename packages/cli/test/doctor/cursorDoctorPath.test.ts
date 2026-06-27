import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { diagnosticCheckNames } from "../../src/setup/doctor/core.js";
import { diagnoseCursor } from "../../src/setup/doctor/diagnostics.js";
import { CURSOR_MANAGED_AGENT, V3_CURSOR_HOOKS_FIXTURE } from "../../src/setup/cursorSurfaces.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-doctor-path-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedRoot(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "s");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "x" }] }));
}

function fakeBin(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  for (const binary of ["cursor", "cursor-agent"]) {
    const file = path.join(dir, binary);
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function writeCursorHooks(targetRoot: string, content = V3_CURSOR_HOOKS_FIXTURE): void {
  fs.mkdirSync(path.join(targetRoot, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, ".cursor", "hooks.json"), content);
}

function writeManagedAgent(targetRoot: string): void {
  fs.mkdirSync(path.join(targetRoot, ".cursor", "agents"), { recursive: true });
  fs.writeFileSync(path.join(targetRoot, ".cursor", "agents", CURSOR_MANAGED_AGENT), "managed\n");
}

function hookCheck(result: ReturnType<typeof diagnoseCursor>): Record<string, unknown> | undefined {
  const name = diagnosticCheckNames("cursor")[1];
  return (result.checks as Record<string, unknown>[]).find((check) => check.name === name);
}

function agentsCheck(result: ReturnType<typeof diagnoseCursor>): Record<string, unknown> | undefined {
  const name = diagnosticCheckNames("cursor")[2];
  return (result.checks as Record<string, unknown>[]).find((check) => check.name === name);
}

describe("cursor doctor path probing", () => {
  it("passes when project-level hooks and agents are wired", () => {
    const installRoot = path.join(tmp, "install");
    const project = path.join(tmp, "project");
    const home = path.join(tmp, "home");
    managedRoot(installRoot);
    writeCursorHooks(project);
    writeManagedAgent(project);

    const bin = fakeBin(path.join(tmp, "bin"));
    const result = diagnoseCursor(installRoot, home, {
      PATH: bin,
      AGENTERA_HOME: installRoot,
      AGENTERA_PROJECT: project,
    });

    expect(hookCheck(result)?.status).toBe("pass");
    expect(agentsCheck(result)?.status).toBe("pass");
    expect(String(hookCheck(result)?.path)).toContain(path.join(project, ".cursor", "hooks.json"));
  });

  it("passes when user-level hooks and agents are wired", () => {
    const installRoot = path.join(tmp, "install");
    const project = path.join(tmp, "project");
    const home = path.join(tmp, "home");
    managedRoot(installRoot);
    writeCursorHooks(home);
    writeManagedAgent(home);

    const bin = fakeBin(path.join(tmp, "bin"));
    const result = diagnoseCursor(installRoot, home, {
      PATH: bin,
      AGENTERA_HOME: installRoot,
      AGENTERA_PROJECT: project,
    });

    expect(hookCheck(result)?.status).toBe("pass");
    expect(agentsCheck(result)?.status).toBe("pass");
    expect(String(hookCheck(result)?.path)).toContain(path.join(home, ".cursor", "hooks.json"));
  });

  it("fails with project and user probe paths when hooks and agents are missing", () => {
    const installRoot = path.join(tmp, "install");
    const project = path.join(tmp, "project");
    const home = path.join(tmp, "home");
    managedRoot(installRoot);
    fs.mkdirSync(path.join(installRoot, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(installRoot, ".cursor", "hooks.json"), V3_CURSOR_HOOKS_FIXTURE);
    writeManagedAgent(installRoot);

    const bin = fakeBin(path.join(tmp, "bin"));
    const result = diagnoseCursor(installRoot, home, {
      PATH: bin,
      AGENTERA_HOME: installRoot,
      AGENTERA_PROJECT: project,
    });

    expect(hookCheck(result)?.status).toBe("fail");
    expect(agentsCheck(result)?.status).toBe("fail");
    expect(String(hookCheck(result)?.message)).toContain(path.join(project, ".cursor", "hooks.json"));
    expect(String(hookCheck(result)?.message)).toContain(path.join(home, ".cursor", "hooks.json"));
    expect(String(agentsCheck(result)?.message)).toContain(path.join(project, ".cursor", "agents"));
    expect(String(agentsCheck(result)?.message)).toContain(path.join(home, ".cursor", "agents"));
  });

  it("does not treat installRoot bundle paths as wired hooks or agents", () => {
    const installRoot = path.join(tmp, "install");
    const project = path.join(tmp, "project");
    const home = path.join(tmp, "home");
    managedRoot(installRoot);
    writeCursorHooks(installRoot);
    writeManagedAgent(installRoot);

    const bin = fakeBin(path.join(tmp, "bin"));
    const result = diagnoseCursor(installRoot, home, {
      PATH: bin,
      AGENTERA_HOME: installRoot,
      AGENTERA_PROJECT: project,
    });

    expect(hookCheck(result)?.status).toBe("fail");
    expect(agentsCheck(result)?.status).toBe("fail");
  });
});
