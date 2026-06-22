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

function v3SourceRoot(announced: boolean): string {
  const root = path.join(tmp, `v3-src-${announced}`);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "x");
  fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(root, "registry.json"));
  fs.mkdirSync(path.join(root, "references", "cli"), { recursive: true });
  let channels = fs.readFileSync(path.join(REPO_ROOT, "references/cli/update-channels.yaml"), "utf8");
  if (announced) {
    channels = channels.replace("announced: false", "announced: true");
  }
  fs.writeFileSync(path.join(root, "references/cli/update-channels.yaml"), channels);
  return root;
}

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

  it("emits cross_major_pending advisory instead of up_to_date while successor is unannounced", () => {
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
    expect(status.crossMajorBoundary).toBe(false);
    expect(status.status).toBe("manual_review_needed");
    expect(status.dryRunCommand).toBeNull();
    expect(status.applyCommand).toBeNull();
    const pending = status.signals.find((s: { kind?: string }) => s.kind === "cross_major_pending");
    expect(pending).toBeTruthy();
    expect(pending?.status).toBe("manual_review_needed");
    expect(status.signals.some((s: { kind?: string }) => s.kind === "version_mismatch")).toBe(true);
  });

  it("flags crossMajorBoundary for v2 managed app-home when successor is announced", () => {
    const sourceRoot = v3SourceRoot(true);
    const appHome = path.join(tmp, "v2home-announced");
    managed(appHome, "2.7.0");
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot,
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
