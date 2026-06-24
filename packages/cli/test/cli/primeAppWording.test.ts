import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let home: string;
let prevCwd: string;

function managedApp(appHome: string, marker: string | null): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env python3\nsub.add_parser('hej')\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  if (marker !== null) {
    fs.writeFileSync(
      path.join(app, BUNDLE_MARKER),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
    );
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-word-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  prevCwd = process.cwd();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
});

afterEach(() => {
  process.chdir(prevCwd);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prime app lifecycle wording", () => {
  it("uses update framing when managed app files are outdated", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    managedApp(appHome, "3.0.0-next.1");
    const project = path.join(tmp, "project");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.app.status).toBe("outdated");

    expect(state.project_integration.recommendation).toBe("upgrade");
    expect(state.project_integration.pending_runtime).toBe(0);
    expect(state.project_integration.message).toContain("out of date");
    expect(state.project_integration.message).toContain("update");
    expect(state.project_integration.update_channel).toBe("development");
    expect(state.project_integration.dry_run_command).toContain("agentera@next");
    expect(state.project_integration.major_boundary_block).toBeNull();
  });

  it("uses repair framing when managed app files need repair", () => {
    const appHome = process.env.AGENTERA_HOME as string;
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, ".agentera", "progress.yaml"), "cycles: []\n");
    const project = path.join(tmp, "project-repair");
    fs.mkdirSync(project, { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    expect(state.app.status).toBe("repair_needed");

    expect(state.project_integration.recommendation).toBe("upgrade");
    expect(state.project_integration.message).toContain("needs repair");
    const attention = (state.attention as string[]).find((line) => line.includes("needs repair"));
    expect(attention).toBeTruthy();
    expect(attention).toContain(state.project_integration.message);
    expect(attention).not.toMatch(/repair or upgrade/i);
    expect(attention).not.toContain("out of date");
    expect(attention).not.toContain("app files outdated");
  });
});
