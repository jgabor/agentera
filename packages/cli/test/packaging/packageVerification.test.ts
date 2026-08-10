import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

import { normalizeConstruction } from "../../scripts/package-construction.mjs";
import { DEVELOPMENT_RUNTIME_REQUIRED_FILES } from "../../src/core/developmentInvocation.js";
import {
  finalizePackageOwnerEvidence,
  observeCurrentPackageArtifact,
  observationDigest,
  PACKAGE_OWNER_EVIDENCE_SCHEMA,
  writeContentAddressedOwnerEvidence,
  writeContentAddressedPackageIdentity,
} from "../../src/validate/activationArtifactEvidence.js";
import {
  assertDeterministicPackagePair,
  assertNoForbiddenPathMatches,
  pathNeedles,
} from "./packageSetup.js";

const fixture = inject("packageFixture");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");

type BundleSurfaces = {
  directories: Array<{ path: string }>;
  files: Array<{ path: string }>;
  generated_files: Array<{ path: string }>;
};

const NPM_METADATA_FILES = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);

function unclassifiedManifestPaths(files: Iterable<string>, surfaces: BundleSurfaces): string[] {
  const allowedBundleFiles = new Set([
    ...surfaces.files.map(({ path: ownedPath }) => `bundle/${ownedPath}`),
    ...surfaces.generated_files.map(({ path: ownedPath }) => `bundle/${ownedPath}`),
  ]);
  const allowedBundleDirectories = surfaces.directories
    .map(({ path: ownedPath }) => `bundle/${ownedPath}/`);
  return [...files].filter((file) => {
    if (NPM_METADATA_FILES.has(file) || file.startsWith("dist/")) return false;
    if (allowedBundleFiles.has(file)) return false;
    return !allowedBundleDirectories.some((prefix) => file.startsWith(prefix));
  });
}

function currentDescriptorPaths(files: Iterable<string>): string[] {
  return [...files].filter((file) => file.startsWith("bundle/skills/agentera/agents/"));
}

function packageMetadata(): { name: string; version: string; publishConfig?: { tag?: string } } {
  return JSON.parse(fs.readFileSync(path.join(fixture.packageRoot, "package.json"), "utf8"));
}

function normalizedFixtureManifest() {
  const metadata = packageMetadata();
  return normalizeConstruction(fixture.manifest, {
    expectedName: metadata.name,
    expectedVersion: metadata.version,
    expectedTag: metadata.publishConfig?.tag ?? "next",
  });
}

