import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  buildUpgradePlan,
  upgradeExitCode,
} from "../../src/upgrade/upgradeOrchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;
let home: string;

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }),
  );
}

function seedLayout(sandbox: string): { appHome: string; project: string } {
  const h = path.join(sandbox, "home");
  fs.mkdirSync(h, { recursive: true });
  const appHome = path.join(h, "agentera");
  managedV2(appHome);
  const project = path.join(sandbox, "project");
  fs.cpSync(path.join(FIXTURES, "v2-yaml-project"), project, { recursive: true });
  fs.cpSync(path.join(FIXTURES, "v2-runtime-python"), h, { recursive: true });
  const git = (...args: string[]): void => {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr));
  };
  git("init", "--quiet");
  git("config", "user.name", "Upgrade Test");
  git("config", "user.email", "upgrade@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "--quiet", "-m", "v2 state");
  return { appHome, project };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exit-codes-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSuccessorAnnouncedOverrideForTests(null);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("exitCodes", () => {
  it("partialFailureApply: upgradeExitCode returns 1 when safe cleanup blocks after an I/O failure", () => {
    const { appHome, project } = seedLayout(tmp);

    process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE = "1";

    const plan = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      yes: true,
    });
    delete process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE;

    expect(plan.summary.blocked).toBeGreaterThan(0);
    expect(upgradeExitCode(plan)).toBe(1);
  });
});
