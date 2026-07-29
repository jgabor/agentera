import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { main } from "../../src/cli/dispatch/index.js";
import { cmdPrime, collectOrientationState } from "../../src/cli/commands/prime.js";
import { buildOrientationJsonPayload } from "../../src/cli/commands/prime/orientationOutput.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { planSummary } from "../../src/cli/orientation.js";
import { PRIME_BLOB } from "../../src/cli/prime-blob.js";
import { appendHealthEntity } from "../../src/state/healthEntities.js";
import { operationSpec } from "../../src/state/write/operations.js";
import type { SchemaInfo } from "../../src/cli/appContext.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("prime schema loading", () => {
  it("keeps current-state schemas internal without marker-dependent fallback", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "prime-schema-loading-"));
    const home = path.join(project, "home");
    const previousCwd = process.cwd();
    const previousSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
    fs.mkdirSync(home);
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
    process.chdir(project);

    try {
      fs.writeFileSync(
        path.join(project, ".agentera/state-mode.yaml"),
        "schemaVersion: agentera.stateMode.v1\nmode: entities\n",
      );
      const entityState = collectOrientationState({ home, env: process.env });
      const entityPayload = buildOrientationJsonPayload(entityState, "prime");
      expect(entityState.schemas).toEqual({});
      expect(entityState.schemas_dir).toBe(path.join(REPO_ROOT, "skills/agentera/schemas/artifacts"));
      expect(entityPayload).not.toHaveProperty("schemas");

      fs.rmSync(path.join(project, ".agentera/state-mode.yaml"));
      const markerAbsentDirectState = collectOrientationState({ home, env: process.env });
      expect(markerAbsentDirectState.schemas).toEqual({});
      expect(markerAbsentDirectState.schemas_dir).toBe(entityState.schemas_dir);
      expect(buildOrientationJsonPayload(markerAbsentDirectState, "prime")).not.toHaveProperty("schemas");
    } finally {
      process.chdir(previousCwd);
      if (previousSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
      else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousSourceRoot;
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

describe("cli prime", () => {
  it("prints the static guidance for --guidance", () => {
    const { rc, out } = capture((io) => cmdPrime({ guidance: true }, io));
    expect(rc).toBe(0);
    expect(out).toBe(PRIME_BLOB);
    expect(out).toContain("agentera state <artifact> explain --format json");
    expect(out).toContain("Supported typed writes:");
    expect(out).toContain("--dry-run");
  });

  it("renders the default text orientation briefing", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime" }, io));
    expect(rc).toBe(0);
    expect(out.startsWith("agentera prime\n")).toBe(true);
    expect(out).toContain("app_home: install_track=");
    expect(out).toContain("status=");
    expect(out).toContain("mode: ");
    expect(out).toContain("shared_skill: status=");
    expect(out).toContain("todo: critical=");
    expect(out).toContain("next_action:");
    expect(out).toContain("| phase=");
    expect(out).toContain("- alt: ");
    expect(out).toContain("source_contract:");
    expect(out).toContain("capability_startup_complete=true");
    expect(out).toContain("artifact_writes: discover via");
  });

  it("rejects mutually-exclusive prime modes", () => {
    expect(capture((io) => cmdPrime({ context: "plan", dashboard: true }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ context: "plan", guidance: true }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ dashboard: true, guidance: true }, io)).rc).toBe(2);
  });

  it("emits a default JSON orientation payload (bespoke contexts null)", () => {
    const { rc, out, err } = capture((io) => cmdPrime({ command: "prime", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime");
    expect(payload.status).toBe("ok");
    expect(payload.orchestration_context).toBeNull();
    expect(payload.closeout_context).toBeNull();
    expect(payload.execution_context).toBeNull();
    expect(payload.source_contract.capability_context).not.toBeNull();
    expect(typeof payload.source_contract.capability_context).toBe("object");
    expect(payload.source_contract.capability_context.capability).toBe("status");
    expect(payload.source_contract.capability_context.fetch_command).toBe("agentera prime --context status --format json");
    expect(payload.source_contract.capability_context.required_before_rendering).toBe(true);
    // The bare default is a bounded decision brief (Plan Task 3): the writer
    // contract detail (artifact_writes.artifacts) is omitted and recovered via
    // `agentera schema` or the full --dashboard payload. The discovery pointer
    // and schema identity stay so consumers can recover without raw access.
    expect(payload.source_contract.artifact_writes).toMatchObject({
      schemaVersion: "agentera.stateWriterDiscovery.v1",
      discovery_command: "agentera schema --format json",
    });
    expect(payload.source_contract.artifact_writes.artifacts).toBeUndefined();
    expect(payload.brief.status).toBe("ok");
    expect(payload.brief.omitted_rich_state.some((e: { field: string }) => e.field === "source_contract.artifact_writes.artifacts")).toBe(true);
    expect(payload.source_contract.fields).toContain("todo");
    expect(payload.source_contract.fields).not.toContain("issues");
    expect(payload.source_contract.fields).toContain("next_action");
    expect(payload.todo).toEqual(
      expect.objectContaining({
        critical: expect.any(Number),
        degraded: expect.any(Number),
        normal: expect.any(Number),
        annoying: expect.any(Number),
      }),
    );
    expect(payload.issues).toEqual({
      critical: payload.todo.critical,
      degraded: payload.todo.degraded,
      normal: payload.todo.normal,
      annoying: payload.todo.annoying,
    });
    expect(payload.issues).not.toHaveProperty("detail");
    expect(payload.todo.detail).toMatchObject({
      total: expect.any(Number),
      returned: expect.any(Number),
      omitted: expect.any(Number),
    });
    expect(err).toContain("Deprecation: prime JSON field 'issues' is deprecated; use 'todo'");
    expect(err).toContain("3.0.0 stable cut");
    expect(out).not.toContain("Deprecation:");
    expect(payload.app).toBeTruthy();
    expect(payload.app_home.install_track).toBeTruthy();
    expect(payload.shared_skill.path).toContain(".agents/skills/agentera");
    expect(payload).not.toHaveProperty("runtime_lifecycle");
    expect(typeof payload.app.status).toBe("string");
  });

  it("keeps full-fidelity payload on --dashboard (brief omission is default-only)", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", dashboard: true, format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    // --dashboard is NOT projected: the full writer contract, plan tasks, and
    // runtime detail remain available without a brief meta block.
    expect(payload.source_contract.artifact_writes.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact: "decisions", mutations: ["append", "update", "amend"] }),
      ]),
    );
    expect(Array.isArray(payload.plan?.tasks)).toBe(true);
    expect(payload.brief).toBeUndefined();
  });

  it("surfaces ranked next_action with alternatives and phase in JSON", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", format: "json" }, io));
    expect(rc).toBe(0);
    const nextAction = JSON.parse(out).next_action as Record<string, unknown>;
    expect(typeof nextAction.object).toBe("string");
    expect((nextAction.object as string).length).toBeGreaterThan(0);
    expect(typeof nextAction.capability).toBe("string");
    expect((nextAction.capability as string).length).toBeGreaterThan(0);
    expect(typeof nextAction.reason).toBe("string");
    expect(typeof nextAction.phase).toBe("string");
    expect((nextAction.phase as string).length).toBeGreaterThan(0);
    const alternatives = nextAction.alternatives as Array<Record<string, unknown>>;
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives.length).toBeGreaterThan(0);
    for (const alt of alternatives) {
      expect(typeof alt.object).toBe("string");
      expect(typeof alt.capability).toBe("string");
      expect(typeof alt.reason).toBe("string");
      expect(typeof alt.phase).toBe("string");
      expect((alt.phase as string).length).toBeGreaterThan(0);
    }
  });

  it("requires json for --dashboard and --context", () => {
    expect(capture((io) => cmdPrime({ dashboard: true, format: "text" }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ context: "plan", format: "text" }, io)).rc).toBe(2);
  });

  it("supports --fields selection on the JSON payload", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", format: "json", fields: "plan" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(Object.keys(payload).sort()).toEqual(["command", "plan", "status"]);
  });

  it("selects todo via --fields without emitting a deprecation warning", () => {
    const { rc, out, err } = capture((io) =>
      cmdPrime({ command: "prime", format: "json", fields: "todo" }, io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(Object.keys(payload).sort()).toEqual(["command", "status", "todo"]);
    expect(payload.todo).toEqual(
      expect.objectContaining({
        critical: expect.any(Number),
        degraded: expect.any(Number),
        normal: expect.any(Number),
        annoying: expect.any(Number),
      }),
    );
    expect(err).toBe("");
  });

  it("selects issues via --fields with a deprecation warning", () => {
    const { rc, out, err } = capture((io) =>
      cmdPrime({ command: "prime", format: "json", fields: "issues" }, io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(Object.keys(payload).sort()).toEqual(["command", "issues", "status"]);
    expect(payload.issues).toEqual(
      expect.objectContaining({
        critical: expect.any(Number),
        degraded: expect.any(Number),
        normal: expect.any(Number),
        annoying: expect.any(Number),
      }),
    );
    expect(payload.issues).not.toHaveProperty("detail");
    expect(err).toContain("Deprecation: prime JSON field 'issues' is deprecated; use 'todo'");
    expect(err).toContain("3.0.0 stable cut");
  });

  it("rejects an unsupported --fields value for prime", () => {
    const { rc, err } = capture((io) => cmdPrime({ command: "prime", format: "json", fields: "bogusfield" }, io));
    expect(rc).toBe(1);
    expect(err).toContain("unsupported field 'bogusfield'");
  });

  it("emits a capability context for a non-bespoke capability (planera)", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "plan", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime");
    expect(payload.capability_context.schemaVersion).toBe("agentera.capabilityContext.v1");
    expect(payload.capability_context.capability).toBe("plan");
    expect(payload.capability_context.context.planning_context).toBeTruthy();
    expect(payload.capability_context.context.planning_context.startup_contract.schemaVersion).toBe(
      "agentera.planeraStartup.v1",
    );
    expect(payload.capability_context.state.write_contract).toMatchObject({
      schemaVersion: "agentera.stateWriterDiscovery.v1",
      artifacts: [
        expect.objectContaining({
          artifact: "plan",
          mutations: ["append", "update", "set-status", "supersede", "set-plan-status", "record-evaluation", "archive", "create"],
        }),
      ],
      unsupported_targets: ["plan_archive"],
    });
    const planning = payload.capability_context.context.planning_context.startup_contract.planning;
    expect(planning.task_coherence_rule).toBe(
      "Keep full-plan tasks within a coherent lifecycle boundary; split only at real lifecycle or coherence boundaries.",
    );
    expect(planning).not.toHaveProperty(["max", "full", "plan", "tasks"].join("_"));
  });

  it("emits the orchestration bespoke context for orkestrera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "orchestrate", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.capability_context.capability).toBe("orchestrate");
    const ctx = payload.capability_context.context;
    expect(ctx.orchestration_context).toBeTruthy();
    expect(ctx.orchestration_context.capability).toBe("orchestrate");
    expect(ctx.orchestration_context.task_queue).toBeTruthy();
    expect(ctx.orchestration_context.evaluator_handoff).toMatchObject({
      output_requirements: {
        citation_required_for: ["WARN", "FAIL"],
        warn_verify_command_required: true,
        schema_authority: "references/cli/capability-instruction-contract.yaml#evaluator_handoff",
      },
    });
  });

  it("emits the execution bespoke context for realisera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "build", format: "json" }, io));
    expect(rc).toBe(0);
    const ctx = JSON.parse(out).capability_context.context;
    expect(ctx.execution_context).toBeTruthy();
    expect(ctx.execution_context.capability).toBe("build");
    expect(ctx.execution_context.work_selection).toBeTruthy();
    expect(ctx.execution_context.changelog_boundary).toBeTruthy();
  });

  it("emits the evidence bespoke context for inspektera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "audit", format: "json" }, io));
    expect(rc).toBe(0);
    const ctx = JSON.parse(out).capability_context.context;
    expect(ctx.evidence_context).toBeTruthy();
    expect(ctx.evidence_context.capability).toBe("audit");
    expect(ctx.evidence_context.version_checks).toBeTruthy();
    expect(ctx.evidence_context.decision_review_pressure).toBeTruthy();
    expect(ctx.evidence_context.residual_risks).toBeTruthy();
  });

  it("emits the benchmark bespoke context for optimera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "optimize", format: "json" }, io));
    expect(rc).toBe(0);
    const ctx = JSON.parse(out).capability_context.context;
    expect(ctx.benchmark_context).toBeTruthy();
    expect(ctx.benchmark_context.capability).toBe("optimize");
    expect(ctx.benchmark_context.privacy_boundary.status).toBe("enforced");
    expect(ctx.benchmark_context.manual_refresh.command).toBe("mage bench:startupState");
  });

  it("emits the closeout bespoke context for dokumentera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "document", format: "json" }, io));
    expect(rc).toBe(0);
    const ctx = JSON.parse(out).capability_context.context;
    expect(ctx.closeout_context).toBeTruthy();
    expect(ctx.closeout_context.capability).toBe("document");
    expect(ctx.closeout_context.release_boundary).toBeTruthy();
    expect(ctx.closeout_context.version_policy).toBeTruthy();
  });

  it("derives audit and document decision pressure only from bounded decision entities", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "prime-entity-decisions-"));
    const previousCwd = process.cwd();
    const previousSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    const decisionDir = path.join(project, ".agentera/entities/decisions/decision");
    const satisfactionDir = path.join(project, ".agentera/entities/decisions/decision_satisfaction");
    fs.mkdirSync(decisionDir, { recursive: true });
    fs.mkdirSync(satisfactionDir, { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(decisionDir, "aaaaaaaaaa.yaml"), [
      "id: aaaaaaaaaa",
      "artifact: decisions",
      "record:",
      "  date: 2026-07-01",
      "  question: Entity authority?",
      "  context: Audit startup",
      "  alternatives:",
      "    - name: entities",
      "      status: chosen",
      "  choice: entities",
      "  reasoning: Canonical ownership",
      "  confidence: firm",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(satisfactionDir, "bbbbbbbbbb.yaml"), [
      "id: bbbbbbbbbb",
      "artifact: decisions",
      "record:",
      "  decision: aaaaaaaaaa",
      "  state: open",
      "  review_needed: true",
      "  review_due: 2026-07-01",
      "",
    ].join("\n"));
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
    process.chdir(project);
    try {
      const context = (capability: "audit" | "document") => {
        const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: capability, format: "json" }, io));
        expect(rc).toBe(0);
        return JSON.parse(out).capability_context.context;
      };
      const auditBefore = context("audit").evidence_context;
      const documentBefore = context("document").closeout_context;
      fs.writeFileSync(path.join(project, ".agentera/decisions.yaml"), [
        "decisions:",
        "  - number: 999",
        "    question: HOSTILE LEGACY DECISION",
        "    satisfaction:",
        "      review_needed: true",
        "      review_due: 1999-01-01",
        "",
      ].join("\n"));
      const auditAfter = context("audit").evidence_context;
      const documentAfter = context("document").closeout_context;
      expect(auditAfter).toEqual(auditBefore);
      expect(documentAfter).toEqual(documentBefore);
      expect(auditAfter.decision_context).toMatchObject({
        status: "caveated",
        summary: { total_entries: 1, returned_entries: 0, omitted_entries: 1, authority: "canonical_entity_files" },
        caveats: [expect.stringContaining("agentera state decisions list --limit 20 --format json")],
      });
      expect(auditAfter.decision_review_pressure).toMatchObject({
        status: "degraded",
        summary: { protected_active_decisions: 0, total_decisions: 1, omitted_decisions: 1 },
        stale_protected_decisions: [],
        source_provenance: { command: "agentera state decisions list --limit 20 --format json" },
      });
      expect(JSON.stringify(auditAfter)).not.toContain("HOSTILE LEGACY DECISION");
    } finally {
      process.chdir(previousCwd);
      if (previousSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
      else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousSourceRoot;
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it("serves --context for all 12 capabilities (no gate)", () => {
    const caps = ["status", "vision", "discuss", "research", "plan", "build",
      "optimize", "audit", "document", "profile", "design", "orchestrate"];
    for (const cap of caps) {
      const { rc } = capture((io) => cmdPrime({ context: cap, format: "json" }, io));
      expect(rc).toBe(0);
    }
  });

  it("rejects an unknown --context capability", () => {
    const { rc, err } = capture((io) => cmdPrime({ context: "bogus", format: "json" }, io));
    expect(rc).toBe(2);
    expect(err).toContain("unsupported capability 'bogus'");
  });
});

