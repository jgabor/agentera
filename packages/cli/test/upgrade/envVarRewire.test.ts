import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type NpxHookCommands,
  applyRuntimeMigrationItem,
  rewireProfileraEnvVar,
  textUsesProfileraProfileDir,
} from "../../src/upgrade/runtimeMigration.js";
import {
  applyRuntimeRewirePhase,
  planRuntimeRewirePhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const NPX_COMMANDS: NpxHookCommands = {
  cliEntrypoint: "npx -y agentera@next",
  validate: "npx -y agentera@next hook validate-artifact",
  cursorSessionStart: "npx -y agentera@next hook cursor-session-start",
  cursorSessionStop: "npx -y agentera@next hook session-stop",
  cursorPreTool: "npx -y agentera@next hook cursor-pre-tool-use",
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "envvar-rewire-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("textUsesProfileraProfileDir", () => {
  it("detects PROFILERA_PROFILE_DIR in text", () => {
    expect(textUsesProfileraProfileDir("export PROFILERA_PROFILE_DIR=/tmp/profile")).toBe(true);
  });

  it("returns false for text with only AGENTERA_PROFILE_DIR", () => {
    expect(textUsesProfileraProfileDir("export AGENTERA_PROFILE_DIR=/tmp/profile")).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(textUsesProfileraProfileDir("")).toBe(false);
  });

  it("detects PROFILERA_PROFILE_DIR embedded in JSON", () => {
    expect(textUsesProfileraProfileDir('{"env": "PROFILERA_PROFILE_DIR"}')).toBe(true);
  });

  it("detects PROFILERA_PROFILE_DIR in TOML set directive", () => {
    expect(
      textUsesProfileraProfileDir('set = { PROFILERA_PROFILE_DIR = "/tmp/profile" }'),
    ).toBe(true);
  });
});

describe("rewireProfileraEnvVar", () => {
  it("replaces PROFILERA_PROFILE_DIR with AGENTERA_PROFILE_DIR", () => {
    const input = "export PROFILERA_PROFILE_DIR=/tmp/profile";
    expect(rewireProfileraEnvVar(input)).toBe("export AGENTERA_PROFILE_DIR=/tmp/profile");
  });

  it("replaces all occurrences", () => {
    const input = "PROFILERA_PROFILE_DIR=foo\nPROFILERA_PROFILE_DIR=bar";
    expect(rewireProfileraEnvVar(input)).toBe(
      "AGENTERA_PROFILE_DIR=foo\nAGENTERA_PROFILE_DIR=bar",
    );
  });

  it("leaves text without the env var unchanged", () => {
    const input = "export AGENTERA_PROFILE_DIR=/tmp/profile";
    expect(rewireProfileraEnvVar(input)).toBe(input);
  });

  it("preserves surrounding content", () => {
    const input = 'set = { PROFILERA_PROFILE_DIR = "/tmp" }\n# comment';
    const result = rewireProfileraEnvVar(input);
    expect(result).toBe('set = { AGENTERA_PROFILE_DIR = "/tmp" }\n# comment');
  });
});

