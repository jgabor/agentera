import os from "node:os";

import { expanduser, resolvePath } from "../core/paths.js";
import { resolveDoctorInstallRoot, resolveSourceRootStrict } from "./appModel.js";
import {
  MAJOR_BOUNDARY_ITEM_TAG,
  STATUS_APPLIED,
  STATUS_MANUAL_REVIEW_NEEDED,
  STATUS_NO_CHANGES_NEEDED,
  STATUS_READY_TO_APPLY,
  UPGRADE_PREVIEW_SCHEMA,
  classifyInstall,
  crossMajorBoundaryApplies,
  previewCrossMajorGuard,
  shouldIncludeCrossMajorPlanItems,
  type InstallClassification,
} from "./compatibility.js";
import { resolveUpdateChannel, type ResolvedUpdateChannel } from "./channels.js";
import { buildUpgradeCommands, type UpgradeOnlyPhase } from "./upgradeCommands.js";
import {
  MIGRATION_STATUSES,
  applyMigrationPhases,
  dryRunMigration,
  type MigrationPhase,
  type MigrationPhaseItem,
  type MigrationPhaseSummary,
  type MigrationStatus,
} from "./migrateArtifactsV2ToV3.js";

/**
 * Phased upgrade orchestration for v2→v3 migration and project-level migration work.
 * Behavior oracle: scripts/agentera_upgrade.py (phase structure, lifecycle mapping).
 */

export type UpgradePhaseName = "detect" | "artifacts" | "runtime" | "cleanup";
export type { UpgradeOnlyPhase } from "./upgradeCommands.js";

const DEFAULT_PHASES: readonly UpgradePhaseName[] = ["detect", "artifacts", "runtime", "cleanup"];
const MIGRATION_ONLY_PHASES: readonly UpgradeOnlyPhase[] = ["artifacts", "runtime", "cleanup"];

export interface UpgradeOrchestratorArgs {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  channel?: string | null;
  targetMajor?: number | null;
  yes?: boolean;
  dryRun?: boolean;
  only?: readonly UpgradeOnlyPhase[] | null;
  force?: boolean;
}

export interface UpgradeOrchestratorPhase {
  name: UpgradePhaseName;
  status: MigrationStatus;
  summary: MigrationPhaseSummary;
  items: MigrationPhaseItem[];
  message: string;
}

export interface UpgradePlanV2 {
  schemaVersion: typeof UPGRADE_PREVIEW_SCHEMA;
  mode: "plan" | "apply";
  status: MigrationStatus;
  lifecycleStatus:
    | typeof STATUS_MANUAL_REVIEW_NEEDED
    | typeof STATUS_NO_CHANGES_NEEDED
    | typeof STATUS_READY_TO_APPLY
    | typeof STATUS_APPLIED;
  channel: ResolvedUpdateChannel;
  install: InstallClassification;
  targetMajor: number | null;
  crossMajorBoundary: boolean;
  project: string;
  appHome: string;
  home: string;
  phases: UpgradeOrchestratorPhase[];
  summary: MigrationPhaseSummary;
  dryRunCommand: string | null;
  applyCommand: string | null;
}

function emptySummary(): MigrationPhaseSummary {
  return { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0, skipped: 0 };
}

function aggregateSummary(phases: UpgradeOrchestratorPhase[]): MigrationPhaseSummary {
  const summary = emptySummary();
  for (const phase of phases) {
    for (const status of MIGRATION_STATUSES) {
      summary[status] += phase.summary[status];
    }
  }
  return summary;
}

function workflowStatus(summary: MigrationPhaseSummary): MigrationStatus {
  if (summary.blocked > 0) return "blocked";
  if (summary.failed > 0) return "failed";
  if (summary.pending > 0) return "pending";
  if (summary.applied > 0) return "applied";
  if (summary.skipped > 0 && summary.noop === 0 && summary.applied === 0) return "skipped";
  return "noop";
}

function lifecycleStatusFromWorkflow(workflow: MigrationStatus, mode: "plan" | "apply"): UpgradePlanV2["lifecycleStatus"] {
  switch (workflow) {
    case "pending":
      return STATUS_READY_TO_APPLY;
    case "applied":
      return STATUS_APPLIED;
    case "noop":
    case "skipped":
      return STATUS_NO_CHANGES_NEEDED;
    case "blocked":
    case "failed":
      return STATUS_MANUAL_REVIEW_NEEDED;
    default:
      return mode === "apply" ? STATUS_APPLIED : STATUS_NO_CHANGES_NEEDED;
  }
}

