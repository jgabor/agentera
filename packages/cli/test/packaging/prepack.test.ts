import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

/**
 * Build the package (tsc + copy-bundle) and read the `npm pack --dry-run
 * --json` manifest. We bypass the `prepack` npm-script because the script
 * is the surface we want to validate independently; the assertion still
 * checks the package layout: dist/bin/agentera.js + bundle/ + sentinel.
 */
function packManifestDirect(): PackEntry {
  const env = scrubbedEnv({ npm_config_ignore_scripts: "true" });
  // Invoke the TypeScript compiler via its lib/tsc.js shim so the test does
  // not depend on the shell-wrapper at node_modules/.bin/tsc (which is a
  // /bin/sh script and not directly executable as a Node module).
  const tscEntry = path.join(PKG_ROOT, "node_modules", "typescript", "lib", "tsc.js");
  const tsc = spawnSync("node", [tscEntry, "-p", "tsconfig.json"], {
    encoding: "utf8",
    env,
    cwd: PKG_ROOT,
  });
  expect(
    tsc.status,
    `tsc must succeed in packManifestDirect; stderr=${tsc.stderr.slice(0, 800)}`,
  ).toBe(0);
  const copy = spawnSync("node", [path.join(PKG_ROOT, "scripts", "copy-bundle.mjs")], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
  });
  expect(
    copy.status,
    `copy-bundle must succeed in packManifestDirect; stderr=${copy.stderr.slice(0, 800)}`,
  ).toBe(0);
  const r = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: PKG_ROOT, encoding: "utf8", env },
  );
  expect(
    r.status,
    `npm pack --ignore-scripts must succeed; stderr=${r.stderr.slice(0, 800)}`,
  ).toBe(0);
  const start = r.stdout.indexOf("[");
  expect(start, "npm pack --json must emit a JSON array").toBeGreaterThanOrEqual(0);
  const parsed = JSON.parse(r.stdout.slice(start)) as PackEntry[];
  expect(parsed.length).toBe(1);
  return parsed[0];
}

function paths(manifest: PackEntry): Set<string> {
  return new Set(manifest.files.map((f) => f.path));
}

