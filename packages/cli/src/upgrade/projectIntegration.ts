import { expanduser, isFile, resolvePath } from "../core/paths.js";
import { isNpxBundleRoot } from "../core/sourceRoot.js";
import {
  APP_MIGRATION_NEEDED,
  APP_MANUAL_REVIEW_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
} from "./doctor.js";
import { doctorRoots } from "./appModel.js";
import { resolveNpxPlatformStatus } from "./npxPlatformStatus.js";
import { classifyInstall, crossMajorBoundaryApplies } from "./compatibility.js";
import { resolveInvokedUpdateChannel, type ResolvedUpdateChannel } from "./channels.js";
import fs from "node:fs";
import path from "node:path";

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
  integrationExit,
  integrationGuidance,
  integrationPhase,
  lifecycleIntegrationPhase,
  type IntegrationExit,
  type IntegrationGuidance,
  type IntegrationPhaseSummary,
  type IntegrationRetry,
  type LifecycleIntegrationFacts,
  type IntegrationScenarioFacts,
} from "./projectIntegrationDecision.js";
import {
  classifyUpgradeOutcome,
  parseSemverMajor,
  resolveRunningVersion,
  shouldIncludeCrossMajorPlanItems,
} from "./versionResolution.js";
import {
  lifecycleOwnershipJournalPath,
  readLifecycleOwnershipJournal,
} from "../runtime/lifecycleOwnershipJournal.js";
import {
  observeRuntimeLifecycle,
  type RuntimeLifecycleSnapshot,
} from "../runtime/lifecycleSnapshot.js";

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
  /** Canonical lifecycle projection; callers should reuse one observation across consumers. */
  lifecycleSnapshot?: RuntimeLifecycleSnapshot;
  /** App retry command from doctor; retained separately from lifecycle guidance. */
  retryCommand?: string | null;
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
  phases: {
    app: IntegrationPhaseSummary;
    lifecycle: IntegrationPhaseSummary;
  };
  aggregate_status: "stay" | "upgrade" | "blocked";
  guidance: IntegrationGuidance;
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

/** Observe the canonical lifecycle projection used by project integration. */
export function observeProjectIntegrationLifecycle(
  args: ProjectIntegrationArgs,
  installRoot?: string,
): RuntimeLifecycleSnapshot {
  const lifecycleInstallRoot = isNpxBundleRoot(args.sourceRoot)
    ? resolveIntegrationTargets(args).installRoot
    : installRoot ?? resolveIntegrationTargets(args).installRoot;
  const ownership = readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(lifecycleInstallRoot));
  const canonicalSkillTarget = path.join(
    isNpxBundleRoot(args.sourceRoot)
      ? args.sourceRoot
      : doctorRoots(lifecycleInstallRoot).activeBundleRoot,
    "skills",
    "agentera",
  );
  return observeRuntimeLifecycle({
    home: resolvePath(expanduser(args.home)),
    project: resolvePath(args.project),
    sourceRoot: args.sourceRoot,
    env: { ...(args.env ?? process.env), HOME: resolvePath(expanduser(args.home)) },
    ledger: ownership.ledger,
    canonicalSkillTarget,
  });
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

