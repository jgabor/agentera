import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { queryDecisions, queryHealth, queryPlan, queryProgress, queryTodo } from "../../src/cli/commands/state.js";
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


function healthSchema(absPath: string): Record<string, SchemaInfo> {
  return { health: { path: absPath, record: undefined, schema: {}, fields: {} } };
}

function seedHealth(): string {
  const p = path.join(tmp, "health.yaml");
  fs.writeFileSync(
    p,
    [
      "audits:",
      "  - number: 1",
      "    trajectory: improving",
      "    grades:",
      "      coupling_health: B",
      "  - number: 2",
      "    trajectory: stable",
      "    grades:",
      "      coupling_health: A",
      "      test_health: B",
      "",
    ].join("\n"),
  );
  return p;
}

describe("cli state health", () => {
  it("renders the latest audit (highest number) with grades", () => {
    const p = seedHealth();
    const { rc, out } = capture((io) => queryHealth({ command: "health" }, healthSchema(p), io));
    expect(rc).toBe(0);
    expect(out).toContain("Audit 2: stable");
    expect(out).toContain("coupling_health: A");
    expect(out).toContain("test_health: B");
  });

  it("filters by dimension substring", () => {
    const p = seedHealth();
    const { out } = capture((io) => queryHealth({ command: "health", dimension: "coupling" }, healthSchema(p), io));
    expect(out).toContain("coupling_health: A");
    expect(out).not.toContain("test_health");
  });

  it("emits a latest-only structured payload", () => {
    const p = seedHealth();
    const { rc, out } = capture((io) => queryHealth({ command: "health", format: "json" }, healthSchema(p), io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("health");
    expect(payload.summary.latest_only).toBe(true);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].number).toBe(2);
  });
});


function todoSchema(absPath: string): Record<string, SchemaInfo> {
  return { todo: { path: absPath, record: undefined, schema: {}, fields: {} } };
}

describe("cli state todo", () => {
  it("renders YAML todo entries with status counts", () => {
    const p = path.join(tmp, "todo.yaml");
    fs.writeFileSync(
      p,
      [
        "todos:",
        "  - severity: critical",
        "    status: open",
        "    description: Fix the parser at scripts/x.ts.",
        "  - severity: normal",
        "    status: done",
        "    description: Already handled.",
        "",
      ].join("\n"),
    );
    const { rc, out } = capture((io) => queryTodo({ command: "todo" }, todoSchema(p), io));
    expect(rc).toBe(0);
    expect(out).toContain("TODO status: done=1, open=1");
    expect(out).toContain("severity=critical | status=open");
  });

  it("filters YAML todo entries by severity (json)", () => {
    const p = path.join(tmp, "todo.yaml");
    fs.writeFileSync(p, "todos:\n  - severity: critical\n    status: open\n    description: A\n  - severity: info\n    status: open\n    description: B\n");
    const { rc, out } = capture((io) => queryTodo({ command: "todo", severity: "critical", format: "json" }, todoSchema(p), io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.counts.entries).toBe(1);
    expect(payload.entries[0].severity).toBe("critical");
  });

  it("parses a markdown TODO.md fallback", () => {
    const p = path.join(tmp, "TODO.md");
    fs.writeFileSync(p, "## critical\n- [ ] Do the urgent thing\n\n## Resolved\n- [x] Old item\n");
    const { rc, out } = capture((io) => queryTodo({ command: "todo" }, todoSchema(p), io));
    expect(rc).toBe(0);
    expect(out).toContain("[critical] Do the urgent thing");
    expect(out).not.toContain("Old item");
  });
});


function decisionsSchema(absPath: string): Record<string, SchemaInfo> {
  return {
    decisions: {
      path: absPath,
      record: undefined,
      schema: {},
      fields: { number: {}, date: {}, choice: {}, question: { type: "string" } },
    },
  };
}

describe("cli state decisions", () => {
  it("renders display fields as text", () => {
    const p = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(
      p,
      [
        "decisions:",
        "  - number: 1",
        "    date: '2026-05-29'",
        "    question: Should we migrate?",
        "    choice: Yes, to TypeScript.",
        "",
      ].join("\n"),
    );
    const { rc, out } = capture((io) => queryDecisions({ command: "decisions" }, decisionsSchema(p), io));
    expect(rc).toBe(0);
    expect(out).toContain("number=1");
    expect(out).toContain("date=2026-05-29");
  });

  it("emits enriched satisfaction context + source_contract (json)", () => {
    const p = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(
      p,
      [
        "decisions:",
        "  - number: 1",
        "    question: Q",
        "    choice: C",
        "    feeds_into: scripts/x.ts",
        "",
      ].join("\n"),
    );
    const { rc, out } = capture((io) => queryDecisions({ command: "decisions", format: "json" }, decisionsSchema(p), io));
    expect(rc).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.command).toBe("decisions");
    const entry = payload.entries[0];
    expect(entry.outcome).toBe("C");
    expect(entry.satisfaction.review_needed).toBe(true);
    expect(entry.satisfaction.source).toBe("missing_legacy_state");
    expect(entry.downstream_consequence_references[0].reference).toBe("scripts/x.ts");
    expect(payload.source_contract.artifact).toBe("DECISIONS.md");
  });

  it("includes compacted archive entries with caveats", () => {
    const p = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(
      p,
      ["decisions: []", "archive:", "  - 'Decision 5 (2026-01-02): chose X'", ""].join("\n"),
    );
    const { out } = capture((io) => queryDecisions({ command: "decisions", format: "json" }, decisionsSchema(p), io));
    const payload = JSON.parse(out);
    const entry = payload.entries[0];
    expect(entry.compacted).toBe(true);
    expect(entry.number).toBe(5);
    expect(entry.date).toBe("2026-01-02");
  });
});