describe("planEnvVarRewireItems", () => {
  it("pushes pending rewire-env-var items for codex config containing PROFILERA_PROFILE_DIR", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      'set = { PROFILERA_PROFILE_DIR = "/tmp/profile" }\n',
    );

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);

    const envVarItems = phase.items.filter(
      (item) => item.action === "rewire-env-var" && item.status === "pending",
    );
    expect(envVarItems.length).toBe(1);
    expect(envVarItems[0].runtime).toBe("codex");
    expect(envVarItems[0].source).toBe(path.join(home, ".codex", "config.toml"));
    expect(envVarItems[0].target).toBe(path.join(home, ".codex", "config.toml"));
    expect(envVarItems[0].newText).toContain("AGENTERA_PROFILE_DIR");
    expect(envVarItems[0].newText).not.toContain("PROFILERA_PROFILE_DIR");
    expect(envVarItems[0].message).toBe(
      "will rewire PROFILERA_PROFILE_DIR to AGENTERA_PROFILE_DIR",
    );
  });

  it("skips files that do not contain PROFILERA_PROFILE_DIR", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      'set = { AGENTERA_PROFILE_DIR = "/tmp/profile" }\n',
    );

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);

    const envVarItems = phase.items.filter((item) => item.action === "rewire-env-var");
    expect(envVarItems).toEqual([]);
  });

  it("detects PROFILERA_PROFILE_DIR across multiple runtime surfaces", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    // opencode plugin (in the opencode config dir, not repo source)
    const opencodePluginsDir = path.join(home, "xdg", "opencode", "plugins");
    fs.mkdirSync(opencodePluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodePluginsDir, "agentera.js"),
      'process.env.PROFILERA_PROFILE_DIR = "/tmp/profile";\n',
    );

    // cursor project hooks
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".cursor", "hooks.json"),
      '{ "env": "PROFILERA_PROFILE_DIR" }\n',
    );

    // cursor home hooks
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".cursor", "hooks.json"),
      '{ "env": "PROFILERA_PROFILE_DIR" }\n',
    );

    // codex config
    fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      'set = { PROFILERA_PROFILE_DIR = "/tmp/profile" }\n',
    );

    // codex hooks
    fs.writeFileSync(
      path.join(home, ".codex", "hooks", "codex-hooks.json"),
      '{ "PROFILERA_PROFILE_DIR": true }\n',
    );

    // copilot (github hooks)
    fs.mkdirSync(path.join(project, ".github", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".github", "hooks", "copilot.json"),
      '{ "env": "PROFILERA_PROFILE_DIR" }\n',
    );

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);

    const envVarItems = phase.items.filter(
      (item) => item.action === "rewire-env-var" && item.status === "pending",
    );
    const runtimes = new Set(envVarItems.map((item) => item.runtime));
    expect(runtimes.has("opencode")).toBe(true);
    expect(runtimes.has("cursor")).toBe(true);
    expect(runtimes.has("codex")).toBe(true);
    expect(runtimes.has("copilot")).toBe(true);
    expect(envVarItems.length).toBeGreaterThanOrEqual(6);
    for (const item of envVarItems) {
      expect(item.newText).toContain("AGENTERA_PROFILE_DIR");
      expect(item.newText).not.toContain("PROFILERA_PROFILE_DIR");
    }
  });

  it("pushes no rewire-env-var items when no config files exist", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);

    const envVarItems = phase.items.filter((item) => item.action === "rewire-env-var");
    expect(envVarItems).toEqual([]);
  });
});

