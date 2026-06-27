import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APP_CONTENT_REFRESH_ACTION,
  detectStaleAppContentSurfaces,
} from "../../src/upgrade/appContentRefresh.js";
import {
  INSTALLED_HOOKS_SURFACE_LABEL,
  RETIRE_INSTALLED_HOOKS_ACTION,
  detectStaleInstalledHooksSurface,
  installedBundleHasV2HookInvocationText,
  installedHookPathsAfterMigration,
  planInstalledHooksRetirementItems,
  textReferencesV2InstalledHooks,
} from "../../src/upgrade/installedHooksRetirement.js";
import {
  NPX_CLI_ENTRYPOINT,
  NPX_HOOK_VALIDATE,
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx } from "./helpers/migrationCtx.js";
import { scanDirectoryForPythonLeftovers } from "./helpers/preservation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
let home: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

function seedV2InstalledHooks(appHome: string): void {
  const hooksDir = path.join(appHome, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of [
    "validate_artifact.py",
    "cursor_session_start.py",
    "cursor_pre_tool_use.py",
    "cursor_session_stop.py",
  ]) {
    fs.writeFileSync(
      path.join(hooksDir, name),
      `#!/usr/bin/env python3\n# v2 installed hook stub: ${name}\n`,
      "utf8",
    );
  }
  const manifestPath = path.join(appHome, "hooks", "codex-hooks.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "^apply_patch$",
              hooks: [{ type: "command", command: "uv run hooks/validate_artifact.py" }],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "installed-hooks-retire-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("detectStaleInstalledHooksSurface", () => {
  it("flags app homes seeded with v2 Python hooks and uv run hooks/*.py invocations", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "detect"));
    seedV2InstalledHooks(appHome);
    expect(detectStaleInstalledHooksSurface(appHome)).toBe(true);
    expect(detectStaleAppContentSurfaces(appHome, REPO_ROOT)).toContain(INSTALLED_HOOKS_SURFACE_LABEL);
    expect(textReferencesV2InstalledHooks("uv run hooks/validate_artifact.py")).toBe(true);
    expect(textReferencesV2InstalledHooks('uv run "${AGENTERA_HOME}/hooks/validate_artifact.py"')).toBe(true);
  });
});

describe("upgrade apply retires v2 installed hooks", () => {
  it("detects and retires a bundle seeded with uv run hooks/*.py during apply", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "apply"));
    const project = copyFixture("v2-yaml-project", path.join(tmp, "project"));
    seedV2InstalledHooks(appHome);
    fs.cpSync(path.join(FIXTURES, "v2-runtime-python"), home, { recursive: true });
    fs.cpSync(path.join(FIXTURES, "v2-runtime-cursor-full", "project", ".cursor"), path.join(project, ".cursor"), {
      recursive: true,
    });

    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);

    const hookItems = [
      ...preview.runtime.items.filter((item) => item.action === RETIRE_INSTALLED_HOOKS_ACTION),
      ...preview.cleanup.items.filter((item) => item.action === RETIRE_INSTALLED_HOOKS_ACTION),
    ];
    const refreshItems = preview.cleanup.items.filter((item) => item.action === APP_CONTENT_REFRESH_ACTION);
    expect(refreshItems.some((item) => item.removedPreview?.includes(INSTALLED_HOOKS_SURFACE_LABEL))).toBe(true);
    expect(hookItems.some((item) => item.status === "pending")).toBe(true);
    expect(preview.runtime.items.some((item) => item.action === "rewire-runtime" && item.status === "pending")).toBe(
      true,
    );

    const applied = applyMigrationPhases(ctx, preview);
    expect(
      [...applied.runtime.items, ...applied.cleanup.items].some(
        (item) => item.action === RETIRE_INSTALLED_HOOKS_ACTION && item.status === "applied",
      ),
    ).toBe(true);

    expect(installedHookPathsAfterMigration(appHome)).toEqual([]);
    expect(installedBundleHasV2HookInvocationText(appHome)).toBe(false);

    const codexHooks = fs.readFileSync(path.join(home, ".codex", "hooks", "codex-hooks.json"), "utf8");
    expect(codexHooks).toContain(NPX_HOOK_VALIDATE);
    expect(codexHooks).not.toContain("validate_artifact.py");

    const cursorHooks = fs.readFileSync(path.join(project, ".cursor", "hooks.json"), "utf8");
    expect(cursorHooks).toContain(NPX_CLI_ENTRYPOINT);
    expect(cursorHooks).not.toContain("cursor_pre_tool_use.py");

    expect(scanDirectoryForPythonLeftovers(path.join(home, ".codex"))).toEqual([]);
    expect(scanDirectoryForPythonLeftovers(path.join(project, ".cursor"))).toEqual([]);
  });

  it("plans noop when installed hooks are already retired", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "noop"));
    const items = planInstalledHooksRetirementItems(migrationCtx(appHome, appHome, home, REPO_ROOT));
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("noop");
  });
});
