import { resolvePath } from "../core/paths.js";
import { isNpxBundleRoot } from "../core/sourceRoot.js";
import {
  APP_MIGRATION_NEEDED,
  APP_MANUAL_REVIEW_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
} from "./doctor.js";
import { resolveNpxPlatformStatus } from "./npxPlatformStatus.js";
import { classifyInstall, crossMajorBoundaryApplies, type InstallClassification } from "./compatibility.js";
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
import { buildUpgradeCommands } from "./upgradeCommands.js";
import {
  classifyIntegrationScenario,
  integrationScenarioMessage,
  integrationExit,
  integrationPhase,
  type IntegrationExit,
  type IntegrationPhaseSummary,
  type IntegrationRetry,
  type IntegrationScenarioFacts,
} from "./projectIntegrationDecision.js";
import {
  classifyUpgradeOutcome,
  parseSemverMajor,
  resolveRunningVersion,
  shouldIncludeCrossMajorPlanItems,
} from "./versionResolution.js";

const MAJOR_BOUNDARY_BLOCK_MESSAGE_PREFIX =
  "v3 successor line is not announced yet; v2 managed app files remain current on the";

function majorBoundaryBlockMessage(channelName: string): string {
  const label = channelName.trim() || "current";
  return `${MAJOR_BOUNDARY_BLOCK_MESSAGE_PREFIX} ${label} channel`;
}

export interface ProjectIntegrationArgs {
  project: string;
  sourceRoot: string;
  home: string;
  env?: Record<string, string | undefined>;
  installRoot: string;
  bundleStatus: string;
  crossMajorBoundary?: boolean;
  /** When set, overrides cross-major detection (avoids false ?? short-circuit on announced=false). */
  crossMajorBoundaryDetected?: boolean;
  /** CLI `--channel` override; otherwise resolved from env/config/bundle authority. */
  channel?: string | null;
  /** Channel already resolved by an enclosing status collection. */
  resolvedChannel?: ResolvedUpdateChannel;
  /** App classification already observed by an enclosing doctor status. */
  installClassification?: InstallClassification;
  /** Successor gate already observed by an enclosing doctor status. */
  successorAnnounced?: boolean;
  /** V1 artifact scan already performed by an enclosing orientation collection. */
  precomputedV1Artifacts?: readonly string[];
  /** App retry command from doctor; retained separately from lifecycle guidance. */
  retryCommand?: string | null;
}

export interface ProjectIntegrationSummary {
  recommendation: "stay" | "upgrade";
  message: string;
  pending_artifacts: number;
  dry_run_command: string | null;
  apply_command: string | null;
  update_channel: string;
  major_boundary_block?: string | null;
  phases: {
    app: IntegrationPhaseSummary;
  };
  aggregate_status: "stay" | "upgrade" | "blocked";
  exit: IntegrationExit;
  retry: IntegrationRetry;
}

