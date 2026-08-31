import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { inspectDurability } from "../../src/state/durability.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";

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
  const result = spawnSync(
    "git",
    [
      "-c", "user.email=durability-test@example.invalid",
      "-c", "user.name=Durability Test",
      "-c", "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
}

function gitProject(): string {
  const root = project();
  git(root, ["init", "--quiet"]);
  return root;
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
    const rc = main(["node", "agentera", "check", "durability", "--project", root, "--artifact", "progress", "--id", "aaaaaaaaaa"], { out: (text) => out += text });
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload).toMatchObject({ read_only: true, remote_contact: false, entries: [{ id: "aaaaaaaaaa", artifact: "progress", retrieval: { get: "agentera state progress get --id aaaaaaaaaa" } }] });
    expect(JSON.stringify(payload)).not.toMatch(/stable_id|artifact_id|entry_number/);
    expect(fs.readFileSync(target)).toEqual(before);
    out = "";
    expect(main(["node", "agentera", "check", "durability", "--project", root, "--artifact", "progress", "--number", "1", "--format", "json"], { out: (text) => out += text })).toBe(2);
    expect(JSON.parse(out).error).toMatchObject({ artifact: "progress" });
  });

  it("rejects non-JSON output selectors", () => {
    const root = nonGitProject();
    writeEntity(root);
    let out = "";
    let err = "";
    const rc = main(["node", "agentera", "check", "durability", "--project", root, "--artifact", "progress", "--id", "aaaaaaaaaa", "--format", "yaml"], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    expect(rc).toBe(2);
    expect(JSON.parse(out).error.valid_values).toEqual(["json"]);
    expect(err).toBe("");
  });

  it("reports committed, dirty, and locally missing entity recovery through Git", () => {
    const root = gitProject();
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
    const root = gitProject();
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
    const root = gitProject();
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
    const root = gitProject();
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

  it("does not verify a committed entity through a cross-artifact duplicate identity", () => {
    const root = gitProject();
    writeEntity(root);
    git(root, ["add", ".agentera"]); git(root, ["commit", "--quiet", "-m", "entity"]);
    const duplicate = path.join(root, ".agentera/entities/health/health_audit/aaaaaaaaaa.yaml");
    fs.mkdirSync(path.dirname(duplicate), { recursive: true });
    fs.writeFileSync(duplicate, dumpYamlMapping({ id: "aaaaaaaaaa", artifact: "health", record: {} }));

    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      status: "unavailable",
      entries: [{ local: { status: "corrupt" }, git: { status: "unavailable", reason: "committed_content_mismatch" } }],
    });
  });

  it("does not verify a committed entity through same-artifact boundary ambiguity", () => {
    const root = gitProject();
    writeEntity(root);
    git(root, ["add", ".agentera"]); git(root, ["commit", "--quiet", "-m", "entity"]);
    const source = { number: 1, summary: "ambiguous summary" };
    const summary = path.join(root, ".agentera/entities/progress/progress_summary/aaaaaaaaaa.yaml");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "archive:\n  - number: 1\n    summary: ambiguous summary\n");
    fs.writeFileSync(summary, dumpYamlMapping({
      id: "aaaaaaaaaa",
      artifact: "progress",
      record: {
        summary: source.summary,
        migration_provenance: {
          source_path: ".agentera/progress.yaml",
          source_record_sha256: createHash("sha256").update(canonicalRecordJson(source)).digest("hex"),
        },
      },
    }));

    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      status: "unavailable",
      entries: [{ local: { status: "corrupt" }, git: { status: "unavailable", reason: "committed_content_mismatch" } }],
    });
  });

  it.each([
    { label: "dirty", shallow: false },
    { label: "shallow", shallow: true },
  ])("rejects an uncommitted malformed provenance entity before $label Git fallbacks", ({ shallow }) => {
    const root = gitProject();
    fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
    git(root, ["add", "README.md"]); git(root, ["commit", "--quiet", "-m", "baseline"]);
    const target = path.join(root, ".agentera/entities/progress/progress_summary/aaaaaaaaaa.yaml");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(target, dumpYamlMapping({
      id: "aaaaaaaaaa",
      artifact: "progress",
      record: {
        summary: "fabricated provenance",
        migration_provenance: {
          source_path: ".agentera/progress.yaml",
          source_record_sha256: "a".repeat(64),
        },
      },
    }));
    const runGit = shallow ? (args: string[], cwd: string) => {
      if (args.join(" ") === "rev-parse --is-shallow-repository") {
        return { status: 0, stdout: "true\n", timedOut: false };
      }
      const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
      return { status: result.status, stdout: String(result.stdout ?? ""), timedOut: false, ...(result.error ? { error: result.error.message } : {}) };
    } : undefined;

    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot, ...(runGit ? { runGit } : {}) })).toMatchObject({
      status: "unavailable",
      entries: [{
        local: { status: "corrupt" },
        git: { status: "unavailable", reason: "not_committed", reachable_recovery: false },
      }],
    });
  });

  it("fails Git evidence closed when an entity path is replaced before its bytes are pinned", () => {
    const root = gitProject();
    const target = writeEntity(root);
    git(root, ["add", ".agentera"]); git(root, ["commit", "--quiet", "-m", "entity"]);
    const outside = path.join(root, "outside.yaml");
    fs.writeFileSync(outside, entityBytes());
    const originalOpenSync = fs.openSync;
    let replaced = false;
    const open = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (!replaced && path.resolve(String(file)) === target) {
        replaced = true;
        fs.renameSync(target, `${target}.replaced`);
        fs.symlinkSync(outside, target);
      }
      return originalOpenSync(file, flags, mode);
    });
    try {
      expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
        status: "unavailable",
        entries: [{ local: { status: "corrupt" }, git: { status: "unavailable", reason: "committed_content_mismatch" } }],
      });
      expect(replaced).toBe(true);
    } finally {
      open.mockRestore();
    }
  });

  it("binds committed compacted summaries to the preserved aggregate blob from the same commit", () => {
    const root = gitProject();
    const source = { number: 1, summary: "committed summary" };
    const sourceDigest = createHash("sha256").update(canonicalRecordJson(source)).digest("hex");
    const directory = path.join(root, ".agentera/entities/progress/progress_summary");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "archive:\n  - number: 1\n    summary: committed summary\n");
    fs.writeFileSync(path.join(directory, "aaaaaaaaaa.yaml"), dumpYamlMapping({
      id: "aaaaaaaaaa",
      artifact: "progress",
      record: { summary: source.summary, migration_provenance: { source_path: ".agentera/progress.yaml", source_record_sha256: sourceDigest } },
    }));
    git(root, ["add", ".agentera"]);
    git(root, ["commit", "--quiet", "-m", "summary"]);

    const entityPath = path.join(directory, "aaaaaaaaaa.yaml");
    const committedEntityBytes = fs.readFileSync(entityPath, "utf8");
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "archive:\n  - number: 1\n    summary: divergent worktree source\n");
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      status: "degraded", entries: [{ local: { status: "corrupt" }, git: { status: "verified", reason: "reachable_head", reachable_recovery: true } }],
    });
    fs.writeFileSync(entityPath, committedEntityBytes.replace("summary: committed summary", "summary: changed local entity"));
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      entries: [{ local: { status: "corrupt" }, git: { status: "unavailable", reason: "committed_content_mismatch" } }],
    });
    fs.writeFileSync(entityPath, committedEntityBytes);
    fs.rmSync(entityPath);
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      entries: [{ local: { status: "unavailable" }, git: { status: "verified", reason: "reachable_head" } }],
    });
    git(root, ["checkout", "--", ".agentera"]);

    fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      entries: [{ git: { status: "verified", reason: "reachable_head", reachable_recovery: true } }],
    });

    git(root, ["checkout", "--", ".agentera"]);
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "archive:\n  - number: 1\n    summary: forged replacement\n");
    git(root, ["add", ".agentera/progress.yaml"]);
    git(root, ["commit", "--quiet", "-m", "diverge source"]);
    fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      entries: [{ git: { status: "unavailable", reason: "committed_entity_invalid", reachable_recovery: false } }],
    });

    git(root, ["checkout", "--", ".agentera"]);
    git(root, ["rm", "--quiet", ".agentera/progress.yaml"]);
    git(root, ["commit", "--quiet", "-m", "remove source"]);
    fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "progress", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      entries: [{ git: { status: "unavailable", reason: "committed_entity_invalid", reachable_recovery: false } }],
    });
  });

  it.each(["current_projection", "verified_archive"] as const)("binds inherited-confidence %s durability to its exact same-commit source", (sourceKind) => {
    const root = gitProject();
    const canonical = { date: "2026-07-17", question: "Q", context: "C", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "R", confidence: "high" };
    const sourceRecord = { number: 1, ...canonical };
    const digest = createHash("sha256").update(canonicalRecordJson(sourceRecord)).digest("hex");
    const sourcePath = sourceKind === "current_projection" ? ".agentera/decisions.yaml" : ".agentera/archive/decisions/1.yaml";
    const sourceBytes = (record = sourceRecord, entryNumber = 1) => sourceKind === "current_projection"
      ? dumpYamlMapping({ decisions: [record] })
      : dumpYamlMapping({ schemaVersion: "agentera.stateArchiveEntry.v1", artifact_id: "decisions", entry_number: entryNumber, record, record_sha256: createHash("sha256").update(canonicalRecordJson(record)).digest("hex") });
    const directory = path.join(root, ".agentera/entities/decisions/decision");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.mkdirSync(path.dirname(path.join(root, sourcePath)), { recursive: true });
    fs.writeFileSync(path.join(root, sourcePath), sourceBytes());
    const entityPath = path.join(directory, "aaaaaaaaaa.yaml");
    fs.writeFileSync(entityPath, dumpYamlMapping({ id: "aaaaaaaaaa", artifact: "decisions", migration_provenance: { kind: "inherited_decision_confidence", source: sourceKind, source_path: sourcePath, source_record_sha256: digest, confidence: "high" }, record: canonical }));
    git(root, ["add", ".agentera"]); git(root, ["commit", "--quiet", "-m", "inherited source"]);

    const committedEntityBytes = fs.readFileSync(entityPath, "utf8");
    fs.writeFileSync(path.join(root, sourcePath), sourceBytes({ ...sourceRecord, choice: "worktree divergence" }));
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({
      status: "degraded", entries: [{ local: { status: "corrupt" }, git: { status: "verified", reason: "reachable_head", reachable_recovery: true } }],
    });
    const changedEntity = JSON.parse(JSON.stringify(canonical)); changedEntity.choice = "changed local entity";
    fs.writeFileSync(entityPath, dumpYamlMapping({ id: "aaaaaaaaaa", artifact: "decisions", migration_provenance: { kind: "inherited_decision_confidence", source: sourceKind, source_path: sourcePath, source_record_sha256: digest, confidence: "high" }, record: changedEntity }));
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ local: { status: "corrupt" }, git: { status: "unavailable", reason: "committed_content_mismatch" } }] });
    fs.writeFileSync(entityPath, committedEntityBytes); fs.rmSync(entityPath);
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ local: { status: "unavailable" }, git: { status: "verified", reason: "reachable_head" } }] });
    git(root, ["checkout", "--", ".agentera"]);

    fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "verified", reason: "reachable_head" } }] });

    git(root, ["checkout", "--", ".agentera"]);
    fs.writeFileSync(path.join(root, sourcePath), sourceBytes({ ...sourceRecord, choice: "forged" }));
    git(root, ["add", sourcePath]); git(root, ["commit", "--quiet", "-m", "forge source"]); fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "unavailable", reason: "committed_entity_invalid" } }] });

    git(root, ["checkout", "--", ".agentera"]);
    fs.writeFileSync(path.join(root, sourcePath), sourceBytes(sourceKind === "current_projection" ? { ...sourceRecord, number: 2 } : sourceRecord, 2));
    git(root, ["add", sourcePath]); git(root, ["commit", "--quiet", "-m", "mismatch source identity"]); fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "unavailable", reason: "committed_entity_invalid" } }] });

    git(root, ["checkout", "--", ".agentera"]); git(root, ["rm", "--quiet", sourcePath]); git(root, ["commit", "--quiet", "-m", "remove inherited source"]); fs.rmSync(path.join(root, ".agentera"), { recursive: true });
    expect(inspectDurability(root, { artifact: "decisions", id: "aaaaaaaaaa" }, { sourceRoot })).toMatchObject({ entries: [{ git: { status: "unavailable", reason: "committed_entity_invalid" } }] });
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
        syntax: "agentera check durability --artifact ARTIFACT --id ID",
        example: expect.stringContaining("agentera check durability"),
        recovery: expect.any(String),
      },
    });
  });
});
