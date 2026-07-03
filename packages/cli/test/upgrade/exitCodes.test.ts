import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  fs.cpSync(path.join(FIXTURES, "v2-yaml-project"), path.join(sandbox, "project"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "v2-runtime-python"), h, { recursive: true });
  return { appHome, project: path.join(sandbox, "project") };
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
  it("partialFailureApply: upgradeExitCode returns 1 when summary.failed > 0 after a partial-failure apply", () => {
    const { appHome, project } = seedLayout(tmp);

    const realCpSync = fs.cpSync.bind(fs);
    vi.spyOn(fs, "cpSync").mockImplementation((src, dest, opts) => {
      if (typeof dest === "string" && dest.includes("upgrade-snapshot")) {
        throw Object.assign(new Error("write ENOSPC"), { code: "ENOSPC" }) as NodeJS.ErrnoException;
      }
      return realCpSync(src as fs.PathOrFileDescriptor, dest as fs.PathOrFileDescriptor, opts as fs.CopySyncOptions);
    });

    const plan = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      yes: true,
    });

    expect(plan.summary.failed).toBeGreaterThan(0);
    expect(upgradeExitCode(plan)).toBe(1);
  });
});
