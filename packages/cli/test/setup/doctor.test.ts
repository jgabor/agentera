import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AVAILABILITY_CHECKS,
  CANONICAL_ENTRIES,
  HELPER_ENTRIES,
  INSTALLER_FIXABLE_GAPS,
  RUNTIMES,
  SCHEMA_VERSION,
  aggregateStatus,
  autoDetectInstallRoot,
  classifyInstallRoot,
  mkCheck,
  summarizeStatuses,
  tail,
  verifyHelperAccess,
  verifyInstallRoot,
} from "../../src/setup/doctor.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-doctor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedRoot(root: string, withHelper = true): void {
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "validate_capability.py"), "x");
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "s");
  if (withHelper) fs.writeFileSync(path.join(root, "hooks", "validate_artifact.py"), "x");
}

describe("setup doctor: registry-derived constants", () => {
  it("exposes the doctor schema + runtime roster", () => {
    expect(SCHEMA_VERSION).toBe("agentera.setupDoctor.v1");
    expect(RUNTIMES).toContain("claude");
    expect(RUNTIMES).toContain("codex");
    expect(Object.keys(AVAILABILITY_CHECKS).sort()).toEqual([...RUNTIMES].sort());
    expect(INSTALLER_FIXABLE_GAPS.copilot).toHaveLength(2);
    expect(HELPER_ENTRIES).toContain("hooks/validate_artifact.py");
    expect(CANONICAL_ENTRIES.length).toBeGreaterThan(0);
  });
});

describe("setup doctor: install-root classification", () => {
  it("passes a valid managed root with helper scripts", () => {
    const root = path.join(tmp, "ok");
    managedRoot(root);
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("pass");
    expect(c.kind).toBe("installed-bundle");
    expect(verifyInstallRoot(root)).toEqual([]);
    expect(verifyHelperAccess(root)).toEqual([]);
  });

  it("fails a managed root that is missing helper scripts", () => {
    const root = path.join(tmp, "nohelper");
    managedRoot(root, false);
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("fail");
    expect(c.gap).toBe("bundle_packaging");
    expect(c.missing).toEqual(["hooks/validate_artifact.py"]);
  });

  it("fails an invalid root", () => {
    const root = path.join(tmp, "invalid");
    fs.mkdirSync(root);
    const c = classifyInstallRoot(root, {});
    expect(c.status).toBe("fail");
    expect(c.kind).toBeNull();
  });

  it("resolves via AGENTERA_HOME env fallback", () => {
    const root = path.join(tmp, "envroot");
    managedRoot(root);
    expect(autoDetectInstallRoot({ AGENTERA_HOME: root })).toBe(fs.realpathSync.native(root));
    const c = classifyInstallRoot(null, { AGENTERA_HOME: root });
    expect(c.status).toBe("pass");
    expect(c.source).toBe("auto");
  });
});

describe("setup doctor: aggregation helpers", () => {
  it("aggregates statuses with fail>warn>pass>skip precedence", () => {
    expect(aggregateStatus([])).toBe("skip");
    expect(aggregateStatus([{ status: "skip" }])).toBe("skip");
    expect(aggregateStatus([{ status: "pass" }, { status: "fail" }])).toBe("fail");
    expect(aggregateStatus([{ status: "pass" }, { status: "warn" }])).toBe("warn");
  });

  it("summarizes status counts across all buckets", () => {
    expect(summarizeStatuses([{ status: "pass" }, { status: "pass" }, { status: "fail" }])).toEqual({
      pass: 2,
      warn: 0,
      fail: 1,
      skip: 0,
    });
  });

  it("tails non-empty lines", () => {
    expect(tail("a\n\n b \nc\n\nd\n", 2)).toEqual(["c", "d"]);
  });

  it("builds a check record with defaults", () => {
    expect(mkCheck("n", "pass", "ok")).toEqual({
      name: "n",
      status: "pass",
      message: "ok",
      source: null,
      path: null,
      gap: null,
      details: [],
    });
  });
});
