import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { cmdDoctor } from "../../src/cli/commands/doctor.js";
import { emptyLifecycleOwnershipLedger } from "../../src/runtime/lifecycleOperations.js";
import {
  observeRuntimeLifecycle,
  summarizeRuntimeLifecycle,
  type RuntimeLifecycleSnapshot,
} from "../../src/runtime/lifecycleSnapshot.js";
import { summarizeProjectIntegration } from "../../src/upgrade/projectIntegration.js";
import { buildUpgradePlan } from "../../src/upgrade/upgradeOrchestrator.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let root: string;
let home: string;
let project: string;
let appHome: string;
let previousCwd = process.cwd();
let previousBootstrap: string | undefined;
let previousHome: string | undefined;
let previousPath: string | undefined;

function captureDoctor(): Record<string, any> {
  let output = "";
  const code = cmdDoctor(
    { installRoot: appHome, home, project, format: "json" },
    { out: (text) => { output += text; }, err: () => {} },
  );
  expect(code).toBe(1);
  return JSON.parse(output);
}

function sharedSummary(snapshot: RuntimeLifecycleSnapshot): Record<string, unknown> {
  return summarizeRuntimeLifecycle(snapshot) as unknown as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-consumer-parity-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  appHome = path.join(root, "app home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(appHome, { recursive: true });
  for (const entry of ["skills", "references"]) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(appHome, entry), { recursive: true });
  }
  fs.cpSync(
    path.join(REPO_ROOT, "packages", "cli", "dist", "capabilities"),
    path.join(appHome, "dist", "capabilities"),
    { recursive: true },
  );
  fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(appHome, "registry.json"));
  previousCwd = process.cwd();
  previousBootstrap = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  previousHome = process.env.HOME;
  previousPath = process.env.PATH;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.PATH = "";
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousBootstrap === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousBootstrap;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lifecycle consumer projection parity", () => {
  it("shares one identity, classification, count, and command projection", () => {
    const runtimeEnv = { ...process.env, HOME: home, PATH: "" };
    const context = {
      home,
      project,
      sourceRoot: REPO_ROOT,
      env: runtimeEnv,
      ledger: emptyLifecycleOwnershipLedger(),
      canonicalSkillTarget: path.join(appHome, "skills", "agentera"),
    };
    const observed = observeRuntimeLifecycle(context);
    const expected = sharedSummary(observed);
    const integration = summarizeProjectIntegration({
      project,
      sourceRoot: REPO_ROOT,
      home,
      env: context.env,
      installRoot: appHome,
      bundleStatus: "up_to_date",
      lifecycleSnapshot: observed,
    });
    const upgrade = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      runtime: "all",
      dryRun: true,
    });
    const doctor = captureDoctor();
    const state = collectOrientationState({ home, installRoot: appHome, env: process.env });
    const status = buildPrimeCapabilityContextPayload(state, "status");

    expect(integration.pending_runtime).toBe(
      new Set(observed.actions.filter((action) => action.actionClass === "repairable_owned")
        .flatMap((action) => action.runtimeIds)).size,
    );
    expect(upgrade.lifecycle?.projection).toEqual(observed);
    expect(doctor.runtime_lifecycle).toEqual(observed);
    expect(state.runtime_lifecycle_snapshot).toEqual(observed);
    expect(state.runtime_lifecycle).toEqual(expected);
    expect(status.runtime_lifecycle).toEqual(expected);
    expect(integration.phases.lifecycle.counts.total).toBe(observed.counts.total);
    expect(integration.phases.lifecycle.counts.pending).toBe(observed.counts.repairableOwned);
    expect(integration.phases.lifecycle.counts.blocked).toBe(
      observed.counts.manualVerification + observed.counts.unobservableGap,
    );
    expect(upgrade.dryRunCommand).toBe(integration.dry_run_command);
    expect(upgrade.applyCommand).toBe(integration.apply_command);
  });
});
