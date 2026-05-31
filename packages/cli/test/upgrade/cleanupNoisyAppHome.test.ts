import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyCleanupPhase,
  planCleanupPhase,
} from "../../src/upgrade/migrateArtifactsV2ToV3.js";
import {
  assertChecksumsUnchanged,
  checksumManifest,
  listPreservedAppHomeRelPaths,
} from "./helpers/preservation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noisy-v2v3-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("cleanupNoisyAppHome", () => {

  it("applies cleanup without force on realistic app-home user dirs", () => {
    const appHome = fs.cpSync(path.join(FIXTURES, "v2-app-home-realistic"), path.join(tmp, "realistic"), {
      recursive: true,
    });
    void appHome;
    const realistic = path.join(tmp, "realistic");
    const before = checksumManifest(realistic, listPreservedAppHomeRelPaths(realistic));
    const preview = planCleanupPhase({ appHome: realistic, project: realistic, home: tmp });
    expect(preview.status).toBe("pending");
    applyCleanupPhase(preview);
    expect(preview.status).toBe("applied");
    expect(fs.existsSync(path.join(realistic, "app"))).toBe(false);
    expect(fs.existsSync(path.join(realistic, "benchmarks"))).toBe(true);
    expect(fs.existsSync(path.join(realistic, "intermediate"))).toBe(true);
    expect(fs.existsSync(path.join(realistic, "sessions"))).toBe(true);
    assertChecksumsUnchanged(realistic, before);
  });

  it("blocks cleanup when unrecognized app-home entries exist", () => {
    const appHome = fs.cpSync(path.join(FIXTURES, "v2-app-home-noisy"), path.join(tmp, "noisy"), {
      recursive: true,
    });
    void appHome;
    const noisy = path.join(tmp, "noisy");
    const phase = planCleanupPhase({ appHome: noisy, project: noisy, home: tmp });
    expect(phase.status).toBe("blocked");
    expect(phase.items[0]?.message).toMatch(/unrecognized entries/i);
    expect(fs.existsSync(path.join(noisy, "app"))).toBe(true);
  });

  it("applies cleanup with --force while preserving allowlisted paths", () => {
    const noisy = fs.cpSync(path.join(FIXTURES, "v2-app-home-noisy"), path.join(tmp, "force"), {
      recursive: true,
    });
    void noisy;
    const appHome = path.join(tmp, "force");
    const before = checksumManifest(appHome, listPreservedAppHomeRelPaths(appHome));
    const preview = planCleanupPhase({ appHome, project: appHome, home: tmp, force: true });
    expect(preview.status).toBe("pending");
    applyCleanupPhase(preview);
    expect(preview.status).toBe("applied");
    expect(fs.existsSync(path.join(appHome, "app"))).toBe(false);
    expect(fs.existsSync(path.join(appHome, "notes.txt"))).toBe(true);
    assertChecksumsUnchanged(appHome, before);
  });
});
