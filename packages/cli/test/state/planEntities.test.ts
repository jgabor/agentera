import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { createPlanEntities } from "../../src/state/planEntities.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { executeStateWrite } from "../../src/state/write/transaction.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";

const roots: string[] = [];

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-plan-entities-")); roots.push(root);
  if (entity) { fs.mkdirSync(path.join(root, ".agentera"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n"); }
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
function request(root: string, verb: string, values: Record<string, unknown> = {}, input: Record<string, unknown> | null = null): StateWriteRequest {
  const spec = operationSpec("plan", verb); if (!spec) throw new Error(`missing plan ${verb}`);
  return { artifact: "plan", spec, projectRoot: root, dryRun: false, force: false, values, callerPayload: structuredClone(input ?? values), input };
}
function git(root: string, ...args: string[]): string {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(() => { vi.restoreAllMocks(); while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("plan and task entity authority", () => {
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

  it("runs append, update, status, evaluation, lifecycle, and archive by entity selectors", () => {
    const root = project(); const created = create(root, "lifecycle"); const planId = created.id; const first = created.tasks[0].id;
    let result = capture(root, ["state", "plan", "append", "--plan", planId, "--name", "Added", "--depends-on", first, "--acceptance", "GIVEN first WHEN done THEN added runs", "--format", "json"]); expect(result.rc, result.err).toBe(0); const added = JSON.parse(result.out).id;
    result = capture(root, ["state", "plan", "update", "--plan", planId, "--id", added, "--name", "Updated", "--format", "json"]); expect(result.rc).toBe(0);
    result = capture(root, ["state", "plan", "update", "--plan", planId, "--id", added, "--surprise", "Observed in packages/cli/src/state/planEntities.ts", "--format", "json"]); expect(result.rc).toBe(0); expect(JSON.parse(result.out).record.surprises).toContain("planEntities.ts");
    result = capture(root, ["state", "plan", "record-evaluation", "--plan", planId, "--id", added, "--attempt-id", "audit-1", "--verdict", "pass", "--provenance", "test", "--format", "json"]); expect(result.rc).toBe(0);
    for (const id of [first, added]) { result = capture(root, ["state", "plan", "set-status", "--plan", planId, "--id", id, "--status", "complete", "--format", "json"]); expect(result.rc).toBe(0); }
    result = capture(root, ["state", "plan", "set-plan-status", "--plan", planId, "--status", "complete", "--format", "json"]); expect(result.rc).toBe(0);
    result = capture(root, ["state", "plan", "archive", "--plan", planId, "--format", "json"]); expect(result.rc).toBe(0); expect(JSON.parse(result.out).operation.idempotent_replay).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera/archive"))).toBe(false);
  });

  it("infers one open plan and reports zero or multiple open plans actionably", () => {
    const root = project(); const first = create(root, "first");
    expect(capture(root, ["state", "plan", "append", "--name", "Inferred", "--format", "json"]).rc).toBe(0);
    const second = create(root, "second");
    const ambiguous = capture(root, ["state", "plan", "append", "--name", "No owner", "--format", "json"]); expect(ambiguous.rc).toBe(1); expect(ambiguous.err).toMatch(new RegExp(`${first.id}.*${second.id}|${second.id}.*${first.id}`));
    expect(capture(root, ["state", "plan", "append", "--plan", second.id, "--name", "Explicit", "--format", "json"]).rc).toBe(0);
    const empty = project(); const missing = capture(empty, ["state", "plan", "append", "--name", "Missing", "--format", "json"]); expect(missing.rc).toBe(1); expect(missing.err).toMatch(/no open plan/i);
  });

  it("rejects missing, cross-plan, self, and cyclic dependencies without changing the task", () => {
    const root = project(); const left = create(root, "left", true); const right = create(root, "right"); const leftFirst = left.tasks[0].id; const leftSecond = left.tasks[1].id;
    for (const dependency of ["zzzzzzzzzz", right.tasks[0].id, leftSecond]) {
      const result = capture(root, ["state", "plan", "update", "--plan", left.id, "--id", leftFirst, "--depends-on", dependency, "--format", "json"]); expect(result.rc).not.toBe(0);
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

  it("provides full bounded plan/task snapshots and invalidates changed cursors", () => {
    const root = project(); const first = create(root, "first"); create(root, "second");
    const listed = capture(root, ["state", "plan", "list", "--limit", "1", "--format", "json"]); expect(listed.rc).toBe(0); const page = JSON.parse(listed.out); expect(page.entries[0]).toHaveProperty("record"); expect(page.next_cursor).toBeTruthy();
    const exact = capture(root, ["state", "plan", "get", "--id", first.id, "--format", "json"]); expect(exact.rc).toBe(0); expect(JSON.parse(exact.out).tasks[0].record).toBeTruthy();
    const tasks = capture(root, ["state", "plan", "tasks", "list", "--plan", first.id, "--format", "json"]); expect(tasks.rc).toBe(0); const taskId = JSON.parse(tasks.out).entries[0].id;
    expect(capture(root, ["state", "plan", "tasks", "get", "--plan", first.id, "--id", taskId, "--format", "json"]).rc).toBe(0);
    capture(root, ["state", "plan", "append", "--plan", first.id, "--name", "Changed snapshot", "--format", "json"]);
    const stale = capture(root, ["state", "plan", "list", "--limit", "1", "--cursor", page.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(JSON.parse(stale.out).error.class).toBe("cursor_snapshot_unavailable");
  });

  it("keeps legacy writes isolated and rejects numeric selectors in entity mode", () => {
    const entity = project(); const created = create(entity, "entity");
    expect(capture(entity, ["state", "plan", "set-status", "--task", "1", "--status", "complete", "--format", "json"]).rc).toBe(2);
    expect(capture(entity, ["state", "plan", "tasks", "get", "--task", "1", "--format", "json"]).rc).toBe(2);
    const legacy = project(false); const input = path.join(legacy, "legacy.yaml"); fs.writeFileSync(input, dumpYamlMapping(plan("legacy")));
    expect(capture(legacy, ["state", "plan", "create", "--input", input, "--format", "json"]).rc).toBe(0);
    expect(fs.existsSync(path.join(legacy, ".agentera/plan.yaml"))).toBe(true); expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);
    expect(created.id).toMatch(/^[a-z]{10}$/);
  });

  it("lets Git merge different tasks, conflicts on one task, and validates duplicate ownership", () => {
    const root = project(); const created = create(root, "merge"); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", ".agentera"); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    capture(left, ["state", "plan", "append", "--plan", created.id, "--name", "Left", "--format", "json"]); capture(right, ["state", "plan", "append", "--plan", created.id, "--name", "Right", "--format", "json"]); git(left, "add", ".agentera/entities"); git(left, "commit", "-m", "left"); git(right, "add", ".agentera/entities"); git(right, "commit", "-m", "right"); git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right"); expect(validateEntityState(root).valid).toBe(true);
    const taskPath = path.join(root, ".agentera/entities/plan/plan_task", `${created.tasks[0].id}.yaml`); const duplicate = path.join(root, ".agentera/entities/plan/plan", `${created.tasks[0].id}.yaml`); fs.copyFileSync(taskPath, duplicate); expect(validateEntityState(root).valid).toBe(false); fs.unlinkSync(duplicate);
    const conflictRoot = project(); const conflictPlan = create(conflictRoot, "conflict"); git(conflictRoot, "init", "-b", "main"); git(conflictRoot, "config", "user.name", "Fixture"); git(conflictRoot, "config", "user.email", "fixture@example.test"); git(conflictRoot, "add", ".agentera"); git(conflictRoot, "commit", "-m", "base");
    const a = `${conflictRoot}-a`, b = `${conflictRoot}-b`; roots.push(a, b); git(conflictRoot, "worktree", "add", "-b", "a", a, "main"); git(conflictRoot, "worktree", "add", "-b", "b", b, "main"); capture(a, ["state", "plan", "update", "--plan", conflictPlan.id, "--id", conflictPlan.tasks[0].id, "--name", "A", "--format", "json"]); capture(b, ["state", "plan", "update", "--plan", conflictPlan.id, "--id", conflictPlan.tasks[0].id, "--name", "B", "--format", "json"]); git(a, "add", ".agentera/entities"); git(a, "commit", "-m", "a"); git(b, "add", ".agentera/entities"); git(b, "commit", "-m", "b"); git(conflictRoot, "merge", "--ff-only", "a"); expect(() => git(conflictRoot, "merge", "--no-edit", "b")).toThrow();
  });
});
