import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  STATUS_NO_CHANGES_NEEDED,
  STATUS_READY_TO_APPLY,
  UPGRADE_PREVIEW_SCHEMA,
} from "../../src/upgrade/compatibility.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import {
  buildUpgradePlan,
  validateUpgradeApply,
} from "../../src/upgrade/upgradeOrchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;
let home: string;
let stdout: string;
let stderr: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  stdout = "";
  stderr = "";
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

describe("buildUpgradePlan", () => {
  it("skips v2→v3 migration phases for v3 self-contained npm bundles", () => {
    const bundle = path.join(tmp, "npx-bundle");
    fs.mkdirSync(path.join(bundle, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "skills", "agentera", "SKILL.md"), "x");
    fs.writeFileSync(
      path.join(bundle, "registry.json"),
      JSON.stringify({ skills: [{ name: "agentera", version: "3.0.0-next.1" }] }),
    );
    fs.writeFileSync(
      path.join(bundle, ".agentera-npx-bundle.json"),
      JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0-next.1" }),
    );

    const plan = buildUpgradePlan({
      installRoot: bundle,
      home,
      project: bundle,
      channel: "stable",
      dryRun: true,
    });

    expect(plan.install.kind).toBe("v3_self_contained_npm");
    expect(plan.phases.map((p) => p.name)).toEqual(["detect"]);
    expect(plan.lifecycleStatus).toBe(STATUS_NO_CHANGES_NEEDED);
    expect(plan.summary.pending).toBe(0);
    expect(plan.summary.blocked).toBe(0);
  });

  it("emits agentera.upgrade.v2 with phases, channel metadata, and commands on dry-run", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project"));

    const plan = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      dryRun: true,
    });

    expect(plan.schemaVersion).toBe(UPGRADE_PREVIEW_SCHEMA);
    expect(plan.channel.channel).toBe("development");
    expect(plan.phases.map((p) => p.name)).toEqual(["detect", "artifacts", "runtime", "cleanup"]);
    expect(plan.phases.every((p) => p.summary && Array.isArray(p.items))).toBe(true);
    expect(plan.dryRunCommand).toContain("--dry-run");
    expect(plan.applyCommand).toContain("--yes");
    expect(plan.applyCommand).not.toContain("--target-major");
    expect(plan.upgradeOutcome.kind).toBe("migration_to_latest_on_channel");
  });


  it("runs runtime rewire without crossMajorBoundary when project hooks are pending", () => {
    const bundle = path.join(tmp, "npx-bundle-runtime");
    fs.mkdirSync(path.join(bundle, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "skills", "agentera", "SKILL.md"), "x");
    fs.writeFileSync(
      path.join(bundle, "registry.json"),
      JSON.stringify({ skills: [{ name: "agentera", version: "3.0.0-next.1" }] }),
    );
    fs.writeFileSync(
      path.join(bundle, ".agentera-npx-bundle.json"),
      JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0-next.1" }),
    );
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(bundle, "references"), { recursive: true });

    const project = path.join(tmp, "cursor-project");
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, "v2-runtime-cursor-full/project/.cursor/hooks.json"),
      path.join(project, ".cursor", "hooks.json"),
    );

    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;
    const plan = buildUpgradePlan({
      installRoot: bundle,
      home,
      project,
      channel: "development",
      dryRun: true,
    });

    expect(plan.crossMajorBoundary).toBe(false);
    expect(plan.phases.map((p) => p.name)).toContain("runtime");
    expect(plan.phases.find((p) => p.name === "runtime")?.summary.pending).toBeGreaterThan(0);
    expect(plan.summary.pending).toBeGreaterThan(0);
  });

  it("limits phases with --only artifacts", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project-only"));

    const plan = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      only: ["artifacts"],
    });

    expect(plan.phases.map((p) => p.name)).toEqual(["detect", "artifacts"]);
    expect(plan.phases.some((p) => p.name === "runtime")).toBe(false);
    expect(plan.phases.some((p) => p.name === "cleanup")).toBe(false);
  });
});

describe("validateUpgradeApply", () => {
  it("rejects --yes on stable channel for cross-major v2 home", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project-yes"));

    const preview = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "stable",
      dryRun: true,
    });

    const message = validateUpgradeApply({ yes: true }, preview);
    expect(message).toMatch(/development channel/i);
  });
});

describe("cmdUpgrade integration", () => {
  it("upgrade --dry-run --project emits v2 JSON with channel metadata", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cli-project"));

    const code = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        project,
        dryRun: true,
        format: "json",
        channel: "development",
        },
      {
        out: (t) => { stdout += t; },
        err: (t) => { stderr += t; },
      },
    );

    expect(code).toBe(1);
    const payload = JSON.parse(stdout);
    expect(payload.schemaVersion).toBe(UPGRADE_PREVIEW_SCHEMA);
    expect(payload.channel.distTag).toBe("next");
    expect(payload.dryRunCommand).toContain("--dry-run");
    expect(payload.applyCommand).toContain("--yes");
    expect(payload.summary.pending).toBeGreaterThan(0);
    expect(payload.lifecycleStatus).toBe(STATUS_READY_TO_APPLY);
  });

  it("exits non-zero with plain-language error on --yes for stable cross-major v2 home", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "cli-yes"));

    const code = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        project,
        yes: true,
        channel: "stable",
      },
      {
        out: (t) => { stdout += t; },
        err: (t) => { stderr += t; },
      },
    );

    expect(code).toBe(1);
    expect(stderr).toMatch(/development channel/i);
  });
});
