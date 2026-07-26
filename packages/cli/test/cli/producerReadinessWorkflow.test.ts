import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  EXPECTED_PRODUCER_READINESS,
  runProducerReadinessWorkflow,
} from "../helpers/producerReadinessWorkflow.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");

it("proves source producer readiness through built module and executable boundaries", { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "producer-readiness-source-"));
  try {
    const output = path.join(root, "build");
    const build = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, "scripts/build-package.mjs"), "--output-root", output], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    expect(build.status, build.stderr || build.stdout).toBe(0);
    fs.symlinkSync(path.join(PACKAGE_ROOT, "node_modules"), path.join(output, "node_modules"), "dir");
    await expect(runProducerReadinessWorkflow(path.join(output, "dist/bin/agentera.js"), path.join(root, "smoke")))
      .resolves.toEqual(EXPECTED_PRODUCER_READINESS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
