import { expanduser, isFile, resolvePath } from "../core/paths.js";
import { isNpxBundleRoot } from "../core/sourceRoot.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  buildDoctorStatus,
} from "./doctor.js";
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
import { resolvePlatformAppHome } from "./appModel.js";
import { buildUpgradeCommands, type UpgradeOnlyPhase } from "./upgradeCommands.js";
import {
  classifyUpgradeOutcome,
  shouldIncludeCrossMajorPlanItems,
} from "./versionResolution.js";

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
  crossMajorBoundary: boolean;
} {
  if (!isNpxBundleRoot(args.sourceRoot)) {
    return {
      installRoot: args.installRoot,
      bundleStatus: args.bundleStatus,
      crossMajorBoundary: args.crossMajorBoundary ?? false,
    };
  }
  const platformRoot = resolvePlatformAppHome(args.home, args.env);
  const platformStatus = buildDoctorStatus(platformRoot, {
    rootSource: "default",
    sourceRoot: args.sourceRoot,
    home: args.home,
    project: args.project,
    expectedCommands: ["prime"],
    probeCli: false,
    skipNpxBundleShortCircuit: true,
    env: args.env,
  });
  return {
    installRoot: platformRoot,
    bundleStatus: args.bundleStatus,
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
  const crossMajor =
    args.crossMajorBoundary ??
    integrationTargets.crossMajorBoundary ??
    crossMajorBoundaryApplies(install, args.sourceRoot);
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
  const needsAppUpgrade =
    isNpxBundleRoot(args.sourceRoot) && args.bundleStatus === APP_UP_TO_DATE
      ? false
      : appNeedsUpgrade(integrationTargets.bundleStatus);
  const artifactsOnly = v1Artifacts.length > 0 && !crossMajorMigration && !crossMajorNeedsPreview && !needsAppUpgrade;
  const runtimeOnly =
    pending.length > 0 &&
    !artifactsOnly &&
    !crossMajorMigration &&
    !crossMajorNeedsPreview &&
    !needsAppUpgrade;

  if (
    integrationTargets.bundleStatus === APP_MANUAL_REVIEW_NEEDED &&
    pending.length === 0 &&
    v1Artifacts.length === 0 &&
    !crossMajor
  ) {
    return {
      recommendation: "stay",
      message:
        "Agentera needs manual review for your app directory before this project can be upgraded safely.",
      pending_runtime: 0,
      pending_runtimes: [],
      pending_artifacts: 0,
      dry_run_command: null,
      apply_command: null,
      update_channel: channel.channel,
    };
  }

  if (
    !artifactsOnly &&
    !runtimeOnly &&
    !crossMajorMigration &&
    !crossMajorNeedsPreview &&
    !needsAppUpgrade &&
    integrationTargets.bundleStatus === APP_UP_TO_DATE &&
    pending.length === 0 &&
    v1Artifacts.length === 0
  ) {
    return {
      recommendation: "stay",
      message: "This project matches your current Agentera install; no upgrade is needed.",
      pending_runtime: 0,
      pending_runtimes: [],
      pending_artifacts: 0,
      dry_run_command: null,
      apply_command: null,
      update_channel: channel.channel,
    };
  }

  const cmdsChannel = commandChannel(args, channel, crossMajor, upgradeOutcome);
  const onlyPhases: readonly UpgradeOnlyPhase[] | undefined = artifactsOnly
    ? ["artifacts"]
    : runtimeOnly
      ? ["runtime"]
      : undefined;
  const installRootForCommands =
    crossMajorMigration || crossMajorNeedsPreview || needsAppUpgrade ? integrationTargets.installRoot : null;
  const cmds = buildUpgradeCommands({
    project: args.project,
    installRoot: installRootForCommands,
    channel: cmdsChannel,
    only: onlyPhases,
    cwdDefault: true,
  });

  let message: string;
  if (artifactsOnly) {
    message =
      "This project still uses v1 Markdown artifacts; preview migrating them to v2 YAML before continuing.";
  } else if (crossMajorMigration || crossMajorNeedsPreview) {
    message =
      "Your Agentera app copy is still on v2 while the CLI is on v3; preview the one-way v2→v3 migration before applying.";
  } else if (needsAppUpgrade) {
    message = "Your Agentera app copy is out of date; preview the repair or upgrade before applying.";
  } else if (pending.length > 0) {
    const runtimes = pendingRuntimes.length > 0 ? pendingRuntimes.join(", ") : "runtime configs";
    message = projectHasProjectLevelRuntimeHooks(args.project)
      ? `This project still uses older Agentera runtime wiring (${runtimes}); preview rewiring hooks to the current npm entrypoint.`
      : `Your user-level Agentera runtime wiring (${runtimes}) is stale; preview rewiring hooks to the current npm entrypoint.`;
  } else {
    message = "Preview Agentera upgrade changes for this project before applying.";
  }

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
