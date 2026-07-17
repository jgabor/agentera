import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { runSessionStart } from "../../src/hooks/sessionStart.js";

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-lifecycle-protocol-"));
  roots.push(root);
  return root;
}

function capture(root: string, args: string[], stdin = ""): { rc: number; out: string; err: string } {
  const previous = process.cwd(); let out = "", err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], { out: (text) => out += text, err: (text) => err += text, stdin: () => stdin });
    return { rc, out, err };
  } finally { process.chdir(previous); }
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const stat = fs.lstatSync(file);
      hash.update(path.relative(root, file)).update(String(stat.mode));
      if (stat.isDirectory()) walk(file); else hash.update(fs.readFileSync(file));
    }
  };
  walk(root); return hash.digest("hex");
}

function entity(root: string, artifact: string, boundary: string, id: string, record: Record<string, unknown>): void {
  const file = path.join(root, ".agentera/entities", artifact, boundary, `${id}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, dumpYamlMapping({ id, artifact, record }));
}

function cutoverProject(): string {
  const root = project();
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity(root, "progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "canonical progress", context: { intent: "test" } });
  entity(root, "decisions", "decision", "bbbbbbbbbb", { date: "2026-07-17", question: "Canonical?", context: "test", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "entity", confidence: "firm" });
  entity(root, "health", "health_audit", "cccccccccc", { date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } });
  entity(root, "plan", "plan", "dddddddddd", { header: { level: "light", created: "2026-07-17", status: "open", title: "Canonical plan" }, what: "test", why: "test", scope: { included: ["state"], excluded: [] } });
  entity(root, "plan", "plan_task", "eeeeeeeeee", { plan: "dddddddddd", name: "Canonical task", status: "pending", depends_on: [], acceptance: ["pass"] });
  entity(root, "todo", "todo_item", "ffffffffff", { severity: "critical", status: "open", description: "Canonical TODO" });
  entity(root, "docs", "documentation_inventory_entry", "gggggggggg", { document: "Canonical docs", path: "docs/canonical.md", last_updated: "2026-07-17", status: "current" });
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("final lifecycle protocol", () => {
  it("fails ordinary marker-absent commands read-only with one exact migration recovery", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "legacy.txt"), "unchanged\n");
    const before = treeDigest(root);
    for (const args of [
      ["prime", "--format", "json"],
      ["prime", "--context", "build", "--format", "json"],
      ["state", "progress", "--format", "json"],
      ["state", "decisions", "list", "--format", "json"],
      ["state", "todo", "create", "--severity", "normal", "--description", "x", "--format", "json"],
      ["state", "query", "progress", "--format", "json"],
    ]) {
      const result = capture(root, args);
      expect(result.rc).toBe(1); expect(result.err).toBe("");
      expect(JSON.parse(result.out).error).toEqual(expect.objectContaining({
        class: "migration_required",
        recovery: `agentera state migrate entities --project ${root} --dry-run --format json`,
      }));
      expect(treeDigest(root)).toBe(before);
      expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);
    }
  });

  it("keeps readiness exceptions and legacy evidence writes explicit and entity-free", () => {
    const root = project();
    expect(capture(root, ["state", "query", "--list-artifacts", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["schema", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["check", "compact", "--project", root, "--format", "json"]).out).not.toContain("migration_required");
    const write = capture(root, ["state", "progress", "append", "--type", "fix", "--phase", "build", "--what", "evidence", "--intent", "Task12", "--format", "json"]);
    expect(write.rc, write.err).toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/progress.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
    const explain = capture(root, ["state", "progress", "explain", "--format", "json"]);
    expect(JSON.parse(explain.out)).toMatchObject({ classification: "legacy_migration_evidence", recovery_only: true });
  });

  it("uses canonical entities for startup and compact while ignoring hostile aggregates", () => {
    const root = cutoverProject();
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "cycles:\n  - what: HOSTILE_AGGREGATE\n");
    fs.writeFileSync(path.join(root, ".agentera/plan.yaml"), "tasks:\n  - name: HOSTILE_AGGREGATE\n");
    fs.writeFileSync(path.join(root, "TODO.md"), "HOSTILE_AGGREGATE\n");
    const before = treeDigest(root);
    const prime = capture(root, ["prime", "--format", "json"]);
    expect(prime.rc, JSON.stringify(prime)).toBe(0); expect(prime.out).not.toContain("HOSTILE_AGGREGATE");
    expect(prime.out).toContain("aaaaaaaaaa"); expect(prime.out).toContain('"artifact": "progress"');
    let hookOut = "", hookErr = "";
    expect(runSessionStart(JSON.stringify({ cwd: root }), { out: (text) => hookOut += text, err: (text) => hookErr += text })).toBe(0);
    expect(hookErr).toBe(""); expect(hookOut).toContain("aaaaaaaaaa"); expect(hookOut).not.toContain("HOSTILE_AGGREGATE");
    const compact = capture(root, ["check", "compact", "--project", root, "--mode", "fix", "--format", "json"]);
    expect(compact.rc, compact.err).toBe(0); expect(compact.out).toContain("canonical entity state");
    expect(compact.out).not.toContain("HOSTILE_AGGREGATE"); expect(treeDigest(root)).toBe(before);
  });

  it("fails closed on an invalid marker without reading aggregates", () => {
    const root = project(); fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: bad\nmode: legacy\n");
    fs.writeFileSync(path.join(root, ".agentera/progress.yaml"), "HOSTILE_AGGREGATE\n");
    const result = capture(root, ["state", "progress", "--format", "json"]);
    expect(result.rc).toBe(1); expect(result.out).not.toContain("HOSTILE_AGGREGATE");
    expect(JSON.parse(result.out).error.class).toBe("invalid_state_marker");
  });
});
