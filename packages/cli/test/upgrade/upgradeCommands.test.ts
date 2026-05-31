import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveUpdateChannel } from "../../src/upgrade/channels.js";
import { buildUpgradeCommands } from "../../src/upgrade/upgradeCommands.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("buildUpgradeCommands", () => {
  it("uses stable @latest entrypoint for doctor-style install-root commands", () => {
    const channel = resolveUpdateChannel({
      channel: "stable",
      sourceRoot: REPO_ROOT,
      home: "/tmp/home",
    });
    const cmds = buildUpgradeCommands({
      project: "/tmp/proj",
      installRoot: "/tmp/agentera",
      channel,
    });
    expect(cmds.dryRunCommand).toContain("npx -y agentera@latest");
    expect(cmds.dryRunCommand).toContain("--install-root /tmp/agentera");
    expect(cmds.dryRunCommand).not.toContain("uvx");
    expect(cmds.applyCommand).toContain("--yes");
  });

  it("omits install-root for project-only v1 migration hints", () => {
    const channel = resolveUpdateChannel({
      channel: "stable",
      sourceRoot: REPO_ROOT,
      home: "/tmp/home",
    });
    const cmds = buildUpgradeCommands({
      project: "$PWD",
      installRoot: null,
      channel,
    });
    expect(cmds.dryRunCommand).toContain("agentera@latest");
    expect(cmds.dryRunCommand).not.toContain("--install-root");
    expect(cmds.dryRunCommand).toMatch(/--project .*\$PWD/);
  });

  it("adds development channel for cross-major preview", () => {
    const channel = resolveUpdateChannel({
      channel: "development",
      sourceRoot: REPO_ROOT,
      home: "/tmp/home",
    });
    const cmds = buildUpgradeCommands({
      project: "/tmp/proj",
      installRoot: "/tmp/agentera",
      channel,
    });
    expect(cmds.dryRunCommand).toContain("agentera@next");
    expect(cmds.dryRunCommand).toContain("--channel development");
    expect(cmds.dryRunCommand).not.toContain("--target-major");
  });
});
