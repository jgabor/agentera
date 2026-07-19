import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { applyPreparedEntityCutover, prepareEntityCutoverForUpgrade } from "../../src/state/entityCutover.js";
import {
  STATUS_MANUAL_REVIEW_NEEDED,
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

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr));
}

function initializeGit(root: string): void {
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Upgrade Test");
  git(root, "config", "user.email", "upgrade@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "v2 state");
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) visit(absolute);
      else snapshot[relative] = fs.readFileSync(absolute).toString("base64");
    }
  };
  visit(root);
  return snapshot;
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
  it("includes blocker-free entity readiness in full and artifacts-only v2 plans without writes", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    for (const only of [null, ["artifacts"] as const]) {
      const project = copyFixture("v2-yaml-project", path.join(tmp, only ? "artifacts-entities" : "full-entities"));
      const before = fs.readdirSync(path.join(project, ".agentera")).sort();

      const plan = buildUpgradePlan({ installRoot: appHome, home, project, channel: "development", dryRun: true, only });
      const entities = plan.phases.find((phase) => phase.name === "entities");

      expect(entities).toMatchObject({ status: "pending", items: [expect.objectContaining({ action: "entity-cutover", status: "pending" })] });
      expect(fs.readdirSync(path.join(project, ".agentera")).sort()).toEqual(before);
      expect(fs.existsSync(path.join(project, ".agentera/state-mode.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(project, ".agentera/entities"))).toBe(false);
    }
  });

  it("blocks all apply effects when entity readiness is blocked", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "blocked-entities"));
    fs.writeFileSync(path.join(project, ".agentera/progress.yaml"), "cycles: not-a-list\n");
    const projectBefore = JSON.stringify(snapshotTree(project));
    const appBefore = JSON.stringify(snapshotTree(appHome));

    const plan = buildUpgradePlan({ installRoot: appHome, home, project, channel: "development", yes: true });

    expect(plan.status).toBe("blocked");
    expect(plan.phases.find((phase) => phase.name === "entities")?.status).toBe("blocked");
    expect(JSON.stringify(snapshotTree(project))).toBe(projectBefore);
    expect(JSON.stringify(snapshotTree(appHome))).toBe(appBefore);
  });

  it("rejects unknown marker-absent state with a manual handoff and treats completed entity state as a no-op", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const empty = path.join(tmp, "empty-state");
    fs.mkdirSync(empty);
    const emptyPlan = buildUpgradePlan({ installRoot: appHome, home, project: empty, channel: "development", dryRun: true, only: ["artifacts"] });
    expect(emptyPlan.phases.find((phase) => phase.name === "entities")?.items[0]).toMatchObject({
      status: "blocked",
      action: "unsupported-state-source",
      message: expect.stringMatching(/manual/i),
    });

    const orphaned = path.join(tmp, "orphaned-marker");
    fs.mkdirSync(path.join(orphaned, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(orphaned, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    const orphanedPlan = buildUpgradePlan({ installRoot: appHome, home, project: orphaned, channel: "development", dryRun: true, only: ["artifacts"] });
    expect(orphanedPlan.phases.find((phase) => phase.name === "entities")?.status).toBe("blocked");

    const existing = copyFixture("v2-yaml-project", path.join(tmp, "existing-entities"));
    initializeGit(existing);
    applyPreparedEntityCutover(prepareEntityCutoverForUpgrade(existing, REPO_ROOT));
    const existingPlan = buildUpgradePlan({ installRoot: appHome, home, project: existing, channel: "development", dryRun: true, only: ["artifacts"] });
    expect(existingPlan.phases.find((phase) => phase.name === "entities")?.items[0]).toMatchObject({ status: "noop", action: "entity-state-active" });
  });

  it.each([["runtime"], ["cleanup"]] as const)("refuses marker-absent %s-only apply before effects", (only) => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, `${only}-only`));
    const before = JSON.stringify(snapshotTree(tmp));

    const plan = buildUpgradePlan({ installRoot: appHome, home, project, channel: "development", yes: true, only: [only] });

    expect(plan.status).toBe("blocked");
    expect(plan.phases.find((phase) => phase.name === "entities")?.items[0]).toMatchObject({ status: "blocked", action: "entity-cutover-required" });
    expect(JSON.stringify(snapshotTree(tmp))).toBe(before);
  });

  it("rejects unresolved v1 Markdown with a manual handoff", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = copyFixture("v2-v1-md-project", path.join(tmp, "v1-readiness"));
    const unresolved = buildUpgradePlan({ installRoot: appHome, home, project, channel: "development", dryRun: true, only: ["artifacts"] });
    expect(unresolved.phases.find((phase) => phase.name === "entities")?.items[0]).toMatchObject({
      status: "blocked",
      action: "resolve-v1-state",
      message: expect.stringMatching(/manual/i),
    });

  });

  it.each(["npm", "source"] as const)("selects marker-absent v2 project state under %s v3 execution without preview writes", (execution) => {
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

    const project = copyFixture("v2-yaml-project", path.join(tmp, `v2-${execution}`));
    const before = snapshotTree(project);
    const plan = buildUpgradePlan({
      installRoot: execution === "npm" ? bundle : REPO_ROOT,
      home,
      project,
      channel: "development",
      dryRun: true,
    });

    expect(plan.install.kind).toBe(execution === "npm" ? "v3_self_contained_npm" : "source_checkout");
    expect(plan.crossMajorBoundary).toBe(false);
    expect(plan.phases.find((phase) => phase.name === "entities")?.items).toEqual([
      expect.objectContaining({ status: "pending", action: "entity-cutover" }),
    ]);
    expect(plan.summary.pending).toBeGreaterThan(0);
    expect(snapshotTree(project)).toEqual(before);
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
    expect(plan.phases.map((p) => p.name)).toEqual(["detect", "artifacts", "entities", "runtime", "cleanup"]);
    expect(plan.phases.every((p) => p.summary && Array.isArray(p.items))).toBe(true);
    expect(plan.dryRunCommand).toContain("--dry-run");
    expect(plan.applyCommand).toContain("--yes");
    expect(plan.applyCommand).not.toContain("--runtime");
    expect(plan.applyCommand).not.toContain("--target-major");
    expect(plan.upgradeOutcome.kind).toBe("migration_to_latest_on_channel");
    expect(plan.lifecycle).toBeNull();
  });

  it("keeps lifecycle findings visible when a development-channel app phase is blocked", () => {
    const appHome = path.join(home, "agentera-blocked");
    managedV2(appHome);
    fs.writeFileSync(path.join(appHome, "unrecognized-entry"), "user-owned\n");
    const project = copyFixture("v2-yaml-project", path.join(tmp, "blocked-project"));

    const plan = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      runtime: "all",
      dryRun: true,
    });

    expect(plan.summary.blocked).toBeGreaterThan(0);
    expect(plan.lifecycle?.selection.runtimeIds).toEqual(["opencode", "codex", "cursor", "copilot"]);
    expect(new Set(plan.lifecycle?.operations.map((operation) => operation.runtime))).toEqual(
      new Set(["shared", "opencode", "codex", "cursor"]),
    );
  });

  it("keeps stable previews and applies without a selector app-only", () => {
    const appHome = path.join(home, "agentera-stable");
    managedV2(appHome);
    const project = copyFixture("v2-yaml-project", path.join(tmp, "stable-project"));

    const stablePreview = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "stable",
      dryRun: true,
    });
    const developmentApply = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      yes: true,
    });

    expect(stablePreview.lifecycle).toBeNull();
    expect(developmentApply.lifecycle).toBeNull();
  });


  it("keeps runtime rewire eligible for an active entity project with pending hooks", () => {
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
    fs.cpSync(
      path.join(REPO_ROOT, "skills", "agentera", "schemas"),
      path.join(bundle, "skills", "agentera", "schemas"),
      { recursive: true },
    );
    fs.cpSync(path.join(REPO_ROOT, "references"), path.join(bundle, "references"), { recursive: true });

    const project = copyFixture("v2-yaml-project", path.join(tmp, "cursor-project"));
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, "v2-runtime-cursor-full/project/.cursor/hooks.json"),
      path.join(project, ".cursor", "hooks.json"),
    );
    initializeGit(project);
    applyPreparedEntityCutover(prepareEntityCutoverForUpgrade(project, bundle));

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

    expect(plan.phases.map((p) => p.name)).toEqual(["detect", "artifacts", "entities"]);
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
    expect(payload.applyCommand).not.toContain("--runtime");
    expect(payload.lifecycle).toBeNull();
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
