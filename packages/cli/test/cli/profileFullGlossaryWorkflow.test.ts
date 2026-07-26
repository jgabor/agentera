import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { runServedProfileFullWorkflow } from "../helpers/profileFullGlossaryWorkflow.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

it("drives Profile Full behavior from a transient local executable's served instruction order", { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-full-source-workflow-"));
  try {
    const buildRoot = path.join(root, "local-build");
    const build = spawnSync(
      process.execPath,
      [path.join(PACKAGE_ROOT, "scripts/build-package.mjs"), "--output-root", buildRoot],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    expect(build.status, build.stderr || build.stdout).toBe(0);
    fs.symlinkSync(path.join(PACKAGE_ROOT, "node_modules"), path.join(buildRoot, "node_modules"), "dir");
    const executable = path.join(buildRoot, "dist/bin/agentera.js");
    expect(fs.statSync(executable).isFile()).toBe(true);

    const observation = runServedProfileFullWorkflow(executable, path.join(root, "workflow"));
    expect(observation).toMatchObject({
      firstStatus: "changed",
      replayStatus: "unchanged_replay",
      laterStatus: "changed",
      laterConfidence: 49,
      malformedCasesRejected: 4,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
