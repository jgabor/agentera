import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { APP_OUTDATED, APP_REPAIR_NEEDED } from "../../src/upgrade/doctor.js";
import { summarizeProjectIntegration } from "../../src/upgrade/projectIntegration.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proj-int-word-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("summarizeProjectIntegration wording", () => {
  it("uses update language when only the app bundle is outdated", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(project, { recursive: true });
    const appHome = path.join(tmp, "app-home");
    fs.mkdirSync(appHome, { recursive: true });

    const summary = summarizeProjectIntegration({
      project,
      sourceRoot: REPO_ROOT,
      home: path.join(tmp, "home"),
      env: {},
      installRoot: appHome,
      bundleStatus: APP_OUTDATED,
      crossMajorBoundary: false,
    });

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("out of date");
    expect(summary.message).toContain("update");
    expect(summary.message).not.toMatch(/repair or upgrade/i);
    expect(summary.message).not.toContain("needs repair");
  });

  it("uses repair language when the app bundle needs repair", () => {
    const project = path.join(tmp, "project-repair");
    fs.mkdirSync(project, { recursive: true });
    const appHome = path.join(tmp, "broken-home");
    fs.mkdirSync(appHome, { recursive: true });

    const summary = summarizeProjectIntegration({
      project,
      sourceRoot: REPO_ROOT,
      home: path.join(tmp, "home"),
      env: {},
      installRoot: appHome,
      bundleStatus: APP_REPAIR_NEEDED,
      crossMajorBoundary: false,
    });

    expect(summary.recommendation).toBe("upgrade");
    expect(summary.message).toContain("needs repair");
    expect(summary.message).not.toMatch(/repair or upgrade/i);
    expect(summary.message).not.toContain("out of date");
  });
});
