import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import {
  todoReconciliationActivationBytes,
  TODO_RECONCILIATION_ACTIVATION_PATH,
} from "../../src/state/todoReconciliationActivation.js";
import { shellCommandArgs } from "../helpers/shellCommand.js";

const roots: string[] = [];
const MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-todo-capacity-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), MARKER);
  fs.writeFileSync(path.join(root, TODO_RECONCILIATION_ACTIVATION_PATH), todoReconciliationActivationBytes([]));
  fs.writeFileSync(path.join(root, "TODO.md"), "# TODO\n");
  fs.writeFileSync(path.join(root, ".agentera/docs.yaml"), dumpYamlMapping({
    last_audit: "2026-07-17 (fixture)",
    conventions: { doc_root: ".", style: "concise" },
    mapping: [{ artifact: "TODO.md", path: "TODO.md", producers: ["build"] }],
    coverage: { documented: 1, undocumented: 0, stale: 0, tests: "covered" },
    index: [],
    audit_log: [],
  }));
  return root;
}

function capture(root: string, args: string[]): { rc: number; out: string; err: string; json: any } {
  const cwd = process.cwd();
  let out = "";
  let err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], {
      out: (text) => { out += text; },
      err: (text) => { err += text; },
    });
    return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
  } finally {
    process.chdir(cwd);
  }
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

function indexedId(index: number): string {
  let value = index;
  return Array.from({ length: 10 }, () => {
    const character = String.fromCharCode(97 + value % 26);
    value = Math.floor(value / 26);
    return character;
  }).reverse().join("");
}

function largeTodoProject(): { root: string; orderedIds: string[]; criticalOpenIds: string[] } {
  const root = project();
  const sections: Record<"critical" | "normal" | "resolved", string[]> = { critical: [], normal: [], resolved: [] };
  const criticalOpenIds: string[] = [];
  const criticalResolvedIds: string[] = [];
  const normalOpenIds: string[] = [];
  const orders = { critical: 0, normal: 0, resolved: 0 };
  for (let index = 0; index < 120; index += 1) {
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
  fs.writeFileSync(path.join(root, "TODO.md"), [
    "# TODO", "", "## ⇶ Critical", ...sections.critical, "", "## → Normal", ...sections.normal,
    "", "## ✓ Resolved", ...sections.resolved, "",
  ].join("\n"));
  return { root, orderedIds: [...criticalOpenIds, ...criticalResolvedIds, ...normalOpenIds], criticalOpenIds };
}

describe("TODO entity capacity", () => {
  it("preserves 40, 60, and 100 realistic TODO rows across byte pressure, filters, and continuation without mutation", () => {
    const { root, orderedIds, criticalOpenIds } = largeTodoProject();
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
        expect(entry.retrieval.get).toBe(`agentera state todo get --id ${entry.id}`);
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
});
