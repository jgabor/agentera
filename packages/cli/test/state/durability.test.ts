import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { inspectDurability } from "../../src/state/durability.js";

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

function entityBytes(artifact = "progress", id = "aaaaaaaaaa"): string {
  return dumpYamlMapping({
    id,
    artifact,
    record: {
      timestamp: "2026-07-17 12:00",
      type: "test",
      phase: "build",
      what: "durable",
      context: { intent: "test" },
    },
  });
}

function writeEntity(root: string, artifact = "progress", id = "aaaaaaaaaa"): string {
  const directory = path.join(root, ".agentera/entities", artifact, "progress_cycle");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  const target = path.join(directory, `${id}.yaml`);
  fs.writeFileSync(target, entityBytes(artifact, id));
  return target;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("read-only entity and Git durability", () => {
  it("rejects legacy durability selectors before cutover without changing state", () => {
    const root = project();
    fs.mkdirSync(path.join(root, ".agentera/archive/progress"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/archive/progress/1.yaml"), "record: {}\n");
    const previous = process.cwd();
    let out = "";
    let err = "";
    process.chdir(root);
    try {
      const rc = main(["node", "agentera", "check", "durability", "--artifact", "progress", "--number", "1", "--format", "json"], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      });
      expect(rc).toBe(1);
    } finally {
      process.chdir(previous);
    }
    expect(err).toBe("");
    expect(JSON.parse(out).error).toMatchObject({ class: "migration_required", recovery: expect.stringContaining("upgrade --channel development") });
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
  });

  it("uses bare entity identity after cutover and remains read-only", () => {
    const root = nonGitProject();
    const target = writeEntity(root);
    const before = fs.readFileSync(target);
    let out = "";
    const rc = main(["node", "agentera", "check", "durability", "--project", root, "--artifact", "progress", "--id", "aaaaaaaaaa", "--format", "json"], { out: (text) => out += text });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload).toMatchObject({ read_only: true, remote_contact: false, entries: [{ id: "aaaaaaaaaa", artifact: "progress", retrieval: { get: "agentera state progress get --id aaaaaaaaaa --format json" } }] });
    expect(JSON.stringify(payload)).not.toMatch(/stable_id|artifact_id|entry_number/);
    expect(fs.readFileSync(target)).toEqual(before);
    out = "";
    expect(main(["node", "agentera", "check", "durability", "--project", root, "--artifact", "progress", "--number", "1", "--format", "json"], { out: (text) => out += text })).toBe(2);
    expect(JSON.parse(out).error).toMatchObject({ artifact: "progress" });
  });

  it("reports committed, dirty, and locally missing entity recovery through Git", () => {
    const root = project();
    initGit(root);
    const target = writeEntity(root);
    const bytes = fs.readFileSync(target, "utf8");
    git(root, ["add", ".agentera"]);
    git(root, ["commit", "--quiet", "-m", "entity fixture"]);
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ id: "aaaaaaaaaa", git: { status: "verified", reason: "reachable_head", reachable_recovery: true } }] });
    fs.writeFileSync(target, bytes.replace("what: durable", "what: dirty"));
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "degraded", reason: "dirty_archive", reachable_recovery: true } }] });
    fs.rmSync(target);
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ local: { status: "unavailable" }, git: { status: "verified", reason: "reachable_head", reachable_recovery: true } }] });
  });

  it("never accepts a committed entity from an authority-undeclared boundary", () => {
    const root = project();
    initGit(root);
    const directory = path.join(root, ".agentera/entities/progress/wrong_boundary");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(directory, "aaaaaaaaaa.yaml"), entityBytes());
    git(root, ["add", ".agentera"]);
    git(root, ["commit", "--quiet", "-m", "wrong boundary"]);
    fs.rmSync(path.join(root, ".agentera/entities"), { recursive: true });
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ status: "unavailable", entries: [{ local: { status: "unavailable" }, git: { status: "unavailable", reachable_recovery: false } }] });
  });

  it.each([
    ["malformed envelope", "not: [yaml\n"],
    ["wrong artifact", entityBytes("health")],
    ["wrong id", entityBytes("progress", "bbbbbbbbbb")],
  ])("does not claim committed recovery for a canonical-path %s", (_label, bytes) => {
    const root = project();
    initGit(root);
    const directory = path.join(root, ".agentera/entities/progress/progress_cycle");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(directory, "aaaaaaaaaa.yaml"), bytes);
    git(root, ["add", ".agentera"]);
    git(root, ["commit", "--quiet", "-m", "invalid entity"]);
    fs.rmSync(path.join(root, ".agentera/entities"), { recursive: true });
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "unavailable", reason: "committed_entity_invalid", reachable_recovery: false } }] });
  });

  it.each([
    ["decisions", [
      ["decision", { date: "2026-07-17", question: "Q", context: "C", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "R", confidence: "firm" }],
      ["decision_satisfaction", { decision: "bbbbbbbbbb", state: "open" }],
    ]],
    ["plan", [
      ["plan", { header: { level: "light", created: "2026-07-17", status: "open", title: "P" }, what: "W", why: "Y", scope: { included: ["state"], excluded: [] } }],
      ["plan_task", { plan: "bbbbbbbbbb", name: "T", status: "pending", depends_on: [], acceptance: ["pass"] }],
    ]],
  ] as const)("reports conflicting committed recovery across every multi-boundary %s artifact", (artifact, candidates) => {
    const root = project();
    initGit(root);
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (const [boundary, record] of candidates) {
      const directory = path.join(root, ".agentera/entities", artifact, boundary);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "aaaaaaaaaa.yaml"), dumpYamlMapping({ id: "aaaaaaaaaa", artifact, record }));
    }
    git(root, ["add", ".agentera"]);
    git(root, ["commit", "--quiet", "-m", `${artifact} duplicate`]);
    fs.rmSync(path.join(root, ".agentera/entities"), { recursive: true });
    expect(inspectDurability(root, { artifact, id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "unavailable", reason: "committed_entity_conflict", reachable_recovery: false } }] });
  });

  it.each([
    { args: ["--artifact", "bogus", "--id", "aaaaaaaaaa", "--format", "json"], message: "unsupported durability artifact 'bogus'" },
    { args: ["--artifact", "progress", "--id", "aaaaaaaaaa", "--limit", "101", "--format", "json"], message: "argument --limit must be between 1 and 100" },
    { args: ["--artifact", "progress", "--id", "aaaaaaaaaa", "--number", "1", "--format", "json"], message: "entity mode rejects --number; use --artifact ARTIFACT --id ID" },
  ])("emits an entity request failure for invalid durability input", ({ args, message }) => {
    let out = "";
    const rc = main(["node", "agentera", "check", "durability", ...args], { out: (text) => (out += text) });
    expect(rc).toBe(2);
    expect(JSON.parse(out)).toMatchObject({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "invalid_request",
        message,
        syntax: "agentera check durability --artifact ARTIFACT --id ID --format json",
        example: expect.stringContaining("agentera check durability"),
        recovery: expect.any(String),
      },
    });
  });
});