function lifecycleIntegrationFacts(snapshot: RuntimeLifecycleSnapshot): LifecycleIntegrationFacts {
  const actions = snapshot.actions;
  const isHostAction = (action: RuntimeLifecycleSnapshot["actions"][number]): boolean =>
    action.actionClass === "manual_verification" &&
    action.ownership === "user_owned" &&
    action.manual?.command !== null &&
    action.manual?.command !== undefined;
  const isManualReview = (action: RuntimeLifecycleSnapshot["actions"][number]): boolean =>
    action.actionClass === "manual_verification" && !isHostAction(action);
  const runtimesFor = (predicate: (action: RuntimeLifecycleSnapshot["actions"][number]) => boolean) =>
    [...new Set(actions.filter(predicate).flatMap((action) => action.runtimeIds))].sort();
  const pendingOwnedRuntimes = runtimesFor((action) => action.actionClass === "repairable_owned");
  const hostActionRuntimes = runtimesFor(isHostAction);
  const manualReviewRuntimes = runtimesFor(isManualReview);
  const doctorRuntimes = runtimesFor((action) => action.actionClass === "unobservable_gap");
  const blockers = [
    ...new Set(
      [
        ...snapshot.runtimes.flatMap((runtime) =>
          runtime.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`),
        ),
        ...actions
          .filter((action) => action.actionClass !== "repairable_owned")
          .map((action) => `${action.actionClass}: ${action.reason}`),
      ],
    ),
  ];
  return {
    pendingOwnedCount: actions.filter((action) => action.actionClass === "repairable_owned").length,
    pendingOwnedRuntimes,
    manualReviewCount: actions.filter(isManualReview).length,
    manualReviewRuntimes,
    hostActionCount: actions.filter(isHostAction).length,
    hostActionRuntimes,
    doctorCount: actions.filter((action) => action.actionClass === "unobservable_gap").length,
    doctorRuntimes,
    blockers,
  };
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
    case "host_action_required":
      return "Run the user-owned host action, then retry Agentera to re-observe the runtime.";
    case "doctor_diagnostics_required":
      return "Run Agentera doctor diagnostics, then retry Agentera after the gap is observable.";
    case "manual_review_required":
      return "Complete the manual review, then retry Agentera to re-observe project integration.";
  }
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
    args.crossMajorBoundaryDetected ??
    crossMajorBoundaryApplies(install, args.sourceRoot);
  const successorAnnounced = isStableSuccessorAnnounced(args.sourceRoot, "stable");
  const crossMajor = crossMajorDetected && successorAnnounced;
  const runningMajor =
    parseSemverMajor(
      resolveRunningVersion({
        appHome: integrationTargets.installRoot,
        sourceRoot: args.sourceRoot,
        install,
      }),
    ) ?? 0;
  const majorBoundaryBlock =
    crossMajorDetected && !successorAnnounced && runningMajor > 0 && runningMajor < 3
      ? majorBoundaryBlockMessage(channel.channel)
      : null;
  const upgradeOutcome = classifyUpgradeOutcome({
    appHome: integrationTargets.installRoot,
    sourceRoot: args.sourceRoot,
    install,
    channel,
  });
  const v1Artifacts = detectV1ArtifactPairs(args.project);
  const lifecycleSnapshot =
    args.lifecycleSnapshot ?? observeProjectIntegrationLifecycle(args, integrationTargets.installRoot);
  const lifecycle = lifecycleIntegrationFacts(lifecycleSnapshot);

  const crossMajorMigration =
    crossMajor && shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome);
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
    (needsAppUpgrade ? 1 : 0) +
    (crossMajorMigration ? 1 : 0);
  const appBlockers = appPhaseBlockers(classificationBundleStatus, majorBoundaryBlock);
  const appPhase = integrationPhase({
    total: appPending + appBlockers.length,
    pending: appPending,
    blocked: appBlockers.length,
    blockers: appBlockers,
  });
  const lifecyclePhase = lifecycleIntegrationPhase(lifecycle);
  const hasUpgradeWork = appPending > 0 || lifecycle.pendingOwnedCount > 0;
  const hasBlockers = appBlockers.length > 0 || lifecyclePhase.counts.blocked > 0;
  const aggregateStatus: ProjectIntegrationSummary["aggregate_status"] = hasUpgradeWork
    ? "upgrade"
    : hasBlockers
      ? "blocked"
      : "stay";
  const scenarioFacts: IntegrationScenarioFacts = {
    bundleStatus: classificationBundleStatus,
    pendingRuntimeCount: lifecycle.pendingOwnedCount,
    pendingArtifactCount: v1Artifacts.length,
    crossMajor,
    crossMajorMigration,
    crossMajorNeedsPreview: Boolean(majorBoundaryBlock) || (crossMajor && !crossMajorMigration),
    needsAppUpgrade,
  };
  const scenario = classifyIntegrationScenario(scenarioFacts);
  const pendingRuntimes = lifecycle.pendingOwnedRuntimes;
  const runtimeSelector =
    pendingRuntimes.length === 1 ? pendingRuntimes[0] : pendingRuntimes.length > 1 ? "all" : null;
  const guidance = integrationGuidance(lifecycle, hasUpgradeWork);
  if (!hasUpgradeWork && appBlockers.length > 0 && guidance.runtimes.length === 0) {
    guidance.route = "manual_review";
    guidance.message = appBlockers.join("; ");
  }
  const exit = integrationExit(hasUpgradeWork, lifecycle, appBlockers.length > 0);

  const cmdsChannel = commandChannel(args, channel, crossMajor, upgradeOutcome);
  const cmds = hasUpgradeWork
    ? buildUpgradeCommands({
        project: args.project,
        installRoot: null,
        channel: cmdsChannel,
        only: null,
        runtime: runtimeSelector,
        cwdDefault: true,
      })
    : null;
  const message = hasUpgradeWork
    ? `${integrationScenarioMessage(scenario, scenarioFacts)} ${guidance.message}`
    : guidance.message;

  return {
    recommendation: aggregateStatus === "upgrade" ? "upgrade" : "stay",
    message,
    pending_runtime: pendingRuntimes.length,
    pending_runtimes: pendingRuntimes,
    pending_artifacts: v1Artifacts.length,
    dry_run_command: cmds?.dryRunCommand ?? null,
    apply_command: cmds?.applyCommand ?? null,
    update_channel: hasUpgradeWork ? cmdsChannel.channel : channel.channel,
    upgrade_only: undefined,
    major_boundary_block: majorBoundaryBlock,
    phases: {
      app: appPhase,
      lifecycle: lifecyclePhase,
    },
    aggregate_status: aggregateStatus,
    guidance,
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
    summary.pending_artifacts > 0 || summary.pending_runtime > 0
      ? "normal"
      : "degraded";
  const previewText = summary.dry_run_command ? ` Preview ${preview}.` : "";
  return `${prefix}: ${summary.message}${previewText}`;
}
