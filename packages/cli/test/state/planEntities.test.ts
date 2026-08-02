import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMigratedDecisionAndProgressSummaries } from "../helpers/migratedSummaryFixture.js";
import { sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { canonicalEntityRecordViolations, validateEntityState } from "../../src/state/entityStorage.js";
import { createPlanEntities } from "../../src/state/planEntities.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { buildExplain } from "../../src/state/write/explain.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { shellCommandArgs } from "../helpers/shellCommand.js";
import { entityListFamily } from "../../src/state/entityRetrievalHelp.js";

const roots: string[] = [];
const VALID_MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";
const supersessionWorker = fileURLToPath(new URL("./planSupersessionWorker.mjs", import.meta.url));
const appendWorker = fileURLToPath(new URL("./planAppendWorker.mjs", import.meta.url));

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-entities-")); roots.push(root);
  if (entity) { fs.mkdirSync(path.join(root, ".agentera"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER); }
  return root;
}
function plan(title: string, dependency = false): Record<string, unknown> {
  return {
    header: { level: "light", created: "2026-07-17", status: "open", title },
    what: `Deliver ${title} through \`.agentera/entities/plan\`.`, why: "Independent task files must merge safely in Git.", scope: { included: ["plan state"], excluded: ["other families"] },
    tasks: [
      { number: 1, name: "First", status: "pending", acceptance: ["GIVEN state WHEN written THEN it is canonical"] },
      ...(dependency ? [{ number: 2, name: "Second", depends_on: ["1"], status: "pending", acceptance: ["GIVEN first WHEN complete THEN second can run"] }] : []),
    ],
  };
}
function capture(root: string, args: string[]): { rc: number; out: string; err: string } {
  const cwd = process.cwd(); let out = ""; let err = ""; process.chdir(root);
  try { return { rc: main(["node", "agentera", ...args], { out: (text) => { out += text; }, err: (text) => { err += text; } }), out, err }; }
  finally { process.chdir(cwd); }
}
function create(root: string, title: string, dependency = false): any {
  const input = path.join(root, `${title}.yaml`); fs.writeFileSync(input, dumpYamlMapping(plan(title, dependency)));
  const result = capture(root, ["state", "plan", "create", "--input", input, "--format", "json"]); expect(result.rc, result.err || result.out).toBe(0); return JSON.parse(result.out);
}
function taskInput(root: string, record: Record<string, unknown>): string {
  const input = path.join(root, "task-input.yaml"); fs.writeFileSync(input, dumpYamlMapping(record)); return input;
}
function appendTask(root: string, planId: string | undefined, record: Record<string, unknown>): any {
  const result = capture(root, ["state", "plan", "append", ...(planId ? ["--plan", planId] : []), "--input", taskInput(root, record), "--format", "json"]);
  expect(result.rc, result.err || result.out).toBe(0); return JSON.parse(result.out);
}
function updateTask(root: string, id: string, record: Record<string, unknown>, planId?: string): { rc: number; out: string; err: string } {
  return capture(root, ["state", "plan", "update", "--id", id, ...(planId ? ["--plan", planId] : []), "--input", taskInput(root, record), "--format", "json"]);
}
function complete(root: string, title: string): any {
  const created = create(root, title);
  expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", created.tasks[0].id, "--status", "complete", "--format", "json"]).rc).toBe(0);
  expect(capture(root, ["state", "plan", "set-plan-status", "--plan", created.id, "--status", "complete", "--format", "json"]).rc).toBe(0);
  return created;
}
function persistedReplacement(root: string, title: string): { planId: string; predecessor: string; replacement: string } {
  const created = create(root, title); const predecessor = created.tasks[0].id;
  const replacement = appendTask(root, created.id, { name: "Completed replacement", depends_on: [], acceptance: [] }).id;
  expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", predecessor, "--status", "blocked", "--format", "json"]).rc).toBe(0);
  expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", replacement, "--status", "complete", "--format", "json"]).rc).toBe(0);
  const predecessorPath = path.join(root, `.agentera/entities/plan/plan_task/${predecessor}.yaml`);
  const envelope = loadYamlMapping(fs.readFileSync(predecessorPath, "utf8")); const record = envelope.record as Record<string, unknown>;
  record.status = "superseded"; record.superseded_by = [replacement]; record.superseded_reason = "Replacement closes the failed work.";
  fs.writeFileSync(predecessorPath, dumpYamlMapping(envelope));
  return { planId: created.id, predecessor, replacement };
}
function fixtureId(index: number): string {
  let value = index;
  return Array.from({ length: 10 }, () => {
    const char = String.fromCharCode(97 + (value % 26));
    value = Math.floor(value / 26);
    return char;
  }).join("");
}
function archivedPlanFixture(root: string, index: number): { id: string } {
  const id = fixtureId(100 + index * 2); const taskId = fixtureId(101 + index * 2);
  const record = plan(`historical-${index}`); delete record.tasks; (record.header as Record<string, unknown>).status = "archived";
  const planFile = path.join(root, `.agentera/entities/plan/plan/${id}.yaml`);
  const taskFile = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`);
  fs.mkdirSync(path.dirname(planFile), { recursive: true }); fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  fs.writeFileSync(planFile, dumpYamlMapping({ id, artifact: "plan", record }));
  fs.writeFileSync(taskFile, dumpYamlMapping({ id: taskId, artifact: "plan", record: { plan: id, name: "First", status: "blocked", depends_on: [], acceptance: ["GIVEN state WHEN written THEN it is canonical"] } }));
  return { id };
}
function request(root: string, verb: string, values: Record<string, unknown> = {}, input: Record<string, unknown> | null = null): StateWriteRequest {
  const spec = operationSpec("plan", verb); if (!spec) throw new Error(`missing plan ${verb}`);
  return { artifact: "plan", spec, projectRoot: root, dryRun: false, force: false, values, callerPayload: structuredClone(input ?? values), input };
}
function git(root: string, ...args: string[]): string {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function entityNames(root: string): string[] {
  const entities = path.join(root, ".agentera/entities");
  return fs.existsSync(entities) ? fs.readdirSync(entities, { recursive: true, encoding: "utf8" }) : [];
}
async function concurrentLifecycle(root: string, planId: string, blocked: string, replacement: string, action: "reopen" | "archive"): Promise<Array<{ ok: boolean; error?: string }>> {
  const start = path.join(root, `race-${action}.start`); const ready = ["supersede", action].map((name) => path.join(root, `race-${action}-${name}.ready`)); const results = ["supersede", action].map((name) => path.join(root, `race-${action}-${name}.json`));
  const children = ["supersede", action].map((kind, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [supersessionWorker], { cwd: path.resolve(import.meta.dirname, "../.."), env: { ...sourceSubprocessEnv(), AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."), AGENTERA_PLAN_RACE_ROOT: root, AGENTERA_PLAN_RACE_PLAN: planId, AGENTERA_PLAN_RACE_BLOCKED: blocked, AGENTERA_PLAN_RACE_REPLACEMENT: replacement, AGENTERA_PLAN_RACE_ACTION: kind, AGENTERA_PLAN_RACE_READY: ready[index], AGENTERA_PLAN_RACE_START: start, AGENTERA_PLAN_RACE_RESULT: results[index] }, stdio: "pipe" });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`plan race worker exited ${code}: ${stderr}`)));
  }));
  const deadline = Date.now() + 10_000; while (!ready.every((file) => fs.existsSync(file))) { if (Date.now() > deadline) throw new Error("plan race workers did not become ready"); await new Promise((resolve) => setTimeout(resolve, 10)); }
  fs.writeFileSync(start, "start\n"); await Promise.all(children); return results.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}
async function concurrentAppend(root: string, planId: string, input: string): Promise<Array<{ rc: number; output: string; error: string }>> {
  const start = path.join(root, "race-append.start");
  const ready = ["one", "two"].map((name) => path.join(root, `race-append-${name}.ready`));
  const results = ["one", "two"].map((name) => path.join(root, `race-append-${name}.json`));
  const children = ready.map((readyFile, index) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [appendWorker], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
        AGENTERA_PLAN_APPEND_ROOT: root,
        AGENTERA_PLAN_APPEND_PLAN: planId,
        AGENTERA_PLAN_APPEND_INPUT: input,
        AGENTERA_PLAN_APPEND_READY: readyFile,
        AGENTERA_PLAN_APPEND_START: start,
        AGENTERA_PLAN_APPEND_RESULT: results[index],
      },
      stdio: "pipe",
    });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`plan append worker exited ${code}: ${stderr}`)));
  }));
  const deadline = Date.now() + 10_000;
  while (!ready.every((file) => fs.existsSync(file))) { if (Date.now() > deadline) throw new Error("plan append workers did not become ready"); await new Promise((resolve) => setTimeout(resolve, 10)); }
  fs.writeFileSync(start, "start\n"); await Promise.all(children);
  return results.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}

function unrelated(root: string): { file: string; bytes: string } {
  const file = path.join(root, ".agentera/unrelated.txt");
  const bytes = "successor or unrelated state\n";
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  return { file, bytes };
}

afterEach(() => { vi.restoreAllMocks(); while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("plan and task entity authority", () => {
  it("explains task mutations with bare IDs in entity mode", () => {
    const root = project();
    for (const verb of ["update", "set-status", "supersede", "record-evaluation"]) {
      const result = capture(root, ["state", "plan", "explain", "--verb", verb, "--format", "json"]);
      expect(result.rc, result.err || result.out).toBe(0);
      const explanation = JSON.parse(result.out);
      expect(explanation.path).toBe(".agentera/entities/plan/plan_task/<id>.yaml");
      expect(explanation.fields).toEqual(expect.arrayContaining([expect.objectContaining({ flag: "--id", field: "id", required: true, type: "string" })]));
      expect(explanation.fields).not.toEqual(expect.arrayContaining([expect.objectContaining({ flag: "--task" })]));
      expect(explanation.example).toContain("--id qjtrmnpvka");
      if (verb === "record-evaluation") expect(explanation.guidance).toEqual(expect.arrayContaining([
        expect.stringContaining("evaluate before completing"),
        expect.stringContaining("first PASS on an unevaluated complete replacement"),
      ]));
    }
  });

  it("creates one plan and independent task entities with bare dependency IDs", () => {
    const root = project(); const created = create(root, "graph", true);
    expect(created).toMatchObject({ artifact: "plan", id: expect.stringMatching(/^[a-z]{10}$/) });
    expect(created.tasks).toHaveLength(2);
    expect(created.tasks[0]).toMatchObject({ artifact: "plan", id: expect.stringMatching(/^[a-z]{10}$/), record: { plan: created.id } });
    expect(created.tasks[1].record.depends_on).toEqual([created.tasks[0].id]);
    expect(created.record.header.id).toBeUndefined(); expect(created.tasks[0].record.number).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".agentera/plan.yaml"))).toBe(false);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 3 });
  });

  it.each([1, "1"])("normalizes atomic-create dependency ordinal %j to a bare task ID", (dependency) => {
    const root = project();
    const input = plan(`ordinal-${typeof dependency}`) as Record<string, any>;
    input.tasks.push({ number: 2, name: "Second", depends_on: [dependency], status: "pending", acceptance: ["The dependency is canonical"] });
    const source = path.join(root, "plan.yaml"); fs.writeFileSync(source, dumpYamlMapping(input));
    const result = capture(root, ["state", "plan", "create", "--input", source, "--format", "json"]);
    expect(result.rc, result.err || result.out).toBe(0);
    const created = JSON.parse(result.out);
    expect(created.tasks[1].record.depends_on).toEqual([created.tasks[0].id]);
    for (const task of created.tasks) {
      expect(task.id).toMatch(/^[a-z]{10}$/);
      expect(task.record).not.toHaveProperty("number");
      expect(task.record.depends_on ?? []).toEqual(expect.arrayContaining((task.record.depends_on ?? []).map(() => expect.stringMatching(/^[a-z]{10}$/))));
    }
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 3 });
  });

  it.each([
    ["zero", [0]],
    ["negative", [-1]],
    ["fractional", [1.5]],
    ["nonnumeric", ["one"]],
    ["noncanonical numeric string", ["01"]],
    ["missing ordinal", [3]],
    ["duplicate normalized ordinal", [1, "1"]],
    ["mixed unresolved ordinals", [1, "3"]],
  ])("rejects %s atomic-create dependencies before effects", (_label, dependsOn) => {
    const root = project();
    const input = plan(`invalid-${_label}`) as Record<string, any>;
    input.tasks.push({ number: 2, name: "Second", depends_on: dependsOn, status: "pending", acceptance: ["Invalid input is rejected"] });
    const source = path.join(root, "plan.yaml"); fs.writeFileSync(source, dumpYamlMapping(input));
    const result = capture(root, ["state", "plan", "create", "--input", source, "--format", "json"]);
    expect(result.rc).not.toBe(0);
    expect(JSON.parse(result.out).error.class).toBe("schema_violation");
    expect(fs.readdirSync(path.join(root, ".agentera"))).toEqual(["state-mode.yaml"]);
  });

  it("keeps existing-task append and update dependencies bare-ID-only", () => {
    const root = project(); const created = create(root, "existing-task-identities", true);
    const before = validateEntityState(root).entityCount;
    for (const dependency of [1, "1", "plan:123e4567-e89b-42d3-a456-426614174000"]) {
      const append = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Rejected alias", depends_on: [dependency], acceptance: [] }), "--format", "json"]);
      expect(append.rc).not.toBe(0);
      expect(JSON.parse(append.out).error.class).toBe("schema_violation");
      const update = updateTask(root, created.tasks[1].id, { depends_on: [dependency] }, created.id);
      expect(update.rc).not.toBe(0);
      expect(JSON.parse(update.out).error.class).toBe("schema_violation");
      expect(validateEntityState(root).entityCount).toBe(before);
    }
    expect(loadYamlMapping(fs.readFileSync(path.join(root, `.agentera/entities/plan/plan_task/${created.tasks[1].id}.yaml`), "utf8"))).toMatchObject({ record: { depends_on: [created.tasks[0].id] } });
  });

  it("bounds Unicode task pages and emits executable relationship-bound continuations", () => {
    const root = project();
    const input = plan("unicode task pages") as Record<string, any>;
    const unicodeSample = "\u{10400}\u20ac\u2030";
    const names = Array.from({ length: 20 }, (_, index) => `${index}-${unicodeSample.repeat(70)}`);
    input.tasks = names.map((name, index) => ({
      number: index + 1,
      name,
      status: "pending",
      depends_on: [],
      acceptance: [`GIVEN ${name} WHEN listed THEN UTF-8 remains valid`],
    }));
    const source = path.join(root, "unicode-plan.yaml");
    fs.writeFileSync(source, dumpYamlMapping(input));
    const publication = capture(root, ["state", "plan", "create", "--input", source, "--format", "json"]);
    expect(publication.rc, publication.err || publication.out).toBe(0);
    const created = JSON.parse(publication.out);
    const expectedIds = new Set(created.tasks.map((task: any) => task.id));
    const observed = new Set<string>();
    let command = "agentera state plan tasks list --limit 100 --format json";
    let pageCount = 0;
    do {
      expect(command).toMatch(/^agentera state plan tasks list /);
      const result = capture(root, shellCommandArgs(command));
      expect(result.rc, result.err || result.out).toBe(0);
      expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32_768);
      const page = JSON.parse(result.out);
      expect(page.filters.plan).toBe(created.id);
      expect(page.snapshot.id).toEqual(expect.any(String));
      for (const task of page.entries) {
        expect(expectedIds.has(task.id)).toBe(true);
        expect(observed.has(task.id)).toBe(false);
        expect(task.retrieval.get).toBe(`agentera state plan tasks get --id ${task.id} --format json`);
        observed.add(task.id);
      }
      if (page.omitted) {
        expect(page.omission_reason).toBe("page_limit");
        expect(page.omitted_count).toBeGreaterThan(0);
        expect(page.next_cursor).toEqual(expect.any(String));
        expect(page.retrieval.get).toBe("agentera state plan tasks get --id ID --format json");
        command = page.retrieval.continue;
      } else command = "";
      pageCount += 1;
    } while (command);
    expect(pageCount).toBe(1);
    expect(observed.size).toBe(20);
    expect(observed).toEqual(expectedIds);

    const exact = capture(root, ["state", "plan", "tasks", "get", "--id", created.tasks[0].id, "--format", "json"]);
    expect(exact.rc, exact.err || exact.out).toBe(0);
    expect(JSON.parse(exact.out).entry).toMatchObject({
      id: created.tasks[0].id,
      artifact: "plan",
      record: { plan: created.id, name: names[0] },
    });
  });

  it("keeps active and archived task continuations bound to their cursor plan", () => {
    const root = project();
    const archived = create(root, "archived pagination", true);
    for (const task of archived.tasks) {
      const completed = capture(root, ["state", "plan", "set-status", "--plan", archived.id, "--id", task.id, "--status", "complete", "--format", "json"]);
      expect(completed.rc, completed.err || completed.out).toBe(0);
    }
    expect(capture(root, ["state", "plan", "set-plan-status", "--plan", archived.id, "--status", "complete", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "plan", "archive", "--plan", archived.id, "--format", "json"]).rc).toBe(0);
    const active = create(root, "active pagination", true);

    for (const [selector, expected] of [[[], active], [[archived.id], archived]] as const) {
      const first = capture(root, ["state", "plan", "tasks", "list", ...selector, "--limit", "1", "--format", "json"]);
      expect(first.rc, first.err || first.out).toBe(0);
      const page = JSON.parse(first.out);
      expect(page).toMatchObject({ status: "degraded", filters: { plan: expected.id }, omitted: true, omitted_count: 1 });
      expect(page.entries[0].record.plan).toBe(expected.id);
        expect(page.retrieval.continue).toMatch(new RegExp(`^agentera state plan tasks list '${expected.id}' --limit 1 --cursor `));

      const continued = capture(root, shellCommandArgs(page.retrieval.continue));
      expect(continued.rc, continued.err || continued.out).toBe(0);
      expect(JSON.parse(continued.out)).toMatchObject({
        status: "ok",
        filters: { plan: expected.id },
        entries: [expect.objectContaining({ record: expect.objectContaining({ plan: expected.id }) })],
        counts: { total: 2, returned: 1, remaining: 0 },
      });
    }

    const archivedPage = JSON.parse(capture(root, ["state", "plan", "tasks", "list", archived.id, "--limit", "1", "--format", "json"]).out);
    const planCursor = JSON.parse(capture(root, ["state", "plan", "list", "--limit", "1", "--format", "json"]).out).next_cursor;
    const mismatch = capture(root, ["state", "plan", "tasks", "list", "--cursor", planCursor, "--format", "json"]);
    expect(mismatch.rc).toBe(1);
    expect(JSON.parse(mismatch.out).error.class).toBe("cursor_snapshot_unavailable");
    const malformed = capture(root, ["state", "plan", "tasks", "list", "--cursor", "not-a-cursor", "--format", "json"]);
    expect(malformed.rc).toBe(1);
    expect(JSON.parse(malformed.out).error.class).toBe("cursor_invalid");

    const changed = capture(root, ["state", "plan", "set-status", "--plan", active.id, "--id", active.tasks[0].id, "--status", "complete", "--format", "json"]);
    expect(changed.rc, changed.err || changed.out).toBe(0);
    const stale = capture(root, shellCommandArgs(archivedPage.retrieval.continue));
    expect(stale.rc).toBe(1);
    expect(JSON.parse(stale.out).error.class).toBe("cursor_snapshot_unavailable");

    const foreign = project();
    create(foreign, "foreign cursor", true);
    const rejected = capture(foreign, shellCommandArgs(archivedPage.retrieval.continue));
    expect(rejected.rc).toBe(1);
    expect(JSON.parse(rejected.out).error.class).toBe("cursor_invalid");
  });

  it("binds IDs-only and selected-field continuations without skips or duplicates", () => {
    const root = project();
    const created = create(root, "selector pagination", true);
    const first = capture(root, ["state", "plan", "tasks", "list", "--limit", "1", "--ids-only", "--format", "json"]);
    expect(first.rc, first.err || first.out).toBe(0);
    const firstPage = JSON.parse(first.out);
    expect(firstPage).toMatchObject({
      projection: { selector: "ids_only", detail: "identity" },
      counts: { candidate: 2, returned: 1, omitted: 1, continuation: 1 },
      entries: [{ artifact: "plan", retrieval: { get: expect.stringMatching(/^agentera state plan tasks get --id [a-z]{10} --format json$/) } }],
    });
    expect(firstPage.entries[0]).not.toHaveProperty("record");
    expect(firstPage.retrieval.continue).toContain("--ids-only");

    const second = capture(root, shellCommandArgs(firstPage.retrieval.continue));
    expect(second.rc, second.err || second.out).toBe(0);
    const secondPage = JSON.parse(second.out);
    const observed = [firstPage.entries[0].id, secondPage.entries[0].id];
    expect(new Set(observed)).toEqual(new Set(created.tasks.map((task: any) => task.id)));
    expect(secondPage).toMatchObject({ counts: { candidate: 2, returned: 1, omitted: 0, continuation: 0 }, projection: { selector: "ids_only" } });

    const switched = capture(root, ["state", "plan", "tasks", "list", "--limit", "1", "--fields", "status", "--cursor", firstPage.next_cursor, "--format", "json"]);
    expect(switched.rc).toBe(1);
    expect(JSON.parse(switched.out).error).toMatchObject({ class: "cursor_invalid", recovery: expect.stringContaining("original selector") });

    const fields = capture(root, ["state", "plan", "tasks", "list", "--fields", "status,name", "--format", "json"]);
    expect(fields.rc, fields.err || fields.out).toBe(0);
    const fieldsPage = JSON.parse(fields.out);
    expect(fieldsPage.entries).toHaveLength(2);
    expect(fieldsPage.entries[0]).toMatchObject({ id: expect.any(String), artifact: "plan", record: { name: expect.any(String), status: "pending" }, retrieval: { get: expect.any(String) } });
    expect(fieldsPage.projection.fields).toEqual(["name", "status"]);

    const invalid = capture(root, ["state", "plan", "tasks", "list", "--fields", "not_a_field", "--format", "json"]);
    expect(invalid.rc).toBe(2);
    expect(JSON.parse(invalid.out).error).toMatchObject({
      class: "invalid_request",
      message: expect.stringContaining("unsupported record field"),
      valid_values: expect.arrayContaining(["name", "status"]),
      example: entityListFamily("plan_tasks").example,
      recovery: expect.stringContaining(entityListFamily("plan_tasks").example),
    });
    const combined = capture(root, ["state", "plan", "tasks", "list", "--ids-only", "--fields", "status", "--format", "json"]);
    expect(combined.rc).toBe(2);
    expect(JSON.parse(combined.out).error.message).toContain("cannot be combined");
  });

  it("documents the positional plan selector in task-list diagnostics", () => {
    const root = project();
    const result = capture(root, ["state", "plan", "tasks", "list", "too", "many", "selectors", "--format", "json"]);
    expect(result.rc).toBe(2);
    const family = entityListFamily("plan_tasks");
    expect(JSON.parse(result.out).error).toMatchObject({ syntax: family.syntax, example: family.example });
    const invalid = capture(root, ["state", "plan", "tasks", "list", "not-a-plan", "--format", "json"]);
    expect(invalid.rc).toBe(2);
    expect(JSON.parse(invalid.out).error).toMatchObject({
      class: "invalid_request",
      example: "agentera state plan get --id qjtrmnpvka --format json",
      recovery: "Use a bare plan ID returned by plan create or list.",
    });
  });

  it("applies the authority-backed plan scope shape at direct and whole-state boundaries", () => {
    const base = plan("scope parity"); delete base.tasks;
    for (const scope of [{ included: [], excluded: [] }, { included: ["plan"], excluded: ["release"], deferred: ["later", "exactly"] }]) {
      expect(canonicalEntityRecordViolations("plan", { ...base, scope })).toEqual([]);
    }
    for (const [scope, message] of [
      ["plan", "scope must be a mapping"],
      [["plan"], "scope must be a mapping"],
      [{ included: [] }, "scope.excluded is required"],
      [{ included: "plan", excluded: [] }, "scope.included must be a list of strings"],
      [{ included: [], excluded: [2] }, "scope.excluded must be a list of strings"],
      [{ included: [], excluded: [], deferred: "later" }, "scope.deferred must be a list of strings"],
      [{ included: [], excluded: [], deferred: {} }, "scope.deferred must be a list of strings"],
      [{ included: [], excluded: [], deferred: ["later", 2] }, "scope.deferred must be a list of strings"],
      [{ included: [], excluded: [], other: [] }, "scope.other is not allowed"],
    ] as Array<[unknown, string]>) {
      expect(canonicalEntityRecordViolations("plan", { ...base, scope } as any)).toContain(message);
    }

    const root = project(); const created = create(root, "malformed scope state");
    const target = path.join(root, `.agentera/entities/plan/plan/${created.id}.yaml`);
    const entity = loadYamlMapping(fs.readFileSync(target, "utf8")); (entity.record as Record<string, unknown>).scope = { included: ["plan"] };
    fs.writeFileSync(target, dumpYamlMapping(entity));
    const validation = validateEntityState(root);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "plan", message: expect.stringContaining("scope.excluded is required") })]));
    const checked = capture(root, ["check", "validate", "state", "--format", "json"]);
    expect(checked.rc).toBe(1);
    expect(JSON.parse(checked.out).issues).toEqual(expect.arrayContaining([expect.objectContaining({ boundary: "plan", message: expect.stringContaining("scope.excluded is required") })]));
  });

  it("runs append, update, status, evaluation, lifecycle, and archive by entity selectors", () => {
    const root = project(); const created = create(root, "lifecycle"); const planId = created.id; const first = created.tasks[0].id;
    let result = appendTask(root, planId, { name: "Added", depends_on: [first], acceptance: ["GIVEN first WHEN done THEN added runs"] }); const added = result.id;
    result = updateTask(root, added, { name: "Updated" }, planId); expect(result.rc).toBe(0);
    result = updateTask(root, added, { surprise: "Observed in packages/cli/src/state/planEntities.ts" }, planId); expect(result.rc).toBe(0); expect(JSON.parse(result.out).record.surprises).toContain("planEntities.ts");
    result = capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", added, "--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "test", "--format", "json"]); expect(result.rc).toBe(0);
    for (const id of [first, added]) { result = capture(root, ["state", "plan", "set-status", "--plan", planId, "--id", id, "--status", "complete", "--format", "json"]); expect(result.rc).toBe(0); }
    result = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]); expect(result.rc).toBe(0);
    result = capture(root, ["state", "plan", "archive", "--plan", planId, "--format", "json"]); expect(result.rc).toBe(0); expect(JSON.parse(result.out)).toMatchObject({ record: { header: { status: "archived" } }, operation: { idempotent_replay: false } });
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
  });

  it("requires structured task records and rejects retired, owned, and non-bare input before effects", () => {
    const root = project(); const created = create(root, "structured task input"); const taskId = created.tasks[0].id;
    const before = entityNames(root);
    const retired = capture(root, ["state", "plan", "append", "--plan", created.id, "--name", "retired", "--format", "json"]);
    expect(retired.rc).toBe(2); expect(entityNames(root)).toEqual(before);
    const incomplete = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Incomplete", depends_on: [] }), "--format", "json"]);
    expect(incomplete.rc).toBe(2); expect(entityNames(root)).toEqual(before);
    const owned = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Owned", plan: created.id, depends_on: [], acceptance: [] }), "--format", "json"]);
    expect(owned.rc).toBe(2); expect(entityNames(root)).toEqual(before);
    const malformedDependency = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Bad dependency", depends_on: ["plan:abcdefghij"], acceptance: [] }), "--format", "json"]);
    expect(malformedDependency.rc).toBe(2); expect(entityNames(root)).toEqual(before);
    const invalidUpdate = updateTask(root, taskId, { status: "complete" }, created.id);
    expect(invalidUpdate.rc).toBe(2); expect(entityNames(root)).toEqual(before);
    const compositeSelector = capture(root, ["state", "plan", "update", "--id", "plan:abcdefghij", "--plan", created.id, "--input", taskInput(root, { name: "No" }), "--format", "json"]);
    expect(compositeSelector.rc).toBe(2); expect(entityNames(root)).toEqual(before);
    const planLifecycleTaskSelector = capture(root, ["state", "plan", "set-plan-status", "--id", created.id, "--status", "complete", "--format", "json"]);
    expect(planLifecycleTaskSelector.rc).toBe(2); expect(entityNames(root)).toEqual(before);
  });

  it("converges identical append retries under the writer lock while preserving divergence and dry-run semantics", async () => {
    const root = project(); const created = create(root, "append replay"); const payload = { name: "Retryable task", depends_on: [created.tasks[0].id], acceptance: ["GIVEN one logical input WHEN retried THEN one entity remains"] };
    const first = appendTask(root, created.id, payload);
    const retry = appendTask(root, created.id, payload);
    expect(retry.id).toBe(first.id); expect(first.operation.idempotent_replay).toBe(false); expect(retry.operation.idempotent_replay).toBe(true);
    const beforeDry = JSON.parse(capture(root, ["state", "plan", "tasks", "list", created.id, "--format", "json"]).out).counts.total;
    const dryBefore = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Dry-only", depends_on: [], acceptance: [] }), "--dry-run", "--format", "json"]);
    const afterDry = JSON.parse(capture(root, ["state", "plan", "tasks", "list", created.id, "--format", "json"]).out).counts.total;
    expect(dryBefore.rc).toBe(0); expect(JSON.parse(dryBefore.out).operation).toMatchObject({ dry_run: true, idempotent_replay: false }); expect(afterDry).toBe(beforeDry);
    const dryAfter = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, payload), "--dry-run", "--format", "json"]);
    expect(dryAfter.rc).toBe(0); expect(JSON.parse(dryAfter.out).operation).toMatchObject({ dry_run: true, idempotent_replay: true, }); expect(JSON.parse(dryAfter.out).id).toBe(first.id);
    const divergent = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { ...payload, acceptance: ["different"] }), "--format", "json"]);
    expect(divergent.rc).not.toBe(0); expect(JSON.parse(divergent.out).error.class).toBe("conflict");
    const distinct = appendTask(root, created.id, { ...payload, name: "Distinct task" }); expect(distinct.id).not.toBe(first.id);

    const concurrentPlan = create(root, "concurrent append replay");
    const concurrentInput = taskInput(root, { name: "Concurrent task", depends_on: [concurrentPlan.tasks[0].id], acceptance: ["GIVEN two processes WHEN appending identical input THEN one task is published"] });
    const receipts = await concurrentAppend(root, concurrentPlan.id, concurrentInput);
    const parsed = receipts.map(({ output }) => JSON.parse(output));
    expect(new Set(parsed.map((value) => value.id)).size).toBe(1);
    expect(parsed.map((value) => value.operation.idempotent_replay).sort()).toEqual([false, true]);
    expect(JSON.parse(capture(root, ["state", "plan", "tasks", "list", concurrentPlan.id, "--format", "json"]).out).counts.total).toBe(2);
  });

  it("supersedes a blocked task only with completed same-plan replacements and preserves evaluation evidence", () => {
    const root = project(); const created = create(root, "supersession"); const [blocked] = created.tasks.map((task: any) => task.id);
    const append = (name: string) => appendTask(root, created.id, { name, depends_on: [], acceptance: [] }).id as string;
    const firstReplacement = append("First replacement"); const secondReplacement = append("Second replacement");
    const evaluate = (attempt: string, evidence: string) => capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", blocked, "--attempt-id", attempt, "--verdict", "fail", "--provenance", "audit", "--failure-evidence", evidence, "--format", "json"]);
    expect(evaluate("audit-1", "failure one").rc).toBe(0); expect(evaluate("audit-2", "failure two").rc).toBe(0);
    for (const [index, id] of [firstReplacement, secondReplacement].entries()) {
      expect(capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", id, "--attempt-id", `replacement-audit-${index + 1}`, "--verdict", "pass", "--provenance", "audit", "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", id, "--status", "complete", "--format", "json"]).rc).toBe(0);
    }
    const taskPath = path.join(root, `.agentera/entities/plan/plan_task/${blocked}.yaml`);
    const before = loadYamlMapping(fs.readFileSync(taskPath, "utf8")).record as Record<string, unknown>;
    const superseded = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, "--by", secondReplacement, "--by", firstReplacement, "--reason", "Replacement tasks cover the blocked work.", "--format", "json"]);
    expect(superseded.rc, superseded.err || superseded.out).toBe(0);
    expect(JSON.parse(superseded.out).record).toMatchObject({ status: "superseded", superseded_by: [firstReplacement, secondReplacement].sort(), superseded_reason: "Replacement tasks cover the blocked work.", evaluation: before.evaluation });
    const replacementPath = path.join(root, `.agentera/entities/plan/plan_task/${firstReplacement}.yaml`); const replacementBytes = fs.readFileSync(replacementPath, "utf8");
    const reopening = capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", firstReplacement, "--status", "pending", "--format", "json"]);
    expect(reopening.rc).not.toBe(0); expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacementBytes);
    const written = fs.readFileSync(taskPath, "utf8");
    const replay = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, "--by", firstReplacement, "--by", secondReplacement, "--reason", "Replacement tasks cover the blocked work.", "--format", "json"]);
    expect(replay.rc, replay.err || replay.out).toBe(0); expect(JSON.parse(replay.out).operation.idempotent_replay).toBe(true); expect(fs.readFileSync(taskPath, "utf8")).toBe(written);
    expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "superseded", "--format", "json"]).rc).toBe(2);
    expect(capture(root, ["state", "plan", "set-plan-status", "--plan", created.id, "--status", "complete", "--format", "json"]).rc).toBe(0);
    expect(validateEntityState(root).valid).toBe(true);
    const invalid = loadYamlMapping(fs.readFileSync(taskPath, "utf8")); (invalid.record as Record<string, unknown>).superseded_by = [blocked]; fs.writeFileSync(taskPath, dumpYamlMapping(invalid));
    expect(validateEntityState(root)).toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ relation: "superseded_by", message: expect.stringContaining("cannot name itself") })]) });
  });

  it("rejects invalid supersession targets without changing the blocked task", () => {
    const root = project(); const created = create(root, "supersession rejection"); const blocked = created.tasks[0].id;
     const pending = appendTask(root, created.id, { name: "Pending replacement", depends_on: [], acceptance: [] }).id;
    const otherPlan = create(root, "other plan"); const crossPlan = otherPlan.tasks[0].id;
    expect(capture(root, ["state", "plan", "set-status", "--plan", otherPlan.id, "--id", crossPlan, "--status", "complete", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "blocked", "--format", "json"]).rc).toBe(0);
    const taskPath = path.join(root, `.agentera/entities/plan/plan_task/${blocked}.yaml`); const before = fs.readFileSync(taskPath, "utf8");
    for (const args of [
      ["--by", blocked],
      ["--by", pending],
      ["--by", pending, "--by", pending],
      ["--by", "INVALID"],
      ["--by", "zzzzzzzzzz"],
      ["--by", crossPlan],
    ]) {
      const result = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, ...args, "--reason", "Replacement work.", "--format", "json"]);
      expect(result.rc).not.toBe(0); expect(fs.readFileSync(taskPath, "utf8")).toBe(before);
    }
  });

  it("rejects complete replacements without a latest persisted PASS and preserves the blocked task", () => {
    for (const verdict of ["unevaluated", "fail"] as const) {
      const root = project(); const created = create(root, `replacement ${verdict}`); const blocked = created.tasks[0].id;
      const replacement = appendTask(root, created.id, { name: `${verdict} replacement`, depends_on: [], acceptance: [] }).id;
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "blocked", "--format", "json"]).rc).toBe(0);
      if (verdict === "fail") expect(capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", replacement, "--attempt-id", "replacement-audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "still incomplete", "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", replacement, "--status", "complete", "--format", "json"]).rc).toBe(0);
      const taskPath = path.join(root, `.agentera/entities/plan/plan_task/${blocked}.yaml`); const before = fs.readFileSync(taskPath, "utf8");

      const rejected = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, "--by", replacement, "--reason", "Replacement work.", "--format", "json"]);

      expect(rejected.rc).not.toBe(0);
      expect(JSON.parse(rejected.out).error).toMatchObject({
        class: "conflict",
        message: expect.stringContaining(replacement),
        recovery: expect.stringMatching(/reopen.*record PASS.*complete.*retry/i),
      });
      expect(fs.readFileSync(taskPath, "utf8")).toBe(before);
    }
  });

  it("repairs an unevaluated historical replacement in place before reusing it for supersession", () => {
    const root = project(); const { planId, replacement } = persistedReplacement(root, "historical replacement reuse");
    const blocked = appendTask(root, planId, { name: "New blocked predecessor", depends_on: [], acceptance: [] }).id;
    expect(capture(root, ["state", "plan", "set-status", "--plan", planId, "--id", blocked, "--status", "blocked", "--format", "json"]).rc).toBe(0);
    const supersede = () => capture(root, ["state", "plan", "supersede", "--plan", planId, "--id", blocked, "--by", replacement, "--reason", "Reuse historical replacement evidence.", "--format", "json"]);

    const rejected = supersede();
    expect(rejected.rc).not.toBe(0);
    expect(JSON.parse(rejected.out).error).toMatchObject({
      class: "conflict",
      message: expect.stringContaining(replacement),
      recovery: expect.stringMatching(/first PASS.*remains complete.*retry/i),
    });
    expect(JSON.parse(rejected.out).error.recovery).not.toMatch(/reopen/i);

    const repaired = capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", replacement, "--attempt-id", "historical-reuse-audit-1", "--verdict", "pass", "--provenance", "audit", "--format", "json"]);
    expect(repaired.rc, repaired.err || repaired.out).toBe(0);
    expect(JSON.parse(repaired.out).record).toMatchObject({ status: "complete", evaluation: { last_verdict: "pass" } });
    expect(supersede().rc).toBe(0);
  });

  it("describes context-sensitive supersession recovery", () => {
    const guidance = buildExplain("plan", project(), "supersede").guidance as string[];
    expect(guidance).toEqual(expect.arrayContaining([
      expect.stringMatching(/not already referenced.*reopen.*record PASS.*complete.*retry/i),
      expect.stringMatching(/referenced.*unevaluated complete.*first PASS.*remains complete/i),
      expect.stringMatching(/existing non-PASS evaluation.*first-PASS recovery is unavailable.*another complete latest-PASS replacement/i),
    ]));
  });

  it("serializes supersession against replacement reopening and plan archival", async () => {
    for (const action of ["reopen", "archive"] as const) {
      const root = project(); const created = create(root, `supersession ${action}`); const blocked = created.tasks[0].id;
      const replacement = appendTask(root, created.id, { name: "Completed replacement", depends_on: [], acceptance: [] }).id;
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "blocked", "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", replacement, "--attempt-id", "replacement-audit-1", "--verdict", "pass", "--provenance", "audit", "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", replacement, "--status", "complete", "--format", "json"]).rc).toBe(0);
      const outcomes = await concurrentLifecycle(root, created.id, blocked, replacement, action);
      expect(outcomes.some(({ ok }) => ok)).toBe(true);
      if (action === "reopen") expect(outcomes.filter(({ ok }) => ok)).toHaveLength(1);
      expect(validateEntityState(root).valid).toBe(true);
      expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
    }
  });

  it("enforces shared evaluation validation, exact replay, and divergent-attempt conflicts through the public CLI", () => {
    const root = project(); const created = create(root, "evaluation"); const taskId = created.tasks[0].id;
    const evaluate = (...args: string[]) => capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", taskId, ...args, "--format", "json"]);
    const target = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`);
    const initial = fs.readFileSync(target, "utf8");
    for (const invalid of [
      ["--attempt-id", "", "--verdict", "pass", "--provenance", "audit"],
      ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", ""],
      ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit"],
      ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "audit", "--failure-evidence", "not allowed"],
    ]) {
      const result = evaluate(...invalid); expect(result.rc).not.toBe(0); expect(fs.readFileSync(target, "utf8")).toBe(initial);
    }
    const valid = ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "test:1"];
    expect(evaluate(...valid).rc).toBe(0); const once = fs.readFileSync(target, "utf8");
    expect(JSON.parse(evaluate(...valid).out).operation.idempotent_replay).toBe(true); expect(fs.readFileSync(target, "utf8")).toBe(once);
    for (const divergent of [
      ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "audit"],
      ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "other", "--failure-evidence", "test:1"],
      ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "test:2"],
    ]) {
      const result = evaluate(...divergent); expect(result.rc).not.toBe(0); expect(JSON.parse(result.out).error.class).toBe("conflict"); expect(fs.readFileSync(target, "utf8")).toBe(once);
    }
  });

  it("records one recovery PASS for an unevaluated complete replacement without changing its predecessor", () => {
    const root = project(); const { planId, predecessor, replacement } = persistedReplacement(root, "replacement evaluation recovery");
    const predecessorPath = path.join(root, `.agentera/entities/plan/plan_task/${predecessor}.yaml`);
    const replacementPath = path.join(root, `.agentera/entities/plan/plan_task/${replacement}.yaml`);
    const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
    const evaluate = (...args: string[]) => capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", replacement, ...args, "--format", "json"]);
    const attempt = ["--attempt-id", "replacement-audit-1", "--verdict", "pass", "--provenance", "independent audit"];

    expect(validateEntityState(root).valid).toBe(true);
    const historicalRead = capture(root, ["state", "plan", "get", "--id", planId, "--format", "json"]);
    expect(historicalRead.rc, historicalRead.err || historicalRead.out).toBe(0);
    expect(JSON.parse(historicalRead.out).tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: replacement, record: expect.objectContaining({ status: "complete" }) })]));
    const rejectedCloseout = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]);
    expect(rejectedCloseout.rc).not.toBe(0);
    expect(JSON.parse(rejectedCloseout.out).error).toMatchObject({
      class: "conflict",
      message: expect.stringContaining(replacement),
      recovery: expect.stringMatching(/first PASS.*retry/i),
    });

    const recorded = evaluate(...attempt);
    expect(recorded.rc, recorded.err || recorded.out).toBe(0);
    expect(JSON.parse(recorded.out)).toMatchObject({
      record: {
        status: "complete",
        evaluation: {
          attempt_count: 1,
          failure_count: 0,
          last_verdict: "pass",
          last_failure_evidence: null,
          provenance: {
            attempt_id: "replacement-audit-1",
            source: "independent audit",
            recorded_at: expect.any(String),
            writer_command: "agentera state plan record-evaluation",
          },
        },
      },
      operation: { idempotent_replay: false },
    });
    expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
    expect(loadYamlMapping(predecessorBytes).record).toMatchObject({ status: "superseded", superseded_by: [replacement] });

    const replacementBytes = fs.readFileSync(replacementPath, "utf8");
    const replay = evaluate(...attempt);
    expect(replay.rc, replay.err || replay.out).toBe(0);
    expect(JSON.parse(replay.out).operation.idempotent_replay).toBe(true);
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacementBytes);
    for (const distinct of [
      ["--attempt-id", "replacement-audit-1", "--verdict", "pass", "--provenance", "different audit"],
      ["--attempt-id", "replacement-audit-2", "--verdict", "pass", "--provenance", "independent audit"],
    ]) {
      const rejected = evaluate(...distinct);
      expect(rejected.rc).not.toBe(0); expect(JSON.parse(rejected.out).error.class).toBe("conflict");
      expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacementBytes);
    }
    expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
    expect(validateEntityState(root).valid).toBe(true);

    const closeout = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]);
    expect(closeout.rc, closeout.err || closeout.out).toBe(0);
    expect(JSON.parse(closeout.out).operation.idempotent_replay).toBe(false);
    const completedPlan = path.join(root, `.agentera/entities/plan/plan/${planId}.yaml`); const completedBytes = fs.readFileSync(completedPlan, "utf8");
    const closeoutReplay = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]);
    expect(closeoutReplay.rc, closeoutReplay.err || closeoutReplay.out).toBe(0);
    expect(JSON.parse(closeoutReplay.out).operation.idempotent_replay).toBe(true);
    expect(fs.readFileSync(completedPlan, "utf8")).toBe(completedBytes);
  });

  it("rejects replacement recovery for FAIL, unrelated terminal tasks, terminal predecessors, and non-open plans", () => {
    const assertRejected = (root: string, planId: string, taskId: string, args: string[]) => {
      const target = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`); const before = fs.readFileSync(target, "utf8");
      const result = capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", taskId, ...args, "--format", "json"]);
      expect(result.rc).not.toBe(0); expect(JSON.parse(result.out).error.class).toBe("conflict"); expect(fs.readFileSync(target, "utf8")).toBe(before);
    };
    const pass = ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "audit"];

    const failRoot = project(); const failed = persistedReplacement(failRoot, "reject recovery fail");
    assertRejected(failRoot, failed.planId, failed.replacement, ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "still broken"]);
    assertRejected(failRoot, failed.planId, failed.predecessor, pass);

    const unreferencedRoot = project(); const unreferenced = create(unreferencedRoot, "unreferenced complete"); const unreferencedTask = unreferenced.tasks[0].id;
    expect(capture(unreferencedRoot, ["state", "plan", "set-status", "--plan", unreferenced.id, "--id", unreferencedTask, "--status", "complete", "--format", "json"]).rc).toBe(0);
    assertRejected(unreferencedRoot, unreferenced.id, unreferencedTask, pass);

    const blockedRoot = project(); const blocked = create(blockedRoot, "blocked terminal"); const blockedTask = blocked.tasks[0].id;
    expect(capture(blockedRoot, ["state", "plan", "set-status", "--plan", blocked.id, "--id", blockedTask, "--status", "blocked", "--format", "json"]).rc).toBe(0);
    assertRejected(blockedRoot, blocked.id, blockedTask, pass);

    for (const lifecycle of ["complete", "archived"] as const) {
      const root = project(); const persisted = persistedReplacement(root, `${lifecycle} plan recovery`);
      expect(capture(root, ["state", "plan", "record-evaluation", "--plan", persisted.planId, "--id", persisted.replacement, ...pass, "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-plan-status", "--plan", persisted.planId, "--status", "complete", "--format", "json"]).rc).toBe(0);
      if (lifecycle === "archived") expect(capture(root, ["state", "plan", "archive", "--plan", persisted.planId, "--format", "json"]).rc).toBe(0);
      assertRejected(root, persisted.planId, persisted.replacement, ["--attempt-id", "audit-2", "--verdict", "pass", "--provenance", "audit"]);
    }
  });

  it("infers one open plan and reports zero or multiple open plans actionably", () => {
    const root = project(); const first = create(root, "first");
    expect(appendTask(root, undefined, { name: "Inferred", depends_on: [], acceptance: [] }).id).toMatch(/^[a-z]{10}$/);
    const second = create(root, "second");
    const ambiguous = capture(root, ["state", "plan", "append", "--input", taskInput(root, { name: "No owner", depends_on: [], acceptance: [] }), "--format", "json"]); expect(ambiguous.rc).toBe(1); expect(JSON.parse(ambiguous.out).error.message).toMatch(new RegExp(`${first.id}.*${second.id}|${second.id}.*${first.id}`));
    expect(appendTask(root, second.id, { name: "Explicit", depends_on: [], acceptance: [] }).id).toMatch(/^[a-z]{10}$/);
    const empty = project(); const missing = capture(empty, ["state", "plan", "append", "--input", taskInput(empty, { name: "Missing", depends_on: [], acceptance: [] }), "--format", "json"]); expect(missing.rc).toBe(1); expect(JSON.parse(missing.out).error.message).toMatch(/no open plan/i);
  });

  it("keeps one active plan unambiguous beside more than twenty archived plans and exposes archived exact/filter reads", () => {
    const root = project(); const active = create(root, "active"); const archived: any[] = [];
    for (let index = 0; index < 21; index += 1) {
      archived.push(archivedPlanFixture(root, index));
    }

    const current = capture(root, ["state", "plan", "--format", "json"]);
    expect(current.rc, current.err || current.out).toBe(0);
    expect(JSON.parse(current.out).plan.id).toBe(active.id);
    const filtered = capture(root, ["state", "plan", "list", "--status", "archived", "--limit", "100", "--format", "json"]);
    expect(filtered.rc, filtered.err || filtered.out).toBe(0);
    expect(JSON.parse(filtered.out)).toMatchObject({ counts: { total: 21, returned: 21 }, filters: { status: ["archived"] } });
    const filteredPage = capture(root, ["state", "plan", "list", "--status", "archived", "--ids-only", "--limit", "1", "--format", "json"]);
    expect(JSON.parse(filteredPage.out).retrieval.continue).toMatch(/^agentera state plan list --status 'archived' --ids-only --limit 1 --cursor \S+ --format json$/);
    const exact = capture(root, ["state", "plan", "get", "--id", archived[0].id, "--format", "json"]);
    expect(exact.rc, exact.err || exact.out).toBe(0);
    expect(JSON.parse(exact.out).entry.record.header.status).toBe("archived");
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 44 });

    const archivedInput = plan("ordinary archived create"); (archivedInput.header as Record<string, unknown>).status = "archived";
    const input = path.join(root, "archived.yaml"); fs.writeFileSync(input, dumpYamlMapping(archivedInput));
    expect(capture(root, ["state", "plan", "create", "--input", input, "--format", "json"]).rc).not.toBe(0);
    expect(capture(root, ["state", "plan", "set-plan-status", "--plan", active.id, "--status", "archived", "--format", "json"]).rc).not.toBe(0);
  });

  it("rejects missing, cross-plan, self, and cyclic dependencies without changing the task", () => {
    const root = project(); const left = create(root, "left", true); const right = create(root, "right"); const leftFirst = left.tasks[0].id; const leftSecond = left.tasks[1].id;
    for (const dependency of ["zzzzzzzzzz", right.tasks[0].id, leftSecond]) {
      const result = updateTask(root, leftFirst, { depends_on: [dependency] }, left.id); expect(result.rc).not.toBe(0);
    }
    expect(validateEntityState(root).valid).toBe(true);
  });

  it("rolls back every visible entity when plan create publication fails", () => {
    const root = project(); const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let calls = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => { calls += 1; if (calls === 2) throw new Error("injected create failure"); return original(target, bytes); });
    expect(() => createPlanEntities(request(root, "create", {}, plan("rollback", true)), { publicationContext: binding.publicationContext, candidate: (() => { const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]; return () => ids.shift()!; })() })).toThrow(/injected create failure/);
    binding.publicationContext.close();
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 0 });
  });

  it("restores a completed predecessor byte-for-byte after each replacement publication boundary, then archives it once on retry", () => {
    for (const failAt of [1, 2]) {
      const root = project(); const predecessor = complete(root, `predecessor-${failAt}`);
      const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
      const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let calls = 0;
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => { calls += 1; if (calls === failAt) throw new Error(`injected replacement publication failure ${failAt}`); return original(target, bytes); });
      const failedIds = ["cccccccccc", "dddddddddd"];
      expect(() => createPlanEntities(request(root, "create", {}, plan("replacement")), { publicationContext: binding.publicationContext, candidate: () => failedIds.shift()! })).toThrow(/replacement publication failure/);
      expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
      vi.mocked(binding.publicationContext.publishImmutable).mockImplementation(original);
      const ids = ["cccccccccc", "dddddddddd"];
      const replacement = createPlanEntities(request(root, "create", {}, plan("replacement")), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! });
      binding.publicationContext.close(); vi.restoreAllMocks();
      expect(replacement.id).toBe("cccccccccc");
      expect(loadYamlMapping(fs.readFileSync(predecessorPath, "utf8")).record).toMatchObject({ header: { status: "archived" } });
      expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
    }
  });

  it("restores the exact predecessor and removes the whole replacement graph after post-publication validation or identity failure", () => {
    for (const boundary of ["validation", "identity"] as const) {
      const root = project(); const predecessor = complete(root, `predecessor-${boundary}`);
      const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
      const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const originalPublish = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
      const originalReplace = binding.publicationContext.replaceExisting.bind(binding.publicationContext);
      const originalExact = binding.publicationContext.restoreExact.bind(binding.publicationContext);
      const originalAssert = binding.publicationContext.assertValid.bind(binding.publicationContext); let publications = 0; let replacements = 0;
      vi.spyOn(binding.publicationContext, "replaceExisting").mockImplementation((...args) => { replacements += 1; return originalReplace(...args); });
      vi.spyOn(binding.publicationContext, "restoreExact").mockImplementation((...args) => { replacements += 1; return originalExact(...args); });
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        const result = originalPublish(target, bytes); publications += 1;
        if (boundary === "validation" && publications === 2) fs.writeFileSync(path.join(root, ".agentera/entities/plan/plan_task/eeeeeeeeee.yaml"), "invalid: residue\n");
        return result;
      });
      if (boundary === "identity") vi.spyOn(binding.publicationContext, "assertValid").mockImplementation(() => { if (publications === 2) throw new Error("injected replacement identity failure"); return originalAssert(); });
      const ids = ["cccccccccc", "dddddddddd"];
      expect(() => createPlanEntities(request(root, "create", {}, plan(`replacement-${boundary}`)), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(boundary === "validation" ? /failed state validation/ : /identity failure/);
      binding.publicationContext.close(); vi.restoreAllMocks();
      expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
      expect(replacements).toBe(2);
      if (boundary === "validation") fs.rmSync(path.join(root, ".agentera/entities/plan/plan_task/eeeeeeeeee.yaml"));
      expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
    }
  });

  it("fails closed with both errors when predecessor restoration ownership changes", () => {
    const root = project(); const predecessor = complete(root, "owned predecessor");
    const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`); const competing = "competing predecessor bytes\n";
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation(() => { fs.writeFileSync(predecessorPath, competing); throw new Error("primary replacement failure"); });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() => createPlanEntities(request(root, "create", {}, plan("replacement")), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(/primary replacement failure.*recovery.*ownership|recovery.*ownership.*primary replacement failure/i);
    binding.publicationContext.close();
    expect(fs.readFileSync(predecessorPath, "utf8")).toBe(competing);
  });

  it("retains competing replacement residue and reports primary plus cleanup failure", () => {
    const root = project(); complete(root, "cleanup predecessor");
    const replacementPath = path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"); const competing = "competing replacement bytes\n";
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const originalPublish = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let publications = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      const result = originalPublish(target, bytes); publications += 1;
      if (publications === 2) fs.writeFileSync(replacementPath, competing);
      return result;
    });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() => createPlanEntities(request(root, "create", {}, plan("cleanup replacement")), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(/failed state validation.*recovery.*cleanup|recovery.*cleanup.*failed state validation/i);
    binding.publicationContext.close();
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(competing);
  });

  it("creates a valid plan graph when logical validation reaches migrated summary sources through the real root", () => {
    const root = project();
    writeMigratedDecisionAndProgressSummaries(root);
    const created = create(root, "migrated summaries");
    expect(created).toMatchObject({ id: expect.stringMatching(/^[a-z]{10}$/), tasks: [{ id: expect.stringMatching(/^[a-z]{10}$/) }] });
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
  });

  it("rolls back a plan graph when a migrated summary source no longer matches after publication", () => {
    const root = project(); const { progressSource } = writeMigratedDecisionAndProgressSummaries(root); const preserved = unrelated(root);
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let calls = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      const result = original(target, bytes); calls += 1;
      if (calls === 2) fs.writeFileSync(progressSource, "archive: []\n");
      return result;
    });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() => createPlanEntities(request(root, "create", {}, plan("changed provenance")), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(/migration_provenance|bind|unsafe/i);
    binding.publicationContext.close();
    expect(calls).toBe(2);
    expect(fs.existsSync(path.join(root, ".agentera/entities/plan"))).toBe(false);
    expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
  });

  it("rolls back the complete create graph after every successful file when the marker changes", () => {
    for (const invalidation of ["remove", "replace"] as const) for (const after of [1, 2, 3]) {
      const container = project(false); const root = path.join(container, "project"); fs.mkdirSync(root); fs.mkdirSync(path.join(root, ".agentera")); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
      const preserved = unrelated(root);
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let calls = 0;
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        const result = original(target, bytes); calls += 1;
        if (calls === after) {
          fs.rmSync(path.join(root, ".agentera/state-mode.yaml")); if (invalidation === "replace") fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
        }
        return result;
      });
      const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
      expect(() => createPlanEntities(request(root, "create", {}, plan("rollback", true)), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(/changed|conflict/i);
      expect(() => binding.publicationContext.publishImmutable(".agentera/entities/plan/plan/dddddddddd.yaml", "refused\n")).toThrow(/changed|conflict/i);
      binding.publicationContext.close(); vi.restoreAllMocks();
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan"))).toBe(false);
      expect(entityNames(root).filter((name) => name.includes(".tmp") || name.includes("aaaaaaaaaa") || name.includes("bbbbbbbbbb") || name.includes("cccccccccc"))).toEqual([]);
      expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
    }
  });

  it("rolls back prior create files when marker invalidation strikes every next-file publication boundary", () => {
    for (const invalidation of ["remove", "replace"] as const) for (const boundary of ["directory", "stage", "link", "final"] as const) {
      const container = project(false); const root = path.join(container, "project"); fs.mkdirSync(root); fs.mkdirSync(path.join(root, ".agentera")); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
      const preserved = unrelated(root);
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const mutate = (): void => {
        fs.rmSync(path.join(root, ".agentera/state-mode.yaml")); if (invalidation === "replace") fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
      };
      let mutated = false; const once = (): void => { if (!mutated) { mutated = true; mutate(); } };
      const originalMkdir = fs.mkdirSync.bind(fs), originalOpen = fs.openSync.bind(fs), originalLink = fs.linkSync.bind(fs), originalSync = fs.fsyncSync.bind(fs);
      if (boundary === "directory") vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => { const result = originalMkdir(candidate, options as never); if (String(candidate).endsWith("/plan_task")) once(); return result as never; });
      else if (boundary === "stage") vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => { const fd = originalOpen(candidate, flags, mode); if (String(candidate).includes(".bbbbbbbbbb.yaml.") && String(candidate).endsWith(".tmp")) once(); return fd; });
      else if (boundary === "link") vi.spyOn(fs, "linkSync").mockImplementation((source, target) => { originalLink(source, target); if (String(target).endsWith("/bbbbbbbbbb.yaml")) once(); });
      else vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => { originalSync(fd); let descriptor = ""; try { descriptor = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* descriptor closed */ } if (descriptor.endsWith("/plan_task") && fs.existsSync(`/proc/self/fd/${fd}/bbbbbbbbbb.yaml`)) once(); });
      const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
      expect(() => createPlanEntities(request(root, "create", {}, plan("rollback", true)), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(/changed|conflict/i);
      expect(mutated).toBe(true); binding.publicationContext.close(); vi.restoreAllMocks();
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan")), `${invalidation}/${boundary}: ${entityNames(root).join(", ")}`).toBe(false);
      expect(entityNames(root).filter((name) => name.includes(".tmp") || name.includes("aaaaaaaaaa") || name.includes("bbbbbbbbbb"))).toEqual([]);
      expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
    }
  });

  it("preserves identical and divergent same-path successors during marker-invalidated create rollback", () => {
    for (const content of ["identical", "divergent"] as const) {
      const container = project(false); const root = path.join(container, "project"); fs.mkdirSync(root); fs.mkdirSync(path.join(root, ".agentera")); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
      const preserved = unrelated(root);
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let calls = 0; let firstBytes = "";
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        const result = original(target, bytes); calls += 1;
        if (calls === 1) firstBytes = bytes;
        if (calls === 2) {
          const first = path.join(root, ".agentera/entities/plan/plan/aaaaaaaaaa.yaml");
          fs.unlinkSync(first); fs.writeFileSync(first, content === "identical" ? firstBytes : "successor bytes\n");
          fs.unlinkSync(path.join(root, ".agentera/state-mode.yaml"));
        }
        return result;
      });
      const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
      expect(() => createPlanEntities(request(root, "create", {}, plan("successor", true)), { publicationContext: binding.publicationContext, candidate: () => ids.shift()! })).toThrow(/changed|conflict/i);
      binding.publicationContext.close(); vi.restoreAllMocks();
      expect(fs.readFileSync(path.join(root, ".agentera/entities/plan/plan/aaaaaaaaaa.yaml"), "utf8")).toBe(content === "identical" ? firstBytes : "successor bytes\n");
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/bbbbbbbbbb.yaml"))).toBe(false);
      expect(entityNames(root).filter((name) => name.includes(".tmp") || name.includes(".rollback"))).toEqual([]);
      expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
    }
  });

  it("rejects malformed entity evaluation metadata in whole-state validation", () => {
    const root = project(); const created = create(root, "validation"); const target = path.join(root, `.agentera/entities/plan/plan_task/${created.tasks[0].id}.yaml`);
    const entity = loadYamlMapping(fs.readFileSync(target, "utf8")); const record = entity.record as Record<string, unknown>;
    record.evaluation = { attempt_count: 1, failure_count: 1, last_verdict: "fail", last_failure_evidence: null, provenance: { attempt_id: "audit-1", source: "audit", recorded_at: "2026-07-17 12:00", writer_command: "agentera state plan record-evaluation" } };
    fs.writeFileSync(target, dumpYamlMapping(entity)); const validation = validateEntityState(root);
    expect(validation.valid).toBe(false); expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/evaluation fields/) })]));
  });

  it("provides full bounded plan/task snapshots and invalidates changed cursors", () => {
    const root = project(); const first = create(root, "first"); create(root, "second");
    const listed = capture(root, ["state", "plan", "list", "--limit", "1", "--format", "json"]); expect(listed.rc).toBe(0); const page = JSON.parse(listed.out); expect(page.entries[0]).toHaveProperty("record"); expect(page.next_cursor).toBeTruthy();
    const exact = capture(root, ["state", "plan", "get", "--id", first.id, "--format", "json"]); expect(exact.rc).toBe(0); expect(JSON.parse(exact.out).tasks[0].record).toBeTruthy();
    const taskId = JSON.parse(exact.out).tasks[0].id;
    expect(capture(root, ["state", "plan", "tasks", "get", "--id", taskId, "--format", "json"]).rc).toBe(0);
    appendTask(root, first.id, { name: "Changed snapshot", depends_on: [], acceptance: [] });
    const stale = capture(root, ["state", "plan", "list", "--limit", "1", "--cursor", page.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(JSON.parse(stale.out).error.class).toBe("cursor_snapshot_unavailable");
  });

  it("rejects numeric selectors in entity mode and all writes before cutover", () => {
    const entity = project(); const created = create(entity, "entity");
    expect(capture(entity, ["state", "plan", "set-status", "--task", "1", "--status", "complete", "--format", "json"]).rc).toBe(2);
    expect(capture(entity, ["state", "plan", "tasks", "get", "--task", "1", "--format", "json"]).rc).toBe(2);
    const legacy = project(false); const input = path.join(legacy, "legacy.yaml"); fs.writeFileSync(input, dumpYamlMapping(plan("legacy")));
    const rejected = capture(legacy, ["state", "plan", "create", "--input", input, "--format", "json"]);
    expect(rejected.rc).toBe(1); expect(JSON.parse(rejected.out).error).toMatchObject({ class: "migration_required", recovery: expect.stringContaining("upgrade --channel development") });
    expect(fs.existsSync(path.join(legacy, ".agentera/plan.yaml"))).toBe(false); expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);
    expect(created.id).toMatch(/^[a-z]{10}$/);
  });

  it("lets Git merge different tasks, conflicts on one task, and validates duplicate ownership", () => {
    const root = project(); const created = create(root, "merge"); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", ".agentera"); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    appendTask(left, created.id, { name: "Left", depends_on: [], acceptance: [] }); appendTask(right, created.id, { name: "Right", depends_on: [], acceptance: [] }); git(left, "add", ".agentera/entities"); git(left, "commit", "-m", "left"); git(right, "add", ".agentera/entities"); git(right, "commit", "-m", "right"); git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right"); expect(validateEntityState(root).valid).toBe(true);
    const taskPath = path.join(root, ".agentera/entities/plan/plan_task", `${created.tasks[0].id}.yaml`); const duplicate = path.join(root, ".agentera/entities/plan/plan", `${created.tasks[0].id}.yaml`); fs.copyFileSync(taskPath, duplicate); expect(validateEntityState(root).valid).toBe(false); fs.unlinkSync(duplicate);
    const conflictRoot = project(); const conflictPlan = create(conflictRoot, "conflict"); git(conflictRoot, "init", "-b", "main"); git(conflictRoot, "config", "user.name", "Fixture"); git(conflictRoot, "config", "user.email", "fixture@example.test"); git(conflictRoot, "add", ".agentera"); git(conflictRoot, "commit", "-m", "base");
    const a = `${conflictRoot}-a`, b = `${conflictRoot}-b`; roots.push(a, b); git(conflictRoot, "worktree", "add", "-b", "a", a, "main"); git(conflictRoot, "worktree", "add", "-b", "b", b, "main"); expect(updateTask(a, conflictPlan.tasks[0].id, { name: "A" }, conflictPlan.id).rc).toBe(0); expect(updateTask(b, conflictPlan.tasks[0].id, { name: "B" }, conflictPlan.id).rc).toBe(0); git(a, "add", ".agentera/entities"); git(a, "commit", "-m", "a"); git(b, "add", ".agentera/entities"); git(b, "commit", "-m", "b"); git(conflictRoot, "merge", "--ff-only", "a"); expect(() => git(conflictRoot, "merge", "--no-edit", "b")).toThrow();
  });
});
