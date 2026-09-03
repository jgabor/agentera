import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { discoverSchemasDir, loadSchemas } from "../../src/cli/appContext.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { loadYamlMapping } from "../../src/core/yaml.js";

const roots: string[] = [];
const storageAuthority = loadYamlMapping(fs.readFileSync(path.resolve(import.meta.dirname, "../../../..", "references/artifacts/state-storage-authority.yaml"), "utf8"));
const forbiddenAliases = new Set((storageAuthority.entity_target as any).public_schema.forbidden_canonical_aliases as string[]);
const convertedSchemas = Object.keys(loadSchemas(discoverSchemasDir())).filter((name) => (storageAuthority.entity_target as any).implementation_status[name] === "implemented");
const convertedQueryAliases = convertedSchemas.flatMap((name) => [...new Set([name, name.replace(/s$/, ""), `${name}s`])].map((alias) => [alias, name] as const));

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
  entity(root, "progress", "progress_cycle", "aaaaaaaaaa", {
    timestamp: "2026-07-17 12:00",
    type: "feat",
    phase: "build",
    what: "new",
    context: { intent: "test" },
  });
  entity(root, "progress", "progress_cycle", "bbbbbbbbbb", {
    timestamp: "2026-07-17 11:00",
    type: "fix",
    phase: "verify",
    what: "old",
    context: { intent: "test" },
  });
  entity(root, "decisions", "decision", "cccccccccc", {
    date: "2026-07-17",
    question: "Cut over?",
    context: "Task11",
    alternatives: [{ name: "yes", status: "chosen" }],
    choice: "yes",
    reasoning: "Canonical",
    confidence: "firm",
  });
  entity(root, "health", "health_audit", "dddddddddd", {
    date: "2026-07-17",
    dimensions: ["architecture_alignment"],
    findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
    trajectory: "stable",
    grades: { architecture_alignment: "A" },
  });
  entity(root, "plan", "plan", "eeeeeeeeee", {
    header: { level: "light", created: "2026-07-17", status: "open", title: "Entity APIs" },
    what: "retrieve",
    why: "bounded",
    scope: { included: ["state"], excluded: [] },
  });
  entity(root, "plan", "plan_task", "ffffffffff", {
    plan: "eeeeeeeeee",
    name: "verify",
    status: "pending",
    depends_on: [],
    acceptance: ["pass"],
  });
  entity(root, "objective", "objective", "gggggggggg", {
    header: { title: "latency", status: "open", created: "2026-07-17" },
    objective: {
      description: "Reduce latency",
      why: "Users wait",
      measurement: "p95",
      constraints: [],
    },
    metric: { description: "p95", direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" },
    gates: {},
    scope: { included: ["CLI"], excluded: [] },
  });
  entity(root, "experiments", "experiment", "hhhhhhhhhh", {
    objective: "gggggggggg",
    date: "2026-07-17 09:00",
    label: "baseline",
    hypothesis: "Measure",
    method: "Harness",
    change: "None",
    metric: { primary_value: "100 ms", delta_vs_baseline: "0" },
    regression: "pass",
    status: "baseline",
    conclusion: "Measured",
    provenance: { command: "fixture", revision: "abc" },
  });
  entity(root, "todo", "todo_item", "iiiiiiiiii", {
    severity: "normal",
    status: "open",
    description: "Entity TODO",
  });
  entity(root, "docs", "documentation_inventory_entry", "jjjjjjjjjj", {
    document: "Entity docs",
    path: "docs/entity.md",
    last_updated: "2026-07-17",
    status: "current",
  });
  return root;
}

function seedLegacySecrets(root: string): void {
  for (const name of convertedSchemas.filter((name) => name !== "todo")) {
    fs.writeFileSync(path.join(root, `.agentera/${name}.yaml`), dumpYamlMapping({ entries: [{ secret: `LEGACY_${name.toUpperCase()}_SECRET` }] }));
  }
  fs.writeFileSync(path.join(root, "TODO.md"), "LEGACY_TODO_SECRET\n");
}

