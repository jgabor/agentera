import { expanduser, isFile, resolvePath } from "../core/paths.js";
import { isNpxBundleRoot } from "../core/sourceRoot.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
} from "./doctor.js";
import { resolveNpxPlatformStatus } from "./npxPlatformStatus.js";
import { classifyInstall, crossMajorBoundaryApplies } from "./compatibility.js";
import { resolveInvokedUpdateChannel, type ResolvedUpdateChannel } from "./channels.js";
import fs from "node:fs";

import {
  detectV1ArtifactPairs,
  planRuntimeRewirePhase,
  type MigrationContext,
  type MigrationPhaseItem,
} from "./migrateArtifactsV2ToV3.js";
import {
  projectHasProjectLevelRuntimeHooks,
  textUsesPythonManagedEntrypoint,
} from "./runtimeMigration.js";
import { isStableSuccessorAnnounced } from "./nextMajorDoctor.js";
import { buildUpgradeCommands, type UpgradeOnlyPhase } from "./upgradeCommands.js";
import {
  classifyIntegrationScenario,
  integrationScenarioMessage,
  integrationScenarioNeedsInstallRoot,
  integrationScenarioOnlyPhases,
  integrationScenarioRecommendation,
} from "./projectIntegrationDecision.js";
import {
  classifyUpgradeOutcome,
  shouldIncludeCrossMajorPlanItems,
} from "./versionResolution.js";

const MAJOR_BOUNDARY_BLOCK_MESSAGE =
  "v3 successor line is not announced yet; v2 managed app files remain current on the stable channel";

export interface ProjectIntegrationArgs {
  project: string;
  sourceRoot: string;
  home: string;
  env?: Record<string, string | undefined>;
  installRoot: string;
  bundleStatus: string;
  crossMajorBoundary?: boolean;
  /** CLI `--channel` override; otherwise resolved from env/config/bundle authority. */
  channel?: string | null;
}

export interface ProjectIntegrationSummary {
  recommendation: "stay" | "upgrade";
  message: string;
  pending_runtime: number;
  pending_runtimes: string[];
  pending_artifacts: number;
  dry_run_command: string | null;
  apply_command: string | null;
  update_channel: string;
  upgrade_only?: readonly UpgradeOnlyPhase[];
  major_boundary_block?: string | null;
}

function migrationContext(args: ProjectIntegrationArgs, channel: ResolvedUpdateChannel): MigrationContext {
  const home = resolvePath(expanduser(args.home));
  const env = { ...(args.env ?? process.env), HOME: home };
  return {
    appHome: args.installRoot,
    project: resolvePath(args.project),
    home,
    sourceRoot: args.sourceRoot,
    channel: args.channel ?? channel.channel,
    env,
  };
}

const RUNTIME_MIGRATION_ACTIONS = new Set([
  "rewire-runtime",
  "retire-hooks",
  "copy-plugin",
  "copy-agent",
  "copy-command",
  "link-skill",
]);

function isPendingRuntimeMigrationItem(item: MigrationPhaseItem): boolean {
  if (item.status !== "pending" || item.action === "configure") {
    return false;
  }
  if (item.action === "retire-hooks") {
    return true;
  }
  if (item.action === "rewire-runtime") {
    if (!item.source) {
      return false;
    }
    try {
      return textUsesPythonManagedEntrypoint(fs.readFileSync(item.source, "utf8"));
    } catch {
      return false;
    }
  }
  return RUNTIME_MIGRATION_ACTIONS.has(item.action);
}

function isPythonManagedRewireItem(item: MigrationPhaseItem): boolean {
  if (item.action === "retire-hooks") {
    return item.status === "pending";
  }
  if (item.action !== "rewire-runtime" || item.status !== "pending" || !item.source) {
    return false;
  }
  try {
    return textUsesPythonManagedEntrypoint(fs.readFileSync(item.source, "utf8"));
  } catch {
    return false;
  }
}

