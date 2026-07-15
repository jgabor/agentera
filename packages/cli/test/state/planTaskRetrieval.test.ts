import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { printStateHelp } from "../../src/cli/help.js";
import { stateRetrievalCommands } from "../../src/state/retrievalAuthority.js";

const roots: string[] = [];
const planId = "plan:123e4567-e89b-42d3-a456-426614174000";

function project(tasks: Array<Record<string, unknown>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-tasks-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agentera", "plan.yaml"),
    YAML.stringify({
      header: { id: planId, title: "Large plan", status: "open", created: "2026-07-14" },
      tasks,
    }),
  );
  return root;
}

function task(number: number, detail = `Task ${number}`): Record<string, unknown> {
  return {
    number,
    name: `Task ${number}`,
    status: "pending",
    acceptance: [`GIVEN task ${number} WHEN fetched THEN ${detail}`],
  };
}

function capture(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", "state", "plan", "tasks", ...args], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

function capturePlan(root: string, args: string[]): { rc: number; out: string; err: string } {
  const previous = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", "state", "plan", ...args], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { rc, out, err };
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("active plan task retrieval", () => {
  it("derives deterministic read-only legacy identity and reports byte-equivalent mirrors", () => {
    const root = project([task(1)]);
    const activePath = path.join(root, ".agentera", "plan.yaml");
    const document = YAML.parse(fs.readFileSync(activePath, "utf8"));
    delete document.header.id;
    const bytes = YAML.stringify(document);
    fs.writeFileSync(activePath, bytes);
    const archivePath = path.join(root, ".agentera", "archive", "PLAN-legacy-copy.yaml");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, bytes);

    const first = capture(root, ["get", "--task", "1", "--format", "json"]);
    const second = capture(root, ["get", "--task", "1", "--format", "json"]);
    expect(first.rc).toBe(0);
    expect(second.rc).toBe(0);
    const firstPayload = JSON.parse(first.out);
    const secondPayload = JSON.parse(second.out);
    expect(firstPayload.entry.stable_id).toBe(secondPayload.entry.stable_id);
    expect(firstPayload.entry.stable_id).toMatch(/^legacy-plan:[0-9a-f]{64}\/task:1$/);
    expect(firstPayload.entry.compatibility).toBe("degraded");
    expect(firstPayload.entry.provenance.mirrored_paths).toEqual([activePath, archivePath].sort());
    expect(fs.readFileSync(activePath, "utf8")).toBe(bytes);
    expect(fs.readFileSync(archivePath, "utf8")).toBe(bytes);
  });

  it("fails safely with structured ambiguity when one persisted identity names different plans", () => {
    const root = project([task(1)]);
    const archivePath = path.join(root, ".agentera", "archive", "PLAN-collision.yaml");
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, YAML.stringify({
      header: { id: planId, title: "Different plan", status: "open", created: "2026-07-14" },
      tasks: [task(2)],
    }));

    const result = capture(root, ["get", "--task", "1", "--format", "json"]);
    expect(result.rc).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      status: "fail",
      error: {
        class: "ambiguous",
        stable_id: planId,
        details: { candidate_paths: [path.join(root, ".agentera", "plan.yaml"), archivePath].sort() },
      },
    });
  });

  it("keeps help, authority, and runtime aligned on active-plan task get", () => {
    const grammar = (stateRetrievalCommands().plan_tasks as Record<string, string>).get;
    const help = printStateHelp("plan");
    expect(grammar).toBe("agentera state plan tasks get [--plan PLAN_ID] --task N --format json");
    expect(help).toContain(grammar);
    expect(help).toContain("Task list and task get default to the active plan; --plan is optional");
    expect(help).not.toContain("task get requires --plan");

    const root = project([task(1)]);
    const result = capture(root, ["get", "--task", "1", "--format", "json"]);
    expect(result.rc).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      command: "state plan tasks get",
      status: "ok",
      source: { active: true, plan_id: planId },
      entry: { task_number: 1 },
    });
  });

  it("bounds a large active plan at the authority maximum without changing declared order", () => {
    const root = project(Array.from({ length: 120 }, (_, index) => task(120 - index)));
    const result = capture(root, ["list", "--limit", "100", "--format", "json"]);
    expect(result.rc).toBe(0);
    const payload = JSON.parse(result.out);
    const returned = payload.entries.length;
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThanOrEqual(100);
    expect(payload.entries.map((entry: any) => entry.task_number)).toEqual(Array.from({ length: returned }, (_, index) => index + 1));
    expect(payload.counts).toMatchObject({ total: 120, returned, remaining: 120 - returned, omitted: 120 - returned });
    expect(payload.omitted_count).toBe(120 - returned);

    const text = capture(root, ["list", "--limit", "100"]);
    expect(text.rc).toBe(0);
    expect(Buffer.byteLength(text.out, "utf8")).toBeLessThanOrEqual(32768);
    expect(text.out).toContain("Omitted: 20 task(s) | reason=page_limit");
  });

  it("lists tasks in declared numeric order with stable counts and an opaque continuation", () => {
    const root = project([task(3), task(1), task(2)]);
    const first = capture(root, ["list", "--limit", "2", "--format", "json"]);
    expect(first.rc).toBe(0);
    const page1 = JSON.parse(first.out);
    expect(page1).toMatchObject({
      schemaVersion: "agentera.stateRetrieval.v1",
      command: "state plan tasks list",
      status: "ok",
      order: "task_number_asc",
      filters: { plan: planId },
      counts: { total: 3, returned: 2, remaining: 1, omitted: 1 },
      omitted: true,
      omitted_count: 1,
      omission_reason: "page_limit",
    });
    expect(page1.entries.map((entry: any) => entry.task_number)).toEqual([1, 2]);
    expect(page1.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page1.retrieval.continue).toContain(`--cursor ${page1.next_cursor}`);

    const second = capture(root, ["list", "--limit", "2", "--cursor", page1.next_cursor, "--format", "json"]);
    expect(second.rc).toBe(0);
    const page2 = JSON.parse(second.out);
    expect(page2.entries.map((entry: any) => entry.task_number)).toEqual([3]);
    expect(page2.counts).toMatchObject({ total: 3, returned: 1, remaining: 0, omitted: 0 });
    expect(page2.next_cursor).toBeUndefined();
  });

  it("returns one complete task and a structured not-found result", () => {
    const root = project([task(1, "all acceptance detail is retained")]);
    const found = capture(root, ["get", "--task", "1", "--format", "json"]);
    expect(found.rc).toBe(0);
    expect(JSON.parse(found.out)).toMatchObject({
      schemaVersion: "agentera.stateRetrieval.v1",
      command: "state plan tasks get",
      status: "ok",
      entry: {
        stable_id: `${planId}/task:1`,
        task_number: 1,
        detail_availability: "full",
        record: { acceptance: ["GIVEN task 1 WHEN fetched THEN all acceptance detail is retained"] },
      },
    });

    const missing = capture(root, ["get", "--task", "2", "--format", "json"]);
    expect(missing.rc).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "not_found",
        syntax: "agentera state plan tasks get [--plan PLAN_ID] --task N --format json",
        example: "agentera state plan tasks get --task 1 --format json",
      },
    });
  });

  it("rejects malformed requests and cursors with structured usage failures", () => {
    const root = project([task(1)]);
    for (const args of [
      ["list", "--limit", "0", "--format", "json"],
      ["list", "--cursor", "not-a-real-cursor", "--format", "json"],
      ["get", "--task", "01", "--format", "json"],
      ["get", "--format", "json"],
    ]) {
      const result = capture(root, args);
      expect(result.rc).toBe(2);
      expect(JSON.parse(result.out)).toMatchObject({
        schemaVersion: "agentera.stateFailure.v1",
        status: "fail",
        error: { class: expect.stringMatching(/^(invalid_request|cursor_invalid)$/), recovery: expect.any(String) },
      });
    }
  });

  it("does not silently slice text or byte-bounded JSON and exposes working recovery", () => {
    const root = project(Array.from({ length: 12 }, (_, index) => task(index + 1, "x".repeat(5000))));
    const text = capture(root, ["list", "--limit", "5"]);
    expect(text.rc).toBe(0);
    expect(text.out).toContain("Omitted: 7 task(s) | reason=page_limit");
    expect(text.out).toMatch(/Continue: agentera state plan tasks list .*--cursor [A-Za-z0-9_-]+/);
    expect(text.out).toContain("Get one: agentera state plan tasks get --task N --format json");

    const json = capture(root, ["list", "--limit", "12", "--format", "json"]);
    expect(json.rc).toBe(0);
    expect(Buffer.byteLength(json.out, "utf8")).toBeLessThanOrEqual(32768);
    const payload = JSON.parse(json.out);
    expect(payload.omitted).toBe(true);
    expect(payload.omitted_count).toBeGreaterThan(0);
    expect(payload.omission_reason).toBe("serialized_output_byte_budget");
    expect(payload.retrieval.continue).toContain(`--cursor ${payload.next_cursor}`);

    const yaml = capture(root, ["list", "--limit", "12", "--format", "yaml"]);
    expect(yaml.rc).toBe(0);
    expect(Buffer.byteLength(yaml.out, "utf8")).toBeLessThanOrEqual(32768);
    const yamlPayload = YAML.parse(yaml.out);
    expect(yamlPayload.omitted).toBe(true);
    expect(yamlPayload.omitted_count).toBeGreaterThan(0);
    expect(yamlPayload.omission_reason).toBe("serialized_output_byte_budget");
    expect(yamlPayload.retrieval.continue).toContain(`--cursor ${yamlPayload.next_cursor}`);
  });

  it("adds task list/get recovery when the legacy plan projection omits tasks", () => {
    const root = project(Array.from({ length: 12 }, (_, index) => task(index + 1, "é🙂漢字".repeat(1500))));
    const text = capturePlan(root, []);
    expect(text.rc).toBe(0);
    expect(text.out).toContain("Tasks omitted: 2 | reason=text_projection_limit");
    expect(text.out).toContain("Continue: agentera state plan tasks list --format json");
    expect(text.out).toContain("Get one: agentera state plan tasks get --task N --format json");

    const json = capturePlan(root, ["--format", "json"]);
    expect(json.rc).toBe(0);
    expect(Buffer.byteLength(json.out, "utf8")).toBeLessThanOrEqual(32768);
    const payload = JSON.parse(json.out);
    expect(payload.omitted).toBe(true);
    expect(payload.omitted_count).toBeGreaterThan(0);
    expect(payload.retrieval).toEqual({
      available: true,
      list: "agentera state plan tasks list --format json",
      get: "agentera state plan tasks get --task N --format json",
      plans_list: "agentera state plan list --format json",
      plans_get: "agentera state plan get --plan PLAN_ID --format json",
    });
    expect(payload.plan_catalog).toMatchObject({
      omitted: false,
      omitted_count: 0,
      omission_reason: null,
      retrieval: {
        list: "agentera state plan list --format json",
        get: "agentera state plan get --plan PLAN_ID --format json",
      },
    });
  });

  it("declares legacy plan catalog and archive-path omissions with public recovery", () => {
    const root = project([task(1)]);
    const archiveRoot = path.join(root, ".agentera", "archive");
    fs.mkdirSync(archiveRoot, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      fs.writeFileSync(path.join(archiveRoot, `PLAN-${index}.yaml`), YAML.stringify({
        header: { id: `plan:223e4567-e89b-42d3-a456-${suffix}`, title: `Archive ${index}`, status: "complete", created: `2026-06-${String(index + 1).padStart(2, "0")}` },
        tasks: [{ ...task(1), status: "complete" }],
      }));
    }
    const result = capturePlan(root, ["--format", "json"]);
    expect(result.rc).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload.plan_catalog).toMatchObject({
      omitted: true,
      omitted_count: 3,
      omission_reason: "archive_catalog_limit",
      retrieval: {
        list: "agentera state plan list --format json",
        get: "agentera state plan get --plan PLAN_ID --format json",
      },
    });
    expect(payload.source).toMatchObject({
      archive_paths_omitted: true,
      archive_paths_omitted_count: 2,
      archive_paths_omission_reason: "archive_path_catalog_limit",
      archive_paths_retrieval: {
        list: "agentera state plan list --format json",
        get: "agentera state plan get --plan PLAN_ID --format json",
      },
    });
  });

  it("keeps archive-only catalog omissions recoverable through executable list/get commands", () => {
    const root = project([task(1)]);
    const activePath = path.join(root, ".agentera", "plan.yaml");
    const archiveRoot = path.join(root, ".agentera", "archive");
    fs.mkdirSync(archiveRoot, { recursive: true });
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const suffix = index.toString(16).padStart(12, "0");
      const id = `plan:323e4567-e89b-42d3-a456-${suffix}`;
      ids.push(id);
      fs.writeFileSync(path.join(archiveRoot, `PLAN-only-${index}.yaml`), YAML.stringify({
        header: { id, title: `Archive only ${index}`, status: "complete", created: `2026-05-${String(index + 1).padStart(2, "0")}` },
        tasks: [{ ...task(1), status: "complete" }],
      }));
    }
    fs.rmSync(activePath);

    const legacy = capturePlan(root, ["--format", "json"]);
    expect(legacy.rc).toBe(0);
    const payload = JSON.parse(legacy.out);
    expect(payload.plan_catalog).toMatchObject({
      omitted: true,
      omitted_count: 2,
      omission_reason: "archive_catalog_limit",
      retrieval: {
        list: "agentera state plan list --format json",
        get: "agentera state plan get --plan PLAN_ID --format json",
      },
    });
    const listed = capturePlan(root, ["list", "--format", "json"]);
    expect(listed.rc).toBe(0);
    expect(JSON.parse(listed.out).entries).toHaveLength(12);
    const fetched = capturePlan(root, ["get", "--plan", ids[0]!, "--format", "json"]);
    expect(fetched.rc).toBe(0);
    expect(JSON.parse(fetched.out).entry.stable_id).toBe(ids[0]);
  });

  it("validates a cursor plan selector before ordinary selector resolution", () => {
    const root = project([task(1), task(2)]);
    const first = JSON.parse(capture(root, ["list", "--limit", "1", "--format", "json"]).out);
    const wrongPlan = "plan:923e4567-e89b-42d3-a456-426614174000";
    const wrongCursorSelector = capture(root, ["list", "--plan", wrongPlan, "--cursor", first.next_cursor, "--format", "json"]);
    expect(wrongCursorSelector.rc).toBe(2);
    expect(JSON.parse(wrongCursorSelector.out).error.class).toBe("cursor_invalid");

    const ordinaryNotFound = capture(root, ["list", "--plan", wrongPlan, "--format", "json"]);
    expect(ordinaryNotFound.rc).toBe(1);
    expect(JSON.parse(ordinaryNotFound.out).error.class).toBe("not_found");
  });

  it("renders complete Unicode task scalars without ellipsis when the whole row fits", () => {
    const longName = `Boundary ${"🙂漢字é".repeat(300)}`;
    const root = project([{ ...task(1), name: longName, title: "Complete title" }]);
    const result = capturePlan(root, []);
    expect(result.rc).toBe(0);
    expect(result.out).toContain(`name=${longName}`);
    expect(result.out).toContain("title=Complete title");
    expect(result.out).not.toContain("...");
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32768);
  });

  it("omits an entire oversized text row with recovery instead of truncating a scalar", () => {
    const oversizedName = `Oversized ${"🙂漢字é".repeat(5000)}`;
    const root = project([{ ...task(1), name: oversizedName }]);
    const result = capturePlan(root, []);
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32768);
    expect(result.out).not.toContain("Oversized");
    expect(result.out).not.toContain("...");
    expect(result.out).toContain("Tasks omitted: 1 | reason=text_output_byte_budget");
    expect(result.out).toContain("Continue: agentera state plan tasks list --format json");
    expect(result.out).toContain("Get one: agentera state plan tasks get --task N --format json");
  });

  it("omits an oversized non-task scalar with exact plan recovery", () => {
    const root = project([task(1)]);
    const planPath = path.join(root, ".agentera", "plan.yaml");
    const plan = YAML.parse(fs.readFileSync(planPath, "utf8"));
    plan.what = `Whole plan scalar ${"🙂漢字é".repeat(5000)}`;
    fs.writeFileSync(planPath, YAML.stringify(plan));
    const result = capturePlan(root, []);
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32768);
    expect(result.out).not.toContain("Whole plan scalar");
    expect(result.out).not.toContain("...");
    expect(result.out).toContain("Plan fields omitted: 1 | reason=text_output_byte_budget");
    expect(result.out).toContain(`Get plan: agentera state plan get --plan ${planId} --format json`);
  });

  it("combines the ten-row count limit with the total text byte bound", () => {
    const tasks = Array.from({ length: 12 }, (_, index) => ({
      ...task(index + 1),
      name: index === 9 ? `Large ${"é🙂漢字".repeat(3500)}` : `Whole task ${index + 1}`,
    }));
    const root = project(tasks);
    const result = capturePlan(root, []);
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(32768);
    expect(result.out).not.toContain("name=Large ");
    expect(result.out).not.toContain("...");
    expect(result.out).toContain("Tasks omitted: 3 | reason=text_projection_limit_and_output_byte_budget");
  });

  it("invalidates a continuation when an existing task changes but excludes later appends", () => {
    const root = project([task(1), task(2), task(3)]);
    const first = JSON.parse(capture(root, ["list", "--limit", "1", "--format", "json"]).out);
    const planPath = path.join(root, ".agentera", "plan.yaml");
    const plan = YAML.parse(fs.readFileSync(planPath, "utf8"));
    plan.tasks.push(task(4));
    fs.writeFileSync(planPath, YAML.stringify(plan));
    const continued = capture(root, ["list", "--cursor", first.next_cursor, "--limit", "10", "--format", "json"]);
    expect(continued.rc).toBe(0);
    expect(JSON.parse(continued.out).entries.map((entry: any) => entry.task_number)).toEqual([2, 3]);

    plan.tasks[1].name = "Changed task";
    fs.writeFileSync(planPath, YAML.stringify(plan));
    const unavailable = capture(root, ["list", "--cursor", first.next_cursor, "--format", "json"]);
    expect(unavailable.rc).toBe(1);
    expect(JSON.parse(unavailable.out).error.class).toBe("cursor_snapshot_unavailable");
  });
});
