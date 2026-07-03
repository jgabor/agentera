import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { main } from "../../src/cli/dispatch.js";
import {
  renderRestoreSummary,
  renderVerifySummary,
  verifyUpgrade,
} from "../../src/cli/commands/upgradeVerify.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let home: string;

function managedV3(appHome: string, version: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-verify-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  setSuccessorAnnouncedOverrideForTests(null);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("verifyUpgrade", () => {
  it("passes when doctor reports up_to_date with no signals and all capabilities resolve", () => {
    const appHome = path.join(tmp, "fresh");
    managedV3(appHome, "3.0.0");

    const result = verifyUpgrade({
      installRoot: appHome,
      home,
      expectedVersion: "3.0.0",
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(1 + Object.keys(CAPABILITY_INSTRUCTIONS).length);

    const doctor = result.checks[0]!;
    expect(doctor.name).toBe("doctor");
    expect(doctor.passed).toBe(true);
    expect(doctor.detail).toContain("status=up_to_date");
    expect(doctor.detail).toContain("signals=0");

    for (const check of result.checks.slice(1)) {
      expect(check.name).toMatch(/^prime --context /);
      expect(check.passed).toBe(true);
      expect(check.detail).toBe("schema_error: null");
    }
  });

  it("fails when doctor reports signals (expected-version mismatch)", () => {
    const appHome = path.join(tmp, "drift");
    managedV3(appHome, "3.0.0");

    const result = verifyUpgrade({
      installRoot: appHome,
      home,
      expectedVersion: "3.1.0",
    });

    expect(result.passed).toBe(false);
    const doctor = result.checks.find((c) => c.name === "doctor");
    expect(doctor).toBeDefined();
    expect(doctor!.passed).toBe(false);
    expect(doctor!.detail).not.toContain("signals=0");
  });

  it("fails when the install root has no managed app (missing bundle marker)", () => {
    const result = verifyUpgrade({
      installRoot: path.join(tmp, "missing"),
      home,
      expectedVersion: "3.0.0",
    });

    expect(result.passed).toBe(false);
    const doctor = result.checks.find((c) => c.name === "doctor");
    expect(doctor!.passed).toBe(false);
    expect(doctor!.detail).not.toContain("signals=0");
  });
});

describe("renderVerifySummary", () => {
  it("emits a JSON envelope when json=true", () => {
    const result = verifyUpgrade({
      installRoot: path.join(tmp, "missing-json"),
      home,
      expectedVersion: "3.0.0",
    });

    const summary = renderVerifySummary(result, true);
    const parsed = JSON.parse(summary) as {
      command: string;
      status: string;
      checks: Array<{ name: string; passed: boolean; detail: string }>;
    };
    expect(parsed.command).toBe("upgrade --verify");
    expect(parsed.status).toBe("failed");
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBeGreaterThan(0);
  });

  it("emits a text summary with a status line and per-check rows", () => {
    const appHome = path.join(tmp, "ok-text");
    managedV3(appHome, "3.0.0");
    const result = verifyUpgrade({
      installRoot: appHome,
      home,
      expectedVersion: "3.0.0",
    });

    const summary = renderVerifySummary(result, false);
    expect(summary).toContain("Agentera verify");
    expect(summary).toContain("status: passed");
    expect(summary).toContain("doctor: passed");
    expect(summary).toContain("prime --context status: passed");
  });
});

describe("renderRestoreSummary", () => {
  it("reports the file count and source when restore succeeds", () => {
    const summary = renderRestoreSummary("/tmp/agentera", {
      restored: true,
      source: "/tmp/agentera/app",
      snapshotDir: "/tmp/agentera/.agentera/upgrade-snapshot-1",
      created: "2026-07-03T00:00:00.000Z",
      fileCount: 12,
    });
    expect(summary).toContain("restored 12 files to /tmp/agentera/app");
    expect(summary).toContain("from snapshot created 2026-07-03T00:00:00.000Z");
  });

  it("reports 'no upgrade snapshot' when nothing was found", () => {
    const summary = renderRestoreSummary("/tmp/agentera", {
      restored: false,
      source: null,
      snapshotDir: null,
      created: null,
      fileCount: 0,
    });
    expect(summary).toContain("no upgrade snapshot found at /tmp/agentera");
  });
});

describe("cli dispatch: upgrade --verify / --restore", () => {
  function capture(argv: string[]): { rc: number; out: string; err: string } {
    let out = "";
    let err = "";
    const rc = main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
    return { rc, out, err };
  }

  it("upgrade --verify --dry-run is rejected as mutually exclusive (rc 2)", () => {
    const { rc, err } = capture(["node", "agentera", "upgrade", "--verify", "--dry-run"]);
    expect(rc).toBe(2);
    expect(err).toContain("--verify cannot be combined with --dry-run");
  });

  it("upgrade --restore --yes is rejected as mutually exclusive (rc 2)", () => {
    const { rc, err } = capture(["node", "agentera", "upgrade", "--restore", "--yes"]);
    expect(rc).toBe(2);
    expect(err).toContain("--restore is mutually exclusive");
  });

  it("upgrade --restore reports 'no upgrade snapshot' and exits 0 when no manifest exists", () => {
    const appHome = path.join(tmp, "restore-empty");
    fs.mkdirSync(path.join(appHome, ".agentera"), { recursive: true });
    const { rc, out } = capture([
      "node",
      "agentera",
      "upgrade",
      "--restore",
      "--install-root",
      appHome,
      "--home",
      home,
    ]);
    expect(rc).toBe(0);
    expect(out).toContain("no upgrade snapshot found");
  });

  it("upgrade --verify --install-root <missing> exits non-zero with a failed doctor check", () => {
    const { rc, out } = capture([
      "node",
      "agentera",
      "upgrade",
      "--verify",
      "--install-root",
      path.join(tmp, "no-such-app"),
      "--home",
      home,
      "--expected-version",
      "3.0.0",
    ]);
    expect(rc).toBe(1);
    expect(out).toContain("status: failed");
    expect(out).toContain("doctor: failed");
  });

  it("upgrade --verify --format json emits the envelope on stdout", () => {
    const { rc, out } = capture([
      "node",
      "agentera",
      "upgrade",
      "--verify",
      "--format",
      "json",
      "--install-root",
      path.join(tmp, "no-such-app-json"),
      "--home",
      home,
      "--expected-version",
      "3.0.0",
    ]);
    expect(rc).toBe(1);
    const parsed = JSON.parse(out) as { command: string; status: string };
    expect(parsed.command).toBe("upgrade --verify");
    expect(parsed.status).toBe("failed");
  });
});
