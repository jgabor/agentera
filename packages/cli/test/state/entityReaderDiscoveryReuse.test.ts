import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectEntityOrientation } from "../../src/cli/commands/prime/collectEntityOrientation.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { listDecisionEntities } from "../../src/state/decisionEntities.js";
import { StateRetrievalFailure } from "../../src/state/directRetrieval.js";
import { discoverEntities, type EntityDiscoveryResult } from "../../src/state/entityStorage.js";
import { listHealthEntities } from "../../src/state/healthEntities.js";
import { listExperimentEntities, listObjectiveEntities } from "../../src/state/objectiveExperimentEntities.js";
import { listPlanEntities, listPlanTaskEntities } from "../../src/state/planEntities.js";
import { listProgressEntities } from "../../src/state/progressEntities.js";
import { listTodoDocsEntities } from "../../src/state/todoDocsEntities.js";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const roots: string[] = [];

function id(index: number): string {
  return `aaaaaaaaa${String.fromCharCode(97 + index)}`;
}

function fixture(): { root: string; activePlan: string; activeObjective: string; entityCount: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reader-discovery-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  let next = 0;
  const add = (artifact: string, boundary: string, record: Record<string, unknown>): string => {
    const entityId = id(next++);
    const directory = path.join(root, ".agentera/entities", artifact, boundary);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${entityId}.yaml`), dumpYamlMapping({ id: entityId, artifact, record }));
    return entityId;
  };

  for (const [day, what] of [["17", "First cycle"], ["18", "Second cycle"]]) {
    add("progress", "progress_cycle", { timestamp: `2026-07-${day} 12:00`, type: "test", phase: "audit", what, context: { intent: "Verify reuse" } });
  }
  for (const day of ["17", "18"]) {
    add("decisions", "decision", { date: `2026-07-${day}`, question: `Decision ${day}?`, context: "Reader reuse", alternatives: [{ name: "reuse", status: "chosen" }], choice: "reuse", reasoning: "One parse", confidence: "firm" });
    add("health", "health_audit", { date: `2026-07-${day}`, dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } });
  }

  const activePlan = add("plan", "plan", { header: { level: "light", created: "2026-07-18", status: "open", title: "Active" }, what: "Reuse", why: "Avoid reparsing", scope: { included: ["prime"], excluded: [] } });
  add("plan", "plan_task", { plan: activePlan, name: "First", status: "complete", depends_on: [], acceptance: ["pass"] });
  add("plan", "plan_task", { plan: activePlan, name: "Second", status: "pending", depends_on: [], acceptance: ["pass"] });
  add("plan", "plan", { header: { level: "light", created: "2026-07-17", status: "complete", title: "Complete" }, what: "Done", why: "History", scope: { included: ["prime"], excluded: [] } });

  const activeObjective = add("objective", "objective", { header: { title: "Active objective", status: "open", created: "2026-07-18" }, objective: { description: "Reduce allocation", why: "Cold start", measurement: "Inspector", constraints: [] }, metric: { description: "Peak heap", direction: "minimize", unit: "bytes" }, baseline: { description: "Current peak" }, gates: {}, scope: { included: ["prime"], excluded: [] } });
  add("objective", "objective", { header: { title: "Closed objective", status: "closed", created: "2026-07-17" }, objective: { description: "Prior", why: "History", measurement: "Inspector", constraints: [] }, metric: { description: "Peak heap", direction: "minimize", unit: "bytes" }, baseline: { description: "Prior peak" }, gates: {}, scope: { included: ["prime"], excluded: [] } });
  const experiment = (date: string, status: string, label: string) => ({ objective: activeObjective, date, label, hypothesis: "Reuse helps", method: "Run gate", change: "Share discovery", metric: { primary_value: "1", delta_vs_baseline: "-1" }, regression: "tests pass", status, conclusion: "Measured", provenance: { command: "gate", revision: "fixture" } });
  add("experiments", "experiment", experiment("2026-07-17 09:00", "baseline", "Baseline"));
  add("experiments", "experiment", experiment("2026-07-18 09:00", "kept", "Reuse"));

  add("todo", "todo_item", { severity: "critical", status: "open", description: "Critical item" });
  add("todo", "todo_item", { severity: "normal", status: "open", description: "Normal item" });
  add("docs", "documentation_inventory_entry", { document: "Alpha", path: "a.md", last_updated: "2026-07-18", status: "current" });
  add("docs", "documentation_inventory_entry", { document: "Zulu", path: "z.md", last_updated: "2026-07-17", status: "current" });
  return { root, activePlan, activeObjective, entityCount: next };
}

function expectEquivalent(standalone: Record<string, any>, supplied: Record<string, any>): void {
  expect(supplied).toEqual(standalone);
  expect(supplied.counts).toEqual(standalone.counts);
  expect(supplied.filters).toEqual(standalone.filters);
  expect(supplied.snapshot).toEqual(standalone.snapshot);
  if (Number(standalone.counts.remaining) > 0) {
    expect(supplied.next_cursor).toBe(standalone.next_cursor);
    expect(supplied.snapshot.first_page).toBe(true);
  }
}

function readers(root: string, activePlan: string, activeObjective: string, discovery: EntityDiscoveryResult): Array<[string, () => unknown]> {
  const options = { sourceRoot: SOURCE_ROOT, format: "json", discovery };
  return [
    ["progress", () => listProgressEntities(root, 1, {}, undefined, options)],
    ["decisions", () => listDecisionEntities(root, 1, undefined, undefined, options)],
    ["health", () => listHealthEntities(root, 1, undefined, undefined, options)],
    ["plan", () => listPlanEntities(root, 1, undefined, { ...options, statuses: ["open", "complete"] })],
    ["plan tasks", () => listPlanTaskEntities(root, activePlan, 1, undefined, options)],
    ["objectives", () => listObjectiveEntities(root, 1, undefined, { ...options, statuses: ["open", "closed"] })],
    ["experiments", () => listExperimentEntities(root, activeObjective, 1, undefined, options)],
    ["TODO", () => listTodoDocsEntities(root, "todo", 1, undefined, { status: "open" }, options)],
    ["docs", () => listTodoDocsEntities(root, "docs", 1, undefined, { status: "current" }, options)],
  ];
}

function rejectBeforeEntries(discovery: EntityDiscoveryResult): void {
  Object.defineProperty(discovery, "entities", {
    configurable: true,
    get: () => { throw new Error("foreign discovery entries were consumed"); },
  });
}

function failureClass(call: () => unknown): string {
  try { call(); }
  catch (error) {
    if (error instanceof StateRetrievalFailure) return error.body.error.class;
    throw error;
  }
  throw new Error("expected reader failure");
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("startup entity reader discovery reuse", () => {
  it("keeps standalone and supplied-discovery list envelopes equivalent", () => {
    const { root, activePlan, activeObjective } = fixture();
    const discovery = discoverEntities(root, SOURCE_ROOT);
    const pairs: Array<[Record<string, any>, Record<string, any>]> = [
      [listProgressEntities(root, 1, {}, undefined, { sourceRoot: SOURCE_ROOT, format: "json" }), listProgressEntities(root, 1, {}, undefined, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
      [listDecisionEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT, format: "json" }), listDecisionEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
      [listHealthEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT, format: "json" }), listHealthEntities(root, 1, undefined, undefined, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
      [listPlanEntities(root, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json", statuses: ["open", "complete"] }), listPlanEntities(root, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json", statuses: ["open", "complete"], discovery })],
      [listPlanTaskEntities(root, activePlan, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json" }), listPlanTaskEntities(root, activePlan, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
      [listObjectiveEntities(root, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json", statuses: ["open", "closed"] }), listObjectiveEntities(root, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json", statuses: ["open", "closed"], discovery })],
      [listExperimentEntities(root, activeObjective, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json" }), listExperimentEntities(root, activeObjective, 1, undefined, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
      [listTodoDocsEntities(root, "todo", 1, undefined, { status: "open" }, { sourceRoot: SOURCE_ROOT, format: "json" }), listTodoDocsEntities(root, "todo", 1, undefined, { status: "open" }, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
      [listTodoDocsEntities(root, "docs", 1, undefined, { status: "current" }, { sourceRoot: SOURCE_ROOT, format: "json" }), listTodoDocsEntities(root, "docs", 1, undefined, { status: "current" }, { sourceRoot: SOURCE_ROOT, format: "json", discovery })],
    ];
    for (const [standalone, supplied] of pairs) expectEquivalent(standalone, supplied);
  });

  it("rejects a foreign project discovery in every optional reader before consuming entries", () => {
    const foreign = fixture();
    const requested = fixture();
    const discovery = discoverEntities(foreign.root, SOURCE_ROOT);
    rejectBeforeEntries(discovery);

    for (const [name, call] of readers(requested.root, requested.activePlan, requested.activeObjective, discovery)) {
      expect(call, name).toThrow(/discovery origin does not match.*call discoverEntities/s);
      try { call(); } catch (error) { expect(String(error), name).not.toContain("foreign discovery entries were consumed"); }
    }
  });

  it("rejects a foreign source authority in every optional reader before consuming entries", () => {
    const requested = fixture();
    const foreignSource = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-reader-source-"));
    roots.push(foreignSource);
    fs.symlinkSync(path.join(SOURCE_ROOT, "references"), path.join(foreignSource, "references"), "dir");
    const discovery = discoverEntities(requested.root, foreignSource);
    rejectBeforeEntries(discovery);

    for (const [name, call] of readers(requested.root, requested.activePlan, requested.activeObjective, discovery)) {
      expect(call, name).toThrow(/discovery origin does not match.*source authority/s);
      try { call(); } catch (error) { expect(String(error), name).not.toContain("foreign discovery entries were consumed"); }
    }
  });

  it("preserves standalone and supplied corruption and duplicate failure classes", () => {
    const corrupt = fixture();
    const progressPath = discoverEntities(corrupt.root, SOURCE_ROOT).entities.find(({ boundary }) => boundary === "progress_cycle")!.path;
    fs.writeFileSync(progressPath, "id: [\n");
    const corruptDiscovery = discoverEntities(corrupt.root, SOURCE_ROOT);
    expect(failureClass(() => listProgressEntities(corrupt.root, 20, {}, undefined, { sourceRoot: SOURCE_ROOT }))).toBe("corrupt");
    expect(failureClass(() => listProgressEntities(corrupt.root, 20, {}, undefined, { sourceRoot: SOURCE_ROOT, discovery: corruptDiscovery }))).toBe("corrupt");

    const duplicate = fixture();
    const planPath = path.join(duplicate.root, ".agentera/entities/plan/plan", `${duplicate.activePlan}.yaml`);
    const duplicatePath = path.join(duplicate.root, ".agentera/entities/plan/plan_task", `${duplicate.activePlan}.yaml`);
    fs.copyFileSync(planPath, duplicatePath);
    const duplicateDiscovery = discoverEntities(duplicate.root, SOURCE_ROOT);
    expect(failureClass(() => listPlanEntities(duplicate.root, 20, undefined, { sourceRoot: SOURCE_ROOT }))).toBe("ambiguous");
    expect(failureClass(() => listPlanEntities(duplicate.root, 20, undefined, { sourceRoot: SOURCE_ROOT, discovery: duplicateDiscovery }))).toBe("ambiguous");
  });

  it("reads every canonical entity exactly once during entity orientation", () => {
    const { root, entityCount } = fixture();
    const entityRoot = `${path.join(root, ".agentera/entities")}${path.sep}`;
    const reads = new Map<string, number>();
    const original = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      const candidate = typeof args[0] === "string" ? path.resolve(args[0]) : "";
      if (candidate.startsWith(entityRoot) && candidate.endsWith(".yaml")) reads.set(candidate, (reads.get(candidate) ?? 0) + 1);
      return Reflect.apply(original, fs, args);
    });

    collectEntityOrientation(root, SOURCE_ROOT);

    expect(reads.size).toBe(entityCount);
    expect([...reads.values()]).toEqual(Array.from({ length: entityCount }, () => 1));
  });
});
