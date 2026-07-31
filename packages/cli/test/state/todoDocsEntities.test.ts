import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { mutateTodoDocsEntity } from "../../src/state/todoDocsEntities.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { writeMigratedDecisionAndProgressSummaries } from "../helpers/migratedSummaryFixture.js";
import { collectEntityOrientation } from "../../src/cli/commands/prime/collectEntityOrientation.js";
import { closeoutTodoBlockers } from "../../src/cli/capabilityContext/closeout.js";

const roots: string[] = [];
const MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-todo-docs-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  if (entity) fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), MARKER);
  fs.writeFileSync(path.join(root, "TODO.md"), "# legacy TODO sentinel\n");
  fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({
    last_audit: "2026-07-17 (fixture)",
    conventions: { doc_root: ".", style: "concise" },
    mapping: [{ artifact: "TODO.md", path: "TODO.md", producers: ["build"] }],
    coverage: { documented: 1, undocumented: 0, stale: 0, tests: "covered" },
    index: [{ document: "legacy sentinel", path: "legacy.md", last_updated: "2026-01-01", status: "stale" }],
    audit_log: [{ date: "2026-07-17", label: "editorial singleton", findings: [] }],
  }));
  return root;
}

function capture(root: string, args: string[], input?: Record<string, unknown>): { rc: number; out: string; err: string; json: any } {
  const cwd = process.cwd(); let out = ""; let err = ""; process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: input ? () => dumpYamlMapping(input) : undefined });
    return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
  } finally { process.chdir(cwd); }
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else result[path.relative(root, target)] = fs.readFileSync(target, "utf8");
    }
  };
  walk(root);
  return result;
}

function recoveryFiles(root: string): string[] {
  const recovery = path.join(root, ".agentera/.entity-recovery"); if (!fs.existsSync(recovery)) return [];
  return fs.readdirSync(recovery, { recursive: true, encoding: "utf8" }).map((name) => path.join(recovery, name)).filter((file) => path.basename(file) !== ".gitignore" && fs.statSync(file).isFile());
}

function todo(root: string, title: string, severity = "normal"): any {
  const result = capture(root, ["state", "todo", "create", "--input", "-", "--format", "json"], {
    kind: "task", target_version: "3.0.0", title, requirements: [], acceptance: [], release_blocker: false, severity,
  });
  expect(result.rc, result.err || result.out).toBe(0); return result.json;
}

function readinessInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values = {
    capability: "build",
    reason: "The implementation boundary is ready.",
    queue_rank: 1,
    orderReason: "Highest-value ready work.",
    ...overrides,
  };
  return { capability: values.capability, reason: values.reason, dependencies: [], blocked: null, gate: null, queue_rank: values.queue_rank, order_reason: values.orderReason };
}

function doc(root: string, document: string, filePath: string, status = "current"): any {
  const result = capture(root, ["state", "docs", "create", "--input", "-", "--format", "json"], { document, path: filePath, last_updated: "2026-07-17", status });
  expect(result.rc, result.err || result.out).toBe(0); return result.json;
}

