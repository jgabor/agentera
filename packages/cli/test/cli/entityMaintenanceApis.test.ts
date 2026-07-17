import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-entity-maintenance-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  return root;
}

function entity(root: string, artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(root, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function seeded(): string {
  const root = project();
  entity(root, "progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "feat", phase: "build", what: "new", context: { intent: "test" } });
  entity(root, "progress", "progress_cycle", "bbbbbbbbbb", { timestamp: "2026-07-17 11:00", type: "fix", phase: "verify", what: "old", context: { intent: "test" } });
  entity(root, "decisions", "decision", "cccccccccc", { date: "2026-07-17", question: "Cut over?", context: "Task11", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "Canonical", confidence: "firm" });
  entity(root, "health", "health_audit", "dddddddddd", { date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } });
  entity(root, "plan", "plan", "eeeeeeeeee", { header: { level: "light", created: "2026-07-17", status: "open", title: "Entity APIs" }, what: "retrieve", why: "bounded", scope: { included: ["state"], excluded: [] } });
  entity(root, "plan", "plan_task", "ffffffffff", { plan: "eeeeeeeeee", name: "verify", status: "pending", depends_on: [], acceptance: ["pass"] });
  entity(root, "objective", "objective", "gggggggggg", { header: { title: "latency", status: "open", created: "2026-07-17" }, objective: { description: "Reduce latency", why: "Users wait", measurement: "p95", constraints: [] }, metric: { description: "p95", direction: "minimize", unit: "ms" }, baseline: { description: "100 ms" }, gates: {}, scope: { included: ["CLI"], excluded: [] } });
  entity(root, "experiments", "experiment", "hhhhhhhhhh", { objective: "gggggggggg", date: "2026-07-17 09:00", label: "baseline", hypothesis: "Measure", method: "Harness", change: "None", metric: { primary_value: "100 ms", delta_vs_baseline: "0" }, regression: "pass", status: "baseline", conclusion: "Measured", provenance: { command: "fixture", revision: "abc" } });
  return root;
}

function capture(root: string, args: string[]): { rc: number; json: any; out: string; err: string } {
  const prior = process.cwd(); let out = "", err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], { out: (text) => out += text, err: (text) => err += text });
    return { rc, json: out.trim() ? JSON.parse(out) : null, out, err };
  } finally { process.chdir(prior); }
}

function digest(root: string): string {
  const files = fs.readdirSync(path.join(root, ".agentera"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  const hash = createHash("sha256"); for (const file of files) hash.update(path.relative(root, file)).update(fs.readFileSync(file)); return hash.digest("hex");
}

function forbiddenIdentityKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) forbiddenIdentityKeys(item, found);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { if (["stable_id", "artifact_id", "entry_number", "number", "plan_id", "task_number", "experiment_number"].includes(key)) found.push(key); forbiddenIdentityKeys(child, found); }
  return found;
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("entity-mode retrieval and maintenance APIs", () => {
  it("routes every converted default view through canonical entities with bounded recovery", () => {
    const root = seeded();
    const commands = [
      ["state", "progress", "--limit", "1", "--format", "json"],
      ["state", "decisions", "--limit", "1", "--format", "json"],
      ["state", "health", "--format", "json"],
      ["state", "plan", "--limit", "1", "--format", "json"],
      ["state", "experiments", "--format", "json"],
    ];
    for (const args of commands) {
      const result = capture(root, args); expect(result.rc, `${args.join(" ")}: ${result.err || result.out}`).toBe(0);
      expect(forbiddenIdentityKeys(result.json)).toEqual([]);
      expect(JSON.stringify(result.json)).toContain('"id"'); expect(JSON.stringify(result.json)).toContain('"artifact"');
    }
    const first = capture(root, commands[0]); expect(first.json.omitted).toBe(true); expect(first.json.next_cursor).toBeTruthy();
    const second = capture(root, ["state", "progress", "--limit", "1", "--cursor", first.json.next_cursor, "--format", "json"]); expect(second.rc).toBe(0); expect(second.json.entries[0].id).toBe("bbbbbbbbbb"); expect(second.json.snapshot.id).toBe(first.json.snapshot.id);
    expect(capture(root, commands[0]).json).toEqual(first.json);
    const changed = path.join(root, ".agentera/entities/progress/progress_cycle/bbbbbbbbbb.yaml"); fs.writeFileSync(changed, fs.readFileSync(changed, "utf8").replace("what: old", "what: changed"));
    const stale = capture(root, ["state", "progress", "--limit", "1", "--cursor", first.json.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
    const phase = capture(root, ["state", "query", "last-phase", "--format", "json"]); expect(phase.json).toMatchObject({ phase: "build", id: "aaaaaaaaaa", artifact: "progress" });
  });

  it("rejects every legacy selector and reports exact missing IDs", () => {
    const root = seeded();
    for (const args of [
      ["state", "progress", "get", "--number", "1", "--format", "json"],
      ["state", "plan", "get", "--plan", "plan:123e4567-e89b-42d3-a456-426614174000", "--format", "json"],
      ["state", "plan", "tasks", "get", "--task", "1", "--format", "json"],
      ["state", "plan", "tasks", "list", "--plan", "eeeeeeeeee", "--format", "json"],
    ]) { const result = capture(root, args); expect(result.rc).toBe(2); expect(result.json.error.syntax).toMatch(/--(?:plan-)?id/); expect(forbiddenIdentityKeys(result.json)).toEqual([]); }
    const missing = capture(root, ["state", "progress", "get", "--id", "zzzzzzzzzz", "--format", "json"]); expect(missing.rc).toBe(1); expect(missing.json.error).toMatchObject({ class: "not_found", id: "zzzzzzzzzz", artifact: "progress" });
  });

  it("validates complete and empty graphs without mutating files", () => {
    for (const root of [seeded(), project()]) {
      const before = digest(root); const result = capture(root, ["check", "validate", "state", "--format", "json"]);
      expect(result.rc, result.err || result.out).toBe(0); expect(result.json.valid).toBe(true); expect(digest(root)).toBe(before);
    }
  });
});