describe("orkestrera orchestration_context task_queue", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-orch-queue-"));
    prevCwd = process.cwd();
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".agentera/plan.yaml"),
      [
        "header:",
        "  title: Dependency queue regression",
        "  status: active",
        "tasks:",
        "  - number: 1",
        "    name: First task",
        "    status: complete",
        "    depends_on: []",
        "  - number: 2",
        "    name: Second task",
        "    status: pending",
        "    depends_on:",
        '      - "1"',
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (const [boundary, id, record] of [
      ["plan", "aaaaaaaaaa", "header:\n  level: light\n  created: 2026-07-17\n  title: Dependency queue regression\n  status: open\nwhat: test\nwhy: test\nscope:\n  included: [state]\n  excluded: []\n"],
      ["plan_task", "bbbbbbbbbb", "plan: aaaaaaaaaa\nname: First task\nstatus: complete\ndepends_on: []\nacceptance: []\n"],
      ["plan_task", "cccccccccc", "plan: aaaaaaaaaa\nname: Second task\nstatus: pending\ndepends_on: [dddddddddd]\nacceptance: []\n"],
      ["plan_task", "dddddddddd", "plan: aaaaaaaaaa\nname: Superseded task\nstatus: superseded\nsuperseded_by: [bbbbbbbbbb]\nsuperseded_reason: Replacement task completed the work.\ndepends_on: []\nacceptance: []\n"],
    ] as const) {
      const dir = path.join(tmp, ".agentera/entities/plan", boundary);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.yaml`), `id: ${id}\nartifact: plan\nrecord:\n${record.split("\n").filter(Boolean).map((line) => `  ${line}`).join("\n")}\n`);
    }
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("unblocks dependents when a string depends_on ref matches an integer task number", () => {
    const planPath = path.join(tmp, ".agentera/plan.yaml");
    const schemas: Record<string, SchemaInfo> = {
      plan: { path: planPath, record: undefined, schema: {}, fields: {} },
    };
    const plan = planSummary(schemas);
    expect(plan.tasks[0].status).toBe("complete");
    expect(plan.tasks[1].depends_on).toEqual(["1"]);

    const state = collectOrientationState({ env: process.env });
    const payload = buildPrimeCapabilityContextPayload(state, "orchestrate");
    const orch = payload.capability_context.context.orchestration_context as Record<string, unknown>;
    const taskQueue = orch.task_queue as Record<string, unknown>;
    const ready = (taskQueue.dependency_ready_tasks as Array<{ id: string }>).map((t) => t.id);
    const blocked = taskQueue.blocked_tasks as Array<{ id: string; blocked_reasons?: string[] }>;
    const allReasons = blocked.flatMap((t) => t.blocked_reasons ?? []);

    expect(ready).toContain("cccccccccc");
    expect(blocked.some((t) => t.id === "cccccccccc")).toBe(false);
    expect(allReasons.some((r) => r.includes("dependency bbbbbbbbbb is not present in plan tasks"))).toBe(false);
    expect((orch.task_summaries as Array<{ id: string; status: string }>)[0].status).toBe("complete");
    expect(taskQueue).toMatchObject({ total: 3, complete: 1, superseded: 1 });
    expect(ready).not.toContain("dddddddddd");
    expect(blocked.some((t) => t.id === "dddddddddd")).toBe(false);
    expect((orch.selected_next_action as Record<string, unknown>)?.object).toBeTruthy();
  });

  it("matches prime --context orchestrate --format json task_queue to task_summaries", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "orchestrate", format: "json" }, io));
    expect(rc).toBe(0);
    const orch = JSON.parse(out).capability_context.context.orchestration_context;
    const ready = orch.task_queue.dependency_ready_tasks.map((t: { id: string }) => t.id);
    const blockedReasons = orch.task_queue.blocked_tasks.flatMap(
      (t: { blocked_reasons?: string[] }) => t.blocked_reasons ?? [],
    );

    expect(ready).toContain("cccccccccc");
    expect(blockedReasons.some((r: string) => r.includes("dependency bbbbbbbbbb is not present in plan tasks"))).toBe(false);
  });

  it("keeps terminal-open plans distinct from missing-plan bootstrap", () => {
    fs.writeFileSync(
      path.join(tmp, ".agentera/entities/plan/plan_task/cccccccccc.yaml"),
      dumpYamlMapping({
        id: "cccccccccc",
        artifact: "plan",
        record: {
          plan: "aaaaaaaaaa",
          name: "Second task",
          status: "complete",
          depends_on: ["dddddddddd"],
          acceptance: [],
        },
      }),
    );
    const terminal = buildPrimeCapabilityContextPayload(collectOrientationState({ env: process.env }), "orchestrate") as any;
    expect(terminal.capability_context.context.plan).toMatchObject({
      exists: true,
      active: true,
      complete_plan: true,
    });
    expect(terminal.capability_context.context.orchestration_context.selected_next_task).toBeNull();
    expect(terminal.capability_context.state.declared_write_targets).toContain("health");

    fs.rmSync(path.join(tmp, ".agentera/entities/plan"), { recursive: true, force: true });
    const missing = buildPrimeCapabilityContextPayload(collectOrientationState({ env: process.env }), "orchestrate") as any;
    expect(missing.capability_context.context.plan).toMatchObject({
      exists: false,
      active: false,
      complete_plan: false,
    });
    expect(missing.capability_context.context.orchestration_context.selected_next_task).toBeNull();
  });

  it("selects the later same-day health append as current regardless of health ID", () => {
    const spec = operationSpec("health", "append");
    if (!spec) throw new Error("health append spec missing");
    const audit = {
      date: "2026-07-17",
      dimensions: ["artifact_freshness"],
      findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 },
      trajectory: "stable",
      grades: { artifact_freshness: "A" },
      dimensions_detail: [{
        name: "artifact_freshness",
        grade: "A",
        summary: "Current entity is selected by CLI-owned append time.",
        findings: [],
      }],
    };
    const request = () => ({ artifact: "health", spec, projectRoot: tmp, dryRun: false, force: false, values: {}, callerPayload: structuredClone(audit), input: structuredClone(audit) });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-17T10:00:00.000Z"));
      appendHealthEntity(request(), { id: "eeeeeeeeee" });
      vi.setSystemTime(new Date("2026-07-17T11:00:00.000Z"));
      appendHealthEntity(request(), { id: "zzzzzzzzzz" });

      expect(collectOrientationState({ env: process.env }).health).toMatchObject({
        id: "zzzzzzzzzz",
        date: "2026-07-17",
        grade: "A",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("indexes oversized task graphs exactly while returning bounded orchestration detail with recovery", () => {
    const planId = "zzzzzzzzzz"; const taskIds = Array.from({ length: 22 }, (_, index) => `${String.fromCharCode(97 + index)}aaaaaaaaa`);
    fs.rmSync(path.join(tmp, ".agentera/entities/plan"), { recursive: true, force: true });
    const planDirectory = path.join(tmp, ".agentera/entities/plan/plan"); const taskDirectory = path.join(tmp, ".agentera/entities/plan/plan_task"); fs.mkdirSync(planDirectory, { recursive: true }); fs.mkdirSync(taskDirectory, { recursive: true });
    fs.writeFileSync(path.join(planDirectory, `${planId}.yaml`), dumpYamlMapping({ id: planId, artifact: "plan", record: { header: { level: "light", created: "2026-07-21", title: "Oversized graph", status: "open" }, what: "Bounded output must retain exact orchestration graph accounting.", why: "Task details can exceed startup page capacity.", scope: { included: ["plan"], excluded: [] } } }));
    for (const [index, id] of taskIds.entries()) {
      const status = index < 12 ? "complete" : index < 21 ? "superseded" : "pending";
      const record: Record<string, unknown> = { plan: planId, name: `Task ${index + 1}: ${"x".repeat(3_000)}`, status, depends_on: index === 21 ? [taskIds[12]] : [], acceptance: [] };
      if (status === "superseded") Object.assign(record, { superseded_by: [taskIds[0]], superseded_reason: "A completed replacement covers this task." });
      fs.writeFileSync(path.join(taskDirectory, `${id}.yaml`), dumpYamlMapping({ id, artifact: "plan", record }));
    }

    const state = collectOrientationState({ env: process.env }); const payload = buildPrimeCapabilityContextPayload(state, "orchestrate") as any;
    const context = payload.capability_context.context; const queue = context.orchestration_context.task_queue;
    expect(context.plan).toMatchObject({ complete: 12, superseded: 9, total: 22, task_status_counts: { complete: 12, superseded: 9, pending: 1 }, task_omission: { omitted: true } });
    expect(context.plan.tasks.length).toBeLessThan(22);
    expect(queue).toMatchObject({ total: 22, complete: 12, superseded: 9, status_counts: { complete: 12, superseded: 9, pending: 1 }, dependency_ready_count: 1, blocked_count: 0 });
    expect(context.orchestration_context.selected_next_task.id).toBe(taskIds[21]);
    expect(context.orchestration_context.task_summaries.length).toBe(10);
    expect(context.orchestration_context.task_summaries_omission).toMatchObject({ omitted: true, omitted_count: 12, retrieval: { get: "agentera state plan tasks get --id ID --format json" } });
    const emitted = capture((io) => cmdPrime({ command: "prime", context: "orchestrate", format: "json" }, io));
    expect(emitted.rc).toBe(0); expect(emitted.out).not.toContain("x".repeat(1_000));
  });

  it("reports generic startup-cap task omissions before generic bounding truncates detail", () => {
    const planId = "yyyyyyyyyy"; const taskIds = Array.from({ length: 22 }, (_, index) => `${String.fromCharCode(97 + index)}bbbbbbbbb`);
    fs.rmSync(path.join(tmp, ".agentera/entities/plan"), { recursive: true, force: true });
    const planDirectory = path.join(tmp, ".agentera/entities/plan/plan"); const taskDirectory = path.join(tmp, ".agentera/entities/plan/plan_task"); fs.mkdirSync(planDirectory, { recursive: true }); fs.mkdirSync(taskDirectory, { recursive: true });
    fs.writeFileSync(path.join(planDirectory, `${planId}.yaml`), dumpYamlMapping({ id: planId, artifact: "plan", record: { header: { level: "light", created: "2026-07-21", title: "Small bounded graph", status: "open" }, what: "Startup task detail is explicitly bounded.", why: "Small records can exceed the generic startup item cap.", scope: { included: ["plan"], excluded: [] } } }));
    for (const [index, id] of taskIds.entries()) fs.writeFileSync(path.join(taskDirectory, `${id}.yaml`), dumpYamlMapping({ id, artifact: "plan", record: { plan: planId, name: `Small task ${index + 1}`, status: "pending", depends_on: [], acceptance: [] } }));

    const state = collectOrientationState({ env: process.env }); const statePlan = state.plan as any;
    expect(statePlan).toMatchObject({ total: 22, task_status_counts: { pending: 22 }, task_omission: { omitted: true, total: 22, returned_count: 20, omitted_count: 2, omission_reason: "startup_detail_capacity", retrieval: { get: "agentera state plan tasks get --id ID --format json" } } });
    expect(statePlan.tasks).toHaveLength(20);
    const ordinary = buildOrientationJsonPayload(state, "prime") as any;
    expect(ordinary.plan).toMatchObject({ total: 22, task_count: 22, omitted_task_count: 12, task_omission: { omitted: true, total: 22, returned_count: 10, omitted_count: 12, retrieval: { get: "agentera state plan tasks get --id ID --format json" } } });
    expect(ordinary.plan.tasks).toHaveLength(10);
    const payload = buildPrimeCapabilityContextPayload(state, "orchestrate") as any; const queue = payload.capability_context.context.orchestration_context.task_queue;
    expect(queue).toMatchObject({ total: 22, status_counts: { pending: 22 }, dependency_ready_count: 22, dependency_ready_omission: { omitted: true, omitted_count: 12, retrieval: { get: "agentera state plan tasks get --id ID --format json" } } });
    expect(payload.capability_context.context.plan).toMatchObject({ total: 22, task_omission: { omitted: true, returned_count: 20, omitted_count: 2 } });
  });

  it("restarts task recovery when a byte-bounded page extends past public detail caps", () => {
    const planId = "xxxxxxxxxx";
    const taskId = (index: number): string => { let value = index; return Array.from({ length: 10 }, () => { const char = String.fromCharCode(97 + (value % 26)); value = Math.floor(value / 26); return char; }).join(""); };
    const taskIds = Array.from({ length: 30 }, (_, index) => taskId(index));
    fs.rmSync(path.join(tmp, ".agentera/entities/plan"), { recursive: true, force: true });
    const planDirectory = path.join(tmp, ".agentera/entities/plan/plan"); const taskDirectory = path.join(tmp, ".agentera/entities/plan/plan_task"); fs.mkdirSync(planDirectory, { recursive: true }); fs.mkdirSync(taskDirectory, { recursive: true });
    fs.writeFileSync(path.join(planDirectory, `${planId}.yaml`), dumpYamlMapping({ id: planId, artifact: "plan", record: { header: { level: "light", created: "2026-07-21", title: "Composed bound graph", status: "open" }, what: "Restart recovery cannot skip hidden page entries.", why: "Public detail caps compose with byte-bounded list pages.", scope: { included: ["plan"], excluded: [] } } }));
    for (const [index, id] of taskIds.entries()) fs.writeFileSync(path.join(taskDirectory, `${id}.yaml`), dumpYamlMapping({ id, artifact: "plan", record: { plan: planId, name: `Medium task ${index + 1}: ${"m".repeat(1_100)}`, status: "pending", depends_on: [], acceptance: [] } }));

    const state = collectOrientationState({ env: process.env }); const ordinary = buildOrientationJsonPayload(state, "prime") as any; const recovery = ordinary.plan.task_omission.retrieval;
    expect(ordinary.plan.task_omission).toMatchObject({ omitted: true, total: 30, returned_count: 10, omitted_count: 20, retrieval: { restart: expect.stringContaining(`tasks list ${planId}`), get: "agentera state plan tasks get --id ID --format json" } });
    expect(recovery).not.toHaveProperty("continue");
    const invoke = (command: string): any => { let out = ""; let err = ""; const rc = main(["node", "agentera", ...command.split(" ").slice(1)], { out: (text) => { out += text; }, err: (text) => { err += text; } }); expect(rc, err || out).toBe(0); return JSON.parse(out); };
    const reached = new Set<string>(); let page = invoke(recovery.restart);
    expect(page.omitted).toBe(true); expect(page.entries.length).toBeGreaterThan(20);
    while (true) {
      for (const entry of page.entries) reached.add(entry.id);
      if (!page.omitted) break;
      page = invoke(page.retrieval.continue);
    }
    expect(reached).toEqual(new Set(taskIds));
  });
});
