import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { main } from "../../src/cli/dispatch.js";
import { renderVerifySummary, type VerifyResult, verifyOneWayUpgrade, verifyUpgrade } from "../../src/cli/commands/upgradeVerify.js";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { gitCommitArgs } from "../helpers/git.js";

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
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version }] }));
  fs.writeFileSync(path.join(app, BUNDLE_MARKER), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version }));
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
    const result: VerifyResult = {
      passed: false,
      checks: [{ name: "doctor", passed: false, detail: "signals=1" }],
    };

    const summary = renderVerifySummary(result, true);
    const parsed = JSON.parse(summary) as {
      command: string;
      status: string;
      checks: Array<{ name: string; passed: boolean; detail: string }>;
    };
    expect(parsed).toEqual({
      command: "upgrade --verify",
      status: "failed",
      checks: result.checks,
    });
  });

  it("emits a text summary with a status line and per-check rows", () => {
    const result: VerifyResult = {
      passed: true,
      checks: [
        { name: "doctor", passed: true, detail: "signals=0" },
        { name: "prime --context status", passed: true, detail: "schema_error: null" },
      ],
    };

    const summary = renderVerifySummary(result, false);
    expect(summary).toContain("Agentera verify");
    expect(summary).toContain("status: passed");
    expect(summary).toContain("doctor: passed");
    expect(summary).toContain("prime --context status: passed");
  });
});

describe("cli dispatch: upgrade --verify", () => {
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

  it("upgrade --verify --install-root <missing> exits non-zero with a failed doctor check", () => {
    const { rc, out } = capture(["node", "agentera", "upgrade", "--verify", "--install-root", path.join(tmp, "no-such-app"), "--home", home, "--expected-version", "3.0.0"]);
    expect(rc).toBe(1);
    expect(JSON.parse(out)).toMatchObject({
      status: "failed",
      checks: expect.arrayContaining([expect.objectContaining({ name: "doctor", passed: false })]),
    });
  });

  it("upgrade --verify emits the envelope on stdout", () => {
    const { rc, out } = capture(["node", "agentera", "upgrade", "--verify", "--format", "json", "--install-root", path.join(tmp, "no-such-app-json"), "--home", home, "--expected-version", "3.0.0"]);
    expect(rc).toBe(1);
    const parsed = JSON.parse(out) as { command: string; status: string };
    expect(parsed.command).toBe("upgrade --verify");
    expect(parsed.status).toBe("failed");
  });
});

describe("verify", () => {
  function capture(argv: string[]): { rc: number; out: string; err: string } {
    let out = "";
    let err = "";
    const rc = main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
    return { rc, out, err };
  }

  it("fullUpgradeThenDoctorAndPrime: upgrade --yes --verify exits 0 after state and startup validation", () => {
    const appHome = path.join(home, ".local", "share", "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, "packages/cli/test/migrate/fixtures/v2-handoff-manifest.json"), path.join(appHome, "v3-handoff.json"));
    const project = path.join(tmp, "v2-project");
    fs.cpSync(path.join(REPO_ROOT, "packages/cli/test/upgrade/fixtures/v2-yaml-project"), project, {
      recursive: true,
    });
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    execFileSync("git", ["add", "."], { cwd: project });
    execFileSync("git", gitCommitArgs("--quiet", "-m", "v2 state"), { cwd: project });

    const { rc, out, err } = capture(["node", "agentera", "upgrade", "--yes", "--verify", "--home", home, "--install-root", appHome, "--project", project, "--channel", "development"]);

    expect(rc, `${out}\n${err}`).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      status: "success",
      state_validation: { status: "passed" },
      startup_validation: { status: "passed" },
    });
    expect(err).toBe("");
  });

  it("fails state validation and public startup when entity authority is absent", () => {
    const project = path.join(tmp, "authority-absent");
    fs.mkdirSync(project);

    const verification = verifyOneWayUpgrade({ home, project });
    const previous = process.cwd();
    process.chdir(project);
    try {
      const startup = capture(["node", "agentera", "prime", "--context", "status", "--format", "json", "--home", home]);
      expect(startup.rc).not.toBe(0);
    } finally {
      process.chdir(previous);
    }

    expect(verification.state_validation.status).toBe("failed");
    expect(verification.startup_validation.status).toBe("failed");
  });
});
