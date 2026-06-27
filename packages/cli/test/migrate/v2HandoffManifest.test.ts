import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  READER_PREFLIGHT_BUDGET_MS,
  V2_HANDOFF_MANIFEST_FILENAME,
  V2_HANDOFF_MANIFEST_SCHEMA_REL,
  V2_HANDOFF_SCHEMA_VERSION,
  parseV2HandoffManifest,
  readV2HandoffManifestFile,
  resolveMigrationUserStatePreflight,
} from "../../src/migrate/v2HandoffManifest.js";
import { planCleanupPhase } from "../../src/upgrade/migrateArtifactsV2ToV3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(__dirname, "fixtures");
const UPGRADE_FIXTURES = path.join(__dirname, "../upgrade/fixtures");
const SCHEMA_PATH = path.join(REPO_ROOT, V2_HANDOFF_MANIFEST_SCHEMA_REL);
const V2_MANIFEST_FIXTURE = path.join(FIXTURES, "v2-handoff-manifest.json");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "v2-handoff-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function loadFixtureManifest(): unknown {
  return JSON.parse(fs.readFileSync(V2_MANIFEST_FIXTURE, "utf8"));
}

describe("v2 handoff manifest contract", () => {
  it("references the shared schema document by path", () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    expect(schema).toContain(V2_HANDOFF_SCHEMA_VERSION);
    expect(schema).toContain("user_data_inventory_catalog");
    expect(schema).toContain(String(READER_PREFLIGHT_BUDGET_MS));
  });

  it("parses a v2-shaped fixture with every required field typed", () => {
    const manifest = parseV2HandoffManifest(loadFixtureManifest());
    expect(manifest.schema_version).toBe(V2_HANDOFF_SCHEMA_VERSION);
    expect(manifest.installed_v2_version).toBe("2.7.0");
    expect(manifest.app_home_path).toBe("/tmp/v2-app-home-realistic");
    expect(manifest.runtime_adapters).toEqual(["cursor", "codex"]);
    expect(manifest.user_data_inventory).toHaveLength(6);
    expect(manifest.user_data_inventory.filter((entry) => entry.kind === "directory")).toHaveLength(5);
    const profile = manifest.user_data_inventory.find((entry) => entry.id === "profile_files");
    expect(profile?.kind).toBe("profile_files");
    if (profile?.kind === "profile_files") {
      expect(profile.members).toHaveLength(2);
      expect(profile.members.every((member) => member.kind === "file")).toBe(true);
    }
    expect(manifest.user_data_inventory.find((entry) => entry.id === "benchmarks")?.exists).toBe(true);
    expect(manifest.user_data_inventory.find((entry) => entry.id === "history")?.exists).toBe(false);
  });

  it("rejects missing catalog ids and schema_version mismatches", () => {
    const base = loadFixtureManifest() as Record<string, unknown>;
    expect(() => parseV2HandoffManifest({ ...base, schema_version: "other" })).toThrow(/schema_version/);
    const inventory = (base.user_data_inventory as unknown[]).map((entry) =>
      (entry as { id?: string }).id === "profile_files"
        ? {
            id: "benchmarks",
            relative_path: "benchmarks-shadow",
            kind: "directory",
            exists: false,
          }
        : entry,
    );
    expect(() => parseV2HandoffManifest({ ...base, user_data_inventory: inventory })).toThrow(
      /profile_files/,
    );
    const brokenProfile = (base.user_data_inventory as unknown[]).map((entry) => {
      if ((entry as { id?: string }).id !== "profile_files") {
        return entry;
      }
      return { ...(entry as object), members: [{ relative_path: "PROFILE.md", kind: "file" }] };
    });
    expect(() => parseV2HandoffManifest({ ...base, user_data_inventory: brokenProfile })).toThrow(
      /exists/,
    );
  });

  it("reads a manifest from disk within the preflight budget", () => {
    const appHome = path.join(tmp, "app-home");
    fs.mkdirSync(appHome, { recursive: true });
    fs.writeFileSync(path.join(appHome, V2_HANDOFF_MANIFEST_FILENAME), JSON.stringify(loadFixtureManifest()));
    const result = readV2HandoffManifestFile(appHome);
    expect(result).not.toBeNull();
    expect(result!.manifest.installed_v2_version).toBe("2.7.0");
    expect(result!.elapsedMs).toBeLessThan(READER_PREFLIGHT_BUDGET_MS);
  });

  it("uses manifest inventory for migration preflight when present", () => {
    const appHome = fs.cpSync(path.join(UPGRADE_FIXTURES, "v2-app-home-realistic"), path.join(tmp, "realistic"), {
      recursive: true,
    });
    void appHome;
    const realistic = path.join(tmp, "realistic");
    const manifest = parseV2HandoffManifest(loadFixtureManifest());
    manifest.app_home_path = realistic;
    fs.writeFileSync(path.join(realistic, V2_HANDOFF_MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));

    const preflight = resolveMigrationUserStatePreflight(realistic);
    expect(preflight.source).toBe("manifest");
    expect(preflight.elapsedMs).toBeLessThan(READER_PREFLIGHT_BUDGET_MS);
    expect(preflight.preservedTopLevel).toEqual(["benchmarks", "intermediate", "sessions"]);

    const cleanup = planCleanupPhase({ appHome: realistic, project: realistic, home: tmp });
    expect(cleanup.status).toBe("pending");
    const removeItem = cleanup.items.find((item) => item.action === "remove-managed-app-home");
    expect(removeItem?.preserved?.some((p) => p.includes("benchmarks"))).toBe(true);
  });

  it("falls back to directory scan when the manifest is absent", () => {
    const realistic = fs.cpSync(path.join(UPGRADE_FIXTURES, "v2-app-home-realistic"), path.join(tmp, "scan"), {
      recursive: true,
    });
    void realistic;
    const appHome = path.join(tmp, "scan");
    const preflight = resolveMigrationUserStatePreflight(appHome);
    expect(preflight.source).toBe("scan");
    expect(preflight.manifest).toBeNull();
    expect(preflight.preservedTopLevel).toContain("benchmarks");
    expect(preflight.preservedTopLevel).toContain("intermediate");
    expect(preflight.preservedTopLevel).toContain("sessions");
  });

  it("round-trips disk inventory entries that exist on disk", () => {
    const realistic = fs.cpSync(path.join(UPGRADE_FIXTURES, "v2-app-home-realistic"), path.join(tmp, "roundtrip"), {
      recursive: true,
    });
    void realistic;
    const appHome = path.join(tmp, "roundtrip");
    const manifest = parseV2HandoffManifest(loadFixtureManifest());
    manifest.app_home_path = appHome;
    fs.writeFileSync(path.join(appHome, V2_HANDOFF_MANIFEST_FILENAME), JSON.stringify(manifest));

    const parsed = readV2HandoffManifestFile(appHome)!.manifest;
    for (const entry of parsed.user_data_inventory) {
      if (entry.kind === "directory" && entry.exists) {
        expect(fs.existsSync(path.join(appHome, entry.relative_path))).toBe(true);
      }
      if (entry.kind === "profile_files") {
        for (const member of entry.members) {
          if (member.exists) {
            expect(fs.existsSync(path.join(appHome, member.relative_path))).toBe(true);
          }
        }
      }
    }
  });
});
