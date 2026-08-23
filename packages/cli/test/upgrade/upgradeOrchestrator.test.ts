import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath } from "../../src/runtime/lifecycleOwnershipJournal.js";
import { observeLifecyclePath } from "../../src/runtime/lifecyclePublication.js";
import { LIFECYCLE_LEDGER_SCHEMA } from "../../src/runtime/lifecycleOperations.js";
import { runLifecycleUpgrade } from "../../src/upgrade/lifecycleUpgrade.js";
import { applyPreparedEntityCutover, prepareEntityCutoverForUpgrade } from "../../src/state/entityCutover.js";
import { getDecisionEntity } from "../../src/state/decisionEntities.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import {
  STATUS_READY_TO_APPLY,
  STATUS_NO_CHANGES_NEEDED,
  UPGRADE_PREVIEW_SCHEMA,
} from "../../src/upgrade/compatibility.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import {
  buildUpgradePlan,
  renderUpgradePlan,
  validateUpgradeApply,
} from "../../src/upgrade/upgradeOrchestrator.js";
import { gitCommitArgs } from "../helpers/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");
const ORIGINAL_OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR;

const MANAGED_OPENCODE_COMMAND = [
  "---",
  "agentera_managed: true",
  "---",
  "uv run ${AGENTERA_HOME}/hooks/validate_artifact.py",
  "",
].join("\n");

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
  git(root, "add", ".");
  git(root, ...gitCommitArgs("--quiet", "--allow-empty", "-m", "v2 state"));
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

