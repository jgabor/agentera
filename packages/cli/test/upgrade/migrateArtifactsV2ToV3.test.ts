import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NPX_CLI_ENTRYPOINT,
  NPX_HOOK_VALIDATE,
  applyCleanupPhase,
  applyMigrationPhases,
  applyRuntimeRewirePhase,
  detectV1ArtifactPairs,
  dryRunMigration,
  planArtifactsPhase,
  planCleanupPhase,
  planRuntimeRewirePhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx, sandboxMigrationEnv } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

function copyFixture(name: string, dest: string): string {
  const src = path.join(FIXTURES, name);
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-v2v3-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("planArtifactsPhase", () => {
  it("reports noop for v2 YAML project layouts", () => {
    const project = copyFixture("v2-yaml-project", path.join(tmp, "yaml-project"));
    const phase = planArtifactsPhase(project);
    expect(phase.status).toBe("noop");
    expect(phase.items.every((item) => item.status === "noop")).toBe(true);
    expect(phase.items.some((item) => item.source === ".agentera/progress.yaml")).toBe(true);
  });

  it("plans pending v1 Markdown migration to v2 YAML", () => {
    const project = copyFixture("v2-v1-md-project", path.join(tmp, "v1-md"));
    const phase = planArtifactsPhase(project);
    expect(phase.status).toBe("pending");
    expect(detectV1ArtifactPairs(project)).toEqual([".agentera/PROGRESS.md"]);
    expect(phase.items[0]?.action).toBe("migrate");
    expect(phase.items[0]?.target).toBe(".agentera/progress.yaml");
  });

  it("applies v1 Markdown migration and archives source", () => {
    const project = copyFixture("v2-v1-md-project", path.join(tmp, "v1-apply"));
    const preview = planArtifactsPhase(project);
    const applied = applyMigrationPhases({ appHome: project, project, home: tmp }, {
      artifacts: preview,
      runtime: { name: "runtime", status: "noop", summary: { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0, skipped: 0 }, items: [], message: "" },
      cleanup: { name: "cleanup", status: "noop", summary: { pending: 0, applied: 0, noop: 0, blocked: 0, failed: 0, skipped: 0 }, items: [], message: "" },
    }, ["artifacts"]);
    expect(applied.artifacts.status).toBe("applied");
    expect(fs.existsSync(path.join(project, ".agentera/progress.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(project, ".agentera/PROGRESS.md"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".agentera/backup-v1/PROGRESS.md"))).toBe(true);
  });
});

describe("planRuntimeRewirePhase", () => {
  it("dry-run reports pending rewire for Python managed runtime configs", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home"));
    const phase = planRuntimeRewirePhase(
      migrationCtx(path.join(home, "agentera"), path.join(home, "project"), home, REPO_ROOT),
    );
    expect(phase.status).toBe("pending");
    expect(phase.items.some((item) => item.runtime === "codex" && item.status === "pending")).toBe(true);
    expect(phase.items.some((item) => item.runtime === "cursor" && item.status === "pending")).toBe(true);
  });

  it("apply rewires runtime config to npm self-contained entrypoint", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home-apply"));
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(home, "project"), home, REPO_ROOT);
    const preview = planRuntimeRewirePhase(ctx);
    applyRuntimeRewirePhase(preview, ctx);
    expect(preview.status).toBe("applied");

    const codexHooks = fs.readFileSync(path.join(home, ".codex/hooks/codex-hooks.json"), "utf8");
    expect(codexHooks).toContain(NPX_HOOK_VALIDATE);
    expect(codexHooks).not.toContain("validate_artifact.py");

    const cursorHooks = fs.readFileSync(path.join(home, ".cursor/hooks.json"), "utf8");
    expect(cursorHooks).toContain(NPX_CLI_ENTRYPOINT);
    expect(cursorHooks).not.toContain("cursor_session_start.py");

    const codexConfig = fs.readFileSync(path.join(home, ".codex/config.toml"), "utf8");
    expect(codexConfig).not.toContain("AGENTERA_HOME");
  });
});

describe("planCleanupPhase", () => {
  it("dry-run previews managed app-home removal with user-data preservation", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "app-home"));
    const phase = planCleanupPhase({ appHome, project: appHome, home: tmp });
    expect(phase.status).toBe("pending");
    const item = phase.items[0];
    expect(item?.action).toBe("remove-managed-app-home");
    expect(item?.preserved?.some((p) => p.endsWith(".agentera/progress.yaml"))).toBe(true);
    expect(item?.removedPreview?.some((p) => p.includes("app/scripts/agentera"))).toBe(true);
    expect(fs.existsSync(path.join(appHome, "app", "scripts", "agentera"))).toBe(true);
    expect(fs.existsSync(path.join(appHome, ".agentera", "progress.yaml"))).toBe(true);
  });

  it("apply removes managed bundle but preserves user state", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "app-home-apply"));
    const preview = planCleanupPhase({ appHome, project: appHome, home: tmp });
    applyCleanupPhase(preview);
    expect(preview.status).toBe("applied");
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
    expect(fs.existsSync(path.join(appHome, ".agentera", "progress.yaml"))).toBe(true);
  });
});

describe("dryRunMigration", () => {
  it("returns all three phases without network access", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "full"));
    const appHome = copyFixture("v2-app-home", path.join(home, "agentera"));
    const project = copyFixture("v2-yaml-project", path.join(home, "project"));
    const result = dryRunMigration({ appHome, project, home, env: sandboxMigrationEnv(home, REPO_ROOT) });
    expect(result.artifacts.name).toBe("artifacts");
    expect(result.runtime.name).toBe("runtime");
    expect(result.cleanup.name).toBe("cleanup");
    expect(result.artifacts.status).toBe("noop");
    expect(result.runtime.status).toBe("pending");
    expect(result.cleanup.status).toBe("pending");
  });

  it("applyMigrationPhases honors --only phase limits", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "only"));
    const appHome = copyFixture("v2-app-home", path.join(home, "agentera"));
    const project = copyFixture("v2-yaml-project", path.join(home, "project"));
    const ctx = migrationCtx(appHome, project, home, REPO_ROOT);
    const preview = dryRunMigration(ctx);
    const applied = applyMigrationPhases(ctx, preview, ["runtime"]);
    expect(applied.runtime.status).toBe("applied");
    expect(applied.cleanup.status).toBe("pending");
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(true);
  });
});
