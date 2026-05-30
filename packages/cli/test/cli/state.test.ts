import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryPlan, queryProgress } from "../../src/cli/commands/state.js";
import { main } from "../../src/cli/dispatch.js";
import type { SchemaInfo } from "../../src/cli/appContext.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-state-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
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

/** Schema whose artifact path is absolute, so resolution is cwd-independent. */
function progressSchema(absPath: string): Record<string, SchemaInfo> {
  return {
    progress: {
      path: absPath,
      record: undefined,
      schema: {},
      fields: { what: { type: "string" }, type: { type: "string" } },
    },
  };
}

function seedProgress(): string {
  const p = path.join(tmp, "progress.yaml");
  fs.writeFileSync(
    p,
    [
      "progress:",
      "  - number: 2",
      "    timestamp: '2026-05-29 18:00'",
      "    type: fix",
      "    phase: build",
      "    what: Did the second thing at scripts/x.ts line 4.",
      "  - number: 1",
      "    timestamp: '2026-05-29 17:00'",
      "    type: feat",
      "    phase: build",
      "    what: Did the first thing.",
      "",
    ].join("\n"),
  );
  return p;
}

describe("cli state progress", () => {
  it("renders recent cycles as text (newest first)", () => {
    const p = seedProgress();
    const { rc, out } = capture((io) => queryProgress({ command: "progress" }, progressSchema(p), io));
    expect(rc).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toContain("number=2");
    expect(out.indexOf("number=2")).toBeLessThan(out.indexOf("number=1"));
    expect(out).toContain("  what: Did the second thing");
  });

  it("limits the number of entries", () => {
    const p = seedProgress();
    const { out } = capture((io) => queryProgress({ command: "progress", limit: 1 }, progressSchema(p), io));
    expect(out).toContain("number=2");
    expect(out).not.toContain("number=1");
  });

  it("emits a structured JSON payload", () => {
    const p = seedProgress();
    const { rc, out } = capture((io) => queryProgress({ command: "progress", format: "json" }, progressSchema(p), io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("progress");
    expect(payload.status).toBe("ok");
    expect(payload.counts.entries).toBe(2);
    expect(payload.entries[0].number).toBe(2);
  });

  it("supports --fields selection with sparse context", () => {
    const p = seedProgress();
    const { rc, out } = capture((io) =>
      queryProgress({ command: "progress", format: "json", fields: "entries" }, progressSchema(p), io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(Object.keys(payload).sort()).toEqual(["command", "entries", "status"]);
  });

  it("rejects an unsupported --fields value", () => {
    const p = seedProgress();
    const { rc, err } = capture((io) =>
      queryProgress({ command: "progress", format: "json", fields: "bogus" }, progressSchema(p), io),
    );
    expect(rc).toBe(1);
    expect(err).toContain("unsupported field 'bogus'");
  });
});

describe("cli dispatch: state routing", () => {
  it("errors when state subcommand is missing", () => {
    const { rc, err } = capture((io) => main(["node", "agentera", "state"], io));
    expect(rc).toBe(2);
    expect(err).toContain("state_command");
  });

  it("emits a deprecation alias for top-level progress", () => {
    const { err } = capture((io) => main(["node", "agentera", "progress"], io));
    expect(err).toContain("Deprecation: agentera progress is deprecated; use agentera state progress");
  });
});


function planSchema(absPath: string): Record<string, SchemaInfo> {
  return {
    plan: { path: absPath, record: undefined, schema: {}, fields: { title: { type: "string" } } },
  };
}

function seedPlan(): string {
  const p = path.join(tmp, "plan.yaml");
  fs.writeFileSync(
    p,
    [
      "header:",
      "  title: Migrate CLI to TypeScript",
      "  status: active",
      "  created: '2026-05-29'",
      "what: Port the dispatcher.",
      "tasks:",
      "  - number: 1",
      "    status: done",
      "    name: Foundation",
      "  - number: 2",
      "    status: pending",
      "    name: State commands",
      "",
    ].join("\n"),
  );
  return p;
}

describe("cli state plan", () => {
  it("renders the plan header, task status counts, and tasks as text", () => {
    const p = seedPlan();
    const { rc, out } = capture((io) => queryPlan({ command: "plan" }, planSchema(p), io));
    expect(rc).toBe(0);
    expect(out).toContain("Plan: status=active");
    expect(out).toContain("Task status: done=1, pending=1");
    expect(out).toContain("Task: number=1 | status=done | name=Foundation");
  });

  it("filters tasks by status", () => {
    const p = seedPlan();
    const { out } = capture((io) => queryPlan({ command: "plan", status: "done" }, planSchema(p), io));
    expect(out).toContain("name=Foundation");
    expect(out).not.toContain("State commands");
  });

  it("emits a structured payload with summary and source_contract", () => {
    const p = seedPlan();
    const { rc, out } = capture((io) => queryPlan({ command: "plan", format: "json" }, planSchema(p), io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("plan");
    expect(payload.summary.title).toBe("Migrate CLI to TypeScript");
    expect(payload.source_contract.complete_for_plan_artifact).toBe(true);
    expect(payload.counts.entries).toBe(2);
  });

  it("reports an absence payload when no plan artifact exists", () => {
    const { rc, out } = capture((io) =>
      queryPlan({ command: "plan", format: "json" }, planSchema(path.join(tmp, "missing.yaml")), io),
    );
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe("empty");
    expect(payload.summary.absence_reason).toContain("No plan artifact");
    expect(payload.source_contract.complete_for_plan_artifact).toBe(false);
  });
});

