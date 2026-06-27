import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InstallRootError, diagnose, resolveInstallRoot } from "../../src/setup/cursor.js";
import { resolvePath } from "../../src/core/paths.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-cursor-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function managedFresh(root: string): void {
  // Node-era managed app evidence: app data surfaces (no Python scripts/hooks).
  for (const entry of ["skills/agentera/SKILL.md", "registry.json"]) {
    fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
    fs.writeFileSync(path.join(root, entry), "x");
  }
}

describe("setup cursor", () => {
  it("resolves an explicit managed root", () => {
    const root = path.join(tmp, "managed");
    managedFresh(root);
    expect(resolveInstallRoot(root, {})).toBe(resolvePath(root));
  });

  it("rejects an invalid explicit root with missing entries", () => {
    const root = path.join(tmp, "bad");
    fs.mkdirSync(root);
    expect(() => resolveInstallRoot(root, {})).toThrow(InstallRootError);
    try {
      resolveInstallRoot(root, {});
    } catch (err) {
      expect((err as Error).message).toContain("is not a valid Agentera directory");
      expect((err as Error).message).toContain("missing canonical entries");
    }
  });

  it("diagnoses a managed root with cursor hooks present", () => {
    const root = path.join(tmp, "managed");
    const project = path.join(tmp, "project");
    managedFresh(root);
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(project, ".cursor", "hooks.json"), "{}");
    const report = diagnose(root, path.join(tmp, "home"), { AGENTERA_HOME: root, AGENTERA_PROJECT: project });
    expect(report.runtime).toBe("cursor");
    expect(report.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "cursor.hooks")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "AGENTERA_HOME")?.status).toBe("pass");
  });

  it("fails diagnosis when cursor hooks are missing", () => {
    const root = path.join(tmp, "managed");
    managedFresh(root);
    const report = diagnose(root, path.join(tmp, "home"), {});
    expect(report.status).toBe("fail");
    expect(report.checks.find((c) => c.name === "cursor.hooks")?.status).toBe("fail");
    expect(report.checks.find((c) => c.name === "AGENTERA_HOME")?.status).toBe("warn");
  });
});