function isGlobalStaleRuntimeItem(item: MigrationPhaseItem, ctx: MigrationContext): boolean {
  const homeRoot = resolvePath(ctx.home);
  if (!item.source?.startsWith(homeRoot)) {
    return false;
  }
  if (item.action === "rewire-runtime" || item.action === "retire-hooks") {
    return true;
  }
  if (item.action === "copy-plugin" && item.target) {
    try {
      if (isFile(item.target)) {
        return textUsesPythonManagedEntrypoint(fs.readFileSync(item.target, "utf8"));
      }
      return item.source ? textUsesPythonManagedEntrypoint(fs.readFileSync(item.source, "utf8")) : false;
    } catch {
      return false;
    }
  }
  return false;
}

export function pendingRuntimeMigrationItems(ctx: MigrationContext): MigrationPhaseItem[] {
  const phase = planRuntimeRewirePhase(ctx);
  const projectRoot = resolvePath(ctx.project);
  const hasProjectHooks = projectHasProjectLevelRuntimeHooks(ctx.project);
  return phase.items.filter((item) => {
    if (item.status !== "pending" || item.action === "configure") {
      return false;
    }
    if (hasProjectHooks) {
      return (item.source?.startsWith(projectRoot) ?? false) && isPendingRuntimeMigrationItem(item);
    }
    return isGlobalStaleRuntimeItem(item, ctx);
  });
}

/** True when runtime hooks/config still need npm self-contained rewiring. */
export function projectHasPendingRuntimeRewire(ctx: MigrationContext): boolean {
  const phase = planRuntimeRewirePhase(ctx);
  return phase.items.some((item) => isPythonManagedRewireItem(item));
}

function appNeedsUpgrade(bundleStatus: string): boolean {
  return (
    bundleStatus === APP_OUTDATED ||
    bundleStatus === APP_REPAIR_NEEDED ||
    bundleStatus === APP_MIGRATION_NEEDED
  );
}

function resolveIntegrationTargets(args: ProjectIntegrationArgs): {
  installRoot: string;
  bundleStatus: string;
  platformBundleStatus?: string;
  crossMajorBoundary: boolean;
} {
  if (!isNpxBundleRoot(args.sourceRoot)) {
    return {
      installRoot: args.installRoot,
      bundleStatus: args.bundleStatus,
      crossMajorBoundary: args.crossMajorBoundary ?? false,
    };
  }
  const { platformRoot, platformStatus } = resolveNpxPlatformStatus({
    home: args.home,
    sourceRoot: args.sourceRoot,
    project: args.project,
    env: args.env,
  });
  return {
    installRoot: platformRoot,
    bundleStatus: args.bundleStatus,
    platformBundleStatus: platformStatus.status,
    crossMajorBoundary: Boolean(platformStatus.crossMajorBoundary),
  };
}

function commandChannel(
  args: ProjectIntegrationArgs,
  channel: ResolvedUpdateChannel,
  crossMajor: boolean,
  upgradeOutcome: ReturnType<typeof classifyUpgradeOutcome>,
): ResolvedUpdateChannel {
  if (crossMajor && !shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome)) {
    return resolveInvokedUpdateChannel({
      channel: "development",
      env: args.env,
      home: args.home,
      sourceRoot: args.sourceRoot,
    });
  }
  return channel;
}

