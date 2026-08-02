import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, inject, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { FILE_REPLACEMENT_RECOVERY_VERSION } from "../../src/state/entityPublicationContext.js";
import { ExactReplacementConflictError } from "../../src/state/exactReplacementRecovery.js";
import { mutateTodoDocsEntity } from "../../src/state/todoDocsEntities.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { todoReconciliationActivationBytes, TODO_RECONCILIATION_ACTIVATION_PATH } from "../../src/state/todoReconciliationActivation.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";
import { writeMigratedDecisionAndProgressSummaries } from "../helpers/migratedSummaryFixture.js";
import { collectEntityOrientation } from "../../src/cli/commands/prime/collectEntityOrientation.js";
import { closeoutTodoBlockers } from "../../src/cli/capabilityContext/closeout.js";
import { evaluateTodoReadinessQueue } from "../../src/cli/todoReadinessSelection.js";
import { shellCommandArgs } from "../helpers/shellCommand.js";
import { decodeListCursor, encodeListCursor } from "../../src/state/listCursor.js";
import { loadStateStorageAuthority } from "../../src/state/stateStorageAuthority.js";
import { resolveSourceRoot } from "../../src/core/sourceRoot.js";

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

function seedTodoEntity(root: string, id: string, title: string, severity = "normal"): string {
  const target = path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, dumpYamlMapping({
    id,
    artifact: "todo",
    record: {
      kind: "task",
      target_version: "3.0.0",
      title,
      requirements: [],
      acceptance: [],
      release_blocker: false,
      severity,
      status: "open",
    },
  }));
  return target;
}

function seedAbsentTodoEntity(root: string, id: string, title: string, queueRank = 1): string {
  const target = seedTodoEntity(root, id, title);
  const envelope = loadYamlMapping(fs.readFileSync(target, "utf8"));
  (envelope.record as any).readiness = readinessInput({ queue_rank: queueRank });
  (envelope.record as any).reconciliation = {
    schema_version: "agentera.todoReconciliation.v1",
    public: { present: false },
  };
  fs.writeFileSync(target, dumpYamlMapping(envelope));
  return target;
}

