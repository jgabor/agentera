import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDigest,
  extractCriticalTodos,
  extractHealthGrades,
  extractLatestProgress,
  extractNextPlanTask,
  extractSessionSummary,
} from "../../src/hooks/sessionStart.js";

const PROGRESS_MULTI =
  "# Progress\n\n■ ## Cycle 80 · 2026-04-03\n\n**What**: Built the session start hook infrastructure.\n**Commits**: abc123\n**Inspiration**: None\n**Discovered**: Clean addition.\n**Next**: Task 2.\n\n■ ## Cycle 79 · 2026-04-02\n\n**What**: Previous work.\n";
const PROGRESS_EMPTY = "# Progress\n\nNo cycles yet.\n";
const PROGRESS_YAML = "cycles:\n  - number: 80\n    phase: build\n    what: Built the session start hook infrastructure.\n    verified: uv run pytest\n    next: Task 2.\n";
const HEALTH_WITH_GRADES = "# Health\n\n## Audit 6\n\n**Grades**: Architecture [A] | Patterns [A] | Tests [B]\n";
const HEALTH_YAML = "audits:\n  - number: 6\n    grades:\n      architecture: A\n      patterns: A\n      tests: B\n";
const PLAN_WITH_PENDING =
  "# Plan\n\n## Tasks\n\n### Task 1: Write the generation script\n**Status**: ■ complete\n\n### Task 2: Add frontmatter\n**Status**: pending\n\n### Task 3: Migrate files\n**Status**: not started\n";
const PLAN_ALL_COMPLETE = "# Plan\n\n## Tasks\n\n### Task 1: Write the script\n**Status**: ■ complete\n\n### Task 2: Add tests\n**Status**: ■ complete\n";
const TODO_WITH_CRITICAL =
  "# TODO\n\n## ⇶ Critical\n- [ ] ISS-99: [fix] Database connection leak\n- [ ] ISS-100: [fix] Auth bypass vulnerability\n\n## ⇉ Degraded\n- [ ] ISS-31: [test] Missing CI gating\n";
const SESSION_WITH_ENTRY =
  "# Session History\n\n## Session 2026-04-03T10:00\n\nWorked on hooks infrastructure.\nCompleted session_start.py.\nTests passing.\n\n## Session 2026-04-02T14:00\n\nPrevious session.\n";

describe("session_start extractors", () => {
  it("extracts the latest progress cycle", () => {
    expect(extractLatestProgress(PROGRESS_MULTI)).toContain("Built the session start hook");
    expect(extractLatestProgress(PROGRESS_EMPTY)).toBeNull();
  });

  it("extracts the health grades line", () => {
    const grades = extractHealthGrades(HEALTH_WITH_GRADES);
    expect(grades).toContain("[A]");
    expect(grades).toContain("[B]");
    expect(extractHealthGrades("# Health\n\nNo audits yet.\n")).toBeNull();
  });

  it("finds the first pending plan task", () => {
    expect(extractNextPlanTask(PLAN_WITH_PENDING)).toContain("Task 2");
    expect(extractNextPlanTask(PLAN_ALL_COMPLETE)).toBeNull();
  });

  it("extracts critical TODO items", () => {
    const items = extractCriticalTodos(TODO_WITH_CRITICAL);
    expect(items.length).toBe(2);
    expect(items[0]).toContain("ISS-99");
    expect(extractCriticalTodos("# TODO\n\n## ⇶ Critical\n\n## ⇉ Degraded\n- [ ] ISS-31\n")).toEqual([]);
  });

  it("extracts the latest session summary", () => {
    expect(extractSessionSummary(SESSION_WITH_ENTRY)).toContain("hooks infrastructure");
    expect(extractSessionSummary("# Session History\n\nNo sessions recorded.\n")).toBeNull();
  });
});

describe("buildDigest", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-start-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("builds a digest from operational artifacts", () => {
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera", "progress.yaml"), PROGRESS_YAML);
    fs.writeFileSync(path.join(tmp, ".agentera", "health.yaml"), HEALTH_YAML);
    fs.writeFileSync(path.join(tmp, "TODO.md"), TODO_WITH_CRITICAL);

    const digest = buildDigest(tmp, { AGENTERA_HOME: path.join(tmp, "no-sessions") });
    expect(digest).not.toBeNull();
    expect(digest).toContain("# Session context");
    expect(digest).toContain("Latest progress");
    expect(digest).toContain("Health");
    expect(digest).toContain("Critical issues");
  });

  it("returns null for a fresh project with no artifacts", () => {
    expect(buildDigest(tmp, { AGENTERA_HOME: path.join(tmp, "no-sessions") })).toBeNull();
  });
});
