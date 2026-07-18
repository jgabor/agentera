import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURE = path.resolve(import.meta.dirname, "../upgrade/fixtures/v2-yaml-project");

function run(command: string, args: string[], cwd: string, env = process.env) {
  return spawnSync(command, args, { cwd, env, encoding: "utf8" });
}

function git(root: string, ...args: string[]): void {
  const result = run("git", args, root);
  if (result.status !== 0) throw new Error(result.stderr);
}

function managedV2(appHome: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts/agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills/agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills/agentera/SKILL.md"), "fixture\n");
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
  fs.writeFileSync(path.join(app, ".agentera-bundle.json"), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }));
}

describe("packed v2-to-v3 upgrade", () => {
  it("runs the full public apply shape and prime using only an extracted development package", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-packed-upgrade-"));
    try {
      const pack = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], PACKAGE_ROOT);
      expect(pack.status, pack.stderr).toBe(0);
      const packed = JSON.parse(pack.stdout) as unknown;
      const entry = Array.isArray(packed) ? packed[0] : Object.values(packed as Record<string, unknown>)[0];
      const tarball = path.join(tmp, String((entry as { filename: string }).filename));
      const extracted = path.join(tmp, "extracted");
      fs.mkdirSync(extracted);
      const untar = run("tar", ["-xzf", tarball, "-C", extracted], tmp);
      expect(untar.status, untar.stderr).toBe(0);
      const packageDir = path.join(extracted, "package");
      const install = run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], packageDir);
      expect(install.status, install.stderr).toBe(0);

      const project = path.join(tmp, "project");
      fs.cpSync(FIXTURE, project, { recursive: true });
      git(project, "init", "--quiet");
      git(project, "config", "user.name", "Packed Upgrade Test");
      git(project, "config", "user.email", "packed-upgrade@example.invalid");
      git(project, "config", "commit.gpgsign", "false");
      git(project, "add", ".");
      git(project, "commit", "--quiet", "-m", "tracked v2 fixture");
      expect(run("git", ["status", "--porcelain"], project).stdout).toBe("");

      const home = path.join(tmp, "home");
      const appHome = path.join(home, ".local/share/agentera");
      fs.mkdirSync(home, { recursive: true });
      managedV2(appHome);
      const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, ".local/share"), AGENTERA_HOME: appHome };
      const bin = path.join(packageDir, "dist/bin/agentera.js");

      const upgraded = run(process.execPath, [bin, "upgrade", "--channel", "development", "--project", project, "--yes"], project, env);
      expect(upgraded.status, `${upgraded.stdout}\n${upgraded.stderr}`).toBe(0);
      expect(upgraded.stdout).toContain("state and startup validation passed");
      expect(YAML.parse(fs.readFileSync(path.join(project, ".agentera/state-mode.yaml"), "utf8"))).toMatchObject({ mode: "entities" });

      const primed = run(process.execPath, [bin, "prime", "--format", "json"], project, env);
      expect(primed.status, `${primed.stdout}\n${primed.stderr}`).toBe(0);
      expect(JSON.parse(primed.stdout)).toMatchObject({ command: "prime", status: "ok" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
