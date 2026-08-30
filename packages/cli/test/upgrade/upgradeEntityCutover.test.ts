import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { main } from "../../src/cli/dispatch.js";
import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { detectStateMode } from "../../src/state/stateMode.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { FORWARD_MANIFEST, applyPreparedEntityCutover, prepareEntityCutoverForUpgrade } from "../../src/state/entityCutover.js";
import { previewEntityMigration } from "../../src/state/entityMigrationPreview.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { setSuccessorAnnouncedOverrideForTests } from "../../src/upgrade/nextMajorDoctor.js";
import { gitCommitArgs } from "../helpers/git.js";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURE = path.join(import.meta.dirname, "fixtures/v2-yaml-project");
const V2_COMPACTION_OUTPUT = path.join(import.meta.dirname, "../fixtures/v2-compaction-2.7.11/output");
const LARGE_CUTOVER_TIMEOUT_MS = 240_000;
const roots: string[] = [];

function managedV2(home: string): string {
  const appHome = path.join(home, "agentera");
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts/agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills/agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills/agentera/SKILL.md"), "x");
  fs.writeFileSync(path.join(app, "registry.json"), JSON.stringify({ skills: [{ name: "agentera", version: "2.7.0" }] }));
  fs.writeFileSync(path.join(app, BUNDLE_MARKER), JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: "2.7.0" }));
  return appHome;
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-cutover-"));
  roots.push(root);
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function todoId(index: number): string {
  let value = index;
  let suffix = "";
  for (let digit = 0; digit < 6; digit += 1) { suffix = String.fromCharCode(97 + value % 26) + suffix; value = Math.floor(value / 26); }
  return `item${suffix}`;
}

function precreatedTodoProject(count: number, options: { explicit?: boolean; duplicateDescription?: boolean } = {}): string {
  const root = project();
  const rows: string[] = ["# TODO", "", "Unrelated project note.", "", "## ⇶ Critical"];
  const directory = path.join(root, ".agentera/entities/todo/todo_item");
  fs.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    if (index === 2) rows.push("", "## Client-specific work");
    const id = todoId(index);
    const description = options.duplicateDescription && index < 2 ? "Same task" : `Task ${index}`;
    const resolved = index % 3 === 1;
    const indent = index % 2 ? "  " : "";
    rows.push(`${indent}- [${resolved ? "x" : " "}] ${options.explicit ? `[id:${id}] ` : ""}${description}`);
    fs.writeFileSync(path.join(directory, `${id}.yaml`), YAML.stringify({
      id,
      artifact: "todo",
      record: { severity: "critical", status: "open", description, readiness: { capability: "build", reason: "Preserve operational state", dependencies: [], blocked: null, gate: null, queue_rank: index + 1, order_reason: "Fixture order" } },
    }));
  }
  rows.push("", "Unrelated closing note.", "");
  fs.writeFileSync(path.join(root, "TODO.md"), rows.join("\n"));
  return root;
}

/** The clean lifecycle fixture retains only the pinned compactor's supported summary families. */
function compactedProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v2-compaction-cutover-"));
  roots.push(root);
  for (const relative of ["TODO.md", ".agentera/progress.yaml", ".agentera/decisions.yaml", ".agentera/health.yaml"]) {
    const source = path.join(V2_COMPACTION_OUTPUT, relative);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.cpSync(path.join(V2_COMPACTION_OUTPUT, ".agentera/optimera"), path.join(root, ".agentera/optimera"), { recursive: true });
  return root;
}

function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return String(result.stdout).trim();
}

function initializeGit(root: string): void {
  git(root, "init", "--quiet");
  git(root, "add", ".");
  git(root, ...gitCommitArgs("--quiet", "-m", "v2 state"));
}

function applyUpgrade(
  root: string,
  appHome: string,
  home: string,
  only?: readonly ("artifacts" | "runtime" | "cleanup")[],
  format: "text" | "json" = "text",
  verification?: Parameters<typeof cmdUpgrade>[2],
): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = cmdUpgrade({ installRoot: appHome, home, project: root, channel: "development", yes: true, only, format }, { out: (value) => { out += value; }, err: (value) => { err += value; } }, verification);
  return { code, out, err };
}

function previewUpgrade(root: string, appHome: string, home: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = cmdUpgrade({ installRoot: appHome, home, project: root, channel: "development", format: "json" }, { out: (value) => { out += value; }, err: (value) => { err += value; } });
  return { code, out, err };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function aggregateHashes(root: string): Record<string, string> {
  const paths = ["TODO.md", ".agentera/progress.yaml", ".agentera/decisions.yaml", ".agentera/health.yaml"];
  return Object.fromEntries(paths.filter((relative) => fs.existsSync(path.join(root, relative))).map((relative) => [relative, sha256(fs.readFileSync(path.join(root, relative)))]));
}

function capture(root: string, args: string[], stdin = ""): { code: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const code = main(["node", "agentera", ...args], { out: (value) => { out += value; }, err: (value) => { err += value; }, stdin: () => stdin });
    return { code, out, err };
  } finally {
    process.chdir(previous);
  }
}