function preactivationProject(id = "abcdefghij", title = "Legacy matched row"): { root: string; id: string; entity: string } {
  const root = project();
  const entity = seedTodoEntity(root, id, title);
  fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Normal\n- [ ] [task:3.0.0] ${title}\n- [ ] [note] Retained pre-activation note\n`);
  return { root, id, entity };
}

function readinessInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const values = {
    capability: "build",
    reason: "The implementation boundary is ready.",
    dependencies: [],
    blocked: null,
    gate: null,
    queue_rank: 1,
    orderReason: "Highest-value ready work.",
    ...overrides,
  };
  return { capability: values.capability, reason: values.reason, dependencies: values.dependencies, blocked: values.blocked, gate: values.gate, queue_rank: values.queue_rank, order_reason: values.orderReason };
}

function indexedId(index: number): string {
  let value = index;
  return Array.from({ length: 10 }, () => {
    const character = String.fromCharCode(97 + value % 26);
    value = Math.floor(value / 26);
    return character;
  }).reverse().join("");
}

function realisticTodoProject(count = 120): { root: string; orderedIds: string[]; criticalOpenIds: string[] } {
  const root = project();
  const sections: Record<"critical" | "normal" | "resolved", string[]> = { critical: [], normal: [], resolved: [] };
  const criticalOpenIds: string[] = [];
  const criticalResolvedIds: string[] = [];
  const normalOpenIds: string[] = [];
  const orders = { critical: 0, normal: 0, resolved: 0 };
  for (let index = 0; index < count; index += 1) {
    const id = indexedId(index);
    const resolved = index >= 100;
    const severity = index < 70 || resolved ? "critical" : "normal";
    const section = resolved ? "resolved" : severity;
    const status = resolved ? "resolved" : "open";
    const order = ++orders[section];
    const title = `Synchronize retrieval consumer ${String(index + 1).padStart(3, "0")}: ${"preserve deterministic bounded evidence and exact recovery without mutating project state; ".repeat(5).trim()}`;
    const publicDescription = `[fix:3.0.0] ${title}`;
    const record = {
      kind: "fix",
      target_version: "3.0.0",
      title,
      requirements: ["Retain every selected row", "Expose exact recovery"],
      acceptance: ["No skipped or duplicated row across continuation"],
      release_blocker: false,
      severity,
      status,
      readiness: {
        capability: "build",
        reason: "The bounded retrieval contract is ready for deterministic verification.",
        dependencies: [],
        blocked: null,
        gate: null,
        queue_rank: index + 1,
        order_reason: "Exercise realistic ordered TODO state.",
      },
      reconciliation: {
        schema_version: "agentera.todoReconciliation.v1",
        public: { present: true, description: publicDescription, severity, status, order },
      },
    };
    const directory = path.join(root, ".agentera/entities/todo/todo_item");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact: "todo", record }));
    sections[section].push(`- [${resolved ? "x" : " "}] [id:${id}] ${publicDescription}`);
    if (resolved) criticalResolvedIds.push(id);
    else if (severity === "critical") criticalOpenIds.push(id);
    else normalOpenIds.push(id);
  }
  fs.writeFileSync(path.join(root, TODO_RECONCILIATION_ACTIVATION_PATH), todoReconciliationActivationBytes([]));
  fs.writeFileSync(path.join(root, "TODO.md"), [
    "# TODO", "", "## ⇶ Critical", ...sections.critical, "", "## → Normal", ...sections.normal,
    "", "## ✓ Resolved", ...sections.resolved, "",
  ].join("\n"));
  return { root, orderedIds: [...criticalOpenIds, ...criticalResolvedIds, ...normalOpenIds], criticalOpenIds };
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
    const bareText = capture(root, ["state", "todo", "--format", "text"]);
    const explicitText = capture(root, ["state", "todo", "list", "--format", "text"]);
    expect(bareText).toEqual(explicitText);
    expect(bareText.out).toContain(`id: ${id}`);

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
    expect(divergent.rc).toBe(0); expect(divergent.json.record.title).toBe("Divergent public title"); expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain("Divergent public title");

    const resolved = capture(root, ["state", "todo", "resolve", "--id", id, "--reason", "closed", "--date", "2026-07-31", "--format", "json"]);
    expect(resolved.rc).toBe(0); expect(resolved.json.record.lifecycle).toMatchObject({ operation: "resolve", reason: "closed", date: "2026-07-31" });
    const resolvedReplay = capture(root, ["state", "todo", "resolve", "--id", id, "--reason", "closed", "--date", "2026-07-31", "--format", "json"]);
    expect(resolvedReplay.rc).toBe(0); expect(resolvedReplay.json.operation.idempotent_replay).toBe(true);
    fs.writeFileSync(path.join(root, "TODO.md"), "# TODO\n");
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

  it("uses the exact docs-mapped TODO path as the public authority", () => {
    const root = project();
    const created = todo(root, "Mapped public title");
    const mapped = path.join(root, "mapped", "WORK.md");
    fs.mkdirSync(path.dirname(mapped), { recursive: true });
    fs.writeFileSync(mapped, `# TODO\n\n## → Normal\n- [ ] [id:${created.id}] [task:3.0.0] Mapped public title\n`);
    fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/WORK.md", producers: ["build"] }] }));
    const result = capture(root, ["state", "todo", "update", "--id", created.id, "--input", "-", "--format", "json"], { title: "Bypass attempt" });
    expect(result.rc).toBe(0);
    expect(fs.readFileSync(mapped, "utf8")).toContain("Bypass attempt");
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain("Mapped public title");
  });

  it("rejects a cross-filesystem public mapping before journal or target effects", () => {
    const root = project(); const item = todo(root, "Cross-filesystem mapping");
    const mapped = path.join(root, "mapped", "WORK.md"); fs.mkdirSync(path.dirname(mapped), { recursive: true });
    fs.writeFileSync(mapped, `# TODO\n\n## → Normal\n- [ ] [id:${item.id}] [task:3.0.0] Cross-filesystem mapping\n`);
    fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/WORK.md", producers: ["build"] }] }));
    const before = files(root); const originalStat = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((candidate, options) => {
      const result = originalStat(candidate, options as never);
      if (path.resolve(String(candidate)) === path.dirname(mapped) && typeof result.dev === "bigint") return { ...result, dev: result.dev + 1n } as fs.BigIntStats;
      return result;
    });
    const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Must not publish" });
    expect(rejected.rc).toBe(2);
    expect(rejected.json.error).toMatchObject({ class: "unsupported_target", recovery: expect.stringContaining("no journal or target bytes were changed") });
    expect(files(root)).toEqual(before);
  });

  it("binds a pending transaction to the exact docs mapping snapshot", () => {
    const root = project(); const item = todo(root, "Mapped binding"); const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const spec = operationSpec("todo", "update")!; const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id }, callerPayload: {}, input: { title: "Pending mapped binding" } };
    expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, interruptAfterTarget: 0 })).toThrow(/interruption/); binding.publicationContext.close();
    fs.mkdirSync(path.join(root, "mapped"), { recursive: true }); fs.writeFileSync(path.join(root, "mapped/WORK.md"), fs.readFileSync(path.join(root, "TODO.md")));
    fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/WORK.md", producers: ["build"] }] }));
    const before = files(root); const retry = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Pending mapped binding" });
    expect(retry.rc).toBe(2); expect(retry.json.error).toMatchObject({ class: "conflict", recovery: expect.stringContaining("Restore the docs mapping") }); expect(files(root)).toEqual(before);
  });

  it("rolls back targets without overwriting concurrent mapping or activation changes at commit", () => {
    for (const competitor of ["mapping", "activation"] as const) {
      const root = project(); const item = todo(root, `Commit binding ${competitor}`);
      const mapped = path.join(root, "mapped", "WORK.md"); fs.mkdirSync(path.dirname(mapped), { recursive: true });
      const publicBefore = `# TODO\n\n## → Normal\n- [ ] [id:${item.id}] [task:3.0.0] Commit binding ${competitor}\n`;
      fs.writeFileSync(mapped, publicBefore);
      const docs = path.join(root, ".agentera/docs.yaml");
      fs.writeFileSync(docs, dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/WORK.md", producers: ["build"] }] }));
      const activation = path.join(root, ".agentera/todo-reconciliation-activation.json");
      const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
      const entityBefore = fs.readFileSync(entity);
      const competitorBytes = competitor === "mapping"
        ? dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "concurrent/WORK.md", producers: ["build"] }] })
        : `${JSON.stringify({ schema_version: "agentera.todoReconciliationActivation.v1", retained_legacy_rows: ["a".repeat(64)] })}\n`;
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const original = binding.publicationContext.replaceVisible.bind(binding.publicationContext);
      vi.spyOn(binding.publicationContext, "replaceVisible").mockImplementation((...args) => {
        const result = original(...args);
        fs.writeFileSync(competitor === "mapping" ? docs : activation, competitorBytes);
        return result;
      });
      const spec = operationSpec("todo", "update")!;
      const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id }, callerPayload: {}, input: { title: `Rejected ${competitor}` } };
      expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext })).toThrow(new RegExp(`${competitor} changed during transaction publication`));
      binding.publicationContext.close();
      expect(fs.readFileSync(mapped, "utf8")).toBe(publicBefore);
      expect(fs.readFileSync(entity)).toEqual(entityBefore);
      expect(fs.readFileSync(competitor === "mapping" ? docs : activation, "utf8")).toBe(competitorBytes);
    }
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

  it("uses the complete Markdown projection for production startup readiness and counts", () => {
    const root = project();
    const dependency = todo(root, "Resolved entity reopened by Markdown");
    const dependent = todo(root, "Must wait for projected dependency");
    const resolvedCandidate = todo(root, "Open entity resolved by Markdown");
    const fallback = todo(root, "Projected critical fallback");
    expect(capture(root, ["state", "todo", "resolve", "--id", dependency.id, "--reason", "fixture", "--date", "2026-08-02", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", dependent.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ dependencies: [{ artifact: "todo", id: dependency.id }], queue_rank: 1 }) }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", resolvedCandidate.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 2 }) }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", fallback.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 3 }) }).rc).toBe(0);
    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Critical\n- [ ] [id:${fallback.id}] [task:3.0.0] Projected critical fallback\n\n## → Normal\n- [ ] [id:${dependent.id}] [task:3.0.0] Must wait for projected dependency\n- [x] [id:${resolvedCandidate.id}] [task:3.0.0] Open entity resolved by Markdown\n\n## ✓ Resolved\n- [ ] [id:${dependency.id}] [task:3.0.0] Resolved entity reopened by Markdown\n`);
    const before = files(root);

    const projection = collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"));

    expect(projection.todoReadiness.selected).toMatchObject({ id: fallback.id, severity: "critical", result: "actionable" });
    expect(projection.todoReadiness.evaluations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: dependent.id, result: "waiting", eligible: false }),
      expect.objectContaining({ id: resolvedCandidate.id, result: "resolved", eligible: false }),
      expect.objectContaining({ id: dependency.id, result: "needs-triage", eligible: false }),
    ]));
    expect(projection.todoCounts).toEqual({ critical: 1, degraded: 0, normal: 2, annoying: 0 });
    expect(projection.todoItems.map((entry) => entry.id)).not.toContain(resolvedCandidate.id);
    expect(files(root)).toEqual(before);
  });

  it("selects the Markdown-first same-severity row despite opposing queue rank", () => {
    const root = project();
    const queueFirst = todo(root, "Entity queue first");
    const markdownFirst = todo(root, "Markdown order first");
    expect(capture(root, ["state", "todo", "update", "--id", queueFirst.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 1 }) }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", markdownFirst.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 9 }) }).rc).toBe(0);
    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Normal\n- [ ] [id:${markdownFirst.id}] [task:3.0.0] Markdown order first\n- [ ] [id:${queueFirst.id}] [task:3.0.0] Entity queue first\n`);
    const before = files(root);

    const projection = collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"));

    expect(projection.todoReadiness.selected).toMatchObject({ id: markdownFirst.id, severity: "normal", projectedOrder: { kind: "managed", markdownOrder: 1 }, queueRank: 9, result: "actionable" });
    expect(projection.todoReadiness.evaluations.map((entry) => entry.id)).toEqual([markdownFirst.id, queueFirst.id]);
    expect(projection.todoCounts).toEqual({ critical: 0, degraded: 0, normal: 2, annoying: 0 });
    expect(files(root)).toEqual(before);
  });

  it("selects the Markdown-first managed row when same-severity queue ranks are equal", () => {
    const root = project();
    const first = todo(root, "Equal rank first");
    const second = todo(root, "Equal rank second");
    expect(capture(root, ["state", "todo", "update", "--id", first.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 1 }) }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", second.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 1 }) }).rc).toBe(0);
    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Normal\n- [ ] [id:${first.id}] [task:3.0.0] Equal rank first\n- [ ] [id:${second.id}] [task:3.0.0] Equal rank second\n`);
    const before = files(root);

    const projection = collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"));

    expect(projection.todoReadiness.selected).toMatchObject({ id: first.id, projectedOrder: { kind: "managed", markdownOrder: 1 }, queueRank: 1, result: "actionable" });
    expect(projection.todoReadiness.evaluations.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(projection.todoCounts).toEqual({ critical: 0, degraded: 0, normal: 2, annoying: 0 });
    expect(files(root)).toEqual(before);
  });

  it("keeps a later managed row eligible when an absent entity shares its queue rank", () => {
    const root = project();
    const blocked = todo(root, "Blocked Markdown first");
    const managed = todo(root, "Eligible managed second");
    expect(capture(root, ["state", "todo", "update", "--id", blocked.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 9, blocked: { reason: "Fixture blocker.", recovery: "Remove the fixture blocker." } }) }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", managed.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 1 }) }).rc).toBe(0);
    const absentId = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].find((id) => id !== blocked.id && id !== managed.id)!;
    seedAbsentTodoEntity(root, absentId, "Eligible absent fallback", 1);
    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## → Normal\n- [ ] [id:${blocked.id}] [task:3.0.0] Blocked Markdown first\n- [ ] [id:${managed.id}] [task:3.0.0] Eligible managed second\n`);
    const before = files(root);

    const projection = collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"));

    expect(projection.todoReadiness.selected).toMatchObject({ id: managed.id, projectedOrder: { kind: "managed", markdownOrder: 2 }, queueRank: 1, result: "actionable" });
    expect(projection.todoReadiness.evaluations.find((entry) => entry.id === blocked.id)).toMatchObject({ projectedOrder: { kind: "managed", markdownOrder: 1 }, result: "blocked", eligible: false });
    expect(projection.todoReadiness.evaluations.find((entry) => entry.id === absentId)).toMatchObject({ projectedOrder: { kind: "absent" }, queueRank: 1, result: "actionable" });
    expect(projection.todoCounts).toEqual({ critical: 0, degraded: 0, normal: 3, annoying: 0 });
    expect(files(root)).toEqual(before);
  });

  it("uses ID order for equal-ranked entities absent from managed Markdown", () => {
    const root = project();
    const anchor = todo(root, "Resolved activation anchor");
    expect(capture(root, ["state", "todo", "resolve", "--id", anchor.id, "--reason", "fixture", "--date", "2026-08-02", "--format", "json"]).rc).toBe(0);
    const absentIds = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].filter((id) => id !== anchor.id).slice(0, 2).sort();
    seedAbsentTodoEntity(root, absentIds[1]!, "Absent later ID", 1);
    seedAbsentTodoEntity(root, absentIds[0]!, "Absent first ID", 1);
    const before = files(root);

    const projection = collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"));

    expect(projection.todoReadiness.selected).toMatchObject({ id: absentIds[0], projectedOrder: { kind: "absent" }, queueRank: 1, result: "actionable" });
    expect(projection.todoReadiness.evaluations.filter((entry) => entry.eligible).map((entry) => entry.id)).toEqual(absentIds);
    expect(projection.todoCounts).toEqual({ critical: 0, degraded: 0, normal: 2, annoying: 0 });
    expect(files(root)).toEqual(before);
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

  it("publishes TODO Markdown with its entity while leaving the docs singleton untouched", () => {
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
    expect(fs.readFileSync(path.join(root, "TODO.md"))).not.toEqual(todoBytes);
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain(`[x] [id:${item.id}] [task:3.0.0] Ship safely`);
    expect(fs.readFileSync(path.join(root, ".agentera/docs.yaml"))).toEqual(docsBytes);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
  });

  it("updates a valid noncanonical TODO through the public writer and publishes canonical bytes", () => {
    const root = project(); const id = "ldzkfdcopb"; const file = path.join(root, `.agentera/entities/todo/todo_item/${id}.yaml`);
    const noncanonical = `id: ${id}\nartifact: todo\nrecord:\n  severity: normal\n  status: resolved\n  description: "[feat:3.0.0] Resolved 2026-07-26: Shipped the shared glossary-entry primitive, personal and project ownership contracts, canonical project identity and conformance, deferred capability alignment, development metadata, and source/package verification. Confidence remains protocol CS1-CS5; personal evidence uses bounded history, project evidence uses repository-file provenance, and collision/review behavior remains consumer-owned. Producers remain deferred and open; no producer, persistence, lookup, or live project glossary exists."\n  readiness:\n    capability: plan\n    reason: Shared semantics and ownership shipped as the prerequisite for both glossary producers and their consumer.\n    dependencies: []\n    blocked: null\n    gate: null\n    queue_rank: 1\n    order_reason: Resolved prerequisite; downstream order is owned by the open producer and consumer TODOs.\n`.replaceAll("\n", "\r\n");
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, noncanonical);
    fs.writeFileSync(path.join(root, "TODO.md"), `# TODO\n\n## ✓ Resolved\n- [x] [id:${id}] [feat:3.0.0] Resolved 2026-07-26: Shipped the shared glossary-entry primitive, personal and project ownership contracts, canonical project identity and conformance, deferred capability alignment, development metadata, and source/package verification. Confidence remains protocol CS1-CS5; personal evidence uses bounded history, project evidence uses repository-file provenance, and collision/review behavior remains consumer-owned. Producers remain deferred and open; no producer, persistence, lookup, or live project glossary exists.\n`);
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

    expect(String(failure)).toMatch(/ownership or bytes changed before replacement/);
    expect(fs.readFileSync(file, "utf8")).toBe(competingBytes);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".tmp") || name.includes(".previous"))).toEqual([]);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 1 });
  });

  it("preserves an in-place competitor write that lands while replacement bytes are staged", () => {
    const root = project(); const item = todo(root, "Initial owner"); const file = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const competingBytes = dumpYamlMapping({ id: item.id, artifact: "todo", record: { ...item.record, title: "Competing in-place write" } });
    const originalOpen = fs.openSync.bind(fs); let injected = false;
    vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
      const descriptor = originalOpen(target, flags, mode);
      if (!injected && String(target).endsWith("/replacement.tmp")) { injected = true; fs.writeFileSync(file, competingBytes); }
      return descriptor;
    });

    const updated = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Writer replacement" });
    expect(injected).toBe(true);
    expect(updated.rc).toBe(2);
    expect(updated.json?.error).toMatchObject({
      class: "conflict",
      message: expect.stringMatching(/changed at a validation boundary/i),
      recovery: expect.stringMatching(/pending journal.*competitor.*no competitor bytes were overwritten/i),
    });
    expect(fs.readFileSync(file, "utf8")).toBe(competingBytes);
    expect(recoveryFiles(root)).toEqual([]);
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
      if (target.includes("/todo_item/")) { fs.rmSync(progressSource); fs.symlinkSync(external, progressSource); mutated = true; }
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
    expect(todoPage.json).toMatchObject({ status: "degraded", order: "severity_then_status_then_markdown_order_then_id", omitted: true, omitted_count: 1, entries: [{ id: high.id, artifact: "todo", queue_rank: 1, provenance: { storage: "canonical_entity_file" } }] });
    todo(root, "critical second", "critical");
    const filteredTodo = capture(root, ["state", "todo", "list", "--status", "open", "--severity", "critical", "--ids-only", "--limit", "1", "--format", "json"]);
    expect(filteredTodo.json.retrieval.continue).toMatch(/^agentera state todo list --severity 'critical' --status 'open' --ids-only --limit 1 --cursor \S+ --format json$/);
    const todoGet = capture(root, ["state", "todo", "get", "--id", low.id, "--format", "json"]); expect(todoGet.json.entry.record.title).toBe("normal");
    const docsList = capture(root, ["state", "docs", "list", "--format", "json"]); expect(docsList.json.entries.map((entry: any) => entry.id)).toEqual([secondDoc.id, firstDoc.id]);
    const filteredDocs = capture(root, ["state", "docs", "list", "--status", "current", "--topic", ".md", "--ids-only", "--limit", "1", "--format", "json"]);
    expect(filteredDocs.json.retrieval.continue).toMatch(/^agentera state docs list --topic '\.md' --status 'current' --ids-only --limit 1 --cursor \S+ --format json$/);
    const docsDefault = capture(root, ["state", "docs", "--format", "json"]); expect(docsDefault.rc).toBe(2); expect(docsDefault.json.error).toMatchObject({ class: "invalid_request", recovery: expect.stringContaining("state docs list") });
    todo(root, "cursor invalidator"); const stale = capture(root, ["state", "todo", "list", "--limit", "1", "--cursor", todoPage.json.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
    const detail = "x".repeat(18_000); const large = todo(root, detail); todo(root, `y${detail}`); const bounded = capture(root, ["state", "todo", "list", "--limit", "100", "--format", "json"]); expect(Buffer.byteLength(bounded.out)).toBeLessThanOrEqual(32_768); expect(bounded.json).toMatchObject({ status: "degraded", counts: { returned: 6, omitted: 0 }, degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 6 }, retrieval: { get: "agentera state todo get --id ID --format json" } }); expect(bounded.json.entries.map((entry: any) => entry.queue_rank)).toEqual([1, 2, 3, 4, 5, 6]); expect(capture(root, ["state", "todo", "get", "--id", large.id, "--format", "json"]).json.entry.record.title).toBe(detail);
    expect(capture(root, ["state", "docs", "get", "--id", secondDoc.id, "--format", "json"]).json.entry.record).toEqual({ document: "Alpha", path: "a.md", last_updated: "2026-07-17", status: "current" });
  });

  it("preserves 40, 60, and 100 realistic TODO rows across byte pressure, filters, and continuation without mutation", () => {
    const { root, orderedIds, criticalOpenIds } = realisticTodoProject();
    const before = files(root);

    for (const limit of [40, 60, 100]) {
      const result = capture(root, ["state", "todo", "list", "--ids-only", "--limit", String(limit), "--format", "json"]);
      expect(result.rc, result.err || result.out).toBe(0);
      expect(Buffer.byteLength(result.out)).toBeLessThanOrEqual(32_768);
      expect(result.json).toMatchObject({
        counts: { total: 120, candidate: 120, returned: limit, remaining: 120 - limit, omitted: 120 - limit, continuation: 120 - limit },
        projection: { selector: "ids_only", detail: "identity", cardinality: "requested_rows" },
      });
      expect(result.json.entries).toHaveLength(limit);
      expect(result.json.entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, limit));
      expect(result.json.entries.map((entry: any) => entry.queue_rank)).toEqual(Array.from({ length: limit }, (_, index) => index + 1));
      for (const entry of result.json.entries) {
        expect(Object.keys(entry).sort()).toEqual(["artifact", "id", "queue_rank", "retrieval"]);
        expect(entry.retrieval.get).toBe(`agentera state todo get --id ${entry.id} --format json`);
      }
    }

    const first = capture(root, ["state", "todo", "list", "--severity", "critical", "--status", "open", "--ids-only", "--limit", "40", "--format", "json"]);
    expect(first.rc, first.err || first.out).toBe(0);
    expect(first.json).toMatchObject({ counts: { total: 70, candidate: 70, returned: 40, remaining: 30, omitted: 30, continuation: 30 } });
    const second = capture(root, shellCommandArgs(first.json.retrieval.continue));
    expect(second.rc, second.err || second.out).toBe(0);
    expect(second.json).toMatchObject({ counts: { total: 70, candidate: 70, returned: 30, remaining: 0, omitted: 0, continuation: 0 } });
    const paged = [...first.json.entries, ...second.json.entries];
    expect(paged.map((entry: any) => entry.id)).toEqual(criticalOpenIds);
    expect(new Set(paged.map((entry: any) => entry.id)).size).toBe(70);
    expect(paged.map((entry: any) => entry.queue_rank)).toEqual(Array.from({ length: 70 }, (_, index) => index + 1));

    const selected = capture(root, ["state", "todo", "list", "--fields", "status,target_version", "--limit", "100", "--format", "json"]);
    expect(selected.rc, selected.err || selected.out).toBe(0);
    expect(selected.json.entries).toHaveLength(100);
    expect(selected.json.projection).toMatchObject({ selector: "fields", fields: ["status", "target_version"], cardinality: "requested_rows" });
    expect(selected.json.entries.every((entry: any) => entry.record.status && entry.record.target_version === "3.0.0")).toBe(true);

    const degraded = capture(root, ["state", "todo", "list", "--limit", "100", "--format", "json"]);
    expect(degraded.rc, degraded.err || degraded.out).toBe(0);
    expect(Buffer.byteLength(degraded.out)).toBeLessThanOrEqual(32_768);
    expect(degraded.json).toMatchObject({
      status: "degraded",
      counts: { candidate: 120, returned: 100, omitted: 20, continuation: 20 },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 100, omitted_fields: expect.arrayContaining(["record", "provenance"]) },
    });

    const rejected = capture(root, ["state", "todo", "list", "--fields", "title", "--limit", "100", "--format", "json"]);
    expect(rejected.rc).toBe(1);
    expect(rejected.json).toMatchObject({ status: "fail", error: { class: "unsupported_state", message: expect.stringContaining("selected fields cannot fit") } });

    for (const entry of [first.json.entries[0], second.json.entries.at(-1), degraded.json.entries.at(-1)]) {
      const exact = capture(root, shellCommandArgs(entry.retrieval.get));
      expect(exact.rc, exact.err || exact.out).toBe(0);
      expect(exact.json.entry).toMatchObject({ id: entry.id, artifact: "todo" });
    }
    expect(files(root)).toEqual(before);
  });

  it("binds TODO cursors to normalized limit and preserves exact unfiltered continuation", () => {
    const { root, orderedIds } = realisticTodoProject();
    const before = files(root);
    const cursorFirst = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--format", "json"]);
    expect(cursorFirst.rc, cursorFirst.err || cursorFirst.out).toBe(0);
    const authorityPath = loadStateStorageAuthority(resolveSourceRoot()).authorityPath;
    const cursorPayload = decodeListCursor(cursorFirst.json.next_cursor, root, authorityPath);
    expect(cursorPayload).toMatchObject({
      limit: 10,
      order: "severity_then_status_then_markdown_order_then_id",
      filters: {},
      selector: expect.any(String),
      snapshot_id: expect.any(String),
      after: cursorFirst.json.entries.at(-1).id,
    });

    const cursorPages = [cursorFirst.json];
    while (cursorPages.at(-1).retrieval.continue) {
      const next = capture(root, shellCommandArgs(cursorPages.at(-1).retrieval.continue));
      expect(next.rc, next.err || next.out).toBe(0);
      cursorPages.push(next.json);
    }
    const cursorEntries = cursorPages.flatMap((page) => page.entries);
    expect(cursorPages).toHaveLength(12);
    cursorPages.forEach((page, index) => expect(page.counts).toMatchObject({
      total: 120,
      candidate: 120,
      returned: 10,
      remaining: 120 - (index + 1) * 10,
      omitted: 120 - (index + 1) * 10,
      continuation: 120 - (index + 1) * 10,
    }));
    expect(cursorPages.at(-1)).toMatchObject({ status: "ok", counts: { remaining: 0, omitted: 0, continuation: 0 } });
    expect(cursorPages.at(-1).next_cursor).toBeUndefined();
    expect(cursorPages.at(-1).retrieval.continue).toBeUndefined();
    expect(cursorEntries.map((entry: any) => entry.id)).toEqual(orderedIds);
    expect(cursorEntries.map((entry: any) => entry.queue_rank)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
    expect(new Set(cursorEntries.map((entry: any) => entry.id)).size).toBe(120);
    const cursorExact = capture(root, shellCommandArgs(cursorEntries.at(-1).retrieval.get));
    expect(cursorExact.rc, cursorExact.err || cursorExact.out).toBe(0);
    expect(cursorExact.json.entry).toMatchObject({ id: orderedIds.at(-1), artifact: "todo" });

    expect(files(root)).toEqual(before);
  });

  it("preserves filtered TODO continuation and pre-filter queue rank", () => {
    const { root, orderedIds } = realisticTodoProject();
    const before = files(root);
    const first = capture(root, ["state", "todo", "list", "--severity", "normal", "--status", "open", "--ids-only", "--limit", "10", "--format", "json"]);
    expect(first.rc, first.err || first.out).toBe(0);
    const normalPages = [first.json];
    while (normalPages.at(-1).retrieval.continue) {
      const next = capture(root, shellCommandArgs(normalPages.at(-1).retrieval.continue));
      expect(next.rc, next.err || next.out).toBe(0);
      normalPages.push(next.json);
    }
    const normalEntries = normalPages.flatMap((page) => page.entries);
    expect(normalPages).toHaveLength(3);
    expect(normalEntries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(90));
    expect(normalEntries.map((entry: any) => entry.queue_rank)).toEqual(Array.from({ length: 30 }, (_, index) => index + 91));
    expect(files(root)).toEqual(before);
  });

  it("classifies TODO request-binding changes as cursor_invalid with current exact restart", () => {
    const { root, orderedIds } = realisticTodoProject();
    const before = files(root);
    const authorityPath = loadStateStorageAuthority(resolveSourceRoot()).authorityPath;
    const first = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--format", "json"]);
    const payload = decodeListCursor(first.json.next_cursor, root, authorityPath);
    const assertInvalid = (args: string[], message: string, recovery: string, expectedIds: string[]): void => {
      const result = capture(root, args);
      expect(result.rc).toBe(1);
      expect(result.json).not.toHaveProperty("entries");
      expect(result.json.error).toMatchObject({ class: "cursor_invalid", message, recovery });
      const restarted = capture(root, shellCommandArgs(result.json.error.recovery));
      expect(restarted.rc, restarted.err || restarted.out).toBe(0);
      expect(restarted.json.entries.map((entry: any) => entry.id)).toEqual(expectedIds);
    };

    assertInvalid(
      ["state", "todo", "list", "--ids-only", "--limit", "5", "--cursor", first.json.next_cursor, "--format", "json"],
      "todo cursor is bound to --limit 10, not --limit 5",
      "agentera state todo list --ids-only --limit 5 --format json",
      orderedIds.slice(0, 5),
    );
    assertInvalid(
      ["state", "todo", "list", "--ids-only", "--limit", "20", "--cursor", first.json.next_cursor, "--format", "json"],
      "todo cursor is bound to --limit 10, not --limit 20",
      "agentera state todo list --ids-only --limit 20 --format json",
      orderedIds.slice(0, 20),
    );
    assertInvalid(
      ["state", "todo", "list", "--limit", "10", "--cursor", first.json.next_cursor, "--format", "json"],
      "todo cursor selectors do not match this request",
      "agentera state todo list --limit 10 --format json",
      orderedIds.slice(0, 10),
    );
    assertInvalid(
      ["state", "todo", "list", "--status", "open", "--ids-only", "--limit", "10", "--cursor", first.json.next_cursor, "--format", "json"],
      "todo cursor filters do not match this request",
      "agentera state todo list --status 'open' --ids-only --limit 10 --format json",
      orderedIds.slice(0, 10),
    );
    const changedOrder = structuredClone(payload); changedOrder.order = "changed_order";
    assertInvalid(
      ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", encodeListCursor(changedOrder, root, authorityPath), "--format", "json"],
      "todo cursor order does not match this request",
      "agentera state todo list --ids-only --limit 10 --format json",
      orderedIds.slice(0, 10),
    );

    const defaultFirst = capture(root, ["state", "todo", "list", "--ids-only", "--format", "json"]);
    expect(decodeListCursor(defaultFirst.json.next_cursor, root, authorityPath).limit).toBe(20);
    const explicitDefault = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "20", "--cursor", defaultFirst.json.next_cursor, "--format", "json"]);
    expect(explicitDefault.rc, explicitDefault.err || explicitDefault.out).toBe(0);
    expect(explicitDefault.json.entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(20, 40));
    const explicitFirst = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "20", "--format", "json"]);
    const omittedDefault = capture(root, ["state", "todo", "list", "--ids-only", "--cursor", explicitFirst.json.next_cursor, "--format", "json"]);
    expect(omittedDefault.rc, omittedDefault.err || omittedDefault.out).toBe(0);
    expect(omittedDefault.json.entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(20, 40));
    expect(files(root)).toEqual(before);
  });

  it("fails closed for malformed, signed legacy, signature, base64, and payload cursors", () => {
    const { root, orderedIds } = realisticTodoProject();
    const before = files(root);
    const authorityPath = loadStateStorageAuthority(resolveSourceRoot()).authorityPath;
    const first = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--format", "json"]);
    const payload = decodeListCursor(first.json.next_cursor, root, authorityPath);
    const [body, signature] = String(first.json.next_cursor).split(".");
    const legacy = structuredClone(payload); delete legacy.limit;
    const variants = [
      { label: "malformed", cursor: "not-a-cursor", message: "todo cursor is malformed or belongs to another project" },
      { label: "signature", cursor: `${body}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`, message: "todo cursor is malformed or belongs to another project" },
      { label: "base64", cursor: `${body}=.${signature}`, message: "todo cursor is malformed or belongs to another project" },
      { label: "payload", cursor: encodeListCursor([] as any, root, authorityPath), message: "todo cursor is malformed or belongs to another project" },
      { label: "legacy", cursor: encodeListCursor(legacy, root, authorityPath), message: "todo cursor lacks the required effective limit binding" },
    ];
    for (const variant of variants) {
      const result = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", variant.cursor, "--format", "json"]);
      expect(result.rc, variant.label).toBe(1);
      expect(result.json).not.toHaveProperty("entries");
      expect(result.json.error).toMatchObject({ class: "cursor_invalid", message: variant.message, recovery: "agentera state todo list --ids-only --limit 10 --format json" });
      const restarted = capture(root, shellCommandArgs(result.json.error.recovery));
      expect(restarted.rc, restarted.err || restarted.out).toBe(0);
      expect(restarted.json.entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, 10));
    }
    expect(files(root)).toEqual(before);
  });

  it("rejects signed invalid TODO limits and preserves YAML and text cursor errors", () => {
    const { root } = realisticTodoProject();
    const before = files(root);
    const authorityPath = loadStateStorageAuthority(resolveSourceRoot()).authorityPath;
    const first = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--format", "json"]);
    const payload = decodeListCursor(first.json.next_cursor, root, authorityPath);
    for (const invalidLimit of [0, -1, 1.5, 101, "10", null]) {
      const invalid = structuredClone(payload); invalid.limit = invalidLimit as any;
      const result = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", encodeListCursor(invalid, root, authorityPath), "--format", "json"]);
      expect(result.rc, String(invalidLimit)).toBe(1);
      expect(result.json).not.toHaveProperty("entries");
      expect(result.json.error).toMatchObject({ class: "cursor_invalid", message: "todo cursor has an invalid effective limit binding", recovery: "agentera state todo list --ids-only --limit 10 --format json" });
      expect(capture(root, shellCommandArgs(result.json.error.recovery)).rc).toBe(0);
    }

    const yaml = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "5", "--cursor", first.json.next_cursor, "--format", "yaml"]);
    expect(yaml.rc).toBe(1);
    expect(loadYamlMapping(yaml.out)).toMatchObject({ status: "fail", error: { class: "cursor_invalid", recovery: "agentera state todo list --ids-only --limit 5 --format json" } });
    expect(loadYamlMapping(yaml.out)).not.toHaveProperty("entries");
    const text = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "5", "--cursor", first.json.next_cursor, "--format", "text"]);
    expect(text.rc).toBe(1);
    expect(text.out).toBe("");
    expect(text.err).toContain("Class: cursor_invalid");
    expect(text.err).toContain("Recovery: agentera state todo list --ids-only --limit 5 --format json");
    expect(files(root)).toEqual(before);
  });

  it("reserves snapshot-unavailable for actual state loss and missing continuation identity", () => {
    const { root, orderedIds } = realisticTodoProject();
    const initial = files(root);
    const authorityPath = loadStateStorageAuthority(resolveSourceRoot()).authorityPath;
    const first = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--format", "json"]);
    const payload = decodeListCursor(first.json.next_cursor, root, authorityPath);
    const missingAfter = structuredClone(payload); missingAfter.after = "zzzzzzzzzz";
    const missing = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", encodeListCursor(missingAfter, root, authorityPath), "--format", "json"]);
    expect(missing.rc).toBe(1);
    expect(missing.json).not.toHaveProperty("entries");
    expect(missing.json.error).toMatchObject({ class: "cursor_snapshot_unavailable", message: "todo cursor continuation identity is no longer available", recovery: "agentera state todo list --ids-only --limit 10 --format json" });
    expect(capture(root, shellCommandArgs(missing.json.error.recovery)).json.entries.map((entry: any) => entry.id)).toEqual(orderedIds.slice(0, 10));
    expect(files(root)).toEqual(initial);

    todo(root, "Actual cursor snapshot mutation", "critical");
    const mutated = files(root);
    const stale = capture(root, ["state", "todo", "list", "--ids-only", "--limit", "10", "--cursor", first.json.next_cursor, "--format", "json"]);
    expect(stale.rc).toBe(1);
    expect(stale.json).not.toHaveProperty("entries");
    expect(stale.json.error).toMatchObject({ class: "cursor_snapshot_unavailable", message: "todo cursor snapshot is no longer available", recovery: "agentera state todo list --ids-only --limit 10 --format json" });
    expect(capture(root, shellCommandArgs(stale.json.error.recovery)).rc).toBe(0);
    expect(files(root)).toEqual(mutated);
  });

  it("uses static final help and explain with bare IDs", () => {
    const root = project();
    const todoHelp = capture(root, ["state", "todo", "--help"]); const docsHelp = capture(root, ["state", "docs", "--help"]);
    expect(todoHelp.out).toContain("todo resolve|reopen --id ID --reason TEXT --date YYYY-MM-DD"); expect(todoHelp.out).toContain("todo create --input TODO.yaml"); expect(docsHelp.out).toContain("docs update --id ID"); expect(todoHelp.out + docsHelp.out).not.toContain("--number"); expect(docsHelp.out).toContain("path is record data, not identity");
    const explain = capture(root, ["state", "todo", "explain", "--verb", "update", "--format", "json"]); expect(explain.json.fields).toEqual(expect.arrayContaining([expect.objectContaining({ flag: "--id", required: true })])); expect(explain.json.example).toContain("--id qjtrmnpvka");
    expect(capture(root, ["schema", "--format", "json"]).json.state_writer.artifacts.map((artifact: any) => artifact.artifact)).toEqual(expect.arrayContaining(["todo", "docs"]));
    const legacy = project(false); expect(capture(legacy, ["state", "todo", "--help"]).out).toContain("todo create"); expect(capture(legacy, ["state", "todo", "explain", "--format", "json"]).json.example).toContain("todo create"); expect(capture(legacy, ["schema", "--format", "json"]).json.state_writer.artifacts.map((artifact: any) => artifact.artifact)).toEqual(expect.arrayContaining(["todo", "docs"]));
  });

  it("reconciles one-sided Markdown edits with the requested mutation in one transaction", () => {
    const root = project(); const item = todo(root, "Original public title");
    const markdown = path.join(root, "TODO.md");
    fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").replace("Original public title", "Human public title"));
    const drifted = files(root);
    const read = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
    expect(read.json).toMatchObject({
      entry: { record: { title: "Human public title" }, public: { owner: "markdown", source: "TODO.md" } },
      reconciliation: { status: "drift", read_effect: "none", next_write_boundary: "atomic_reconciliation", items: [{ id: item.id, state: "markdown_only", markdown_changed_fields: ["description"] }] },
    });
    expect(files(root)).toEqual(drifted);
    const result = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
    expect(result.rc, result.err || result.out).toBe(0);
    expect(result.json).toMatchObject({ record: { title: "Human public title", readiness: { capability: "build" } }, reconciliation: { targets: 1, recovered: [] } });
    expect(loadYamlMapping(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`), "utf8")).record).toEqual(result.json.record);
    expect(fs.readFileSync(markdown, "utf8")).toContain("Human public title");
  });

  it("projects a one-sided entity edit with the requested operational mutation in one transaction", () => {
    const root = project(); const item = todo(root, "Original entity title");
    const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const envelope = loadYamlMapping(fs.readFileSync(entity, "utf8"));
    (envelope.record as any).title = "Agentera entity title";
    fs.writeFileSync(entity, dumpYamlMapping(envelope));
    const drifted = files(root);
    const read = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
    expect(read.json).toMatchObject({
      entry: { record: { title: "Original entity title" }, public: { description: "[task:3.0.0] Original entity title", owner: "markdown" } },
      reconciliation: { status: "drift", items: [{ id: item.id, state: "entity_only", entity_changed_fields: ["description"] }] },
    });
    expect(files(root)).toEqual(drifted);

    const result = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput() });

    expect(result.rc, result.err || result.out).toBe(0);
    expect(result.json).toMatchObject({ record: { title: "Agentera entity title", readiness: { capability: "build" } }, reconciliation: { targets: 2, recovered: [] } });
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain(`[id:${item.id}] [task:3.0.0] Agentera entity title`);
    expect(loadYamlMapping(fs.readFileSync(entity, "utf8")).record).toEqual(result.json.record);
  });

  it("reads Markdown-owned edit classes and order without letting them bypass operational constraints", () => {
    const root = project();
    const first = todo(root, "First public row");
    const second = todo(root, "Second public row");
    expect(capture(root, ["state", "todo", "update", "--id", first.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 1 }) }).rc).toBe(0);
    expect(capture(root, ["state", "todo", "update", "--id", second.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 2, gate: { state: "pending", reason: "Approval required.", recovery: "Obtain approval." } }) }).rc).toBe(0);
    const markdown = path.join(root, "TODO.md");
    fs.writeFileSync(markdown, `# TODO\n\n## → Critical\n- [ ] [id:${second.id}] [task:3.0.0] Human changed second row\n\n## → Normal\n- [ ] [id:${first.id}] [task:3.0.0] First public row\n`);

    const list = capture(root, ["state", "todo", "list", "--format", "json"]);
    expect(list.rc, list.err || list.out).toBe(0);
    expect(list.json).toMatchObject({
      order: "severity_then_status_then_markdown_order_then_id",
      reconciliation: { status: "drift", read_effect: "none", authority: { public: { owner: "markdown" }, operational: { owner: "agentera" } } },
    });
    expect(list.json.entries.map((entry: any) => entry.id)).toEqual([second.id, first.id]);
    const selection = evaluateTodoReadinessQueue(list.json.entries.map((entry: any) => ({ id: entry.id, artifact: entry.artifact, record: entry.record })));
    expect(selection.selected?.id).toBe(first.id);
    expect(selection.evaluations.find((entry) => entry.id === second.id)).toMatchObject({ result: "gated", eligible: false });

    fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").replace(`- [ ] [id:${second.id}]`, `- [x] [id:${second.id}]`));
    const beforeReads = files(root);
    const exact = capture(root, ["state", "todo", "get", "--id", second.id, "--format", "json"]);
    expect(exact.json.entry).toMatchObject({
      id: second.id,
      record: { title: "Human changed second row", severity: "critical", status: "resolved", readiness: { gate: { state: "pending" }, queue_rank: 2 } },
      public: { description: "[task:3.0.0] Human changed second row", severity: "critical", status: "resolved", order: 1 },
    });
    const validation = capture(root, ["check", "validate", "state", "--cwd", root, "--format", "json"]);
    expect(validation.rc).toBe(1);
    expect(validation.json.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "todo_reconciliation_drift", artifact: "todo" })]));
    expect(files(root)).toEqual(beforeReads);

    const reconciled = capture(root, ["state", "todo", "update", "--id", first.id, "--input", "-", "--format", "json"], { readiness: readinessInput({ queue_rank: 1 }) });
    expect(reconciled.rc, reconciled.err || reconciled.out).toBe(0);
    expect(reconciled.json.reconciliation).toMatchObject({ recovered: [], targets: 2 });
    expect(fs.readFileSync(markdown, "utf8")).toContain(`- [x] [id:${second.id}] [task:3.0.0] Human changed second row`);
    expect(capture(root, ["check", "validate", "state", "--cwd", root, "--format", "json"]).rc).toBe(0);
  });

  it("reports divergent edits and unchecked removal on reads and validation without effects", () => {
    for (const kind of ["divergent", "removed"] as const) {
      const root = project(); const item = todo(root, `Read ${kind}`); const markdown = path.join(root, "TODO.md");
      if (kind === "removed") fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").split("\n").filter((line) => !line.includes(item.id)).join("\n"));
      else {
        fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").replace(`Read ${kind}`, "Markdown branch"));
        const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
        const value = loadYamlMapping(fs.readFileSync(entity, "utf8")); (value.record as any).title = "Entity branch"; fs.writeFileSync(entity, dumpYamlMapping(value));
      }
      const before = files(root);
      const read = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
      expect(read.rc, read.err || read.out).toBe(0);
      expect(read.json.reconciliation).toMatchObject({ status: "conflict", read_effect: "none", items: [expect.objectContaining({ id: item.id, state: "conflict" })] });
      const validation = capture(root, ["check", "validate", "state", "--cwd", root, "--format", "json"]);
      expect(validation.rc).toBe(1);
      expect(validation.json.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "todo_reconciliation_drift", id: item.id })]));
      expect(files(root), kind).toEqual(before);
    }
  });

  it("bounds read-only Markdown inspection without exposing rejected bytes", () => {
    const root = project(); const item = todo(root, "Bounded read"); const markdown = path.join(root, "TODO.md");
    const privateBytes = `PRIVATE_REJECTED_TODO_BYTES_${"x".repeat(1024 * 1024)}`;
    fs.writeFileSync(markdown, privateBytes);
    const before = files(root);
    const read = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
    expect(read.rc).toBe(2);
    expect(read.out + read.err).toContain("1048576-byte reconciliation bound");
    expect(read.out + read.err).not.toContain("PRIVATE_REJECTED_TODO_BYTES");
    const validation = capture(root, ["check", "validate", "state", "--cwd", root, "--format", "json"]);
    expect(validation.rc).toBe(1);
    expect(validation.out + validation.err).not.toContain("PRIVATE_REJECTED_TODO_BYTES");
    expect(files(root)).toEqual(before);
  });

  it("uses within-severity Markdown order for reads and reconciles independent public fields", () => {
    const root = project(); const first = todo(root, "First ordered"); const second = todo(root, "Second ordered");
    const markdown = path.join(root, "TODO.md");
    fs.writeFileSync(markdown, `# TODO\n\n## → Normal\n- [ ] [id:${second.id}] [task:3.0.0] Second ordered\n- [ ] [id:${first.id}] [task:3.0.0] First ordered\n`);
    const firstEntity = path.join(root, `.agentera/entities/todo/todo_item/${first.id}.yaml`);
    const value = loadYamlMapping(fs.readFileSync(firstEntity, "utf8")); (value.record as any).title = "Entity-only first title"; fs.writeFileSync(firstEntity, dumpYamlMapping(value));
    const secondEntity = path.join(root, `.agentera/entities/todo/todo_item/${second.id}.yaml`);
    const secondValue = loadYamlMapping(fs.readFileSync(secondEntity, "utf8")); (secondValue.record as any).readiness = readinessInput({ blocked: { reason: "Decision missing", recovery: "Run agentera discuss" }, capability: "discuss" }); fs.writeFileSync(secondEntity, dumpYamlMapping(secondValue));

    const beforeReads = files(root);
    const read = capture(root, ["state", "todo", "list", "--format", "json"]);
    expect(read.json.entries.map((entry: any) => entry.id)).toEqual([second.id, first.id]);
    expect(read.json.entries[0]).toMatchObject({ id: second.id, public_order: 1, readiness: { state: "open", blocked: true }, actionability: { outcome: "blocked", eligible: false }, queue_rank: 1, reconciliation: { status: "drift", drifted: true } });
    expect(read.json.entries[1]).toMatchObject({ id: first.id, public_order: 2, readiness: { state: "open", blocked: false }, actionability: { outcome: "readiness_absent", eligible: false }, queue_rank: 2, reconciliation: { status: "drift", drifted: true } });
    expect(read.json.reconciliation).toMatchObject({
      status: "drift",
      items: expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: "convergent", markdown_changed_fields: ["order"], entity_changed_fields: ["description"], conflicting_fields: [] }),
        expect.objectContaining({ id: second.id, state: "markdown_only", markdown_changed_fields: ["order"] }),
      ]),
    });
    const bare = capture(root, ["state", "todo", "--format", "json"]); expect(bare).toEqual(read);
    expect(capture(root, ["state", "todo", "list", "--format", "yaml"]).rc).toBe(0);
    expect(capture(root, ["state", "todo", "list", "--format", "text"]).rc).toBe(0);
    const page = capture(root, ["state", "todo", "list", "--limit", "1", "--format", "json"]); expect(page.json.next_cursor).toEqual(expect.any(String));
    expect(capture(root, ["state", "todo", "list", "--limit", "1", "--cursor", page.json.next_cursor, "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "todo", "get", "--id", second.id, "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "todo", "list", "--help"]).rc).toBe(0);
    expect(capture(root, ["state", "todo", "get", "extra", "--format", "json"]).rc).toBe(2);
    expect(files(root)).toEqual(beforeReads);
    const applied = capture(root, ["state", "todo", "update", "--id", second.id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
    expect(applied.rc, applied.err || applied.out).toBe(0);
    expect(fs.readFileSync(markdown, "utf8")).toMatch(new RegExp(`id:${second.id}[\\s\\S]*id:${first.id}`));
    expect(fs.readFileSync(markdown, "utf8")).toContain("Entity-only first title");
  });

  it("lets ordinary Git merge independent authorities and reports semantic public conflicts", () => {
    for (const divergent of [false, true]) {
      const root = project(); const item = todo(root, divergent ? "Merge conflict base" : "Merge success base");
      git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", "."); git(root, "commit", "-m", "baseline");
      git(root, "switch", "-c", "markdown-edit");
      const markdown = path.join(root, "TODO.md"); fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").replace(divergent ? "Merge conflict base" : "Merge success base", divergent ? "Markdown branch title" : "Markdown-only title"));
      git(root, "add", "TODO.md"); git(root, "commit", "-m", "edit markdown");
      git(root, "switch", "main");
      const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`); const value = loadYamlMapping(fs.readFileSync(entity, "utf8"));
      if (divergent) (value.record as any).title = "Entity branch title";
      else (value.record as any).readiness = readinessInput();
      fs.writeFileSync(entity, dumpYamlMapping(value)); git(root, "add", path.relative(root, entity)); git(root, "commit", "-m", "edit entity");
      git(root, "merge", "--no-edit", "markdown-edit");

      const read = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
      expect(read.rc, read.err || read.out).toBe(0);
      expect(read.json.reconciliation.status).toBe(divergent ? "conflict" : "drift");
      const beforeWrite = files(root);
      const write = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
      if (divergent) {
        expect(write.rc).toBe(2); expect(write.json.error).toMatchObject({ class: "conflict", message: expect.stringContaining("description") }); expect(files(root)).toEqual(beforeWrite);
      } else {
        expect(write.rc, write.err || write.out).toBe(0); expect(write.json.record).toMatchObject({ title: "Markdown-only title", readiness: { capability: "build" } });
        expect(capture(root, ["check", "validate", "state", "--cwd", root, "--format", "json"]).rc).toBe(0);
      }
    }
  });

  it("rejects a missing post-activation baseline as stale before target effects", () => {
    const root = project(); const item = todo(root, "Stale baseline");
    const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const envelope = loadYamlMapping(fs.readFileSync(entity, "utf8"));
    delete (envelope.record as any).reconciliation;
    fs.writeFileSync(entity, dumpYamlMapping(envelope));
    const before = files(root);

    const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput() });

    expect(rejected.rc).toBe(2);
    expect(rejected.json.error).toMatchObject({
      class: "conflict",
      message: expect.stringContaining("has no stable reconciliation baseline"),
      recovery: expect.stringMatching(/restore.*baseline.*retry/i),
    });
    expect(files(root)).toEqual(before);
  });

  it("rejects duplicate, orphaned, removed-open, and divergent managed rows before effects", () => {
    const cases = ["duplicate", "orphan", "removed", "divergent"] as const;
    for (const kind of cases) {
      const root = project(); const item = todo(root, `Conflict ${kind}`); const markdown = path.join(root, "TODO.md"); const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
      if (kind === "duplicate") fs.appendFileSync(markdown, `- [ ] [id:${item.id}] [task:3.0.0] Duplicate\n`);
      if (kind === "orphan") fs.appendFileSync(markdown, "- [ ] [id:cccccccccc] [task:3.0.0] Orphan\n");
      if (kind === "removed") fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").split("\n").filter((line) => !line.includes(item.id)).join("\n"));
      if (kind === "divergent") {
        fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").replace(`Conflict ${kind}`, "Markdown branch"));
        const envelope = loadYamlMapping(fs.readFileSync(entity, "utf8")); (envelope.record as any).title = "Entity branch"; fs.writeFileSync(entity, dumpYamlMapping(envelope));
      }
      const before = files(root);
      const result = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
      expect(result.rc, kind).toBe(2); expect(result.json.error, kind).toMatchObject({ class: "conflict", recovery: expect.stringMatching(/retry once|exactly one/) }); expect(files(root), kind).toEqual(before);
    }
  });

  it("activates bounded legacy rows once, preserves unmatched legacy bytes, and then requires managed IDs", () => {
    const { root, id, entity } = preactivationProject();
    const activation = path.join(root, ".agentera/todo-reconciliation-activation.json");
    const beforePreview = files(root);
    const preview = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--dry-run", "--format", "json"], { readiness: readinessInput() });
    expect(preview.rc, preview.err || preview.out).toBe(0);
    expect(preview.json.reconciliation).toMatchObject({ transaction_id: null, targets: 3, recovered: [] });
    expect(files(root)).toEqual(beforePreview);
    expect(fs.existsSync(activation)).toBe(false);

    const applied = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
    expect(applied.rc, applied.err || applied.out).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain(`- [ ] [id:${id}] [task:3.0.0] Legacy matched row`);
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain("- [ ] [note] Retained pre-activation note");
    const activationRecord = JSON.parse(fs.readFileSync(activation, "utf8"));
    expect(activationRecord).toMatchObject({
      schema_version: "agentera.todoReconciliationActivation.v1",
      retained_legacy_rows: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect((loadYamlMapping(fs.readFileSync(entity, "utf8")).record as any).reconciliation).toMatchObject({
      schema_version: "agentera.todoReconciliation.v1",
      public: { present: true, severity: "normal", status: "open" },
    });

    fs.appendFileSync(path.join(root, "TODO.md"), "\n## → Degraded\n- [ ] [fix:3.0.0] New ID-less managed row\n");
    const beforeReject = files(root);
    const rejected = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { readiness: null });
    expect(rejected.rc).toBe(2);
    expect(rejected.json.error).toMatchObject({
      class: "conflict",
      message: expect.stringContaining("after reconciliation activation"),
      recovery: expect.stringContaining("[id:abcdefghij]"),
    });
    expect(files(root)).toEqual(beforeReject);
  });

  it("rejects identical pre-activation managed rows before assigning either row an entity ID", () => {
    const { root, id } = preactivationProject();
    const markdown = path.join(root, "TODO.md");
    fs.writeFileSync(markdown, `# TODO\n\n## → Normal\n- [ ] [task:3.0.0] Legacy matched row\n- [ ] [task:3.0.0] Legacy matched row\n`);
    const before = files(root);

    const rejected = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { readiness: readinessInput() });

    expect(rejected.rc).toBe(2);
    expect(rejected.json.error).toMatchObject({
      class: "conflict",
      message: expect.stringMatching(/identical ID-less managed rows.*lines/i),
      recovery: expect.stringContaining("distinct canonical '[id:abcdefghij]'"),
    });
    expect(files(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".agentera/todo-reconciliation-activation.json"))).toBe(false);
  });

  it("rejects ID-less rows only inside managed sections", () => {
    const root = project(); const item = todo(root, "Managed identity"); const markdown = path.join(root, "TODO.md");
    fs.appendFileSync(markdown, "\n## Notes\n- [ ] ordinary unchecked note\n");
    expect(capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: readinessInput() }).rc).toBe(0);
    fs.appendFileSync(markdown, "\n## → Degraded\n- [ ] [fix:3.0.0] Missing managed identity\n"); const before = files(root);
    const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { readiness: null });
    expect(rejected.rc).toBe(2); expect(rejected.json.error).toMatchObject({ class: "conflict", recovery: expect.stringContaining("[id:abcdefghij]") }); expect(files(root)).toEqual(before);
  });

  it("resumes deterministic publication after every injected target boundary", () => {
    for (const boundary of [0, 1, 2]) {
      const root = project(); const item = todo(root, `Interrupted ${boundary}`); const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const spec = operationSpec("todo", "update")!; const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id }, callerPayload: {}, input: { title: `Recovered ${boundary}` } };
      expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, interruptAfterTarget: boundary })).toThrow(/interruption/); binding.publicationContext.close();
      expect(fs.readdirSync(path.join(root, ".agentera/.todo-reconciliation")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
      const pending = files(root); const ordinaryMarkdown = fs.readFileSync(path.join(root, "TODO.md"), "utf8"); expect(ordinaryMarkdown).toMatch(/^# legacy TODO sentinel/); expect(ordinaryMarkdown.includes(`Interrupted ${boundary}`) || ordinaryMarkdown.includes(`Recovered ${boundary}`)).toBe(true);
      for (const read of [["state", "todo", "get", "--id", item.id, "--format", "json"], ["state", "todo", "list", "--format", "json"]]) {
        const blocked = capture(root, read); expect(blocked.rc).toBe(1); expect(blocked.json.error).toMatchObject({ class: "unsupported_state", message: expect.stringContaining("no mixed TODO state is readable") });
      }
      expect(() => collectEntityOrientation(root, path.resolve(import.meta.dirname, "../../../../"))).toThrow(/no mixed TODO state is readable/);
      const dryRun = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--dry-run", "--format", "json"], { title: `Recovered ${boundary}` });
      expect(dryRun.rc).toBe(2); expect(dryRun.json.error.recovery).toContain("without --dry-run"); expect(files(root)).toEqual(pending);
      const replay = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: `Recovered ${boundary}` });
      expect(replay.rc, replay.err || replay.out).toBe(0); expect(replay.json.reconciliation.recovered).toHaveLength(1); expect(replay.json.record.title).toBe(`Recovered ${boundary}`);
      expect(fs.readdirSync(path.join(root, ".agentera/.todo-reconciliation")).filter((name) => name.endsWith(".json"))).toEqual([]);
      expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain(`Recovered ${boundary}`);
    }
  });

  it("recovers interrupted create at every target boundary without allocating a second ID", () => {
    for (const boundary of [0, 1, 2, 3]) {
      const root = project();
      const input = { kind: "task", target_version: "3.0.0", title: `Interrupted create ${boundary}`, requirements: [], acceptance: [], release_blocker: false, severity: "normal" };
      const req: StateWriteRequest = { artifact: "todo", spec: operationSpec("todo", "create")!, projectRoot: root, dryRun: false, force: false, values: {}, callerPayload: {}, input };
      const firstCandidate = vi.fn(() => "aaaaaaaaaa");
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, candidate: firstCandidate, interruptAfterTarget: boundary })).toThrow(/interruption/);
      binding.publicationContext.close();
      expect(firstCandidate).toHaveBeenCalledTimes(1);

      const journalDirectory = path.join(root, ".agentera/.todo-reconciliation");
      const journalName = fs.readdirSync(journalDirectory).find((name) => name.endsWith(".json"));
      if (!journalName) throw new Error("pending create journal fixture missing");
      const journal = JSON.parse(fs.readFileSync(path.join(journalDirectory, journalName), "utf8"));
      expect(journal).toMatchObject({
        id: journalName.replace(/\.json$/, ""),
        create: { created_id: "aaaaaaaaaa", request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
      expect(journal.targets.map((target: any) => target.path)).toEqual([
        ".agentera/entities/todo/todo_item/aaaaaaaaaa.yaml",
        ".agentera/todo-reconciliation-activation.json",
        "TODO.md",
      ]);

      const retryCandidate = vi.fn(() => "bbbbbbbbbb");
      const retryBinding = detectStateModeBinding(root); if (retryBinding.mode !== "entities") throw new Error("entity mode expected");
      const replay = mutateTodoDocsEntity(req, { publicationContext: retryBinding.publicationContext, candidate: retryCandidate });
      retryBinding.publicationContext.close();

      expect(retryCandidate).not.toHaveBeenCalled();
      expect(replay).toMatchObject({
        id: "aaaaaaaaaa",
        record: { title: `Interrupted create ${boundary}` },
        operation: { idempotent_replay: true },
        reconciliation: { transaction_id: journal.id, targets: 0, recovered: [journal.id] },
      });
      const entities = fs.readdirSync(path.join(root, ".agentera/entities/todo/todo_item")).filter((name) => name.endsWith(".yaml"));
      expect(entities).toEqual(["aaaaaaaaaa.yaml"]);
      const markdown = fs.readFileSync(path.join(root, "TODO.md"), "utf8");
      expect(markdown.match(/\[id:aaaaaaaaaa\]/g)).toHaveLength(1);
      expect(markdown).not.toContain("bbbbbbbbbb");
      expect(fs.readdirSync(journalDirectory).filter((name) => name.endsWith(".json"))).toEqual([]);
      expect(recoveryFiles(root)).toEqual([]);
      expect(validateEntityState(root).valid).toBe(true);
    }
  });

  it("rejects a divergent create while its journal is pending without additional effects", () => {
    const root = project();
    const original = { kind: "task", target_version: "3.0.0", title: "Original interrupted create", requirements: [], acceptance: [], release_blocker: false, severity: "normal" };
    const req: StateWriteRequest = { artifact: "todo", spec: operationSpec("todo", "create")!, projectRoot: root, dryRun: false, force: false, values: {}, callerPayload: {}, input: original };
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, candidate: () => "aaaaaaaaaa", interruptAfterTarget: 1 })).toThrow(/interruption/);
    binding.publicationContext.close();
    const before = files(root);

    const rejected = capture(root, ["state", "todo", "create", "--input", "-", "--format", "json"], { ...original, title: "Different create request" });

    expect(rejected.rc).toBe(2);
    expect(rejected.json.error).toMatchObject({
      class: "conflict",
      message: expect.stringMatching(/pending TODO create.*does not match this request/i),
      recovery: expect.stringMatching(/exact original TODO create input.*aaaaaaaaaa.*no transaction target bytes were changed/i),
    });
    expect(files(root)).toEqual(before);

    const retryCandidate = vi.fn(() => "bbbbbbbbbb");
    const retryBinding = detectStateModeBinding(root); if (retryBinding.mode !== "entities") throw new Error("entity mode expected");
    const replay = mutateTodoDocsEntity(req, { publicationContext: retryBinding.publicationContext, candidate: retryCandidate });
    retryBinding.publicationContext.close();
    expect(replay).toMatchObject({ id: "aaaaaaaaaa", operation: { idempotent_replay: true } });
    expect(retryCandidate).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, ".agentera/entities/todo/todo_item/bbbbbbbbbb.yaml"))).toBe(false);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("derives the original create receipt from a pending pre-receipt journal", () => {
    const root = project();
    const input = { kind: "task", target_version: "3.0.0", title: "Pre-receipt interrupted create", requirements: [], acceptance: [], release_blocker: false, severity: "normal" };
    const req: StateWriteRequest = { artifact: "todo", spec: operationSpec("todo", "create")!, projectRoot: root, dryRun: false, force: false, values: {}, callerPayload: {}, input };
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, candidate: () => "aaaaaaaaaa", interruptAfterTarget: 0 })).toThrow(/interruption/);
    binding.publicationContext.close();

    const journalDirectory = path.join(root, ".agentera/.todo-reconciliation");
    const journalName = fs.readdirSync(journalDirectory).find((name) => name.endsWith(".json"));
    if (!journalName) throw new Error("pending create journal fixture missing");
    const currentPath = path.join(journalDirectory, journalName);
    const journal = JSON.parse(fs.readFileSync(currentPath, "utf8"));
    delete journal.create;
    journal.id = createHash("sha256").update(canonicalRecordJson(journal.targets)).digest("hex").slice(0, 24);
    const legacyPath = path.join(journalDirectory, `${journal.id}.json`);
    fs.writeFileSync(legacyPath, `${JSON.stringify(journal)}\n`);
    fs.unlinkSync(currentPath);

    const retryCandidate = vi.fn(() => "bbbbbbbbbb");
    const retryBinding = detectStateModeBinding(root); if (retryBinding.mode !== "entities") throw new Error("entity mode expected");
    const replay = mutateTodoDocsEntity(req, { publicationContext: retryBinding.publicationContext, candidate: retryCandidate });
    retryBinding.publicationContext.close();

    expect(replay).toMatchObject({ id: "aaaaaaaaaa", operation: { idempotent_replay: true }, reconciliation: { recovered: [journal.id] } });
    expect(retryCandidate).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, ".agentera/entities/todo/todo_item/bbbbbbbbbb.yaml"))).toBe(false);
    expect(fs.readdirSync(journalDirectory).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("rejects an invalid pending journal through structured read and write corrections without effects", () => {
    const root = project(); const item = todo(root, "Invalid journal");
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const spec = operationSpec("todo", "update")!;
    const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id }, callerPayload: {}, input: { title: "Must not publish" } };
    expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, interruptAfterTarget: 0 })).toThrow(/interruption/);
    binding.publicationContext.close();
    const journalDirectory = path.join(root, ".agentera/.todo-reconciliation");
    const journal = path.join(journalDirectory, fs.readdirSync(journalDirectory).find((name) => name.endsWith(".json"))!);
    fs.writeFileSync(journal, "{\"invalid\":true}\n");
    const before = files(root);

    const read = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
    expect(read.rc).toBe(1);
    expect(read.json.error).toMatchObject({ class: "unsupported_state", recovery: expect.stringContaining("restore its last valid committed journal bytes") });
    const write = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Must not publish" });
    expect(write.rc).toBe(2);
    expect(write.json.error).toMatchObject({ class: "conflict", recovery: expect.stringContaining("no target bytes were changed") });
    const withoutLock = (snapshot: Record<string, string>) => Object.fromEntries(Object.entries(snapshot).filter(([name]) => !name.startsWith(".agentera/.writer.lock/")));
    expect(withoutLock(files(root))).toEqual(withoutLock(before));
  });

  it("resumes pre-activation entity, activation-baseline, and public targets at every boundary", () => {
    for (const boundary of [0, 1, 2, 3]) {
      const { root, id } = preactivationProject("abcdefghij", `Activation ${boundary}`);
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const spec = operationSpec("todo", "update")!;
      const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id }, callerPayload: {}, input: { readiness: readinessInput() } };
      expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, interruptAfterTarget: boundary })).toThrow(/interruption/);
      binding.publicationContext.close();
      expect(fs.existsSync(path.join(root, "TODO.md"))).toBe(true);
      const blocked = capture(root, ["state", "todo", "list", "--format", "json"]);
      expect(blocked.rc).toBe(1); expect(blocked.json.error.class).toBe("unsupported_state");
      const retry = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
      expect(retry.rc, retry.err || retry.out).toBe(0);
      expect(retry.json.reconciliation.recovered).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain(`[id:${id}]`);
      expect(fs.existsSync(path.join(root, ".agentera/todo-reconciliation-activation.json"))).toBe(true);
      expect(fs.readdirSync(path.join(root, ".agentera/.todo-reconciliation")).filter((name) => name.endsWith(".json"))).toEqual([]);
    }
  });

  it("recovers real SIGKILL before and after the activation-baseline publication boundary", () => {
    for (const phase of ["before", "after"] as const) {
      const { root, id } = preactivationProject("abcdefghij", `Activation kill ${phase}`);
      const script = path.join(root, `kill-activation-${phase}.mjs`);
      fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, build, id, phase] = process.argv.slice(2);
const { detectStateModeBinding } = await import(pathToFileURL(path.join(build, "state/stateMode.js")).href);
const { operationSpec } = await import(pathToFileURL(path.join(build, "state/write/operations.js")).href);
const { mutateTodoDocsEntity } = await import(pathToFileURL(path.join(build, "state/todoDocsEntities.js")).href);
const link = fs.linkSync.bind(fs);
fs.linkSync = (source, target) => {
  const activation = String(target).endsWith("/todo-reconciliation-activation.json");
  if (activation && phase === "before") process.kill(process.pid, "SIGKILL");
  const result = link(source, target);
  if (activation && phase === "after") process.kill(process.pid, "SIGKILL");
  return result;
};
const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
mutateTodoDocsEntity({ artifact: "todo", spec: operationSpec("todo", "update"), projectRoot: root, dryRun: false, force: false, values: { id }, callerPayload: {}, input: { readiness: ${JSON.stringify(readinessInput())} } }, { publicationContext: binding.publicationContext });
`);
      const killed = spawnSync(process.execPath, [script, root, inject("sourceBuildRoot"), id, phase], { encoding: "utf8" });
      expect(killed.status, killed.stderr || killed.stdout).toBeNull(); expect(killed.signal).toBe("SIGKILL");
      expect(fs.existsSync(path.join(root, "TODO.md"))).toBe(true);
      const blocked = capture(root, ["state", "todo", "get", "--id", id, "--format", "json"]);
      expect(blocked.rc).toBe(1); expect(blocked.json.error.class).toBe("unsupported_state");
      const retry = capture(root, ["state", "todo", "update", "--id", id, "--input", "-", "--format", "json"], { readiness: readinessInput() });
      expect(retry.rc, retry.err || retry.out).toBe(0);
      expect(retry.json.reconciliation.recovered).toHaveLength(1);
      expect(fs.existsSync(path.join(root, ".agentera/todo-reconciliation-activation.json"))).toBe(true);
      expect(Object.keys(files(root)).some((name) => /todo-reconciliation-activation\.json\..*\.tmp$/.test(name))).toBe(false);
    }
  });

  it("keeps a mapped public TODO complete old-or-new across real SIGKILL and converges on retry", () => {
    for (const phase of ["before", "after"] as const) {
      const root = project(); const item = todo(root, `Mapped crash ${phase}`);
      const mapped = path.join(root, "mapped", "WORK.md"); fs.mkdirSync(path.dirname(mapped), { recursive: true });
      const oldBytes = `# TODO\n\n## → Normal\n- [ ] [id:${item.id}] [task:3.0.0] Mapped crash ${phase}\n`;
      const newBytes = oldBytes.replace(`Mapped crash ${phase}`, `Mapped recovered ${phase}`);
      fs.writeFileSync(mapped, oldBytes);
      fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/WORK.md", producers: ["build"] }] }));
      const rootTodoBefore = fs.readFileSync(path.join(root, "TODO.md"));
      const script = path.join(root, `kill-mapped-${phase}.mjs`);
      fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, build, id, phase] = process.argv.slice(2);
const { detectStateModeBinding } = await import(pathToFileURL(path.join(build, "state/stateMode.js")).href);
const { operationSpec } = await import(pathToFileURL(path.join(build, "state/write/operations.js")).href);
const { mutateTodoDocsEntity } = await import(pathToFileURL(path.join(build, "state/todoDocsEntities.js")).href);
const rename = fs.renameSync.bind(fs);
fs.renameSync = (from, to) => {
  const visible = String(to).endsWith("/WORK.md");
  if (visible && phase === "before") process.kill(process.pid, "SIGKILL");
  const result = rename(from, to);
  if (visible && phase === "after") process.kill(process.pid, "SIGKILL");
  return result;
};
const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
mutateTodoDocsEntity({ artifact: "todo", spec: operationSpec("todo", "update"), projectRoot: root, dryRun: false, force: false, values: { id }, callerPayload: {}, input: { title: "Mapped recovered ${phase}" } }, { publicationContext: binding.publicationContext });
`);
      const killed = spawnSync(process.execPath, [script, root, inject("sourceBuildRoot"), item.id, phase], { encoding: "utf8" });
      expect(killed.status, killed.stderr || killed.stdout).toBeNull(); expect(killed.signal).toBe("SIGKILL");
      expect(fs.existsSync(mapped)).toBe(true);
      expect([oldBytes, newBytes]).toContain(fs.readFileSync(mapped, "utf8"));
      expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(rootTodoBefore);
      const blocked = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]);
      expect(blocked.rc).toBe(1); expect(blocked.json.error.class).toBe("unsupported_state");
      const retry = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: `Mapped recovered ${phase}` });
      expect(retry.rc, retry.err || retry.out).toBe(0);
      expect(retry.json.reconciliation.recovered).toHaveLength(1);
      expect(fs.readFileSync(mapped, "utf8")).toBe(newBytes);
      expect(recoveryFiles(root)).toEqual([]);
    }
  });

  it("preserves a mapped public change detected at the final validation boundary", () => {
    const root = project(); const item = todo(root, "Mapped concurrent baseline");
    const mapped = path.join(root, "mapped", "WORK.md"); fs.mkdirSync(path.dirname(mapped), { recursive: true });
    const baseline = `# TODO\n\n## → Normal\n- [ ] [id:${item.id}] [task:3.0.0] Mapped concurrent baseline\n`;
    const competitor = baseline.replace("Mapped concurrent baseline", "Concurrent public owner");
    fs.writeFileSync(mapped, baseline);
    fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({ mapping: [{ artifact: "TODO.md", path: "mapped/WORK.md", producers: ["build"] }] }));
    const originalOpen = fs.openSync.bind(fs); let injected = false;
    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      const replacement = path.join(path.dirname(String(candidate)), "replacement.tmp");
      if (
        !injected
        && String(candidate).endsWith("/replacement.json")
        && fs.existsSync(replacement)
        && fs.readFileSync(replacement, "utf8").startsWith("# TODO")
      ) {
        injected = true;
        const competitorStage = path.join(path.dirname(mapped), ".competitor.tmp");
        fs.writeFileSync(competitorStage, competitor);
        fs.renameSync(competitorStage, mapped);
      }
      return descriptor;
    });

    const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Agentera public owner" });
    expect(injected).toBe(true);
    expect(rejected.rc).toBe(2);
    expect(rejected.json.error).toMatchObject({
      class: "conflict",
      message: expect.stringMatching(/changed at a validation boundary/i),
      recovery: expect.stringMatching(/canonical competitor.*recorded before or after/i),
    });
    expect(fs.readFileSync(mapped, "utf8")).toBe(competitor);
    expect(fs.readdirSync(path.join(root, ".agentera/.todo-reconciliation")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("maps an operational standard-rename failure to bounded recovery without target effects", () => {
    const root = project(); const item = todo(root, "Standard rename failure"); const before = files(root);
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source).endsWith("/replacement.tmp") && String(target).endsWith("/TODO.md")) {
        throw Object.assign(new Error("injected standard rename EIO"), { code: "EIO" });
      }
      return originalRename(source, target);
    });
    const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Rejected rename" });
    expect(rejected.rc, rejected.err || rejected.out).toBe(2);
    expect(rejected.json.error).toMatchObject({
      class: "unsupported_target",
      message: expect.stringContaining("complete-file replacement is unavailable"),
      recovery: expect.stringMatching(/standard rename support.*retry the exact/i),
    });
    expect(files(root)).toEqual(before);
  });

  it("attempts every rollback target after one target reports a CAS conflict", () => {
    const root = project(); const item = todo(root, "Rollback exhaustion baseline");
    const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    const entityBefore = fs.readFileSync(entity);
    const markdown = path.join(root, "TODO.md");
    const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
    const context = binding.publicationContext;
    const originalReplaceVisible = context.replaceVisible.bind(context);
    vi.spyOn(context, "replaceVisible").mockImplementation((...args) => {
      const result = originalReplaceVisible(...args);
      fs.writeFileSync(path.join(root, ".agentera/todo-reconciliation-activation.json"), `${JSON.stringify({
        schema_version: "agentera.todoReconciliationActivation.v1",
        retained_legacy_rows: ["a".repeat(64)],
      })}\n`);
      return result;
    });
    vi.spyOn(context, "restoreVisible").mockImplementation(() => {
      throw new ExactReplacementConflictError("injected public rollback CAS conflict", [".agentera/.entity-recovery/injected/competitor"]);
    });
    const spec = operationSpec("todo", "update")!;
    const req: StateWriteRequest = { artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id: item.id }, callerPayload: {}, input: { title: "Rollback exhaustion requested" } };
    let failure: any;
    try { mutateTodoDocsEntity(req, { publicationContext: context }); } catch (error) { failure = error; } finally { context.close(); }

    expect(failure?.body).toMatchObject({
      class: "conflict",
      message: expect.stringMatching(/attempted rollback for every published target.*1 target could not be restored/i),
      violations: expect.arrayContaining([
        expect.stringContaining("rollback target 'TODO.md'"),
        expect.stringContaining("preserved recovery role"),
      ]),
      recovery: expect.stringContaining("Targets not listed were restored"),
    });
    expect(fs.readFileSync(entity)).toEqual(entityBefore);
    expect(fs.readFileSync(markdown, "utf8")).toContain("Rollback exhaustion requested");
    expect(fs.readdirSync(path.join(root, ".agentera/.todo-reconciliation")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("recovers a real SIGKILL before complete-file replacement", () => {
    const root = project(); const item = todo(root, "Hard crash baseline"); const script = path.join(root, "kill-exact-replacement.mjs");
    fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, build, id] = process.argv.slice(2);
const { detectStateModeBinding } = await import(pathToFileURL(path.join(build, "state/stateMode.js")).href);
const { operationSpec } = await import(pathToFileURL(path.join(build, "state/write/operations.js")).href);
const { mutateTodoDocsEntity } = await import(pathToFileURL(path.join(build, "state/todoDocsEntities.js")).href);
const rename = fs.renameSync.bind(fs);
fs.renameSync = (source, target) => { if (String(source).endsWith("/replacement.tmp") && String(target).endsWith("/${item.id}.yaml")) process.kill(process.pid, "SIGKILL"); return rename(source, target); };
const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
const spec = operationSpec("todo", "update");
mutateTodoDocsEntity({ artifact: "todo", spec, projectRoot: root, dryRun: false, force: false, values: { id }, callerPayload: {}, input: { title: "Hard crash recovered" } }, { publicationContext: binding.publicationContext });
`);
    const killed = spawnSync(process.execPath, [script, root, inject("sourceBuildRoot"), item.id], { encoding: "utf8" });
    expect(killed.status, killed.stderr || killed.stdout).toBeNull(); expect(killed.signal).toBe("SIGKILL");
    const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`); expect(fs.existsSync(entity)).toBe(true); expect(fs.readFileSync(entity, "utf8")).toContain("Hard crash baseline");
    const roles = recoveryFiles(root); expect(roles.some((file) => file.endsWith("original.previous"))).toBe(true); expect(roles.some((file) => file.endsWith("replacement.tmp"))).toBe(true); expect(roles.some((file) => file.endsWith("replacement.json"))).toBe(true);
    const blocked = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]); expect(blocked.rc).toBe(1); expect(blocked.json.error.class).toBe("unsupported_state");
    const retry = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Hard crash recovered" });
    expect(retry.rc, retry.err || retry.out).toBe(0); expect(retry.json.reconciliation.recovered).toHaveLength(1); expect(retry.json.record.title).toBe("Hard crash recovered");
    expect(fs.existsSync(entity)).toBe(true); expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain("Hard crash recovered"); expect(recoveryFiles(root)).toEqual([]);
  });

  it("recovers a real SIGKILL after complete-file replacement and before role cleanup", () => {
    const root = project(); const item = todo(root, "Hard crash after entity link"); const script = path.join(root, "kill-after-entity-link.mjs");
    fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, build, id] = process.argv.slice(2);
const { detectStateModeBinding } = await import(pathToFileURL(path.join(build, "state/stateMode.js")).href);
const { operationSpec } = await import(pathToFileURL(path.join(build, "state/write/operations.js")).href);
const { mutateTodoDocsEntity } = await import(pathToFileURL(path.join(build, "state/todoDocsEntities.js")).href);
const rename = fs.renameSync.bind(fs);
fs.renameSync = (source, target) => {
  const result = rename(source, target);
  if (String(source).endsWith("/replacement.tmp") && String(target).endsWith("/${item.id}.yaml")) process.kill(process.pid, "SIGKILL");
  return result;
};
const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
mutateTodoDocsEntity({ artifact: "todo", spec: operationSpec("todo", "update"), projectRoot: root, dryRun: false, force: false, values: { id }, callerPayload: {}, input: { title: "Entity link committed" } }, { publicationContext: binding.publicationContext });
`);
    const killed = spawnSync(process.execPath, [script, root, inject("sourceBuildRoot"), item.id], { encoding: "utf8" });
    expect(killed.status, killed.stderr || killed.stdout).toBeNull(); expect(killed.signal).toBe("SIGKILL");
    const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    expect(fs.existsSync(entity)).toBe(true); expect(fs.readFileSync(entity, "utf8")).toContain("Entity link committed");
    const blocked = capture(root, ["state", "todo", "get", "--id", item.id, "--format", "json"]); expect(blocked.rc).toBe(1);
    const retry = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Entity link committed" });
    expect(retry.rc, retry.err || retry.out).toBe(0); expect(retry.json.reconciliation.recovered).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "TODO.md"), "utf8")).toContain("Entity link committed"); expect(recoveryFiles(root)).toEqual([]);
  });

  it("rejects symlinked recovery roots and attempts without changing external recovery bytes", () => {
    for (const boundary of ["root", "attempt"] as const) {
      const root = project(); const item = todo(root, `External recovery ${boundary}`); const requestedTitle = `Rejected external recovery ${boundary}`;
      const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`); const entityBefore = fs.readFileSync(entity);
      const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const req: StateWriteRequest = { artifact: "todo", spec: operationSpec("todo", "update")!, projectRoot: root, dryRun: false, force: false, values: { id: item.id }, callerPayload: {}, input: { title: requestedTitle } };
      expect(() => mutateTodoDocsEntity(req, { publicationContext: binding.publicationContext, interruptAfterTarget: 0 })).toThrow(/interruption/);
      binding.publicationContext.close();

      const journalDirectory = path.join(root, ".agentera/.todo-reconciliation");
      const journalName = fs.readdirSync(journalDirectory).find((name) => name.endsWith(".json"));
      if (!journalName) throw new Error("pending journal fixture missing");
      const journal = JSON.parse(fs.readFileSync(path.join(journalDirectory, journalName), "utf8"));
      const target = journal.targets.find((candidate: any) => candidate.path.endsWith(`/${item.id}.yaml`));
      if (!target || target.before === null) throw new Error("replacement target fixture missing");
      const before = Buffer.from(target.before, "base64"); const after = Buffer.from(target.after, "base64");

      const external = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-external-recovery-${boundary}-`)); roots.push(external);
      const externalRecovery = path.join(external, "recovery"); const attemptName = "entity-external-fixture"; const externalAttempt = path.join(externalRecovery, attemptName);
      fs.mkdirSync(externalAttempt, { recursive: true, mode: 0o700 }); fs.chmodSync(externalRecovery, 0o700); fs.chmodSync(externalAttempt, 0o700);
      fs.writeFileSync(path.join(externalAttempt, "original.previous"), before);
      fs.writeFileSync(path.join(externalAttempt, "replacement.tmp"), after);
      fs.writeFileSync(path.join(externalAttempt, "replacement.json"), `${JSON.stringify({
        schema_version: FILE_REPLACEMENT_RECOVERY_VERSION,
        target_path: target.path,
        before_sha256: createHash("sha256").update(before).digest("hex"),
        after_sha256: createHash("sha256").update(after).digest("hex"),
      })}\n`);
      const externalBefore = files(external);

      const recoveryRoot = path.join(root, ".agentera/.entity-recovery");
      if (boundary === "root") fs.symlinkSync(externalRecovery, recoveryRoot, "dir");
      else {
        fs.mkdirSync(recoveryRoot, 0o700);
        fs.writeFileSync(path.join(recoveryRoot, ".gitignore"), "*\n!.gitignore\n");
        fs.symlinkSync(externalAttempt, path.join(recoveryRoot, attemptName), "dir");
      }

      const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: requestedTitle });
      expect(rejected.rc, rejected.err || rejected.out).toBe(2);
      expect(rejected.json.error).toMatchObject({
        class: "unsupported_target",
        violations: expect.arrayContaining([expect.stringMatching(/real project-local non-symlink directory/i)]),
      });
      expect(files(external)).toEqual(externalBefore);
      expect(fs.existsSync(externalAttempt)).toBe(true);
      expect(fs.readFileSync(entity)).toEqual(entityBefore);
      expect(fs.existsSync(path.join(journalDirectory, journalName))).toBe(true);
    }
  });

  it("rejects a retained-role competitor with one structured correction and no byte changes", () => {
    const root = project(); const item = todo(root, "Retained conflict baseline"); const script = path.join(root, "kill-retained-conflict.mjs");
    fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [root, build, id] = process.argv.slice(2);
const { detectStateModeBinding } = await import(pathToFileURL(path.join(build, "state/stateMode.js")).href);
const { operationSpec } = await import(pathToFileURL(path.join(build, "state/write/operations.js")).href);
const { mutateTodoDocsEntity } = await import(pathToFileURL(path.join(build, "state/todoDocsEntities.js")).href);
const rename = fs.renameSync.bind(fs);
fs.renameSync = (source, target) => { if (String(source).endsWith("/replacement.tmp") && String(target).endsWith("/${item.id}.yaml")) process.kill(process.pid, "SIGKILL"); return rename(source, target); };
const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
mutateTodoDocsEntity({ artifact: "todo", spec: operationSpec("todo", "update"), projectRoot: root, dryRun: false, force: false, values: { id }, callerPayload: {}, input: { title: "Requested transaction bytes" } }, { publicationContext: binding.publicationContext });
`);
    const killed = spawnSync(process.execPath, [script, root, inject("sourceBuildRoot"), item.id], { encoding: "utf8" });
    expect(killed.status, killed.stderr || killed.stdout).toBeNull(); expect(killed.signal).toBe("SIGKILL");
    const entity = path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`);
    expect(fs.existsSync(entity)).toBe(true);
    const competitor = dumpYamlMapping({ id: item.id, artifact: "todo", record: { ...item.record, title: "Concurrent canonical owner" } });
    fs.writeFileSync(entity, competitor);
    const before = files(root);
    const durableBytes = (snapshot: Record<string, string>): Record<string, string> => Object.fromEntries(
      Object.entries(snapshot).filter(([name]) => !name.startsWith(".agentera/.writer.lock/")),
    );

    const rejected = capture(root, ["state", "todo", "update", "--id", item.id, "--input", "-", "--format", "json"], { title: "Requested transaction bytes" });
    expect(rejected.rc).toBe(2);
    expect(rejected.json).toMatchObject({
      status: "fail",
      error: {
        class: "conflict",
        message: expect.stringMatching(/retained recovery roles.*concurrent bytes/i),
        recovery: expect.stringMatching(/pending journal.*canonical competitor.*recorded before or after.*changed no bytes/i),
        violations: expect.arrayContaining([expect.stringContaining("preserved recovery role")]),
      },
    });
    expect(durableBytes(files(root))).toEqual(durableBytes(before));
    expect(fs.readFileSync(entity, "utf8")).toBe(competitor);
  });

  it("lets real Git worktrees merge unrelated additions and updates while same-entity updates conflict", () => {
    const root = project(); const leftItem = todo(root, "left base"); const rightDoc = doc(root, "right base", "right.md");
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", "."); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    expect(capture(left, ["state", "todo", "update", "--id", leftItem.id, "--input", "-", "--format", "json"], { title: "left update" }).rc).toBe(0); doc(left, "left addition", "left.md");
    expect(capture(right, ["state", "docs", "update", "--id", rightDoc.id, "--input", "-", "--format", "json"], { document: "right update", path: "right.md", last_updated: "2026-07-18", status: "current" }).rc).toBe(0); doc(right, "right addition", "addition.md");
    for (const checkout of [left, right]) { git(checkout, "add", ".agentera/entities", "TODO.md"); git(checkout, "commit", "-m", path.basename(checkout)); }
    git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right"); expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
    const a = `${root}-a`, b = `${root}-b`; roots.push(a, b); git(root, "worktree", "add", "-b", "a", a, "main"); git(root, "worktree", "add", "-b", "b", b, "main");
    for (const [checkout, description] of [[a, "A"], [b, "B"]]) { expect(capture(checkout, ["state", "todo", "update", "--id", leftItem.id, "--input", "-", "--format", "json"], { title: description }).rc).toBe(0); git(checkout, "add", ".agentera/entities", "TODO.md"); git(checkout, "commit", "-m", description); }
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
