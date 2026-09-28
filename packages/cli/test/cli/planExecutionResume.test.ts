import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main } from "../../src/cli/dispatch.js";

const repo = path.resolve(import.meta.dirname, "../../../..");
let root: string, previousCwd: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-resume-"));
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  vi.stubEnv("HOME", root);
  vi.stubEnv("AGENTERA_HOME", path.join(root, "app"));
  vi.stubEnv("AGENTERA_PROFILE_DIR", path.join(root, "profile"));
  vi.stubEnv("PROFILERA_PROFILE_DIR", path.join(root, "profile"));
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", repo);
  previousCwd = process.cwd();
  process.chdir(root);
});
afterEach(() => {
  process.chdir(previousCwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function run(args: string[], code = 0): any {
  let out = "",
    err = "";
  const result = main(["node", "agentera", ...args], {
    out: (text) => (out += text),
    err: (text) => (err += text),
  });
  expect(result, out + err).toBe(code);
  return JSON.parse(out);
}
function mutate(verb: string, args: string[], code = 0) {
  run(["state", "plan", "explain", "--verb", verb]);
  return run(["state", "plan", verb, ...args], code);
}
function create() {
  const input = path.join(root, "plan.json");
  fs.writeFileSync(
    input,
    JSON.stringify({
      header: {
        title: "Plan: Resume verified work",
        level: "light",
        created: "2026-09-22",
        status: "open",
      },
      what: "Deliver a verified outcome without repeating completed work.",
      why: "An interruption must not lose evaluation evidence.",
      scope: { included: ["task execution"], excluded: ["unapproved work"] },
      tasks: [
        {
          number: 1,
          name: "Earlier ready task",
          depends_on: [],
          status: "pending",
          acceptance: ["GIVEN approval WHEN work completes THEN the result is verified."],
        },
        {
          number: 2,
          name: "Interrupted task",
          depends_on: [],
          status: "pending",
          acceptance: ["GIVEN a result WHEN checked THEN the outcome is correct."],
        },
        {
          number: 3,
          name: "Dependent task",
          depends_on: ["2"],
          status: "pending",
          acceptance: ["GIVEN the prerequisite completes WHEN selected THEN work can proceed."],
        },
      ],
    }),
  );
  return mutate("create", ["--input", input]).tasks.map((task: { id: string }) => task.id) as string[];
}
function readTask(id: string) {
  return run(["state", "plan", "tasks", "get", "--id", id]).entry.record;
}
function startup() {
  return run(["prime", "--context", "orchestrate"]).capability_context.context.orchestration_context;
}
function evaluate(id: string, attempt: string, verdict = "pass", code = 0) {
  return mutate("record-evaluation", ["--id", id, "--attempt-id", attempt, "--verdict", verdict, "--provenance", "fixture audit: matching task, inputs and acceptance", ...(verdict === "fail" ? ["--failure-evidence", `fixture failure ${attempt}`] : [])], code);
}

it("serves consistent final approval and resume rules through the complete instruction detail", () => {
  // Contract regression only: these assertions do not prove a host's consent judgment.
  const text = (capability: string) => {
    const response = run(["prime", "--context", capability, "--detail", "instructions", "--section", "instructions", "--limit", "20"]);
    expect(response.completeness.complete).toBe(true);
    return response.items.map((part: { content: string }) => part.content).join("");
  };
  const plan = text("plan"),
    orchestrate = text("orchestrate");
  expect(plan).toContain("Present the final reviewed plan for meaningful approval");
  expect(plan).toContain("After the writer confirms publication, carry explicit save-and-execute approval forward without another confirmation");
  expect(plan).toContain("Planning-only approval saves the plan and suggests the appropriate execution capability without starting it");
  expect(plan).toContain("a material scope, constraint or acceptance change requires renewed approval");
  expect(plan).not.toContain("Suggest, don't dispatch");
  expect(plan).not.toContain("suggest ⎈ orchestrate to execute the entire plan and wait for confirmation");
  for (const body of [plan, orchestrate]) expect(body).toContain("Git, global installation and history permissions remain separate");
  expect(orchestrate).toContain("do not re-delegate, re-evaluate or record a new attempt");
  expect(orchestrate).toContain("state plan tasks get --id ID");
  expect(orchestrate).toContain("A PASS label alone cannot substitute for missing or stale evidence");
  expect(orchestrate).toContain("Surface the failure and required user decision");
  expect(orchestrate).not.toMatch(/Increment the retry count|retries [<=]|max 2 retries|retry a task more than 2 times/);
  const contract = run(["prime", "--context", "plan", "--detail", "instructions", "--section", "startup_contract", "--limit", "20"]);
  expect(JSON.stringify(contract)).toContain("without another confirmation");
  expect(JSON.stringify(contract)).not.toContain("full plans suggest");
});

it.each(["pending", "in_progress"])("resumes eligible persisted PASS from %s before new work without another evaluation", (status) => {
  const [, , dependent] = create();
  // Choose the later ready entry so the test cannot pass by incidental ID order.
  const [earlier, interrupted] = startup().task_queue.dependency_ready_tasks.map((task: { id: string }) => task.id);
  if (status === "in_progress") mutate("set-status", ["--id", interrupted, "--status", status]);
  const input = path.join(root, "evidence.json");
  fs.writeFileSync(
    input,
    JSON.stringify({
      evidence: ["Fixture audit observed the accepted outcome on unchanged inputs."],
    }),
  );
  mutate("update", ["--id", interrupted, "--input", input]);
  evaluate(interrupted, "pass-1");
  const evaluated = readTask(interrupted);
  const resumed = startup();
  expect(resumed.selected_next_task).toMatchObject({
    id: interrupted,
    status,
    evaluation_state: evaluated.evaluation,
    evidence_summary: { items: evaluated.evidence },
  });
  expect(resumed.task_queue.blocked_tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: dependent })]));
  expect(resumed.retry_state).toMatchObject({
    task: { id: interrupted },
    attempt_count: 1,
    failure_count: 0,
    last_verdict: "pass",
  });
  expect(evaluate(interrupted, "pass-1").operation.idempotent_replay).toBe(true);
  mutate("set-status", ["--id", interrupted, "--status", "complete"]);
  expect(readTask(interrupted)).toEqual({ ...evaluated, status: "complete" });
  expect(mutate("set-status", ["--id", interrupted, "--status", "complete"]).operation.idempotent_replay).toBe(true);
  expect([earlier, dependent]).toContain(startup().selected_next_task.id);
});

