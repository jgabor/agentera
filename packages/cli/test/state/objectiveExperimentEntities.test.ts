import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { publishExperimentEntity } from "../../src/state/objectiveExperimentEntities.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";

const roots: string[] = [];
const MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";

function project(entity = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-objective-entities-")); roots.push(root);
  if (entity) { fs.mkdirSync(path.join(root, ".agentera"), { recursive: true }); fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), MARKER); }
  return root;
}
function objective(title: string, status = "open"): Record<string, unknown> {
  return {
    header: { title, status, created: "2026-07-17" },
    objective: { description: `Reduce ${title}`, why: "Users wait", measurement: "Locked p95 harness", constraints: [] },
    metric: { description: "p95 latency", direction: "minimize", unit: "ms" },
    baseline: { description: "100 ms" }, gates: {}, scope: { included: ["CLI"], excluded: ["network"] },
  };
}
function experiment(label: string, status: "baseline" | "kept" = "kept", date = "2026-07-17 09:00"): Record<string, unknown> {
  return { date, label, hypothesis: "Cache helps", method: "Run locked harness", change: "Cache keys", metric: { primary_value: "80 ms", delta_vs_baseline: "-20 ms" }, regression: "pnpm test passed", status, conclusion: "Measured result", provenance: { command: "locked-harness", revision: "abc123" } };
}
function capture(root: string, args: string[], input?: Record<string, unknown>): { rc: number; out: string; err: string; json: any } {
  const cwd = process.cwd(); let out = ""; let err = ""; process.chdir(root);
  try { const rc = main(["node", "agentera", ...args], { out: (text) => { out += text; }, err: (text) => { err += text; }, stdin: input ? () => dumpYamlMapping(input) : undefined }); return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null }; }
  finally { process.chdir(cwd); }
}
function createObjective(root: string, title: string, status = "open"): any {
  const result = capture(root, ["state", "objective", "create", "--input", "-", "--format", "json"], objective(title, status)); expect(result.rc, result.err || result.out).toBe(0); return result.json;
}
function publish(root: string, objectiveId: string, record: Record<string, unknown>): any {
  const result = capture(root, ["state", "experiments", "publish", "--objective", objectiveId, "--input", "-", "--format", "json"], record); expect(result.rc, result.err || result.out).toBe(0); return result.json;
}
function git(root: string, ...args: string[]): string {
  const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE;
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

afterEach(() => { vi.restoreAllMocks(); while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("objective and experiment entity authority", () => {
  it("creates and replaces independent objective entities with bare project-wide IDs", () => {
    const root = project(); const created = createObjective(root, "latency");
    expect(created).toMatchObject({ artifact: "objective", id: expect.stringMatching(/^[a-z]{10}$/), record: { header: { title: "latency" } } });
    expect(created.record.header.id).toBeUndefined();
    const before = path.join(root, `.agentera/entities/objective/objective/${created.id}.yaml`); expect(fs.existsSync(before)).toBe(true);
    const updated = objective("latency v2");
    const result = capture(root, ["state", "objective", "update", "--id", created.id, "--input", "-", "--format", "json"], updated);
    expect(result.rc, result.err).toBe(0); expect(result.json).toMatchObject({ id: created.id, record: { header: { title: "latency v2" } } });
    expect(fs.existsSync(path.join(root, ".agentera/objective.yaml"))).toBe(false);
  });

  it("publishes immutable full experiments related to exactly one objective and replays only exact content", () => {
    const root = project(); const owner = createObjective(root, "latency"); const baseline = publish(root, owner.id, experiment("baseline", "baseline"));
    expect(baseline).toMatchObject({ artifact: "experiments", id: expect.stringMatching(/^[a-z]{10}$/), record: { objective: owner.id, status: "baseline", provenance: { command: "locked-harness" } } });
    expect(baseline.record.number).toBeUndefined();
    const file = path.join(root, `.agentera/entities/experiments/experiment/${baseline.id}.yaml`); const bytes = fs.readFileSync(file);
    const replay = capture(root, ["state", "experiments", "publish", "--objective", owner.id, "--id", baseline.id, "--input", "-", "--format", "json"], experiment("baseline", "baseline"));
    expect(replay.rc).toBe(0); expect(replay.json.operation.idempotent_replay).toBe(true); expect(fs.readFileSync(file)).toEqual(bytes);
    const divergent = capture(root, ["state", "experiments", "publish", "--objective", owner.id, "--id", baseline.id, "--input", "-", "--format", "json"], experiment("changed", "baseline"));
    expect(divergent.rc).not.toBe(0); expect(divergent.json.error.class).toBe("conflict"); expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it("requires one semantic baseline and rejects missing, duplicate, or conflicting ownership before effects", () => {
    const root = project(); const owner = createObjective(root, "latency");
    const missing = capture(root, ["state", "experiments", "publish", "--objective", owner.id, "--input", "-", "--format", "json"], experiment("candidate"));
    expect(missing.rc).not.toBe(0); expect(missing.json.error.class).toBe("conflict"); expect(fs.existsSync(path.join(root, ".agentera/entities/experiments"))).toBe(false);
    const baseline = publish(root, owner.id, experiment("baseline", "baseline"));
    const duplicate = capture(root, ["state", "experiments", "publish", "--objective", owner.id, "--input", "-", "--format", "json"], experiment("other baseline", "baseline"));
    expect(duplicate.rc).not.toBe(0); expect(duplicate.json.error.class).toBe("conflict"); expect(fs.readdirSync(path.dirname(path.join(root, `.agentera/entities/experiments/experiment/${baseline.id}.yaml`)))).toHaveLength(1);
    const other = createObjective(root, "throughput");
    const envelope = loadYamlMapping(fs.readFileSync(path.join(root, `.agentera/entities/experiments/experiment/${baseline.id}.yaml`), "utf8")); (envelope.record as Record<string, unknown>).objective = other.id;
    fs.mkdirSync(path.join(root, ".agentera/entities/experiments/other"), { recursive: true }); fs.writeFileSync(path.join(root, `.agentera/entities/experiments/other/${baseline.id}.yaml`), dumpYamlMapping(envelope));
    expect(validateEntityState(root).valid).toBe(false);
    const before = fs.readdirSync(path.join(root, ".agentera/entities/experiments/experiment"));
    const blocked = capture(root, ["state", "experiments", "publish", "--objective", owner.id, "--input", "-", "--format", "json"], experiment("blocked"));
    expect(blocked.rc).not.toBe(0); expect(blocked.json.error.class).toBe("conflict"); expect(fs.readdirSync(path.join(root, ".agentera/entities/experiments/experiment"))).toEqual(before);
  });

  it("gets and lists full records in declared temporal order with bounded exact recovery and snapshot cursors", () => {
    const root = project(); const owner = createObjective(root, "latency"); const baseline = publish(root, owner.id, experiment("baseline", "baseline", "2026-07-16 09:00")); const candidate = publish(root, owner.id, experiment("candidate", "kept", "2026-07-17 09:00"));
    const exact = capture(root, ["state", "experiments", "get", "--id", baseline.id, "--objective", owner.id, "--format", "json"]); expect(exact.rc).toBe(0); expect(exact.json.entry.record).toEqual(baseline.record); expect(exact.json.entry.provenance.path).toContain(baseline.id);
    const first = capture(root, ["state", "experiments", "list", "--objective", owner.id, "--limit", "1", "--format", "json"]); expect(first.rc).toBe(0); expect(first.json.entries[0].id).toBe(candidate.id); expect(first.json.next_cursor).toBeTruthy(); expect(first.json.retrieval.get).toContain("--id ID");
    expect(capture(root, ["state", "experiments", "list", "--objective", owner.id, "--limit", "101", "--format", "json"]).rc).toBe(2);
    const second = capture(root, ["state", "experiments", "list", "--objective", owner.id, "--limit", "1", "--cursor", first.json.next_cursor, "--format", "json"]); expect(second.rc).toBe(0); expect(second.json.entries[0].id).toBe(baseline.id);
    publish(root, owner.id, experiment("later", "kept", "2026-07-18 09:00"));
    const stale = capture(root, ["state", "experiments", "list", "--objective", owner.id, "--limit", "1", "--cursor", first.json.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(stale.json.error.class).toBe("cursor_snapshot_unavailable");
    expect(capture(root, ["state", "experiments", "get", "--number", "0", "--objective", owner.id, "--format", "json"]).rc).toBe(2);
  });

  it("lists objectives and infers only one active objective for the compatibility query", () => {
    const root = project(); const first = createObjective(root, "first"); createObjective(root, "closed", "closed");
    expect(capture(root, ["state", "objective", "get", "--id", first.id, "--format", "json"]).json.entry.record.header.title).toBe("first");
    const page = capture(root, ["state", "objective", "list", "--limit", "1", "--format", "json"]); expect(page.json.entries).toHaveLength(1); expect(page.json.next_cursor).toBeTruthy();
    expect(capture(root, ["state", "objective", "list", "--limit", "101", "--format", "json"]).rc).toBe(2);
    const help = capture(root, ["state", "experiments", "--help"]); expect(help.out).toContain("get --id ID"); expect(help.out).not.toContain("get --objective OBJECTIVE_ID --number");
    expect(capture(root, ["state", "objective", "--format", "json"]).json.entries[0].id).toBe(first.id);
    createObjective(root, "second"); const stale = capture(root, ["state", "objective", "list", "--limit", "1", "--cursor", page.json.next_cursor, "--format", "json"]); expect(stale.rc).toBe(1); expect(stale.json.error.class).toBe("cursor_snapshot_unavailable"); const ambiguous = capture(root, ["state", "objective", "--format", "json"]); expect(ambiguous.rc).toBe(1); expect(ambiguous.json.error.class).toBe("ambiguous"); expect(ambiguous.json.error.recovery).toContain("--id");
  });

  it("keeps legacy optimize publication and files unchanged while entity mode rejects legacy selectors and paths", () => {
    const legacy = project(false); const directory = path.join(legacy, ".agentera/optimize/latency"); fs.mkdirSync(directory, { recursive: true }); const legacyObjective = objective("legacy"); (legacyObjective.header as Record<string, unknown>).id = "objective:123e4567-e89b-42d3-a456-426614174000"; fs.writeFileSync(path.join(directory, "objective.yaml"), dumpYamlMapping(legacyObjective));
    const result = capture(legacy, ["state", "experiments", "publish", "--objective", String((legacyObjective.header as any).id), "--number", "0", "--input", "-", "--format", "json"], experiment("baseline", "baseline")); expect(result.rc).toBe(0); expect(fs.existsSync(path.join(directory, "experiments.yaml"))).toBe(true); expect(fs.existsSync(path.join(legacy, ".agentera/entities"))).toBe(false);
    const entity = project(); const owner = createObjective(entity, "entity"); expect(capture(entity, ["state", "experiments", "publish", "--objective", owner.id, "--number", "0", "--input", "-", "--format", "json"], experiment("baseline", "baseline")).rc).toBe(2); expect(fs.existsSync(path.join(entity, ".agentera/optimize"))).toBe(false);
  });

  it("lets Git merge unrelated entities, conflicts on one objective update, and validates distinct-path duplicate ownership", () => {
    const root = project(); const first = createObjective(root, "first"); const second = createObjective(root, "second"); git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test"); git(root, "add", ".agentera"); git(root, "commit", "-m", "base");
    const left = `${root}-left`, right = `${root}-right`; roots.push(left, right); git(root, "worktree", "add", "-b", "left", left, "main"); git(root, "worktree", "add", "-b", "right", right, "main"); createObjective(left, "left"); publish(left, first.id, experiment("left baseline", "baseline")); createObjective(right, "right"); publish(right, second.id, experiment("right baseline", "baseline")); git(left, "add", ".agentera/entities"); git(left, "commit", "-m", "left"); git(right, "add", ".agentera/entities"); git(right, "commit", "-m", "right"); git(root, "merge", "--ff-only", "left"); git(root, "merge", "--no-edit", "right"); expect(validateEntityState(root).valid).toBe(true);
    const a = `${root}-a`, b = `${root}-b`; roots.push(a, b); git(root, "worktree", "add", "-b", "a", a, "main"); git(root, "worktree", "add", "-b", "b", b, "main"); for (const [checkout, title] of [[a, "A"], [b, "B"]]) { const update = capture(checkout, ["state", "objective", "update", "--id", first.id, "--input", "-", "--format", "json"], objective(title)); expect(update.rc).toBe(0); git(checkout, "add", ".agentera/entities"); git(checkout, "commit", "-m", title); } git(root, "merge", "--no-edit", "a"); expect(() => git(root, "merge", "--no-edit", "b")).toThrow(); git(root, "merge", "--abort");
    const source = path.join(root, `.agentera/entities/objective/objective/${first.id}.yaml`); const duplicate = path.join(root, `.agentera/entities/experiments/experiment/${first.id}.yaml`); fs.mkdirSync(path.dirname(duplicate), { recursive: true }); fs.copyFileSync(source, duplicate); expect(validateEntityState(root).valid).toBe(false);
  });

  it("rolls back experiment publication on root or marker substitution through the shared context", () => {
    for (const invalidation of ["root", "marker"] as const) {
      const root = project(); const owner = createObjective(root, invalidation); const binding = detectStateModeBinding(root); if (binding.mode !== "entities") throw new Error("entity mode expected");
      const spec = operationSpec("experiments", "publish")!; const req: StateWriteRequest = { artifact: "experiments", spec, projectRoot: root, dryRun: false, force: false, values: { objective: owner.id }, callerPayload: experiment("baseline", "baseline"), input: experiment("baseline", "baseline") };
      const original = binding.publicationContext.publishImmutable.bind(binding.publicationContext); vi.spyOn(binding.publicationContext, "publishImmutable").mockImplementation((relative, bytes) => { const result = original(relative, bytes); if (invalidation === "marker") fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), MARKER + "# changed\n"); else { const held = `${root}-held`; roots.push(held); fs.renameSync(root, held); fs.mkdirSync(root); } return result; });
      expect(() => publishExperimentEntity(req, { publicationContext: binding.publicationContext, candidate: () => "aaaaaaaaaa" })).toThrow(/changed|conflict/i); binding.publicationContext.close();
      const inspected = invalidation === "root" ? `${root}-held` : root; expect(fs.existsSync(path.join(inspected, ".agentera/entities/experiments/experiment/aaaaaaaaaa.yaml"))).toBe(false);
    }
  });
});