function treeBytes(root: string, relative = "."): Record<string, string> {
  const result: Record<string, string> = {};
  const base = path.join(root, relative);
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) result[path.relative(root, absolute).split(path.sep).join("/")] = `link:${fs.readlinkSync(absolute)}`;
      else if (entry.isDirectory()) visit(absolute);
      else result[path.relative(root, absolute).split(path.sep).join("/")] = fs.readFileSync(absolute).toString("base64");
    }
  };
  if (fs.existsSync(base)) visit(base);
  return result;
}

function files(root: string): string[] {
  return Object.keys(treeBytes(root)).sort();
}

beforeEach(() => {
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = SOURCE_ROOT;
  setSuccessorAnnouncedOverrideForTests(true);
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;
  delete process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE;
  delete process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET;
  setSuccessorAnnouncedOverrideForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("one-way Git entity cutover", () => {
  it("reports the public upgrade preview contract for a representative v2 project", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-preview-"));
    roots.push(home);

    const preview = previewUpgrade(root, managedV2(home), home);

    expect(preview.code, `${preview.out}\n${preview.err}`).toBe(1);
    expect(JSON.parse(preview.out)).toMatchObject({ schemaVersion: "agentera.upgrade.v2", mode: "plan" });
  });

  it("reconciles a compact hierarchical TODO without duplicate projection or resurrection", () => {
    const root = precreatedTodoProject(4);
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-todo-compact-"));
    roots.push(home);
    const applied = applyUpgrade(root, managedV2(home), home);

    expect(applied, `${applied.out}\n${applied.err}`).toMatchObject({ code: 0, err: "" });
    const markdown = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
    expect([...markdown.matchAll(/\[id:([a-z]{10})\]/g)].map((match) => match[1])).toEqual([0, 1, 2, 3].map(todoId));
    expect(markdown.match(/^- \[[ x]\]/gm)).toHaveLength(2);
    expect(markdown).not.toContain("## → Normal");
    expect(markdown).toContain("Unrelated project note.");
    expect(markdown).toContain("## Client-specific work");
    const records = fs.readdirSync(path.join(root, ".agentera/entities/todo/todo_item")).map((name) => YAML.parse(fs.readFileSync(path.join(root, ".agentera/entities/todo/todo_item", name), "utf8")).record);
    expect(records).toHaveLength(4);
    expect(records.map((record) => record.status).sort()).toEqual(["open", "open", "open", "resolved"]);
    expect(records.map((record) => record.description).sort()).toEqual(["Task 0", "Task 1", "Task 2", "Task 3"]);
    expect(records.map((record) => record.readiness?.queue_rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(records.every((record) => record.readiness?.reason === "Preserve operational state")).toBe(true);
    expect(applyUpgrade(root, managedV2(home), home).code).toBe(0);
    expect(fs.readdirSync(path.join(root, ".agentera/entities/todo/todo_item"))).toHaveLength(4);
  }, LARGE_CUTOVER_TIMEOUT_MS);

  it("uses an explicit row ID while importing stale public entity values", () => {
    const root = precreatedTodoProject(1, { explicit: true });
    const entityPath = path.join(root, `.agentera/entities/todo/todo_item/${todoId(0)}.yaml`);
    const envelope = YAML.parse(fs.readFileSync(entityPath, "utf8"));
    envelope.record.description = "Stale entity text";
    fs.writeFileSync(entityPath, YAML.stringify(envelope));
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-todo-explicit-")); roots.push(home);
    const applied = applyUpgrade(root, managedV2(home), home);
    expect(applied.code, `${applied.out}\n${applied.err}`).toBe(0);
    expect(YAML.parse(fs.readFileSync(entityPath, "utf8")).record.description).toBe("Task 0");
  });

  it.each([
    ["unmatched", () => precreatedTodoProject(1), (root: string) => fs.writeFileSync(path.join(root, "TODO.md"), fs.readFileSync(path.join(root, "TODO.md"), "utf8").replace("Task 0", "Different task"))],
    ["unknown explicit ID", () => precreatedTodoProject(1, { explicit: true }), (root: string) => fs.writeFileSync(path.join(root, "TODO.md"), fs.readFileSync(path.join(root, "TODO.md"), "utf8").replace(todoId(0), "zzzzzzzzzz"))],
    ["ambiguous", () => precreatedTodoProject(2, { duplicateDescription: true }), (_root: string) => {}],
    ["stale activation", () => precreatedTodoProject(1), (root: string) => fs.writeFileSync(path.join(root, ".agentera/todo-reconciliation-activation.json"), '{"schema_version":"agentera.todoReconciliationActivation.v1","retained_legacy_rows":[]}\n')],
  ])("rejects %s cutover evidence before tracked or activation effects", (_name, makeRoot, mutate) => {
    const root = makeRoot(); mutate(root); initializeGit(root);
    const before = treeBytes(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-todo-reject-")); roots.push(home);
    const failed = applyUpgrade(root, managedV2(home), home);
    expect(failed.code).not.toBe(0);
    expect(treeBytes(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  });

  it("recovers an interrupted TODO cutover with the same IDs and final public state", () => {
    const root = precreatedTodoProject(4);
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-todo-retry-")); roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET = "2";
    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    delete process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET;
    const recovered = applyUpgrade(root, appHome, home);
    expect(recovered.code, `${recovered.out}\n${recovered.err}`).toBe(0);
    const markdown = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
    expect([...markdown.matchAll(/\[id:([a-z]{10})\]/g)].map((match) => match[1])).toEqual([0, 1, 2, 3].map(todoId));
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toBe(markdown);
  }, 30_000);

  it("recovers interrupted cutover when managed Markdown already has every final ID", () => {
    const root = precreatedTodoProject(2, { explicit: true });
    initializeGit(root);
    const markdownBefore = fs.readFileSync(path.join(root, "TODO.md"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-todo-explicit-retry-")); roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET = "1";
    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    delete process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET;

    const recovered = applyUpgrade(root, appHome, home);

    expect(recovered.code, `${recovered.out}\n${recovered.err}`).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(markdownBefore);
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(markdownBefore);
  }, 30_000);

  it("rejects unmatched entity drift before resuming an interrupted TODO cutover", () => {
    const root = precreatedTodoProject(4);
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-todo-drift-")); roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET = "2";
    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    delete process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET;

    const extraId = "extratodoa";
    const extraPath = path.join(root, `.agentera/entities/todo/todo_item/${extraId}.yaml`);
    fs.writeFileSync(extraPath, YAML.stringify({
      id: extraId,
      artifact: "todo",
      record: {
        severity: "critical",
        status: "open",
        description: "Unmatched interrupted-cutover drift",
        readiness: { capability: "build", reason: "Injected regression evidence", dependencies: [], blocked: null, gate: null, queue_rank: 5, order_reason: "Injected after interruption" },
        reconciliation: { schema_version: "agentera.todoReconciliation.v1", public: { present: true, description: "Unmatched interrupted-cutover drift", severity: "critical", status: "open", order: 5 } },
      },
    }));
    const driftValidation = validateEntityState(root, SOURCE_ROOT, { kind: "migration_preview", projectRoot: root });
    expect(driftValidation.valid, JSON.stringify(driftValidation.issues)).toBe(true);
    const beforeRetry = treeBytes(root);
    const journalBefore = treeBytes(root, ".agentera/.todo-reconciliation");

    const rejected = applyUpgrade(root, appHome, home);

    expect(rejected.code).not.toBe(0);
    expect(rejected.err).toMatch(/complete validated target set/i);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(rejected.err).toMatch(/unmatched|one-to-one|not part of/i);
    expect(treeBytes(root)).toEqual(beforeRetry);
    expect(treeBytes(root, ".agentera/.todo-reconciliation")).toEqual(journalBefore);

    fs.rmSync(extraPath);
    const corrected = applyUpgrade(root, appHome, home);
    expect(corrected.code, `${corrected.out}\n${corrected.err}`).toBe(0);
    const finalEntities = treeBytes(root, ".agentera/entities");
    const finalMarkdown = fs.readFileSync(path.join(root, "TODO.md"));
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    expect(treeBytes(root, ".agentera/entities")).toEqual(finalEntities);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(finalMarkdown);
  }, 30_000);

  it("rejects an added non-TODO entity before resuming an interrupted TODO cutover", () => {
    const root = precreatedTodoProject(4);
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-non-todo-add-")); roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET = "2";
    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    delete process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET;

    const planDirectory = path.join(root, ".agentera/entities/plan/plan");
    const originalPlan = path.join(planDirectory, fs.readdirSync(planDirectory)[0]!);
    const extraId = "extraplana";
    const extraPath = path.join(planDirectory, `${extraId}.yaml`);
    const extra = YAML.parse(fs.readFileSync(originalPlan, "utf8"));
    extra.id = extraId;
    fs.writeFileSync(extraPath, YAML.stringify(extra));
    const driftValidation = validateEntityState(root, SOURCE_ROOT, { kind: "migration_preview", projectRoot: root });
    expect(driftValidation.valid, JSON.stringify(driftValidation.issues)).toBe(true);
    const beforeRetry = treeBytes(root);
    const journalBefore = treeBytes(root, ".agentera/.todo-reconciliation");

    const rejected = applyUpgrade(root, appHome, home);

    expect(rejected.code).not.toBe(0);
    expect(rejected.err).toMatch(/complete validated target set/i);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(treeBytes(root)).toEqual(beforeRetry);
    expect(treeBytes(root, ".agentera/.todo-reconciliation")).toEqual(journalBefore);

    fs.rmSync(extraPath);
    const corrected = applyUpgrade(root, appHome, home);
    expect(corrected.code, `${corrected.out}\n${corrected.err}`).toBe(0);
    const finalEntities = treeBytes(root, ".agentera/entities");
    const finalMarkdown = fs.readFileSync(path.join(root, "TODO.md"));
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    expect(treeBytes(root, ".agentera/entities")).toEqual(finalEntities);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(finalMarkdown);
  }, 30_000);

  it("rejects a missing non-TODO entity before resuming an interrupted TODO cutover", () => {
    const root = precreatedTodoProject(4);
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-non-todo-missing-")); roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET = "2";
    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    delete process.env.AGENTERA_FAULT_INJECT_TODO_CUTOVER_AFTER_TARGET;

    const planDirectory = path.join(root, ".agentera/entities/plan/plan");
    const planPath = path.join(planDirectory, fs.readdirSync(planDirectory)[0]!);
    const planBytes = fs.readFileSync(planPath);
    fs.rmSync(planPath);
    const driftValidation = validateEntityState(root, SOURCE_ROOT, { kind: "migration_preview", projectRoot: root });
    expect(driftValidation.valid, JSON.stringify(driftValidation.issues)).toBe(true);
    const beforeRetry = treeBytes(root);
    const journalBefore = treeBytes(root, ".agentera/.todo-reconciliation");

    const rejected = applyUpgrade(root, appHome, home);

    expect(rejected.code).not.toBe(0);
    expect(rejected.err).toMatch(/complete validated target set/i);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(treeBytes(root)).toEqual(beforeRetry);
    expect(treeBytes(root, ".agentera/.todo-reconciliation")).toEqual(journalBefore);

    fs.writeFileSync(planPath, planBytes);
    const corrected = applyUpgrade(root, appHome, home);
    expect(corrected.code, `${corrected.out}\n${corrected.err}`).toBe(0);
    const finalEntities = treeBytes(root, ".agentera/entities");
    const finalMarkdown = fs.readFileSync(path.join(root, "TODO.md"));
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    expect(treeBytes(root, ".agentera/entities")).toEqual(finalEntities);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(finalMarkdown);
  }, 30_000);

  it("cuts over a clean tracked v2 project without consuming or deleting migration inputs", () => {
    const root = project();
    const appHome = managedV2(root);
    initializeGit(root);
    const sourceBefore = new Map([
      [".agentera/plan.yaml", fs.readFileSync(path.join(root, ".agentera/plan.yaml"))],
      [".agentera/progress.yaml", fs.readFileSync(path.join(root, ".agentera/progress.yaml"))],
    ]);
    const home = root;

    const applied = applyUpgrade(root, appHome, home);

    expect(applied).toMatchObject({ code: 0, err: "" });
    expect(applied.out).toBe("Agentera upgraded this project from v2 to v3; state and startup validation passed.\n");
    expect(applied.out).not.toMatch(/manifest|migration|receipt|snapshot|rollback|operation[_ -]?id/i);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    for (const [relative, bytes] of sourceBefore) expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/migrations/entities"))).toBe(false);
    expect(files(root).some((file) => /(?:snapshot|journal|receipts)/.test(file))).toBe(false);
    expect(capture(root, ["state", "plan", "list", "--format", "json"])).toMatchObject({ code: 0 });
  }, 30_000);

  it("cuts over valid compacted summaries as immutable degraded entities and replays them exactly", () => {
    const root = project();
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "cycles:\n  - number: 1\n    summary: Retained progress summary only.\n");
    fs.writeFileSync(path.join(root, ".agentera/decisions.yaml"), "decisions:\n  - number: 1\n    summary: Retained decision summary only.\n    satisfaction:\n      state: user_confirmed_satisfied\n");
    fs.writeFileSync(path.join(root, ".agentera/health.yaml"), "audits:\n  - number: 1\n    summary: Retained health summary only.\n");
    initializeGit(root);
    const prepared = prepareEntityCutoverForUpgrade(root, SOURCE_ROOT);
    expect(applyPreparedEntityCutover(prepared)).toMatchObject({ status: "complete", idempotent: false, mutation_performed: true });
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    for (const [artifact, boundary] of [["progress", "progress_summary"], ["decisions", "decision_summary"], ["health", "health_summary"]]) {
      const files = fs.readdirSync(path.join(root, `.agentera/entities/${artifact}/${boundary}`));
      expect(files).toHaveLength(1);
      expect(capture(root, ["check", "validate", "state", "--format", "json"]).code).toBe(0);
    }
    const decision = fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision_summary"))
      .map((name) => fs.readFileSync(path.join(root, ".agentera/entities/decisions/decision_summary", name), "utf8"))[0];
    expect(decision).toContain("satisfaction:");
    expect(fs.existsSync(path.join(root, ".agentera/entities/decisions/decision_satisfaction"))).toBe(false);
    expect(applyPreparedEntityCutover(prepared)).toMatchObject({ status: "complete", idempotent: true, mutation_performed: false });
  }, 30_000);

  it.each([
    ["project", (root: string, _prepared: ReturnType<typeof prepareEntityCutoverForUpgrade>) => fs.appendFileSync(path.join(root, ".agentera/progress.yaml"), "# drift\n")],
    ["source", (_root: string, prepared: ReturnType<typeof prepareEntityCutoverForUpgrade>) => {
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-source-drift-"));
      roots.push(sourceRoot);
      fs.cpSync(path.join(SOURCE_ROOT, "references/artifacts"), path.join(sourceRoot, "references/artifacts"), { recursive: true });
      fs.cpSync(path.join(SOURCE_ROOT, "skills/agentera"), path.join(sourceRoot, "skills/agentera"), { recursive: true });
      const authority = path.join(sourceRoot, "references/artifacts/state-storage-authority.yaml");
      fs.appendFileSync(authority, "# drift\n");
      prepared.sourceRoot = sourceRoot;
    }],
    ["Git", (root: string, _prepared: ReturnType<typeof prepareEntityCutoverForUpgrade>) => git(root, ...gitCommitArgs("--quiet", "--allow-empty", "-m", "drift"))],
  ])("rejects %s drift after preparation before the first effect", (_kind, mutate) => {
    const root = project();
    initializeGit(root);
    const prepared = prepareEntityCutoverForUpgrade(root, SOURCE_ROOT);
    mutate(root, prepared);

    expect(() => applyPreparedEntityCutover(prepared)).toThrow(/changed|modified or renamed/);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  });

  it("completes the pinned v2 compaction lifecycle without changing preserved aggregate bytes", () => {
    const root = compactedProject();
    const rawTodo = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
    expect(rawTodo).toMatch(/^## Resolved$/m);
    expect(rawTodo).not.toMatch(/^## ✓ Resolved$/m);
    const protectedExperiments = treeBytes(root, ".agentera/optimera");
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-v2-compaction-home-"));
    roots.push(home);
    const appHome = managedV2(home);
    const { "TODO.md": todoBefore, ...aggregateBefore } = aggregateHashes(root);
    const assertSourcesUnchanged = (expectedTodo: string | null = todoBefore) => {
      const { "TODO.md": _todo, ...current } = aggregateHashes(root);
      expect(current).toEqual(aggregateBefore);
      if (expectedTodo) expect(sha256(fs.readFileSync(path.join(root, "TODO.md")))).toBe(expectedTodo);
      expect(treeBytes(root, ".agentera/optimera")).toEqual(protectedExperiments);
    };
    const preview = previewEntityMigration(root, SOURCE_ROOT, { limit: 1000 });
    const previewEntries = [...preview.entries];
    let previewPage = preview;
    while (previewPage.next_after) {
      previewPage = previewEntityMigration(root, SOURCE_ROOT, {
        limit: 1000,
        after: previewPage.next_after,
        sourceFingerprint: previewPage.source_fingerprint,
        previewDigest: previewPage.preview_digest,
      });
      previewEntries.push(...previewPage.entries);
    }
    expect(preview).toMatchObject({ status: "ready", read_only: true, mutation_performed: false });
    expect(preview.counts).toMatchObject({ blockers: 0, root_blockers: 0, dependent_blockers: 0 });
    expect(preview.counts.valid_compacted_summary).toBeGreaterThan(0);
    const targets = previewEntries.filter((entry) => entry.proposed_target !== null);
    expect(new Set(previewEntries.map((entry) => entry.source_identity)).size).toBe(previewEntries.length);
    expect(previewEntries).toHaveLength(preview.counts.total);
    expect(new Set(targets.map((entry) => entry.proposed_target!.id)).size).toBe(targets.length);
    assertSourcesUnchanged();
    const applied = applyUpgrade(root, appHome, home);
    expect(applied).toMatchObject({ code: 0, err: "" });
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(capture(root, ["check", "validate", "state", "--format", "json"]).code).toBe(0);
    const marker = fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"));
    expect(marker).toEqual(Buffer.from(dumpYamlMapping({ schemaVersion: "agentera.stateMode.v1", mode: "entities", source_fingerprint: preview.source_fingerprint, preview_digest: preview.preview_digest })));
    const finalEntities = treeBytes(root, ".agentera/entities");
    expect(Object.keys(finalEntities)).toHaveLength(preview.counts.publishable_entities);
    const entityIds = new Set<string>();
    for (const entry of targets) {
      const target = entry.proposed_target!;
      const bytes = fs.readFileSync(path.join(root, target.path));
      expect(sha256(bytes)).toBe(entry.target_sha256);
      const envelope = YAML.parse(bytes.toString("utf8"));
      expect(envelope).toMatchObject({ id: target.id, artifact: entry.artifact });
      expect(entityIds.has(envelope.id)).toBe(false);
      entityIds.add(envelope.id);
    }
    expect(entityIds.size).toBe(targets.length);
    assertSourcesUnchanged(null);
    const migratedTodo = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
    expect(migratedTodo).toMatch(/^## ✓ Resolved$/m);
    expect(migratedTodo).not.toMatch(/^## Resolved$/m);
    expect(sha256(Buffer.from(migratedTodo))).not.toBe(todoBefore);
  }, LARGE_CUTOVER_TIMEOUT_MS);

  it("refuses authority-undeclared aggregate collections before any cutover effect", () => {
    const root = project();
    fs.appendFileSync(path.join(root, ".agentera/progress.yaml"), "hidden_rows:\n  - number: 99\n    summary: concealed\n");
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-blocked-summary-"));
    roots.push(home);
    const appHome = managedV2(home);
    const before = treeBytes(root);
    const appBefore = treeBytes(appHome);
    expect(() => prepareEntityCutoverForUpgrade(root, SOURCE_ROOT)).toThrow(/not declared/i);
    expect(treeBytes(root)).toEqual(before);
    const failed = applyUpgrade(root, appHome, home);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toMatch(/not declared|hidden/i);
    expect(treeBytes(root)).toEqual(before);
    expect(treeBytes(appHome)).toEqual(appBefore);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("legacy");
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
  });

  it.each([
    ["ignored migration input", (root: string) => { fs.writeFileSync(path.join(root, ".gitignore"), ".agentera/progress.yaml\n"); initializeGit(root); }],
    ["untracked migration input", (root: string) => { const file = path.join(root, ".agentera/progress.yaml"); const bytes = fs.readFileSync(file); fs.rmSync(file); initializeGit(root); fs.writeFileSync(file, bytes); }],
    ["staged migration input", (root: string) => { initializeGit(root); fs.appendFileSync(path.join(root, ".agentera/plan.yaml"), "# staged\n"); git(root, "add", ".agentera/plan.yaml"); }],
    ["modified migration input", (root: string) => { initializeGit(root); fs.appendFileSync(path.join(root, ".agentera/plan.yaml"), "# modified\n"); }],
    ["renamed migration input", (root: string) => { initializeGit(root); git(root, "mv", ".agentera/progress.yaml", ".agentera/progress-renamed.yaml"); }],
    ["unsafe migration input", (root: string) => { initializeGit(root); fs.rmSync(path.join(root, ".agentera/progress.yaml")); fs.symlinkSync("plan.yaml", path.join(root, ".agentera/progress.yaml")); }],
    ["unsupported tracked source", (root: string) => { fs.mkdirSync(path.join(root, ".agentera/archive/progress"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/archive/progress/not-a-number.yaml"), "record: {}\n"); initializeGit(root); }],
    ["unrelated dirty checkout", (root: string) => { initializeGit(root); fs.writeFileSync(path.join(root, "notes.txt"), "dirty\n"); }],
  ])("refuses %s before every selected effect", (_label, arrange) => {
    const root = project();
    arrange(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-refusal-"));
    roots.push(home);
    const appHome = managedV2(home);
    const projectBefore = treeBytes(root);
    const appBefore = treeBytes(appHome);

    const refused = applyUpgrade(root, appHome, home);

    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("Recover the tracked v2 checkout with Git and retry");
    expect(refused.err).not.toMatch(/rollback|migration[_ -]?id|manifest|receipt|snapshot/i);
    expect(treeBytes(root)).toEqual(projectBefore);
    expect(treeBytes(appHome)).toEqual(appBefore);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
  }, 30_000);

  it("refuses non-Git and every partial cross-major apply", () => {
    for (const only of [undefined, ["artifacts"] as const, ["runtime"] as const, ["cleanup"] as const]) {
      const root = project();
      if (only) initializeGit(root);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-shape-"));
      roots.push(home);
      const appHome = managedV2(home);
      const before = treeBytes(root);

      const refused = applyUpgrade(root, appHome, home, only);

      expect(refused.code).not.toBe(0);
      expect(treeBytes(root)).toEqual(before);
      expect(fs.existsSync(path.join(appHome, "app"))).toBe(true);
    }
  }, 30_000);

  it("accepts exact partial targets and continues at the first missing path", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-stage-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "entity_published";

    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    const partial = files(path.join(root, ".agentera/entities"));
    expect(partial).toHaveLength(1);
    const exact = path.join(root, ".agentera/entities", partial[0]);
    const inode = fs.statSync(exact, { bigint: true }).ino;
    delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;

    const initial = applyUpgrade(root, appHome, home);
    expect(initial.code, initial.err).toBe(0);
    expect(fs.statSync(exact, { bigint: true }).ino).toBe(inode);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
  }, 30_000);

  it("stops at a divergent target and names its path without activating", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-forward-"));
    roots.push(home);
    const appHome = managedV2(home);
    const sourceBefore = fs.readFileSync(path.join(root, ".agentera/progress.yaml"));
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "entity_published";

    expect(applyUpgrade(root, appHome, home).code).not.toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    const relative = files(path.join(root, ".agentera/entities"))[0];
    fs.writeFileSync(path.join(root, ".agentera/entities", relative), "divergent target\n");
    delete process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE;

    const failed = applyUpgrade(root, appHome, home);
    expect(failed.code).not.toBe(0);
    expect(failed.err).toContain(`.agentera/entities/${relative}`);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".agentera/progress.yaml"))).toEqual(sourceBefore);
  }, 30_000);

  it("leaves the marker absent when its last publication step fails", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-marker-fault-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_ENTITY_MIGRATION_AFTER_PHASE = "before_marker";

    const failed = applyUpgrade(root, appHome, home);

    expect(failed.code).not.toBe(0);
    expect(files(path.join(root, ".agentera/entities")).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
  }, 30_000);

  it("keeps recovery forward when cleanup fails after entity authority activates", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-post-marker-failure-"));
    roots.push(home);
    const appHome = managedV2(home);
    process.env.AGENTERA_FAULT_INJECT_V2_CLEANUP_FAILURE = "1";

    const failed = applyUpgrade(root, appHome, home);

    expect(failed.code).toBe(1);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(failed.err).toContain("Rerun the same upgrade command to continue forward");
    expect(failed.err).not.toMatch(/Recover the tracked v2 checkout with Git|no v3 authority was activated/i);
  }, 30_000);

  it("activates valid entities before handing off blocked runtime work", () => {
    const root = project();
    const hooks = path.join(root, ".codex/hooks/codex-hooks.json");
    fs.mkdirSync(path.dirname(hooks), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex/config.toml"), '[plugins."agentera@agentera"]\nenabled = true\n');
    fs.writeFileSync(hooks, '{"user":"hooks/validate_artifact.py"}\n');
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-runtime-blocked-"));
    roots.push(home);
    const appHome = managedV2(home);
    const resourceBefore = fs.readFileSync(hooks);

    const failed = applyUpgrade(root, appHome, home);

    expect(failed.code).toBe(1);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
    expect(fs.readFileSync(hooks)).toEqual(resourceBefore);
    expect(failed.err).toContain("action-required after entity activation");
    expect(failed.err).toContain(".codex/hooks/codex-hooks.json");
  }, 30_000);

  it("retires proven Codex, Cursor, and Copilot v2 hooks without installing native integrations", () => {
    const root = project();
    const codexHooks = path.join(root, ".codex/hooks/codex-hooks.json");
    const cursorHooks = path.join(root, ".cursor/hooks.json");
    const copilotHooks = path.join(root, ".github/hooks/agentera.json");
    for (const hooks of [codexHooks, cursorHooks, copilotHooks]) {
      fs.mkdirSync(path.dirname(hooks), { recursive: true });
      fs.writeFileSync(hooks, '{"command":"uv run ${AGENTERA_HOME}/hooks/validate_artifact.py"}\n');
    }
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-selector-free-"));
    roots.push(home);
    const skill = path.join(home, ".agents/skills/agentera");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "keep.txt"), "user-owned\n");
    const skillBefore = treeBytes(home, ".agents/skills/agentera");
    const appHome = managedV2(home);

    const applied = applyUpgrade(root, appHome, home);

    expect(applied.code, applied.err).toBe(0);
    for (const hooks of [codexHooks, cursorHooks, copilotHooks]) expect(fs.existsSync(hooks)).toBe(false);
    expect(treeBytes(home, ".agents/skills/agentera")).toEqual(skillBefore);
    expect(fs.existsSync(path.join(root, ".cursor-plugin/plugin.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".cursor/agents/agentera.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".config/opencode/plugins/agentera.js"))).toBe(false);
  }, 30_000);

  it("rejects an explicit retired selector before entity cutover or resource mutation", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-lifecycle-collision-"));
    roots.push(home);
    const skill = path.join(home, ".agents/skills/agentera");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "keep.txt"), "user-owned\n");
    const skillBefore = treeBytes(home, ".agents/skills/agentera");
    const appHome = managedV2(home);
    let out = "";
    let err = "";

    const code = cmdUpgrade(
      { installRoot: appHome, home, project: root, channel: "development", runtime: "all", yes: true },
      { out: (value) => { out += value; }, err: (value) => { err += value; } },
    );

    expect(code, out).toBe(2);
    expect(detectStateMode(root, SOURCE_ROOT)).not.toBe("entities");
    expect(treeBytes(home, ".agents/skills/agentera")).toEqual(skillBefore);
    expect(err).toContain("~/.agents/skills/agentera");
    expect(err).toContain("Remove --runtime");
  }, 30_000);

  it("keeps entity authority active across normal writes and repeated upgrade", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-noop-"));
    roots.push(home);
    const appHome = managedV2(home);
    expect(applyUpgrade(root, appHome, home).code).toBe(0);
    const markerBefore = fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"));

    expect(capture(root, ["state", "progress", "append", "--input", "-", "--format", "json"], "type: fix\nphase: build\nwhat: post-cutover write\ncontext:\n  intent: prove entity authority\n").code).toBe(0);
    expect(capture(root, ["state", "progress", "list", "--format", "json"]).code).toBe(0);
    managedV2(home);

    const repeated = applyUpgrade(root, appHome, home, undefined, "json");
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.out)).toEqual({
      phase: "complete",
      startup_validation: { status: "passed" },
      state_validation: { entity_count: expect.any(Number), issue_count: 0, status: "passed" },
      status: "success",
    });
    expect(fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"))).toEqual(markerBefore);
    expect(fs.existsSync(path.join(root, FORWARD_MANIFEST))).toBe(false);
    expect(capture(root, ["state", "progress", "list", "--format", "json"]).out).toContain("post-cutover write");
  }, 30_000);

  it.each([
    ["state", { state_validation: { status: "failed", entity_count: 2, issue_count: 1 }, startup_validation: { status: "passed" } }],
    ["startup", { state_validation: { status: "passed", entity_count: 2, issue_count: 0 }, startup_validation: { status: "failed" } }],
  ])("exits nonzero with bounded forward guidance when %s validation fails", (_name, result) => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-verify-failure-"));
    roots.push(home);
    const appHome = managedV2(home);

    const failed = applyUpgrade(root, appHome, home, undefined, "json", {
      verifyOneWayUpgrade: () => result,
    });

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toEqual({ phase: "verification", status: "failed", ...result });
    expect(failed.err).toContain("Rerun the same upgrade command to continue forward");
    expect(failed.err).not.toMatch(/rollback|migration[_ -]?id|manifest|receipt|snapshot/i);
    expect(detectStateMode(root, SOURCE_ROOT)).toBe("entities");
  }, 30_000);

  it("does not let successful verification mask missing entity authority", () => {
    const root = project();
    initializeGit(root);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-masked-success-"));
    roots.push(home);
    const appHome = managedV2(home);

    const failed = applyUpgrade(root, appHome, home, undefined, "json", {
      verifyOneWayUpgrade: () => {
        fs.rmSync(path.join(root, ".agentera/state-mode.yaml"));
        return {
          state_validation: { status: "passed", entity_count: 2, issue_count: 0 },
          startup_validation: { status: "passed" },
        };
      },
    });

    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.out)).toMatchObject({ phase: "apply", status: "failed" });
  }, 30_000);

  it("keeps entity migration on upgrade and has no cross-major restore command", () => {
    const root = project();
    const entityHelp = capture(root, ["state", "migrate", "entities", "--help"]);
    expect(entityHelp.code).toBe(0);
    expect(entityHelp.out).not.toContain("state migrate entities");
    expect(entityHelp.out).not.toContain("--dry-run");
    for (const args of [["--apply"], ["--resume", "deadbeef"], ["--rollback", "deadbeef"]]) {
      const rejected = capture(root, ["state", "migrate", "entities", ...args]);
      expect(rejected.code).toBe(1);
      expect(rejected.err).toBe("");
      expect(rejected.out).toContain("upgrade --channel development");
      expect(rejected.out).toContain("--yes");
    }
    expect(capture(root, ["upgrade", "--restore"]).code).toBe(2);
  });
});
