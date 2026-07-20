import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDigest,
  extractSessionSummary,
} from "../../src/hooks/sessionStart.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";

const SESSION_WITH_ENTRY =
  "# Session History\n\n## Session 2026-04-03T10:00\n\nWorked on hooks infrastructure.\nCompleted session_start.py.\nTests passing.\n\n## Session 2026-04-02T14:00\n\nPrevious session.\n";

describe("session_start extractors", () => {
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
    const entities = [
      ["progress", "progress_cycle", "aaaaaaaaaa", { timestamp: "2026-07-17 12:00", type: "test", phase: "build", what: "Built session startup", context: { intent: "test" } }],
      ["health", "health_audit", "bbbbbbbbbb", { date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } }],
      ["todo", "todo_item", "cccccccccc", { description: "Fix startup", severity: "critical", status: "open" }],
    ] as const;
    fs.mkdirSync(path.join(tmp, ".agentera"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (const [artifact, boundary, id, record] of entities) {
      const directory = path.join(tmp, ".agentera/entities", artifact, boundary);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({ id, artifact, record }));
    }

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
