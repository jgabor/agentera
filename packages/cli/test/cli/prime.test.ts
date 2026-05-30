import { describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { PRIME_BLOB } from "../../src/cli/prime-blob.js";

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
    expect(out).toContain("app_home: status=");
    expect(out).toContain("mode: ");
    expect(out).toContain("issues: critical=");
    expect(out).toContain("next_action:");
    expect(out).toContain("source_contract:");
    expect(out).toContain("capability_startup_complete=true");
  });

  it("rejects mutually-exclusive prime modes", () => {
    expect(capture((io) => cmdPrime({ context: "planera", dashboard: true }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ context: "planera", guidance: true }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ dashboard: true, guidance: true }, io)).rc).toBe(2);
  });

  it("emits a default JSON orientation payload (bespoke contexts null)", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime");
    expect(payload.status).toBe("ok");
    expect(payload.orchestration_context).toBeNull();
    expect(payload.closeout_context).toBeNull();
    expect(payload.execution_context).toBeNull();
    expect(payload.source_contract.capability_context).toBeNull();
    expect(payload.source_contract.fields).toContain("next_action");
    expect(payload.bundle).toBeTruthy();
  });

  it("requires json for --dashboard and --context", () => {
    expect(capture((io) => cmdPrime({ dashboard: true, format: "text" }, io)).rc).toBe(2);
    expect(capture((io) => cmdPrime({ context: "planera", format: "text" }, io)).rc).toBe(2);
  });

  it("supports --fields selection on the JSON payload", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", format: "json", fields: "plan" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(Object.keys(payload).sort()).toEqual(["command", "plan", "status"]);
  });

  it("rejects an unsupported --fields value for prime", () => {
    const { rc, err } = capture((io) => cmdPrime({ command: "prime", format: "json", fields: "bogusfield" }, io));
    expect(rc).toBe(1);
    expect(err).toContain("unsupported field 'bogusfield'");
  });

  it("emits a capability context for a non-bespoke capability (planera)", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "planera", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("prime");
    expect(payload.capability_context.schemaVersion).toBe("agentera.capabilityContext.v1");
    expect(payload.capability_context.capability).toBe("planera");
    expect(payload.capability_context.context.planning_context).toBeTruthy();
    expect(payload.capability_context.context.planning_context.startup_contract.schemaVersion).toBe(
      "agentera.planeraStartup.v1",
    );
  });

  it("emits the orchestration bespoke context for orkestrera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "orkestrera", format: "json" }, io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.capability_context.capability).toBe("orkestrera");
    const ctx = payload.capability_context.context;
    expect(ctx.orchestration_context).toBeTruthy();
    expect(ctx.orchestration_context.capability).toBe("orkestrera");
    expect(ctx.orchestration_context.task_queue).toBeTruthy();
    expect(ctx.orchestration_context.evaluator_handoff).toBeTruthy();
  });

  it("emits the execution bespoke context for realisera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "realisera", format: "json" }, io));
    expect(rc).toBe(0);
    const ctx = JSON.parse(out).capability_context.context;
    expect(ctx.execution_context).toBeTruthy();
    expect(ctx.execution_context.capability).toBe("realisera");
    expect(ctx.execution_context.work_selection).toBeTruthy();
    expect(ctx.execution_context.changelog_boundary).toBeTruthy();
  });

  it("emits the evidence bespoke context for inspektera", () => {
    const { rc, out } = capture((io) => cmdPrime({ command: "prime", context: "inspektera", format: "json" }, io));
    expect(rc).toBe(0);
    const ctx = JSON.parse(out).capability_context.context;
    expect(ctx.evidence_context).toBeTruthy();
    expect(ctx.evidence_context.capability).toBe("inspektera");
    expect(ctx.evidence_context.version_checks).toBeTruthy();
    expect(ctx.evidence_context.decision_review_pressure).toBeTruthy();
    expect(ctx.evidence_context.residual_risks).toBeTruthy();
  });

  it("still gates the remaining bespoke capabilities", () => {
    for (const cap of ["dokumentera", "optimera"]) {
      const { rc } = capture((io) => cmdPrime({ context: cap, format: "json" }, io));
      expect(rc).toBe(1);
    }
  });

  it("rejects an unknown --context capability", () => {
    const { rc, err } = capture((io) => cmdPrime({ context: "bogus", format: "json" }, io));
    expect(rc).toBe(2);
    expect(err).toContain("unsupported capability 'bogus'");
  });
});