function v3Bundle(): string {
  const bundle = path.join(tmp, "v3-bundle");
  fs.mkdirSync(path.join(bundle, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(path.join(bundle, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "3.0.0" }] }));
  fs.writeFileSync(path.join(bundle, BUNDLE_MARKER), JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0" }));
  fs.cpSync(path.join(REPO_ROOT, "skills", "agentera", "schemas"), path.join(bundle, "skills", "agentera", "schemas"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(bundle, "references"), { recursive: true });
  return bundle;
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
  if (ORIGINAL_OPENCODE_CONFIG_DIR === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = ORIGINAL_OPENCODE_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("buildUpgradePlan", () => {
  it("ignores an inherited OpenCode config override outside an explicitly selected home", () => {
    const project = copyFixture("v2-yaml-project", path.join(tmp, "selected-project"));
    initializeGit(project);
    applyPreparedEntityCutover(prepareEntityCutoverForUpgrade(project, REPO_ROOT));
    const externalConfig = path.join(tmp, "outside-opencode");
    const externalCommand = path.join(externalConfig, "commands", "agentera.md");
    fs.mkdirSync(path.dirname(externalCommand), { recursive: true });
    fs.writeFileSync(externalCommand, MANAGED_OPENCODE_COMMAND);
    const externalBefore = snapshotTree(externalConfig);
    process.env.OPENCODE_CONFIG_DIR = externalConfig;

    const preview = buildUpgradePlan({
      installRoot: REPO_ROOT,
      home,
      project,
      channel: "development",
      dryRun: true,
      only: ["runtime"],
    });

    expect(JSON.stringify(preview)).not.toContain(externalConfig);
    expect(preview.phases.find((phase) => phase.name === "runtime")?.items).toEqual([
      expect.objectContaining({ action: "configure", runtime: "copilot", status: "noop" }),
    ]);
    expect(preview.lifecycleStatus).toBe(STATUS_NO_CHANGES_NEEDED);
    expect(preview.dryRunCommand).toBeNull();
    expect(preview.applyCommand).toBeNull();

    buildUpgradePlan({ installRoot: REPO_ROOT, home, project, channel: "development", yes: true });
    expect(snapshotTree(externalConfig)).toEqual(externalBefore);
  });

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

  it("delegates legacy plan lifecycle work on an active-entity dry-run", () => {
    const project = copyFixture("v2-yaml-project", path.join(tmp, "active-entity-preview"));
    initializeGit(project);
    applyPreparedEntityCutover(prepareEntityCutoverForUpgrade(project, REPO_ROOT));
    const legacyPlan = fs.readFileSync(path.join(project, ".agentera/plan.yaml"));

    const plan = buildUpgradePlan({
      installRoot: path.join(home, "agentera"),
      home,
      project,
      channel: "development",
      dryRun: true,
      force: true,
    });
    const artifacts = plan.phases.find((phase) => phase.name === "artifacts");

    expect(artifacts?.items.find((item) => item.action === "normalize-plan-lifecycle")).toMatchObject({
      status: "noop",
      message: expect.stringMatching(/entity cutover normalizes plan lifecycle/),
    });
    expect(artifacts?.summary.pending).toBe(0);
    expect(plan.phases.some((phase) => phase.name === "lifecycle")).toBe(true);
    expect(plan.lifecycle?.status).toBe("noop");
    expect(plan.summary.pending).toBe(0);
    expect(fs.readFileSync(path.join(project, ".agentera/plan.yaml"))).toEqual(legacyPlan);
  });

  it("persists inherited-confidence provenance through cutover and uses it for reads", () => {
    const project = copyFixture("v2-yaml-project", path.join(tmp, "inherited-confidence-cutover"));
    fs.writeFileSync(path.join(project, ".agentera/decisions.yaml"), YAML.stringify({ decisions: [{
      number: 1,
      date: "2026-07-21",
      question: "Keep inherited confidence?",
      context: "Cutover compatibility",
      alternatives: [{ name: "Preserve", status: "chosen" }],
      choice: "Preserve",
      reasoning: "Migration provenance is explicit.",
      confidence: "high",
      satisfaction: { state: "open" },
    }] }));
    const archiveRecord = {
      number: 2,
      date: "2026-07-20",
      question: "Preserve archived confidence?",
      context: "Verified archive compatibility",
      alternatives: [{ name: "Preserve", status: "chosen" }],
      choice: "Preserve",
      reasoning: "Archive migration uses the same classifier.",
      confidence: "medium",
      satisfaction: { state: "provisionally_satisfied", evidence: "archive fixture" },
    };
    const archiveDir = path.join(project, ".agentera/archive/decisions");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, "2.yaml"), YAML.stringify({
      schemaVersion: "agentera.stateArchiveEntry.v1",
      artifact_id: "decisions",
      entry_number: 2,
      record: archiveRecord,
      record_sha256: createHash("sha256").update(canonicalRecordJson(archiveRecord)).digest("hex"),
    }));
    initializeGit(project);

    const prepared = prepareEntityCutoverForUpgrade(project, REPO_ROOT);
    expect(applyPreparedEntityCutover(prepared)).toMatchObject({ status: "complete", idempotent: false, mutation_performed: true });
    expect(applyPreparedEntityCutover(prepared)).toMatchObject({ status: "complete", idempotent: true, mutation_performed: false });
    const entityDir = path.join(project, ".agentera/entities/decisions/decision");
    const entities = fs.readdirSync(entityDir).map((name) => YAML.parse(fs.readFileSync(path.join(entityDir, name), "utf8")));
    const entity = entities.find((candidate) => candidate.migration_provenance?.source === "current_projection");
    expect(entity).toMatchObject({
      migration_provenance: {
        kind: "inherited_decision_confidence",
        source: "current_projection",
        source_path: ".agentera/decisions.yaml",
        source_record_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        confidence: "high",
      },
      record: { confidence: "high" },
    });
    expect(validateEntityState(project)).toMatchObject({ valid: true });
    expect((getDecisionEntity(project, entity.id) as any).entry).toMatchObject({
      record: { confidence: "high", satisfaction: { state: "open" } },
      caveats: [expect.stringContaining("inherited unsupported confidence label 'high'")],
    });
    const archived = entities.find((candidate) => candidate.migration_provenance?.source === "verified_archive");
    expect(archived).toMatchObject({
      migration_provenance: { source_path: ".agentera/archive/decisions/2.yaml", confidence: "medium" },
      record: { confidence: "medium" },
    });
    expect((getDecisionEntity(project, archived.id) as any).entry).toMatchObject({
      record: { confidence: "medium", satisfaction: { state: "provisionally_satisfied", evidence: "archive fixture" } },
      caveats: [expect.stringContaining("inherited unsupported confidence label 'medium'")],
    });
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
    expect(plan.phases.map((p) => p.name)).toEqual(["detect", "artifacts", "entities", "runtime", "cleanup", "lifecycle"]);
    expect(plan.phases.every((p) => p.summary && Array.isArray(p.items))).toBe(true);
    expect(plan.dryRunCommand).toContain("--dry-run");
    expect(plan.applyCommand).toContain("--yes");
    expect(plan.applyCommand).not.toContain("--runtime");
    expect(plan.applyCommand).not.toContain("--target-major");
    expect(plan.upgradeOutcome.kind).toBe("migration_to_latest_on_channel");
    expect(plan.lifecycle?.status).toBe("noop");
  });

  it("rejects retired runtime selection before a blocked app phase", () => {
    const appHome = path.join(home, "agentera-blocked");
    managedV2(appHome);
    fs.writeFileSync(path.join(appHome, "unrecognized-entry"), "user-owned\n");
    const project = copyFixture("v2-yaml-project", path.join(tmp, "blocked-project"));

    expect(() => buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      runtime: "all",
      dryRun: true,
    })).toThrow("--runtime all is retired");
  });

  it.each([
    { label: "preview", yes: false, operationsPath: "plan" },
    { label: "apply", yes: true, operationsPath: "result" },
  ])("keeps the native resource cleanup phase message aligned with the $label payload", ({ yes, operationsPath }) => {
    const project = path.join(tmp, `cleanup-${operationsPath}`);
    fs.mkdirSync(project, { recursive: true });

    const plan = buildUpgradePlan({
      installRoot: REPO_ROOT,
      home,
      project,
      channel: "development",
      legacyCleanup: "claude.agentera-skill-link",
      yes,
      dryRun: !yes,
    });
    const phase = plan.phases.find((candidate) => candidate.name === "lifecycle");

    expect(phase?.message).toBe(
      "summary only; selected native Agentera resource cleanup outcomes are reported under lifecycle.nativeResourceCleanup",
    );
    expect(plan.lifecycle?.mode).toBe(yes ? "apply" : "preview");
    expect(plan.lifecycle?.nativeResourceCleanup).toHaveProperty("resourceId", "claude.agentera-skill-link");
    if (operationsPath === "plan") {
      expect(plan.lifecycle?.nativeResourceCleanup).toHaveProperty("plan.operations");
      expect(plan.lifecycle?.nativeResourceCleanup).not.toHaveProperty("operations");
    } else {
      expect(plan.lifecycle?.nativeResourceCleanup).toHaveProperty("operations");
      expect(plan.lifecycle?.nativeResourceCleanup).not.toHaveProperty("plan");
    }
  });

  it("keeps an explicit native cleanup preview limited to its selected resource", () => {
    const project = copyFixture("v2-yaml-project", path.join(tmp, "targeted-cleanup-preview"));

    const plan = buildUpgradePlan({
      installRoot: REPO_ROOT,
      home,
      project,
      channel: "development",
      legacyCleanup: "claude.agentera-skill-link",
      dryRun: true,
    });

    expect(plan.phases.map((phase) => phase.name)).toEqual(["lifecycle"]);
    expect(plan.summary).toEqual(plan.phases[0]?.summary);
    expect(plan.lifecycle?.nativeResourceCleanup).toMatchObject({
      resourceId: "claude.agentera-skill-link",
    });
    expect(JSON.stringify(plan)).not.toContain("newText");
  });

  it("renders the selected Codex descriptor resource instead of a Claude-only scope", () => {
    const project = path.join(tmp, "codex-cleanup-preview");
    fs.mkdirSync(project, { recursive: true });
    const plan = buildUpgradePlan({
      installRoot: REPO_ROOT,
      home,
      project,
      channel: "development",
      legacyCleanup: "codex.agent-descriptor.build",
      dryRun: true,
    });

    expect(renderUpgradePlan(plan)).toContain(
      "scope: ownership-proven native Agentera resource codex.agent-descriptor.build; unrelated user-owned data excluded",
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

    expect(stablePreview.lifecycle?.status).toBe("noop");
    expect(developmentApply.lifecycle?.status).toBe("noop");
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

  it("previews, applies, and converges automatic plugin retirement on same-major v3", () => {
    const bundle = v3Bundle();
    const project = copyFixture("v2-yaml-project", path.join(tmp, "v3-project"));
    initializeGit(project);
    applyPreparedEntityCutover(prepareEntityCutoverForUpgrade(project, bundle));
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;

    const plugin = path.join(home, ".config", "opencode", "plugins", "agentera.js");
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    const historical = spawnSync("git", ["show", "aa33870df05d53745ebad5351b8a352b7dad7780:.opencode/plugins/agentera.js"], {
      cwd: REPO_ROOT,
      encoding: null,
    });
    expect(historical.status).toBe(0);
    fs.writeFileSync(plugin, historical.stdout);
    const observed = observeLifecyclePath(plugin, [home]);
    appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(bundle), {
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
      owner: "agentera",
      records: [{
        resourceId: "opencode.plugin",
        destination: plugin,
        kind: "file",
        scope: "whole",
        status: "managed",
        fingerprint: observed.fingerprint!,
        identity: observed.identity!,
      }],
    });

    const preview = buildUpgradePlan({ installRoot: bundle, home, project, channel: "development", dryRun: true });
    expect(preview.crossMajorBoundary).toBe(false);
    expect(preview.lifecycle?.cleanupSummary.pending).toBe(1);
    expect(fs.existsSync(plugin)).toBe(true);

    const applied = buildUpgradePlan({ installRoot: bundle, home, project, channel: "development", yes: true });
    expect(applied.lifecycle?.cleanupSummary.applied).toBe(1);
    expect(renderUpgradePlan(applied)).toContain("restart OpenCode");
    expect(fs.existsSync(plugin)).toBe(false);
    const noop = buildUpgradePlan({ installRoot: bundle, home, project, channel: "development", yes: true });
    expect(noop.lifecycle?.status).toBe("noop");
    expect(renderUpgradePlan(noop)).not.toContain("restart OpenCode");

    fs.writeFileSync(plugin, historical.stdout);
    const replacementObservation = observeLifecyclePath(plugin, [home]);
    appendLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(bundle), {
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA,
      owner: "agentera",
      records: [{
        resourceId: "opencode.plugin",
        destination: plugin,
        kind: "file",
        scope: "whole",
        status: "managed",
        fingerprint: replacementObservation.fingerprint!,
        identity: replacementObservation.identity!,
      }],
    });
    const raced = runLifecycleUpgrade({
      home,
      appHome: bundle,
      apply: true,
      resourceCleanup: "opencode.plugin.agentera",
      automaticRetirement: true,
    }, {
      beforePublication() {
        fs.writeFileSync(plugin, "changed before removal\n");
      },
    });
    expect(raced.cleanupSummary.failed).toBe(1);
    expect(fs.readFileSync(plugin, "utf8")).toBe("changed before removal\n");
  });

  it("preserves an unproven plugin while applying unrelated upgrade work", () => {
    const bundle = v3Bundle();
    const project = copyFixture("v2-yaml-project", path.join(tmp, "unproven-project"));
    initializeGit(project);
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;
    const plugin = path.join(home, ".config", "opencode", "plugins", "agentera.js");
    fs.mkdirSync(path.dirname(plugin), { recursive: true });
    fs.writeFileSync(plugin, "user owned\n");

    const applied = buildUpgradePlan({ installRoot: bundle, home, project, channel: "development", yes: true });

    expect(fs.readFileSync(plugin, "utf8")).toBe("user owned\n");
    expect(applied.lifecycle?.status).toBe("non_success");
    expect("plan" in applied.lifecycle!.nativeResourceCleanup && applied.lifecycle.nativeResourceCleanup.ledgerDiagnostics).toContain(
      "automatic retirement requires manual review: unproven_content",
    );
    expect(validateEntityState(project).valid).toBe(true);
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

    expect(plan.phases.map((p) => p.name)).toEqual(["detect", "artifacts", "entities", "lifecycle"]);
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
    expect(payload.lifecycle.status).toBe("noop");
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