describe("applyRuntimeMigrationItem rewire-env-var", () => {
  it("writes rewired content to the target file", () => {
    const target = path.join(tmp, "config.toml");
    fs.writeFileSync(target, 'set = { PROFILERA_PROFILE_DIR = "/tmp" }\n');

    const item = {
      status: "pending" as const,
      action: "rewire-env-var" as const,
      runtime: "codex",
      source: target,
      target,
      newText: 'set = { AGENTERA_PROFILE_DIR = "/tmp" }\n',
      message: "will rewire PROFILERA_PROFILE_DIR to AGENTERA_PROFILE_DIR",
    };

    applyRuntimeMigrationItem(item, NPX_COMMANDS);
    expect(item.status).toBe("applied");
    expect(item.message).toBe("rewired PROFILERA_PROFILE_DIR to AGENTERA_PROFILE_DIR");
    expect(fs.readFileSync(target, "utf8")).toBe(
      'set = { AGENTERA_PROFILE_DIR = "/tmp" }\n',
    );
  });

  it("does not apply when status is noop", () => {
    const target = path.join(tmp, "config.toml");
    const original = 'set = { PROFILERA_PROFILE_DIR = "/tmp" }\n';
    fs.writeFileSync(target, original);

    const item = {
      status: "noop" as const,
      action: "rewire-env-var" as const,
      runtime: "codex",
      source: target,
      target,
      newText: 'set = { AGENTERA_PROFILE_DIR = "/tmp" }\n',
      message: "already migrated",
    };

    applyRuntimeMigrationItem(item, NPX_COMMANDS);
    expect(item.status).toBe("noop");
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("fails when target is missing", () => {
    const item = {
      status: "pending" as const,
      action: "rewire-env-var" as const,
      runtime: "codex",
      source: path.join(tmp, "source.toml"),
      newText: 'set = { AGENTERA_PROFILE_DIR = "/tmp" }\n',
      message: "will rewire",
    };

    applyRuntimeMigrationItem(item, NPX_COMMANDS);
    expect(item.status).toBe("failed");
    expect(item.message).toBe("rewire-env-var missing target or newText");
  });

  it("fails when newText is undefined", () => {
    const target = path.join(tmp, "config.toml");
    fs.writeFileSync(target, "PROFILERA_PROFILE_DIR=/tmp\n");

    const item = {
      status: "pending" as const,
      action: "rewire-env-var" as const,
      runtime: "codex",
      source: target,
      target,
      message: "will rewire",
    };

    applyRuntimeMigrationItem(item, NPX_COMMANDS);
    expect(item.status).toBe("failed");
    expect(item.message).toBe("rewire-env-var missing target or newText");
  });
});

describe("planRuntimeRewirePhase → applyRuntimeRewirePhase (rewire-env-var)", () => {
  it("plans and applies PROFILERA_PROFILE_DIR rewire in codex config", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
    const configPath = path.join(home, ".codex", "config.toml");
    fs.writeFileSync(
      configPath,
      'set = { PROFILERA_PROFILE_DIR = "/tmp/profile" }\n',
    );

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const phase = planRuntimeRewirePhase(ctx);

    const pendingEnvVar = phase.items.filter(
      (item) => item.action === "rewire-env-var" && item.status === "pending",
    );
    expect(pendingEnvVar.length).toBe(1);

    applyRuntimeRewirePhase(phase, ctx);

    const rewritten = fs.readFileSync(configPath, "utf8");
    expect(rewritten).toContain("AGENTERA_PROFILE_DIR");
    expect(rewritten).not.toContain("PROFILERA_PROFILE_DIR");

    const appliedEnvVar = phase.items.filter(
      (item) => item.action === "rewire-env-var" && item.status === "applied",
    );
    expect(appliedEnvVar.length).toBe(1);
  });

  it("is idempotent: second dry-run finds no PROFILERA_PROFILE_DIR references", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, ".codex", "hooks"), { recursive: true });
    const configPath = path.join(home, ".codex", "config.toml");
    fs.writeFileSync(
      configPath,
      'set = { PROFILERA_PROFILE_DIR = "/tmp/profile" }\n',
    );

    // Pre-create the opencode plugin target without PROFILERA_PROFILE_DIR so the
    // copy-plugin action is noop; otherwise the first apply would copy the repo
    // source plugin (which contains PROFILERA_PROFILE_DIR in its setProfileDir
    // fallback) to the target, introducing references that need a second cycle.
    const opencodePluginsDir = path.join(home, "xdg", "opencode", "plugins");
    fs.mkdirSync(opencodePluginsDir, { recursive: true });
    fs.writeFileSync(
      path.join(opencodePluginsDir, "agentera.js"),
      "// managed plugin; no PROFILERA_PROFILE_DIR references\n",
    );

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);

    const first = planRuntimeRewirePhase(ctx);
    applyRuntimeRewirePhase(first, ctx);

    const second = planRuntimeRewirePhase(ctx);
    const pendingEnvVar = second.items.filter(
      (item) => item.action === "rewire-env-var" && item.status === "pending",
    );
    expect(pendingEnvVar).toEqual([]);
  });
});