function capture(root: string, args: string[]): { rc: number; json: any; out: string; err: string } {
  const prior = process.cwd();
  let out = "",
    err = "";
  process.chdir(root);
  try {
    const rc = main(["node", "agentera", ...args], {
      out: (text) => (out += text),
      err: (text) => (err += text),
    });
    return { rc, json: out.trim() ? JSON.parse(out) : null, out, err };
  } finally {
    process.chdir(prior);
  }
}

function digest(root: string): string {
  const files = fs
    .readdirSync(path.join(root, ".agentera"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(path.relative(root, file)).update(fs.readFileSync(file));
  return hash.digest("hex");
}

function forbiddenIdentityKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) forbiddenIdentityKeys(item, found);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenAliases.has(key)) found.push(key);
      forbiddenIdentityKeys(child, found);
    }
  return found;
}

function identityObjectsWithoutArtifact(value: unknown, found: string[] = [], location = "$."): string[] {
  if (Array.isArray(value)) value.forEach((item, index) => identityObjectsWithoutArtifact(item, found, `${location}[${index}]`));
  else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && /^[a-z]{10}$/.test(object.id) && typeof object.artifact !== "string") found.push(location);
    for (const [key, child] of Object.entries(object)) identityObjectsWithoutArtifact(child, found, `${location}${key}.`);
  }
  return found;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("entity-mode retrieval and maintenance APIs", () => {
  it("routes every converted default view through canonical entities with bounded recovery", () => {
    const root = seeded();
    const commands = [
      ["state", "progress", "--limit", "1", "--format", "json"],
      ["state", "decisions", "--limit", "1", "--format", "json"],
      ["state", "health", "list", "--format", "json"],
      ["state", "plan", "list", "--limit", "1", "--format", "json"],
      ["state", "experiments", "list", "--objective", "gggggggggg", "--format", "json"],
    ];
    for (const args of commands) {
      const result = capture(root, args);
      expect(result.rc, `${args.join(" ")}: ${result.err || result.out}`).toBe(0);
      expect(forbiddenIdentityKeys(result.json)).toEqual([]);
      expect(identityObjectsWithoutArtifact(result.json)).toEqual([]);
      expect(JSON.stringify(result.json)).toContain('"id"');
      expect(JSON.stringify(result.json)).toContain('"artifact"');
    }
    const first = capture(root, commands[0]);
    expect(first.json.omitted).toBe(true);
    expect(first.json.next_cursor).toBeTruthy();
    const second = capture(root, ["state", "progress", "--limit", "1", "--cursor", first.json.next_cursor, "--format", "json"]);
    expect(second.rc).toBe(0);
    expect(second.json.entries[0].id).toBe("bbbbbbbbbb");
    expect(second.json.snapshot.id).toBe(first.json.snapshot.id);
    expect(capture(root, commands[0]).json).toEqual(first.json);
    const changed = path.join(root, ".agentera/entities/progress/progress_cycle/bbbbbbbbbb.yaml");
    fs.writeFileSync(changed, fs.readFileSync(changed, "utf8").replace("what: old", "what: changed"));
    const stale = capture(root, ["state", "progress", "--limit", "1", "--cursor", first.json.next_cursor, "--format", "json"]);
    expect(stale.rc).toBe(1);
    expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
    const phase = capture(root, ["state", "query", "last-phase", "--format", "json"]);
    expect(phase.json).toMatchObject({ phase: "build", id: "aaaaaaaaaa", artifact: "progress" });
  });

  it("rejects the generated alias matrix before generic aggregate dispatch in entity JSON and text", () => {
    const root = seeded();
    seedLegacySecrets(root);
    expect(convertedQueryAliases.map(([alias]) => alias)).toEqual(expect.arrayContaining(["decisionss", "progresss", "experimentss", "docss"]));
    for (const [alias, canonical] of convertedQueryAliases) {
      const json = capture(root, ["state", "query", alias, "--format", "json"]);
      expect(json.rc, alias).toBe(1);
      expect(json.err).toBe("");
      expect(json.json.error).toMatchObject({
        class: "unsupported_target",
        recovery: expect.stringContaining(`agentera state ${canonical}`),
      });
      expect(json.out).not.toContain("LEGACY_");
      const implicit = capture(root, ["state", "query", alias]);
      expect(implicit.rc).toBe(1);
      expect(implicit.err).toBe("");
      expect(implicit.json.error.recovery).toContain(`agentera state ${canonical}`);
      expect(implicit.out).not.toContain("LEGACY_");
    }
  });

  it("keeps direct singleton-style views and special query operations on entity authority", () => {
    const root = seeded();
    seedLegacySecrets(root);
    for (const family of ["docs", "objective"]) {
      const result = capture(root, ["state", family, "--format", "json"]);
      expect(result.rc, `${family}: ${result.err || result.out}`).toBe(2);
      expect(result.json.error).toMatchObject({
        class: "invalid_request",
        recovery: expect.stringContaining(`state ${family} list`),
      });
      expect(result.out).not.toContain("LEGACY_");
    }
    const todo = capture(root, ["state", "todo", "--format", "json"]);
    expect(todo.rc).toBe(0);
    expect(todo.out).toContain('"artifact": "todo"');
    expect(todo.out).not.toContain("LEGACY_");
    const phase = capture(root, ["state", "query", "last-phase", "--format", "json"]);
    expect(phase.rc).toBe(0);
    expect(phase.json).toMatchObject({ phase: "build", id: "aaaaaaaaaa", artifact: "progress" });
    expect(phase.out).not.toContain("LEGACY_");
    const inventory = capture(root, ["state", "query", "--list-artifacts", "--format", "json"]);
    expect(inventory.rc).toBe(0);
    expect(inventory.json.names).toEqual(expect.arrayContaining(convertedSchemas));
  });

  it("preserves every generated generic alias byte-for-byte while the marker is absent", () => {
    const root = seeded();
    seedLegacySecrets(root);
    fs.rmSync(path.join(root, ".agentera/state-mode.yaml"));
    for (const format of ["json", "text"]) {
      for (const family of convertedSchemas) {
        const canonical = capture(root, ["state", "query", family, "--format", format]);
        for (const [alias, target] of convertedQueryAliases.filter(([, target]) => target === family)) {
          const result = capture(root, ["state", "query", alias, "--format", format]);
          expect({ rc: result.rc, out: result.out, err: result.err }, `${format}:${alias}`).toEqual({
            rc: canonical.rc,
            out: canonical.out,
            err: canonical.err,
          });
        }
      }
    }
    const legacy = capture(root, ["state", "query", "decision", "--format", "json"]);
    expect(legacy.rc).toBe(1);
    expect(legacy.json.error.class).toBe("migration_required");
    expect(legacy.out).not.toContain("LEGACY_DECISIONS_SECRET");
  });

  it("fails closed on an invalid mode marker instead of reading a legacy aggregate", () => {
    const root = seeded();
    seedLegacySecrets(root);
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: wrong\nmode: legacy\n");
    const invalid = capture(root, ["state", "query", "decision", "--format", "json"]);
    expect(invalid.rc).toBe(1);
    expect(invalid.json.error.class).toBe("invalid_state_marker");
    expect(invalid.out).not.toContain("LEGACY_DECISIONS_SECRET");
  });

  it("bounds exact pretty JSON stdout for decision and plan entity views including envelope overhead", () => {
    const decisions = project();
    for (const [id, date] of [
      ["aaaaaaaaaa", "2026-07-17"],
      ["bbbbbbbbbb", "2026-07-16"],
    ])
      entity(decisions, "decisions", "decision", id, {
        date,
        question: "Q",
        context: "C",
        alternatives: [{ name: "yes", status: "chosen" }],
        choice: "yes",
        reasoning: "x".repeat(15_700),
        confidence: "firm",
      });
    const decisionView = capture(decisions, ["state", "decisions", "--limit", "2", "--format", "json"]);
    expect(decisionView.rc, decisionView.err).toBe(0);
    expect(Buffer.byteLength(decisionView.out, "utf8")).toBeLessThanOrEqual(32_768);
    expect(decisionView.json).toMatchObject({
      status: "degraded",
      counts: { returned: 2, omitted: 0 },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 2 },
    });

    const plans = project();
    entity(plans, "plan", "plan", "cccccccccc", {
      header: { level: "light", created: "2026-07-17", status: "open", title: "Bounded" },
      what: "x".repeat(20_000),
      why: "Y",
      scope: { included: ["state"], excluded: [] },
    });
    for (const id of ["dddddddddd", "eeeeeeeeee"])
      entity(plans, "plan", "plan_task", id, {
        plan: "cccccccccc",
        name: "Task",
        status: "pending",
        depends_on: [],
        acceptance: ["x".repeat(16_000)],
      });
    const planView = capture(plans, ["state", "plan", "tasks", "list", "cccccccccc", "--limit", "2", "--format", "json"]);
    expect(planView.rc, planView.err).toBe(0);
    expect(Buffer.byteLength(planView.out, "utf8")).toBeLessThanOrEqual(32_768);
    expect(planView.json).toMatchObject({
      status: "degraded",
      counts: { returned: 2, omitted: 0 },
      degradation: { reason: "optional_detail_byte_budget", detail_omitted_count: 2 },
    });
    expect(planView.json.filters.plan).toBe("cccccccccc");
  });

  it("rejects every legacy selector and reports exact missing IDs", () => {
    const root = seeded();
    for (const args of [
      ["state", "progress", "get", "--number", "1", "--format", "json"],
      ["state", "plan", "get", "--plan", "plan:123e4567-e89b-42d3-a456-426614174000", "--format", "json"],
      ["state", "plan", "tasks", "get", "--task", "1", "--format", "json"],
      ["state", "plan", "tasks", "list", "--plan", "eeeeeeeeee", "--format", "json"],
    ]) {
      const result = capture(root, args);
      expect(result.rc).toBe(2);
      expect(result.json.error.syntax).not.toMatch(/--number|--plan\b|--task\b/);
      expect(forbiddenIdentityKeys(result.json)).toEqual([]);
    }
    const missing = capture(root, ["state", "progress", "get", "--id", "zzzzzzzzzz", "--format", "json"]);
    expect(missing.rc).toBe(1);
    expect(missing.json.error).toMatchObject({
      class: "not_found",
      id: "zzzzzzzzzz",
      artifact: "progress",
    });
  });

  it("corrects bare plan reads to canonical list/get commands", () => {
    const none = project();
    entity(none, "plan", "plan", "aaaaaaaaaa", {
      header: { level: "light", created: "2026-07-17", status: "complete", title: "Done" },
      what: "W",
      why: "Y",
      scope: { included: ["state"], excluded: [] },
    });
    const missing = capture(none, ["state", "plan", "--format", "json"]);
    expect(missing.rc).toBe(2);
    expect(missing.json.error).toMatchObject({
      class: "invalid_request",
      syntax: expect.stringContaining("state plan get --id ID"),
      recovery: expect.stringContaining("state plan list"),
    });
    const many = seeded();
    entity(many, "plan", "plan", "kkkkkkkkkk", {
      header: { level: "light", created: "2026-07-16", status: "open", title: "Other" },
      what: "W",
      why: "Y",
      scope: { included: ["state"], excluded: [] },
    });
    const ambiguous = capture(many, ["state", "plan", "--format", "json"]);
    expect(ambiguous).toEqual(missing);
  });

  it("validates complete and empty graphs without mutating files", () => {
    for (const root of [seeded(), project()]) {
      const before = digest(root);
      const result = capture(root, ["check", "validate", "state", "--format", "json"]);
      expect(result.rc, result.err || result.out).toBe(0);
      expect(result.json.valid).toBe(true);
      expect(digest(root)).toBe(before);
    }
  });
});