function selectedPhases(only: readonly UpgradeOnlyPhase[] | null | undefined): Set<UpgradePhaseName> {
  if (!only || only.length === 0) {
    return new Set(DEFAULT_PHASES);
  }
  const selected = new Set<UpgradePhaseName>(["detect"]);
  for (const name of only) {
    if ((MIGRATION_ONLY_PHASES as readonly string[]).includes(name)) {
      selected.add(name);
    }
  }
  return selected;
}

function summarizeOrchestratorPhase(
  name: UpgradePhaseName,
  items: MigrationPhaseItem[],
  message = "",
): UpgradeOrchestratorPhase {
  const summary = emptySummary();
  for (const item of items) {
    summary[item.status] += 1;
  }
  let status: MigrationStatus;
  if (summary.blocked > 0) status = "blocked";
  else if (summary.failed > 0) status = "failed";
  else if (summary.pending > 0) status = "pending";
  else if (summary.applied > 0) status = "applied";
  else if (summary.skipped > 0 && summary.noop === 0 && summary.applied === 0) status = "skipped";
  else status = "noop";
  return { name, status, summary, items, message };
}

function buildDetectPhase(
  install: InstallClassification,
  crossMajorBoundary: boolean,
  explicitMajorOptIn: boolean,
  channel: ResolvedUpdateChannel,
): UpgradeOrchestratorPhase {
  const items: MigrationPhaseItem[] = [
    {
      status: "noop",
      action: "detect-install",
      message: `detected ${install.kind.replace(/_/g, " ")} layout`,
    },
  ];

  if (crossMajorBoundary && !shouldIncludeCrossMajorPlanItems(channel, explicitMajorOptIn)) {
    items.push({
      status: "blocked",
      action: "major-boundary",
      message:
        "v2→v3 migration requires explicit opt-in: rerun with --target-major 3 on a 3.x development-channel CLI after preview",
    });
  }

  return summarizeOrchestratorPhase("detect", items);
}

function migrationPhaseToOrchestrator(phase: MigrationPhase): UpgradeOrchestratorPhase {
  return {
    name: phase.name,
    status: phase.status,
    summary: phase.summary,
    items: phase.items,
    message: phase.message,
  };
}

export function buildUpgradePlan(args: UpgradeOrchestratorArgs): UpgradePlanV2 {
  const sourceRoot = resolveSourceRootStrict();
  const home = resolvePath(expanduser(args.home ?? os.homedir()));
  const env = { ...process.env, HOME: home };
  const project = resolvePath(expanduser(args.project ?? process.cwd()));
  const [installRoot] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
  const channel = resolveUpdateChannel({
    channel: args.channel ?? null,
    env,
    home,
    sourceRoot,
  });
  const install = classifyInstall({ appHome: installRoot, sourceRoot });
  const targetMajor = args.targetMajor ?? null;
  const explicitMajorOptIn = targetMajor === 3;
  const crossMajorBoundary = crossMajorBoundaryApplies(install, sourceRoot);
  const phaseFilter = selectedPhases(args.only);
  const runMigration =
    crossMajorBoundary && shouldIncludeCrossMajorPlanItems(channel, explicitMajorOptIn);

  const phases: UpgradeOrchestratorPhase[] = [];

  if (phaseFilter.has("detect")) {
    phases.push(buildDetectPhase(install, crossMajorBoundary, explicitMajorOptIn, channel));
  }

  let migrationPreview = runMigration
    ? dryRunMigration({ appHome: installRoot, project, home, force: args.force })
    : null;

  if (args.yes && migrationPreview) {
    migrationPreview = applyMigrationPhases(
      { appHome: installRoot, project, home, force: args.force },
      migrationPreview,
      args.only && args.only.length > 0 ? args.only : MIGRATION_ONLY_PHASES,
    );
  }

  if (migrationPreview) {
    if (phaseFilter.has("artifacts")) {
      phases.push(migrationPhaseToOrchestrator(migrationPreview.artifacts));
    }
    if (phaseFilter.has("runtime")) {
      phases.push(migrationPhaseToOrchestrator(migrationPreview.runtime));
    }
    if (phaseFilter.has("cleanup")) {
      phases.push(migrationPhaseToOrchestrator(migrationPreview.cleanup));
    }
  } else if (crossMajorBoundary) {
    const guard = previewCrossMajorGuard({
      appHome: installRoot,
      sourceRoot,
      channel: args.channel ?? null,
      env,
      home,
      targetMajor,
    });
    for (const guardPhase of guard.phases) {
      if (guardPhase.name === "detect" || !phaseFilter.has(guardPhase.name as UpgradePhaseName)) {
        continue;
      }
      const items: MigrationPhaseItem[] = guardPhase.items.map((item) => ({
        status: "blocked",
        action: item.verb,
        message: `${item.name} requires explicit major opt-in (--target-major 3)`,
      }));
      phases.push({
        name: guardPhase.name as UpgradePhaseName,
        status: items.length > 0 ? "blocked" : "noop",
        summary: { ...emptySummary(), blocked: items.length },
        items,
        message: "",
      });
    }
  }

  const summary = aggregateSummary(phases);
  const status = workflowStatus(summary);
  const mode = args.yes ? "apply" : "plan";
  const lifecycleStatus = lifecycleStatusFromWorkflow(status, mode);
  const blocked = status === "blocked" || status === "failed";
  const commands = buildUpgradeCommands({
    project,
    installRoot,
    channel,
    targetMajor: explicitMajorOptIn ? 3 : null,
    only: args.only,
  });

  return {
    schemaVersion: UPGRADE_PREVIEW_SCHEMA,
    mode,
    status,
    lifecycleStatus,
    channel,
    install,
    targetMajor,
    crossMajorBoundary,
    project,
    appHome: installRoot,
    home,
    phases,
    summary,
    dryRunCommand: blocked || lifecycleStatus === STATUS_NO_CHANGES_NEEDED ? null : commands.dryRunCommand,
    applyCommand: blocked || lifecycleStatus === STATUS_NO_CHANGES_NEEDED ? null : commands.applyCommand,
  };
}

