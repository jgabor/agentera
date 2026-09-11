import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { encode } from "gpt-tokenizer/model/gpt-5";
import { afterEach, beforeEach, expect, it } from "vitest";

import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { genericSlimStartupContext, slimPlanState, slimTodoState } from "../../src/cli/capabilityContext/startup.js";
import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml"), "utf8"));
const budget = manifest.surfaces.find((surface: { id: string }) => surface.id === "prime-capability-context").budget_by_capability.plan;
let tmp: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plan-startup-budget-"));
  previousCwd = process.cwd();
  previousEnv = Object.fromEntries(["AGENTERA_BOOTSTRAP_SOURCE_ROOT", "AGENTERA_HOME", "HOME"].map((key) => [key, process.env[key]]));
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(tmp, "home");
  process.env.HOME = tmp;
  process.chdir(tmp);
  fs.mkdirSync(path.join(tmp, ".agentera"));
  fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function entity(artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const directory = path.join(tmp, ".agentera/entities", artifact, boundary);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact, record }));
}

function run(args: string[]): { payload: any; stdout: string } {
  let stdout = "";
  let stderr = "";
  const rc = main(["node", "agentera", ...args], {
    out: (text) => (stdout += text),
    err: (text) => (stderr += text),
  });
  expect(rc, stderr || stdout).toBe(0);
  return { payload: JSON.parse(stdout), stdout };
}

function retrieve(command: string, id?: string): any {
  expect(command).toMatch(/^npx -y agentera@next /);
  return run(
    command
      .replace("npx -y agentera@next ", "")
      .replace(/\bID\b/, id ?? "ID")
      .split(" "),
  ).payload;
}

it("keeps omitted task metadata truthful when exact records are unavailable", () => {
  const plan = slimPlanState({
    tasks: [
      { id: "aaaaaaaaaa", artifact: "plan", detail_availability: "omitted" },
      {
        id: "bbbbbbbbbb",
        artifact: "plan",
        detail_availability: "omitted",
        readable: { text: "Retained task name", metadata: { status: "complete" } },
      },
    ],
  });
  expect(plan.tasks).toEqual([
    {
      id: "aaaaaaaaaa",
      artifact: "plan",
      name: null,
      status: null,
      detail_availability: "omitted",
    },
    {
      id: "bbbbbbbbbb",
      artifact: "plan",
      name: "Retained task name",
      status: "complete",
      detail_availability: "omitted",
    },
  ]);
});

it("keeps other TODO consumers unchanged and legacy Plan recovery usable", () => {
  const items = Array.from({ length: 4 }, () => ({
    text: "Legacy TODO",
    severity: "normal",
    status: "open",
    requirements: ["Retrieve before planning"],
  }));
  const planning = genericSlimStartupContext("plan", {}, {}, {}, {}, {}, items).planning_context as any;
  expect(planning.todo.entries[0].retrieval).toEqual({
    list: "npx -y agentera@next state todo list --status open --limit 20",
  });
  const design = genericSlimStartupContext("design", {}, {}, {}, {}, {}, items).design_context as any;
  expect(design.todo).toEqual(slimTodoState(items));
});

it.each([0, 1, 3])("preserves small Plan TODO projections (%i entries) and other consumers", (count) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `todo-${index}`,
    text: "Meaningful TODO",
    severity: "critical",
    status: "open",
  }));
  const planning = genericSlimStartupContext("plan", {}, {}, {}, {}, {}, items).planning_context as any;
  expect(planning.todo).toEqual(slimTodoState(items));
  const design = genericSlimStartupContext("design", {}, {}, {}, {}, {}, items).design_context as any;
  expect(design.todo).toEqual(slimTodoState(items));
});

