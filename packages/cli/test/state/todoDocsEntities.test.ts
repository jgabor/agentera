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

function todo(root: string, description: string, severity = "normal"): any {
  const result = capture(root, ["state", "todo", "create", "--severity", severity, "--description", description, "--format", "json"]);
  expect(result.rc, result.err || result.out).toBe(0); return result.json;
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
  it("creates, updates, and resolves one canonical entity without touching either legacy aggregate", () => {
    const root = project();
    const todoBytes = fs.readFileSync(path.join(root, "TODO.md"));
    const docsBytes = fs.readFileSync(path.join(root, ".agentera/docs.yaml"));
    const item = todo(root, "Ship entity-backed TODOs");
    const inventory = doc(root, "CLI guide", "docs/cli.md");
    expect(item).toMatchObject({ artifact: "todo", id: expect.stringMatching(/^[a-z]{10}$/), record: { severity: "normal", status: "open", description: "Ship entity-backed TODOs" } });
    expect(inventory).toMatchObject({ artifact: "docs", id: expect.stringMatching(/^[a-z]{10}$/), record: { document: "CLI guide", path: "docs/cli.md", status: "current" } });
    expect(capture(root, ["state", "todo", "update", "--id", item.id, "--severity", "degraded", "--description", "Ship safely", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["state", "todo", "resolve", "--id", item.id, "--format", "json"]).json.record.status).toBe("resolved");
    expect(capture(root, ["state", "docs", "update", "--id", inventory.id, "--input", "-", "--format", "json"], { document: "CLI guide", path: "docs/cli.md", last_updated: "2026-07-18", status: "stale" }).rc).toBe(0);
    expect(fs.readFileSync(path.join(root, "TODO.md"))).toEqual(todoBytes);
    expect(fs.readFileSync(path.join(root, ".agentera/docs.yaml"))).toEqual(docsBytes);
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
  });

  it("rejects aliases and non-bare selectors before effects while marker-absent commands retain legacy behavior", () => {
    const root = project(); const item = todo(root, "valid"); const before = fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`));
    for (const id of ["1", "todo:abcdefghij", "abcdefghij/path", "TODO.md", "ABCDEFGHIJ"]) {
      const result = capture(root, ["state", "todo", "update", "--id", id, "--description", "invalid", "--format", "json"]);
      expect(result.rc).toBe(2); expect(result.json.error.class).toBe("invalid_request");
    }
    for (const alias of ["id", "artifact", "number", "stable_id", "artifact_id", "entry_number", "task_number", "experiment_number", "plan_id", "objective_id", "type_prefixed_id"]) {
      const result = capture(root, ["state", "docs", "create", "--input", "-", "--format", "json"], { document: "invalid", path: "invalid.md", last_updated: "2026-07-17", status: "current", [alias]: "forbidden" });
      expect(result.rc, alias).toBe(2); expect(result.json.error.class).toBe("schema_violation");
    }
    expect(fs.readFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`))).toEqual(before);
    const legacy = project(false); const queried = capture(legacy, ["state", "todo", "--format", "json"]); expect(queried.rc).toBe(0); expect(queried.json.source.path).toContain("TODO.md"); expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);
    const malformed = path.join(root, ".agentera/entities/docs/documentation_inventory_entry/bbbbbbbbbb.yaml"); fs.mkdirSync(path.dirname(malformed), { recursive: true }); fs.writeFileSync(malformed, "id: bbbbbbbbbb\nartifact: docs\nrecord:\n  document: bad\n  path: bad.md\n  last_updated: nope\n  status: invented\n  stable_id: alias\n"); expect(validateEntityState(root).valid).toBe(false); fs.rmSync(malformed);
    const duplicate = path.join(root, `.agentera/entities/docs/documentation_inventory_entry/${item.id}.yaml`); fs.copyFileSync(path.join(root, `.agentera/entities/todo/todo_item/${item.id}.yaml`), duplicate); expect(validateEntityState(root).issues.some((issue) => issue.code === "duplicate_id")).toBe(true);
  });

  it("renders bounded deterministic views with snapshot cursors, provenance, and exact full recovery", () => {
    const root = project();
    const low = todo(root, "normal", "normal"); const high = todo(root, "critical", "critical");
    const firstDoc = doc(root, "Zulu", "z.md"); const secondDoc = doc(root, "Alpha", "a.md");
    const todoPage = capture(root, ["state", "todo", "list", "--limit", "1", "--format", "json"]);
    expect(todoPage.json).toMatchObject({ status: "degraded", order: "severity_then_status_then_id", omitted: true, omitted_count: 1, entries: [{ id: high.id, artifact: "todo", provenance: { storage: "canonical_entity_file" } }] });
    const todoGet = capture(root, ["state", "todo", "get", "--id", low.id, "--format", "json"]); expect(todoGet.json.entry.record.description).toBe("normal");
    const docsList = capture(root, ["state", "docs", "list", "--format", "json"]); expect(docsList.json.entries.map((entry: any) => entry.id)).toEqual([secondDoc.id, firstDoc.id]);
    const docsDefault = capture(root, ["state", "docs", "--format", "json"]); expect(docsDefault.json.entries).toHaveLength(2); expect(docsDefault.json.summary.mapping).toHaveLength(1); expect(JSON.stringify(docsDefault.json)).not.toContain("legacy sentinel");
    todo(root, "cursor invalidator"); const stale = capture(root, ["state", "todo", "list", "--limit", "1", "--cursor", todoPage.json.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
    const detail = "x".repeat(18_000); const large = todo(root, detail); todo(root, `y${detail}`); const bounded = capture(root, ["state", "todo", "list", "--limit", "100", "--format", "json"]); expect(Buffer.byteLength(bounded.out)).toBeLessThanOrEqual(32_768); expect(bounded.json).toMatchObject({ omitted: true, omission_reason: "serialized_byte_budget", retrieval: { get: "agentera state todo get --id ID --format json" } }); expect(capture(root, ["state", "todo", "get", "--id", large.id, "--format", "json"]).json.entry.record.description).toBe(detail);
    expect(capture(root, ["state", "docs", "get", "--id", secondDoc.id, "--format", "json"]).json.entry.record).toEqual({ document: "Alpha", path: "a.md", last_updated: "2026-07-17", status: "current" });
  });

  it("uses mode-sensitive help and explain with bare IDs", () => {
    const root = project();
    const todoHelp = capture(root, ["state", "todo", "--help"]); const docsHelp = capture(root, ["state", "docs", "--help"]);
    expect(todoHelp.out).toContain("todo resolve --id ID"); expect(docsHelp.out).toContain("docs update --id ID"); expect(todoHelp.out + docsHelp.out).not.toContain("--number"); expect(docsHelp.out).toContain("path is record data, not identity");
    const explain = capture(root, ["state", "todo", "explain", "--verb", "update", "--format", "json"]); expect(explain.json.fields).toEqual(expect.arrayContaining([expect.objectContaining({ flag: "--id", required: true })])); expect(explain.json.example).toContain("--id qjtrmnpvka");
    expect(capture(root, ["schema", "--format", "json"]).json.state_writer.artifacts.map((artifact: any) => artifact.artifact)).toEqual(expect.arrayContaining(["todo", "docs"]));
    const legacy = project(false); expect(capture(legacy, ["state", "todo", "--help"]).out).not.toContain("todo create"); expect(capture(legacy, ["state", "todo", "explain", "--format", "json"]).json.error.class).toBe("unsupported_target"); expect(capture(legacy, ["schema", "--format", "json"]).json.state_writer.artifacts.map((artifact: any) => artifact.artifact)).not.toEqual(expect.arrayContaining(["todo", "docs"]));
  });

  it("lets real Git worktrees merge unrelated additions and updates while same-entity updates conflict", () => {
    const root = project(); const leftItem = todo(root, "left base"); const rightDoc = doc(root, "right base", "right.md");
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", "."); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main");
    expect(capture(left, ["state", "todo", "update", "--id", leftItem.id, "--description", "left update", "--format", "json"]).rc).toBe(0); doc(left, "left addition", "left.md");
    expect(capture(right, ["state", "docs", "update", "--id", rightDoc.id, "--input", "-", "--format", "json"], { document: "right update", path: "right.md", last_updated: "2026-07-18", status: "current" }).rc).toBe(0); todo(right, "right addition");
    for (const checkout of [left, right]) { git(checkout, "add", ".agentera/entities"); git(checkout, "commit", "-m", path.basename(checkout)); }
    git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right"); expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 4 });
    const a = `${root}-a`, b = `${root}-b`; roots.push(a, b); git(root, "worktree", "add", "-b", "a", a, "main"); git(root, "worktree", "add", "-b", "b", b, "main");
    for (const [checkout, description] of [[a, "A"], [b, "B"]]) { expect(capture(checkout, ["state", "todo", "update", "--id", leftItem.id, "--description", description, "--format", "json"]).rc).toBe(0); git(checkout, "add", ".agentera/entities"); git(checkout, "commit", "-m", description); }
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