export function validateUpgradeApply(args: UpgradeOrchestratorArgs, plan: UpgradePlanV2): string | null {
  if (args.yes && args.dryRun) {
    return "--yes and --dry-run are mutually exclusive";
  }
  if (!args.yes) {
    return null;
  }
  if (plan.crossMajorBoundary && plan.targetMajor !== 3) {
    return (
      "cross-major v2→v3 migration requires a preview first: run the same command with --dry-run, " +
      "then apply with --yes and --target-major 3"
    );
  }
  if (
    plan.crossMajorBoundary &&
    plan.targetMajor === 3 &&
    !shouldIncludeCrossMajorPlanItems(plan.channel, true)
  ) {
    return "cross-major v2→v3 migration requires a 3.x development-channel CLI; stable channel cannot apply v3 migration";
  }
  return null;
}

export function renderUpgradePlan(plan: UpgradePlanV2): string {
  const lines = [
    "Agentera upgrade",
    `lifecycle status: ${plan.lifecycleStatus.replace(/_/g, " ")}`,
    `mode: ${plan.mode === "plan" ? "preview only; no files were changed" : "applying approved changes"}`,
    `project: ${plan.project}`,
    `Agentera directory: ${plan.appHome}`,
    `channel: ${plan.channel.channel} (distribution major ${plan.channel.distributionMajor})`,
  ];
  if (plan.crossMajorBoundary) {
    lines.push("cross-major boundary: yes");
    if (plan.targetMajor !== null) {
      lines.push(`target major: ${plan.targetMajor}`);
    }
  }
  for (const phase of plan.phases) {
    lines.push("");
    lines.push(`${phase.name}:`);
    if (phase.message && phase.items.length === 0) {
      lines.push(`  ${phase.status}: ${phase.message}`);
    }
    for (const item of phase.items) {
      lines.push(`  - ${item.status}: ${item.action}`);
      if (item.message) {
        lines.push(`    ${item.message}`);
      }
    }
  }
  if (plan.mode === "plan" && plan.summary.pending > 0 && plan.applyCommand) {
    lines.push("");
    lines.push(`Next: if this preview looks right, apply with: ${plan.applyCommand}`);
  }
  return lines.join("\n") + "\n";
}

export function upgradeExitCode(plan: UpgradePlanV2): number {
  if (plan.summary.blocked > 0 || plan.summary.failed > 0) {
    return 1;
  }
  if (plan.mode === "plan" && plan.summary.pending > 0) {
    return 1;
  }
  return 0;
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export { MAJOR_BOUNDARY_ITEM_TAG };
