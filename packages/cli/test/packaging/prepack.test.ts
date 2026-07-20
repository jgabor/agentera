import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateRegistryData } from "../../src/registries/packageRegistry.js";

/**
 * T1 packaging integration test for the v3 Agentera CLI.
 *
 * Three distribution surfaces are exercised with paired pass/fail cases
 * (per V5 proportionality):
 *
 *   1. single-binary (Bun `bun build --compile`)
 *   2. npm-tarball  (`npm pack --dry-run --json` against `packages/cli/`)
 *   3. prepack      (`node packages/cli/scripts/copy-bundle.mjs`)
 *
 * The "fail" cases are the negative regressions: they run the same
 * machinery the "pass" cases exercise, but assert the regression
 * condition. They are green on the post-T1 tree; they turn red the
 * instant a future build step silently drops data or skips `prepack`.
 *
 * See `docs/packaging/v3-packaging.md` for the full design.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "..", "..");
const PKG_JSON = path.join(PKG_ROOT, "package.json");

interface PackFile {
  path: string;
  size: number;
  mode: number;
}

interface PackEntry {
  id: string;
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  shasum: string;
  filename: string;
  files: PackFile[];
}

function readPackageJson(): {
  name: string;
  version: string;
  agentera: { suiteVersion: string; gitRef: string };
  files: string[];
  bin: Record<string, string>;
} {
  return JSON.parse(fs.readFileSync(PKG_JSON, "utf8"));
}

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // npm 11+ exits non-zero when an env var prefixed with `npm_config_` is
  // set to a key it does not recognize. The vitest environment can inherit
  // unknown keys from the test runner (e.g. `verify-deps-before-run`,
  // `_jsr-registry`, `npm-globalconfig`). Strip them so `npm pack` succeeds.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("npm_config_")) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackFile(value: unknown): value is PackFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.mode === "number"
  );
}

function isPackEntry(value: unknown): value is PackEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.size === "number" &&
    typeof value.unpackedSize === "number" &&
    typeof value.shasum === "string" &&
    typeof value.filename === "string" &&
    Array.isArray(value.files) &&
    value.files.every(isPackFile)
  );
}

/**
 * npm 12 changed --json output from a one-item array to an object keyed by
 * package name. Keep the compatibility boundary in the test harness rather
 * than changing the packaging contract being tested.
 */
function parsePackManifest(stdout: string): PackEntry {
  const output = stdout.trim();
  if (output.length === 0) {
    throw new Error("npm pack --dry-run --json produced empty stdout");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`npm pack --dry-run --json produced invalid JSON: ${detail}`);
  }

  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? Object.values(parsed) : null;
  if (entries === null) {
    throw new Error(
      "npm pack --dry-run --json must return a JSON array or package-name object",
    );
  }
  if (entries.length !== 1) {
    throw new Error(
      `npm pack --dry-run --json returned ${entries.length} package entries; expected exactly one`,
    );
  }
  if (!isPackEntry(entries[0])) {
    throw new Error(
      "npm pack --dry-run --json returned a package entry without the required manifest fields",
    );
  }
  return entries[0];
}

/**
 * Read the `npm pack --dry-run --json` manifest from the package output built
 * once by Vitest global setup. Worker tests never rebuild shared dist/ or
 * bundle/ because other parallel workers consume those directories.
 */
function packManifestDirect(): PackEntry {
  const env = scrubbedEnv({ npm_config_ignore_scripts: "true" });
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: PKG_ROOT,
    encoding: "utf8",
    env,
  });
  expect(r.status, `npm pack --ignore-scripts must succeed; stderr=${r.stderr.slice(0, 800)}`).toBe(
    0,
  );
  return parsePackManifest(r.stdout);
}

function paths(manifest: PackEntry): Set<string> {
  return new Set(manifest.files.map((f) => f.path));
}