it("resumes in-progress work but does not select a persisted PASS with unmet dependencies", () => {
  const [, interrupted, dependent] = create();
  mutate("set-status", ["--id", interrupted, "--status", "in_progress"]);
  evaluate(dependent, "premature-pass");
  expect(startup().selected_next_task.id).toBe(interrupted);
  expect(startup().task_queue.blocked_tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: dependent })]));
  expect(readTask(dependent).status).toBe("pending");
});

it("resumes a first failure once and preserves writer-blocked second-failure history against extra attempts", () => {
  const [, interrupted] = create();
  mutate("set-status", ["--id", interrupted, "--status", "in_progress"]);
  evaluate(interrupted, "fail-1", "fail");
  const first = readTask(interrupted);
  expect(evaluate(interrupted, "fail-1", "fail").operation.idempotent_replay).toBe(true);
  expect(readTask(interrupted)).toEqual(first);
  expect(startup().retry_state).toMatchObject({
    task: { id: interrupted },
    attempt_count: 1,
    failure_count: 1,
  });
  evaluate(interrupted, "fail-2", "fail");
  const blocked = readTask(interrupted);
  expect(blocked).toMatchObject({
    status: "blocked",
    evaluation: {
      attempt_count: 2,
      failure_count: 2,
      last_failure_evidence: "fixture failure fail-2",
      provenance: { attempt_id: "fail-2" },
    },
  });
  expect(evaluate(interrupted, "fail-2", "fail").operation.idempotent_replay).toBe(true);
  evaluate(interrupted, "fail-3", "fail", 2);
  evaluate(interrupted, "invented-pass", "pass", 2);
  mutate("set-status", ["--id", interrupted, "--status", "in_progress"], 2);
  expect(readTask(interrupted)).toEqual(blocked);
  expect(startup().task_queue.blocked_tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: interrupted,
        status: "blocked",
        blocked_reasons: ["task status is blocked"],
      }),
    ]),
  );
});
