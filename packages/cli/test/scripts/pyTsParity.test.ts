import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { gitCommitArgs } from "../helpers/git.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(PKG_ROOT, "scripts", "py_ts_parity.sh");
const FIXTURE_PATH = "packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json";
const FIXTURE = path.join(PKG_ROOT, "..", "..", FIXTURE_PATH);
const RECOVERY = "fetch origin refs/heads/main:refs/remotes/origin/main";

type Fixture = { python_commit: string; families: Record<string, { python_commit: string }> };

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

// The check must not read the live checkout, a caller's hook index, or user Git config.
function hermeticEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: hermeticEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(root: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
    git(root, "add", file);
  }
  git(root, ...gitCommitArgs("--quiet", "-m", message));
  return git(root, "rev-parse", "HEAD");
}

// A self-contained clone: main-branch Python history, no main ref yet, and the
// real script at its checkout path so it resolves this repository as its root.
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "py-ts-parity-"));
  temporary.push(root);
  git(root, "init", "--quiet", "-b", "fixture");
  const base = commit(root, { "scripts/agentera": "#!/usr/bin/env python3\n" }, "python cli");
  const docs = commit(root, { "README.md": "docs\n" }, "docs only");
  const python = commit(root, { "scripts/agentera_upgrade.py": "print('upgrade')\n", "src/agentera/cli.py": "print('cli')\n", "NOTES.md": "notes\n" }, "python change");
  fs.mkdirSync(path.join(root, "packages/cli/scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "packages/cli/scripts/py_ts_parity.sh"));
  return { root, base, docs, python };
}

function pin(root: string, sha: string): void {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;
  fixture.python_commit = sha;
  for (const family of Object.values(fixture.families)) family.python_commit = sha;
  fs.mkdirSync(path.dirname(path.join(root, FIXTURE_PATH)), { recursive: true });
  fs.writeFileSync(path.join(root, FIXTURE_PATH), JSON.stringify(fixture, null, 2));
}

function check(root: string, json = false) {
  const result = spawnSync("bash", [path.join(root, "packages/cli/scripts/py_ts_parity.sh"), "--check", ...(json ? ["--json"] : [])], { cwd: root, env: hermeticEnv(), encoding: "utf8" });
  const diagnostic = `stdout: ${result.stdout.slice(-4096)}\nstderr: ${result.stderr.slice(-4096)}`;
  return { status: result.status, stdout: result.stdout, diagnostic, payload: () => JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown> };
}

describe("packages/cli/scripts/py_ts_parity.sh --check", () => {
  it("keeps one 40-character pin that every family mirrors, with no predecessor record", () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Fixture;
    expect(fixture.python_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(fixture.families).length).toBeGreaterThan(0);
    for (const family of Object.values(fixture.families)) expect(family.python_commit).toBe(fixture.python_commit);
    expect(fixture).not.toHaveProperty("pinEvidence");
  });

  it("reports no drift when the pin equals origin/main in a clone without a local main branch", () => {
    const { root, python } = repository();
    git(root, "update-ref", "refs/remotes/origin/main", python);
    pin(root, python);

    const text = check(root);
    expect(text.status, text.diagnostic).toBe(0);
    expect(text.stdout).toContain("drift: none");
    expect(text.stdout).toContain(`main:   ${python} (refs/remotes/origin/main)`);
    const json = check(root, true);
    expect(json.status, json.diagnostic).toBe(0);
    expect(json.payload()).toEqual({ drift: "none", pinned: python, main: python, main_ref: "refs/remotes/origin/main", paths: ["scripts", "src/agentera"] });
  });

  it("falls back to local main and prefers origin/main when both exist", () => {
    const { root, docs, python } = repository();
    git(root, "update-ref", "refs/heads/main", python);
    pin(root, python);
    const local = check(root, true);
    expect(local.status, local.diagnostic).toBe(0);
    expect(local.payload()).toMatchObject({ drift: "none", main: python, main_ref: "refs/heads/main" });

    git(root, "update-ref", "refs/remotes/origin/main", docs);
    const remote = check(root, true);
    expect(remote.status, remote.diagnostic).toBe(1);
    expect(remote.payload()).toMatchObject({ drift: "detected", pinned: python, main: docs, main_ref: "refs/remotes/origin/main" });
  });

  it("reports drift with the changed Python paths, the re-pin procedure, and both commits", () => {
    const { root, base, python } = repository();
    git(root, "update-ref", "refs/remotes/origin/main", python);
    pin(root, base);

    const text = check(root);
    expect(text.status, text.diagnostic).toBe(1);
    expect(text.stdout).toContain("drift: detected");
    expect(text.stdout).toContain(`pinned: ${base}`);
    expect(text.stdout).toContain("    - scripts/agentera_upgrade.py\n    - src/agentera/cli.py\n");
    expect(text.stdout).not.toMatch(/README\.md|NOTES\.md/);
    expect(text.stdout).toContain("Re-pin procedure:");
    expect(text.stdout).toContain(`every per-family python_commit in`);
    expect(text.stdout).toContain(`to ${python}.`);
    expect(text.stdout).toContain("vp run test");
    expect(text.stdout).toContain("version_break: true");
    const json = check(root, true);
    expect(json.status, json.diagnostic).toBe(1);
    expect(json.payload()).toEqual({ drift: "detected", pinned: base, main: python, main_ref: "refs/remotes/origin/main", diff_paths: ["scripts/agentera_upgrade.py", "src/agentera/cli.py"] });
  });

  it("still reports drift, without paths, when the pinned commit is absent from the clone", () => {
    const { root, python } = repository();
    git(root, "update-ref", "refs/remotes/origin/main", python);
    pin(root, "0".repeat(40));

    const json = check(root, true);
    expect(json.status, json.diagnostic).toBe(1);
    expect(json.payload()).toMatchObject({ drift: "detected", pinned: "0".repeat(40), main: python, diff_paths: [], diff_error: "pinned_commit_unavailable" });
    expect(check(root).stdout).toContain("changed Python paths: unavailable");
  });

  it("reports a configuration error with recovery guidance when no main reference exists", () => {
    const { root, python } = repository();
    // Neither HEAD nor a tag named main stands in for the main branch.
    git(root, "tag", "main", python);
    pin(root, python);

    const text = check(root);
    expect(text.status, text.diagnostic).toBe(2);
    expect(text.stdout).toContain("configuration error: no main branch reference");
    expect(text.stdout).toContain("checked: refs/remotes/origin/main refs/heads/main");
    expect(text.stdout).toContain(RECOVERY);
    expect(text.stdout).not.toContain("drift: detected");
    const json = check(root, true);
    expect(json.status, json.diagnostic).toBe(2);
    expect(json.payload()).toMatchObject({ drift: "error", reason: "main_ref_missing", pinned: python, checked_refs: ["refs/remotes/origin/main", "refs/heads/main"] });
    expect(json.payload().recovery).toContain(RECOVERY);
  });
});