export function summarizeProjectIntegration(args: ProjectIntegrationArgs): ProjectIntegrationSummary {
  const channel = resolveInvokedUpdateChannel({
    channel: args.channel ?? null,
    env: args.env,
    home: args.home,
    sourceRoot: args.sourceRoot,
  });
  const integrationTargets = resolveIntegrationTargets(args);
  const install = classifyInstall({ appHome: integrationTargets.installRoot, sourceRoot: args.sourceRoot });
  const crossMajorDetected =
    args.crossMajorBoundary ??
    integrationTargets.crossMajorBoundary ??
    crossMajorBoundaryApplies(install, args.sourceRoot);
  const successorAnnounced = isStableSuccessorAnnounced(args.sourceRoot);
  const crossMajor = crossMajorDetected && successorAnnounced;
  if (crossMajorBoundaryApplies(install, args.sourceRoot) && !successorAnnounced) {
    return {
      recommendation: "stay",
      message: MAJOR_BOUNDARY_BLOCK_MESSAGE,
      pending_runtime: 0,
      pending_runtimes: [],
      pending_artifacts: 0,
      dry_run_command: null,
      apply_command: null,
      update_channel: channel.channel,
      major_boundary_block: MAJOR_BOUNDARY_BLOCK_MESSAGE,
    };
  }
  const upgradeOutcome = classifyUpgradeOutcome({
    appHome: integrationTargets.installRoot,
    sourceRoot: args.sourceRoot,
    install,
    channel,
  });
  const ctx = migrationContext(
    { ...args, installRoot: integrationTargets.installRoot },
    channel,
  );
  const v1Artifacts = detectV1ArtifactPairs(args.project);
  const pending = pendingRuntimeMigrationItems(ctx);
  const pendingRuntimes = [
    ...new Set(pending.map((item) => item.runtime).filter((runtime): runtime is string => Boolean(runtime))),
  ];

  const crossMajorMigration =
    crossMajor && shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome);
  const crossMajorNeedsPreview = crossMajor && !crossMajorMigration;
  const isNpx = isNpxBundleRoot(args.sourceRoot);
  const classificationBundleStatus =
    isNpx && integrationTargets.platformBundleStatus !== undefined
      ? integrationTargets.platformBundleStatus
      : integrationTargets.bundleStatus;
  const needsAppUpgrade =
    isNpx && integrationTargets.bundleStatus === APP_UP_TO_DATE
      ? appNeedsUpgrade(integrationTargets.platformBundleStatus ?? APP_UP_TO_DATE) &&
        pending.length === 0 &&
        v1Artifacts.length === 0
      : appNeedsUpgrade(classificationBundleStatus);

  const scenario = classifyIntegrationScenario({
    bundleStatus: classificationBundleStatus,
    pendingRuntimeCount: pending.length,
    pendingArtifactCount: v1Artifacts.length,
    crossMajor,
    crossMajorMigration,
    crossMajorNeedsPreview,
    needsAppUpgrade,
  });
  const recommendation = integrationScenarioRecommendation(scenario);
  const message = integrationScenarioMessage(scenario, {
    projectLevelRuntimeHooks: projectHasProjectLevelRuntimeHooks(args.project),
    pendingRuntimes,
  });

  if (recommendation === "stay") {
    return {
      recommendation: "stay",
      message,
      pending_runtime: 0,
      pending_runtimes: [],
      pending_artifacts: 0,
      dry_run_command: null,
      apply_command: null,
      update_channel: channel.channel,
      major_boundary_block: null,
    };
  }

  const cmdsChannel = commandChannel(args, channel, crossMajor, upgradeOutcome);
  const onlyPhases = integrationScenarioOnlyPhases(scenario);
  const installRootForCommands = integrationScenarioNeedsInstallRoot(scenario)
    ? integrationTargets.installRoot
    : null;
  const cmds = buildUpgradeCommands({
    project: args.project,
    installRoot: installRootForCommands,
    channel: cmdsChannel,
    only: onlyPhases,
    cwdDefault: true,
  });

  return {
    recommendation: "upgrade",
    message,
    pending_runtime: pending.length,
    pending_runtimes: pendingRuntimes,
    pending_artifacts: v1Artifacts.length,
    dry_run_command: cmds.dryRunCommand,
    apply_command: cmds.applyCommand,
    update_channel: cmdsChannel.channel,
    upgrade_only: onlyPhases,
    major_boundary_block: null,
  };
}

export function projectIntegrationAttention(summary: ProjectIntegrationSummary): string | null {
  if (summary.recommendation === "stay") {
    return null;
  }
  const preview = summary.dry_run_command ? `\`${summary.dry_run_command}\`` : "the preview command";
  const prefix =
    summary.pending_artifacts > 0 ||
    (summary.pending_runtime > 0 && summary.upgrade_only?.includes("runtime"))
      ? "normal"
      : "degraded";
  return `${prefix}: ${summary.message} Preview ${preview}.`;
}
