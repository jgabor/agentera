import os from "node:os";
import path from "node:path";

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
  type InstallClassification,
} from "./compatibility.js";
import {
  classifyUpgradeOutcome,
  isBlockedUpgradeOutcome,
  shouldIncludeCrossMajorPlanItems,
  type UpgradeOutcome,
} from "./versionResolution.js";
import { resolveInvokedUpdateChannel, type ResolvedUpdateChannel } from "./channels.js";
import { buildUpgradeCommands, type UpgradeOnlyPhase } from "./upgradeCommands.js";
import { pendingRuntimeMigrationItems } from "./projectIntegration.js";
import {
  planLegacyAgentCleanupItems,
  planLegacyCapabilityAgentCleanupItems,
} from "./legacyAgentCleanup.js";
import {
  MIGRATION_STATUSES,
  applyMigrationPhases,
  delegatePlanLifecycleToEntityCutover,
  detectV1ArtifactPairs,
  dryRunMigration,
  hasPendingPlanLifecycleMigration,
  type MigrationPhase,
  type MigrationPhaseItem,
  type MigrationPhaseSummary,
  type MigrationStatus,
} from "./migrateArtifactsV2ToV3.js";
import {
  runLifecycleUpgrade,
  type LifecycleUpgradeResult,
} from "./lifecycleUpgrade.js";
import { acquireUpgradeLock, releaseUpgradeLock } from "./upgradeLock.js";
import {
  applyPreparedEntityCutover,
  inspectEntityCutoverForUpgrade,
  prepareEntityCutoverForUpgrade,
  type PreparedEntityCutover,
} from "../state/entityCutover.js";
import { detectStateMode } from "../state/stateMode.js";

/**
 * Phased upgrade orchestration for v2→v3 migration and project-level migration work.
 * Behavior oracle: scripts/agentera_upgrade.py (phase structure, lifecycle mapping).
 */

export type UpgradePhaseName = "detect" | "artifacts" | "entities" | "runtime" | "cleanup" | "lifecycle";
export type { UpgradeOnlyPhase } from "./upgradeCommands.js";

const DEFAULT_PHASES: readonly UpgradePhaseName[] = ["detect", "artifacts", "runtime", "cleanup"];
const MIGRATION_ONLY_PHASES: readonly UpgradeOnlyPhase[] = ["artifacts", "runtime", "cleanup"];

export interface UpgradeOrchestratorArgs {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  channel?: string | null;
  yes?: boolean;
  dryRun?: boolean;
  only?: readonly UpgradeOnlyPhase[] | null;
  force?: boolean;
  /** Retired CLI input retained only so direct callers fail before mutation. */
  runtime?: string | null;
  legacyCleanup?: string | null;
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
  upgradeOutcome: UpgradeOutcome;
  crossMajorBoundary: boolean;
  project: string;
  appHome: string;
  home: string;
  phases: UpgradeOrchestratorPhase[];
  lifecycle: LifecycleUpgradeResult | null;
  summary: MigrationPhaseSummary;
  dryRunCommand: string | null;
  applyCommand: string | null;
}

function emptySummary(): MigrationPhaseSummary {
  return { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0 };
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
  return "noop";
}

