import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  buildDoctorStatus,
  publicDoctorStatus,
} from "../../src/upgrade/doctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managed(appHome: string, marker: string | null, hej = true): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "scripts", "agentera"),
    "#!/usr/bin/env node\n" + (hej ? "sub.add_parser('hej')\n" : "pass\n"),
  );
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "current" }] }),
  );
  if (marker !== null) {
    fs.writeFileSync(
      path.join(app, ".agentera-bundle.json"),
      JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
    );
  }
}

const common = {
  sourceRoot: REPO_ROOT,
  home: "/tmp/doctor-home",
  project: "/tmp/doctor-proj",
  expectedVersion: "v9",
  probeCli: false,
};

describe("buildDoctorStatus", () => {
  it("reports up_to_date for a fresh managed bundle", () => {
    const appHome = path.join(tmp, "fresh");
    managed(appHome, "v9");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_UP_TO_DATE);
    expect(status.rootStatus).toBe("managed");
    expect(status.signals).toEqual([]);
    expect(status.dryRunCommand).toBeNull();
    expect(status.applyCommand).toBeNull();
    expect(status.schemaVersion).toBe("agentera.bundleStatus.v1");
  });

  it("reports outdated with a version_mismatch signal for a stale marker", () => {
    const appHome = path.join(tmp, "stale");
    managed(appHome, "old");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_OUTDATED);
    expect(status.signals.some((s: any) => s.kind === "version_mismatch")).toBe(true);
    expect(status.markerVersion).toBe("old");
    expect(status.dryRunCommand).toContain("npx -y agentera@latest");
    expect(status.dryRunCommand).toContain("upgrade");
    expect(status.applyCommand).toContain("--yes");
  });

  it("reports user_data_only repair for an app home with only Agentera data", () => {
    const appHome = path.join(tmp, "userdata");
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(appHome, ".agentera", "progress.yaml"), "cycles: []\n");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_REPAIR_NEEDED);
    expect(status.rootStatus).toBe("user_data_only");
    expect(status.signals.some((s: any) => s.kind === "user_data_only_app_home")).toBe(true);
  });

  it("reports missing_bundle for a missing default app home", () => {
    const appHome = path.join(tmp, "nope");
    const status = buildDoctorStatus(appHome, { rootSource: "default app home", ...common });
    expect(status.rootStatus).toBe("missing");
    expect(status.status).toBe(APP_REPAIR_NEEDED);
    expect(status.signals.some((s: any) => s.kind === "missing_bundle")).toBe(true);
  });

  it("blocks on a missing explicit app home", () => {
    const appHome = path.join(tmp, "nope2");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    expect(status.status).toBe(APP_MANUAL_REVIEW_NEEDED);
    expect(status.rootStatus).toBe("missing");
    expect(status.dryRunCommand).toBeNull();
    expect(status.signals.some((s: any) => s.kind === "invalid_install_root")).toBe(true);
  });
});

describe("publicDoctorStatus", () => {
  it("strips installRoot and installRootSource", () => {
    const appHome = path.join(tmp, "fresh");
    managed(appHome, "v9");
    const status = buildDoctorStatus(appHome, { rootSource: "explicit --install-root", ...common });
    const pub = publicDoctorStatus(status);
    expect("installRoot" in pub).toBe(false);
    expect("installRootSource" in pub).toBe(false);
    expect(pub.appHome).toBe(status.appHome);
  });
});
