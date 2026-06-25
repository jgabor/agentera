import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkProfileStaleness,
  healthSummary,
  issueCounts,
  loadTodoItems,
  parseProfileHeaderDates,
  planSummary,
  progressSummary,
  selectStatusNextAction,
  statePresence,
} from "../../src/cli/orientation.js";
import type { SchemaInfo } from "../../src/cli/appContext.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ori-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function schema(name: string, absPath: string): Record<string, SchemaInfo> {
  return { [name]: { path: absPath, record: undefined, schema: {}, fields: {} } };
}

describe("orientation: pure helpers", () => {
  it("counts issues by severity bucket", () => {
    const items = [
      { severity: "critical", status: "open", text: "a" },
      { severity: "warning", status: "open", text: "b" },
      { severity: "info", status: "open", text: "c" },
      { severity: "normal", status: "open", text: "d" },
    ];
    expect(issueCounts(items)).toEqual({ critical: 1, degraded: 1, normal: 1, annoying: 1 });
  });

  it("selects the first pending plan task as next action", () => {
    const plan = { first_pending: { number: 3, name: "Wire prime" } };
    const action = selectStatusNextAction(plan, {}, {}, [], null, true);
    expect(action).toEqual({
      object: "PLAN Task 3: Wire prime",
      capability: "orchestrate",
      reason: "first pending plan task",
    });
  });

  it("routes a complex TODO to plan and a simple one to build", () => {
    const complex = [{ severity: "normal", status: "open", text: "update the schema contract and validation surface" }];
    expect(selectStatusNextAction({}, {}, {}, complex, null, true).capability).toBe("plan");
    const simple = [{ severity: "normal", status: "open", text: "rename a thing" }];
    expect(selectStatusNextAction({}, {}, {}, simple, null, true).capability).toBe("build");
  });

  it("summarizes state presence", () => {
    const presence = statePresence(
      { active: true, exists: true },
      { exists: true },
      { exists: false, absence_reason: "none" },
      { exists: false },
      { active: false, exists: false },
    );
    expect(presence.active).toEqual({ plan: true, objective: false });
    expect(presence.any_active).toBe(true);
    expect(presence.absence).toEqual({ progress: "none" });
  });
});

describe("orientation: artifact summaries", () => {
  it("summarizes a plan with task completion + first pending", () => {
    const p = path.join(tmp, "plan.yaml");
    fs.writeFileSync(
      p,
      ["header:", "  title: T", "  status: active", "tasks:", "  - number: 1", "    status: done",
       "  - number: 2", "    status: pending", ""].join("\n"),
    );
    const summary = planSummary(schema("plan", p));
    expect(summary.exists).toBe(true);
    expect(summary.complete).toBe(1);
    expect(summary.total).toBe(2);
    expect(summary.first_pending.number).toBe(2);
  });

  it("returns an absence summary when the plan artifact is missing", () => {
    const summary = planSummary(schema("plan", path.join(tmp, "missing.yaml")));
    expect(summary.exists).toBe(false);
    expect(summary.absence_reason).toContain("No active plan artifact");
  });

  it("summarizes the latest progress cycle", () => {
    const p = path.join(tmp, "progress.yaml");
    fs.writeFileSync(
      p,
      ["progress:", "  - number: 1", "    verified: tests pass", "  - number: 2", "    verified: more tests", ""].join("\n"),
    );
    const summary = progressSummary(schema("progress", p));
    expect(summary.exists).toBe(true);
    expect(summary.cycle_count).toBe(2);
    expect(summary.latest.number).toBe(2);
  });

  it("summarizes the worst health grade and degrading flag", () => {
    const p = path.join(tmp, "health.yaml");
    fs.writeFileSync(
      p,
      ["audits:", "  - number: 1", "    trajectory: improving", "    grades:", "      coupling: A",
       "  - number: 2", "    trajectory: degrading", "    grades:", "      coupling: A", "      tests: D", ""].join("\n"),
    );
    const summary = healthSummary(schema("health", p));
    expect(summary.exists).toBe(true);
    expect(summary.number).toBe(2);
    expect(summary.worst[0]).toBe("tests");
    expect(summary.degrading).toBe(true);
  });

  it("loads markdown TODO items with section severities", () => {
    const p = path.join(tmp, "TODO.md");
    fs.writeFileSync(p, "## critical\n- [ ] Fix it\n\n## Resolved\n- [x] Old\n");
    const items = loadTodoItems(schema("todo", p));
    expect(items).toEqual([{ severity: "critical", status: "open", text: "Fix it" }]);
  });

  it("excludes resolved GitHub checkbox items from open todo load", () => {
    const p = path.join(tmp, "TODO.md");
    fs.writeFileSync(
      p,
      ["## ⇶ Critical", "- [x] [fix] Already done", "- [ ] [fix] Still open", ""].join("\n"),
    );
    const items = loadTodoItems(schema("todo", p));
    expect(items).toEqual([{ severity: "critical", status: "open", text: "[fix] Still open" }]);
    expect(issueCounts(items).critical).toBe(1);
  });

  it("reports zero critical issues when only resolved checkboxes remain", () => {
    const p = path.join(tmp, "TODO.md");
    fs.writeFileSync(p, "## ⇶ Critical\n- [x] [fix] Done only\n");
    const items = loadTodoItems(schema("todo", p));
    expect(items).toEqual([]);
    expect(issueCounts(items).critical).toBe(0);
  });
});

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function writeProfile(tmpDir: string, header: string): string {
  const profilePath = path.join(tmpDir, "PROFILE.md");
  fs.writeFileSync(profilePath, `# Decision Profile\n\n${header}\n`);
  return profilePath;
}

describe("checkProfileStaleness", () => {
  it("marks profiles stale from Generated when Validated is absent", () => {
    const profilePath = writeProfile(tmp, `<!-- Generated: ${isoDaysAgo(10)} | Data: x -->`);
    const result = checkProfileStaleness(profilePath, { AGENTERA_PROFILE_MAX_AGE_DAYS: "7" });
    expect(result).toEqual([true, 10, 7]);
  });

  it("treats recent Validated as fresh even when Generated is old", () => {
    const profilePath = writeProfile(
      tmp,
      `<!-- Generated: ${isoDaysAgo(10)} | Data: x | Validated: ${isoDaysAgo(1)} -->`,
    );
    const result = checkProfileStaleness(profilePath, { AGENTERA_PROFILE_MAX_AGE_DAYS: "7" });
    expect(result).toEqual([false, 1, 7]);
  });

  it("parses Generated and Validated header dates", () => {
    const text = "<!-- Generated: 2026-05-30 | Data: x | Validated: 2026-06-07 -->";
    expect(parseProfileHeaderDates(text)).toEqual({
      generatedDate: "2026-05-30",
      validatedDate: "2026-06-07",
      generatedUtc: Date.UTC(2026, 4, 30),
      validatedUtc: Date.UTC(2026, 5, 7),
    });
  });
});
