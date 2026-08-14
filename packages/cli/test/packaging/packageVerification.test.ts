import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

const fixture = inject("packageFixture");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");

type BundleSurfaces = {
  directories: Array<{ path: string }>;
  files: Array<{ path: string }>;
  generated_files: Array<{ path: string }>;
};

const NPM_METADATA_FILES = new Set(["package.json", "README.md", "LICENSE", "LICENSE.md"]);

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

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

function validateDistributionInventory(files: Set<string>, surfaces: BundleSurfaces): void {
  const required = [
    "dist/bin/agentera.js",
    "bundle/.agentera-npx-bundle.json",
    "bundle/registry.json",
    "bundle/skills/agentera/SKILL.md",
    "bundle/references/artifacts/state-storage-authority.yaml",
  ];
  const missing = required.filter((file) => !files.has(file));
  const unclassified = unclassifiedManifestPaths(files, surfaces);
  if (missing.length > 0 || unclassified.length > 0) {
    throw new Error(`invalid distribution inventory: missing=${missing.join(",")} unclassified=${unclassified.join(",")}`);
  }
}

function packageEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete env.AGENTERA_HOME;
  env.HOME = path.join(fixture.root, "isolated-home");
  return env;
}

describe("npm distribution boundary", () => {
  it("records deterministic, path-independent package construction from two roots", () => {
    expect(fixture.deterministicBytes).toMatchObject({
      packRuns: 2,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      secondSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fixture.deterministicBytes.secondSha256).toBe(fixture.deterministicBytes.sha256);
    expect(fixture.pathIndependence.constructionRoots).toHaveLength(2);
    expect(new Set(fixture.pathIndependence.constructionRoots).size).toBe(2);
    expect(fixture.pathIndependence.extractedRoots).toEqual([fixture.packageRoot]);
    expect(fixture.pathIndependence.regularFiles).toBeGreaterThan(0);
    expect(fixture.pathIndependence.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.pathIndependence.forbiddenPathMatches).toEqual([]);
    expect(fixture.pathIndependence.pathNeedleClasses).toContain("checkout-root:raw");
    expect(fixture.pathIndependence.secondManifest).toEqual(fixture.manifest);

    const tarball = fs.readFileSync(path.join(fixture.root, fixture.manifest.filename));
    expect(createHash("sha256").update(tarball).digest("hex")).toBe(fixture.deterministicBytes.sha256);
    expect(createHash("sha1").update(tarball).digest("hex")).toBe(fixture.manifest.shasum);
    expect(`sha512-${createHash("sha512").update(tarball).digest("base64")}`).toBe(fixture.manifest.integrity);
  });

  it("uses the fixture's isolated construction and extracted roots", () => {
    const constructedBin = path.join(fixture.constructionRoot, "dist/bin/agentera.js");
    const extractedBin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    expect(isContained(fixture.root, fixture.constructionRoot)).toBe(true);
    expect(isContained(fixture.root, fixture.packageRoot)).toBe(true);
    expect(isContained(fixture.constructionRoot, fixture.packageRoot)).toBe(false);
    expect(isContained(CHECKOUT_ROOT, fixture.constructionRoot)).toBe(false);
    expect(fs.realpathSync(constructedBin)).toBe(constructedBin);
    expect(fs.realpathSync(extractedBin)).toBe(extractedBin);
    for (const surface of ["dist", "bundle"]) {
      expect(JSON.parse(fs.readFileSync(
        path.join(fixture.packageRoot, surface, ".agentera-build-source.json"),
        "utf8",
      ))).toEqual(fixture.sourceIdentity);
    }
  });

  it("extracts the manifest as regular files with the executable mode and no source maps", () => {
    const manifestFiles = new Map(fixture.manifest.files.map((entry) => [entry.path, entry]));
    let diskFiles = 0;
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
            const relative = path.relative(fixture.packageRoot, candidate).split(path.sep).join("/");
            expect(manifestFiles.has(relative), relative).toBe(true);
            expect(stat.mode & 0o777, relative).toBe(manifestFiles.get(relative)!.mode);
            diskFiles += 1;
          }
        }
      }
    }
    expect(diskFiles).toBe([...manifestFiles.keys()].filter((file) => file.startsWith("dist/") || file.startsWith("bundle/")).length);
    expect([...manifestFiles.keys()].some((file) => file.endsWith(".map"))).toBe(false);
    expect(manifestFiles.get("dist/bin/agentera.js")!.mode & 0o111).not.toBe(0);
  });

  it("rejects incomplete or unclassified inventory before accepting the extracted inventory", () => {
    const authority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
      "utf8",
    )) as any;
    const surfaces = authority.records.find((record: any) => record.identity.id === "agentera")
      .bundle_surfaces as BundleSurfaces;
    const files = new Set(fixture.manifest.files.map((entry) => entry.path));
    const incomplete = new Set(files);
    incomplete.delete("dist/bin/agentera.js");
    incomplete.add("plugin.json");

    expect(() => validateDistributionInventory(incomplete, surfaces))
      .toThrow("invalid distribution inventory: missing=dist/bin/agentera.js unclassified=plugin.json");
    expect(() => validateDistributionInventory(files, surfaces)).not.toThrow();
    expect([...files].some((file) => file.startsWith("src/") || file.startsWith("test/"))).toBe(false);
    expect([...files].some((file) => file.endsWith(".map"))).toBe(false);
    expect([...files].some((file) => file.startsWith("bundle/skills/agentera/agents/"))).toBe(false);
    for (const retired of [
      "dist/registries/runtimeAdapterRegistry.js",
      "bundle/references/adapters/runtime-adapter-registry.yaml",
      "bundle/references/adapters/opencode.md",
      "bundle/references/adapters/cursor.md",
    ]) {
      expect(files.has(retired), retired).toBe(false);
    }
  });

  it("runs one status smoke from the extracted package", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = spawnSync(
      process.execPath,
      [bin, "prime", "--context", "status", "--format", "json"],
      { cwd: fixture.root, env: packageEnvironment(), encoding: "utf8" },
    );
    expect(result.status, `extracted status smoke failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      capability_context: { capability: string };
    };
    expect(payload.capability_context.capability).toBe("status");
  });
});
