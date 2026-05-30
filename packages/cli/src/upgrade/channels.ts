import fs from "node:fs";
import path from "node:path";

import { expanduser } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadTomlFile, parseToml } from "../core/toml.js";
import { loadYamlMappingFile } from "../core/yaml.js";

/**
 * Update channel resolution for upgrade, doctor, and prime.
 * Authority: references/cli/update-channels.yaml
 */

export const UPDATE_CHANNELS_AUTHORITY = "references/cli/update-channels.yaml";
export const UPDATE_CHANNEL_ENV = "AGENTERA_UPDATE_CHANNEL";
export const DEFAULT_USER_CONFIG = "~/.config/agentera/config.toml";
export const CONFIG_CHANNEL_KEY = "update.channel";

export type UpdateChannelName = "stable" | "development";

export type UpdateChannelOverrideSource = "cli_flag" | "env_var" | "config_file" | "default";

export interface ResolvedUpdateChannel {
  channel: UpdateChannelName;
  distTag: string;
  updateCommand: string;
  distributionMajor: number;
  source: UpdateChannelOverrideSource;
  gitRef: string;
  gitUpdateCommand: string;
}

export interface ResolveUpdateChannelArgs {
  /** CLI `--channel` value; highest precedence when set. */
  channel?: string | null;
  env?: Record<string, string | undefined>;
  home?: string;
  /** App source root holding references/cli/update-channels.yaml. */
  sourceRoot?: string;
}

type Dict = Record<string, unknown>;

const CHANNEL_NAMES: readonly UpdateChannelName[] = ["stable", "development"];

let cachedAuthority: Dict | null = null;
let cachedAuthorityRoot: string | null = null;

function isUpdateChannelName(value: string): value is UpdateChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(value);
}

function parseChannelValue(
  raw: string,
  source: UpdateChannelOverrideSource,
): UpdateChannelName {
  const normalized = raw.trim().toLowerCase();
  if (!isUpdateChannelName(normalized)) {
    throw new Error(
      `invalid update channel ${JSON.stringify(raw)} from ${source}; expected stable or development`,
    );
  }
  return normalized;
}

function readNestedKey(mapping: Dict, dottedKey: string): unknown {
  const parts = dottedKey.split(".");
  let current: unknown = mapping;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Dict)[part];
  }
  return current;
}

function defaultUserConfigPath(home: string): string {
  return path.join(expanduser(home), ".config", "agentera", "config.toml");
}

function readConfigChannel(home: string): UpdateChannelName | null {
  const configPath = defaultUserConfigPath(home);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  let mapping: Dict;
  try {
    mapping = loadTomlFile(configPath);
  } catch {
    return null;
  }
  const raw = readNestedKey(mapping, CONFIG_CHANNEL_KEY);
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new Error(`invalid ${CONFIG_CHANNEL_KEY} in ${configPath}: expected string`);
  }
  return parseChannelValue(raw, "config_file");
}

export function loadUpdateChannelsAuthority(sourceRoot: string): Dict {
  const authorityPath = path.join(sourceRoot, UPDATE_CHANNELS_AUTHORITY);
  return loadYamlMappingFile(authorityPath);
}

function authorityForSourceRoot(sourceRoot: string): Dict {
  if (cachedAuthority && cachedAuthorityRoot === sourceRoot) {
    return cachedAuthority;
  }
  const authority = loadUpdateChannelsAuthority(sourceRoot);
  cachedAuthority = authority;
  cachedAuthorityRoot = sourceRoot;
  return authority;
}

/** Reset cached authority (tests). */
export function resetUpdateChannelsAuthorityCache(): void {
  cachedAuthority = null;
  cachedAuthorityRoot = null;
}

function channelEntry(authority: Dict, channel: UpdateChannelName): Dict {
  const channels = authority.channels as Dict | undefined;
  const entry = channels?.[channel];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`update channels authority missing channel ${channel}`);
  }
  return entry as Dict;
}

function npmResolution(entry: Dict): Dict {
  const resolution = entry.resolution as Dict | undefined;
  const npm = resolution?.npm;
  if (!npm || typeof npm !== "object" || Array.isArray(npm)) {
    throw new Error("update channels authority missing npm resolution");
  }
  return npm as Dict;
}