describe("npm pack JSON manifest parser", () => {
  const entry: PackEntry = {
    id: "agentera@3.0.0-dev.21",
    name: "agentera",
    version: "3.0.0-dev.21",
    size: 1,
    unpackedSize: 2,
    shasum: "deadbeef",
    filename: "agentera-3.0.0-dev.21.tgz",
    files: [{ path: "dist/bin/agentera.js", size: 1, mode: 420 }],
  };

  it("accepts the legacy one-item array output", () => {
    expect(parsePackManifest(JSON.stringify([entry]))).toEqual(entry);
  });

  it("accepts the npm 12 package-name-keyed object output", () => {
    expect(parsePackManifest(JSON.stringify({ agentera: entry }))).toEqual(entry);
  });

  it("rejects empty output with an actionable error", () => {
    expect(() => parsePackManifest("\n")).toThrow(
      "npm pack --dry-run --json produced empty stdout",
    );
  });

  it("rejects malformed JSON with an actionable error", () => {
    expect(() => parsePackManifest("{not-json")).toThrow(
      "npm pack --dry-run --json produced invalid JSON",
    );
  });

  it("rejects output without exactly one valid package entry", () => {
    expect(() => parsePackManifest("{}")).toThrow(
      "npm pack --dry-run --json returned 0 package entries; expected exactly one",
    );
  });
});

