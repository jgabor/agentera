import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { cmdPrime, collectOrientationState } from "../../src/cli/commands/prime.js";
import { planSummary } from "../../src/cli/orientation.js";
import { PRIME_BLOB } from "../../src/cli/prime-blob.js";
import type { SchemaInfo } from "../../src/cli/appContext.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

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
  });

  it("renders the default text orientation briefing", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime" }, io));
    expect(rc).toBe(0);
    expect(out.startsWith("agentera prime\n")).toBe(true);
    expect(out).toContain("app_home: install_track=");
    expect(out).toContain("status=");
    expect(out).toContain("mode: ");
    expect(out).toContain("todo: critical=");
    expect(out).toContain("next_action:");
    expect(out).toContain("source_contract:");
    expect(out).toContain("capability_startup_complete=true");
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
    expect(payload.source_contract.capability_context).toBeNull();
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
    expect(payload.issues).toEqual(payload.todo);
    expect(err).toContain("Deprecation: prime JSON field 'issues' is deprecated; use 'todo'");
    expect(err).toContain("3.0.0 stable cut");
    expect(out).not.toContain("Deprecation:");
    expect(payload.app).toBeTruthy();
    expect(payload.app_home.install_track).toBeTruthy();
    expect(typeof payload.app.status).toBe("string");
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
    expect(ctx.orchestration_context.evaluator_handoff).toBeTruthy();
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
    const ready = (taskQueue.dependency_ready_tasks as Array<{ number: number }>).map((t) => t.number);
    const blocked = taskQueue.blocked_tasks as Array<{ number: number; blocked_reasons?: string[] }>;
    const allReasons = blocked.flatMap((t) => t.blocked_reasons ?? []);

    expect(ready).toContain(2);
    expect(blocked.some((t) => t.number === 2)).toBe(false);
    expect(allReasons.some((r) => r.includes("dependency 1 is not present in plan tasks"))).toBe(false);
    expect((orch.task_summaries as Array<{ number: number; status: string }>)[0].status).toBe("complete");
    expect((orch.selected_next_action as Record<string, unknown>)?.object).toBeTruthy();
  });

  it("matches prime --context orchestrate --format json task_queue to task_summaries", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "orchestrate", format: "json" }, io));
    expect(rc).toBe(0);
    const orch = JSON.parse(out).capability_context.context.orchestration_context;
    const ready = orch.task_queue.dependency_ready_tasks.map((t: { number: number }) => t.number);
    const blockedReasons = orch.task_queue.blocked_tasks.flatMap(
      (t: { blocked_reasons?: string[] }) => t.blocked_reasons ?? [],
    );

    expect(ready).toContain(2);
    expect(blockedReasons.some((r: string) => r.includes("dependency 1 is not present in plan tasks"))).toBe(false);
  });
});
