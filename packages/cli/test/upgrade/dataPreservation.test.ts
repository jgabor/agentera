import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCleanupPhase,
  applyMigrationPhases,
  dryRunMigration,
  planCleanupPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  assertChecksumsUnchanged,
  checksumManifest,
  listPreservedAppHomeRelPaths,
  listProjectArtifactRelPaths,
} from "./helpers/preservation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;

function copyFixture(name: string, dest: string): string {
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "preserve-v2v3-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("dataPreservation", () => {
  it("preserves realistic app-home user dirs across cleanup without force", () => {
    const appHome = copyFixture("v2-app-home-realistic", path.join(tmp, "realistic-home"));
    const before = checksumManifest(appHome, listPreservedAppHomeRelPaths(appHome));
    expect(Object.keys(before).some((k) => k.startsWith("benchmarks/"))).toBe(true);
    expect(before["intermediate/corpus.json"]).toBeDefined();

    const preview = planCleanupPhase({ appHome, project: appHome, home: tmp });
    expect(preview.status).toBe("pending");
    applyCleanupPhase(preview);
    assertChecksumsUnchanged(appHome, before);
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
  });

  it("preserves app-home allowlisted paths across cleanup apply", () => {
    const appHome = copyFixture("v2-app-home-noisy", path.join(tmp, "app-home"));
    const before = checksumManifest(appHome, listPreservedAppHomeRelPaths(appHome));
    expect(Object.keys(before).length).toBeGreaterThan(0);

    const preview = planCleanupPhase({ appHome, project: appHome, home: tmp, force: true });
    applyCleanupPhase(preview);
    assertChecksumsUnchanged(appHome, before);
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
  });

  it("preserves full-artifacts project YAML across migration dry-run", () => {
    const project = copyFixture("v2-full-artifacts", path.join(tmp, "project"));
    const before = checksumManifest(project, listProjectArtifactRelPaths(project));
    expect(before[".agentera/progress.yaml"]).toBeDefined();
    expect(before[".agentera/optimera/runs/sample.yaml"]).toBeDefined();

    const appHome = copyFixture("v2-app-home", path.join(tmp, "agentera"));
    dryRunMigration({ appHome, project, home: tmp });
    assertChecksumsUnchanged(project, before);
  });

  it("preserves legacy agents home user state when cleanup forced", () => {
    const appHome = copyFixture("v2-legacy-agents-home", path.join(tmp, "legacy"));
    const before = checksumManifest(appHome, listPreservedAppHomeRelPaths(appHome));
    const preview = planCleanupPhase({ appHome, project: appHome, home: tmp, force: true });
    applyCleanupPhase(preview);
    assertChecksumsUnchanged(appHome, before);
  });
});