describe("v3 packaging (T1)", () => {
  describe("npm-tarball surface (npm pack --dry-run --json)", () => {
    it("PASS: tarball manifest contains dist/bin/agentera.js (bin entrypoint is shipped)", () => {
      const manifest = packManifestDirect();
      const filePaths = paths(manifest);
      expect(filePaths.has("dist/bin/agentera.js")).toBe(true);
    });

    it("PASS: tarball manifest contains bundle/ data surfaces (self-contained npx install)", () => {
      const manifest = packManifestDirect();
      const filePaths = paths(manifest);
      expect(filePaths.has("bundle/.agentera-npx-bundle.json")).toBe(true);
      expect(filePaths.has("bundle/registry.json")).toBe(true);
      expect(filePaths.has("bundle/skills/agentera/SKILL.md")).toBe(true);
      expect([...filePaths].some((p) => p.startsWith("bundle/references/"))).toBe(true);
      expect([...filePaths].some((p) => p.startsWith("bundle/skills/agentera/capabilities/")))
        .toBe(true);
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
        const start = r.stdout.indexOf("[");
        const parsed = JSON.parse(r.stdout.slice(start)) as PackEntry[];
        const filePaths = new Set(parsed[0]?.files.map((f) => f.path) ?? []);
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
        const start = r.stdout.indexOf("[");
        const parsed = JSON.parse(r.stdout.slice(start)) as PackEntry[];
        const filePaths = new Set(parsed[0]?.files.map((f) => f.path) ?? []);
        expect(filePaths.has("dist/bin/agentera.js")).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("prepack surface (copy-bundle.mjs)", () => {
    const REAL_BUNDLE = path.join(PKG_ROOT, "bundle");

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
      fs.writeFileSync(path.join(fakeRoot, "registry.json"), JSON.stringify({ skills: [] }));
      const fakePkg = path.join(fakeRoot, "packages", "cli");
      fs.mkdirSync(path.join(fakePkg, "scripts"), { recursive: true });
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

    it("PASS: copy-bundle.mjs stages bundle/, sentinel, registry.json, skills/, references/", () => {
      const prevSentinel = fs.existsSync(REAL_BUNDLE)
        ? fs.readFileSync(path.join(REAL_BUNDLE, ".agentera-npx-bundle.json"), "utf8")
        : null;
      try {
        const r = spawnSync("node", [path.join(PKG_ROOT, "scripts", "copy-bundle.mjs")], {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        expect(r.status, `copy-bundle must succeed; stderr=${r.stderr}`).toBe(0);
        expect(fs.existsSync(path.join(REAL_BUNDLE, ".agentera-npx-bundle.json"))).toBe(true);
        expect(fs.existsSync(path.join(REAL_BUNDLE, "registry.json"))).toBe(true);
        expect(fs.existsSync(path.join(REAL_BUNDLE, "skills", "agentera", "SKILL.md"))).toBe(true);
        const refs = fs.readdirSync(path.join(REAL_BUNDLE, "references"));
        expect(refs.length).toBeGreaterThan(0);

        const sentinel = JSON.parse(
          fs.readFileSync(path.join(REAL_BUNDLE, ".agentera-npx-bundle.json"), "utf8"),
        );
        expect(sentinel.kind).toBe("agentera-npx-bundle");
        expect(sentinel.suiteVersion).toBe(readPackageJson().agentera.suiteVersion);
      } finally {
        if (prevSentinel !== null) {
          fs.writeFileSync(path.join(REAL_BUNDLE, ".agentera-npx-bundle.json"), prevSentinel);
        }
      }
    });

    it("FAIL (regression): copy-bundle.mjs fails (non-zero exit) if a data surface is missing", () => {
      const fakeRoot = stageFakeRepo({ omitSkills: true });
      try {
        const r = spawnSync(
          "node",
          [path.join(fakeRoot, "packages", "cli", "scripts", "copy-bundle.mjs")],
          { cwd: fakeRoot, encoding: "utf8" },
        );
        expect(
          r.status,
          `copy-bundle must fail when skills/ is missing; stderr=${r.stderr}`,
        ).not.toBe(0);
        expect(r.stderr).toMatch(/missing data directory skills/);
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
        ["build", "--compile", path.join(PKG_ROOT, "dist", "bin", "agentera.js"), "--outfile", outfile],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(r.status, `bun build --compile must succeed; stderr=${r.stderr.slice(0, 500)}`).toBe(0);
      expect(fs.existsSync(outfile)).toBe(true);
      const stat = fs.statSync(outfile);
      expect(stat.size).toBeGreaterThan(1_000_000);
      expect(stat.mode & 0o111).not.toBe(0);

      const prime = spawnSync(outfile, ["prime", "--format", "json"], { encoding: "utf8" });
      expect(prime.status, `single-binary prime must exit 0; stderr=${prime.stderr.slice(0, 500)}`).toBe(0);
      const payload = JSON.parse(prime.stdout);
      expect(payload.command).toBe("prime");
      expect(payload.status).toBe("ok");
      expect(payload).toHaveProperty("app_home");
      expect(payload).toHaveProperty("app");
    });

    it("FAIL (regression): bun build --compile of a missing entrypoint exits non-zero", () => {
      if (!bunAvailable()) {
        throw new Error("bun is required for the single-binary regression gate; install bun >= 1.1.x");
      }
      const outfile = path.join(tmp, "agentera-bogus-binary");
      const r = spawnSync(
        "bun",
        ["build", "--compile", path.join(PKG_ROOT, "dist", "bin", "does-not-exist.js"), "--outfile", outfile],
        { cwd: tmp, encoding: "utf8" },
      );
      expect(r.status, "bun build --compile of a missing entrypoint must fail").not.toBe(0);
      expect(fs.existsSync(outfile)).toBe(false);
    });
  });
});