describe("v3 packaging (T1)", () => {
  describe("npm-tarball surface (npm pack --dry-run --json)", () => {
    it("PASS: tarball manifest contains dist/bin/agentera.js (bin entrypoint is shipped)", () => {
      const manifest = packManifestDirect();
      const filePaths = paths(manifest);
      expect(filePaths.has("dist/bin/agentera.js")).toBe(true);
    });

    it("PASS: tarball contains only the CLI and canonical shared-skill data", () => {
      const manifest = packManifestDirect();
      const filePaths = paths(manifest);
      for (const required of [
        "dist/bin/agentera.js",
        "bundle/.agentera-npx-bundle.json",
        "bundle/registry.json",
        "bundle/skills/agentera/SKILL.md",
        "bundle/skills/agentera/agents/build.toml",
        "bundle/skills/agentera/capabilities/build/schemas/artifacts.yaml",
        "bundle/skills/agentera/schemas/artifacts/plan.yaml",
        "bundle/references/artifacts/state-storage-authority.yaml",
      ]) {
        expect(filePaths.has(required), required).toBe(true);
      }
      expect([...filePaths].some((p) => p.startsWith("bundle/references/"))).toBe(true);
      expect([...filePaths].some((p) => p.startsWith("bundle/skills/agentera/capabilities/"))).toBe(
        true,
      );
      for (const nativePrefix of [
        "bundle/plugin.json",
        "bundle/.agents/",
        "bundle/.codex-plugin/",
        "bundle/.cursor-plugin/",
        "bundle/.cursor/",
        "bundle/.github/",
        "bundle/.opencode/",
        "bundle/agents/",
        "bundle/hooks/",
        "bundle/plugins/",
      ]) {
        expect(
          [...filePaths].some((candidate) => candidate.startsWith(nativePrefix)),
          nativePrefix,
        ).toBe(false);
      }
      for (const nativeDescriptor of [
        "plugin.json",
        ".github/plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".cursor-plugin/plugin.json",
        ".agents/plugins/marketplace.json",
        ".opencode/package.json",
        ".opencode/plugins/agentera.js",
        "agents/openai.yaml",
        "plugins/agentera",
      ]) {
        expect(filePaths.has(nativeDescriptor), nativeDescriptor).toBe(false);
      }
      expect([...filePaths].some((p) => p.startsWith("bundle/.claude-plugin/"))).toBe(false);
    });

    it("PASS: an extracted tarball boots the CLI directly", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-pack-boot-"));
      try {
        const packed = spawnSync(
          "npm",
          ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp],
          { cwd: PKG_ROOT, encoding: "utf8", env: scrubbedEnv() },
        );
        expect(packed.status, `npm pack must succeed; stderr=${packed.stderr.slice(0, 800)}`).toBe(0);
        const tarball = path.join(tmp, parsePackManifest(packed.stdout).filename);
        const extracted = spawnSync("tar", ["-xzf", tarball, "-C", tmp], { encoding: "utf8" });
        expect(extracted.status, `tar extraction must succeed; stderr=${extracted.stderr}`).toBe(0);
        fs.symlinkSync(path.join(PKG_ROOT, "node_modules"), path.join(tmp, "package", "node_modules"));

        const boot = spawnSync(
          process.execPath,
          [path.join(tmp, "package", "dist", "bin", "agentera.js"), "--help"],
          { cwd: tmp, encoding: "utf8" },
        );
        expect(boot.status, `extracted CLI must boot; stderr=${boot.stderr.slice(0, 800)}`).toBe(0);
        expect(boot.stdout).toContain("agentera");
        expect(boot.stdout).toContain("prime");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("PASS: production source and packed files contain no test environment token", () => {
      const forbidden = "AGENTERA_TEST_";
      const sourceRoot = path.join(PKG_ROOT, "src");
      const productionFiles = fs.readdirSync(sourceRoot, { recursive: true })
        .map(String)
        .map((relative) => path.join(sourceRoot, relative))
        .filter((file) => fs.statSync(file).isFile());
      const packedFiles = packManifestDirect().files
        .map((file) => path.join(PKG_ROOT, file.path))
        .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
      const offenders = [...new Set([...productionFiles, ...packedFiles])]
        .filter((file) => fs.readFileSync(file).includes(forbidden))
        .map((file) => path.relative(PKG_ROOT, file));

      expect(offenders).toEqual([]);
    });

    it("FAIL (regression): if `files: [dist, bundle]` is dropped, the manifest loses bundle/", () => {
      const pkg = readPackageJson();
      const without = pkg.files.filter((f) => f !== "bundle");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prepack-neg-"));
      const fixturePkg = path.join(tmp, "package.json");
      try {
        fs.writeFileSync(fixturePkg, JSON.stringify({ ...pkg, files: without }, null, 2));
        const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--pack-destination", tmp], {
          cwd: tmp,
          encoding: "utf8",
          env: scrubbedEnv({ npm_config_ignore_scripts: "true" }),
        });
        expect(r.status, "npm pack must succeed").toBe(0);
        const filePaths = paths(parsePackManifest(r.stdout));
        expect(filePaths.has("bundle/.agentera-npx-bundle.json")).toBe(false);
        expect(filePaths.has("bundle/registry.json")).toBe(false);
        expect(filePaths.has("bundle/skills/agentera/SKILL.md")).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("FAIL (regression): if `files: [dist, bundle]` is dropped, dist/bin/agentera.js is also dropped when dist is removed", () => {
      const pkg = readPackageJson();
      const without = pkg.files.filter((f) => f !== "dist");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prepack-neg-dist-"));
      const fixturePkg = path.join(tmp, "package.json");
      try {
        fs.writeFileSync(fixturePkg, JSON.stringify({ ...pkg, files: without }, null, 2));
        const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--pack-destination", tmp], {
          cwd: tmp,
          encoding: "utf8",
          env: scrubbedEnv({ npm_config_ignore_scripts: "true" }),
        });
        expect(r.status, "npm pack must succeed").toBe(0);
        const filePaths = paths(parsePackManifest(r.stdout));
        expect(filePaths.has("dist/bin/agentera.js")).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("prepack surface (copy-bundle.mjs)", () => {
    function stageFakeRepo(opts: { omitSkills: boolean }): string {
      const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepack-fake-"));
      if (!opts.omitSkills) {
        fs.mkdirSync(path.join(fakeRoot, "skills", "agentera", "capabilities"), {
          recursive: true,
        });
        fs.writeFileSync(path.join(fakeRoot, "skills", "agentera", "SKILL.md"), "# Fixture\n");
        fs.writeFileSync(
          path.join(fakeRoot, "skills", "agentera", "protocol.yaml"),
          "schemaVersion: agentera.protocol.v1\n",
        );
      }
      fs.mkdirSync(path.join(fakeRoot, "references"), { recursive: true });
      fs.writeFileSync(path.join(fakeRoot, "references", "fixture.md"), "# Fixture\n");
      fs.mkdirSync(path.join(fakeRoot, "references", "adapters"), { recursive: true });
      fs.copyFileSync(
        path.join(REPO_ROOT, "references", "adapters", "package-registry.yaml"),
        path.join(fakeRoot, "references", "adapters", "package-registry.yaml"),
      );
      fs.mkdirSync(path.join(fakeRoot, "references", "artifacts"), { recursive: true });
      fs.writeFileSync(
        path.join(fakeRoot, "references", "artifacts", "state-storage-authority.yaml"),
        "schema_version: fixture.authority.v1\n",
      );
      if (!opts.omitSkills) {
        fs.mkdirSync(path.join(fakeRoot, "skills", "agentera", "schemas", "artifacts"), { recursive: true });
        fs.writeFileSync(
          path.join(fakeRoot, "skills", "agentera", "schemas", "artifacts", "experiments.yaml"),
          "meta:\n  name: experiments\n",
        );
      }
      fs.writeFileSync(path.join(fakeRoot, "registry.json"), JSON.stringify({ skills: [] }));
      for (const sourceFile of ["README.md", "UPGRADE.md", "CHANGELOG.md", "DESIGN.md", "LICENSE"]) {
        fs.writeFileSync(path.join(fakeRoot, sourceFile), "fixture\n");
      }
      const fakePkg = path.join(fakeRoot, "packages", "cli");
      fs.mkdirSync(path.join(fakePkg, "scripts"), { recursive: true });
      fs.symlinkSync(path.join(PKG_ROOT, "node_modules"), path.join(fakePkg, "node_modules"));
      fs.cpSync(path.join(PKG_ROOT, "dist"), path.join(fakePkg, "dist"), { recursive: true });
      fs.copyFileSync(
        path.join(PKG_ROOT, "scripts", "copy-bundle.mjs"),
        path.join(fakePkg, "scripts", "copy-bundle.mjs"),
      );
      fs.writeFileSync(
        path.join(fakePkg, "package.json"),
        JSON.stringify({
          name: "agentera-fixture",
          version: "9.9.9-fixture",
          agentera: { suiteVersion: "9.9.9-fixture", gitRef: "fixture" },
          files: ["dist", "bundle"],
        }),
      );
      return fakeRoot;
    }

    function registryPath(fakeRoot: string): string {
      return path.join(fakeRoot, "references", "adapters", "package-registry.yaml");
    }

    function readRegistry(fakeRoot: string): any {
      return YAML.parse(fs.readFileSync(registryPath(fakeRoot), "utf8"));
    }

    function writeRegistry(fakeRoot: string, registry: unknown): void {
      fs.writeFileSync(registryPath(fakeRoot), YAML.stringify(registry));
    }

    function runCopyBundle(fakeRoot: string) {
      return spawnSync(
        "node",
        [path.join(fakeRoot, "packages", "cli", "scripts", "copy-bundle.mjs")],
        { cwd: fakeRoot, encoding: "utf8" },
      );
    }

    function seedProtectedState(fakeRoot: string): { bundleFile: string; outsideFile: string } {
      const bundleFile = path.join(fakeRoot, "packages", "cli", "bundle", "preserved.txt");
      const outsideFile = path.join(fakeRoot, "outside-sentinel.txt");
      fs.mkdirSync(path.dirname(bundleFile), { recursive: true });
      fs.writeFileSync(bundleFile, "bundle-before\n");
      fs.writeFileSync(outsideFile, "outside-before\n");
      return { bundleFile, outsideFile };
    }

    function expectProtectedState(paths: { bundleFile: string; outsideFile: string }): void {
      expect(fs.readFileSync(paths.bundleFile, "utf8")).toBe("bundle-before\n");
      expect(fs.readFileSync(paths.outsideFile, "utf8")).toBe("outside-before\n");
    }

    it("PASS: copy-bundle.mjs stages bundle/, sentinel, registry.json, skills/, references/", () => {
      const fakeRoot = stageFakeRepo({ omitSkills: false });
      try {
        const fakePkg = path.join(fakeRoot, "packages", "cli");
        const bundle = path.join(fakePkg, "bundle");
        const r = runCopyBundle(fakeRoot);
        expect(r.status, `copy-bundle must succeed; stderr=${r.stderr}`).toBe(0);
        expect(fs.existsSync(path.join(bundle, ".agentera-npx-bundle.json"))).toBe(true);
        expect(fs.existsSync(path.join(bundle, "registry.json"))).toBe(true);
        expect(fs.existsSync(path.join(bundle, "skills", "agentera", "SKILL.md"))).toBe(true);
        expect(fs.existsSync(path.join(bundle, ".opencode"))).toBe(false);
        expect(fs.existsSync(path.join(bundle, ".codex-plugin"))).toBe(false);
        expect(fs.existsSync(path.join(bundle, ".cursor-plugin"))).toBe(false);
        expect(fs.existsSync(path.join(bundle, "plugin.json"))).toBe(false);
        expect(fs.readFileSync(
          path.join(bundle, "references", "artifacts", "state-storage-authority.yaml"),
          "utf8",
        )).toBe("schema_version: fixture.authority.v1\n");
        expect(fs.readFileSync(
          path.join(bundle, "skills", "agentera", "schemas", "artifacts", "experiments.yaml"),
          "utf8",
        )).toBe("meta:\n  name: experiments\n");
        const refs = fs.readdirSync(path.join(bundle, "references"));
        expect(refs.length).toBeGreaterThan(0);

        const sentinel = JSON.parse(
          fs.readFileSync(path.join(bundle, ".agentera-npx-bundle.json"), "utf8"),
        );
        expect(sentinel.kind).toBe("agentera-npx-bundle");
        expect(sentinel.suiteVersion).toBe("9.9.9-fixture");
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });

    it("FAIL (regression): copy-bundle.mjs fails (non-zero exit) if a data surface is missing", () => {
      const fakeRoot = stageFakeRepo({ omitSkills: true });
      try {
        const r = runCopyBundle(fakeRoot);
        expect(
          r.status,
          `copy-bundle must fail when skills/ is missing; stderr=${r.stderr}`,
        ).not.toBe(0);
        expect(r.stderr).toContain('source id "skills" path "skills" is missing');
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });

    it("FAIL (regression): copy-bundle.mjs rejects string-list bundle entries", () => {
      const fakeRoot = stageFakeRepo({ omitSkills: false });
      try {
        const registry = readRegistry(fakeRoot);
        registry.records[0].bundle_surfaces.directories = ["skills"];
        writeRegistry(fakeRoot, registry);

        const r = runCopyBundle(fakeRoot);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain(
          "records[0].bundle_surfaces.directories[0] must be an object",
        );
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });

    it.each([
      {
        label: "duplicate id across lists",
        mutate: (registry: any) => {
          registry.records[0].bundle_surfaces.files[0].id = "skills";
        },
        expected: 'files[0].id "skills" duplicates records[0].bundle_surfaces.directories[0].id',
      },
      {
        label: "duplicate path across lists",
        mutate: (registry: any) => {
          registry.records[0].bundle_surfaces.files[0].path = "skills";
        },
        expected: 'files[0].path "skills" for id "readme" duplicates records[0].bundle_surfaces.directories[0].path',
      },
      ...[
        "",
        "../outside",
        "./README.md",
        "/tmp/outside",
        "C:/outside/file",
        "C:\\outside\\file",
        "nested\\file",
        "README.md/",
        "nested//file",
      ].map((invalidPath) => ({
        label: `invalid path ${JSON.stringify(invalidPath)}`,
        mutate: (registry: any) => {
          registry.records[0].bundle_surfaces.files[0].path = invalidPath;
        },
        expected: `files[0].path ${JSON.stringify(invalidPath)} for id "readme" is invalid`,
      })),
    ])("fails before side effects for $label and matches loader rejection", ({ mutate, expected }) => {
      const fakeRoot = stageFakeRepo({ omitSkills: false });
      try {
        const protectedState = seedProtectedState(fakeRoot);
        const registry = readRegistry(fakeRoot);
        mutate(registry);
        const loaderErrors = validateRegistryData(registry, fakeRoot);
        const loaderError = loaderErrors.find((error) => error.includes(expected));
        expect(loaderError, `loader must reject ${expected}`).toBeDefined();
        writeRegistry(fakeRoot, registry);

        const result = runCopyBundle(fakeRoot);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(loaderError!);
        expectProtectedState(protectedState);
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });

    it("fails before side effects when a source symlink escapes the source root", () => {
      const fakeRoot = stageFakeRepo({ omitSkills: false });
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "prepack-source-escape-"));
      try {
        const protectedState = seedProtectedState(fakeRoot);
        fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside-source-before\n");
        fs.rmSync(path.join(fakeRoot, "skills"), { recursive: true, force: true });
        try {
          fs.symlinkSync(outside, path.join(fakeRoot, "skills"), "dir");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return;
          throw error;
        }

        const result = runCopyBundle(fakeRoot);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'source id "skills" path "skills" resolves outside source root',
        );
        expectProtectedState(protectedState);
        expect(fs.readFileSync(path.join(outside, "sentinel.txt"), "utf8")).toBe(
          "outside-source-before\n",
        );
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it("fails before side effects when recursive and explicit sources share a destination", () => {
      const fakeRoot = stageFakeRepo({ omitSkills: false });
      try {
        const protectedState = seedProtectedState(fakeRoot);
        const registry = readRegistry(fakeRoot);
        registry.records[0].bundle_surfaces.files.push({
          id: "nested-skill",
          path: "skills/agentera/SKILL.md",
        });
        expect(validateRegistryData(registry, fakeRoot)).toEqual([]);
        writeRegistry(fakeRoot, registry);

        const result = runCopyBundle(fakeRoot);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'destination id "nested-skill" path "skills/agentera/SKILL.md" duplicates id "skills" path "skills/agentera/SKILL.md"',
        );
        expectProtectedState(protectedState);
      } finally {
        fs.rmSync(fakeRoot, { recursive: true, force: true });
      }
    });
  });

  describe("single-binary surface (bun build --compile)", () => {
    let tmp: string;

    function removeBunBuildArtifacts(dir: string): void {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith(".bun-build")) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    }

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bun-binary-"));
    });

    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      removeBunBuildArtifacts(PKG_ROOT);
    });

    function bunAvailable(): boolean {
      const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
      return r.status === 0 && r.stdout.trim().length > 0;
    }

    it("PASS: bun build --compile dist/bin/agentera.js produces an executable file", () => {
      if (!bunAvailable()) {
        throw new Error("bun is required for the single-binary smoke gate; install bun >= 1.1.x");
      }
      const outfile = path.join(tmp, "agentera-single-binary");
      const r = spawnSync(
        "bun",
        [
          "build",
          "--compile",
          path.join(PKG_ROOT, "dist", "bin", "agentera.js"),
          "--outfile",
          outfile,
        ],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(r.status, `bun build --compile must succeed; stderr=${r.stderr.slice(0, 500)}`).toBe(
        0,
      );
      expect(fs.existsSync(outfile)).toBe(true);
      const stat = fs.statSync(outfile);
      expect(stat.size).toBeGreaterThan(1_000_000);
      expect(stat.mode & 0o111).not.toBe(0);

      fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
      fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
      const prime = spawnSync(outfile, ["prime", "--format", "json"], {
        cwd: tmp,
        encoding: "utf8",
        env: { ...process.env, AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(PKG_ROOT, "../..") },
      });
      expect(
        prime.status,
        `single-binary prime must exit 0; stderr=${prime.stderr.slice(0, 500)}`,
      ).toBe(0);
      const payload = JSON.parse(prime.stdout);
      expect(payload.command).toBe("prime");
      expect(payload.status).toBe("ok");
      expect(payload).toHaveProperty("app_home");
      expect(payload).toHaveProperty("app");
    });

    it("FAIL (regression): bun build --compile of a missing entrypoint exits non-zero", () => {
      if (!bunAvailable()) {
        throw new Error(
          "bun is required for the single-binary regression gate; install bun >= 1.1.x",
        );
      }
      const outfile = path.join(tmp, "agentera-bogus-binary");
      const r = spawnSync(
        "bun",
        [
          "build",
          "--compile",
          path.join(PKG_ROOT, "dist", "bin", "does-not-exist.js"),
          "--outfile",
          outfile,
        ],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(r.status, "bun build --compile of a missing entrypoint must fail").not.toBe(0);
      expect(fs.existsSync(outfile)).toBe(false);
    });
  });
});
