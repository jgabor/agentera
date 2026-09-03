import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMigratedDecisionAndProgressSummaries } from "../helpers/migratedSummaryFixture.js";
import { sourceBuildOutputRoot, sourceSubprocessEnv } from "../helpers/sourceSubprocess.js";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { canonicalEntityRecordViolations, validateEntityState } from "../../src/state/entityStorage.js";
import { createPlanEntities, replacePlanEntities } from "../../src/state/planEntities.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { buildExplain } from "../../src/state/write/explain.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { shellCommandArgs } from "../helpers/shellCommand.js";
import { entityListFamily } from "../../src/state/entityRetrievalHelp.js";

const roots: string[] = [];
const VALID_MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";
const TARGETED_REPLACEMENT_RECOVERY = "npx -y agentera@next state plan replace --predecessor PREDECESSOR_ID --successor SUCCESSOR_ID";
const supersessionWorker = fileURLToPath(new URL("./planSupersessionWorker.mjs", import.meta.url));
const appendWorker = fileURLToPath(new URL("./planAppendWorker.mjs", import.meta.url));

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-entities-"));
  roots.push(root);
  if (entity) {
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
  }
  return root;
}
function plan(title: string, dependency = false): Record<string, unknown> {
  return {
    header: { level: "light", created: "2026-07-17", status: "open", title },
    what: `Deliver ${title} through \`.agentera/entities/plan\`.`,
    why: "Independent task files must merge safely in Git.",
    scope: { included: ["plan state"], excluded: ["other families"] },
    tasks: [
      {
        number: 1,
        name: "First",
        status: "pending",
        acceptance: ["GIVEN state WHEN written THEN it is canonical"],
      },
      ...(dependency
        ? [
            {
              number: 2,
              name: "Second",
              depends_on: ["1"],
              status: "pending",
              acceptance: ["GIVEN first WHEN complete THEN second can run"],
            },
          ]
        : []),
    ],
  };
}
function capture(root: string, args: string[]): { rc: number; out: string; err: string } {
  const cwd = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    return {
      rc: main(["node", "agentera", ...args], {
        out: (text) => {
          out += text;
        },
        err: (text) => {
          err += text;
        },
      }),
      out,
      err,
    };
  } finally {
    process.chdir(cwd);
  }
}
function create(root: string, title: string, dependency = false, force = false): any {
  const input = path.join(root, `${title}.yaml`);
  fs.writeFileSync(input, dumpYamlMapping(plan(title, dependency)));
  const result = capture(root, ["state", "plan", "create", ...(force ? ["--force"] : []), "--input", input, "--format", "json"]);
  expect(result.rc, result.err || result.out).toBe(0);
  return JSON.parse(result.out);
}
function planInput(root: string, title: string, dependency = false, record = plan(title, dependency)): string {
  const input = path.join(root, `${title}.yaml`);
  fs.writeFileSync(input, dumpYamlMapping(record));
  return input;
}
function taskInput(root: string, record: Record<string, unknown>): string {
  const input = path.join(root, "task-input.yaml");
  fs.writeFileSync(input, dumpYamlMapping(record));
  return input;
}
function appendTask(root: string, planId: string | undefined, record: Record<string, unknown>): any {
  const result = capture(root, ["state", "plan", "append", ...(planId ? ["--plan", planId] : []), "--input", taskInput(root, record), "--format", "json"]);
  expect(result.rc, result.err || result.out).toBe(0);
  return JSON.parse(result.out);
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
  const created = create(root, title);
  const predecessor = created.tasks[0].id;
  const replacement = appendTask(root, created.id, {
    name: "Completed replacement",
    depends_on: [],
    acceptance: [],
  }).id;
  expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", predecessor, "--status", "blocked", "--format", "json"]).rc).toBe(0);
  expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", replacement, "--status", "complete", "--format", "json"]).rc).toBe(0);
  const predecessorPath = path.join(root, `.agentera/entities/plan/plan_task/${predecessor}.yaml`);
  const envelope = loadYamlMapping(fs.readFileSync(predecessorPath, "utf8"));
  const record = envelope.record as Record<string, unknown>;
  record.status = "superseded";
  record.superseded_by = [replacement];
  record.superseded_reason = "Replacement closes the failed work.";
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
function openPlanFixture(root: string, index: number, title: string): { id: string; tasks: Array<{ id: string }> } {
  const id = fixtureId(index);
  const taskId = fixtureId(index + 1);
  const record = plan(title);
  delete record.tasks;
  const planFile = path.join(root, `.agentera/entities/plan/plan/${id}.yaml`);
  const taskFile = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  fs.writeFileSync(planFile, dumpYamlMapping({ id, artifact: "plan", record }));
  fs.writeFileSync(
    taskFile,
    dumpYamlMapping({
      id: taskId,
      artifact: "plan",
      record: { plan: id, name: "First", status: "pending", depends_on: [], acceptance: [] },
    }),
  );
  return { id, tasks: [{ id: taskId }] };
}
function archivedPlanFixture(root: string, index: number): { id: string } {
  const id = fixtureId(100 + index * 2);
  const taskId = fixtureId(101 + index * 2);
  const record = plan(`historical-${index}`);
  delete record.tasks;
  (record.header as Record<string, unknown>).status = "archived";
  const planFile = path.join(root, `.agentera/entities/plan/plan/${id}.yaml`);
  const taskFile = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  fs.writeFileSync(planFile, dumpYamlMapping({ id, artifact: "plan", record }));
  fs.writeFileSync(
    taskFile,
    dumpYamlMapping({
      id: taskId,
      artifact: "plan",
      record: {
        plan: id,
        name: "First",
        status: "blocked",
        depends_on: [],
        acceptance: ["GIVEN state WHEN written THEN it is canonical"],
      },
    }),
  );
  return { id };
}
function request(root: string, verb: string, values: Record<string, unknown> = {}, input: Record<string, unknown> | null = null, force = false): StateWriteRequest {
  const spec = operationSpec("plan", verb);
  if (!spec) throw new Error(`missing plan ${verb}`);
  return {
    artifact: "plan",
    spec,
    projectRoot: root,
    dryRun: false,
    force,
    values,
    callerPayload: structuredClone(input ?? values),
    input,
  };
}
function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function entityNames(root: string): string[] {
  const entities = path.join(root, ".agentera/entities");
  return fs.existsSync(entities) ? fs.readdirSync(entities, { recursive: true, encoding: "utf8" }) : [];
}
function replacementJournals(root: string): string[] {
  const directory = path.join(root, ".agentera/.entity-recovery/plan-replacement");
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
}
async function concurrentLifecycle(root: string, planId: string, blocked: string, replacement: string, action: "reopen" | "archive"): Promise<Array<{ ok: boolean; error?: string }>> {
  const start = path.join(root, `race-${action}.start`);
  const ready = ["supersede", action].map((name) => path.join(root, `race-${action}-${name}.ready`));
  const results = ["supersede", action].map((name) => path.join(root, `race-${action}-${name}.json`));
  const children = ["supersede", action].map(
    (kind, index) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [supersessionWorker], {
          cwd: path.resolve(import.meta.dirname, "../.."),
          env: {
            ...sourceSubprocessEnv(),
            AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
            AGENTERA_PLAN_RACE_ROOT: root,
            AGENTERA_PLAN_RACE_PLAN: planId,
            AGENTERA_PLAN_RACE_BLOCKED: blocked,
            AGENTERA_PLAN_RACE_REPLACEMENT: replacement,
            AGENTERA_PLAN_RACE_ACTION: kind,
            AGENTERA_PLAN_RACE_READY: ready[index],
            AGENTERA_PLAN_RACE_START: start,
            AGENTERA_PLAN_RACE_RESULT: results[index],
          },
          stdio: "pipe",
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`plan race worker exited ${code}: ${stderr}`))));
      }),
  );
  const deadline = Date.now() + 10_000;
  while (!ready.every((file) => fs.existsSync(file))) {
    if (Date.now() > deadline) throw new Error("plan race workers did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(start, "start\n");
  await Promise.all(children);
  return results.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}
async function concurrentAppend(root: string, planId: string, input: string): Promise<Array<{ rc: number; output: string; error: string }>> {
  const start = path.join(root, "race-append.start");
  const ready = ["one", "two"].map((name) => path.join(root, `race-append-${name}.ready`));
  const results = ["one", "two"].map((name) => path.join(root, `race-append-${name}.json`));
  const children = ready.map(
    (readyFile, index) =>
      new Promise<void>((resolve, reject) => {
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
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`plan append worker exited ${code}: ${stderr}`))));
      }),
  );
  const deadline = Date.now() + 10_000;
  while (!ready.every((file) => fs.existsSync(file))) {
    if (Date.now() > deadline) throw new Error("plan append workers did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(start, "start\n");
  await Promise.all(children);
  return results.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}

function unrelated(root: string): { file: string; bytes: string } {
  const file = path.join(root, ".agentera/unrelated.txt");
  const bytes = "successor or unrelated state\n";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

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
      if (verb === "record-evaluation") expect(explanation.guidance).toEqual(expect.arrayContaining([expect.stringContaining("evaluate before completing"), expect.stringContaining("first PASS on an unevaluated complete replacement")]));
    }
  });

  it("discovers one targeted replacement grammar with bare roles and an optional creation payload", () => {
    const root = project();
    const result = capture(root, ["state", "plan", "explain", "--verb", "replace", "--format", "json"]);
    expect(result.rc, result.err || result.out).toBe(0);
    const explanation = JSON.parse(result.out);
    expect(explanation).toMatchObject({
      path: ".agentera/entities/plan/plan/<id>.yaml",
      mutation_class: "batch_transaction",
      selectors: ["--predecessor", "--successor"],
      input: {
        mode: "structured",
        optional: true,
        root: "complete plan document when creating a successor",
      },
    });
    expect(explanation.fields).toEqual(expect.arrayContaining([expect.objectContaining({ flag: "--predecessor", field: "predecessor", required: true }), expect.objectContaining({ flag: "--successor", field: "successor", required: false })]));
    expect(explanation.examples).toEqual(["agentera state plan replace --predecessor abcdefghij --successor klmnopqrst", "agentera state plan replace --predecessor abcdefghij --input plan.yaml"]);
  });

  it("explains locked forced plan lifecycle effects with bare lineage IDs", () => {
    const root = project();
    for (const verb of ["create", "archive"] as const) {
      const result = capture(root, ["state", "plan", "explain", "--verb", verb, "--format", "json"]);
      expect(result.rc, result.err || result.out).toBe(0);
      const explanation = JSON.parse(result.out);
      expect(explanation).toMatchObject({
        allow_force: true,
        force_semantics: expect.stringContaining("--force"),
      });
      expect(explanation.guidance).toEqual(expect.arrayContaining([expect.stringContaining(verb === "create" ? "unchanged" : "without changing")]));
    }
  });

  it("creates one plan and independent task entities with bare dependency IDs", () => {
    const root = project();
    const created = create(root, "graph", true);
    expect(created).toMatchObject({ artifact: "plan", id: expect.stringMatching(/^[a-z]{10}$/) });
    expect(created.tasks).toHaveLength(2);
    expect(created.tasks[0]).toMatchObject({
      artifact: "plan",
      id: expect.stringMatching(/^[a-z]{10}$/),
      record: { plan: created.id },
    });
    expect(created.tasks[1].record.depends_on).toEqual([created.tasks[0].id]);
    expect(created.record.header.id).toBeUndefined();
    expect(created.tasks[0].record.number).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".agentera/plan.yaml"))).toBe(false);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 3 });
  });

  it.each([1, "1"])("normalizes atomic-create dependency ordinal %j to a bare task ID", (dependency) => {
    const root = project();
    const input = plan(`ordinal-${typeof dependency}`) as Record<string, any>;
    input.tasks.push({
      number: 2,
      name: "Second",
      depends_on: [dependency],
      status: "pending",
      acceptance: ["The dependency is canonical"],
    });
    const source = path.join(root, "plan.yaml");
    fs.writeFileSync(source, dumpYamlMapping(input));
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
    input.tasks.push({
      number: 2,
      name: "Second",
      depends_on: dependsOn,
      status: "pending",
      acceptance: ["Invalid input is rejected"],
    });
    const source = path.join(root, "plan.yaml");
    fs.writeFileSync(source, dumpYamlMapping(input));
    const result = capture(root, ["state", "plan", "create", "--input", source, "--format", "json"]);
    expect(result.rc).not.toBe(0);
    expect(JSON.parse(result.out).error.class).toBe("schema_violation");
    expect(fs.readdirSync(path.join(root, ".agentera"))).toEqual(["state-mode.yaml"]);
  });

  it("keeps existing-task append and update dependencies bare-ID-only", () => {
    const root = project();
    const created = create(root, "existing-task-identities", true);
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
    let command = "agentera state plan tasks list --limit 100";
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
        expect(task.retrieval.get).toBe(`agentera state plan tasks get --id ${task.id}`);
        observed.add(task.id);
      }
      if (page.omitted) {
        expect(page.omission_reason).toBe("page_limit");
        expect(page.omitted_count).toBeGreaterThan(0);
        expect(page.next_cursor).toEqual(expect.any(String));
        expect(page.retrieval.get).toBe("agentera state plan tasks get --id ID");
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

    for (const [selector, expected] of [
      [[], active],
      [[archived.id], archived],
    ] as const) {
      const first = capture(root, ["state", "plan", "tasks", "list", ...selector, "--limit", "1", "--format", "json"]);
      expect(first.rc, first.err || first.out).toBe(0);
      const page = JSON.parse(first.out);
      expect(page).toMatchObject({
        status: "degraded",
        filters: { plan: expected.id },
        omitted: true,
        omitted_count: 1,
      });
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
      entries: [
        {
          artifact: "plan",
          retrieval: {
            get: expect.stringMatching(/^agentera state plan tasks get --id [a-z]{10}$/),
          },
        },
      ],
    });
    expect(firstPage.entries[0]).not.toHaveProperty("record");
    expect(firstPage.retrieval.continue).toContain("--ids-only");

    const second = capture(root, shellCommandArgs(firstPage.retrieval.continue));
    expect(second.rc, second.err || second.out).toBe(0);
    const secondPage = JSON.parse(second.out);
    const observed = [firstPage.entries[0].id, secondPage.entries[0].id];
    expect(new Set(observed)).toEqual(new Set(created.tasks.map((task: any) => task.id)));
    expect(secondPage).toMatchObject({
      counts: { candidate: 2, returned: 1, omitted: 0, continuation: 0 },
      projection: { selector: "ids_only" },
    });

    const switched = capture(root, ["state", "plan", "tasks", "list", "--limit", "1", "--fields", "status", "--cursor", firstPage.next_cursor, "--format", "json"]);
    expect(switched.rc).toBe(1);
    expect(JSON.parse(switched.out).error).toMatchObject({
      class: "cursor_invalid",
      recovery: expect.stringContaining("original selector"),
    });

    const fields = capture(root, ["state", "plan", "tasks", "list", "--fields", "status,name", "--format", "json"]);
    expect(fields.rc, fields.err || fields.out).toBe(0);
    const fieldsPage = JSON.parse(fields.out);
    expect(fieldsPage.entries).toHaveLength(2);
    expect(fieldsPage.entries[0]).toMatchObject({
      id: expect.any(String),
      artifact: "plan",
      record: { name: expect.any(String), status: "pending" },
      retrieval: { get: expect.any(String) },
    });
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
    expect(JSON.parse(result.out).error).toMatchObject({
      syntax: family.syntax,
      example: family.example,
    });
    const invalid = capture(root, ["state", "plan", "tasks", "list", "not-a-plan", "--format", "json"]);
    expect(invalid.rc).toBe(2);
    expect(JSON.parse(invalid.out).error).toMatchObject({
      class: "invalid_request",
      example: "agentera state plan get --id qjtrmnpvka",
      recovery: "Use a bare plan ID returned by plan create or list.",
    });
  });

  it("applies the authority-backed plan scope shape at direct and whole-state boundaries", () => {
    const base = plan("scope parity");
    delete base.tasks;
    for (const scope of [
      { included: [], excluded: [] },
      { included: ["plan"], excluded: ["release"], deferred: ["later", "exactly"] },
    ]) {
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

    const root = project();
    const created = create(root, "malformed scope state");
    const target = path.join(root, `.agentera/entities/plan/plan/${created.id}.yaml`);
    const entity = loadYamlMapping(fs.readFileSync(target, "utf8"));
    (entity.record as Record<string, unknown>).scope = { included: ["plan"] };
    fs.writeFileSync(target, dumpYamlMapping(entity));
    const validation = validateEntityState(root);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundary: "plan",
          message: expect.stringContaining("scope.excluded is required"),
        }),
      ]),
    );
    const checked = capture(root, ["check", "validate", "state", "--format", "json"]);
    expect(checked.rc).toBe(1);
    expect(JSON.parse(checked.out).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundary: "plan",
          message: expect.stringContaining("scope.excluded is required"),
        }),
      ]),
    );
  });

  it("runs append, update, status, evaluation, lifecycle, and archive by entity selectors", () => {
    const root = project();
    const created = create(root, "lifecycle");
    const planId = created.id;
    const first = created.tasks[0].id;
    let result = appendTask(root, planId, {
      name: "Added",
      depends_on: [first],
      acceptance: ["GIVEN first WHEN done THEN added runs"],
    });
    const added = result.id;
    result = updateTask(root, added, { name: "Updated" }, planId);
    expect(result.rc).toBe(0);
    result = updateTask(root, added, { surprise: "Observed in packages/cli/src/state/planEntities.ts" }, planId);
    expect(result.rc).toBe(0);
    expect(JSON.parse(result.out).record.surprises).toContain("planEntities.ts");
    result = capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", added, "--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "test", "--format", "json"]);
    expect(result.rc).toBe(0);
    for (const id of [first, added]) {
      result = capture(root, ["state", "plan", "set-status", "--plan", planId, "--id", id, "--status", "complete", "--format", "json"]);
      expect(result.rc).toBe(0);
    }
    result = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]);
    expect(result.rc).toBe(0);
    result = capture(root, ["state", "plan", "archive", "--plan", planId, "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      record: { header: { status: "archived" } },
      operation: { idempotent_replay: false },
    });
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
  });

  it("replaces an explicitly named competing open-plan pair without touching tasks, progress, or TODO state", () => {
    const root = project();
    const predecessor = create(root, "explicit predecessor", true);
    const successor = openPlanFixture(root, 720, "explicit successor");
    const progressInput = path.join(root, "replacement-progress.yaml");
    fs.writeFileSync(
      progressInput,
      dumpYamlMapping({
        type: "test",
        phase: "build",
        what: `Keep ${predecessor.id} progress reference intact.`,
        context: { intent: "Prove targeted replacement preserves unrelated state." },
      }),
    );
    const progress = capture(root, ["state", "progress", "append", "--input", progressInput, "--format", "json"]);
    expect(progress.rc, progress.err || progress.out).toBe(0);
    const progressJson = JSON.parse(progress.out);
    const todoPath = path.join(root, "TODO.md");
    fs.writeFileSync(todoPath, "# TODO\n\n- [ ] unrelated public work\n");
    const preserved = new Map([
      [path.join(root, `.agentera/entities/plan/plan_task/${predecessor.tasks[0].id}.yaml`), fs.readFileSync(path.join(root, `.agentera/entities/plan/plan_task/${predecessor.tasks[0].id}.yaml`), "utf8")],
      [path.join(root, `.agentera/entities/plan/plan_task/${successor.tasks[0].id}.yaml`), fs.readFileSync(path.join(root, `.agentera/entities/plan/plan_task/${successor.tasks[0].id}.yaml`), "utf8")],
      [progressJson.path as string, fs.readFileSync(progressJson.path, "utf8")],
      [todoPath, fs.readFileSync(todoPath, "utf8")],
    ]);
    const args = ["state", "plan", "replace", "--predecessor", predecessor.id, "--successor", successor.id, "--format", "json"];
    const preview = capture(root, [...args.slice(0, -2), "--dry-run", "--format", "json"]);
    const applied = capture(root, args);
    expect(preview.rc, preview.err || preview.out).toBe(0);
    expect(applied.rc, applied.err || applied.out).toBe(0);
    const previewJson = JSON.parse(preview.out);
    const appliedJson = JSON.parse(applied.out);
    expect(previewJson.effects).toEqual(appliedJson.effects);
    expect(appliedJson).toMatchObject({
      id: successor.id,
      record: {
        previous_plan_archived: predecessor.id,
        replacement_input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      effects: {
        lifecycle: "targeted_replacement",
        predecessor: {
          id: predecessor.id,
          transition: "archived",
          preserved: ["task_records", "task_evaluations", "task_completion"],
        },
        successor: {
          id: successor.id,
          created: false,
          lineage: { field: "previous_plan_archived", predecessor: predecessor.id },
        },
      },
    });
    const open = capture(root, ["state", "plan", "list", "--status", "open", "--limit", "100", "--format", "json"]);
    expect(open.rc, open.err || open.out).toBe(0);
    expect(JSON.parse(open.out).entries.map((entry: any) => entry.id)).toEqual([successor.id]);
    expect(loadYamlMapping(fs.readFileSync(path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`), "utf8"))).toMatchObject({ record: { header: { status: "archived" } } });
    for (const [file, bytes] of preserved) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    const replayBytes = new Map([
      [path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`), fs.readFileSync(path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`), "utf8")],
      [path.join(root, `.agentera/entities/plan/plan/${successor.id}.yaml`), fs.readFileSync(path.join(root, `.agentera/entities/plan/plan/${successor.id}.yaml`), "utf8")],
    ]);
    const replay = capture(root, args);
    expect(replay.rc, replay.err || replay.out).toBe(0);
    expect(JSON.parse(replay.out).operation).toMatchObject({
      idempotent_replay: true,
      dry_run: false,
    });
    for (const [file, bytes] of replayBytes) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    const divergentSuccessor = archivedPlanFixture(root, 900);
    const divergent = capture(root, ["state", "plan", "replace", "--predecessor", predecessor.id, "--successor", divergentSuccessor.id, "--format", "json"]);
    expect(divergent.rc).toBe(2);
    expect(JSON.parse(divergent.out).error.class).toBe("conflict");
    for (const [file, bytes] of replayBytes) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(validateEntityState(root)).toMatchObject({ valid: true });
  });

  it("selects a targeted replacement successor across prime, dashboard, and direct reads while retaining predecessor history", () => {
    const root = project();
    const predecessor = create(root, "selection predecessor", true);
    const successor = openPlanFixture(root, 760, "selection successor");
    const replaced = capture(root, ["state", "plan", "replace", "--predecessor", predecessor.id, "--successor", successor.id, "--format", "json"]);
    expect(replaced.rc, replaced.err || replaced.out).toBe(0);

    for (const capability of ["plan", "orchestrate", "status"] as const) {
      const result = capture(root, ["prime", "--context", capability, "--format", "json"]);
      expect(result.rc, result.err || result.out).toBe(0);
      const context = JSON.parse(result.out).capability_context.context;
      const selected = capability === "status" ? context.status_context.plan : context.plan;
      expect(selected).toMatchObject({
        id: successor.id,
        artifact: "plan",
        active: true,
        status: "open",
      });
    }
    const dashboard = capture(root, ["prime", "--dashboard", "--format", "json"]);
    expect(dashboard.rc, dashboard.err || dashboard.out).toBe(0);
    expect(JSON.parse(dashboard.out).capability_context.context.status_context.plan).toMatchObject({
      id: successor.id,
      artifact: "plan",
      active: true,
      status: "open",
    });

    const open = capture(root, ["state", "plan", "list", "--status", "open", "--limit", "100", "--format", "json"]);
    expect(open.rc, open.err || open.out).toBe(0);
    expect(JSON.parse(open.out).entries.map((entry: any) => entry.id)).toEqual([successor.id]);
    const archived = capture(root, ["state", "plan", "list", "--status", "archived", "--limit", "100", "--format", "json"]);
    expect(archived.rc, archived.err || archived.out).toBe(0);
    expect(JSON.parse(archived.out).entries.map((entry: any) => entry.id)).toContain(predecessor.id);
    const successorRead = capture(root, ["state", "plan", "get", "--id", successor.id, "--format", "json"]);
    const predecessorRead = capture(root, ["state", "plan", "get", "--id", predecessor.id, "--format", "json"]);
    expect(successorRead.rc, successorRead.err || successorRead.out).toBe(0);
    expect(predecessorRead.rc, predecessorRead.err || predecessorRead.out).toBe(0);
    expect(JSON.parse(successorRead.out).entry.record).toMatchObject({
      previous_plan_archived: predecessor.id,
      header: { status: "open" },
    });
    expect(JSON.parse(predecessorRead.out).entry.record.header.status).toBe("archived");
    const currentTasks = capture(root, ["state", "plan", "tasks", "list", "--format", "json"]);
    expect(currentTasks.rc, currentTasks.err || currentTasks.out).toBe(0);
    expect(JSON.parse(currentTasks.out).filters).toEqual({ plan: successor.id });
  });

  it("returns one role-neutral targeted recovery command for bounded competing-open diagnostics", () => {
    const assertDiagnostic = (root: string, args: string[], expectedStatus: number, ids: string[], omitted = 0) => {
      const result = capture(root, args);
      expect(result.rc, result.err || result.out).toBe(expectedStatus);
      const error = JSON.parse(result.out).error;
      expect(error.message).toContain("canonical state does not assign predecessor or successor roles");
      expect(error.recovery).toBe(TARGETED_REPLACEMENT_RECOVERY);
      expect(error.details ?? error.diagnosis).toEqual({
        open_plan_candidates: {
          total: ids.length,
          sample_ids: ids.slice(0, 100),
          omitted_count: omitted,
        },
      });
    };

    const pair = project();
    const left = create(pair, "diagnostic left");
    const right = openPlanFixture(pair, 780, "diagnostic right");
    const pairIds = [left.id, right.id].sort();
    const input = taskInput(pair, {
      name: "Selection must stay explicit",
      depends_on: [],
      acceptance: [],
    });
    assertDiagnostic(pair, ["prime", "--context", "plan", "--format", "json"], 1, pairIds);
    assertDiagnostic(pair, ["state", "plan", "tasks", "list", "--format", "json"], 1, pairIds);
    assertDiagnostic(pair, ["state", "plan", "append", "--input", input, "--format", "json"], 1, pairIds);
    assertDiagnostic(pair, ["state", "plan", "create", "--force", "--input", planInput(pair, "blocked implicit successor"), "--format", "json"], 2, pairIds);

    const overBound = project();
    const candidates = Array.from({ length: 101 }, (_, index) => openPlanFixture(overBound, 1000 + index * 2, `over-bound ${index}`));
    const ids = candidates.map(({ id }) => id).sort();
    const overBoundInput = taskInput(overBound, {
      name: "Bounded selection failure",
      depends_on: [],
      acceptance: [],
    });
    assertDiagnostic(overBound, ["prime", "--context", "status", "--format", "json"], 1, ids, 1);
    assertDiagnostic(overBound, ["state", "plan", "tasks", "list", "--format", "json"], 1, ids, 1);
    assertDiagnostic(overBound, ["state", "plan", "append", "--input", overBoundInput, "--format", "json"], 1, ids, 1);
    assertDiagnostic(overBound, ["state", "plan", "create", "--force", "--input", planInput(overBound, "over-bound implicit successor"), "--format", "json"], 2, ids, 1);
    assertDiagnostic(overBound, ["state", "plan", "replace", "--predecessor", ids[0], "--successor", ids[1], "--format", "json"], 2, ids, 1);
  });

  it("creates a successor through targeted replacement and treats only logical input equality as replay", () => {
    const root = project();
    const predecessor = create(root, "create replacement predecessor", true);
    const input = planInput(root, "targeted created successor", true);
    const predecessorPlan = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
    const predecessorTask = path.join(root, `.agentera/entities/plan/plan_task/${predecessor.tasks[0].id}.yaml`);
    const predecessorTaskBytes = fs.readFileSync(predecessorTask, "utf8");
    const args = ["state", "plan", "replace", "--predecessor", predecessor.id, "--input", input, "--format", "json"];
    const preview = capture(root, [...args.slice(0, -2), "--dry-run", "--format", "json"]);
    const applied = capture(root, args);
    expect(preview.rc, preview.err || preview.out).toBe(0);
    expect(applied.rc, applied.err || applied.out).toBe(0);
    const previewJson = JSON.parse(preview.out);
    const appliedJson = JSON.parse(applied.out);
    expect(previewJson.effects).toEqual(appliedJson.effects);
    expect(appliedJson).toMatchObject({
      record: { previous_plan_archived: predecessor.id },
      effects: { lifecycle: "targeted_replacement", successor: { created: true } },
    });
    const successorId = appliedJson.id as string;
    const entityNamesAfterApply = entityNames(root);
    const successorPlan = path.join(root, `.agentera/entities/plan/plan/${successorId}.yaml`);
    const successorBytes = fs.readFileSync(successorPlan, "utf8");
    expect(fs.readFileSync(predecessorTask, "utf8")).toBe(predecessorTaskBytes);
    const replay = capture(root, args);
    expect(replay.rc, replay.err || replay.out).toBe(0);
    expect(JSON.parse(replay.out)).toMatchObject({
      id: successorId,
      operation: { idempotent_replay: true, dry_run: false },
    });
    expect(entityNames(root)).toEqual(entityNamesAfterApply);
    expect(fs.readFileSync(successorPlan, "utf8")).toBe(successorBytes);
    const divergentInput = plan("divergent successor", true);
    const divergentPath = planInput(root, "divergent successor", true, divergentInput);
    const predecessorBytes = fs.readFileSync(predecessorPlan, "utf8");
    const divergent = capture(root, ["state", "plan", "replace", "--predecessor", predecessor.id, "--input", divergentPath, "--format", "json"]);
    expect(divergent.rc).toBe(2);
    expect(JSON.parse(divergent.out).error.class).toBe("conflict");
    expect(fs.readFileSync(predecessorPlan, "utf8")).toBe(predecessorBytes);
    expect(fs.readFileSync(successorPlan, "utf8")).toBe(successorBytes);
    expect(validateEntityState(root)).toMatchObject({ valid: true });
  });

  it("replays created replacement from immutable input identity after task lifecycle and evaluation changes", () => {
    const root = project();
    const predecessor = create(root, "immutable replay predecessor", true);
    const input = planInput(root, "immutable replay successor", true);
    const args = ["state", "plan", "replace", "--predecessor", predecessor.id, "--input", input, "--format", "json"];
    const applied = capture(root, args);
    expect(applied.rc, applied.err || applied.out).toBe(0);
    const successor = JSON.parse(applied.out);
    const successorPlan = path.join(root, `.agentera/entities/plan/plan/${successor.id}.yaml`);
    const identity = (loadYamlMapping(fs.readFileSync(successorPlan, "utf8")).record as Record<string, unknown>).replacement_input_sha256;
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    const taskId = successor.tasks[0].id;
    expect(capture(root, ["state", "plan", "set-status", "--plan", successor.id, "--id", taskId, "--status", "in_progress", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "plan", "record-evaluation", "--plan", successor.id, "--id", taskId, "--attempt-id", "immutable-replay-1", "--verdict", "pass", "--provenance", "test", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "plan", "set-status", "--plan", successor.id, "--id", taskId, "--status", "complete", "--format", "json"]).rc).toBe(0);
    const replay = capture(root, args);
    expect(replay.rc, replay.err || replay.out).toBe(0);
    expect(JSON.parse(replay.out)).toMatchObject({
      id: successor.id,
      operation: { idempotent_replay: true },
    });
    expect((loadYamlMapping(fs.readFileSync(successorPlan, "utf8")).record as Record<string, unknown>).replacement_input_sha256).toBe(identity);
  });

  it("restores complete prior state when either targeted replacement transaction is interrupted", () => {
    const existingRoot = project();
    const existingPredecessor = create(existingRoot, "interrupted existing predecessor", true);
    const existingSuccessor = openPlanFixture(existingRoot, 740, "interrupted existing successor");
    const existingPredecessorPath = path.join(existingRoot, `.agentera/entities/plan/plan/${existingPredecessor.id}.yaml`);
    const existingSuccessorPath = path.join(existingRoot, `.agentera/entities/plan/plan/${existingSuccessor.id}.yaml`);
    const existingBefore = new Map([
      [existingPredecessorPath, fs.readFileSync(existingPredecessorPath, "utf8")],
      [existingSuccessorPath, fs.readFileSync(existingSuccessorPath, "utf8")],
    ]);
    const existingBinding = detectStateModeBinding(existingRoot);
    if (existingBinding.mode !== "entities") throw new Error("entity mode expected");
    const originalReplace = existingBinding.publicationContext.replaceExisting.bind(existingBinding.publicationContext);
    const originalAssert = existingBinding.publicationContext.assertValid.bind(existingBinding.publicationContext);
    let replaceCalls = 0;
    let interruptAfterSuccessor = false;
    vi.spyOn(existingBinding.publicationContext, "replaceExisting").mockImplementation((...args) => {
      const result = originalReplace(...args);
      replaceCalls += 1;
      if (replaceCalls === 2) interruptAfterSuccessor = true;
      return result;
    });
    vi.spyOn(existingBinding.publicationContext, "assertValid").mockImplementation(() => {
      if (interruptAfterSuccessor) {
        interruptAfterSuccessor = false;
        throw new Error("injected existing replacement interruption");
      }
      return originalAssert();
    });
    expect(() =>
      replacePlanEntities(
        request(existingRoot, "replace", {
          predecessor: existingPredecessor.id,
          successor: existingSuccessor.id,
        }),
        { publicationContext: existingBinding.publicationContext },
      ),
    ).toThrow(/injected existing replacement interruption/);
    existingBinding.publicationContext.close();
    for (const [file, bytes] of existingBefore) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(validateEntityState(existingRoot)).toMatchObject({ valid: true });

    vi.restoreAllMocks();
    const createRoot = project();
    const createPredecessor = create(createRoot, "interrupted created predecessor", true);
    const createPredecessorPath = path.join(createRoot, `.agentera/entities/plan/plan/${createPredecessor.id}.yaml`);
    const createTaskPath = path.join(createRoot, `.agentera/entities/plan/plan_task/${createPredecessor.tasks[0].id}.yaml`);
    const createBefore = new Map([
      [createPredecessorPath, fs.readFileSync(createPredecessorPath, "utf8")],
      [createTaskPath, fs.readFileSync(createTaskPath, "utf8")],
    ]);
    const createBinding = detectStateModeBinding(createRoot);
    if (createBinding.mode !== "entities") throw new Error("entity mode expected");
    const originalPublish = createBinding.publicationContext.publishImmutable.bind(createBinding.publicationContext);
    let publishCalls = 0;
    vi.spyOn(createBinding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      publishCalls += 1;
      if (publishCalls === 2) throw new Error("injected create replacement interruption");
      return originalPublish(target, bytes);
    });
    expect(() =>
      replacePlanEntities(request(createRoot, "replace", { predecessor: createPredecessor.id }, plan("interrupted created successor", true)), {
        publicationContext: createBinding.publicationContext,
        candidate: (() => {
          const ids = ["cccccccccc", "dddddddddd", "eeeeeeeeee"];
          return () => ids.shift()!;
        })(),
      }),
    ).toThrow(/injected create replacement interruption/);
    createBinding.publicationContext.close();
    for (const [file, bytes] of createBefore) expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(fs.existsSync(path.join(createRoot, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(createRoot, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
    expect(validateEntityState(createRoot)).toMatchObject({ valid: true });
  });

  it("recovers a real SIGKILL through the exact durable plan replacement journal", () => {
    const root = project();
    const predecessor = create(root, "hard interrupted predecessor", true);
    const input = planInput(root, "hard interrupted successor", true);
    const script = path.join(root, "kill-plan-replacement.mjs");
    fs.writeFileSync(
      script,
      `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, build, predecessor, input] = process.argv.slice(2);
const { main } = await import(pathToFileURL(path.join(build, "cli/dispatch/index.js")).href);
const rename = fs.renameSync.bind(fs);
fs.renameSync = (from, to) => {
  const result = rename(from, to);
  if (String(from).endsWith("/replacement.tmp") && String(to).endsWith("/" + predecessor + ".yaml")) process.kill(process.pid, "SIGKILL");
  return result;
};
const cwd = process.cwd();
process.chdir(root);
try { main(["node", "agentera", "state", "plan", "replace", "--predecessor", predecessor, "--input", input, "--format", "json"]); }
finally { process.chdir(cwd); }
`,
    );
    const killed = spawnSync(process.execPath, [script, root, sourceBuildOutputRoot(), predecessor.id, input], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...sourceSubprocessEnv(),
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: path.resolve(import.meta.dirname, "../../../.."),
      },
      encoding: "utf8",
    });
    expect(killed.status, killed.stderr || killed.stdout).toBeNull();
    expect(killed.signal).toBe("SIGKILL");
    expect(replacementJournals(root)).toHaveLength(1);
    const blocked = capture(root, ["state", "plan", "list", "--format", "json"]);
    expect(blocked.rc).toBe(1);
    expect(JSON.parse(blocked.out).error).toMatchObject({
      class: "unsupported_state",
      message: expect.stringContaining("pending durable recovery"),
    });
    for (const args of [
      ["state", "plan", "get", "--id", predecessor.id, "--format", "json"],
      ["prime", "--context", "plan", "--format", "json"],
      ["prime", "--context", "orchestrate", "--format", "json"],
      ["prime", "--context", "status", "--format", "json"],
      ["prime", "--dashboard", "--format", "json"],
    ]) {
      const read = capture(root, args);
      expect(read.rc).toBe(1);
      expect(JSON.parse(read.out).error).toMatchObject({
        class: "unsupported_state",
        message: expect.stringContaining("pending durable recovery"),
      });
    }
    const divergent = capture(root, ["state", "plan", "replace", "--predecessor", predecessor.id, "--input", planInput(root, "divergent interrupted successor", true), "--format", "json"]);
    expect(divergent.rc).toBe(2);
    expect(JSON.parse(divergent.out).error.message).toContain("requires the exact original successor input");
    expect(replacementJournals(root)).toHaveLength(1);
    const retry = capture(root, ["state", "plan", "replace", "--predecessor", predecessor.id, "--input", input, "--format", "json"]);
    expect(retry.rc, retry.err || retry.out).toBe(0);
    expect(JSON.parse(retry.out).operation).toMatchObject({ idempotent_replay: true });
    expect(replacementJournals(root)).toEqual([]);
    expect(validateEntityState(root)).toMatchObject({ valid: true });
  });

  it("derives matching zero- and one-predecessor lifecycle effects for preview and apply", () => {
    const zero = project();
    const zeroInput = planInput(zero, "zero predecessor");
    const zeroPreview = capture(zero, ["state", "plan", "create", "--input", zeroInput, "--dry-run", "--format", "json"]);
    expect(validateEntityState(zero)).toMatchObject({ valid: true, entityCount: 0 });
    const zeroApply = capture(zero, ["state", "plan", "create", "--input", zeroInput, "--format", "json"]);
    expect(zeroPreview.rc, zeroPreview.err || zeroPreview.out).toBe(0);
    expect(zeroApply.rc, zeroApply.err || zeroApply.out).toBe(0);
    expect(JSON.parse(zeroPreview.out).effects).toEqual(JSON.parse(zeroApply.out).effects);
    expect(JSON.parse(zeroApply.out).effects).toEqual({ lifecycle: "create", force: false });

    const replacement = project();
    const predecessor = create(replacement, "unfinished predecessor", true);
    const predecessorPlan = path.join(replacement, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
    const predecessorPlanBytes = fs.readFileSync(predecessorPlan, "utf8");
    const predecessorTask = path.join(replacement, `.agentera/entities/plan/plan_task/${predecessor.tasks[0].id}.yaml`);
    const predecessorTaskBytes = fs.readFileSync(predecessorTask, "utf8");
    const suppliedLineage = plan("caller supplied lineage") as Record<string, unknown>;
    suppliedLineage.previous_plan_archived = predecessor.id;
    const suppliedLineageInput = planInput(replacement, "caller supplied lineage", false, suppliedLineage);
    const rejectedLineage = capture(replacement, ["state", "plan", "create", "--force", "--input", suppliedLineageInput, "--format", "json"]);
    expect(rejectedLineage.rc).toBe(2);
    expect(JSON.parse(rejectedLineage.out).error.message).toContain("previous_plan_archived");
    const successorInput = planInput(replacement, "forced successor");
    const blocked = capture(replacement, ["state", "plan", "create", "--input", successorInput, "--dry-run", "--format", "json"]);
    expect(blocked.rc, blocked.err || blocked.out).toBe(2);
    expect(JSON.parse(blocked.out).error).toMatchObject({
      class: "conflict",
      message: expect.stringContaining(predecessor.id),
    });

    const preview = capture(replacement, ["state", "plan", "create", "--force", "--input", successorInput, "--dry-run", "--format", "json"]);
    expect(fs.readFileSync(predecessorPlan, "utf8")).toBe(predecessorPlanBytes);
    const applied = capture(replacement, ["state", "plan", "create", "--force", "--input", successorInput, "--format", "json"]);
    expect(preview.rc, preview.err || preview.out).toBe(0);
    expect(applied.rc, applied.err || applied.out).toBe(0);
    const previewJson = JSON.parse(preview.out);
    const appliedJson = JSON.parse(applied.out);
    expect(previewJson.effects).toEqual(appliedJson.effects);
    expect(appliedJson).toMatchObject({
      record: { previous_plan_archived: predecessor.id },
      effects: {
        lifecycle: "forced_replacement",
        archived_predecessor: {
          id: predecessor.id,
          from_status: "open",
          to_status: "archived",
          preserved: ["task_records", "task_evaluations", "task_completion"],
        },
        successor_lineage: { field: "previous_plan_archived", predecessor: predecessor.id },
      },
    });
    expect(fs.readFileSync(predecessorTask, "utf8")).toBe(predecessorTaskBytes);
    expect(JSON.parse(capture(replacement, ["state", "plan", "get", "--id", predecessor.id, "--format", "json"]).out).entry.record.header.status).toBe("archived");
    expect(validateEntityState(replacement)).toMatchObject({ valid: true });

    const forcedArchive = project();
    const unfinished = create(forcedArchive, "archive unfinished", true);
    const unfinishedPlan = path.join(forcedArchive, `.agentera/entities/plan/plan/${unfinished.id}.yaml`);
    const unfinishedPlanBytes = fs.readFileSync(unfinishedPlan, "utf8");
    const unfinishedTask = path.join(forcedArchive, `.agentera/entities/plan/plan_task/${unfinished.tasks[0].id}.yaml`);
    const unfinishedTaskBytes = fs.readFileSync(unfinishedTask, "utf8");
    const ordinaryArchive = capture(forcedArchive, ["state", "plan", "archive", "--dry-run", "--format", "json"]);
    expect(ordinaryArchive.rc).toBe(2);
    expect(JSON.parse(ordinaryArchive.out).error).toMatchObject({
      class: "conflict",
      message: expect.stringContaining("without --force"),
    });
    const archivePreview = capture(forcedArchive, ["state", "plan", "archive", "--force", "--dry-run", "--format", "json"]);
    expect(fs.readFileSync(unfinishedPlan, "utf8")).toBe(unfinishedPlanBytes);
    const archiveApply = capture(forcedArchive, ["state", "plan", "archive", "--force", "--format", "json"]);
    expect(archivePreview.rc, archivePreview.err || archivePreview.out).toBe(0);
    expect(archiveApply.rc, archiveApply.err || archiveApply.out).toBe(0);
    expect(JSON.parse(archivePreview.out).effects).toEqual(JSON.parse(archiveApply.out).effects);
    expect(JSON.parse(archiveApply.out).effects).toMatchObject({
      lifecycle: "forced_archive",
      archived_plan: { id: unfinished.id, from_status: "open", to_status: "archived" },
    });
    expect(fs.readFileSync(unfinishedTask, "utf8")).toBe(unfinishedTaskBytes);
  });

  it("reports matching zero- and multiple-open conflicts without blocking explicit historical archive", () => {
    const zero = project();
    const zeroPreview = capture(zero, ["state", "plan", "archive", "--force", "--dry-run", "--format", "json"]);
    const zeroApply = capture(zero, ["state", "plan", "archive", "--force", "--format", "json"]);
    expect(zeroPreview.rc).toBe(1);
    expect(zeroApply.rc).toBe(1);
    expect(JSON.parse(zeroPreview.out).error).toEqual(JSON.parse(zeroApply.out).error);

    const root = project();
    const historical = complete(root, "historical");
    const left = openPlanFixture(root, 680, "left competing plan");
    const right = openPlanFixture(root, 690, "right competing plan");
    const successorInput = planInput(root, "ambiguous successor");
    for (const args of [
      ["state", "plan", "create", "--force", "--input", successorInput, "--dry-run", "--format", "json"],
      ["state", "plan", "archive", "--force", "--dry-run", "--format", "json"],
    ]) {
      const preview = capture(root, args);
      const apply = capture(
        root,
        args.filter((value) => value !== "--dry-run"),
      );
      const expectedExit = args[2] === "create" ? 2 : 1;
      expect(preview.rc, preview.err || preview.out).toBe(expectedExit);
      expect(apply.rc, apply.err || apply.out).toBe(expectedExit);
      expect(JSON.parse(preview.out).error).toEqual(JSON.parse(apply.out).error);
      expect(JSON.parse(preview.out).error.message).toMatch(new RegExp(`${left.id}.*${right.id}|${right.id}.*${left.id}`));
    }

    const historicalArchive = capture(root, ["state", "plan", "archive", "--plan", historical.id, "--format", "json"]);
    expect(historicalArchive.rc, historicalArchive.err || historicalArchive.out).toBe(0);
    expect(JSON.parse(historicalArchive.out)).toMatchObject({
      record: { header: { status: "archived" } },
      operation: { idempotent_replay: false },
    });
  });

  it("bounds forced lifecycle conflicts for more than one hundred open plans", () => {
    const root = project();
    const candidates = Array.from({ length: 101 }, (_, index) => openPlanFixture(root, 1000 + index * 2, `competing plan ${index}`));
    const ids = candidates.map(({ id }) => id).sort();
    const successorInput = planInput(root, "bounded ambiguous successor");
    for (const { args, exit, diagnosticField } of [
      {
        args: ["state", "plan", "create", "--force", "--input", successorInput, "--dry-run", "--format", "json"],
        exit: 2,
        diagnosticField: "diagnosis",
      },
      {
        args: ["state", "plan", "archive", "--force", "--dry-run", "--format", "json"],
        exit: 1,
        diagnosticField: "details",
      },
    ]) {
      const preview = capture(root, args);
      const apply = capture(
        root,
        args.filter((value) => value !== "--dry-run"),
      );
      expect(preview.rc, preview.err || preview.out).toBe(exit);
      expect(apply.rc, apply.err || apply.out).toBe(exit);
      const previewError = JSON.parse(preview.out).error;
      expect(previewError).toEqual(JSON.parse(apply.out).error);
      expect(previewError[diagnosticField]).toEqual({
        open_plan_candidates: { total: 101, sample_ids: ids.slice(0, 100), omitted_count: 1 },
      });
      expect(previewError.message).toContain(ids[0]);
      expect(previewError.message).not.toContain(ids[100]);
      expect(previewError.message).toContain("total=101");
      expect(previewError.message).toContain("omitted=1");
    }

    const afterFailures = capture(root, ["state", "plan", "list", "--status", "open", "--limit", "100", "--format", "json"]);
    expect(afterFailures.rc, afterFailures.err || afterFailures.out).toBe(0);
    expect(JSON.parse(afterFailures.out)).toMatchObject({
      counts: { total: 101, returned: 100, remaining: 1 },
      omitted: true,
      omitted_count: 1,
    });

    const explicitPreview = capture(root, ["state", "plan", "archive", "--plan", ids[0], "--force", "--dry-run", "--format", "json"]);
    const explicitApply = capture(root, ["state", "plan", "archive", "--plan", ids[0], "--force", "--format", "json"]);
    expect(explicitPreview.rc, explicitPreview.err || explicitPreview.out).toBe(0);
    expect(explicitApply.rc, explicitApply.err || explicitApply.out).toBe(0);
    expect(JSON.parse(explicitPreview.out).effects).toEqual(JSON.parse(explicitApply.out).effects);
    expect(JSON.parse(explicitApply.out)).toMatchObject({
      record: { header: { status: "archived" } },
      effects: { lifecycle: "forced_archive", archived_plan: { id: ids[0] } },
    });
  });

  it("keeps writer-owned plan lineage one-to-one in both directions", () => {
    const root = project();
    const predecessor = create(root, "lineage predecessor");
    const successor = create(root, "lineage successor", false, true);
    expect(successor.record.previous_plan_archived).toBe(predecessor.id);
    const duplicate = openPlanFixture(root, 700, "duplicate lineage successor");
    const duplicatePath = path.join(root, `.agentera/entities/plan/plan/${duplicate.id}.yaml`);
    const duplicateEntity = loadYamlMapping(fs.readFileSync(duplicatePath, "utf8"));
    (duplicateEntity.record as Record<string, unknown>).previous_plan_archived = predecessor.id;
    fs.writeFileSync(duplicatePath, dumpYamlMapping(duplicateEntity));
    expect(validateEntityState(root)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          relation: "previous_plan_archived",
          message: expect.stringContaining("multiple successor plan records"),
        }),
      ]),
    });
  });

  it("requires structured task records and rejects retired, owned, and non-bare input before effects", () => {
    const root = project();
    const created = create(root, "structured task input");
    const taskId = created.tasks[0].id;
    const before = entityNames(root);
    const retired = capture(root, ["state", "plan", "append", "--plan", created.id, "--name", "retired", "--format", "json"]);
    expect(retired.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
    const incomplete = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Incomplete", depends_on: [] }), "--format", "json"]);
    expect(incomplete.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
    const owned = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Owned", plan: created.id, depends_on: [], acceptance: [] }), "--format", "json"]);
    expect(owned.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
    const malformedDependency = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Bad dependency", depends_on: ["plan:abcdefghij"], acceptance: [] }), "--format", "json"]);
    expect(malformedDependency.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
    const invalidUpdate = updateTask(root, taskId, { status: "complete" }, created.id);
    expect(invalidUpdate.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
    const compositeSelector = capture(root, ["state", "plan", "update", "--id", "plan:abcdefghij", "--plan", created.id, "--input", taskInput(root, { name: "No" }), "--format", "json"]);
    expect(compositeSelector.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
    const planLifecycleTaskSelector = capture(root, ["state", "plan", "set-plan-status", "--id", created.id, "--status", "complete", "--format", "json"]);
    expect(planLifecycleTaskSelector.rc).toBe(2);
    expect(entityNames(root)).toEqual(before);
  });

  it("converges identical append retries under the writer lock while preserving divergence and dry-run semantics", async () => {
    const root = project();
    const created = create(root, "append replay");
    const payload = {
      name: "Retryable task",
      depends_on: [created.tasks[0].id],
      acceptance: ["GIVEN one logical input WHEN retried THEN one entity remains"],
    };
    const first = appendTask(root, created.id, payload);
    const retry = appendTask(root, created.id, payload);
    expect(retry.id).toBe(first.id);
    expect(first.operation.idempotent_replay).toBe(false);
    expect(retry.operation.idempotent_replay).toBe(true);
    const beforeDry = JSON.parse(capture(root, ["state", "plan", "tasks", "list", created.id, "--format", "json"]).out).counts.total;
    const dryBefore = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { name: "Dry-only", depends_on: [], acceptance: [] }), "--dry-run", "--format", "json"]);
    const afterDry = JSON.parse(capture(root, ["state", "plan", "tasks", "list", created.id, "--format", "json"]).out).counts.total;
    expect(dryBefore.rc).toBe(0);
    expect(JSON.parse(dryBefore.out).operation).toMatchObject({
      dry_run: true,
      idempotent_replay: false,
    });
    expect(afterDry).toBe(beforeDry);
    const dryAfter = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, payload), "--dry-run", "--format", "json"]);
    expect(dryAfter.rc).toBe(0);
    expect(JSON.parse(dryAfter.out).operation).toMatchObject({
      dry_run: true,
      idempotent_replay: true,
    });
    expect(JSON.parse(dryAfter.out).id).toBe(first.id);
    const divergent = capture(root, ["state", "plan", "append", "--plan", created.id, "--input", taskInput(root, { ...payload, acceptance: ["different"] }), "--format", "json"]);
    expect(divergent.rc).not.toBe(0);
    expect(JSON.parse(divergent.out).error.class).toBe("conflict");
    const distinct = appendTask(root, created.id, { ...payload, name: "Distinct task" });
    expect(distinct.id).not.toBe(first.id);

    const concurrentPlan = create(root, "concurrent append replay", false, true);
    const concurrentInput = taskInput(root, {
      name: "Concurrent task",
      depends_on: [concurrentPlan.tasks[0].id],
      acceptance: ["GIVEN two processes WHEN appending identical input THEN one task is published"],
    });
    const receipts = await concurrentAppend(root, concurrentPlan.id, concurrentInput);
    const parsed = receipts.map(({ output }) => JSON.parse(output));
    expect(new Set(parsed.map((value) => value.id)).size).toBe(1);
    expect(parsed.map((value) => value.operation.idempotent_replay).sort()).toEqual([false, true]);
    expect(JSON.parse(capture(root, ["state", "plan", "tasks", "list", concurrentPlan.id, "--format", "json"]).out).counts.total).toBe(2);
  });

  it("supersedes a blocked task only with completed same-plan replacements and preserves evaluation evidence", () => {
    const root = project();
    const created = create(root, "supersession");
    const [blocked] = created.tasks.map((task: any) => task.id);
    const append = (name: string) => appendTask(root, created.id, { name, depends_on: [], acceptance: [] }).id as string;
    const firstReplacement = append("First replacement");
    const secondReplacement = append("Second replacement");
    const evaluate = (attempt: string, evidence: string) => capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", blocked, "--attempt-id", attempt, "--verdict", "fail", "--provenance", "audit", "--failure-evidence", evidence, "--format", "json"]);
    expect(evaluate("audit-1", "failure one").rc).toBe(0);
    expect(evaluate("audit-2", "failure two").rc).toBe(0);
    for (const [index, id] of [firstReplacement, secondReplacement].entries()) {
      expect(capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", id, "--attempt-id", `replacement-audit-${index + 1}`, "--verdict", "pass", "--provenance", "audit", "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", id, "--status", "complete", "--format", "json"]).rc).toBe(0);
    }
    const taskPath = path.join(root, `.agentera/entities/plan/plan_task/${blocked}.yaml`);
    const before = loadYamlMapping(fs.readFileSync(taskPath, "utf8")).record as Record<string, unknown>;
    const superseded = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, "--by", secondReplacement, "--by", firstReplacement, "--reason", "Replacement tasks cover the blocked work.", "--format", "json"]);
    expect(superseded.rc, superseded.err || superseded.out).toBe(0);
    expect(JSON.parse(superseded.out).record).toMatchObject({
      status: "superseded",
      superseded_by: [firstReplacement, secondReplacement].sort(),
      superseded_reason: "Replacement tasks cover the blocked work.",
      evaluation: before.evaluation,
    });
    const replacementPath = path.join(root, `.agentera/entities/plan/plan_task/${firstReplacement}.yaml`);
    const replacementBytes = fs.readFileSync(replacementPath, "utf8");
    const reopening = capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", firstReplacement, "--status", "pending", "--format", "json"]);
    expect(reopening.rc).not.toBe(0);
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacementBytes);
    const written = fs.readFileSync(taskPath, "utf8");
    const replay = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, "--by", firstReplacement, "--by", secondReplacement, "--reason", "Replacement tasks cover the blocked work.", "--format", "json"]);
    expect(replay.rc, replay.err || replay.out).toBe(0);
    expect(JSON.parse(replay.out).operation.idempotent_replay).toBe(true);
    expect(fs.readFileSync(taskPath, "utf8")).toBe(written);
    expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "superseded", "--format", "json"]).rc).toBe(2);
    expect(capture(root, ["state", "plan", "set-plan-status", "--plan", created.id, "--status", "complete", "--format", "json"]).rc).toBe(0);
    expect(validateEntityState(root).valid).toBe(true);
    const invalid = loadYamlMapping(fs.readFileSync(taskPath, "utf8"));
    (invalid.record as Record<string, unknown>).superseded_by = [blocked];
    fs.writeFileSync(taskPath, dumpYamlMapping(invalid));
    expect(validateEntityState(root)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          relation: "superseded_by",
          message: expect.stringContaining("cannot name itself"),
        }),
      ]),
    });
  });

  it("rejects invalid supersession targets without changing the blocked task", () => {
    const root = project();
    const created = create(root, "supersession rejection");
    const blocked = created.tasks[0].id;
    const pending = appendTask(root, created.id, {
      name: "Pending replacement",
      depends_on: [],
      acceptance: [],
    }).id;
    const otherPlan = openPlanFixture(root, 620, "other plan");
    const crossPlan = otherPlan.tasks[0].id;
    expect(capture(root, ["state", "plan", "set-status", "--plan", otherPlan.id, "--id", crossPlan, "--status", "complete", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "blocked", "--format", "json"]).rc).toBe(0);
    const taskPath = path.join(root, `.agentera/entities/plan/plan_task/${blocked}.yaml`);
    const before = fs.readFileSync(taskPath, "utf8");
    for (const args of [
      ["--by", blocked],
      ["--by", pending],
      ["--by", pending, "--by", pending],
      ["--by", "INVALID"],
      ["--by", "zzzzzzzzzz"],
      ["--by", crossPlan],
    ]) {
      const result = capture(root, ["state", "plan", "supersede", "--plan", created.id, "--id", blocked, ...args, "--reason", "Replacement work.", "--format", "json"]);
      expect(result.rc).not.toBe(0);
      expect(fs.readFileSync(taskPath, "utf8")).toBe(before);
    }
  });

  it("rejects complete replacements without a latest persisted PASS and preserves the blocked task", () => {
    for (const verdict of ["unevaluated", "fail"] as const) {
      const root = project();
      const created = create(root, `replacement ${verdict}`);
      const blocked = created.tasks[0].id;
      const replacement = appendTask(root, created.id, {
        name: `${verdict} replacement`,
        depends_on: [],
        acceptance: [],
      }).id;
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", blocked, "--status", "blocked", "--format", "json"]).rc).toBe(0);
      if (verdict === "fail") expect(capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", replacement, "--attempt-id", "replacement-audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "still incomplete", "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-status", "--plan", created.id, "--id", replacement, "--status", "complete", "--format", "json"]).rc).toBe(0);
      const taskPath = path.join(root, `.agentera/entities/plan/plan_task/${blocked}.yaml`);
      const before = fs.readFileSync(taskPath, "utf8");

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
    const root = project();
    const { planId, replacement } = persistedReplacement(root, "historical replacement reuse");
    const blocked = appendTask(root, planId, {
      name: "New blocked predecessor",
      depends_on: [],
      acceptance: [],
    }).id;
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
    expect(JSON.parse(repaired.out).record).toMatchObject({
      status: "complete",
      evaluation: { last_verdict: "pass" },
    });
    expect(supersede().rc).toBe(0);
  });

  it("describes context-sensitive supersession recovery", () => {
    const guidance = buildExplain("plan", project(), "supersede").guidance as string[];
    expect(guidance).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not already referenced.*reopen.*record PASS.*complete.*retry/i),
        expect.stringMatching(/referenced.*unevaluated complete.*first PASS.*remains complete/i),
        expect.stringMatching(/existing non-PASS evaluation.*first-PASS recovery is unavailable.*another complete latest-PASS replacement/i),
      ]),
    );
  });

  it("serializes supersession against replacement reopening and plan archival", async () => {
    for (const action of ["reopen", "archive"] as const) {
      const root = project();
      const created = create(root, `supersession ${action}`);
      const blocked = created.tasks[0].id;
      const replacement = appendTask(root, created.id, {
        name: "Completed replacement",
        depends_on: [],
        acceptance: [],
      }).id;
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
    const root = project();
    const created = create(root, "evaluation");
    const taskId = created.tasks[0].id;
    const evaluate = (...args: string[]) => capture(root, ["state", "plan", "record-evaluation", "--plan", created.id, "--id", taskId, ...args, "--format", "json"]);
    const target = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`);
    const initial = fs.readFileSync(target, "utf8");
    for (const invalid of [
      ["--attempt-id", "", "--verdict", "pass", "--provenance", "audit"],
      ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", ""],
      ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit"],
      ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "audit", "--failure-evidence", "not allowed"],
    ]) {
      const result = evaluate(...invalid);
      expect(result.rc).not.toBe(0);
      expect(fs.readFileSync(target, "utf8")).toBe(initial);
    }
    const valid = ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "test:1"];
    expect(evaluate(...valid).rc).toBe(0);
    const once = fs.readFileSync(target, "utf8");
    expect(JSON.parse(evaluate(...valid).out).operation.idempotent_replay).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(once);
    for (const divergent of [
      ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "audit"],
      ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "other", "--failure-evidence", "test:1"],
      ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "test:2"],
    ]) {
      const result = evaluate(...divergent);
      expect(result.rc).not.toBe(0);
      expect(JSON.parse(result.out).error.class).toBe("conflict");
      expect(fs.readFileSync(target, "utf8")).toBe(once);
    }
  });

  it("records one recovery PASS for an unevaluated complete replacement without changing its predecessor", () => {
    const root = project();
    const { planId, predecessor, replacement } = persistedReplacement(root, "replacement evaluation recovery");
    const predecessorPath = path.join(root, `.agentera/entities/plan/plan_task/${predecessor}.yaml`);
    const replacementPath = path.join(root, `.agentera/entities/plan/plan_task/${replacement}.yaml`);
    const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
    const evaluate = (...args: string[]) => capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", replacement, ...args, "--format", "json"]);
    const attempt = ["--attempt-id", "replacement-audit-1", "--verdict", "pass", "--provenance", "independent audit"];

    expect(validateEntityState(root).valid).toBe(true);
    const historicalRead = capture(root, ["state", "plan", "get", "--id", planId, "--format", "json"]);
    expect(historicalRead.rc, historicalRead.err || historicalRead.out).toBe(0);
    expect(JSON.parse(historicalRead.out).tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: replacement,
          record: expect.objectContaining({ status: "complete" }),
        }),
      ]),
    );
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
    expect(loadYamlMapping(predecessorBytes).record).toMatchObject({
      status: "superseded",
      superseded_by: [replacement],
    });

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
      expect(rejected.rc).not.toBe(0);
      expect(JSON.parse(rejected.out).error.class).toBe("conflict");
      expect(fs.readFileSync(replacementPath, "utf8")).toBe(replacementBytes);
    }
    expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
    expect(validateEntityState(root).valid).toBe(true);

    const closeout = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]);
    expect(closeout.rc, closeout.err || closeout.out).toBe(0);
    expect(JSON.parse(closeout.out).operation.idempotent_replay).toBe(false);
    const completedPlan = path.join(root, `.agentera/entities/plan/plan/${planId}.yaml`);
    const completedBytes = fs.readFileSync(completedPlan, "utf8");
    const closeoutReplay = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]);
    expect(closeoutReplay.rc, closeoutReplay.err || closeoutReplay.out).toBe(0);
    expect(JSON.parse(closeoutReplay.out).operation.idempotent_replay).toBe(true);
    expect(fs.readFileSync(completedPlan, "utf8")).toBe(completedBytes);
  });

  it("rejects replacement recovery for FAIL, unrelated terminal tasks, terminal predecessors, and non-open plans", () => {
    const assertRejected = (root: string, planId: string, taskId: string, args: string[]) => {
      const target = path.join(root, `.agentera/entities/plan/plan_task/${taskId}.yaml`);
      const before = fs.readFileSync(target, "utf8");
      const result = capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", taskId, ...args, "--format", "json"]);
      expect(result.rc).not.toBe(0);
      expect(JSON.parse(result.out).error.class).toBe("conflict");
      expect(fs.readFileSync(target, "utf8")).toBe(before);
    };
    const pass = ["--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "audit"];

    const failRoot = project();
    const failed = persistedReplacement(failRoot, "reject recovery fail");
    assertRejected(failRoot, failed.planId, failed.replacement, ["--attempt-id", "audit-1", "--verdict", "fail", "--provenance", "audit", "--failure-evidence", "still broken"]);
    assertRejected(failRoot, failed.planId, failed.predecessor, pass);

    const unreferencedRoot = project();
    const unreferenced = create(unreferencedRoot, "unreferenced complete");
    const unreferencedTask = unreferenced.tasks[0].id;
    expect(capture(unreferencedRoot, ["state", "plan", "set-status", "--plan", unreferenced.id, "--id", unreferencedTask, "--status", "complete", "--format", "json"]).rc).toBe(0);
    assertRejected(unreferencedRoot, unreferenced.id, unreferencedTask, pass);

    const blockedRoot = project();
    const blocked = create(blockedRoot, "blocked terminal");
    const blockedTask = blocked.tasks[0].id;
    expect(capture(blockedRoot, ["state", "plan", "set-status", "--plan", blocked.id, "--id", blockedTask, "--status", "blocked", "--format", "json"]).rc).toBe(0);
    assertRejected(blockedRoot, blocked.id, blockedTask, pass);

    for (const lifecycle of ["complete", "archived"] as const) {
      const root = project();
      const persisted = persistedReplacement(root, `${lifecycle} plan recovery`);
      expect(capture(root, ["state", "plan", "record-evaluation", "--plan", persisted.planId, "--id", persisted.replacement, ...pass, "--format", "json"]).rc).toBe(0);
      expect(capture(root, ["state", "plan", "set-plan-status", "--plan", persisted.planId, "--status", "complete", "--format", "json"]).rc).toBe(0);
      if (lifecycle === "archived") expect(capture(root, ["state", "plan", "archive", "--plan", persisted.planId, "--format", "json"]).rc).toBe(0);
      assertRejected(root, persisted.planId, persisted.replacement, ["--attempt-id", "audit-2", "--verdict", "pass", "--provenance", "audit"]);
    }
  });

  it("infers one open plan and reports zero or multiple open plans actionably", () => {
    const root = project();
    const first = create(root, "first");
    expect(appendTask(root, undefined, { name: "Inferred", depends_on: [], acceptance: [] }).id).toMatch(/^[a-z]{10}$/);
    const second = openPlanFixture(root, 640, "second");
    const ambiguous = capture(root, ["state", "plan", "append", "--input", taskInput(root, { name: "No owner", depends_on: [], acceptance: [] }), "--format", "json"]);
    expect(ambiguous.rc).toBe(1);
    expect(JSON.parse(ambiguous.out).error.message).toMatch(new RegExp(`${first.id}.*${second.id}|${second.id}.*${first.id}`));
    expect(appendTask(root, second.id, { name: "Explicit", depends_on: [], acceptance: [] }).id).toMatch(/^[a-z]{10}$/);
    const empty = project();
    const missing = capture(empty, ["state", "plan", "append", "--input", taskInput(empty, { name: "Missing", depends_on: [], acceptance: [] }), "--format", "json"]);
    expect(missing.rc).toBe(1);
    expect(JSON.parse(missing.out).error.message).toMatch(/no open plan/i);
  });

  it("keeps one active plan unambiguous beside more than twenty archived plans and exposes archived exact/filter reads", () => {
    const root = project();
    const active = create(root, "active");
    const archived: any[] = [];
    for (let index = 0; index < 21; index += 1) {
      archived.push(archivedPlanFixture(root, index));
    }

    const current = capture(root, ["state", "plan", "--format", "json"]);
    expect(current.rc).toBe(2);
    expect(JSON.parse(current.out).error).toMatchObject({
      class: "invalid_request",
      recovery: expect.stringContaining("state plan list"),
    });
    const filtered = capture(root, ["state", "plan", "list", "--status", "archived", "--limit", "100", "--format", "json"]);
    expect(filtered.rc, filtered.err || filtered.out).toBe(0);
    expect(JSON.parse(filtered.out)).toMatchObject({
      counts: { total: 21, returned: 21 },
      filters: { status: ["archived"] },
    });
    const filteredPage = capture(root, ["state", "plan", "list", "--status", "archived", "--ids-only", "--limit", "1", "--format", "json"]);
    expect(JSON.parse(filteredPage.out).retrieval.continue).toMatch(/^agentera state plan list --status 'archived' --ids-only --limit 1 --cursor \S+$/);
    const exact = capture(root, ["state", "plan", "get", "--id", archived[0].id, "--format", "json"]);
    expect(exact.rc, exact.err || exact.out).toBe(0);
    expect(JSON.parse(exact.out).entry.record.header.status).toBe("archived");
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 44 });

    const archivedInput = plan("ordinary archived create");
    (archivedInput.header as Record<string, unknown>).status = "archived";
    const input = path.join(root, "archived.yaml");
    fs.writeFileSync(input, dumpYamlMapping(archivedInput));
    expect(capture(root, ["state", "plan", "create", "--input", input, "--format", "json"]).rc).not.toBe(0);
    expect(capture(root, ["state", "plan", "set-plan-status", "--plan", active.id, "--status", "archived", "--format", "json"]).rc).not.toBe(0);
  });

  it("rejects missing, cross-plan, self, and cyclic dependencies without changing the task", () => {
    const root = project();
    const left = create(root, "left", true);
    const right = openPlanFixture(root, 660, "right");
    const leftFirst = left.tasks[0].id;
    const leftSecond = left.tasks[1].id;
    for (const dependency of ["zzzzzzzzzz", right.tasks[0].id, leftSecond]) {
      const result = updateTask(root, leftFirst, { depends_on: [dependency] }, left.id);
      expect(result.rc).not.toBe(0);
    }
    expect(validateEntityState(root).valid).toBe(true);
  });

  it("rolls back every visible entity when plan create publication fails", () => {
    const root = project();
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
    let calls = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      calls += 1;
      if (calls === 2) throw new Error("injected create failure");
      return original(target, bytes);
    });
    expect(() =>
      createPlanEntities(request(root, "create", {}, plan("rollback", true)), {
        publicationContext: binding.publicationContext,
        candidate: (() => {
          const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
          return () => ids.shift()!;
        })(),
      }),
    ).toThrow(/injected create failure/);
    binding.publicationContext.close();
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 0 });
  });

  it("restores a completed predecessor byte-for-byte after each replacement publication boundary, then archives it once on retry", () => {
    for (const failAt of [1, 2]) {
      const root = project();
      const predecessor = complete(root, `predecessor-${failAt}`);
      const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
      const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
      const binding = detectStateModeBinding(root);
      if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
      let calls = 0;
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        calls += 1;
        if (calls === failAt) throw new Error(`injected replacement publication failure ${failAt}`);
        return original(target, bytes);
      });
      const failedIds = ["cccccccccc", "dddddddddd"];
      expect(() =>
        createPlanEntities(request(root, "create", {}, plan("replacement")), {
          publicationContext: binding.publicationContext,
          candidate: () => failedIds.shift()!,
        }),
      ).toThrow(/replacement publication failure/);
      expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
      vi.mocked(binding.publicationContext.publishImmutable).mockImplementation(original);
      const ids = ["cccccccccc", "dddddddddd"];
      const replacement = createPlanEntities(request(root, "create", {}, plan("replacement")), {
        publicationContext: binding.publicationContext,
        candidate: () => ids.shift()!,
      });
      binding.publicationContext.close();
      vi.restoreAllMocks();
      expect(replacement.id).toBe("cccccccccc");
      expect(loadYamlMapping(fs.readFileSync(predecessorPath, "utf8")).record).toMatchObject({
        header: { status: "archived" },
      });
      expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
    }
  });

  it("restores an unfinished forced predecessor byte-for-byte after successor publication failure", () => {
    for (const failAt of [1, 2]) {
      const root = project();
      const predecessor = create(root, `unfinished predecessor-${failAt}`, true);
      const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
      const predecessorTaskPath = path.join(root, `.agentera/entities/plan/plan_task/${predecessor.tasks[0].id}.yaml`);
      const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
      const predecessorTaskBytes = fs.readFileSync(predecessorTaskPath, "utf8");
      const binding = detectStateModeBinding(root);
      if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
      let calls = 0;
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        calls += 1;
        if (calls === failAt) throw new Error(`injected forced replacement publication failure ${failAt}`);
        return original(target, bytes);
      });
      const ids = ["cccccccccc", "dddddddddd"];
      expect(() =>
        createPlanEntities(request(root, "create", {}, plan("forced replacement"), true), {
          publicationContext: binding.publicationContext,
          candidate: () => ids.shift()!,
        }),
      ).toThrow(/forced replacement publication failure/);
      binding.publicationContext.close();
      vi.restoreAllMocks();
      expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
      expect(fs.readFileSync(predecessorTaskPath, "utf8")).toBe(predecessorTaskBytes);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
      const selected = capture(root, ["state", "plan", "tasks", "list", "--format", "json"]);
      expect(selected.rc, selected.err || selected.out).toBe(0);
      expect(JSON.parse(selected.out).filters).toEqual({ plan: predecessor.id });
    }
  });

  it("restores unfinished forced selection after final successor validation failure", () => {
    const root = project();
    const predecessor = create(root, "unfinished validation predecessor", true);
    const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
    const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
    let calls = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      const result = original(target, bytes);
      calls += 1;
      if (calls === 2) fs.writeFileSync(path.join(root, ".agentera/entities/plan/plan_task/eeeeeeeeee.yaml"), "invalid: residue\n");
      return result;
    });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() =>
      createPlanEntities(request(root, "create", {}, plan("forced validation replacement"), true), {
        publicationContext: binding.publicationContext,
        candidate: () => ids.shift()!,
      }),
    ).toThrow(/failed state validation/);
    binding.publicationContext.close();
    vi.restoreAllMocks();
    expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
    expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
    fs.rmSync(path.join(root, ".agentera/entities/plan/plan_task/eeeeeeeeee.yaml"));
    const selected = capture(root, ["state", "plan", "tasks", "list", "--format", "json"]);
    expect(selected.rc, selected.err || selected.out).toBe(0);
    expect(JSON.parse(selected.out).filters).toEqual({ plan: predecessor.id });
    expect(validateEntityState(root)).toMatchObject({ valid: true });
  });

  it("restores the exact predecessor and removes the whole replacement graph after post-publication validation or identity failure", () => {
    for (const boundary of ["validation", "identity"] as const) {
      const root = project();
      const predecessor = complete(root, `predecessor-${boundary}`);
      const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
      const predecessorBytes = fs.readFileSync(predecessorPath, "utf8");
      const binding = detectStateModeBinding(root);
      if (binding.mode !== "entities") throw new Error("entity mode expected");
      const originalPublish = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
      const originalReplace = binding.publicationContext.replaceExisting.bind(binding.publicationContext);
      const originalExact = binding.publicationContext.restoreExact.bind(binding.publicationContext);
      const originalAssert = binding.publicationContext.assertValid.bind(binding.publicationContext);
      let publications = 0;
      let replacements = 0;
      vi.spyOn(binding.publicationContext, "replaceExisting").mockImplementation((...args) => {
        replacements += 1;
        return originalReplace(...args);
      });
      vi.spyOn(binding.publicationContext, "restoreExact").mockImplementation((...args) => {
        replacements += 1;
        return originalExact(...args);
      });
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        const result = originalPublish(target, bytes);
        publications += 1;
        if (boundary === "validation" && publications === 2) fs.writeFileSync(path.join(root, ".agentera/entities/plan/plan_task/eeeeeeeeee.yaml"), "invalid: residue\n");
        return result;
      });
      if (boundary === "identity")
        vi.spyOn(binding.publicationContext, "assertValid").mockImplementation(() => {
          if (publications === 2) throw new Error("injected replacement identity failure");
          return originalAssert();
        });
      const ids = ["cccccccccc", "dddddddddd"];
      expect(() =>
        createPlanEntities(request(root, "create", {}, plan(`replacement-${boundary}`)), {
          publicationContext: binding.publicationContext,
          candidate: () => ids.shift()!,
        }),
      ).toThrow(boundary === "validation" ? /failed state validation/ : /identity failure/);
      binding.publicationContext.close();
      vi.restoreAllMocks();
      expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorBytes);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/dddddddddd.yaml"))).toBe(false);
      expect(replacements).toBe(2);
      if (boundary === "validation") fs.rmSync(path.join(root, ".agentera/entities/plan/plan_task/eeeeeeeeee.yaml"));
      expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
    }
  });

  it("fails closed with both errors when predecessor restoration ownership changes", () => {
    const root = project();
    const predecessor = complete(root, "owned predecessor");
    const predecessorPath = path.join(root, `.agentera/entities/plan/plan/${predecessor.id}.yaml`);
    const competing = "competing predecessor bytes\n";
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation(() => {
      fs.writeFileSync(predecessorPath, competing);
      throw new Error("primary replacement failure");
    });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() =>
      createPlanEntities(request(root, "create", {}, plan("replacement")), {
        publicationContext: binding.publicationContext,
        candidate: () => ids.shift()!,
      }),
    ).toThrow(/primary replacement failure.*recovery.*ownership|recovery.*ownership.*primary replacement failure/i);
    binding.publicationContext.close();
    expect(fs.readFileSync(predecessorPath, "utf8")).toBe(competing);
  });

  it("retains competing replacement residue and reports primary plus cleanup failure", () => {
    const root = project();
    complete(root, "cleanup predecessor");
    const replacementPath = path.join(root, ".agentera/entities/plan/plan/cccccccccc.yaml");
    const competing = "competing replacement bytes\n";
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    const originalPublish = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
    let publications = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      const result = originalPublish(target, bytes);
      publications += 1;
      if (publications === 2) fs.writeFileSync(replacementPath, competing);
      return result;
    });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() =>
      createPlanEntities(request(root, "create", {}, plan("cleanup replacement")), {
        publicationContext: binding.publicationContext,
        candidate: () => ids.shift()!,
      }),
    ).toThrow(/failed state validation.*recovery.*cleanup|recovery.*cleanup.*failed state validation/i);
    binding.publicationContext.close();
    expect(fs.readFileSync(replacementPath, "utf8")).toBe(competing);
  });

  it("creates a valid plan graph when logical validation reaches migrated summary sources through the real root", () => {
    const root = project();
    writeMigratedDecisionAndProgressSummaries(root);
    const created = create(root, "migrated summaries");
    expect(created).toMatchObject({
      id: expect.stringMatching(/^[a-z]{10}$/),
      tasks: [{ id: expect.stringMatching(/^[a-z]{10}$/) }],
    });
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
  });

  it("rolls back a plan graph when a migrated summary source no longer matches after publication", () => {
    const root = project();
    const { progressSource } = writeMigratedDecisionAndProgressSummaries(root);
    const preserved = unrelated(root);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
    let calls = 0;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      const result = original(target, bytes);
      calls += 1;
      if (calls === 2) fs.writeFileSync(progressSource, "archive: []\n");
      return result;
    });
    const ids = ["cccccccccc", "dddddddddd"];
    expect(() =>
      createPlanEntities(request(root, "create", {}, plan("changed provenance")), {
        publicationContext: binding.publicationContext,
        candidate: () => ids.shift()!,
      }),
    ).toThrow(/migration_provenance|bind|unsafe/i);
    binding.publicationContext.close();
    expect(calls).toBe(2);
    expect(fs.existsSync(path.join(root, ".agentera/entities/plan"))).toBe(false);
    expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
  });

  it("rolls back the complete create graph after every successful file when the marker changes", () => {
    for (const invalidation of ["remove", "replace"] as const)
      for (const after of [1, 2, 3]) {
        const container = project(false);
        const root = path.join(container, "project");
        fs.mkdirSync(root);
        fs.mkdirSync(path.join(root, ".agentera"));
        fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
        const preserved = unrelated(root);
        const binding = detectStateModeBinding(root);
        if (binding.mode !== "entities") throw new Error("entity mode expected");
        const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
        let calls = 0;
        vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
          const result = original(target, bytes);
          calls += 1;
          if (calls === after) {
            fs.rmSync(path.join(root, ".agentera/state-mode.yaml"));
            if (invalidation === "replace") fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
          }
          return result;
        });
        const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
        expect(() =>
          createPlanEntities(request(root, "create", {}, plan("rollback", true)), {
            publicationContext: binding.publicationContext,
            candidate: () => ids.shift()!,
          }),
        ).toThrow(/changed|conflict/i);
        expect(() => binding.publicationContext.publishImmutable(".agentera/entities/plan/plan/dddddddddd.yaml", "refused\n")).toThrow(/changed|conflict/i);
        binding.publicationContext.close();
        vi.restoreAllMocks();
        expect(fs.existsSync(path.join(root, ".agentera/entities/plan"))).toBe(false);
        expect(entityNames(root).filter((name) => name.includes(".tmp") || name.includes("aaaaaaaaaa") || name.includes("bbbbbbbbbb") || name.includes("cccccccccc"))).toEqual([]);
        expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
      }
  });

  it("rolls back prior create files when marker invalidation strikes every next-file publication boundary", () => {
    for (const invalidation of ["remove", "replace"] as const)
      for (const boundary of ["directory", "stage", "link", "final"] as const) {
        const container = project(false);
        const root = path.join(container, "project");
        fs.mkdirSync(root);
        fs.mkdirSync(path.join(root, ".agentera"));
        fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
        const preserved = unrelated(root);
        const binding = detectStateModeBinding(root);
        if (binding.mode !== "entities") throw new Error("entity mode expected");
        const mutate = (): void => {
          fs.rmSync(path.join(root, ".agentera/state-mode.yaml"));
          if (invalidation === "replace") fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
        };
        let mutated = false;
        const once = (): void => {
          if (!mutated) {
            mutated = true;
            mutate();
          }
        };
        const originalMkdir = fs.mkdirSync.bind(fs),
          originalOpen = fs.openSync.bind(fs),
          originalLink = fs.linkSync.bind(fs),
          originalSync = fs.fsyncSync.bind(fs);
        if (boundary === "directory")
          vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => {
            const result = originalMkdir(candidate, options as never);
            if (String(candidate).endsWith("/plan_task")) once();
            return result as never;
          });
        else if (boundary === "stage")
          vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
            const fd = originalOpen(candidate, flags, mode);
            if (String(candidate).includes(".bbbbbbbbbb.yaml.") && String(candidate).endsWith(".tmp")) once();
            return fd;
          });
        else if (boundary === "link")
          vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
            originalLink(source, target);
            if (String(target).endsWith("/bbbbbbbbbb.yaml")) once();
          });
        else
          vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
            originalSync(fd);
            let descriptor = "";
            try {
              descriptor = fs.readlinkSync(`/proc/self/fd/${fd}`);
            } catch {
              /* descriptor closed */
            }
            if (descriptor.endsWith("/plan_task") && fs.existsSync(`/proc/self/fd/${fd}/bbbbbbbbbb.yaml`)) once();
          });
        const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
        expect(() =>
          createPlanEntities(request(root, "create", {}, plan("rollback", true)), {
            publicationContext: binding.publicationContext,
            candidate: () => ids.shift()!,
          }),
        ).toThrow(/changed|conflict/i);
        expect(mutated).toBe(true);
        binding.publicationContext.close();
        vi.restoreAllMocks();
        expect(fs.existsSync(path.join(root, ".agentera/entities/plan")), `${invalidation}/${boundary}: ${entityNames(root).join(", ")}`).toBe(false);
        expect(entityNames(root).filter((name) => name.includes(".tmp") || name.includes("aaaaaaaaaa") || name.includes("bbbbbbbbbb"))).toEqual([]);
        expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
      }
  });

  it("preserves identical and divergent same-path successors during marker-invalidated create rollback", () => {
    for (const content of ["identical", "divergent"] as const) {
      const container = project(false);
      const root = path.join(container, "project");
      fs.mkdirSync(root);
      fs.mkdirSync(path.join(root, ".agentera"));
      fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
      const preserved = unrelated(root);
      const binding = detectStateModeBinding(root);
      if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext);
      let calls = 0;
      let firstBytes = "";
      vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
        const result = original(target, bytes);
        calls += 1;
        if (calls === 1) firstBytes = bytes;
        if (calls === 2) {
          const first = path.join(root, ".agentera/entities/plan/plan/aaaaaaaaaa.yaml");
          const successor = path.join(root, "same-path-successor.yaml");
          fs.writeFileSync(successor, content === "identical" ? firstBytes : "successor bytes\n");
          fs.renameSync(successor, first);
          fs.unlinkSync(path.join(root, ".agentera/state-mode.yaml"));
        }
        return result;
      });
      const ids = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"];
      expect(() =>
        createPlanEntities(request(root, "create", {}, plan("successor", true)), {
          publicationContext: binding.publicationContext,
          candidate: () => ids.shift()!,
        }),
      ).toThrow(/changed|conflict/i);
      binding.publicationContext.close();
      vi.restoreAllMocks();
      expect(fs.readFileSync(path.join(root, ".agentera/entities/plan/plan/aaaaaaaaaa.yaml"), "utf8")).toBe(content === "identical" ? firstBytes : "successor bytes\n");
      expect(fs.existsSync(path.join(root, ".agentera/entities/plan/plan_task/bbbbbbbbbb.yaml"))).toBe(false);
      expect(entityNames(root).filter((name) => name.includes(".tmp") || name.includes(".rollback"))).toEqual([]);
      expect(fs.readFileSync(preserved.file, "utf8")).toBe(preserved.bytes);
    }
  });

  it("rejects malformed entity evaluation metadata in whole-state validation", () => {
    const root = project();
    const created = create(root, "validation");
    const target = path.join(root, `.agentera/entities/plan/plan_task/${created.tasks[0].id}.yaml`);
    const entity = loadYamlMapping(fs.readFileSync(target, "utf8"));
    const record = entity.record as Record<string, unknown>;
    record.evaluation = {
      attempt_count: 1,
      failure_count: 1,
      last_verdict: "fail",
      last_failure_evidence: null,
      provenance: {
        attempt_id: "audit-1",
        source: "audit",
        recorded_at: "2026-07-17 12:00",
        writer_command: "agentera state plan record-evaluation",
      },
    };
    fs.writeFileSync(target, dumpYamlMapping(entity));
    const validation = validateEntityState(root);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/evaluation fields/) })]));
  });

  it("provides full bounded plan/task snapshots and invalidates changed cursors", () => {
    const root = project();
    const first = create(root, "first");
    const second = create(root, "second", false, true);
    const listed = capture(root, ["state", "plan", "list", "--limit", "1", "--format", "json"]);
    expect(listed.rc).toBe(0);
    const page = JSON.parse(listed.out);
    expect(page.entries[0]).toHaveProperty("record");
    expect(page.next_cursor).toBeTruthy();
    const exact = capture(root, ["state", "plan", "get", "--id", first.id, "--format", "json"]);
    expect(exact.rc).toBe(0);
    expect(JSON.parse(exact.out).tasks[0].record).toBeTruthy();
    const taskId = JSON.parse(exact.out).tasks[0].id;
    expect(capture(root, ["state", "plan", "tasks", "get", "--id", taskId, "--format", "json"]).rc).toBe(0);
    appendTask(root, second.id, { name: "Changed snapshot", depends_on: [], acceptance: [] });
    const stale = capture(root, ["state", "plan", "list", "--limit", "1", "--cursor", page.next_cursor, "--format", "json"]);
    expect(stale.rc).toBe(1);
    expect(JSON.parse(stale.out).error.class).toBe("cursor_snapshot_unavailable");
  });

  it("rejects numeric selectors in entity mode and all writes before cutover", () => {
    const entity = project();
    const created = create(entity, "entity");
    expect(capture(entity, ["state", "plan", "set-status", "--task", "1", "--status", "complete", "--format", "json"]).rc).toBe(2);
    expect(capture(entity, ["state", "plan", "tasks", "get", "--task", "1", "--format", "json"]).rc).toBe(2);
    const legacy = project(false);
    const input = path.join(legacy, "legacy.yaml");
    fs.writeFileSync(input, dumpYamlMapping(plan("legacy")));
    const rejected = capture(legacy, ["state", "plan", "create", "--input", input, "--format", "json"]);
    expect(rejected.rc).toBe(1);
    expect(JSON.parse(rejected.out).error).toMatchObject({
      class: "migration_required",
      recovery: expect.stringContaining("upgrade --channel development"),
    });
    expect(fs.existsSync(path.join(legacy, ".agentera/plan.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);
    expect(created.id).toMatch(/^[a-z]{10}$/);
  });

  it("lets Git merge different tasks, conflicts on one task, and validates duplicate ownership", () => {
    const root = project();
    const created = create(root, "merge");
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "add", ".agentera");
    git(root, "commit", "-m", "base");
    const left = `${root}-left`,
      right = `${root}-right`;
    roots.push(left, right);
    git(root, "worktree", "add", "-b", "left", left, "main");
    git(root, "worktree", "add", "-b", "right", right, "main");
    appendTask(left, created.id, { name: "Left", depends_on: [], acceptance: [] });
    appendTask(right, created.id, { name: "Right", depends_on: [], acceptance: [] });
    git(left, "add", ".agentera/entities");
    git(left, "commit", "-m", "left");
    git(right, "add", ".agentera/entities");
    git(right, "commit", "-m", "right");
    git(root, "merge", "--ff-only", "left");
    git(root, "merge", "--no-edit", "right");
    expect(validateEntityState(root).valid).toBe(true);
    const taskPath = path.join(root, ".agentera/entities/plan/plan_task", `${created.tasks[0].id}.yaml`);
    const duplicate = path.join(root, ".agentera/entities/plan/plan", `${created.tasks[0].id}.yaml`);
    fs.copyFileSync(taskPath, duplicate);
    expect(validateEntityState(root).valid).toBe(false);
    fs.unlinkSync(duplicate);
    const conflictRoot = project();
    const conflictPlan = create(conflictRoot, "conflict");
    git(conflictRoot, "init", "-b", "main");
    git(conflictRoot, "config", "user.name", "Fixture");
    git(conflictRoot, "config", "user.email", "fixture@example.test");
    git(conflictRoot, "add", ".agentera");
    git(conflictRoot, "commit", "-m", "base");
    const a = `${conflictRoot}-a`,
      b = `${conflictRoot}-b`;
    roots.push(a, b);
    git(conflictRoot, "worktree", "add", "-b", "a", a, "main");
    git(conflictRoot, "worktree", "add", "-b", "b", b, "main");
    expect(updateTask(a, conflictPlan.tasks[0].id, { name: "A" }, conflictPlan.id).rc).toBe(0);
    expect(updateTask(b, conflictPlan.tasks[0].id, { name: "B" }, conflictPlan.id).rc).toBe(0);
    git(a, "add", ".agentera/entities");
    git(a, "commit", "-m", "a");
    git(b, "add", ".agentera/entities");
    git(b, "commit", "-m", "b");
    git(conflictRoot, "merge", "--ff-only", "a");
    expect(() => git(conflictRoot, "merge", "--no-edit", "b")).toThrow();
  });
});
