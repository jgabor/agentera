import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRuntimeRetirementPhase,
  planRuntimeRetirementPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { wholeResourceProvesV2HookOwnership } from "../../src/upgrade/runtimeMigration.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-native-hook-retirement-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const V2_HOOK = 'uv run "${AGENTERA_HOME}/hooks/validate_artifact.py"';

function write(root: string, relative: string, text: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return target;
}

function ownedHook(command = V2_HOOK): string {
  return JSON.stringify({ hooks: { PreToolUse: [{ command }] } }, null, 2);
}

function context(): ReturnType<typeof migrationCtx> {
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return migrationCtx(path.join(home, "agentera"), project, home, REPO_ROOT);
}

describe("whole-resource v2 hook ownership", () => {
  it("accepts a hook resource only when every command is retired Agentera work", () => {
    expect(wholeResourceProvesV2HookOwnership(ownedHook())).toBe(true);
  });

  it("rejects a mixed hook resource", () => {
    expect(wholeResourceProvesV2HookOwnership(ownedHook("/usr/local/bin/user-hook"))).toBe(false);
  });
});

describe("runtime hook retirement", () => {
  it("removes proven Codex and Cursor hooks while leaving declared Copilot cleanup to its authority seam", () => {
    const ctx = context();
    const codexConfig = write(ctx.home, ".codex/config.toml", '[shell_environment_policy]\nset = { USER = "keep" }\n');
    const hooks = [
      write(ctx.home, ".codex/hooks/codex-hooks.json", ownedHook()),
      write(ctx.project, ".cursor/hooks.json", ownedHook()),
    ];
    const copilotHook = write(ctx.project, ".github/hooks/agentera.json", ownedHook());
    const configBefore = fs.readFileSync(codexConfig, "utf8");

    const phase = planRuntimeRetirementPhase(ctx);

    expect(phase.items.filter((item) => item.action === "retire-hooks")).toHaveLength(2);
    expect(phase.items.filter((item) => item.action === "retire-hooks").every((item) => item.status === "pending")).toBe(true);

    applyRuntimeRetirementPhase(phase, ctx);

    expect(phase.status).toBe("applied");
    for (const hook of hooks) expect(fs.existsSync(hook)).toBe(false);
    expect(fs.existsSync(copilotHook)).toBe(true);
    expect(fs.readFileSync(codexConfig, "utf8")).toBe(configBefore);
  });

  it("preserves a mixed hook with bounded manual guidance", () => {
    const ctx = context();
    const hook = write(
      ctx.project,
      ".cursor/hooks.json",
      JSON.stringify({ hooks: { PreToolUse: [{ command: V2_HOOK }, { command: "/usr/local/bin/user-hook" }] } }),
    );
    const before = fs.readFileSync(hook, "utf8");

    const phase = planRuntimeRetirementPhase(ctx);

    expect(phase.status).toBe("blocked");
    expect(phase.items).toContainEqual(expect.objectContaining({
      action: "retire-hooks",
      source: hook,
      status: "blocked",
      message: expect.stringContaining("complete resource ownership is unproven"),
    }));
    applyRuntimeRetirementPhase(phase, ctx);
    expect(fs.readFileSync(hook, "utf8")).toBe(before);
  });

  it("preserves a proven hook replaced after preview", () => {
    const ctx = context();
    const hook = write(ctx.project, ".cursor/hooks.json", ownedHook());
    const phase = planRuntimeRetirementPhase(ctx);
    fs.writeFileSync(hook, ownedHook("/usr/local/bin/user-hook"));

    applyRuntimeRetirementPhase(phase, ctx);

    expect(phase.items[0]).toMatchObject({ status: "blocked" });
    expect(fs.existsSync(hook)).toBe(true);
  });
});
