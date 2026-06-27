import fs from "node:fs";
import path from "node:path";

import { isNpxBundleRoot } from "../core/sourceRoot.js";
import { classifyResolvedRoot } from "../state/installRoot.js";
import { doctorRoots, loadSuiteVersion } from "./appModel.js";
import type { InstallClassification } from "./compatibility.js";
import { loadUpdateChannelsAuthority, type ResolvedUpdateChannel } from "./channels.js";
import { isStableSuccessorAnnounced } from "./nextMajorDoctor.js";

/**
 * Semver and channel upgrade gate.
 * Authority: references/cli/update-channels.yaml (version_resolution)
 */

export type UpgradeOutcomeKind =
  | "same_major_update"
  | "forward_major_upgrade"
  | "migration_to_latest_on_channel"
  | "channel_line_mismatch"
  | "blocked_downgrade_to_v2"
  | "blocked_downgrade_not_implemented"
  | "up_to_date";

export interface UpgradeOutcome {
  kind: UpgradeOutcomeKind;
  runningVersion: string;
  latestOnChannel: string;
  runningMajor: number;
  latestMajor: number;
  migrationTargetVersion: string | null;
  allowsMigrationApply: boolean;
  message: string | null;
}

export interface VersionCatalog {
  stable?: string;
  development?: string;
}

export const IRREVERSIBLE_V2_RETURN =
  "return to the v2 Python line is permanently unsupported after migrating to v3+";

let testVersionCatalog: VersionCatalog | null = null;

/** Reset injectable catalog (tests). */
export function setVersionCatalogForTests(catalog: VersionCatalog | null): void {
  testVersionCatalog = catalog;
}

export function parseSemverMajor(version: string): number | null {
  const match = /^(\d+)/.exec(version.trim());
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

function readRegistryVersion(root: string): string | null {
  const registryPath = path.join(root, "registry.json");
  if (!fs.existsSync(registryPath)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      skills?: Array<{ version?: string }>;
    };
    const version = data.skills?.[0]?.version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null;
  }
}

