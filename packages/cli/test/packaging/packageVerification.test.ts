import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, inject, it } from "vitest";

const fixture = inject("packageFixture");
const V2_PROJECT = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");

function run(command: string, args: string[], cwd: string, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function isolatedPackageEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete env.AGENTERA_HOME;
  return env;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

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
    if (allowedBundleDirectories.some((prefix) => file.startsWith(prefix))) return false;
    return true;
  });
}

function git(root: string, ...args: string[]): void {
  const result = run("git", args, root);
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("npm distribution boundary", () => {
  it("constructs one self-contained CLI and shared-skill package inventory", () => {
    const files = new Set(fixture.manifest.files.map((entry) => entry.path));
    for (const required of [
      "dist/bin/agentera.js",
      "bundle/.agentera-npx-bundle.json",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      "bundle/references/artifacts/state-storage-authority.yaml",
    ]) {
      expect(files.has(required), required).toBe(true);
    }
    expect([...files].some((file) => file.startsWith("src/"))).toBe(false);

    const authority = YAML.parse(fs.readFileSync(
      path.join(fixture.packageRoot, "bundle/references/adapters/package-registry.yaml"),
      "utf8",
    )) as any;
    const surfaces = authority.records.find((record: any) => record.identity.id === "agentera")
      .bundle_surfaces as BundleSurfaces;
    expect(
      unclassifiedManifestPaths(files, surfaces),
      "package boundary found manifest paths outside npm metadata, compiled CLI, or bundle authority",
    )
      .toEqual([]);
  });

  it("rejects retired and otherwise unclassified top-level package surfaces", () => {
    const surfaces: BundleSurfaces = {
      directories: [{ path: "skills" }, { path: "references" }],
      files: [{ path: "registry.json" }],
      generated_files: [{ path: ".agentera-npx-bundle.json" }],
    };
    expect(unclassifiedManifestPaths([
      "package.json",
      "README.md",
      "dist/bin/agentera.js",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ], surfaces)).toEqual([
      ".opencode/package.json",
      "plugin.json",
      ".cursor-plugin/plugin.json",
    ]);
  });

  it("installs and invokes the extracted package without a repository checkout", () => {
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const result = run(process.execPath, [bin, "--help"], fixture.root, isolatedPackageEnv({
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: CHECKOUT_ROOT,
    }));
    expect(result.status, `package boundary invocation failed:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("agentera");
  });

  it("runs the public v2-to-v3 apply shape and prime through that package", () => {
    const project = path.join(fixture.root, "project $(touch shell-expansion-trap) `touch backtick-trap`");
    fs.cpSync(V2_PROJECT, project, { recursive: true });
    git(project, "init", "--quiet");
    git(project, "config", "user.name", "Package Verification Test");
    git(project, "config", "user.email", "package-verification@example.invalid");
    git(project, "config", "commit.gpgsign", "false");
    git(project, "add", ".");
    git(project, "commit", "--quiet", "-m", "tracked v2 fixture");

    const home = path.join(fixture.root, "home");
    fs.mkdirSync(home, { recursive: true });
    const env = isolatedPackageEnv({
      HOME: home,
      XDG_DATA_HOME: path.join(home, ".local/share"),
      AGENTERA_BOOTSTRAP_SOURCE_ROOT: CHECKOUT_ROOT,
    });
    expect(env.AGENTERA_BOOTSTRAP_SOURCE_ROOT).toBeUndefined();
    const bin = path.join(fixture.packageRoot, "dist/bin/agentera.js");
    const blocked = run(process.execPath, [bin, "prime", "--format", "json"], project, env);
    expect(blocked.status).toBe(1);
    const failure = JSON.parse(blocked.stdout) as { error: { recovery: string } };
    expect(failure.error.recovery).toMatch(/^npx -y agentera@next upgrade /);
    const quotedBin = `'${bin.replaceAll("'", `'"'"'`)}'`;
    const recovery = failure.error.recovery.replace("npx -y agentera@next", `${process.execPath} ${quotedBin}`);
    const upgraded = run("/bin/sh", ["-c", recovery], fixture.root, env);
    expect(upgraded.status, `package boundary upgrade failed:\n${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(fixture.root, "shell-expansion-trap"))).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, "backtick-trap"))).toBe(false);
    expect(YAML.parse(fs.readFileSync(path.join(project, ".agentera/state-mode.yaml"), "utf8")))
      .toMatchObject({ mode: "entities" });

    const primed = run(process.execPath, [bin, "prime", "--format", "json"], project, env);
    expect(primed.status, `package boundary prime failed:\n${primed.stderr}`).toBe(0);
    const payload = JSON.parse(primed.stdout) as {
      command: string;
      status: string;
      app_home: { home: string; source: string };
      app: { sourceRoot: string };
    };
    expect(payload).toMatchObject({
      command: "prime",
      status: "ok",
      app_home: { home: expect.any(String), source: "bundled app" },
      app: { sourceRoot: expect.any(String) },
    });
    const bundleRoot = fs.realpathSync(path.join(fixture.packageRoot, "bundle"));
    for (const reportedSource of [payload.app_home.home, payload.app.sourceRoot]) {
      const appSource = fs.realpathSync(reportedSource);
      expect(
        isContained(bundleRoot, appSource),
        `package boundary escaped extracted bundle: source=${appSource} bundle=${bundleRoot}`,
      ).toBe(true);
    }
  });
});
