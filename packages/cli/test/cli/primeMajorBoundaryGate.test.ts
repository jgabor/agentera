import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let home: string;
let prevCwd: string;

function managedApp(appHome: string, marker: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env python3\nsub.add_parser('hej')\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: marker }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

function npxBundle(root: string, version: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(root, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version }] }),
  );
  fs.writeFileSync(
    path.join(root, NPX_BUNDLE_SENTINEL),
    JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: version }),
  );
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(root, "references"), { recursive: true });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-boundary-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  prevCwd = process.cwd();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  process.chdir(prevCwd);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prime major-boundary gate", () => {
  describe("unannounced v3 successor with v2 managed app", () => {
    beforeEach(() => {
      setSuccessorAnnouncedOverrideForTests(false);
    });

    it("surfaces block reason and stays (pass)", () => {
      const appHome = process.env.AGENTERA_HOME as string;
      managedApp(appHome, "2.7.0");
      const project = path.join(tmp, "project");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      expect(state.project_integration.recommendation).toBe("stay");
      expect(state.project_integration.pending_runtime).toBe(0);
      expect(state.project_integration.major_boundary_block).toBeTruthy();
      expect(state.project_integration.major_boundary_block).toContain("v3 successor line is not announced yet");
    });

    it("does not recommend upgrade (fail)", () => {
      const appHome = process.env.AGENTERA_HOME as string;
      managedApp(appHome, "2.7.0");
      const project = path.join(tmp, "project-fail");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      expect(state.project_integration.recommendation).not.toBe("upgrade");
    });

    it("next_action surfaces block reason, not Upgrade (pass)", () => {
      const appHome = process.env.AGENTERA_HOME as string;
      managedApp(appHome, "2.7.0");
      const project = path.join(tmp, "project-na");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      const nextAction = state.next_action as { object: string; capability: string; reason: string };
      expect(nextAction.object).toBe("Await v3 successor announcement");
      expect(nextAction.capability).toBe("status");
      expect(nextAction.reason).toContain("v3 successor line is not announced yet");
      expect(nextAction.object).not.toBe("Upgrade Agentera");
    });
  });

  describe("announced v3 successor with v2 managed app", () => {
    beforeEach(() => {
      setSuccessorAnnouncedOverrideForTests(true);
    });

    it("recommends upgrade as before (pass)", () => {
      const appHome = process.env.AGENTERA_HOME as string;
      managedApp(appHome, "2.7.0");
      const project = path.join(tmp, "project-announced");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      expect(state.project_integration.recommendation).toBe("upgrade");
      expect(state.project_integration.major_boundary_block).toBeFalsy();
    });

    it("next_action recommends upgrade (pass)", () => {
      const appHome = process.env.AGENTERA_HOME as string;
      managedApp(appHome, "2.7.0");
      const project = path.join(tmp, "project-na-announced");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      const nextAction = state.next_action as { object: string; capability: string; reason: string };
      expect(nextAction.object).toContain("Upgrade");
      expect(nextAction.capability).toBe("status");
    });
  });

  describe("v3 self-contained npm bundle", () => {
    it("does not surface a block reason (pass)", () => {
      const bundle = path.join(tmp, "npx-bundle");
      npxBundle(bundle, "3.0.0-next.1");
      process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;
      const appHome = process.env.AGENTERA_HOME as string;
      const project = path.join(tmp, "project-npx");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      expect(state.project_integration.major_boundary_block).toBeFalsy();
    });

    it("next_action does not surface a block reason (pass)", () => {
      const bundle = path.join(tmp, "npx-bundle-na");
      npxBundle(bundle, "3.0.0-next.1");
      process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;
      const appHome = process.env.AGENTERA_HOME as string;
      const project = path.join(tmp, "project-npx-na");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      const nextAction = state.next_action as { object: string; reason: string };
      expect(nextAction.object).not.toBe("Await v3 successor announcement");
    });
  });

  describe("source checkout", () => {
    it("does not surface a block reason (pass)", () => {
      const appHome = process.env.AGENTERA_HOME as string;
      const project = path.join(tmp, "project-source");
      fs.mkdirSync(project, { recursive: true });
      process.chdir(project);

      const state = collectOrientationState({ home, installRoot: appHome, env: process.env });

      expect(state.project_integration.major_boundary_block).toBeFalsy();
    });
  });
});
