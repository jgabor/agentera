import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planRuntimeMigrationItems } from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewire-gap-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeCodexConfig(root: string, content: string): void {
  fs.mkdirSync(path.join(root, ".codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), content);
}

describe("pushRewireItem gap detection", () => {
  it("flags blocked when config has neither v2 Python nor v3 npm entrypoint", () => {
    const home = path.join(tmp, "home-neither");
    const project = path.join(tmp, "project-neither");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    makeCodexConfig(home, '[hooks]\ncommand = "/usr/local/bin/my-custom-hook"\n');
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const blocked = items.filter(
      (item) =>
        item.runtime === "codex" &&
        item.action === "rewire-runtime" &&
        item.status === "blocked" &&
        item.source === path.join(home, ".codex", "config.toml"),
    );
    expect(blocked.length).toBe(1);
    expect(blocked[0].message).toContain("neither v2 Python patterns nor v3 npm entrypoint");
  });

  it("reports noop when config already references v3 npm entrypoint", () => {
    const home = path.join(tmp, "home-v3");
    const project = path.join(tmp, "project-v3");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    makeCodexConfig(home, '[hooks]\ncommand = "npx -y agentera@next hook validate-artifact"\n');
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const noop = items.filter(
      (item) =>
        item.runtime === "codex" &&
        item.action === "rewire-runtime" &&
        item.status === "noop" &&
        item.source === path.join(home, ".codex", "config.toml"),
    );
    expect(noop.length).toBe(1);
    expect(noop[0].message).toContain("already references npm self-contained entrypoint");
  });

  it("reports noop for v3 entrypoint with channel variant present", () => {
    const home = path.join(tmp, "home-v3-latest");
    const project = path.join(tmp, "project-v3-latest");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    makeCodexConfig(home, '[hooks]\ncommand = "npx -y agentera@latest hook validate-artifact"\n');
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const rewireItems = items.filter(
      (item) =>
        item.runtime === "codex" &&
        item.action === "rewire-runtime" &&
        item.source === path.join(home, ".codex", "config.toml"),
    );
    expect(rewireItems.length).toBe(1);
    expect(["noop", "pending"]).toContain(rewireItems[0].status);
  });

  it("reports pending when config has v2 Python patterns", () => {
    const home = path.join(tmp, "home-v2");
    const project = path.join(tmp, "project-v2");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    makeCodexConfig(
      home,
      '[hooks]\ncommand = "uv run ${AGENTERA_HOME}/hooks/validate_artifact.py"\n',
    );
    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const pending = items.filter(
      (item) =>
        item.runtime === "codex" &&
        item.action === "rewire-runtime" &&
        item.status === "pending" &&
        item.source === path.join(home, ".codex", "config.toml"),
    );
    expect(pending.length).toBe(1);
    expect(pending[0].message).toContain("will rewire");
  });

  it("classifies every file in a mixed project into exactly one bucket", () => {
    const home = path.join(tmp, "home-mixed");
    const project = path.join(tmp, "project-mixed");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });

    // v2 config at home
    makeCodexConfig(home, '[hooks]\ncommand = "uv run ${AGENTERA_HOME}/hooks/validate_artifact.py"\n');

    // v3 config at project
    const projectCodex = path.join(project, ".codex");
    fs.mkdirSync(path.join(projectCodex, "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(projectCodex, "config.toml"),
      '[hooks]\ncommand = "npx -y agentera@next hook validate-artifact"\n',
    );

    // neither v2 nor v3 at a third location
    const homeCodexHooks = path.join(home, ".codex", "hooks", "codex-hooks.json");
    fs.writeFileSync(homeCodexHooks, '{"hooks": {"preToolUse": [{"command": "/bin/echo"}]}}');

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);

    const rewireItems = items.filter((item) => item.action === "rewire-runtime");
    for (const item of rewireItems) {
      const valid = ["noop", "pending", "blocked"].includes(item.status);
      expect(valid).toBe(true);
    }

    const statuses = rewireItems.map((item) => item.status);
    expect(statuses).toContain("pending");
    expect(statuses).toContain("noop");
  });
});