function lifecycleStatusFromWorkflow(workflow: MigrationStatus, mode: "plan" | "apply"): UpgradePlanV2["lifecycleStatus"] {
  switch (workflow) {
    case "pending":
      return STATUS_READY_TO_APPLY;
    case "applied":
      return STATUS_APPLIED;
    case "noop":
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
  else status = "noop";
  return { name, status, summary, items, message };
}

function buildDetectPhase(
  install: InstallClassification,
  crossMajorBoundary: boolean,
  outcome: UpgradeOutcome,
  channel: ResolvedUpdateChannel,
): UpgradeOrchestratorPhase {
  const items: MigrationPhaseItem[] = [
    {
      status: "noop",
      action: "detect-install",
      message: `detected ${install.kind.replace(/_/g, " ")} layout`,
    },
  ];

  if (isBlockedUpgradeOutcome(outcome)) {
    items.push({
      status: "blocked",
      action: "downgrade-blocked",
      message: outcome.message ?? "upgrade blocked",
    });
  } else if (crossMajorBoundary && !shouldIncludeCrossMajorPlanItems(channel, outcome)) {
    items.push({
      status: "blocked",
      action: "major-boundary",
      message:
        outcome.message ??
        "v2→v3 migration requires the development channel while stable tracks 2.x; rerun with --channel development after preview",
    });
  } else if (outcome.message && outcome.kind !== "up_to_date") {
    items.push({
      status: "noop",
      action: "version-gate",
      message: outcome.message,
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

function entityReadinessPhase(
  project: string,
  sourceRoot: string,
  pendingV1Artifacts: boolean,
  selected: boolean,
  apply: boolean,
  activeUpgradeLockPaths: readonly string[],
): UpgradeOrchestratorPhase {
  try {
    const cutover = inspectEntityCutoverForUpgrade(project, sourceRoot, apply && selected, activeUpgradeLockPaths);
    if (cutover.phase === "active") {
      return summarizeOrchestratorPhase("entities", [{
        status: "noop",
        action: "entity-state-active",
        message: "validated entity authority is already active",
      }]);
    }
    if (cutover.phase !== "ready") {
      if (!selected) {
        return summarizeOrchestratorPhase("entities", [{
          status: "blocked",
          action: "entity-cutover-required",
          message: "a forward entity cutover must complete inside one full upgrade before any filtered effects",
        }]);
      }
      return summarizeOrchestratorPhase("entities", [{
        status: "pending",
        action: "entity-cutover",
        message: "validated forward entity publication is ready to complete without deleting canonical entities",
      }]);
    }
    if (!selected) {
      return summarizeOrchestratorPhase("entities", [{
        status: "blocked",
        action: "entity-cutover-required",
        message: "marker-absent projects require one full cross-major upgrade; filtered apply is unavailable",
      }]);
    }
    if (pendingV1Artifacts) {
      return summarizeOrchestratorPhase("entities", [{
        status: "blocked",
        action: "resolve-v1-state",
        message: "pending v1 Markdown state is not a supported automatic source; preserve it and follow the manual v1 recovery instructions in UPGRADE.md",
      }]);
    }
    const empty = cutover.entityCount === 0;
    return summarizeOrchestratorPhase("entities", [{
      status: empty ? "blocked" : "pending",
      action: empty ? "unsupported-state-source" : "entity-cutover",
      message: empty
        ? "marker-absent state has no recognized v2 entity input; preserve it and follow the manual source recovery instructions in UPGRADE.md"
        : `${cutover.entityCount} entity record(s) are ready for marker-last Git cutover`,
    }]);
  } catch (error) {
    return summarizeOrchestratorPhase("entities", [{
      status: "blocked",
      action: "validate-entity-state",
      message: (error as Error).message,
    }]);
  }
}

function lifecyclePhase(result: LifecycleUpgradeResult): UpgradeOrchestratorPhase {
  const cleanup = result.cleanupSummary;
  const summary: MigrationPhaseSummary = {
    pending: cleanup.pending,
    applied: cleanup.applied,
    noop: cleanup.noop,
    failed: cleanup.failed,
    blocked: cleanup.blocked_unowned + cleanup.skipped_dependency + cleanup.action_required,
  };
  return {
    name: "lifecycle",
    status: workflowStatus(summary),
    summary,
    items: [],
    message: "summary only; selected native Agentera resource cleanup outcomes are reported under lifecycle.nativeResourceCleanup",
  };
}

export function buildUpgradePlan(args: UpgradeOrchestratorArgs): UpgradePlanV2 {
  if (args.runtime) {
    throw new Error(
      `--runtime ${args.runtime} is retired; use the shared skill at ~/.agents/skills/agentera plus the CLI and remove --runtime`,
    );
  }
  const home = resolvePath(expanduser(args.home ?? os.homedir()));
  const project = resolvePath(expanduser(args.project ?? process.cwd()));
  if (!args.yes) return buildUpgradePlanUnlocked(args, home, project, []);

  const projectLock = acquireUpgradeLock(project, "project");
  try {
    const runtimeLock = acquireUpgradeLock(home, "runtime");
    try {
      return buildUpgradePlanUnlocked(args, home, project, [projectLock.path, runtimeLock.path]);
    } finally {
      releaseUpgradeLock(runtimeLock);
    }
  } finally {
    releaseUpgradeLock(projectLock);
  }
}

function buildUpgradePlanUnlocked(
  args: UpgradeOrchestratorArgs,
  home: string,
  project: string,
  activeUpgradeLockPaths: readonly string[],
): UpgradePlanV2 {
  const sourceRoot = resolveSourceRootStrict();
  const inheritedXdgConfigHome = process.env.XDG_CONFIG_HOME
    ? resolvePath(process.env.XDG_CONFIG_HOME)
    : null;
  const xdgRelative = inheritedXdgConfigHome ? path.relative(home, inheritedXdgConfigHome) : null;
  const xdgConfigHome = inheritedXdgConfigHome
    && xdgRelative !== null
    && !xdgRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(xdgRelative)
    ? inheritedXdgConfigHome
    : path.join(home, ".config");
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
  };
  const [installRoot] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
  const channel = resolveInvokedUpdateChannel({
    channel: args.channel ?? null,
    env,
    home,
    sourceRoot,
  });
  const install = classifyInstall({ appHome: installRoot, sourceRoot });
  const upgradeOutcome = classifyUpgradeOutcome({
    appHome: installRoot,
    sourceRoot,
    install,
    channel,
  });
  const crossMajorBoundary = crossMajorBoundaryApplies(install, sourceRoot);
  const phaseFilter = selectedPhases(args.only);
  const migrationCtx = {
    appHome: installRoot,
    project,
    home,
    force: args.force,
    sourceRoot,
    channel: args.channel ?? null,
    env,
    installAppContentIfMissing: false,
  };
  const pendingRuntimeSync = pendingRuntimeMigrationItems(migrationCtx).length > 0;
  const pendingV1Artifacts = detectV1ArtifactPairs(project).length > 0;
  const pendingPlanLifecycleMigration = hasPendingPlanLifecycleMigration(project);
  const crossMajorMigration =
    crossMajorBoundary && shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome);
  const entityAuthorityActive = detectStateMode(project, sourceRoot) === "entities";
  const projectEntityCutover = !entityAuthorityActive
    && channel.distributionMajor >= 3
    && !args.only
    && !args.legacyCleanup;
  const pendingCleanup =
    planLegacyAgentCleanupItems(migrationCtx).some((i) => i.status === "pending") ||
    planLegacyCapabilityAgentCleanupItems(migrationCtx).some((i) => i.status === "pending");
  const runMigration =
    crossMajorMigration || projectEntityCutover || pendingRuntimeSync || pendingV1Artifacts || pendingPlanLifecycleMigration || pendingCleanup;

  const phases: UpgradeOrchestratorPhase[] = [];

  if (phaseFilter.has("detect")) {
    phases.push(buildDetectPhase(install, crossMajorBoundary, upgradeOutcome, channel));
  }

  let migrationPreview = runMigration ? dryRunMigration(migrationCtx) : null;
  const entityBoundary = projectEntityCutover || crossMajorMigration;
  const filteredEntityBoundary = entityBoundary && Boolean(args.only && args.only.length > 0);
  const entitySelected = entityBoundary && (!filteredEntityBoundary || (!args.yes && Boolean(args.only?.includes("artifacts"))));
  const partialStateApply = filteredEntityBoundary && !entitySelected;
  let entityPhase = entitySelected || partialStateApply || (entityAuthorityActive && crossMajorMigration)
    ? entityReadinessPhase(project, sourceRoot, pendingV1Artifacts, entitySelected, Boolean(args.yes), activeUpgradeLockPaths)
    : null;
  const entityCutoverPending = entityPhase?.items.some(({ action }) => action === "entity-cutover") ?? false;
  if (migrationPreview && (entityAuthorityActive || (args.yes && entityCutoverPending))) {
    delegatePlanLifecycleToEntityCutover(migrationPreview.artifacts);
  }
  const lifecycleArgs = args.legacyCleanup ? {
    home,
    appHome: installRoot,
    apply: false,
    resourceCleanup: args.legacyCleanup,
  } : null;
  let lifecycle = lifecycleArgs ? runLifecycleUpgrade(lifecycleArgs) : null;

  const plannedPhases = [
    ...phases,
    ...(migrationPreview && phaseFilter.has("artifacts") ? [migrationPhaseToOrchestrator(migrationPreview.artifacts)] : []),
    ...(entityPhase ? [entityPhase] : []),
    ...(migrationPreview && phaseFilter.has("runtime") ? [migrationPhaseToOrchestrator(migrationPreview.runtime)] : []),
    ...(migrationPreview && phaseFilter.has("cleanup") ? [migrationPhaseToOrchestrator(migrationPreview.cleanup)] : []),
    ...(lifecycle ? [lifecyclePhase(lifecycle)] : []),
  ];
  const entityPreflight = aggregateSummary(plannedPhases.filter((phase) => ["detect", "artifacts", "entities"].includes(phase.name)));
  const entityPreflightBlocked = entityPreflight.blocked > 0 || entityPreflight.failed > 0;

  let preparedEntityMigration: PreparedEntityCutover | null = null;
  if (args.yes && entitySelected && entityPhase?.status === "pending" && !entityPreflightBlocked) {
    preparedEntityMigration = prepareEntityCutoverForUpgrade(project, sourceRoot, activeUpgradeLockPaths);
  }
  if (preparedEntityMigration) {
    const result = applyPreparedEntityCutover(preparedEntityMigration, activeUpgradeLockPaths);
    entityPhase = summarizeOrchestratorPhase("entities", [{
      status: "applied",
      action: "entity-cutover",
      message: `${result.entity_count} entity record(s) published and validated; authority marker written last`,
    }]);
  }

  if (args.yes && migrationPreview && !entityPreflightBlocked) {
    const applyPhases = args.only ?? MIGRATION_ONLY_PHASES;
    migrationPreview = applyMigrationPhases(
      migrationCtx,
      migrationPreview,
      applyPhases,
    );
  }
  if (migrationPreview) {
    if (phaseFilter.has("artifacts")) {
      phases.push(migrationPhaseToOrchestrator(migrationPreview.artifacts));
    }
    if (entityPhase) phases.push(entityPhase);
    if (phaseFilter.has("runtime")) {
      phases.push(migrationPhaseToOrchestrator(migrationPreview.runtime));
    }
    if (phaseFilter.has("cleanup")) {
      phases.push(migrationPhaseToOrchestrator(migrationPreview.cleanup));
    }
  }

  if (!migrationPreview && entityPhase) phases.push(entityPhase);
  if (lifecycleArgs && args.yes && !entityPreflightBlocked) {
    lifecycle = runLifecycleUpgrade({ ...lifecycleArgs, apply: true });
  }
  if (lifecycle) {
    phases.push(lifecyclePhase(lifecycle));
  }

  const summary = aggregateSummary(phases);
  const status = workflowStatus(summary);
  const appSummary = aggregateSummary(phases.filter((phase) => phase.name !== "lifecycle"));
  const appApplyBlocked = appSummary.blocked > 0 || appSummary.failed > 0;
  const mode = args.yes ? "apply" : "plan";
  const lifecycleStatus = lifecycleStatusFromWorkflow(status, mode);
  const hasPending = summary.pending > 0;
  const commands = buildUpgradeCommands({
    project,
    installRoot: crossMajorMigration || crossMajorBoundary ? installRoot : null,
    channel,
    only: args.only,
    legacyCleanup: args.legacyCleanup,
    cwdDefault: true,
  });

  return {
    schemaVersion: UPGRADE_PREVIEW_SCHEMA,
    mode,
    status,
    lifecycleStatus,
    channel,
    install,
    upgradeOutcome,
    crossMajorBoundary,
    project,
    appHome: installRoot,
    home,
    phases,
    lifecycle,
    summary,
    dryRunCommand: appApplyBlocked || !hasPending ? null : commands.dryRunCommand,
    applyCommand: appApplyBlocked || !hasPending ? null : commands.applyCommand,
  };
}

export function validateUpgradeApply(args: UpgradeOrchestratorArgs, plan: UpgradePlanV2): string | null {
  if (args.yes && args.dryRun) {
    return "--yes and --dry-run are mutually exclusive";
  }
  if (!args.yes) {
    return null;
  }
  if (plan.crossMajorBoundary && args.only && args.only.length > 0) {
    return "cross-major v2→v3 apply must run as one full upgrade --yes; --only is preview-only at this boundary";
  }
  if (isBlockedUpgradeOutcome(plan.upgradeOutcome)) {
    return plan.upgradeOutcome.message ?? "upgrade blocked";
  }
  const appPhases = plan.phases.filter((phase) => phase.name !== "lifecycle");
  const entityImportPending = appPhases.some((phase) => phase.name === "entities" && phase.items.some((item) => item.action === "entity-cutover" && item.status === "pending"));
  const applyBlockingPhases = entityImportPending
    ? appPhases.filter((phase) => ["detect", "artifacts", "entities"].includes(phase.name))
    : appPhases;
  if (applyBlockingPhases.some((phase) => phase.summary.blocked > 0 || phase.summary.failed > 0)) {
    return applyBlockingPhases.flatMap((phase) => phase.items).find((item) => item.status === "blocked" || item.status === "failed")?.message
      ?? "upgrade preflight is blocked; no changes were applied";
  }
  if (
    plan.crossMajorBoundary &&
    !shouldIncludeCrossMajorPlanItems(plan.channel, plan.upgradeOutcome)
  ) {
    return (
      "cross-major v2→v3 migration requires the development channel while stable tracks 2.x; " +
      "run the same command with --dry-run on --channel development, then apply with --yes"
    );
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
    lines.push(`running: ${plan.upgradeOutcome.runningVersion}; latest on channel: ${plan.upgradeOutcome.latestOnChannel}`);
    if (plan.upgradeOutcome.migrationTargetVersion) {
      lines.push(`migration target: ${plan.upgradeOutcome.migrationTargetVersion}`);
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
  if (plan.lifecycle) {
    lines.push("");
    lines.push("native Agentera resource cleanup:");
    lines.push(`  ownership journal: ${plan.lifecycle.ownershipJournal.state} at ${plan.lifecycle.ownershipJournal.path}`);
    lines.push(`  secure publication: ${plan.lifecycle.platform.securePublication ? "available" : "unavailable"} (${plan.lifecycle.platform.requirement})`);
    lines.push(
      `  scope: ownership-proven native Agentera resource ${plan.lifecycle.nativeResourceCleanup.resourceId}; unrelated user-owned data excluded`,
    );
    const cleanup = plan.lifecycle.cleanupSummary;
    lines.push(
      `  counts: pending=${cleanup.pending}, applied=${cleanup.applied}, noop=${cleanup.noop}, blocked=${cleanup.blocked_unowned + cleanup.action_required}`,
    );
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
