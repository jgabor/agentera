import { expanduser, resolvePath } from "../core/paths.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
} from "./doctor.js";
import { classifyInstall, crossMajorBoundaryApplies } from "./compatibility.js";
import { resolveUpdateChannel, type ResolvedUpdateChannel } from "./channels.js";
import fs from "node:fs";

import {
  planRuntimeRewirePhase,
  type MigrationContext,
  type MigrationPhaseItem,
} from "./migrateArtifactsV2ToV3.js";
import { textUsesPythonManagedEntrypoint } from "./runtimeMigration.js";
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

const RUNTIME_REWIRE_ACTIONS = new Set(["rewire-runtime", "retire-hooks"]);

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

export function pendingRuntimeMigrationItems(ctx: MigrationContext): MigrationPhaseItem[] {
  const phase = planRuntimeRewirePhase(ctx);
  return phase.items.filter(
    (item) => item.status === "pending" && RUNTIME_REWIRE_ACTIONS.has(item.action),
  );
}

/** True when the project still has Python-managed runtime hooks/config to rewire. */
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

function commandChannel(
  args: ProjectIntegrationArgs,
  channel: ResolvedUpdateChannel,
  crossMajor: boolean,
  upgradeOutcome: ReturnType<typeof classifyUpgradeOutcome>,
): ResolvedUpdateChannel {
  if (crossMajor && !shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome)) {
    return resolveUpdateChannel({
      channel: "development",
      env: args.env,
      home: args.home,
      sourceRoot: args.sourceRoot,
    });
  }
  return channel;
}

export function summarizeProjectIntegration(args: ProjectIntegrationArgs): ProjectIntegrationSummary {
  const channel = resolveUpdateChannel({
    channel: args.channel ?? null,
    env: args.env,
    home: args.home,
    sourceRoot: args.sourceRoot,
  });
  const install = classifyInstall({ appHome: args.installRoot, sourceRoot: args.sourceRoot });
  const crossMajor = args.crossMajorBoundary ?? crossMajorBoundaryApplies(install, args.sourceRoot);
  const upgradeOutcome = classifyUpgradeOutcome({
    appHome: args.installRoot,
    sourceRoot: args.sourceRoot,
    install,
    channel,
  });
  const ctx = migrationContext(args, channel);
  const pending = pendingRuntimeMigrationItems(ctx);
  const pendingRuntimes = [
    ...new Set(pending.map((item) => item.runtime).filter((runtime): runtime is string => Boolean(runtime))),
  ];

  const crossMajorMigration =
    crossMajor && shouldIncludeCrossMajorPlanItems(channel, upgradeOutcome);
  const crossMajorNeedsPreview = crossMajor && !crossMajorMigration;
  const needsAppUpgrade = appNeedsUpgrade(args.bundleStatus);
  const runtimeOnly =
    pending.length > 0 && !crossMajorMigration && !crossMajorNeedsPreview && !needsAppUpgrade;

  if (
    args.bundleStatus === APP_MANUAL_REVIEW_NEEDED &&
    pending.length === 0 &&
    !crossMajor
  ) {
    return {
      recommendation: "stay",
      message:
        "Agentera needs manual review for your app directory before this project can be upgraded safely.",
      pending_runtime: 0,
      pending_runtimes: [],
      dry_run_command: null,
      apply_command: null,
      update_channel: channel.channel,
    };
  }

  if (
    args.bundleStatus === APP_UP_TO_DATE &&
    pending.length === 0 &&
    !crossMajorMigration &&
    !crossMajorNeedsPreview
  ) {
    return {
      recommendation: "stay",
      message: "This project matches your current Agentera install; no upgrade is needed.",
      pending_runtime: 0,
      pending_runtimes: [],
      dry_run_command: null,
      apply_command: null,
      update_channel: channel.channel,
    };
  }

  const cmdsChannel = commandChannel(args, channel, crossMajor, upgradeOutcome);
  const onlyPhases: readonly UpgradeOnlyPhase[] | undefined = runtimeOnly ? ["runtime"] : undefined;
  const installRootForCommands =
    crossMajorMigration || crossMajorNeedsPreview || needsAppUpgrade ? args.installRoot : null;
  const cmds = buildUpgradeCommands({
    project: args.project,
    installRoot: installRootForCommands,
    channel: cmdsChannel,
    only: onlyPhases,
    cwdDefault: true,
  });

  let message: string;
  if (crossMajorMigration || crossMajorNeedsPreview) {
    message =
      "Your Agentera app copy is still on v2 while the CLI is on v3; preview the one-way v2→v3 migration before applying.";
  } else if (needsAppUpgrade) {
    message = "Your Agentera app copy is out of date; preview the repair or upgrade before applying.";
  } else if (pending.length > 0) {
    const runtimes = pendingRuntimes.length > 0 ? pendingRuntimes.join(", ") : "runtime configs";
    message = `This project still uses older Agentera runtime wiring (${runtimes}); preview rewiring hooks to the current npm entrypoint.`;
  } else {
    message = "Preview Agentera upgrade changes for this project before applying.";
  }

  return {
    recommendation: "upgrade",
    message,
    pending_runtime: pending.length,
    pending_runtimes: pendingRuntimes,
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
  const prefix = summary.pending_runtime > 0 && summary.upgrade_only?.includes("runtime") ? "normal" : "degraded";
  return `${prefix}: ${summary.message} Preview ${preview}.`;
}
