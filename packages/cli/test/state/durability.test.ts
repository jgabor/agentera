import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { inspectDurability } from "../../src/state/durability.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-durability-"));
  roots.push(root);
  return root;
}

function nonGitProject(): string {
  const parent = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, "agentera-durability-non-git-"));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

function initGit(root: string): void {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "durability-test@example.invalid"]);
  git(root, ["config", "user.name", "Durability Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
}

function progress(number: number, what = `Cycle ${number}`): Record<string, unknown> {
  return {
    number,
    timestamp: "2026-07-13 17:00",
    type: "test",
    phase: "build",
    what,
    context: { intent: "Exercise read-only durability diagnostics" },
  };
}

function archive(root: string, number = 1, what?: string): string {
  return publishNumberedArchive(root, "progress", number, progress(number, what), { sourceRoot }).path;
}

function commitArchive(root: string, number = 1): string {
  initGit(root);
  const target = archive(root, number);
  git(root, ["add", ".agentera/archive"]);
  git(root, ["commit", "--quiet", "-m", "archive fixture"]);
  return target;
}

function rewriteValidArchive(target: string, what: string): void {
  const envelope = YAML.parse(fs.readFileSync(target, "utf8")) as Record<string, any>;
  envelope.record.what = what;
  envelope.record_sha256 = createHash("sha256")
    .update(canonicalRecordJson(envelope.record), "utf8")
    .digest("hex");
  fs.writeFileSync(target, dumpYamlMapping(envelope));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("read-only archive and Git durability", () => {
  it("reports stable local and reachable committed recovery deterministically without remote commands", () => {
    const root = project();
    commitArchive(root);
    const calls: string[][] = [];
    const runner = (args: string[], cwd: string) => {
      calls.push(args);
      const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
      return {
        status: result.status,
        stdout: String(result.stdout ?? ""),
        timedOut: false,
      };
    };

    const before = fs.readFileSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"), "utf8");
    const first = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot, runGit: runner });
    const second = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot, runGit: runner });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "complete",
      head: { status: "stable" },
      counts: { local_verified: 1, reachable_recovery: 1 },
      entries: [{ local: { status: "verified" }, git: { status: "verified", reachable_recovery: true } }],
      read_only: true,
      remote_contact: false,
    });
    expect(fs.readFileSync(path.join(root, ".agentera", "archive", "progress", "1.yaml"), "utf8")).toBe(before);
    expect(calls.some((args) => ["fetch", "push", "pull", "ls-remote"].includes(args[0] ?? ""))).toBe(false);
  });

  it("keeps local writes usable in non-Git projects and reports Git as unavailable", () => {
    const root = nonGitProject();
    archive(root);
    const calls: string[][] = [];
    const result = inspectDurability(
      root,
      { artifact: "progress", number: 1 },
      {
        sourceRoot,
        runGit: (args) => {
          calls.push(args);
          return { status: null, stdout: "", timedOut: true };
        },
      },
    );

    expect(result).toMatchObject({
      status: "complete",
      entries: [{ status: "complete", local: { status: "verified" }, git: { status: "unavailable", reason: "non_git" } }],
    });
    expect(calls).toEqual([]);
    expect(() => archive(root, 2)).not.toThrow();
  });

  it("degrades a Git-marked project when the initial rev-parse probe times out", () => {
    const root = project();
    fs.mkdirSync(path.join(root, ".git"));
    archive(root);

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, {
      sourceRoot,
      runGit: () => ({ status: null, stdout: "", timedOut: true }),
    });

    expect(result).toMatchObject({
      status: "degraded",
      entries: [{ status: "degraded", git: { status: "unavailable", reason: "git_probe_timeout", reachable_recovery: false } }],
    });
  });

  it("degrades a Git-marked project when the initial rev-parse probe errors", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /missing/worktree\n");
    archive(root);

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, {
      sourceRoot,
      runGit: () => ({ status: null, stdout: "", timedOut: false, error: "EIO" }),
    });

    expect(result).toMatchObject({
      status: "degraded",
      entries: [{ status: "degraded", git: { status: "unavailable", reason: "git_probe_error", reachable_recovery: false } }],
    });
  });

  it("emits an unavailable diagnostic when neither local nor committed recovery exists", () => {
    const root = nonGitProject();

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot });

    expect(result).toMatchObject({
      status: "unavailable",
      head: { status: "unavailable" },
      entries: [{ status: "unavailable", local: { status: "unavailable" }, git: { status: "unavailable", reason: "non_git" } }],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.class)).toEqual([
      "local_recovery_unavailable",
      "non_git",
    ]);
  });

  it("separates a dirty local archive from its prior committed bytes", () => {
    const root = project();
    const target = commitArchive(root);
    rewriteValidArchive(target, "Dirty but still valid archive");

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot });

    expect(result).toMatchObject({
      status: "degraded",
      entries: [{ local: { status: "verified" }, git: { status: "degraded", reason: "dirty_archive", reachable_recovery: true } }],
    });
  });

  it("reports shallow history as degraded while retaining current local and head evidence", () => {
    const source = project();
    commitArchive(source);
    const shallow = path.join(path.dirname(source), `${path.basename(source)}-shallow`);
    git(path.dirname(source), ["clone", "--quiet", "--depth", "1", `file://${source}`, shallow]);
    roots.push(shallow);

    const result = inspectDurability(shallow, { artifact: "progress", number: 1 }, { sourceRoot });

    expect(result).toMatchObject({
      status: "degraded",
      entries: [{ local: { status: "verified" }, git: { status: "degraded", reason: "shallow_history", reachable_recovery: true } }],
    });
  });

  it("distinguishes a Git repository without a commit from a non-Git project", () => {
    const root = project();
    initGit(root);
    archive(root);

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot });

    expect(result).toMatchObject({
      status: "degraded",
      head: { status: "unavailable" },
      entries: [{ git: { status: "unavailable", reason: "missing_commit" } }],
    });
  });

  it("refuses to claim committed recovery when HEAD changes during inspection", () => {
    const root = project();
    commitArchive(root);
    let headReads = 0;
    const runner = (args: string[], cwd: string) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}") {
        headReads += 1;
        if (headReads === 2) {
          return { status: 0, stdout: "0".repeat(40), timedOut: false };
        }
      }
      return { status: result.status, stdout: String(result.stdout ?? ""), timedOut: false };
    };

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot, runGit: runner });

    expect(result).toMatchObject({
      status: "degraded",
      head: { status: "changed" },
      entries: [{ git: { status: "degraded", reason: "changed_head", reachable_recovery: false } }],
    });
  });

  it("identifies locally retained bytes after the committed history was rewritten", () => {
    const root = project();
    initGit(root);
    fs.writeFileSync(path.join(root, "README"), "base\n");
    git(root, ["add", "README"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    const target = commitArchive(root);
    git(root, ["reset", "--quiet", "--hard", "HEAD~1"]);
    archive(root);

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot });

    expect(result).toMatchObject({
      status: "degraded",
      entries: [{ local: { status: "verified" }, git: { status: "degraded", reason: "history_rewritten" } }],
    });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("reports committed recovery separately when the local archive is missing", () => {
    const root = project();
    const target = commitArchive(root);
    fs.rmSync(target);

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot });

    expect(result).toMatchObject({
      status: "degraded",
      entries: [{ local: { status: "unavailable" }, git: { status: "verified", reachable_recovery: true } }],
    });
  });

  it("downgrades all Git evidence when the ending HEAD capture times out", () => {
    const root = project();
    commitArchive(root);
    let headReads = 0;
    const runner = (args: string[], cwd: string) => {
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}") {
        headReads += 1;
        if (headReads === 2) return { status: null, stdout: "", timedOut: true };
      }
      const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
      return { status: result.status, stdout: String(result.stdout ?? ""), timedOut: false };
    };

    const result = inspectDurability(root, { artifact: "progress", number: 1 }, { sourceRoot, runGit: runner });

    expect(result).toMatchObject({
      status: "degraded",
      head: { status: "unavailable" },
      entries: [{ status: "degraded", git: { status: "degraded", reason: "final_head_unavailable", reachable_recovery: false } }],
    });
  });

  it("exposes the authority syntax through the CLI without making a diagnostic a write gate", () => {
    const root = project();
    archive(root);
    const previous = process.cwd();
    let out = "";
    let err = "";
    process.chdir(root);
    try {
      const rc = main(["node", "agentera", "check", "durability", "--artifact", "progress", "--number", "1", "--format", "json"], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      });
      expect(rc).toBe(0);
    } finally {
      process.chdir(previous);
    }
    expect(err).toBe("");
    expect(JSON.parse(out)).toMatchObject({
      command: "agentera check durability [--project PATH] [--artifact ARTIFACT] [--number N] [--limit N] --format json",
      read_only: true,
      remote_contact: false,
      source_contract: { writes_independent: true },
    });
  });

  it.each([
    {
      args: ["--artifact", "bogus", "--format", "json"],
      className: "unsupported_artifact",
      message: "unsupported durability artifact 'bogus'",
    },
    {
      args: ["--limit", "101", "--format", "json"],
      className: "invalid_request",
      message: "argument --limit must be between 1 and 100",
    },
    {
      args: ["--artifact", "progress", "--number", "0", "--format", "json"],
      className: "invalid_request",
      message: "argument --number: invalid int value: '0'",
    },
  ])("emits an authority state failure for invalid durability input", ({ args, className, message }) => {
    let out = "";
    let err = "";
    const rc = main(["node", "agentera", "check", "durability", ...args], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });

    expect(rc).toBe(2);
    expect(err).toBe("");
    expect(JSON.parse(out)).toMatchObject({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: "agentera check durability [--project PATH] [--artifact ARTIFACT] [--number N] [--limit N] --format json",
        example: expect.stringContaining("agentera check durability"),
        recovery: expect.any(String),
      },
    });
  });
});
