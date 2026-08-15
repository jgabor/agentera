import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCleanupPhase,
  applyMigrationPhases,
  applyRuntimeRetirementPhase,
  dryRunMigration,
  planArtifactsPhase,
  planCleanupPhase,
  planRuntimeRetirementPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { APP_CONTENT_REFRESH_ACTION } from "../../src/upgrade/appContentRefresh.js";
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
  it("plans lifecycle migration for legacy v2 YAML plan fixtures", () => {
    const project = copyFixture("v2-yaml-project", path.join(tmp, "yaml-project"));
    const phase = planArtifactsPhase(project);
    expect(phase.status).toBe("pending");
    expect(phase.items).toContainEqual(
      expect.objectContaining({
        action: "normalize-plan-lifecycle",
        source: ".agentera/plan.yaml",
        status: "pending",
      }),
    );
    expect(phase.items.some((item) => item.source === ".agentera/progress.yaml")).toBe(true);
  });

});

describe("planRuntimeRetirementPhase", () => {
  it("dry-run reports pending retirement for whole-resource v2 hooks", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home"));
    const phase = planRuntimeRetirementPhase(
      migrationCtx(path.join(home, "agentera"), path.join(home, "project"), home, REPO_ROOT),
    );
    expect(phase.status).toBe("pending");
    expect(phase.items.some((item) => item.runtime === "codex" && item.status === "pending")).toBe(true);
    expect(phase.items.some((item) => item.runtime === "cursor" && item.status === "pending")).toBe(true);
  });

  it("apply removes whole-resource hooks and preserves configuration", () => {
    const home = copyFixture("v2-runtime-python", path.join(tmp, "home-apply"));
    const ctx = migrationCtx(path.join(home, "agentera"), path.join(home, "project"), home, REPO_ROOT);
    const config = path.join(home, ".codex/config.toml");
    const configBefore = fs.readFileSync(config, "utf8");
    const preview = planRuntimeRetirementPhase(ctx);
    applyRuntimeRetirementPhase(preview, ctx);
    expect(preview.status).toBe("applied");

    expect(fs.existsSync(path.join(home, ".codex/hooks/codex-hooks.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".cursor/hooks.json"))).toBe(false);
    expect(fs.readFileSync(config, "utf8")).toBe(configBefore);
  });
});

describe("planCleanupPhase", () => {
  it("does not infer app ownership from scripts and skill filenames", () => {
    const appHome = path.join(tmp, "markerless-user-app");
    const app = path.join(appHome, "app");
    fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
    fs.writeFileSync(path.join(app, "scripts", "agentera"), "user script\n");
    fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "user skill\n");
    fs.writeFileSync(path.join(app, "keep-user-data.txt"), "keep\n");
    const ctx = migrationCtx(appHome, appHome, tmp, REPO_ROOT);

    const phase = planCleanupPhase(ctx);
    applyCleanupPhase(phase, ctx);

    expect(phase.items.some((item) => item.action === "remove-managed-app-home" && item.status === "applied")).toBe(false);
    expect(fs.readFileSync(path.join(app, "keep-user-data.txt"), "utf8")).toBe("keep\n");
    expect(fs.readFileSync(path.join(app, "scripts", "agentera"), "utf8")).toBe("user script\n");
  });

  it("blocks marker-owned app cleanup when unknown content is present", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "managed-with-user-data"));
    const userFile = path.join(appHome, "app", "keep-user-data.txt");
    fs.writeFileSync(userFile, "keep\n");
    const ctx = migrationCtx(appHome, appHome, tmp, REPO_ROOT);

    const phase = planCleanupPhase(ctx);
    applyCleanupPhase(phase, ctx);

    expect(phase.items.find((item) => item.action === "remove-managed-app-home")?.status).toBe("blocked");
    expect(fs.readFileSync(userFile, "utf8")).toBe("keep\n");
  });

  it("preserves the whole marked bundle when nested user content is present", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "managed-with-nested-user-data"));
    const userFile = path.join(appHome, "app", "skills", "user-custom", "notes.txt");
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, "keep nested notes\n");
    const ctx = migrationCtx(appHome, appHome, tmp, REPO_ROOT);

    const phase = planCleanupPhase(ctx);
    applyCleanupPhase(phase, ctx);

    const removal = phase.items.find((item) => item.action === "remove-managed-app-home");
    expect(removal?.status).toBe("blocked");
    expect(removal?.message).toContain("skills/user-custom/notes.txt");
    expect(fs.readFileSync(userFile, "utf8")).toBe("keep nested notes\n");
    expect(fs.existsSync(path.join(appHome, "app", "registry.json"))).toBe(true);
  });

  it("dry-run previews managed app-home removal with user-data preservation", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "app-home"));
    const phase = planCleanupPhase({ appHome, project: appHome, home: tmp, sourceRoot: REPO_ROOT });
    expect(phase.status).toBe("pending");
    const removeItem = phase.items.find((item) => item.action === "remove-managed-app-home");
    expect(removeItem?.action).toBe("remove-managed-app-home");
    expect(removeItem?.preserved?.some((p) => p.endsWith(".agentera/progress.yaml"))).toBe(true);
    expect(removeItem?.removedPreview?.some((p) => p.includes("app/scripts/agentera"))).toBe(true);
    expect(phase.items.some((item) => item.action === APP_CONTENT_REFRESH_ACTION)).toBe(true);
    expect(fs.existsSync(path.join(appHome, "app", "scripts", "agentera"))).toBe(true);
    expect(fs.existsSync(path.join(appHome, ".agentera", "progress.yaml"))).toBe(true);
  });

  it("apply removes managed bundle but preserves user state", () => {
    const appHome = copyFixture("v2-app-home", path.join(tmp, "app-home-apply"));
    const ctx = migrationCtx(appHome, appHome, tmp, REPO_ROOT);
    const preview = planCleanupPhase(ctx);
    applyCleanupPhase(preview, ctx);
    expect(preview.status).toBe("applied");
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
    expect(fs.existsSync(path.join(appHome, ".agentera", "progress.yaml"))).toBe(true);

    const retry = planCleanupPhase(ctx);
    applyCleanupPhase(retry, ctx);
    expect(retry.items.some((item) => item.action === "remove-managed-app-home" && item.status === "pending")).toBe(false);
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
    expect(result.artifacts.status).toBe("pending");
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
