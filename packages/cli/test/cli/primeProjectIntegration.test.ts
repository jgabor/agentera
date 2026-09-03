import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { selectProjectIntegrationNextAction } from "../../src/cli/commands/prime/collectOrientationState.js";
import type { ReadinessHint } from "../../src/cli/contracts/orientationState.js";
import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";
import type { ProjectIntegrationSummary } from "../../src/upgrade/projectIntegration.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../upgrade/fixtures/v2-runtime-cursor-full/project/.cursor/hooks.json");

let tmp: string;
let home: string;
let prevCwd: string;
let previousEnv: Record<string, string | undefined>;

const SANDBOXED_ENVIRONMENT = ["AGENTERA_BOOTSTRAP_SOURCE_ROOT", "AGENTERA_DEFAULT_INSTALL_ROOT", "AGENTERA_HOME", "AGENTERA_PROFILE_DIR", "PROFILERA_PROFILE_DIR", "AGENTERA_VISIBLE_SKILL_ROOT", "HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"] as const;

function seedNpxBundle(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "3.0.0-next.1" }] }));
  fs.writeFileSync(path.join(root, NPX_BUNDLE_SENTINEL), JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0-next.1" }));
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(root, "references"), { recursive: true });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-proj-int-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  prevCwd = process.cwd();
  previousEnv = Object.fromEntries(SANDBOXED_ENVIRONMENT.map((name) => [name, process.env[name]]));
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.XDG_CACHE_HOME = path.join(tmp, "xdg", "cache");
  process.env.XDG_CONFIG_HOME = path.join(tmp, "xdg", "config");
  process.env.XDG_DATA_HOME = path.join(tmp, "xdg", "data");
  process.env.XDG_STATE_HOME = path.join(tmp, "xdg", "state");
  process.env.AGENTERA_PROFILE_DIR = path.join(tmp, "profile");
  process.env.PROFILERA_PROFILE_DIR = path.join(tmp, "profile");
  delete process.env.AGENTERA_HOME;
  delete process.env.AGENTERA_DEFAULT_INSTALL_ROOT;
  delete process.env.AGENTERA_VISIBLE_SKILL_ROOT;
});

afterEach(() => {
  process.chdir(prevCwd);
  for (const name of SANDBOXED_ENVIRONMENT) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prime project_integration", () => {
  it("requires manual review for unowned python-managed cursor hooks", () => {
    const bundle = path.join(tmp, "bundle");
    seedNpxBundle(bundle);
    seedNpxBundle(path.join(tmp, "xdg", "data", "agentera"));
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;

    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.copyFileSync(FIXTURES, path.join(project, ".cursor", "hooks.json"));
    fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, env: process.env });
    const integration = state.project_integration as Record<string, unknown>;

    expect(state.app.status).toBe("up_to_date");
    expect(integration.recommendation).toBe("upgrade");
    expect(integration).not.toHaveProperty("pending_runtime");
    expect(integration).not.toHaveProperty("pending_runtimes");
    expect(integration.phases).toMatchObject({ app: { status: "pending" } });
    expect(integration.dry_run_command).not.toContain("--runtime");

    expect((state.attention as string[]).some((line) => line.includes("lifecycle action_class="))).toBe(false);

    const nextAction = state.next_action.recommended;
    expect(nextAction.object).not.toContain("Upgrade Agentera runtime wiring");
  });

  it("does not let warning-only lifecycle blockers replace executable readiness work", () => {
    const readiness: ReadinessHint = {
      recommended: {
        object: "TODO: remove stale fixture",
        capability: "build",
        reason: "highest-priority open TODO",
        phase: "build",
      },
      alternatives: [
        {
          object: "VISION refresh",
          capability: "vision",
          reason: "fresh project direction",
          phase: "envision",
        },
      ],
    };
    const warningOnlyIntegration: ProjectIntegrationSummary = {
      recommendation: "stay",
      major_boundary_block: null,
      message: "Manual review is required for lifecycle blockers.",
      pending_runtime: 0,
      pending_runtimes: [],
      pending_artifacts: 0,
      dry_run_command: null,
      apply_command: null,
      update_channel: "development",
      phases: {
        app: { status: "stay", counts: { total: 0, pending: 0, blocked: 0 }, blockers: [] },
        lifecycle: {
          status: "blocked",
          counts: { total: 1, pending: 0, blocked: 1 },
          blockers: ["manual_verification: host trust remains user-owned"],
        },
      },
      aggregate_status: "blocked",
      guidance: {
        route: "manual_review",
        runtimes: ["codex"],
        manual_review_runtimes: ["codex"],
        host_action_runtimes: [],
        doctor_runtimes: [],
        message: "Review the host trust UI manually.",
      },
      exit: { code: 1, meaning: "manual_review_required" },
      retry: { command: null, guidance: "Resolve the host blocker, then retry." },
    };

    const nextAction = selectProjectIntegrationNextAction(readiness, warningOnlyIntegration);

    expect(nextAction.recommended).toEqual(readiness.recommended);
  });
});
