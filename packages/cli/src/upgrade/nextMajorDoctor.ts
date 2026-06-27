import { cliDistributionMajor } from "./compatibility.js";
import {
  loadUpdateChannelsAuthority,
  resolveSelectedChannel,
  type UpdateChannelName,
} from "./channels.js";
import { resolveRunningVersion } from "./versionResolution.js";
import type { InstallClassification } from "./compatibility.js";

/**
 * Head-of-output "next major" doctor section.
 * Authority: references/cli/update-channels.yaml (channels.<channel>.next_major)
 */

export const NEXT_MAJOR_SECTION_HEADER = "Next major";
export const NEXT_MAJOR_LINE_CAP = 6;

export interface NextMajorBlock {
  concept: string;
  channel: UpdateChannelName;
  version: string;
  /** When false, doctor/prime omit successor-line upgrade prompts until republished. */
  announced: boolean;
  npmOnlyAdvisory: string;
  guideUrl: string;
  previewCommand: string;
  irreversibleAdvisory: string;
}

export interface NextMajorDoctorContext {
  sourceRoot: string;
  home: string;
  channel?: UpdateChannelName | null;
  runningVersion?: string | null;
  runningDistributionMajor?: number | null;
  install?: InstallClassification | null;
  env?: Record<string, string | undefined>;
}

/** v1 installs predate the channel authority; hardcoded stable-line successor mapping. */
export const V1_NEXT_MAJOR_FALLBACK: NextMajorBlock & { currentVersion: string; currentChannel: UpdateChannelName } = {
  concept: "forward_successor_line",
  currentVersion: "1.x",
  currentChannel: "stable",
  channel: "stable",
  version: "2.x",
  announced: true,
  npmOnlyAdvisory: "",
  guideUrl:
    "https://github.com/jgabor/agentera/blob/main/UPGRADE.md#recommended-upgrade-v1--v2-stable-channel",
  previewCommand: "npx -y agentera@latest upgrade --dry-run",
  irreversibleAdvisory:
    "Forward migration upgrades artifact format from Markdown to YAML; review the preview before applying.",
};

type Dict = Record<string, unknown>;

function parseNextMajorBlock(raw: unknown): NextMajorBlock | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const block = raw as Dict;
  const channel = String(block.channel ?? "").trim().toLowerCase();
  if (channel !== "stable" && channel !== "development") {
    return null;
  }
  const version = String(block.version ?? "").trim();
  if (!version) {
    return null;
  }
  const guideUrl = String(block.guide_url ?? "").trim();
  const previewCommand = String(block.preview_command ?? "").trim();
  const irreversibleAdvisory = String(block.irreversible_advisory ?? "").trim();
  if (!guideUrl || !previewCommand || !irreversibleAdvisory) {
    return null;
  }
  return {
    concept: String(block.concept ?? "forward_successor_line").trim(),
    channel: channel as UpdateChannelName,
    version,
    announced: block.announced !== false,
    npmOnlyAdvisory: String(block.npm_only_advisory ?? "").trim(),
    guideUrl,
    previewCommand,
    irreversibleAdvisory,
  };
}

let testSuccessorAnnouncedOverride: boolean | null = null;

/** Reset injectable successor announcement gate (tests). */
export function setSuccessorAnnouncedOverrideForTests(value: boolean | null): void {
  testSuccessorAnnouncedOverride = value;
}

/**
 * True when the resolved channel's successor metadata exists and is announced
 * for doctor/prime. Defaults to the stable channel so legacy callers that
 * omit the argument behave identically to pre-fix behavior.
 */
export function isStableSuccessorAnnounced(
  sourceRoot: string,
  channel: UpdateChannelName = "stable",
): boolean {
  if (testSuccessorAnnouncedOverride !== null) {
    return testSuccessorAnnouncedOverride;
  }
  const block = loadChannelNextMajor(sourceRoot, channel);
  return block?.announced === true;
}

export function loadChannelNextMajor(sourceRoot: string, channel: UpdateChannelName): NextMajorBlock | null {
  const authority = loadUpdateChannelsAuthority(sourceRoot);
  const channels = authority.channels as Dict | undefined;
  const entry = channels?.[channel];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return parseNextMajorBlock((entry as Dict).next_major);
}

export function formatNextMajorDoctorLines(args: {
  currentVersion: string;
  currentChannel: UpdateChannelName;
  block: NextMajorBlock;
}): string[] {
  const nextLine = args.block.npmOnlyAdvisory
    ? `Next: ${args.block.version} (${args.block.channel} channel). ${args.block.npmOnlyAdvisory}`
    : `Next: ${args.block.version} (${args.block.channel} channel)`;
  return [
    NEXT_MAJOR_SECTION_HEADER,
    `Current: ${args.currentVersion} (${args.currentChannel} channel)`,
    nextLine,
    `Guide: ${args.block.guideUrl}`,
    `Preview: ${args.block.previewCommand}`,
    args.block.irreversibleAdvisory,
  ];
}

function installTrackSkipsSuccessorBlock(
  install: InstallClassification | null | undefined,
  sourceRoot: string,
): boolean {
  if (install?.kind === "v3_self_contained_npm") {
    return true;
  }
  if (install?.kind === "source_checkout" && cliDistributionMajor(sourceRoot) >= 3) {
    return true;
  }
  return false;
}

export function resolveNextMajorDoctorLines(ctx: NextMajorDoctorContext): string[] | null {
  const env = ctx.env ?? process.env;
  const home = ctx.home;
  const sourceRoot = ctx.sourceRoot;
  const install = ctx.install ?? null;

  if (installTrackSkipsSuccessorBlock(install, sourceRoot)) {
    return null;
  }

  const selected = resolveSelectedChannel({
    channel: ctx.channel ?? null,
    env,
    home,
    sourceRoot,
  });
  const currentChannel = selected.channel;
  const successorChannel: UpdateChannelName =
    install?.kind === "v2_managed_app_home" ? "stable" : currentChannel;
  const displayChannel: UpdateChannelName =
    install?.kind === "v2_managed_app_home" ? "stable" : currentChannel;

  const runningDistributionMajor =
    ctx.runningDistributionMajor ??
    (install?.kind === "v2_managed_app_home" ? 2 : cliDistributionMajor(sourceRoot));

  if (runningDistributionMajor === 1) {
    const block = V1_NEXT_MAJOR_FALLBACK;
    return formatNextMajorDoctorLines({
      currentVersion: block.currentVersion,
      currentChannel: block.currentChannel,
      block,
    });
  }

  const authorityBlock = loadChannelNextMajor(sourceRoot, successorChannel);
  if (!authorityBlock || !authorityBlock.announced) {
    return null;
  }

  const runningVersion =
    ctx.runningVersion ??
    (install
      ? resolveRunningVersion({
          appHome: install.appHome,
          sourceRoot,
          install,
        })
      : null) ??
    `${runningDistributionMajor}.x`;

  return formatNextMajorDoctorLines({
    currentVersion: runningVersion,
    currentChannel: displayChannel,
    block: authorityBlock,
  });
}

export function prependNextMajorDoctorSection(text: string, sectionLines: string[] | null): string {
  if (!sectionLines || sectionLines.length === 0) {
    return text;
  }
  return `${sectionLines.join("\n")}\n\n${text}`;
}
