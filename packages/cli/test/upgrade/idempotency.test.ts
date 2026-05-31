import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STATUS_NO_CHANGES_NEEDED,
  UPGRADE_PREVIEW_SCHEMA,
} from "../../src/upgrade/compatibility.js";
import {
  applyMigrationPhases,
  dryRunMigration,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  buildUpgradePlan,
  upgradeExitCode,
} from "../../src/upgrade/upgradeOrchestrator.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;
let home: string;

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }),
  );
}

function seedLayout(sandbox: string): { appHome: string; project: string } {
  const h = path.join(sandbox, "home");
  fs.mkdirSync(h, { recursive: true });
  const appHome = path.join(h, "agentera");
  managedV2(appHome);
  fs.cpSync(path.join(FIXTURES, "v2-yaml-project"), path.join(sandbox, "project"), { recursive: true });
  fs.cpSync(path.join(FIXTURES, "v2-runtime-python"), h, { recursive: true });
  return { appHome, project: path.join(sandbox, "project") };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idempotent-v2v3-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("idempotency", () => {
  it("second orchestrator dry-run reports no_changes_needed after full apply", () => {
    const { appHome, project } = seedLayout(tmp);
    const preview = dryRunMigration({ appHome, project, home });
    applyMigrationPhases({ appHome, project, home }, preview, ["runtime", "cleanup"]);

    const second = buildUpgradePlan({
      installRoot: appHome,
      home,
      project,
      channel: "development",
      dryRun: true,
    });
    expect(second.schemaVersion).toBe(UPGRADE_PREVIEW_SCHEMA);
    expect(second.lifecycleStatus).toBe(STATUS_NO_CHANGES_NEEDED);
    expect(upgradeExitCode(second)).toBe(0);
  });
});
