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
  for (const entry of [
    "scripts/validate_capability.py",
    "skills/agentera/SKILL.md",
  ]) {
    fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
    fs.writeFileSync(path.join(root, entry), "x");
  }
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
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
    managedFresh(root);
    fs.mkdirSync(path.join(root, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(root, ".cursor", "hooks.json"), "{}");
    const report = diagnose(root, path.join(tmp, "home"), { AGENTERA_HOME: root });
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
