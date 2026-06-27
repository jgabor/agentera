import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveMigrationUserStatePreflight,
} from "../../src/migrate/v2HandoffManifest.js";
import {
  dryRunMigration,
  planCleanupPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import { migrationCtx } from "./helpers/migrationCtx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-profile-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("handoffCustomProfileDir", () => {
  it("catalogs custom PROFILERA_PROFILE_DIR and its preserved entries in preflight and cleanup", () => {
    const home = path.join(tmp, "home");
    const appHome = copyFixture("v2-app-home-realistic", path.join(home, "agentera"));
    const customProfile = path.join(home, "custom-profile");
    fs.mkdirSync(path.join(customProfile, "intermediate"), { recursive: true });
    fs.writeFileSync(path.join(customProfile, "PROFILE.md"), "# profile\n");
    fs.writeFileSync(path.join(customProfile, "intermediate", "corpus.json"), "{}\n");

    const env = {
      HOME: home,
      PROFILERA_PROFILE_DIR: customProfile,
    };
    const preflight = resolveMigrationUserStatePreflight(appHome, { home, env });
    const profileEntry = preflight.handoffCatalog.find((entry) => entry.surface === "custom_profile_dir");
    expect(profileEntry?.root).toBe(customProfile);
    expect(profileEntry?.envVar).toBe("PROFILERA_PROFILE_DIR");
    expect(preflight.preservedAbsolutePaths).toContain(customProfile);
    expect(preflight.preservedAbsolutePaths).toContain(path.join(customProfile, "PROFILE.md"));
    expect(preflight.preservedAbsolutePaths).toContain(path.join(customProfile, "intermediate"));

    const cleanup = planCleanupPhase(migrationCtx(appHome, appHome, home, REPO_ROOT, env));
    const catalogItem = cleanup.items.find((item) => item.action === "catalog-handoff");
    expect(catalogItem?.source).toBe(customProfile);
    expect(catalogItem?.message).toContain("PROFILERA_PROFILE_DIR");
    expect(catalogItem?.message).toContain(customProfile);
    expect(catalogItem?.preserved).toContain(path.join(customProfile, "PROFILE.md"));

    const removeItem = cleanup.items.find((item) => item.action === "remove-managed-app-home");
    expect(removeItem?.preserved).toContain(customProfile);
  });

  it("does not catalog a profile dir when PROFILERA_PROFILE_DIR matches app home", () => {
    const home = path.join(tmp, "home");
    const appHome = copyFixture("v2-app-home-realistic", path.join(home, "agentera"));
    const env = {
      HOME: home,
      PROFILERA_PROFILE_DIR: appHome,
    };
    const preflight = resolveMigrationUserStatePreflight(appHome, { home, env });
    expect(preflight.handoffCatalog.some((entry) => entry.surface === "custom_profile_dir")).toBe(false);
  });

  it("catalogs a custom opencode runtime-config-dir with Agentera artifacts", () => {
    const home = path.join(tmp, "home");
    const appHome = copyFixture("v2-app-home-realistic", path.join(home, "agentera"));
    const xdg = path.join(home, "xdg");
    const opencodeDir = path.join(xdg, "opencode");
    fs.mkdirSync(path.join(opencodeDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(opencodeDir, "plugins", "agentera.js"), "// managed plugin\n");

    const env = {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
    };
    const preflight = resolveMigrationUserStatePreflight(appHome, { home, env });
    const opencodeEntry = preflight.handoffCatalog.find(
      (entry) => entry.surface === "opencode_runtime_config_dir",
    );
    expect(opencodeEntry?.root).toBe(opencodeDir);
    expect(opencodeEntry?.envVar).toBe("XDG_CONFIG_HOME");
    expect(preflight.preservedAbsolutePaths).toContain(opencodeDir);
    expect(preflight.preservedAbsolutePaths).toContain(path.join(opencodeDir, "plugins", "agentera.js"));

    const cleanup = planCleanupPhase(migrationCtx(appHome, appHome, home, REPO_ROOT, env));
    const catalogItem = cleanup.items.find(
      (item) => item.action === "catalog-handoff" && item.source === opencodeDir,
    );
    expect(catalogItem?.message).toContain("opencode runtime config dir");
    expect(catalogItem?.message).toContain("XDG_CONFIG_HOME");
  });

  it("does not catalog opencode runtime-config-dir without custom env or Agentera artifacts", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const appHome = copyFixture("v2-app-home-realistic", path.join(home, "agentera"));
    const defaultOpencode = path.join(home, ".config", "opencode");
    fs.mkdirSync(defaultOpencode, { recursive: true });

    const env = { HOME: home };
    const preflight = resolveMigrationUserStatePreflight(appHome, { home, env });
    expect(preflight.handoffCatalog).toEqual([]);

    const cleanup = planCleanupPhase({ appHome, project: appHome, home });
    expect(cleanup.items.some((item) => item.action === "catalog-handoff")).toBe(false);
  });

  it("leaves default preflight unchanged when no custom profile or runtime env is set", () => {
    const home = path.join(tmp, "home");
    const appHome = copyFixture("v2-app-home-realistic", path.join(home, "agentera"));
    const env = { HOME: home };

    const preflight = resolveMigrationUserStatePreflight(appHome, { home, env });
    expect(preflight.handoffCatalog).toEqual([]);
    expect(preflight.preservedTopLevel).toEqual(
      expect.arrayContaining(["benchmarks", "intermediate", "sessions"]),
    );
    expect(preflight.preservedAbsolutePaths.some((p) => p.includes("benchmarks"))).toBe(true);

    const result = dryRunMigration(migrationCtx(appHome, appHome, home, REPO_ROOT, env));
    expect(result.cleanup.items.some((item) => item.action === "catalog-handoff")).toBe(false);
    const removeItem = result.cleanup.items.find((item) => item.action === "remove-managed-app-home");
    expect(removeItem?.preserved?.some((p) => p.includes("benchmarks"))).toBe(true);
  });
});