function git(root: string, ...args: string[]): string {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(() => { vi.restoreAllMocks(); while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("TODO item and documentation inventory entity authority", () => {
  it("discovers and round-trips canonical readiness through create, list, and exact get", () => {
    const root = project();
    const dependency = todo(root, "Prepare the boundary");
    const explain = capture(root, ["state", "todo", "explain", "--verb", "create", "--format", "json"]);
    expect(explain.json.input_schema.typed_fields).toEqual(expect.arrayContaining(["kind", "title", "readiness"]));
    expect(explain.json.guidance.join(" ")).toContain("full typed TODO record");

    const created = capture(root, ["state", "todo", "create", "--input", "-", "--format", "json"], {
      kind: "fix", target_version: "3.0.0", title: "Implement the boundary", requirements: [], acceptance: [], release_blocker: false, severity: "normal",
      readiness: { ...readinessInput(), dependencies: [dependency.id], gate: { state: "satisfied", reason: "Review complete", recovery: "Re-review if changed" } },
    });
    expect(created.rc, created.err || created.out).toBe(0);
    const readiness = {
      capability: "build",
      reason: "The implementation boundary is ready.",
      dependencies: [{ artifact: "todo", id: dependency.id }],
      blocked: null,
      gate: { state: "satisfied", reason: "Review complete", recovery: "Re-review if changed" },
      queue_rank: 1,
      order_reason: "Highest-value ready work.",
    };
    expect(created.json.record.readiness).toEqual(readiness);
    expect(capture(root, ["state", "todo", "get", "--id", created.json.id, "--format", "json"]).json.entry.record.readiness).toEqual(readiness);

    const updated = capture(root, ["state", "todo", "update", "--id", created.json.id, "--input", "-", "--format", "json"], {
      readiness: { ...readinessInput({ capability: "discuss", reason: "A decision is required.", queue_rank: 2, orderReason: "Resolve intent before implementation." }), blocked: { reason: "Decision missing", recovery: "Run agentera discuss" } },
    });
    expect(updated.rc, updated.err || updated.out).toBe(0);
    const updatedReadiness = {
      capability: "discuss",
      reason: "A decision is required.",
      dependencies: [],
      blocked: { reason: "Decision missing", recovery: "Run agentera discuss" },
      gate: null,
      queue_rank: 2,
      order_reason: "Resolve intent before implementation.",
    };
    expect(updated.json.record.readiness).toEqual(updatedReadiness);
    const listed = capture(root, ["state", "todo", "list", "--format", "json"]);
    expect(listed.json.entries.find((entry: any) => entry.id === created.json.id).record.readiness).toEqual(updatedReadiness);
    expect(capture(root, ["state", "todo", "get", "--id", created.json.id, "--format", "json"]).json.entry.record.readiness).toEqual(updatedReadiness);
  });

  it("publishes the typed record contract, patch clears, lifecycle transitions, and public conflicts", () => {
    const root = project();
    const input = path.join(root, "todo.yaml");
    fs.writeFileSync(input, dumpYamlMapping({ kind: "fix", target_version: "3.0.0", title: "Typed boundary", requirements: ["Use typed input"], acceptance: ["Preserve omissions"], release_blocker: true, severity: "normal", readiness: { ...readinessInput(), gate: null } }));
    const created = capture(root, ["state", "todo", "create", "--input", input, "--format", "json"]);
    expect(created.rc, created.err).toBe(0);
    const id = created.json.id;
    expect(created.json.record).toMatchObject({ kind: "fix", target_version: "3.0.0", title: "Typed boundary", requirements: ["Use typed input"], acceptance: ["Preserve omissions"], release_blocker: true, severity: "normal", status: "open" });
    expect(created.json.record).not.toHaveProperty("description");
    expect(capture(root, ["state", "todo", "--format", "text"]).out).toContain(`[normal] ${id} open: [fix:3.0.0] Typed boundary`);

    const omitted = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { title: "Typed boundary v2" });
    expect(omitted.rc).toBe(0);
    expect(omitted.json.record.readiness).toEqual(created.json.record.readiness);
    const cleared = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { target_version: null, requirements: [], acceptance: [], release_blocker: false });
    expect(cleared.rc).toBe(0);
    expect(cleared.json.record).toMatchObject({ title: "Typed boundary v2", release_blocker: false, requirements: [], acceptance: [] });
    expect(cleared.json.record).not.toHaveProperty("target_version");
    const replay = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { target_version: null, requirements: [], acceptance: [], release_blocker: false });
    expect(replay.json.operation.idempotent_replay).toBe(true);

    const beforeLifecycle = fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`));
    const contentLifecycle = capture(root, ["state", "todo", "resolve", "--id", id, "--reason", "closed", "--date", "2026-07-31", "--input", "-", "--format", "json"], {});
    expect(contentLifecycle.rc).toBe(2); expect(contentLifecycle.json.error.class).toBe("mutually_exclusive"); expect(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`))).toEqual(beforeLifecycle);
    const owned = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { status: "resolved" });
    expect(owned.rc).toBe(2); expect(owned.json.error.class).toBe("schema_violation");
    const graphBefore = fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`));
    const graph = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { readiness: { ...readinessInput(), dependencies: [id] } });
    expect(graph.rc).toBe(2); expect(graph.json.error.class).toBe("schema_violation"); expect(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`))).toEqual(graphBefore);

    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Normal\n- [ ] [id:${id}] [fix] Typed boundary v2\n`);
    const divergent = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { title: "Divergent public title" });
    expect(divergent.rc).toBe(2); expect(divergent.json.error.class).toBe("conflict"); expect(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`))).toEqual(beforeLifecycle);

    fs.writeFileSync(path.join(root, "TODO.md"), "# TODO\n");
    const resolved = capture(root, ["state", "todo", "resolve", "--id", id, "--reason", "closed", "--date", "2026-07-31", "--format", "json"]);
    expect(resolved.rc).toBe(0); expect(resolved.json.record.lifecycle).toMatchObject({ operation: "resolve", reason: "closed", date: "2026-07-31" });
    const resolvedReplay = capture(root, ["state", "todo", "resolve", "--id", id, "--reason", "closed", "--date", "2026-07-31", "--format", "json"]);
    expect(resolvedReplay.rc).toBe(0); expect(resolvedReplay.json.operation.idempotent_replay).toBe(true);
    const reopened = capture(root, ["state", "todo", "reopen", "--id", id, "--reason", "scope returned", "--date", "2026-07-31", "--format", "json"]);
    expect(reopened.rc).toBe(0); expect(reopened.json.record.status).toBe("open");
    const reopenedReplay = capture(root, ["state", "todo", "reopen", "--id", id, "--reason", "scope returned", "--date", "2026-07-31", "--format", "json"]);
    expect(reopenedReplay.rc).toBe(0); expect(reopenedReplay.json.operation.idempotent_replay).toBe(true);
  });

  it("replays all TODO lifecycle transitions exactly and rejects divergent retries without effects", () => {
    const root = project();
    const entityFile = (id: string): string => path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`);
    const persistedRecord = (id: string): Record<string, unknown> => loadYamlMapping(fs.readFileSync(entityFile(id), "utf8")).record as Record<string, unknown>;
    const assertReplayAndConflict = (
      id: string,
      exact: string[],
      divergent: string[][],
      expected: Record<string, unknown>,
    ): void => {
      const before = fs.readFileSync(entityFile(id));
      const replay = capture(root, exact);
      expect(replay.rc, replay.err || replay.out).toBe(0);
      expect(replay.json).toMatchObject({
        status: "pass",
        id,
        record: expected,
        operation: { dry_run: false, idempotent_replay: true },
        validation: { status: "pass", violations: [] },
      });
      expect(replay.json.record).toEqual(persistedRecord(id));
      expect(fs.readFileSync(entityFile(id))).toEqual(before);

      for (const retry of divergent) {
        const conflict = capture(root, retry);
        expect(conflict.rc).toBe(2);
        expect(conflict.json).toMatchObject({
          status: "fail",
          error: { class: "conflict", recovery: expect.stringMatching(/exact|Reopen/) },
        });
        expect(fs.readFileSync(entityFile(id))).toEqual(before);
        expect(persistedRecord(id)).toEqual(replay.json.record);
      }
    };

    const severity = todo(root, "Severity replay");
    const setSeverity = ["state", "todo", "set-severity", "--id", severity.id, "--severity", "critical", "--reason", "Immediate impact", "--date", "2026-07-31", "--format", "json"];
    const severityApplied = capture(root, setSeverity);
    expect(severityApplied.rc, severityApplied.err || severityApplied.out).toBe(0);
    expect(severityApplied.json.operation.idempotent_replay).toBe(false);
    assertReplayAndConflict(severity.id, setSeverity, [setSeverity.map((value) => value === "critical" ? "degraded" : value)], {
      severity: "critical",
      lifecycle: { operation: "set-severity", reason: "Immediate impact", date: "2026-07-31" },
    });

    const superseded = todo(root, "Supersession replay");
    const replacement = todo(root, "First replacement");
    const otherReplacement = todo(root, "Second replacement");
    const supersede = ["state", "todo", "supersede", "--id", superseded.id, "--replacement", replacement.id, "--reason", "Replaced safely", "--date", "2026-07-31", "--format", "json"];
    const supersedeApplied = capture(root, supersede);
    expect(supersedeApplied.rc, supersedeApplied.err || supersedeApplied.out).toBe(0);
    expect(supersedeApplied.json.operation.idempotent_replay).toBe(false);
    assertReplayAndConflict(superseded.id, supersede, [
      supersede.map((value) => value === replacement.id ? otherReplacement.id : value),
      supersede.map((value) => value === "Replaced safely" ? "Different rationale" : value),
      supersede.map((value) => value === "2026-07-31" ? "2026-08-01" : value),
    ], {
      status: "resolved",
      lifecycle: { operation: "supersede", replacement: replacement.id, reason: "Replaced safely", date: "2026-07-31" },
    });

    const resolved = todo(root, "Resolve replay");
    const resolve = ["state", "todo", "resolve", "--id", resolved.id, "--reason", "Work complete", "--date", "2026-07-31", "--format", "json"];
    const resolveApplied = capture(root, resolve);
    expect(resolveApplied.rc, resolveApplied.err || resolveApplied.out).toBe(0);
    expect(resolveApplied.json.operation.idempotent_replay).toBe(false);
    assertReplayAndConflict(resolved.id, resolve, [
      resolve.map((value) => value === "Work complete" ? "Different closeout" : value),
      resolve.map((value) => value === "2026-07-31" ? "2026-08-01" : value),
    ], {
      status: "resolved",
      lifecycle: { operation: "resolve", reason: "Work complete", date: "2026-07-31" },
    });

    const reopened = todo(root, "Reopen replay");
    expect(capture(root, ["state", "todo", "resolve", "--id", reopened.id, "--reason", "Initial closeout", "--date", "2026-07-30", "--format", "json"]).rc).toBe(0);
    const reopen = ["state", "todo", "reopen", "--id", reopened.id, "--reason", "Scope returned", "--date", "2026-07-31", "--format", "json"];
    const reopenApplied = capture(root, reopen);
    expect(reopenApplied.rc, reopenApplied.err || reopenApplied.out).toBe(0);
    expect(reopenApplied.json.operation.idempotent_replay).toBe(false);
    assertReplayAndConflict(reopened.id, reopen, [
      reopen.map((value) => value === "Scope returned" ? "Different reopening" : value),
      reopen.map((value) => value === "2026-07-31" ? "2026-08-01" : value),
    ], {
      status: "open",
      lifecycle: { operation: "reopen", reason: "Scope returned", date: "2026-07-31" },
    });
  });

  it("uses the docs-mapped TODO path as the public authority", () => {
    const root = project();
    const created = todo(root, "Mapped public title");
    const mapped = path.join(root, "mapped", "TODO.md");
    fs.mkdirSync(path.dirname(mapped), { recursive: true });
    fs.writeFileSync(mapped, `# TODO\n\n## → Normal\n- [ ] [id:${created.id}] [task:3.0.0] Mapped public title\n`);
    fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/TODO.md", producers: ["build"] }] }));
    const before = fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${created.id}.yaml`));
    const result = capture(root, ["state", "todo", "update", "--id", created.id, "--input", "-", "--format", "json"], { title: "Bypass attempt" });
    expect(result.rc).toBe(2);
    expect(result.json.error.class).toBe("conflict");
    expect(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${created.id}.yaml`))).toEqual(before);
  });

  it("rejects retired description, invalid UTF-8, and over-bound lifecycle reasons before effects", () => {
    const root = project();
    const created = todo(root, "Validation boundary");
    const retired = capture(root, ["state", "todo", "update", "--id", created.id, "--input", "-", "--format", "json"], { description: "retired" });
    expect(retired.rc).toBe(2);
    expect(retired.json.error.class).toBe("schema_violation");
    const invalidInput = path.join(root, "invalid.yaml");
    fs.writeFileSync(invalidInput, Buffer.from([0x6b, 0x3a, 0x20, 0xc3, 0x28]));
    const invalid = capture(root, ["state", "todo", "create", "--input", invalidInput, "--format", "json"]);
    expect(invalid.rc).toBe(2);
    expect(invalid.json.error.class).toBe("invalid_format");
    const longReason = capture(root, ["state", "todo", "resolve", "--id", created.id, "--reason", "a".repeat(501), "--date", "2026-07-31", "--format", "json"]);
    expect(longReason.rc).toBe(2);
    expect(longReason.json.error.class).toBe("schema_violation");
    expect(capture(root, ["state", "todo", "get", "--id", created.id, "--format", "json"]).json.entry.record.status).toBe("open");
  });

  it("projects typed TODO fields and filters closeout blockers by selected target", () => {
    const root = project();
    const selected = capture(root, ["state", "todo", "create", "--input", "-", "--format", "json"], {
      kind: "fix", target_version: "3.0.0", title: "Selected blocker", requirements: ["r"], acceptance: ["a"], release_blocker: true, severity: "normal",
    });
    const other = capture(root, ["state", "todo", "create", "--input", "-", "--format", "json"], {
      kind: "fix", target_version: "2.7.7", title: "Other blocker", requirements: [], acceptance: [], release_blocker: true, severity: "normal",
    });
    expect(selected.rc).toBe(0); expect(other.rc).toBe(0);
    const projection = collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"));
    const item = projection.todoItems.find((candidate) => candidate.id === selected.json.id);
    expect(item).toMatchObject({ title: "Selected blocker", target_version: "3.0.0", release_blocker: true, text: "[fix:3.0.0] Selected blocker" });
    const closeout = closeoutTodoBlockers({}, projection.todoItems, "3.0.0");
    expect(closeout.open_count).toBe(1);
    expect((closeout.items as any[]).map((entry) => entry.id)).toEqual([selected.json.id]);
  });

  it("rejects invalid readiness inputs before publication with a working correction", () => {
    const root = project();
    const before = files(root);
    const cases = [
      ["capability", readinessInput({ capability: "status" })],
      ["dependency", { ...readinessInput(), dependencies: ["cccccccccc"] }],
      ["gate", { ...readinessInput(), gate: { state: "invented", reason: "why", recovery: "fix" } }],
      ["ordering", readinessInput({ queue_rank: 0 })],
    ] as const;
    for (const [name, readiness] of cases) {
      const result = capture(root, ["state", "todo", "create", "--input", "-", "--format", "json"], { kind: "task", target_version: "3.0.0", title: name, requirements: [], acceptance: [], release_blocker: false, severity: "normal", readiness });
      expect(result.rc, name).not.toBe(0);
      expect(result.json.error.class, name).toBe("schema_violation");
      expect(result.json.error.recovery ?? result.json.error.valid_values ?? result.json.error.syntax, name).toBeTruthy();
      expect(files(root), name).toEqual(before);
    }
  });

  it("preserves legacy meaning and unrelated fields across dry-run, replay, and pre-opened writer contexts", () => {
    const root = project();
    const item = todo(root, "Needs review", "normal");
    const pathToItem = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const ordinary = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Still needs review" });
    expect(ordinary.json).toMatchObject({ id: item.id, record: { severity: "normal", status: "open", title: "Still needs review" } });
    expect(ordinary.json.record).not.toHaveProperty("readiness");

    const beforeDryRun = fs.readFileSync(pathToItem);
    const dryRun = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--dry-run", "--format", "json"], { readiness: readinessInput() });
    expect(dryRun.json.operation).toMatchObject({ dry_run: true, idempotent_replay: false });
    expect(fs.readFileSync(pathToItem)).toEqual(beforeDryRun);

    const first = detectStateModeBinding(root); const second = detectStateModeBinding(root);
    if (first.mode !== "entities" || second.mode !== "entities") throw new Error("entity mode expected");
    try {
      const updateSpec = operationSpec("todo", "update")!;
      mutateTodoDocsEntity({ artifact: "todo", spec: updateSpec, projectRoot: root, dryRun: false, force: false, values: { id: item.id, severity: "critical" }, callerPayload: {}, input: null }, { publicationContext: first.publicationContext });
      mutateTodoDocsEntity({ artifact: "todo", spec: updateSpec, projectRoot: root, dryRun: false, force: false, values: { id: item.id, readiness: { capability: "build", reason: "Ready now.", dependencies: [], queue_rank: 1, order_reason: "Reviewed first." } }, callerPayload: {}, input: null }, { publicationContext: second.publicationContext });
    } finally {
      first.publicationContext.close(); second.publicationContext.close();
    }
    const current = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]).json.entry.record;
    expect(current).toMatchObject({ severity: "critical", status: "open", title: "Still needs review", readiness: { capability: "build", blocked: null, gate: null } });
    const replay = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ reason: "Ready now.", orderReason: "Reviewed first." }) });
    expect(replay.json.operation.idempotent_replay).toBe(true);
  });

  it("creates, updates, and resolves one canonical entity without touching either legacy aggregate", () => {
    const root = project();
    const todoBytes = fs.readFileSync(path.join(root, "TODO.md"));
    const docsBytes = fs.readFileSync(path.join(root, ".agentera/docs.yaml"));
    const item = todo(root, "Ship entity-backed TODOs");
    const inventory = doc(root, "CLI guide", "docs/cli.md");
    expect(item).toMatchObject({ artifact: "todo", id: expect.stringMatching(/^[a-z]{10}$/), record: { severity: "normal", status: "open", title: "Ship entity-backed TODOs" } });
    expect(inventory).toMatchObject({ artifact: "docs", id: expect.stringMatching(/^[a-z]{10}$/), record: { document: "CLI guide", path: "docs/cli.md", status: "current" } });
    expect(capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { severity: "degraded", title: "Ship safely" }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "resolve", "--id", item.id, "--reason", "Shipped", "--date", "2026-07-31", "--format", "json"]).json.record.status).toBe("resolved");
    expect(capture(root, ["state", "docs", "update", "--id", inventory.id, "--input", "-", "--format", "json"], { document: "CLI guide", path: "docs/cli.md", last_updated: "2026-07-18", status: "stale" }).rc).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(todoBytes);
    expect(fs.readFileSync(path.join(root, ".agentera/docs.yaml"))).toEqual(docsBytes);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
  });

  it("updates a valid noncanonical TODO through the public writer and publishes canonical bytes", () => {
    const root = project(); const id = "ldzkfdcopb"; const file = path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`);
    const noncanonical = `id: ${id}\nartifact: todo\nrecord:\n  severity: normal\n  status: resolved\n  description: "[feat:3.0.0] Resolved 2026-07-26: Shipped the shared glossary-entry primitive, personal and project ownership contracts, canonical project identity and conformance, deferred capability alignment, development metadata, and source/package verification. Confidence remains protocol CS1-CS5; personal evidence uses bounded history, project evidence uses repository-file provenance, and collision/review behavior remains consumer-owned. Producers remain deferred and open; no producer, persistence, lookup, or live project glossary exists."\n  readiness:\n    capability: plan\n    reason: Shared semantics and ownership shipped as the prerequisite for both glossary producers and their consumer.\n    dependencies: []\n    blocked: null\n    gate: null\n    queue_rank: 1\n    order_reason: Resolved prerequisite; downstream order is owned by the open producer and consumer TODOs.\n`.replaceAll("\n", "\r\n");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, noncanonical);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
    expect(dumpYamlMapping(loadYamlMapping(noncanonical))).not.toBe(noncanonical);

    const beforeDryRun = fs.readFileSync(file);
    const dryRun = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--dry-run", "--format", "json"], { title: "Shipped and synchronized." });
    expect(dryRun.rc, dryRun.err || dryRun.out).toBe(0);
    expect(fs.readFileSync(file)).toEqual(beforeDryRun);

    const updated = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { title: "Shipped and synchronized." });
    expect(updated.rc, updated.err || updated.out).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(dumpYamlMapping({ id, artifact: "todo", record: updated.json.record }));
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it("rejects a target byte change after discovery without overwriting the concurrent owner", () => {
    const root = project(); const item = todo(root, "Original owner"); const file = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const competingBytes = dumpYamlMapping({ id: item.id, artifact: "todo", record: { ...item.record, title: "Concurrent owner" } });
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.replaceExisting.bind(binding.publicationContext);
    vi.spyOn(binding.publicationContext, "replaceExisting").mockImplementation((...args) => { fs.writeFileSync(file, competingBytes); return original(...args); });
    const spec = operationSpec("todo", "update")!;
    const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id, description: "Writer update" }, callerPayload: { id: item.id, description: "Writer update" }, input: null };
    let failure: unknown;
    try { mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext }); }
    catch (error) { failure = error; }
    finally { binding.publicationContext.close(); }

    expect(String(failure)).toMatch(/ownership changed before replacement/);
    expect(fs.readFileSync(file, "utf8")).toBe(competingBytes);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp") || name.includes(".previous"))).toEqual([]);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it("preserves an in-place competitor write that lands while replacement bytes are staged", () => {
    const root = project(); const item = todo(root, "Initial owner"); const file = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const baselineBytes = fs.readFileSync(file);
    const competingBytes = dumpYamlMapping({ id: item.id, artifact: "todo", record: { ...item.record, title: "Competing in-place write" } });
    const originalWrite = fs.writeFileSync.bind(fs); let injected = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      const result = originalWrite(target, data, options as never);
      if (!injected && typeof target === "number") {
        let descriptorPath = ""; try { descriptorPath = fs.readlinkSync(`/proc/self/fd/${target}`); } catch { /* not the replacement stage */ }
        if (descriptorPath.includes("/.entity-recovery/entity-") && descriptorPath.endsWith("replacement.tmp")) { injected = true; originalWrite(file, competingBytes); }
      }
      return result as never;
    });

    const updated = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Writer replacement" });
    expect(injected).toBe(true);
    expect(updated.rc).toBe(1);
    expect(updated.json?.error?.message ?? updated.err).toMatch(/competitor.*baseline snapshot|baseline snapshot.*competitor/i);
    expect(fs.readFileSync(file, "utf8")).toBe(competingBytes);
    const snapshots = recoveryFiles(root).filter((candidate) => candidate.endsWith("original.previous")); expect(snapshots).toHaveLength(1); expect(fs.readFileSync(snapshots[0])).toEqual(baselineBytes);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp") || name.includes(".previous") || name.includes(".displaced"))).toEqual([]);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it("rejects invalid UTF-8 through validation, reads, and updates without changing source bytes", () => {
    const root = project(); const id = "cccccccccc"; const file = path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`);
    const invalid = Buffer.concat([
      Buffer.from(`id: ${id}\nartifact: todo\nrecord:\n  severity: normal\n  status: open\n  description: "invalid `),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(` bytes"\n`),
    ]);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, invalid); const before = fs.readFileSync(file);

    const validation = capture(root, ["check", "validate", "state", "--format", "json"]);
    expect(validation.rc).toBe(1);
    expect(validation.json.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "malformed_entity", path: expect.stringContaining(`${id}.yaml`), message: expect.stringMatching(/valid UTF-8/i), recovery: expect.stringMatching(/UTF-8 YAML/i) })]));
    expect(JSON.stringify(validation.json)).not.toContain('"type":"Buffer"');
    const read = capture(root, ["state", "todo", "get", "--id", id, "--format", "json"]);
    const update = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { title: "Valid replacement description that must not publish." });
    expect(read.rc).toBe(1); expect(read.json.error).toMatchObject({ class: "corrupt", recovery: expect.stringContaining("check validate state") });
    expect(update.rc).toBeGreaterThan(0); expect(update.json.error).toMatchObject({ class: "conflict", recovery: expect.stringContaining("no state was changed") });
    expect(fs.readFileSync(file)).toEqual(before);
    expect(validateEntityState(root)).toMatchObject({ valid: false, entityCount: 1, issues: expect.arrayContaining([expect.objectContaining({ code: "malformed_entity" })]) });
  });

  it("creates a valid TODO when logical validation reaches migrated summary sources through the real root", () => {
    const root = project();
    writeMigratedDecisionAndProgressSummaries(root);
    const item = todo(root, "Publish beside migrated summaries");
    expect(item).toMatchObject({ id: expect.stringMatching(/^[a-z]{10}$/), record: { title: "Publish beside migrated summaries" } });
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 3 });
  });

  it("rolls back a TODO when a migrated summary source becomes a symlink after publication", () => {
    const root = project(); const { progressSource } = writeMigratedDecisionAndProgressSummaries(root);
    const unrelated = path.join(root, ".agentera/unrelated.txt"); fs.writeFileSync(unrelated, "preserve me\n");
    const external = path.join(root, "external-progress.yaml"); fs.writeFileSync(external, "archive: []\n");
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); let mutated = false;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => {
      const result = original(target, bytes);
      fs.rmSync(progressSource); fs.symlinkSync(external, progressSource); mutated = true;
      return result;
    });
    const spec = operationSpec("todo", "create")!;
    const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { severity: "normal", description: "unsafe source" }, callerPayload: { severity: "normal", description: "unsafe source" }, input: null };
    expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, candidate: () => "cccccccccc" })).toThrow(/migration_provenance|unsafe|symbolic link/i);
    binding.publicationContext.close();
    expect(mutated).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera/entities/todo/todo_item/cccccccccc.yaml"))).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("preserve me\n");
  });

  it("rejects a root ABA that hides invalid descriptor-pinned state during TODO postvalidation", () => {
    const container = project(false); const root = path.join(container, "project"); const held = path.join(container, "held"); const successor = path.join(container, "successor");
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), MARKER); fs.writeFileSync(path.join(root, "TODO.md"), "# original\n");
    fs.mkdirSync(path.join(successor, ".agentera/entities"), { recursive: true }); fs.writeFileSync(path.join(successor, ".agentera/unrelated.txt"), "successor bytes\n");
    const { progressSource } = writeMigratedDecisionAndProgressSummaries(root); const unrelated = path.join(root, ".agentera/unrelated.txt"); fs.writeFileSync(unrelated, "original bytes\n");
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const originalPublish = binding.publicationContext.publishImmutable.bind(binding.publicationContext); const originalReadDirectory = fs.readdirSync.bind(fs);
    let armed = false; let swapped = false;
    vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((target, bytes) => { const result = originalPublish(target, bytes); fs.writeFileSync(progressSource, "archive: []\n"); armed = true; return result; });
    vi.spyOn(fs, "readdirSync").mockImplementation((candidate, options) => {
      if (!armed || typeof candidate !== "string" || !candidate.endsWith("/.agentera/entities")) return originalReadDirectory(candidate, options);
      fs.renameSync(root, held); fs.renameSync(successor, root);
      try { swapped = true; return originalReadDirectory(candidate, options); }
      finally { fs.renameSync(root, successor); fs.renameSync(held, root); armed = false; }
    });
    const spec = operationSpec("todo", "create")!; const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { severity: "normal", description: "root ABA" }, callerPayload: { severity: "normal", description: "root ABA" }, input: null };
    let failure: unknown;
    try { mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, candidate: () => "cccccccccc" }); }
    catch (error) { failure = error; }
    finally { binding.publicationContext.close(); }
    expect(swapped).toBe(true); expect(String(failure)).toMatch(/migration_provenance|bind|changed|invalid/i);
    expect(fs.existsSync(path.join(root, ".agentera/entities/todo/todo_item/cccccccccc.yaml"))).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("original bytes\n");
    expect(fs.readFileSync(path.join(successor, ".agentera/unrelated.txt"), "utf8")).toBe("successor bytes\n");
  });

  it("rejects aliases and non-bare selectors before effects while marker-absent commands retain legacy behavior", () => {
    const root = project(); const item = todo(root, "valid"); const before = fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`));
    for (const id of ["1", "todo:abcdefghij", "abcdefghij/path", "TODO.md", "ABCDEFGHIJ"]) {
      const result = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { title: "invalid" });
      expect(result.rc).toBe(2); expect(result.json.error.class).toBe("invalid_request");
    }
    for (const alias of ["id", "artifact", "number", "stable_id", "artifact_id", "entry_number", "task_number", "experiment_number", "plan_id", "objective_id", "type_prefixed_id"]) {
      const result = capture(root, ["state", "docs", "create", "--input", "-", "--format", "json"], { document: "invalid", path: "invalid.md", last_updated: "2026-07-17", status: "current", [alias]: "forbidden" });
      expect(result.rc, alias).toBe(2); expect(result.json.error.class).toBe("schema_violation");
    }
    expect(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`))).toEqual(before);
    const legacy = project(false); const queried = capture(legacy, ["state", "todo", "--format", "json"]); expect(queried.rc).toBe(1); expect(queried.json.error.class).toBe("migration_required"); expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);
    const malformed = path.join(root, ".agentera/entities/docs/documentation_inventory_entry/bbbbbbbbbb.yaml"); fs.mkdirSync(path.dirname(malformed), { recursive: true }); fs.writeFileSync(malformed, "id: bbbbbbbbbb\nartifact: docs\nrecord:\n  document: bad\n  path: bad.md\n  last_updated: nope\n  status: invented\n  stable_id: alias\n"); expect(validateEntityState(root).valid).toBe(false); fs.rmSync(malformed);
    const duplicate = path.join(root, `.agentera/entities/docs/documentation_inventory_entry/${item.id}.yaml`); fs.copyFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`), duplicate); expect(validateEntityState(root).issues.some((issue) => issue.code === "duplicate_id")).toBe(true);
  });

  it("renders bounded deterministic views with snapshot cursors, provenance, and exact full recovery", () => {
    const root = project();
    const low = todo(root, "normal", "normal"); const high = todo(root, "critical", "critical");
    const firstDoc = doc(root, "Zulu", "z.md"); const secondDoc = doc(root, "Alpha", "a.md");
    const todoPage = capture(root, ["state", "todo", "list", "--limit", "1", "--format", "json"]);
    expect(todoPage.json).toMatchObject({ status: "degraded", order: "severity_then_status_then_id", omitted: true, omitted_count: 1, entries: [{ id: high.id, artifact: "todo", provenance: { storage: "canonical_entity_file" } }] });
    const todoGet = capture(root, ["state", "todo", "get", "--id", low.id, "--format", "json"]); expect(todoGet.json.entry.record.title).toBe("normal");
    const docsList = capture(root, ["state", "docs", "list", "--format", "json"]); expect(docsList.json.entries.map((entry: any) => entry.id)).toEqual([secondDoc.id, firstDoc.id]);
    const docsDefault = capture(root, ["state", "docs", "--format", "json"]); expect(docsDefault.json.entries).toHaveLength(2); expect(docsDefault.json.summary.mapping).toHaveLength(1); expect(JSON.stringify(docsDefault.json)).not.toContain("legacy sentinel");
    todo(root, "cursor invalidator"); const stale = capture(root, ["state", "todo", "list", "--limit", "1", "--cursor", todoPage.json.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
    const detail = "x".repeat(18_000); const large = todo(root, detail); todo(root, `y${detail}`); const bounded = capture(root, ["state", "todo", "list", "--limit", "100", "--format", "json"]); expect(Buffer.byteLength(bounded.out)).toBeLessThanOrEqual(32_768); expect(bounded.json).toMatchObject({ omitted: true, omission_reason: "serialized_byte_budget", retrieval: { get: "agentera state todo get --id ID --format json" } }); expect(capture(root, ["state", "todo", "get", "--id", large.id, "--format", "json"]).json.entry.record.title).toBe(detail);
    expect(capture(root, ["state", "docs", "get", "--id", secondDoc.id, "--format", "json"]).json.entry.record).toEqual({ document: "Alpha", path: "a.md", last_updated: "2026-07-17", status: "current" });
  });

  it("uses static final help and explain with bare IDs", () => {
    const root = project();
    const todoHelp = capture(root, ["state", "todo", "--help"]); const docsHelp = capture(root, ["state", "docs", "--help"]);
    expect(todoHelp.out).toContain("todo resolve|reopen --id ID --reason TEXT --date YYYY-MM-DD"); expect(todoHelp.out).toContain("todo create --input TODO.yaml"); expect(docsHelp.out).toContain("docs update --id ID"); expect(todoHelp.out + docsHelp.out).not.toContain("--number"); expect(docsHelp.out).toContain("path is record data, not identity");
    const explain = capture(root, ["state", "todo", "explain", "--verb", "update", "--format", "json"]); expect(explain.json.fields).toEqual(expect.arrayContaining([expect.objectContaining({ flag: "--id", required: true })])); expect(explain.json.example).toContain("--id qjtrmnpvka");
    expect(capture(root, ["schema", "--format", "json"]).json.state_writer.artifacts.map((artifact: any) => artifact.artifact)).toEqual(expect.arrayContaining(["todo", "docs"]));
    const legacy = project(false); expect(capture(legacy, ["state", "todo", "--help"]).out).toContain("todo create"); expect(capture(legacy, ["state", "todo", "explain", "--format", "json"]).json.example).toContain("todo create"); expect(capture(legacy, ["schema", "--format", "json"]).json.state_writer.artifacts.map((artifact: any) => artifact.artifact)).toEqual(expect.arrayContaining(["todo", "docs"]));
  });

  it("lets real Git worktrees merge unrelated additions and updates while same-entity updates conflict", () => {
    const root = project(); const leftItem = todo(root, "left base"); const rightDoc = doc(root, "right base", "right.md");
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", "."); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    expect(capture(left, ["state", "todo", "update", "--id", leftItem.id, "--input", "-", "--format", "json"], { title: "left update" }).rc).toBe(0); doc(left, "left addition", "left.md");
    expect(capture(right, ["state", "docs", "update", "--id", rightDoc.id, "--input", "-", "--format", "json"], { document: "right update", path: "right.md", last_updated: "2026-07-18", status: "current" }).rc).toBe(0); todo(right, "right addition");
    for (const checkout of [left, right]) { git(checkout, "add", ".agentera/entities"); git(checkout, "commit", "-m", path.basename(checkout)); }
    git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right"); expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
    const a = `${root}-a`, b = `${root}-b`; roots.push(a, b); git(root, "worktree", "add", "-b", "a", a, "main"); git(root, "worktree", "add", "-b", "b", b, "main");
    for (const [checkout, description] of [[a, "A"], [b, "B"]]) { expect(capture(checkout, ["state", "todo", "update", "--id", leftItem.id, "--input", "-", "--format", "json"], { title: description }).rc).toBe(0); git(checkout, "add", ".agentera/entities"); git(checkout, "commit", "-m", description); }
    git(root, "merge", "--no-edit", "a"); expect(() => git(root, "merge", "--no-edit", "b")).toThrow(); git(root, "merge", "--abort");
  });

  it("rolls back exact bytes on marker/root races and failed postvalidation", () => {
    for (const invalidation of ["marker", "root", "validation"] as const) {
      const root = project(); const item = todo(root, invalidation); const file = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`); const before = fs.readFileSync(file); const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.replaceExisting.bind(binding.publicationContext);
      vi.spyOn(binding.publicationContext, "replaceExisting").mockImplementation((...args) => { if (invalidation === "marker") fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), MARKER + "# changed\n"); else if (invalidation === "root") { const held = `${root}-held`; roots.push(held); fs.renameSync(root, held); fs.mkdirSync(root); } const result = original(...args); if (invalidation === "validation") { const bad = path.join(root, ".agentera/entities/docs/documentation_inventory_entry/bbbbbbbbbb.yaml"); fs.mkdirSync(path.dirname(bad), { recursive: true }); fs.writeFileSync(bad, "id: bbbbbbbbbb\nartifact: docs\nrecord: {}\n"); } return result; });
      const spec = operationSpec("todo", "update")!; const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id, description: "changed" }, callerPayload: { id: item.id, description: "changed" }, input: null };
      expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext })).toThrow(/changed|conflict|invalid/i); binding.publicationContext.close();
      const actualRoot = invalidation === "root" ? `${root}-held` : root; expect(fs.readFileSync(path.join(actualRoot, path.relative(root, file)))).toEqual(before);
    }
  });
});