it.each([false, true])("bounds rich TODO detail with an active plan (oversized: %s), retaining exact recovery", (oversized) => {
  const planId = "pppppppppp";
  const count = oversized ? 41 : 4;
  entity("plan", "plan", planId, {
    header: {
      title: "Plan: retain meaningful startup context",
      status: "open",
      level: "simple",
      created: "2026-09-11",
    },
    what: "Bound optional startup detail",
    why: "Preserve executable task identity and recovery",
    scope: { included: ["Plan startup"], excluded: ["Lifecycle writes"] },
  });
  const selectedId = "zzzzzzzzzz";
  const selected = {
    plan: planId,
    name: "Verify startup and exact task recovery",
    status: "in_progress",
    depends_on: ["aaaaaaaaaa"],
    acceptance: ["The Plan capsule stays within the existing budget.", "Retrieve this exact task's acceptance and worker evidence."],
    evidence: ["Synthetic worker handoff; no progress record required."],
  };
  for (let index = 0; index < count - 1; index++) {
    const id = `aaaaaaaa${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
    entity("plan", "plan_task", id, {
      plan: planId,
      name: `Completed task ${index}${oversized ? "𐐀".repeat(300) : ""}`,
      status: "complete",
      depends_on: [],
      acceptance: [oversized ? "Large acceptance context ".repeat(200) : "Dependency complete"],
      evidence: [oversized ? "Existing worker evidence ".repeat(200) : "Worker verified dependency"],
    });
  }
  entity("plan", "plan_task", selectedId, selected);
  for (let index = 0; index < 20; index++) {
    entity("todo", "todo_item", `ttttttttt${String.fromCharCode(97 + index)}`, {
      title: `Preserve requirement ${index}`,
      status: "open",
      severity: index < 5 ? "critical" : "normal",
      kind: "fix",
      target_version: "3.0.0",
      requirements: Array.from({ length: 8 }, (_, item) => `Requirement ${item}: ${"meaningful context ".repeat(10)}`),
      acceptance: Array.from({ length: 8 }, (_, item) => `Acceptance ${item}: ${"observable behavior ".repeat(10)}`),
      readiness: {
        capability: "build",
        reason: "Implement only within accepted scope",
        dependencies: [],
        blocked: null,
        gate: null,
        queue_rank: index + 1,
        order_reason: "Fixture order",
      },
    });
  }
  const { payload, stdout } = run(["prime", "--context", "plan"]);
  expect(Object.keys(payload).sort()).toEqual(["capability_context", "command", "outcome", "shared_skill"]);
  expect(payload.shared_skill).toBeDefined();
  expect(stdout.endsWith("\n")).toBe(true);
  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(budget.byte_budget);
  expect(encode(stdout).length).toBeLessThanOrEqual(budget.token_budget);
  const capsule = payload.capability_context;
  expect(capsule.instructions).toBe(CAPABILITY_INSTRUCTIONS.plan);
  expect(capsule.startup).toMatchObject({ outcome: "ok", raw_artifact_reads_required: false });
  expect(capsule.startup.availability).toContainEqual({
    family: "todo",
    availability: "included",
    detail_command: "npx -y agentera@next state todo list",
  });
  const planning = capsule.context.planning_context;
  expect(planning.plan).toEqual(capsule.context.plan);
  expect(planning.plan).toMatchObject({
    id: planId,
    title: "Plan: retain meaningful startup context",
    active: true,
    total: count,
    complete: count - 1,
    task_status_counts: { complete: count - 1, in_progress: 1 },
    first_pending: { id: selectedId, name: selected.name, status: "in_progress" },
    task_omission: { omitted: oversized },
  });
  expect(planning.plan.tasks.length).toBeGreaterThan(0);
  expect(planning.plan.tasks[0]).toMatchObject({
    id: "aaaaaaaaaa",
    status: "complete",
    name: expect.stringContaining("Completed task 0"),
  });
  const taskRecovery = planning.plan.task_omission.retrieval;
  if (oversized) {
    expect(planning.plan.tasks[0].detail_availability).toBe("omitted");
    expect(Array.from(planning.plan.tasks[0].name)).toHaveLength(32);
    expect(planning.plan.tasks[0].name).toMatch(/…$/);
    expect(retrieve(taskRecovery.get, "aaaaaaaaaa").entry.record).toMatchObject({
      status: "complete",
      name: `Completed task 0${"𐐀".repeat(300)}`,
      evidence: ["Existing worker evidence ".repeat(200)],
    });
  }
  expect(retrieve(taskRecovery.get, selectedId).entry.record).toEqual(selected);
  expect(retrieve(taskRecovery.list)).toHaveProperty("entries");
  expect(planning.todo).toMatchObject({
    open_count: 20,
    severity_counts: { critical: 5, normal: 15 },
    omission: { omitted: true, omitted_count: 17, omission_reason: "startup_detail_capacity" },
  });
  expect(planning.todo.entries).toHaveLength(3);
  expect(planning.todo.entries[0]).toMatchObject({
    id: "ttttttttta",
    title: "Preserve requirement 0",
    status: "open",
    severity: "critical",
  });
  expect(planning.todo.entries[0]).toMatchObject({
    detail_availability: "summary",
    omitted_fields: expect.arrayContaining(["requirements", "acceptance", "readiness"]),
  });
  expect(planning.todo.entries[0]).not.toHaveProperty("requirements");
  expect(retrieve(planning.todo.entries[0].retrieval.get).entry.record.requirements).toHaveLength(8);
  expect(retrieve(planning.todo.omission.retrieval.list).entries).toHaveLength(20);
  const omitted = retrieve(planning.todo.omission.retrieval.get, "tttttttttt").entry;
  expect(omitted.record.title).toBe("Preserve requirement 19");
  expect(omitted.record.acceptance).toHaveLength(8);
  expect(fs.existsSync(path.join(tmp, ".agentera/entities/progress"))).toBe(false);
});
