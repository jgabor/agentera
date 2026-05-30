import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_OUTDATED, buildDoctorStatus } from "../../src/upgrade/doctor.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-ch-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managed(appHome: string, marker: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

describe("buildDoctorStatus channel-aware commands", () => {
  it("uses stable @latest for outdated managed bundles", () => {
    const appHome = path.join(tmp, "stale");
    managed(appHome, "old");
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot: REPO_ROOT,
      home: path.join(tmp, "home"),
      project: path.join(tmp, "proj"),
      expectedVersion: "v9",
      probeCli: false,
      channel: "stable",
    });
    expect(status.status).toBe(APP_OUTDATED);
    expect(status.updateChannel).toBe("stable");
    expect(status.dryRunCommand).toContain("npx -y agentera@latest");
    expect(status.dryRunCommand).not.toContain("uvx");
    expect(status.dryRunCommand).not.toContain("@next");
  });

  it("flags crossMajorBoundary for v2 managed app-home on 3.x source root", () => {
    const appHome = path.join(tmp, "v2home");
    managed(appHome, "2.7.0");
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot: REPO_ROOT,
      home: path.join(tmp, "home"),
      project: path.join(tmp, "proj"),
      expectedVersion: "3.0.0",
      probeCli: false,
    });
    expect(status.crossMajorBoundary).toBe(true);
    expect(status.dryRunCommand).toContain("agentera@latest");
    expect(status.dryRunCommand).not.toContain("--target-major");
  });
});