function gitResolution(entry: Dict): Dict {
  const resolution = entry.resolution as Dict | undefined;
  const git = resolution?.git;
  if (!git || typeof git !== "object" || Array.isArray(git)) {
    throw new Error("update channels authority missing git resolution");
  }
  return git as Dict;
}

/** Stable channel must not target 3.x pre-release dist-tags in npm update commands. */
export function assertStableNpmUpdateCommand(channel: UpdateChannelName, updateCommand: string, distTag: string): void {
  if (channel !== "stable") {
    return;
  }
  if (distTag !== "latest") {
    throw new Error(`stable channel dist tag must be latest, got ${JSON.stringify(distTag)}`);
  }
  const forbidden = [/@next\b/i, /@3\.\d/i, /@3\.0\.0-dev/i, /-alpha/i, /-rc/i, /-beta/i];
  for (const pattern of forbidden) {
    if (pattern.test(updateCommand)) {
      throw new Error(`stable channel update command must not target 3.x pre-releases: ${updateCommand}`);
    }
  }
  if (!/@latest\b/.test(updateCommand)) {
    throw new Error(`stable channel update command must use @latest: ${updateCommand}`);
  }
}

export function resolveSelectedChannel(args: ResolveUpdateChannelArgs): {
  channel: UpdateChannelName;
  source: UpdateChannelOverrideSource;
} {
  const env = args.env ?? process.env;
  const home = args.home ?? env.HOME ?? process.env.HOME ?? "/";

  if (args.channel !== undefined && args.channel !== null && String(args.channel).trim() !== "") {
    return {
      channel: parseChannelValue(String(args.channel), "cli_flag"),
      source: "cli_flag",
    };
  }

  const envRaw = env[UPDATE_CHANNEL_ENV];
  if (envRaw !== undefined && envRaw.trim() !== "") {
    return {
      channel: parseChannelValue(envRaw, "env_var"),
      source: "env_var",
    };
  }

  const fromConfig = readConfigChannel(home);
  if (fromConfig) {
    return { channel: fromConfig, source: "config_file" };
  }

  const sourceRoot = args.sourceRoot ?? resolveSourceRoot(env);
  const authority = authorityForSourceRoot(sourceRoot);
  const defaultChannel = String(authority.default_channel ?? "stable");
  return {
    channel: parseChannelValue(defaultChannel, "default"),
    source: "default",
  };
}

export function resolveUpdateChannel(args: ResolveUpdateChannelArgs = {}): ResolvedUpdateChannel {
  const env = args.env ?? process.env;
  const sourceRoot = args.sourceRoot ?? resolveSourceRoot(env);
  const { channel, source } = resolveSelectedChannel({ ...args, sourceRoot });
  const authority = authorityForSourceRoot(sourceRoot);
  const entry = channelEntry(authority, channel);
  const npm = npmResolution(entry);
  const git = gitResolution(entry);

  const distTag = String(npm.dist_tag ?? "");
  const updateCommand = String(npm.update_command ?? "").trim();
  const gitRef = String(git.ref ?? "");
  const gitUpdateCommand = String(git.update_command ?? "").trim();
  const distributionMajor = Number(entry.distribution_major);
  if (!Number.isFinite(distributionMajor)) {
    throw new Error(`update channels authority missing distribution_major for ${channel}`);
  }

  assertStableNpmUpdateCommand(channel, updateCommand, distTag);

  if (channel === "development") {
    if (distTag !== "next") {
      throw new Error(`development channel dist tag must be next, got ${JSON.stringify(distTag)}`);
    }
    if (!/@next\b/.test(updateCommand)) {
      throw new Error(`development channel update command must use @next: ${updateCommand}`);
    }
  }

  return {
    channel,
    distTag,
    updateCommand,
    distributionMajor,
    source,
    gitRef,
    gitUpdateCommand,
  };
}

/** Parse `update.channel` from TOML text (tests). */
export function parseConfigUpdateChannel(text: string): UpdateChannelName | null {
  const raw = readNestedKey(parseToml(text), CONFIG_CHANNEL_KEY);
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new Error(`invalid ${CONFIG_CHANNEL_KEY}: expected string`);
  }
  return parseChannelValue(raw, "config_file");
}
