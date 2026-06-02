import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commitToken,
  computeBackfill,
  rewriteCycleCommits,
  validateProgressCommits,
} from "../../src/state/progressCommit.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
}

function short(cwd: string, rev = "HEAD"): string {
  return git(cwd, "rev-parse", "--short", rev).trim();
}

function progressYaml(entries: Array<[number, string]>): string {
  const lines = ["cycles:"];
  for (const [number, commit] of entries) {
    lines.push(
      `- number: ${number}`,
      "  timestamp: 2026-01-01 00:00",
      "  type: chore",
      "  phase: build",
      `  what: Cycle ${number} work.`,
      `  commit: "${commit}"`,
      "  discovered: None.",
      "  context:",
      "    intent: Exercise the commit guard.",
    );
  }
  return lines.join("\n") + "\n";
}

interface Repo {
  path: string;
  ancestor: string;
  stale: string;
  head: string;
}

let tmp: string;
let repo: Repo;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-"));
  git(tmp, "init", "-q");
  git(tmp, "config", "user.name", "Test");
  git(tmp, "config", "user.email", "test@example.com");
  git(tmp, "config", "commit.gpgsign", "false");
  git(tmp, "commit", "--allow-empty", "-q", "-m", "A");
  const ancestor = short(tmp);
  git(tmp, "commit", "--allow-empty", "-q", "-m", "B");
  git(tmp, "branch", "stale-ref");
  const stale = short(tmp, "stale-ref");
  git(tmp, "reset", "--hard", ancestor);
  git(tmp, "commit", "--allow-empty", "-q", "-m", "C");
  const head = short(tmp);
  expect(stale).not.toBe(head);
  fs.mkdirSync(path.join(tmp, ".agentera"));
  repo = { path: tmp, ancestor, stale, head };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("validateProgressCommits", () => {
  it("accepts ancestor and pending", () => {
    const content = progressYaml([
      [2, repo.head],
      [1, repo.ancestor],
      [0, "pending"],
    ]);
    expect(validateProgressCommits(content, repo.path)).toEqual([]);
  });

  it("flags a stale hash", () => {
    const content = progressYaml([[1, repo.stale]]);
    const violations = validateProgressCommits(content, repo.path);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain(repo.stale);
    expect(violations[0]).toContain("not an ancestor of HEAD");
    expect(violations[0]).toContain("backfill");
  });

  it("uses the leading token when a subject suffix is present", () => {
    const content = progressYaml([[1, `${repo.stale} amended away`]]);
    const violations = validateProgressCommits(content, repo.path);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain(repo.stale);
  });

  it("exempts N/A values", () => {
    const content = progressYaml([[1, "N/A no product commit"]]);
    expect(validateProgressCommits(content, repo.path)).toEqual([]);
  });

  it("does not flag unknown hashes", () => {
    const content = progressYaml([[1, "deadbeefdead"]]);
    expect(validateProgressCommits(content, repo.path)).toEqual([]);
  });

  it("does not flag non-git directories", () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    try {
      const content = progressYaml([[1, "0123abc"]]);
      expect(validateProgressCommits(content, nonGit)).toEqual([]);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("returns no commit violations for corrupt or non-mapping yaml", () => {
    expect(validateProgressCommits("cycles:\n  - number: [not valid\n", repo.path)).toEqual([]);
    expect(validateProgressCommits("- not a mapping\n", repo.path)).toEqual([]);
  });
});

describe("rewriteCycleCommits", () => {
  it("replaces a single-line commit", () => {
    const text = progressYaml([
      [2, "aaaaaaa"],
      [1, "bbbbbbb"],
    ]);
    const out = rewriteCycleCommits(text, { 1: "pending" });
    const data = YAML.parse(out) as any;
    const commits = Object.fromEntries(data.cycles.map((c: any) => [c.number, c.commit]));
    expect(commits).toEqual({ 2: "aaaaaaa", 1: "pending" });
  });

  it("drops a multiline scalar continuation", () => {
    const text =
      "cycles:\n" +
      "- number: 5\n" +
      "  type: chore\n" +
      "  commit: b78a417\n" +
      "    plan'\n" +
      "  discovered: None.\n";
    const out = rewriteCycleCommits(text, { 5: "pending" });
    expect(out).not.toContain("plan'");
    const data = YAML.parse(out) as any;
    expect(data.cycles[0].commit).toBe("pending");
    expect(data.cycles[0].discovered).toBe("None.");
  });

  it("leaves untargeted cycles and archive untouched", () => {
    const text =
      "cycles:\n" +
      "- number: 2\n" +
      "  commit: aaaaaaa\n" +
      "- number: 1\n" +
      "  commit: bbbbbbb\n" +
      "archive:\n" +
      "- summary: 'commit: ccccccc kept verbatim'\n";
    const out = rewriteCycleCommits(text, { 2: "pending" });
    expect(out).toContain("commit: ccccccc kept verbatim");
    const data = YAML.parse(out) as any;
    const commits = Object.fromEntries(data.cycles.map((c: any) => [c.number, c.commit]));
    expect(commits).toEqual({ 2: "pending", 1: "bbbbbbb" });
  });

  it("replaces a folded scalar commit", () => {
    const text =
      "cycles:\n" +
      "- number: 3\n" +
      "  commit: >-\n" +
      "    abc1234\n" +
      "    subject line\n" +
      "  discovered: kept\n";
    const out = rewriteCycleCommits(text, { 3: "pending" });
    expect(out).not.toContain("subject line");
    expect(out).toContain("commit: pending");
    expect(out).toContain("discovered: kept");
  });

  it("replaces a flow scalar commit", () => {
    const text = "cycles:\n- number: 4\n  commit: {hash: abc1234, note: x}\n  type: chore\n";
    const out = rewriteCycleCommits(text, { 4: "deadbeef" });
    expect(out).not.toContain("{hash:");
    expect(out).toContain("commit: deadbeef");
    expect(out).toContain("type: chore");
  });

  it("preserves an inline comment on an untouched cycle", () => {
    const text =
      "cycles:\n" +
      "- number: 1\n" +
      "  commit: abc1234 # product hash\n" +
      "- number: 2\n" +
      "  commit: def5678\n";
    const out = rewriteCycleCommits(text, { 2: "pending" });
    expect(out).toContain("abc1234 # product hash");
    expect(out).toContain("commit: pending");
  });
});

describe("commitToken", () => {
  const cases: Array<[unknown, string | null]> = [
    ["abc1234", "abc1234"],
    ["abc1234 Speed up suite", "abc1234"],
    ["pending", null],
    ["pending plan'", null],
    ["N/A: docs only", null],
    ["notahash subject", null],
    [123, null],
    ["", null],
  ];
  it.each(cases)("token(%j) -> %j", (value, expected) => {
    expect(commitToken(value)).toBe(expected);
  });
});

describe("computeBackfill", () => {
  it("reports stale and exits one in check mode", () => {
    const text = progressYaml([
      [2, repo.head],
      [1, repo.stale],
      [0, "pending"],
    ]);
    const result = computeBackfill(text, { cwd: repo.path });
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe("action-needed");
    expect(result.changes).toEqual([[1, "pending"]]);
  });

  it("resets stale to pending in fix mode and the rewrite applies", () => {
    const text = progressYaml([
      [2, repo.head],
      [1, repo.stale],
    ]);
    const result = computeBackfill(text, { mode: "fix", cwd: repo.path });
    expect(result.status).toBe("fixed");
    const out = rewriteCycleCommits(text, new Map(result.changes));
    const data = YAML.parse(out) as any;
    const commits = Object.fromEntries(data.cycles.map((c: any) => [c.number, c.commit]));
    expect(commits).toEqual({ 2: repo.head, 1: "pending" });
  });

  it("is clean when all commits are ancestors", () => {
    const text = progressYaml([
      [1, repo.ancestor],
      [0, "pending"],
    ]);
    const result = computeBackfill(text, { cwd: repo.path });
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe("clean");
  });

  it("forward-fills a known ancestor commit", () => {
    const text = progressYaml([
      [2, repo.head],
      [1, "pending"],
    ]);
    const result = computeBackfill(text, {
      mode: "fix",
      targetCycle: 1,
      targetCommit: repo.ancestor,
      cwd: repo.path,
    });
    expect(result.status).toBe("fixed");
    const out = rewriteCycleCommits(text, new Map(result.changes));
    const data = YAML.parse(out) as any;
    const commits = Object.fromEntries(data.cycles.map((c: any) => [c.number, c.commit]));
    // rewriteCycleCommits writes the commit value unquoted; the YAML parser
    // reads all-digit short hashes as numbers. Normalize to string so the
    // assertion is stable across hash shapes.
    expect(String(commits[1])).toBe(repo.ancestor);
  });

  it("refuses a non-ancestor commit", () => {
    const text = progressYaml([[1, "pending"]]);
    const result = computeBackfill(text, { targetCommit: repo.stale, cwd: repo.path });
    expect(result.exitCode).toBe(2);
    expect(result.status).toBe("error");
    expect(result.message).toContain("stale");
  });

  it("refuses an unknown commit", () => {
    const text = progressYaml([[1, "pending"]]);
    const result = computeBackfill(text, { targetCommit: "deadbeefdead", cwd: repo.path });
    expect(result.exitCode).toBe(2);
    expect(result.status).toBe("error");
  });
});
