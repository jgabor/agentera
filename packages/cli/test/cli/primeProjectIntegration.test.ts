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
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../upgrade/fixtures/v2-runtime-cursor-full/project/.cursor/hooks.json",
);

let tmp: string;
let home: string;
let prevCwd: string;

function seedNpxBundle(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
  fs.writeFileSync(path.join(root, "registry.json"), JSON.stringify({ skills: [{ version: "3.0.0-next.1" }] }));
  fs.writeFileSync(
    path.join(root, NPX_BUNDLE_SENTINEL),
    JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0-next.1" }),
  );
  fs.cpSync(path.join(REPO_ROOT, "references"), path.join(root, "references"), { recursive: true });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-proj-int-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  prevCwd = process.cwd();
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  delete process.env.AGENTERA_HOME;
});

afterEach(() => {
  process.chdir(prevCwd);
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  delete process.env.AGENTERA_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prime project_integration", () => {
  it("requires manual review for unowned python-managed cursor hooks", () => {
    const bundle = path.join(tmp, "bundle");
    seedNpxBundle(bundle);
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;

    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.copyFileSync(FIXTURES, path.join(project, ".cursor", "hooks.json"));
    fs.mkdirSync(path.join(home, ".agents", "skills"), { recursive: true });
    process.chdir(project);

    const state = collectOrientationState({ home, env: process.env });
    const integration = state.project_integration as Record<string, unknown>;

    expect(state.app.status).toBe("up_to_date");
    expect(integration.recommendation).toBe("stay");
    expect(integration.pending_runtime).toBe(0);
    expect(integration.pending_runtimes).toEqual([]);
    expect(integration.dry_run_command).toBeNull();
    expect(integration.phases).toMatchObject({
      lifecycle: { status: "blocked" },
    });

    const attention = (state.attention as string[]).find((line) => line.includes("lifecycle action_class="));
    expect(attention).toBeTruthy();

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

  it("recommends artifact upgrade for v1 Markdown project on npx bundle", () => {
    const bundle = path.join(tmp, "bundle-v1");
    seedNpxBundle(bundle);
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;

    const project = path.join(tmp, "v1-project");
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".agentera", "PROGRESS.md"),
      "# Progress\n\n## Cycle 1 · 2026-01-01 00:00 · feat\n\n**What**: fixture\n",
    );
    process.chdir(project);

    const state = collectOrientationState({ home, env: process.env });
    const integration = state.project_integration as Record<string, unknown>;

    expect(integration.recommendation).toBe("upgrade");
    expect(integration.pending_artifacts).toBe(1);
    expect(integration.upgrade_only).toBeUndefined();
    expect(integration.dry_run_command).toContain("upgrade");
    expect(integration.dry_run_command).not.toContain("--project");
    expect(integration.dry_run_command).toContain("@next");

    const nextAction = state.next_action.recommended;
    expect(nextAction.object).toBe("Upgrade Agentera artifacts");
  });
});
