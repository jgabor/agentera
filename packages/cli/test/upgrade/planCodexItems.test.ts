import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planRuntimeMigrationItems } from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");

const V2_CODEX_HOOKS = fs.readFileSync(
  path.join(FIXTURES, "v2-runtime-codex-full/.codex/hooks/codex-hooks.json"),
  "utf8",
);
const V2_CODEX_CONFIG = fs.readFileSync(
  path.join(FIXTURES, "v2-runtime-codex-full/.codex/config.toml"),
  "utf8",
);

function seedCodexLayout(root: string): void {
  fs.mkdirSync(path.join(root, ".codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "hooks", "codex-hooks.json"), V2_CODEX_HOOKS);
  fs.writeFileSync(path.join(root, ".codex", "config.toml"), V2_CODEX_CONFIG);
}

function codexRewireTargets(items: ReturnType<typeof planRuntimeMigrationItems>): string[] {
  return items
    .filter((item) => item.runtime === "codex" && item.action === "rewire-runtime")
    .map((item) => item.target ?? item.source)
    .filter((filePath): filePath is string => Boolean(filePath));
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-codex-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("planCodexItems project and home detection", () => {
  it("plans project-level Codex configs when home-level config is absent", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    seedCodexLayout(project);

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const targets = codexRewireTargets(items);

    expect(targets).toContain(path.join(project, ".codex", "config.toml"));
    expect(targets).toContain(path.join(project, ".codex", "hooks", "codex-hooks.json"));
    expect(targets.some((filePath) => filePath.startsWith(path.join(home, ".codex")))).toBe(false);
  });

  it("plans home-level Codex configs when project-level config is absent", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(project, { recursive: true });
    seedCodexLayout(home);

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const targets = codexRewireTargets(items);

    expect(targets).toContain(path.join(home, ".codex", "config.toml"));
    expect(targets).toContain(path.join(home, ".codex", "hooks", "codex-hooks.json"));
    expect(targets.some((filePath) => filePath.startsWith(path.join(project, ".codex")))).toBe(false);
  });

  it("plans both project and home Codex configs without duplicate targets", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    seedCodexLayout(home);
    seedCodexLayout(project);

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const targets = codexRewireTargets(items);

    const expected = [
      path.join(project, ".codex", "config.toml"),
      path.join(project, ".codex", "hooks", "codex-hooks.json"),
      path.join(home, ".codex", "config.toml"),
      path.join(home, ".codex", "hooks", "codex-hooks.json"),
    ];
    for (const filePath of expected) {
      expect(targets).toContain(filePath);
    }
    expect(new Set(targets).size).toBe(targets.length);
  });
});
