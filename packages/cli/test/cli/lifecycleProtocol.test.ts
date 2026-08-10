import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch/index.js";
import { REMOVED_TOP_LEVEL_CORRECTIONS } from "../../src/cli/commands/schema.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { commandText } from "../../src/upgrade/upgradeCommands.js";
import { semanticFindings } from "./retiredVocabulary.js";

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

function alphaId(index: number): string {
  let value = index;
  const chars = Array.from({ length: 10 }, () => {
    const char = String.fromCharCode(97 + (value % 26));
    value = Math.floor(value / 26);
    return char;
  });
  return chars.join("");
}

function planRecord(status: string, created: string, title = "Canonical plan"): Record<string, unknown> {
  return { header: { level: "light", created, status, title }, what: "test", why: "test", scope: { included: ["state"], excluded: [] } };
}

function objectiveRecord(status: string, created: string, title = "Canonical objective"): Record<string, unknown> {
  return {
    header: { created, status, title },
    objective: { description: "test", measurement: "test" },
    metric: { description: "metric", direction: "maximize", unit: "score" },
    baseline: { description: "none" },
    scope: { included: ["state"], excluded: [] },
  };
}

function cutoverProject(): string {
  const root = project();
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  entity(root, "progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "fix", phase: "build", what: "canonical progress", context: { intent: "test" } });
  entity(root, "decisions", "decision", "bbbbbbbbbb", { date: "2026-07-17", question: "Canonical?", context: "test", alternatives: [{ name: "yes", status: "chosen" }], choice: "yes", reasoning: "entity", confidence: "firm" });
  entity(root, "health", "health_audit", "cccccccccc", { date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } });
  entity(root, "plan", "plan", "dddddddddd", planRecord("open", "2026-07-17"));
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
      ["prime", "--context", "build", "--format", "json"],
      ["state", "progress", "--format", "json"],
      ["state", "decisions", "list", "--format", "json"],
      ["state", "todo", "create", "--severity", "normal", "--description", "x", "--format", "json"],
      ["state", "query", "progress", "--format", "json"],
      ["state", "progress", "append", "--input", "-", "--format", "json"],
      ["state", "backfill", "--apply", "--force", "--format", "json"],
      ["state", "migrate", "--artifact", "progress", "--apply", "--force", "--format", "json"],
      ["state", "removed-repair", "--apply", "--force", "--format", "json"],
      ["check", "compact", "--project", root, "--mode", "fix", "--format", "json"],
    ]) {
      const result = capture(root, args, args[1] === "progress" && args[2] === "append" ? "type: fix\nphase: build\nwhat: evidence\ncontext:\n  intent: test\n" : "");
      expect(result.rc).toBe(1); expect(result.err).toBe("");
      expect(JSON.parse(result.out).error).toEqual(expect.objectContaining({
        class: "migration_required",
        recovery: commandText([
          "npx", "-y", "agentera@next", "upgrade", "--channel", "development", "--project", root, "--yes",
        ]),
      }));
      expect(treeDigest(root)).toBe(before);
      expect(fs.existsSync(path.join(root, ".agentera"))).toBe(false);
    }
  });

  it("returns exact removed-command corrections before marker-absent migration diagnostics", () => {
    const root = project();
    fs.writeFileSync(path.join(root, "legacy.txt"), "unchanged\n");
    const before = treeDigest(root);
    for (const [removed, canonical] of Object.entries(REMOVED_TOP_LEVEL_CORRECTIONS)) {
      const result = capture(root, [removed, "--format", "json"]);
      expect(result.rc, removed).toBe(2);
      expect(result.err, removed).toBe("");
      const payload = JSON.parse(result.out);
      expect(payload, removed).toMatchObject({
        schemaVersion: "agentera.invalidInputEnvelope.v2",
        status: "fail",
        error: {
          class: "unsupported_target",
          message: `unknown or not-yet-ported command: ${removed}; this top-level name was removed, use '${canonical}'`,
          valid_values: [canonical],
          syntax: `agentera ${canonical} [options]`,
        },
      });
      expect(payload.error.example).toMatch(/^agentera /);
      expect(payload.error.recovery).toContain(payload.error.example);
      expect(treeDigest(root), removed).toBe(before);
      expect(fs.existsSync(path.join(root, ".agentera")), removed).toBe(false);
    }
  });

  it("rejects removed mutation operations without touching marker-absent state", () => {
    const root = project();
    const before = treeDigest(root);
    const recovery = commandText([
      "npx", "-y", "agentera@next", "upgrade", "--channel", "development", "--project", root, "--yes",
    ]);
    for (const args of [
      ["upgrade", "--project", root, "--restore", "--yes", "--format", "json"],
      ["upgrade", "--project", root, "--only", "runtime", "--yes", "--format", "json"],
    ]) {
      const result = capture(root, args);
      expect(result.rc).not.toBe(0);
      expect(`${result.out}${result.err}`.split(recovery)).toHaveLength(2);
      expect(treeDigest(root)).toBe(before);
    }
  });

  it("keeps only static discovery available before cutover", () => {
    const root = project();
    expect(capture(root, ["state", "query", "--list-artifacts", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["schema", "--format", "json"]).rc).toBe(0);
    expect(capture(root, ["prime", "--guidance", "--format", "json"]).rc).toBe(0);
    const explain = capture(root, ["state", "progress", "explain", "--format", "json"]);
    expect(explain.rc).toBe(0);
    expect(fs.existsSync(path.join(root, ".agentera/entities"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".agentera/state-mode.yaml"))).toBe(false);
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
    const plan = JSON.parse(prime.out).plan;
    expect(plan).toMatchObject({ id: "dddddddddd", artifact: "plan" });
    expect(plan).not.toHaveProperty("tasks");
    expect(plan.first_pending).toEqual(expect.objectContaining({
      id: "eeeeeeeeee",
      artifact: "plan",
      retrieval: { get: "npx -y agentera@next state plan tasks get --id eeeeeeeeee --format json" },
    }));
    expect(plan.first_pending).not.toHaveProperty("number");
    for (const capability of CAPABILITY_NAMES) {
      const result = capture(root, ["prime", "--context", capability, "--format", "json"]);
      expect(result.rc, `${capability}: ${result.out}${result.err}`).toBe(0);
      const capabilityContext = JSON.parse(result.out).capability_context;
      expect(semanticFindings(`runtime://capability-context/${capability}`, capabilityContext)).toEqual([]);
      const context = capabilityContext.context;
      const contextPlan = capability === "status" ? context.status_context.plan : context.plan;
      if (capability === "status") expect(contextPlan).toMatchObject({ id: "dddddddddd", artifact: "plan", exists: true, active: true, status: "open" });
      else expect(contextPlan).toMatchObject({ id: "dddddddddd", artifact: "plan" });
      expect(contextPlan.first_pending).toEqual(expect.objectContaining({ id: "eeeeeeeeee", artifact: "plan" }));
      if (capability === "status") {
        expect(contextPlan).not.toHaveProperty("tasks");
      } else {
        expect(contextPlan.tasks).toEqual([expect.objectContaining({ id: "eeeeeeeeee", artifact: "plan" })]);
        expect(contextPlan.tasks[0]).not.toHaveProperty("number");
      }
    }
    const compact = capture(root, ["check", "compact", "--project", root, "--mode", "fix", "--format", "json"]);
    expect(compact.rc, compact.err).toBe(0); expect(compact.out).toContain("canonical entity state");
    expect(compact.out).not.toContain("HOSTILE_AGGREGATE"); expect(treeDigest(root)).toBe(before);
  });

  it("selects eligible plans and objectives older than twenty ineligible records", () => {
    const root = cutoverProject();
    fs.rmSync(path.join(root, ".agentera/entities/plan"), { recursive: true });
    for (let index = 0; index < 21; index += 1) {
      entity(root, "plan", "plan", alphaId(100 + index), planRecord("complete", `2026-07-${String(31 - index).padStart(2, "0")}`, `Complete ${index}`));
      entity(root, "objective", "objective", alphaId(200 + index), objectiveRecord("closed", `2026-07-${String(31 - index).padStart(2, "0")}`, `Closed ${index}`));
    }
    entity(root, "plan", "plan", "zzzzzzzzza", planRecord("open", "2020-01-01", "Older open plan"));
    entity(root, "plan", "plan_task", "zzzzzzzzzb", { plan: "zzzzzzzzza", name: "Older pending task", status: "pending", depends_on: [], acceptance: ["pass"] });
    entity(root, "objective", "objective", "zzzzzzzzzc", objectiveRecord("active", "2020-01-01", "Older active objective"));

    const result = capture(root, ["prime", "--format", "json"]);
    expect(result.rc, result.out).toBe(0);
    const orientation = JSON.parse(result.out);
    expect(orientation).toMatchObject({
      plan: { id: "zzzzzzzzza", artifact: "plan", first_pending: { id: "zzzzzzzzzb", artifact: "plan" } },
      state_presence: { active: { objective: true } },
    });
    expect(orientation.next_action.alternatives).toContainEqual(expect.objectContaining({
      id: "zzzzzzzzzc",
      artifact: "objective",
      capability: "optimize",
      outcome: "active",
      eligible: true,
      retrieval: { exact: "npx -y agentera@next state objective get --id zzzzzzzzzc --format json" },
    }));
  });

  it("advertises and executes a dependency-ready task outside the bounded plan projection", () => {
    const root = cutoverProject();
    fs.rmSync(path.join(root, ".agentera/entities/plan/plan_task"), { recursive: true });
    const readyId = "zzzzzzzzzz";
    for (let index = 0; index < 20; index += 1) {
      entity(root, "plan", "plan_task", alphaId(100 + index), {
        plan: "dddddddddd",
        name: `Blocked task ${index}`,
        status: "pending",
        depends_on: [readyId],
        acceptance: ["blocked acceptance"],
      });
    }
    entity(root, "plan", "plan_task", readyId, {
      plan: "dddddddddd",
      name: "Ready outside projection",
      status: "pending",
      depends_on: [],
      acceptance: ["outside projection acceptance"],
    });

    const prime = capture(root, ["prime", "--format", "json"]);
    expect(prime.rc, prime.out + prime.err).toBe(0);
    const orientation = JSON.parse(prime.out);
    expect(orientation.plan).toMatchObject({
      total: 21,
      task_count: 21,
      first_pending: {
        id: readyId,
        artifact: "plan",
        name: "Ready outside projection",
        retrieval: { get: `npx -y agentera@next state plan tasks get --id ${readyId} --format json` },
      },
    });
    expect(orientation.plan).not.toHaveProperty("tasks");
    expect(orientation.next_action).toMatchObject({
      object: "PLAN Task ?: Ready outside projection",
      capability: "orchestrate",
      id: readyId,
      artifact: "plan",
      outcome: "pending",
      eligible: true,
      retrieval: { exact: `npx -y agentera@next state plan tasks get --id ${readyId} --format json` },
    });

    const build = capture(root, ["prime", "--context", "build", "--format", "json"]);
    expect(build.rc, build.out + build.err).toBe(0);
    expect(JSON.parse(build.out).capability_context.context.execution_context).toMatchObject({
      work_selection: { task: { id: readyId, name: "Ready outside projection" } },
      plan_task: { id: readyId, depends_on: [] },
      acceptance_criteria: { items: ["outside projection acceptance"] },
    });

    const audit = capture(root, ["prime", "--context", "audit", "--format", "json"]);
    expect(audit.rc, audit.out + audit.err).toBe(0);
    expect(JSON.parse(audit.out).capability_context.context.evidence_context).toMatchObject({
      evaluation_target: { task: { id: readyId, name: "Ready outside projection" } },
      plan_criteria: {
        target: { id: readyId, name: "Ready outside projection" },
        criteria: ["outside projection acceptance"],
      },
    });
  });

  it.each([
    ["plan", "plan", "plan", "open", planRecord] as const,
    ["objective", "objective", "objective", "active", objectiveRecord] as const,
  ])("fails actionably instead of selecting the first competing %s", (_name, artifact, boundary, status, makeRecord) => {
    const root = cutoverProject();
    if (artifact === "plan") fs.rmSync(path.join(root, ".agentera/entities/plan"), { recursive: true });
    entity(root, artifact, boundary, "yyyyyyyyya", makeRecord(status, "2026-07-17", "First"));
    entity(root, artifact, boundary, "yyyyyyyyyb", makeRecord(status, "2026-07-16", "Second"));
    const result = capture(root, ["prime", "--format", "json"]);
    expect(result.rc).not.toBe(0);
    const error = JSON.parse(result.out).error;
    expect(error).toMatchObject({ class: "ambiguous", artifact });
    expect(result.out).toContain("yyyyyyyyya");
    expect(result.out).toContain("yyyyyyyyyb");
    if (artifact === "plan") {
      expect(error).toMatchObject({
        recovery: "npx -y agentera@next state plan replace --predecessor PREDECESSOR_ID --successor SUCCESSOR_ID --format json",
        details: { open_plan_candidates: { total: 2, sample_ids: ["yyyyyyyyya", "yyyyyyyyyb"], omitted_count: 0 } },
      });
    } else expect(result.out).toContain(`state ${artifact} list`);
  });

  it("fails startup on dangling canonical relationships without consulting hostile aggregates", () => {
    const root = cutoverProject();
    fs.writeFileSync(path.join(root, ".agentera/plan.yaml"), "HOSTILE_AGGREGATE\n");
    entity(root, "plan", "plan_task", "xxxxxxxxxx", { plan: "dddddddddd", name: "Dangling", status: "pending", depends_on: ["wwwwwwwwww"], acceptance: ["pass"] });
    const result = capture(root, ["prime", "--format", "json"]);
    expect(result.rc).not.toBe(0);
    expect(result.out).not.toContain("HOSTILE_AGGREGATE");
    expect(JSON.parse(result.out).error).toMatchObject({ class: "corrupt", artifact: "plan" });
    expect(result.out).toContain("does not resolve");
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
