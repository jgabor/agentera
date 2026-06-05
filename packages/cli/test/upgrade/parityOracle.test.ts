import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import {
  MIGRATION_STATUSES,
  type MigrationStatus,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  STATUS_APPLIED,
  STATUS_MANUAL_REVIEW_NEEDED,
  STATUS_NO_CHANGES_NEEDED,
  STATUS_READY_TO_APPLY,
  UPGRADE_PREVIEW_SCHEMA,
  collectV3MigrationOperations,
} from "../../src/upgrade/compatibility.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import {
  buildUpgradePlan,
  upgradeExitCode,
  type UpgradePlanV2,
} from "../../src/upgrade/upgradeOrchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/python-main-contract.json"), "utf8"),
) as {
  schemaVersions: { pythonMain: string; typescriptV3Migration: string };
  lifecycleStatusMapping: Record<MigrationStatus, string>;
  workflowStatuses: MigrationStatus[];
  lifecycleStatuses: string[];
  exitCodeRules: Record<string, number>;
  pythonMainPhases: string[];
  typescriptV3Phases: string[];
  scenarios: Array<{
    name: string;
    pythonReturncode?: number;
    workflowPhaseStatus?: MigrationStatus;
    lifecycleStatus?: string;
    typescriptOnly?: boolean;
    crossMajorMigrationOperations?: number;
  }>;
};

const LIFECYCLE_BY_WORKFLOW: Record<MigrationStatus, string> = {
  pending: STATUS_READY_TO_APPLY,
  applied: STATUS_APPLIED,
  noop: STATUS_NO_CHANGES_NEEDED,
  blocked: STATUS_MANUAL_REVIEW_NEEDED,
  failed: STATUS_MANUAL_REVIEW_NEEDED,
  skipped: STATUS_NO_CHANGES_NEEDED,
};

let tmp: string;
let home: string;

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