describe("npm distribution boundary", () => {
  it("constructs in two roots, packs deterministic bytes, and rejects byte or path variance", () => {
    expect(fixture.deterministicBytes).toMatchObject({
      packRuns: 2,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      secondSha256: fixture.deterministicBytes.sha256,
    });
    expect(fixture.pathIndependence.constructionRoots).toHaveLength(2);
    expect(fixture.pathIndependence.extractedRoots).toHaveLength(1);
    expect(fixture.pathIndependence.constructionRoots.every((root) => /[ ;$()[\]]/u.test(root))).toBe(true);
    expect(fixture.pathIndependence.forbiddenPathMatches).toEqual([]);
    expect(fixture.pathIndependence.pathNeedleClasses).toEqual(expect.arrayContaining([
      "checkout-root:raw",
      "construction-root-primary:raw",
      "construction-root-secondary:raw",
      "extraction-root-primary:raw",
      "actual-home:raw",
      "developer-home-explicit:raw",
      "prohibited-intermediate-tier:raw",
      "developer-home-pattern:linux",
      "developer-home-pattern:macos",
      "developer-home-pattern:windows",
    ]));
    expect(fixture.pathIndependence.secondManifest.files).toEqual(fixture.manifest.files);
    expect(fixture.pathIndependence.secondManifest.integrity).toBe(fixture.manifest.integrity);
    expect(fixture.pathIndependence.secondManifest.shasum).toBe(fixture.manifest.shasum);
    expect(fixture.pathIndependence.regularFiles).toBe(fixture.manifest.files.length);
    expect(fixture.pathIndependence.contentSha256).toMatch(/^[a-f0-9]{64}$/u);

    const tarballPath = path.join(fixture.root, fixture.manifest.filename);
    const bytes = fs.readFileSync(tarballPath);
    const changedBytes = Buffer.from(bytes);
    changedBytes[changedBytes.length - 1] ^= 1;
    expect(() => assertDeterministicPackagePair(
      bytes,
      changedBytes,
      fixture.manifest,
      fixture.pathIndependence.secondManifest,
    )).toThrow(/independent construction roots produced different package bytes/u);

    const leakedRoot = fixture.pathIndependence.constructionRoots[1];
    const leak = path.join(fixture.packageRoot, "absolute-construction-root-leak.txt");
    fs.writeFileSync(leak, `${leakedRoot}\n`);
    try {
      expect(() => assertNoForbiddenPathMatches(
        fixture.packageRoot,
        pathNeedles("construction-root-secondary", leakedRoot),
      )).toThrow(/absolute-construction-root-leak\.txt:construction-root-secondary:raw/u);
    } finally {
      fs.rmSync(leak);
    }
  });

  it("accepts the real packed manifest and rejects a packed source map or unsafe executable mode", () => {
    expect(() => normalizedFixtureManifest()).not.toThrow();

    const sourceMap = structuredClone(fixture.manifest);
    sourceMap.files.push({ path: "dist/bin/agentera.js.map", size: 1, mode: 0o644 });
    expect(() => {
      const metadata = packageMetadata();
      normalizeConstruction(sourceMap, {
        expectedName: metadata.name,
        expectedVersion: metadata.version,
        expectedTag: metadata.publishConfig?.tag ?? "next",
      });
    }).toThrow(/forbidden source map 'dist\/bin\/agentera\.js\.map'/u);

    const wrongMode = structuredClone(fixture.manifest);
    wrongMode.files.find(({ path: file }) => file === "dist/bin/agentera.js")!.mode = 0o644;
    expect(() => {
      const metadata = packageMetadata();
      normalizeConstruction(wrongMode, {
        expectedName: metadata.name,
        expectedVersion: metadata.version,
        expectedTag: metadata.publishConfig?.tag ?? "next",
      });
    }).toThrow(/mode 644; expected 755/u);
  });

  it("binds layout, integrity, source-map absence, executable mode, and inventory", () => {
    let regularFiles = 0;
    for (const surface of ["dist", "bundle"]) {
      const pending = [path.join(fixture.packageRoot, surface)];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const name of fs.readdirSync(directory)) {
          const candidate = path.join(directory, name);
          const stat = fs.lstatSync(candidate);
          expect(stat.isSymbolicLink(), candidate).toBe(false);
          if (stat.isDirectory()) pending.push(candidate);
          else {
            expect(stat.isFile(), candidate).toBe(true);
            expect(stat.nlink, candidate).toBe(1);
            regularFiles += 1;
          }
        }
      }
    }
    expect(regularFiles).toBeGreaterThan(0);

    const tarball = fs.readFileSync(path.join(fixture.root, fixture.manifest.filename));
    expect(fixture.manifest.integrity).toBe(`sha512-${createHash("sha512").update(tarball).digest("base64")}`);
    expect(fixture.manifest.shasum).toBe(createHash("sha1").update(tarball).digest("hex"));
    const files = new Set(fixture.manifest.files.map(({ path: file }) => file));
    expect([...files].some((file) => file.endsWith(".map"))).toBe(false);
    expect(fixture.manifest.files.find(({ path: file }) => file === "dist/bin/agentera.js")?.mode).toBe(0o755);
    for (const required of [
      "dist/bin/agentera.js",
      "bundle/.agentera-npx-bundle.json",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      "bundle/references/artifacts/state-storage-authority.yaml",
    ]) expect(files.has(required), required).toBe(true);

    const authority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
      "utf8",
    ));
    const surfaces = authority.records.find((record: any) => record.identity.id === "agentera")
      .bundle_surfaces as BundleSurfaces;
    expect(unclassifiedManifestPaths(files, surfaces)).toEqual([]);
    expect(currentDescriptorPaths(files)).toEqual([]);
    expect([...files].some((file) => file.startsWith("src/") || file.startsWith("test/"))).toBe(false);
  });

  it("accepts an exact extraction and rejects missing, changed, or added files", () => {
    const tarballPath = path.join(fixture.root, fixture.manifest.filename);
    const bytes = fs.readFileSync(tarballPath);
    const observed = observeCurrentPackageArtifact(tarballPath, fixture.packageRoot);
    expect(observed).toMatchObject({
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      tarballSha256: createHash("sha256").update(bytes).digest("hex"),
      runtimeSupportPaths: ["node_modules"],
    });
    expect(observed.extractedTree.digest).toBe(observationDigest(observed.extractedTree.entries));
    expect(observed.tarballTree.digest).toBe(observationDigest(observed.tarballTree.entries));

    const packageJson = path.join(fixture.packageRoot, "package.json");
    const originalPackageJson = fs.readFileSync(packageJson);
    try {
      fs.appendFileSync(packageJson, "\n");
      expect(() => observeCurrentPackageArtifact(tarballPath, fixture.packageRoot)).toThrow(/does not exactly match/u);
    } finally {
      fs.writeFileSync(packageJson, originalPackageJson);
    }

    const readme = path.join(fixture.packageRoot, "README.md");
    const heldReadme = path.join(fixture.root, "held-readme");
    fs.renameSync(readme, heldReadme);
    try {
      expect(() => observeCurrentPackageArtifact(tarballPath, fixture.packageRoot)).toThrow(/does not exactly match/u);
    } finally {
      fs.renameSync(heldReadme, readme);
    }

    const addition = path.join(fixture.packageRoot, "unobserved-addition.txt");
    fs.writeFileSync(addition, "added after extraction\n");
    try {
      expect(() => observeCurrentPackageArtifact(tarballPath, fixture.packageRoot)).toThrow(/does not exactly match/u);
    } finally {
      fs.rmSync(addition);
    }
  });

  it("rejects native descriptors and unclassified top-level package surfaces", () => {
    expect(currentDescriptorPaths([
      "bundle/skills/agentera/SKILL.md",
      "bundle/skills/agentera/agents/build.toml",
      "bundle/.agentera/archive/legacy/skills/agentera/agents/build.toml",
    ])).toEqual(["bundle/skills/agentera/agents/build.toml"]);
    const surfaces: BundleSurfaces = {
      directories: [{ path: "skills" }, { path: "references" }],
      files: [{ path: "registry.json" }],
      generated_files: [{ path: ".agentera-npx-bundle.json" }],
    };
    expect(unclassifiedManifestPaths([
      "package.json",
      "dist/bin/agentera.js",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ], surfaces)).toEqual([".opencode/package.json", "plugin.json", ".cursor-plugin/plugin.json"]);
  });

  it("runs one extracted status smoke and emits boundary-only package evidence", async () => {
    const snapshotOutput = process.env.AGENTERA_ACTIVATION_PACKAGE_SNAPSHOT_OUTPUT;
    const { evidence, packageIdentity } = await finalizePackageOwnerEvidence({
      root: CHECKOUT_ROOT,
      fixture,
      requiredFiles: DEVELOPMENT_RUNTIME_REQUIRED_FILES,
      snapshotDirectory: snapshotOutput,
    });
    expect(evidence).toMatchObject({
      schemaVersion: PACKAGE_OWNER_EVIDENCE_SCHEMA,
      producerKind: "package-owner",
      packageIntegrity: fixture.manifest.integrity,
    });
    expect(evidence.records["package.extracted-smoke"].content).toMatchObject({
      identities: ["status"],
      bodies: { status: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } },
    });
    for (const semanticRef of [
      "capability.extracted-served",
      "package.command-policy",
      "package.adversarial",
      "bootstrap.extracted-classifications",
      "bootstrap.extracted-diagnostics",
      "bootstrap.source-package-parity",
      "bootstrap.missing-surface",
    ]) expect(evidence.records).not.toHaveProperty(semanticRef);

    const output = process.env.AGENTERA_ACTIVATION_PACKAGE_EVIDENCE_OUTPUT;
    const identityOutput = process.env.AGENTERA_ACTIVATION_PACKAGE_IDENTITY_OUTPUT;
    if (output || identityOutput || snapshotOutput) {
      expect(output).toBeTruthy();
      expect(identityOutput).toBeTruthy();
      expect(snapshotOutput).toBeTruthy();
      expect(writeContentAddressedOwnerEvidence(output!, evidence).digest).toBe(evidence.evidenceDigest);
      expect(writeContentAddressedPackageIdentity(identityOutput!, packageIdentity).digest).toBe(packageIdentity.identityDigest);
    }
  });
});
