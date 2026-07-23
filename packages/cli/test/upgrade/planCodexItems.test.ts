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

function codexMutationTargets(items: ReturnType<typeof planRuntimeMigrationItems>): string[] {
  return items
    .filter((item) => item.runtime === "codex" && ["rewire-runtime", "retire-hooks"].includes(item.action))
    .flatMap((item) => [item.source, item.target])
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
  it("preserves a non-Agentera copied hook when plugin hooks are enabled", () => {
    const home = path.join(tmp, "preserved-home");
    const project = path.join(tmp, "preserved-project");
    fs.mkdirSync(project, { recursive: true });
    seedCodexLayout(home);
    const hooksPath = path.join(home, ".codex", "hooks", "codex-hooks.json");
    const userHooks = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "^apply_patch$", hooks: [{ type: "command", command: "npx -y agentera@next hook validate-artifact" }] }],
        UserHook: [],
      },
    });
    fs.writeFileSync(hooksPath, userHooks);

    const items = planRuntimeMigrationItems(migrationCtx(path.join(home, "agentera"), project, home, REPO_ROOT));
    const item = items.find((candidate) => candidate.action === "retire-hooks" && candidate.source === hooksPath);

    expect(item?.status).toBe("blocked");
    expect(item?.message).toContain("needs manual review before retirement");
    expect(fs.readFileSync(hooksPath, "utf8")).toBe(userHooks);
  });

  it("blocks an unsafe copied-hook path before migration writes", () => {
    const home = path.join(tmp, "unsafe-home");
    const project = path.join(tmp, "unsafe-project");
    const external = path.join(tmp, "external-hooks.json");
    fs.mkdirSync(project, { recursive: true });
    seedCodexLayout(home);
    const hooksPath = path.join(home, ".codex", "hooks", "codex-hooks.json");
    fs.copyFileSync(hooksPath, external);
    fs.rmSync(hooksPath);
    fs.symlinkSync(external, hooksPath);

    const items = planRuntimeMigrationItems(migrationCtx(path.join(home, "agentera"), project, home, REPO_ROOT));
    const item = items.find((candidate) => candidate.action === "retire-hooks" && candidate.source === hooksPath);

    expect(item?.status).toBe("blocked");
    expect(item?.message).toContain("copied Codex hooks preserved");
    expect(item?.message).toContain("unsafe");
    expect(fs.lstatSync(hooksPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(external, "utf8")).toBe(V2_CODEX_HOOKS);
  });

  it("plans project-level Codex configs when home-level config is absent", () => {
    const home = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    fs.mkdirSync(home, { recursive: true });
    seedCodexLayout(project);

    const appHome = path.join(home, "agentera");
    fs.mkdirSync(appHome, { recursive: true });
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const items = planRuntimeMigrationItems(ctx);
    const targets = codexMutationTargets(items);

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
    const targets = codexMutationTargets(items);

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
    const targets = codexMutationTargets(items);

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