function readNpmPackageVersion(sourceRoot: string): string | null {
  const candidates = [
    path.join(sourceRoot, "package.json"),
    path.join(sourceRoot, "..", "package.json"),
    path.join(sourceRoot, "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string };
      if (typeof data.version === "string" && data.version) {
        return data.version;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveRunningVersion(args: {
  appHome: string;
  sourceRoot: string;
  install: InstallClassification;
}): string {
  void args.install;
  if (isNpxBundleRoot(args.sourceRoot)) {
    return readRegistryVersion(args.sourceRoot) ?? readNpmPackageVersion(args.sourceRoot) ?? "0.0.0";
  }
  const roots = doctorRoots(args.appHome);
  const expected = loadSuiteVersion(args.sourceRoot);
  const classification = classifyResolvedRoot(roots.activeBundleRoot, {
    source: "explicit",
    expectedVersion: expected,
  });
  if (classification.current_version) {
    return classification.current_version;
  }
  if (isNpxBundleRoot(args.sourceRoot)) {
    return readNpmPackageVersion(args.sourceRoot) ?? expected ?? "0.0.0";
  }
  return expected ?? "0.0.0";
}

export function loadOfflineLatestDefaults(sourceRoot: string): VersionCatalog {
  const authority = loadUpdateChannelsAuthority(sourceRoot);
  const versionResolution = authority.version_resolution as Record<string, unknown> | undefined;
  const latestOnChannel = versionResolution?.latest_on_channel as Record<string, unknown> | undefined;
  const defaults = latestOnChannel?.offline_defaults as Record<string, string> | undefined;
  return {
    stable: defaults?.stable ?? "2.7.7",
    development: defaults?.development ?? "3.0.0",
  };
}

export function resolveLatestOnChannel(
  channel: ResolvedUpdateChannel,
  sourceRoot: string,
  catalog?: VersionCatalog | null,
): string {
  const resolved = catalog ?? testVersionCatalog ?? loadOfflineLatestDefaults(sourceRoot);
  return channel.channel === "development"
    ? (resolved.development ?? "3.0.0")
    : (resolved.stable ?? "2.7.7");
}

export function classifyUpgradeOutcome(args: {
  appHome: string;
  sourceRoot: string;
  install: InstallClassification;
  channel: ResolvedUpdateChannel;
  catalog?: VersionCatalog | null;
}): UpgradeOutcome {
  const runningVersion = resolveRunningVersion(args);
  const latestOnChannel = resolveLatestOnChannel(args.channel, args.sourceRoot, args.catalog);
  const runningMajor = parseSemverMajor(runningVersion) ?? 0;
  const latestMajor = parseSemverMajor(latestOnChannel) ?? 0;

  if (args.install.kind === "v3_self_contained_npm") {
    const runningVersion = resolveRunningVersion(args);
    const runningMajor = parseSemverMajor(runningVersion) ?? 0;
    return {
      kind: "up_to_date",
      runningVersion,
      latestOnChannel: runningVersion,
      runningMajor,
      latestMajor: runningMajor,
      migrationTargetVersion: null,
      allowsMigrationApply: false,
      message: null,
    };
  }

  const base: Omit<UpgradeOutcome, "kind"> = {
    runningVersion,
    latestOnChannel,
    runningMajor,
    latestMajor,
    migrationTargetVersion: null,
    allowsMigrationApply: false,
    message: null,
  };

  if (runningMajor >= 3 && latestMajor <= 2) {
    return {
      ...base,
      kind: "blocked_downgrade_to_v2",
      message: IRREVERSIBLE_V2_RETURN,
    };
  }


  if (args.install.kind === "v2_managed_app_home") {
    if (args.channel.distributionMajor < 3) {
      return {
        ...base,
        kind: "up_to_date",
        message:
          "stable channel tracks the 2.x support line; switch to the development channel to preview v2→v3 migration",
      };
    }
    if (!isStableSuccessorAnnounced(args.sourceRoot, "stable")) {
      return {
        ...base,
        kind: "up_to_date",
        message:
          `v3 successor line is not announced yet; v2 managed app files remain current on the ${args.channel.channel} channel`,
      };
    }
    return {
      ...base,
      kind: "migration_to_latest_on_channel",
      migrationTargetVersion: latestOnChannel,
      allowsMigrationApply: true,
      message: `v2 managed app-home will migrate to ${latestOnChannel} on the ${args.channel.channel} channel`,
    };
  }

  if (
    runningMajor >= 3 &&
    runningMajor !== args.channel.distributionMajor &&
    args.channel.distributionMajor < runningMajor
  ) {
    return {
      ...base,
      kind: "channel_line_mismatch",
      message: `running ${runningVersion} on ${args.channel.channel} channel (latest ${latestOnChannel}); switch channel or align versions`,
    };
  }

  if (runningMajor < latestMajor) {
    return {
      ...base,
      kind: "forward_major_upgrade",
      migrationTargetVersion: latestOnChannel,
      allowsMigrationApply: true,
      message: `running ${runningVersion}; latest on ${args.channel.channel} channel is ${latestOnChannel}`,
    };
  }

  if (runningVersion === latestOnChannel) {
    return { ...base, kind: "up_to_date" };
  }

  return {
    ...base,
    kind: "same_major_update",
    message: `running ${runningVersion}; latest on channel is ${latestOnChannel}`,
  };
}

export function shouldIncludeCrossMajorPlanItems(
  channel: ResolvedUpdateChannel,
  outcome: UpgradeOutcome,
): boolean {
  return (
    outcome.kind === "migration_to_latest_on_channel" &&
    outcome.allowsMigrationApply &&
    channel.distributionMajor >= 3
  );
}

export function isBlockedUpgradeOutcome(outcome: UpgradeOutcome): boolean {
  return (
    outcome.kind === "blocked_downgrade_to_v2" ||
    outcome.kind === "blocked_downgrade_not_implemented"
  );
}