function planWithSummary(summary: UpgradePlanV2["summary"], mode: "plan" | "apply" = "plan"): UpgradePlanV2 {
  return {
    schemaVersion: UPGRADE_PREVIEW_SCHEMA,
    mode,
    status: "pending",
    lifecycleStatus: STATUS_READY_TO_APPLY,
    channel: {
      channel: "development",
      distTag: "next",
      updateCommand: "npx -y agentera@next",
      distributionMajor: 3,
      source: "default",
      gitRef: "main",
      gitUpdateCommand: "uvx --from git+https://github.com/jgabor/agentera@main agentera",
    },
    install: {
      kind: "v2_managed_app_home",
      appHome: "/tmp/agentera",
      activeBundleRoot: "/tmp/agentera/app",
      managedAppRoot: "/tmp/agentera/app",
      sourceRoot: REPO_ROOT,
      signals: {} as never,
    },
    targetMajor: 3,
    crossMajorBoundary: true,
    project: "/tmp/project",
    appHome: "/tmp/agentera",
    home: "/tmp/home",
    phases: [],
    summary,
    dryRunCommand: null,
    applyCommand: null,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"));
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

describe("Python main oracle contract parity", () => {
  it("documents intentional schema version bump while preserving lifecycle vocabulary", () => {
    expect(UPGRADE_PREVIEW_SCHEMA).toBe(ORACLE.schemaVersions.typescriptV3Migration);
    expect(UPGRADE_PREVIEW_SCHEMA).not.toBe(ORACLE.schemaVersions.pythonMain);
  });

  it("matches Python workflow and lifecycle status vocabulary from app-lifecycle-vocabulary", () => {
    expect(MIGRATION_STATUSES).toEqual(ORACLE.workflowStatuses);
    for (const workflow of ORACLE.workflowStatuses) {
      expect(LIFECYCLE_BY_WORKFLOW[workflow]).toBe(ORACLE.lifecycleStatusMapping[workflow]);
    }
    expect(Object.values(LIFECYCLE_BY_WORKFLOW).every((status) => ORACLE.lifecycleStatuses.includes(status))).toBe(
      true,
    );
  });

  it("matches Python cmd_upgrade exit-code rules", () => {
    expect(upgradeExitCode(planWithSummary({ pending: 1, applied: 0, noop: 0, blocked: 0, failed: 0, skipped: 0 }))).toBe(
      ORACLE.exitCodeRules.planWithPendingSummary,
    );
    expect(upgradeExitCode(planWithSummary({ pending: 0, applied: 0, noop: 0, blocked: 1, failed: 0, skipped: 0 }))).toBe(
      ORACLE.exitCodeRules.blockedOrFailedSummary,
    );
    expect(upgradeExitCode(planWithSummary({ pending: 0, applied: 0, noop: 1, blocked: 0, failed: 0, skipped: 0 }))).toBe(
      ORACLE.exitCodeRules.success,
    );

    let err = "";
    const rc = cmdUpgrade({ yes: true, dryRun: true }, { out: () => {}, err: (t) => { err += t; } });
    expect(rc).toBe(ORACLE.exitCodeRules.mutuallyExclusiveYesDryRun);
    expect(err).toContain("mutually exclusive");
  });

  it("uses v3 migration phase names aligned with Python artifacts/runtime/cleanup subset", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    const project = path.join(tmp, "project");
    fs.cpSync(path.join(__dirname, "fixtures/v2-yaml-project"), project, { recursive: true });

    const plan = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      dryRun: true,
    });

    expect(plan.phases.map((phase) => phase.name)).toEqual(ORACLE.typescriptV3Phases);
    for (const phaseName of ["artifacts", "runtime", "cleanup"] as const) {
      expect(ORACLE.pythonMainPhases).toContain(phaseName);
    }
    expect(ORACLE.pythonMainPhases).not.toEqual(ORACLE.typescriptV3Phases);
  });

  it("maps oracle scenario lifecycle statuses from representative TS dry-runs", () => {
    for (const scenario of ORACLE.scenarios) {
      if (scenario.typescriptOnly) {
        continue;
      }
      if (scenario.workflowPhaseStatus && scenario.lifecycleStatus) {
        expect(LIFECYCLE_BY_WORKFLOW[scenario.workflowPhaseStatus]).toBe(scenario.lifecycleStatus);
      }
      if (scenario.pythonReturncode !== undefined && scenario.workflowPhaseStatus) {
        const summary = {
          pending: scenario.workflowPhaseStatus === "pending" ? 1 : 0,
          applied: scenario.workflowPhaseStatus === "applied" ? 1 : 0,
          noop: scenario.workflowPhaseStatus === "noop" ? 1 : 0,
          blocked: scenario.workflowPhaseStatus === "blocked" ? 1 : 0,
          failed: scenario.workflowPhaseStatus === "failed" ? 1 : 0,
          skipped: scenario.workflowPhaseStatus === "skipped" ? 1 : 0,
        };
        expect(upgradeExitCode(planWithSummary(summary))).toBe(scenario.pythonReturncode);
      }
    }
  });

  it("stable dry-run emits zero cross-major migration operations per backport-safety oracle", () => {
    const appHome = path.join(home, "agentera");
    managedV2(appHome);
    let stdout = "";
    const rc = cmdUpgrade(
      {
        installRoot: appHome,
        home,
        dryRun: true,
        format: "json",
        channel: "stable",
      },
      { out: (t) => { stdout += t; } },
    );
    const payload = JSON.parse(stdout);
    const stableScenario = ORACLE.scenarios.find((entry) => entry.name === "stable_channel_no_cross_major_ops");
    expect(collectV3MigrationOperations(payload)).toHaveLength(stableScenario?.crossMajorMigrationOperations ?? 0);
    expect(rc).toBe(ORACLE.exitCodeRules.blockedOrFailedSummary);
  });
});
