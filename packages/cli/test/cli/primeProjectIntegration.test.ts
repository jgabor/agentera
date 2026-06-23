import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { NPX_BUNDLE_SENTINEL } from "../../src/core/sourceRoot.js";

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
  it("recommends runtime upgrade for v3 bundle with python-managed cursor hooks", () => {
    const bundle = path.join(tmp, "bundle");
    seedNpxBundle(bundle);
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundle;

    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, ".cursor"), { recursive: true });
    fs.copyFileSync(FIXTURES, path.join(project, ".cursor", "hooks.json"));
    process.chdir(project);

    const state = collectOrientationState({ home, env: process.env });
    const integration = state.project_integration as Record<string, unknown>;

    expect(state.bundle.status).toBe("up_to_date");
    expect(integration.recommendation).toBe("upgrade");
    expect(integration.pending_runtime).toBeGreaterThan(0);
    expect(integration.pending_runtimes).toContain("cursor");
    expect(integration.dry_run_command).toContain("upgrade");
    expect(integration.dry_run_command).not.toContain("--project");
    expect(integration.upgrade_only).toEqual(["runtime"]);

    const attention = (state.attention as string[]).find((line) => line.includes("runtime wiring"));
    expect(attention).toBeTruthy();

    const nextAction = state.next_action as Record<string, string>;
    expect(nextAction.object).toContain('Upgrade');
    expect(nextAction.capability).toBe('hej');
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
    expect(integration.upgrade_only).toEqual(["artifacts"]);
    expect(integration.dry_run_command).toContain("--only artifacts");
    expect(integration.dry_run_command).not.toContain("--project");
    expect(integration.dry_run_command).toContain("@next");

    const nextAction = state.next_action as Record<string, string>;
    expect(nextAction.object).toBe("Upgrade Agentera artifacts");
  });
});
