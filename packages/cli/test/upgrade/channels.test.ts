import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveNpxHookCommands } from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  UPDATE_CHANNEL_ENV,
  assertStableNpmUpdateCommand,
  loadUpdateChannelsAuthority,
  parseConfigUpdateChannel,
  resetUpdateChannelsAuthorityCache,
  resolveSelectedChannel,
  resolveUpdateChannel,
} from "../../src/upgrade/channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ch-"));
  resetUpdateChannelsAuthorityCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  resetUpdateChannelsAuthorityCache();
});

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: home, ...overrides };
}

function writeUserConfig(channel: string): void {
  const dir = path.join(home, ".config", "agentera");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), `[update]\nchannel = "${channel}"\n`);
}

describe("loadUpdateChannelsAuthority", () => {
  it("loads stable and development npm resolution from the repo authority", () => {
    const authority = loadUpdateChannelsAuthority(REPO_ROOT);
    expect(authority.default_channel).toBe("stable");
    const stable = (authority.channels as Record<string, unknown>).stable as Record<string, unknown>;
    const development = (authority.channels as Record<string, unknown>).development as Record<string, unknown>;
    expect((stable.resolution as Record<string, unknown>).npm).toMatchObject({
      dist_tag: "latest",
      update_command: "npx -y agentera@latest",
    });
    expect((development.resolution as Record<string, unknown>).npm).toMatchObject({
      dist_tag: "next",
      update_command: "npx -y agentera@next",
    });
  });
});

describe("resolveUpdateChannel", () => {
  it("defaults to stable with latest dist-tag and distribution major 2", () => {
    const resolved = resolveUpdateChannel({ env: env(), sourceRoot: REPO_ROOT });
    expect(resolved).toMatchObject({
      channel: "stable",
      distTag: "latest",
      updateCommand: "npx -y agentera@latest",
      distributionMajor: 2,
      source: "default",
    });
    expect(resolved.gitRef).toBe("main");
    expect(resolved.gitUpdateCommand).toContain("@main");
  });

  it("honors AGENTERA_UPDATE_CHANNEL for development", () => {
    const resolved = resolveUpdateChannel({
      env: env({ [UPDATE_CHANNEL_ENV]: "development" }),
      sourceRoot: REPO_ROOT,
    });
    expect(resolved).toMatchObject({
      channel: "development",
      distTag: "next",
      updateCommand: "npx -y agentera@next",
      distributionMajor: 3,
      source: "env_var",
    });
    expect(resolved.gitUpdateCommand).toContain("feat/v3");
  });

  it("honors CLI --channel over env and config", () => {
    writeUserConfig("development");
    const resolved = resolveUpdateChannel({
      channel: "stable",
      env: env({ [UPDATE_CHANNEL_ENV]: "development" }),
      sourceRoot: REPO_ROOT,
    });
    expect(resolved.channel).toBe("stable");
    expect(resolved.source).toBe("cli_flag");
    expect(resolved.updateCommand).toBe("npx -y agentera@latest");
  });

  it("reads update.channel from user config when env and CLI are unset", () => {
    writeUserConfig("development");
    const resolved = resolveUpdateChannel({ env: env(), sourceRoot: REPO_ROOT });
    expect(resolved.channel).toBe("development");
    expect(resolved.source).toBe("config_file");
    expect(resolved.distTag).toBe("next");
  });

  it("prefers env over config file", () => {
    writeUserConfig("development");
    const resolved = resolveUpdateChannel({
      env: env({ [UPDATE_CHANNEL_ENV]: "stable" }),
      sourceRoot: REPO_ROOT,
    });
    expect(resolved.channel).toBe("stable");
    expect(resolved.source).toBe("env_var");
  });
});

describe("stable channel npm guard", () => {
  it("rejects 3.x pre-release tags in stable update commands", () => {
    expect(() => assertStableNpmUpdateCommand("stable", "npx -y agentera@next", "latest")).toThrow(
      /3\.x pre-release/,
    );
    expect(() => assertStableNpmUpdateCommand("stable", "npx -y agentera@3.0.0-alpha.1", "latest")).toThrow(
      /3\.x pre-release/,
    );
  });

  it("allows development channel next commands", () => {
    expect(() =>
      assertStableNpmUpdateCommand("development", "npx -y agentera@next", "next"),
    ).not.toThrow();
  });
});

describe("resolveSelectedChannel", () => {
  it("rejects invalid channel values", () => {
    expect(() =>
      resolveSelectedChannel({ channel: "beta", env: env(), sourceRoot: REPO_ROOT }),
    ).toThrow(/invalid update channel/);
  });
});

describe("parseConfigUpdateChannel", () => {
  it("parses nested update.channel from TOML", () => {
    expect(parseConfigUpdateChannel('[update]\nchannel = "development"\n')).toBe("development");
    expect(parseConfigUpdateChannel("")).toBeNull();
  });
});
describe("resolveNpxHookCommands", () => {
  it("uses the selected channel npm update command for hook rewires", () => {
    const resolved = resolveUpdateChannel({ channel: "development", env: env(), home, sourceRoot: REPO_ROOT });
    const hooks = resolveNpxHookCommands({ channel: "development", env: env(), home, sourceRoot: REPO_ROOT });
    expect(hooks.cliEntrypoint).toBe(resolved.updateCommand);
    expect(hooks.validate).toBe(`${resolved.updateCommand} hook validate-artifact`);
  });
});
