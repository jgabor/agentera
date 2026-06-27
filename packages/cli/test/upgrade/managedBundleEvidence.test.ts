import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { hasManagedBundleEvidence } from "../../src/upgrade/migrateArtifactsV2ToV3.js";

let tmp: string;

function managedRoot(name: string): string {
  return path.join(tmp, name);
}

function writeV3Marker(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "3.0.0-next.1" }),
  );
}

function writeV2LegacyPair(root: string): void {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "agentera"), "#!/usr/bin/env python3\n");
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# agentera\n");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "managed-bundle-evidence-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("hasManagedBundleEvidence v3-awareness (#37)", () => {
  it("returns true when only the v3 BUNDLE_MARKER is present (V5 pass)", () => {
    const root = managedRoot("v3-marker-only");
    writeV3Marker(root);
    expect(hasManagedBundleEvidence(root)).toBe(true);
  });

  it("returns false when the v3 marker is absent and no v2 pair exists (V5 fail)", () => {
    const root = managedRoot("v3-marker-absent");
    fs.mkdirSync(root, { recursive: true });
    expect(hasManagedBundleEvidence(root)).toBe(false);
  });

  it("returns true when only the v2 scripts/agentera + SKILL.md pair is present (V5 pass)", () => {
    const root = managedRoot("v2-legacy-pair");
    writeV2LegacyPair(root);
    expect(hasManagedBundleEvidence(root)).toBe(true);
  });

  it("returns false when only one half of the v2 legacy pair is present (V5 fail)", () => {
    const root = managedRoot("v2-partial-script-only");
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "agentera"), "#!/usr/bin/env python3\n");
    expect(hasManagedBundleEvidence(root)).toBe(false);
  });

  it("returns false for an empty managed root (V5 pass)", () => {
    const root = managedRoot("empty");
    fs.mkdirSync(root, { recursive: true });
    expect(hasManagedBundleEvidence(root)).toBe(false);
  });

  it("returns false for an unknown root with unrelated files only (V5 fail)", () => {
    const root = managedRoot("unknown");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "registry.json"), "{}");
    expect(hasManagedBundleEvidence(root)).toBe(false);
  });
});