function isPendingRuntimeMigrationItem(item: MigrationPhaseItem): boolean {
  if (item.status !== "pending" || item.action === "configure") {
    return false;
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
  return true;
}

function isGlobalStaleRuntimeItem(item: MigrationPhaseItem, ctx: MigrationContext): boolean {
  const homeRoot = resolvePath(ctx.home);
  if (!item.source?.startsWith(homeRoot)) {
    return false;
  }
  if (item.action === "rewire-runtime" || item.action === "retire-hooks") {
    return true;
  }
  return false;
}

export function pendingRuntimeMigrationItems(
  ctx: MigrationContext,
  resolvedChannel?: ResolvedUpdateChannel,
): MigrationPhaseItem[] {
  const phase = planRuntimeRewirePhase(ctx, resolvedChannel);
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
  crossMajorBoundaryDetected: boolean;
} {
  if (!isNpxBundleRoot(args.sourceRoot)) {
    return {
      installRoot: args.installRoot,
      bundleStatus: args.bundleStatus,
      crossMajorBoundary: args.crossMajorBoundary ?? false,
      crossMajorBoundaryDetected: args.crossMajorBoundaryDetected ?? false,
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
    crossMajorBoundaryDetected: Boolean(platformStatus.crossMajorBoundaryDetected),
  };
}

function commandChannel(
  args: ProjectIntegrationArgs,
  channel: ResolvedUpdateChannel,
  crossMajor: boolean,
  upgradeOutcome: ReturnType<typeof classifyUpgradeOutcome> | null,
): ResolvedUpdateChannel {
  if (crossMajor && upgradeOutcome && !shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome)) {
    return resolveInvokedUpdateChannel({
      channel: "development",
      env: args.env,
      home: args.home,
      sourceRoot: args.sourceRoot,
    });
  }
  return channel;
}

function appPhaseBlockers(
  bundleStatus: string,
  majorBoundaryBlock: string | null,
): string[] {
  const blockers: string[] = [];
  if (bundleStatus === APP_MANUAL_REVIEW_NEEDED) {
    blockers.push("app: manual review is required before choosing an app write path");
  }
  if (majorBoundaryBlock) blockers.push(`app: ${majorBoundaryBlock}`);
  return blockers;
}

function retryGuidance(exit: IntegrationExit): string {
  switch (exit.meaning) {
    case "no_changes_needed":
      return "No retry is needed; project integration is converged.";
    case "preview_required":
      return "Apply the approved preview, then retry Agentera to re-observe project integration.";
    case "preview_and_blockers":
      return "Resolve the reported blockers, apply the approved preview, then retry Agentera.";
    case "manual_review_required":
      return "Complete the manual review, then retry Agentera to re-observe project integration.";
  }
}

export function summarizeProjectIntegration(args: ProjectIntegrationArgs): ProjectIntegrationSummary {
  const channel = args.resolvedChannel ?? resolveInvokedUpdateChannel({
    channel: args.channel ?? null,
    env: args.env,
    home: args.home,
    sourceRoot: args.sourceRoot,
  });
  const integrationTargets = resolveIntegrationTargets(args);
  const install = args.installClassification ?? classifyInstall({ appHome: integrationTargets.installRoot, sourceRoot: args.sourceRoot });
  const crossMajorDetected =
    args.crossMajorBoundaryDetected ??
    crossMajorBoundaryApplies(install, args.sourceRoot);
  const successorAnnounced = args.successorAnnounced ?? isStableSuccessorAnnounced(args.sourceRoot, "stable");
  const crossMajor = crossMajorDetected && successorAnnounced;
  const runningMajor = crossMajorDetected
    ? parseSemverMajor(
        resolveRunningVersion({
          appHome: integrationTargets.installRoot,
          sourceRoot: args.sourceRoot,
          install,
        }),
      ) ?? 0
    : 0;
  const majorBoundaryBlock =
    crossMajorDetected && !successorAnnounced && runningMajor > 0 && runningMajor < 3
      ? majorBoundaryBlockMessage(channel.channel)
      : null;
  const upgradeOutcome = crossMajor
    ? classifyUpgradeOutcome({
        appHome: integrationTargets.installRoot,
        sourceRoot: args.sourceRoot,
        install,
        channel,
      })
    : null;
  const v1Artifacts = args.precomputedV1Artifacts ?? detectV1ArtifactPairs(args.project);
  const pendingProjectMigration = pendingRuntimeMigrationItems({
    appHome: integrationTargets.installRoot,
    project: args.project,
    home: args.home,
    force: false,
    sourceRoot: args.sourceRoot,
    channel: args.channel ?? null,
    env: args.env,
  }, channel);
  const crossMajorMigration =
    crossMajor && upgradeOutcome !== null && shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome);
  const isNpx = isNpxBundleRoot(args.sourceRoot);
  const classificationBundleStatus =
    isNpx && integrationTargets.platformBundleStatus !== undefined
      ? integrationTargets.platformBundleStatus
      : integrationTargets.bundleStatus;
  const needsAppUpgrade =
    isNpx && integrationTargets.bundleStatus === APP_UP_TO_DATE
      ? appNeedsUpgrade(integrationTargets.platformBundleStatus ?? APP_UP_TO_DATE)
      : appNeedsUpgrade(classificationBundleStatus);

  const appPending =
    v1Artifacts.length +
    pendingProjectMigration.length +
    (needsAppUpgrade ? 1 : 0) +
    (crossMajorMigration ? 1 : 0);
  const appBlockers = appPhaseBlockers(classificationBundleStatus, majorBoundaryBlock);
  const appPhase = integrationPhase({
    total: appPending + appBlockers.length,
    pending: appPending,
    blocked: appBlockers.length,
    blockers: appBlockers,
  });
  const hasUpgradeWork = appPending > 0;
  const hasBlockers = appBlockers.length > 0;
  const aggregateStatus: ProjectIntegrationSummary["aggregate_status"] = hasUpgradeWork
    ? "upgrade"
    : hasBlockers
      ? "blocked"
      : "stay";
  const scenarioFacts: IntegrationScenarioFacts = {
    bundleStatus: classificationBundleStatus,
    pendingArtifactCount: v1Artifacts.length + pendingProjectMigration.length,
    crossMajor,
    crossMajorMigration,
    crossMajorNeedsPreview: Boolean(majorBoundaryBlock) || (crossMajor && !crossMajorMigration),
    needsAppUpgrade,
  };
  const scenario = classifyIntegrationScenario(scenarioFacts);
  const guidanceMessage = appBlockers.length > 0
    ? appBlockers.join("; ")
    : hasUpgradeWork
      ? "Preview the app or project-state upgrade, then apply the approved command."
      : "No app or project-state upgrade is required.";
  const exit = integrationExit(hasUpgradeWork, appBlockers.length > 0);

  const cmdsChannel = commandChannel(args, channel, crossMajor, upgradeOutcome);
  const cmds = hasUpgradeWork
    ? buildUpgradeCommands({
        project: args.project,
        installRoot: null,
        channel: cmdsChannel,
        only: null,
        cwdDefault: true,
      })
    : null;
  const message = hasUpgradeWork
    ? `${integrationScenarioMessage(scenario, scenarioFacts)} ${guidanceMessage}`
    : guidanceMessage;

  return {
    recommendation: aggregateStatus === "upgrade" ? "upgrade" : "stay",
    message,
    pending_artifacts: v1Artifacts.length + pendingProjectMigration.length,
    dry_run_command: cmds?.dryRunCommand ?? null,
    apply_command: cmds?.applyCommand ?? null,
    update_channel: hasUpgradeWork ? cmdsChannel.channel : channel.channel,
    major_boundary_block: majorBoundaryBlock,
    phases: {
      app: appPhase,
    },
    aggregate_status: aggregateStatus,
    exit,
    retry: {
      command: args.retryCommand ?? null,
      guidance: retryGuidance(exit),
    },
  };
}

export function projectIntegrationAttention(summary: ProjectIntegrationSummary): string | null {
  if (summary.recommendation === "stay" && summary.aggregate_status === "stay") {
    return null;
  }
  const preview = summary.dry_run_command ? `\`${summary.dry_run_command}\`` : "the preview command";
  const prefix =
    summary.pending_artifacts > 0
      ? "normal"
      : "degraded";
  const previewText = summary.dry_run_command ? ` Preview ${preview}.` : "";
  return `${prefix}: ${summary.message}${previewText}`;
}
