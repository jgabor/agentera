import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkCompaction,
  compactYamlFile,
  compactEntries,
  computeCompactionStatus,
  parseEntries,
  runCompaction,
} from "../../src/hooks/compaction.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("computeCompactionStatus (real repo)", () => {
  it("classifies the repository artifacts and reports check operations", () => {
    const statuses = computeCompactionStatus(REPO_ROOT);
    const byArtifact = Object.fromEntries(statuses.map((s) => [s.artifact, s]));
    expect(byArtifact["DECISIONS.md"].classification).toBe("compactable");
    expect(byArtifact["CHANGELOG.md"].classification).toBe("exempt");
    expect(byArtifact["PLAN.md"].classification).toBe("unsupported");
    expect(byArtifact["VISION.md"].classification).toBe("protected");

    const ops = checkCompaction(REPO_ROOT);
    expect(ops.length).toBe(statuses.length);
    // The repo artifacts are within limits, so no over_limit actions.
    expect(ops.every((o) => o.action !== "over_limit")).toBe(true);
  });
});

describe("compactYamlFile", () => {
  it("keeps the newest 10 cycles and archives the rest", () => {
    const cycles = Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return `- number: ${n}\n  timestamp: '2026-01-${String(n).padStart(2, "0")} 10:00'\n  type: feat\n  what: Did work ${n}\n  phase: build`;
    });
    const p = path.join(tmp, "progress.yaml");
    fs.writeFileSync(p, "cycles:\n" + cycles.join("\n") + "\n");

    const result = compactYamlFile(p, "PROGRESS.md");
    expect(result.changed).toBe(true);
    expect(result.full_before).toBe(12);
    expect(result.full_after).toBe(10);
    expect(result.oneline_after).toBe(2);

    const data = YAML.parse(fs.readFileSync(p, "utf8"));
    expect(data.cycles.length).toBe(10);
    expect(data.archive.length).toBe(2);
    // Newest cycle (12) retained full; oldest (1,2) archived as summaries.
    expect(data.cycles[0].number).toBe(12);
    expect(data.archive[0].summary).toContain("Cycle 2");
  });

  it("no-ops when under the limit", () => {
    const p = path.join(tmp, "progress.yaml");
    fs.writeFileSync(p, "cycles:\n- number: 1\n  what: x\n");
    expect(compactYamlFile(p, "PROGRESS.md").changed).toBe(false);
  });
});

describe("parseEntries todo-resolved + compactEntries", () => {
  it("parses resolved checkbox bullets and detects full vs oneline", () => {
    const todo = "# TODO\n\n## Resolved\n- [x] Fixed the leak\n    detail line\n- [x] ~~Quick fix~~\n";
    const entries = parseEntries(todo, "todo-resolved");
    expect(entries.length).toBe(2);
    expect(entries[0].kind).toBe("full");
    expect(entries[1].kind).toBe("oneline");
  });

  it("compacts markdown entries to 10 full + archived one-liners", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      header: `Cycle ${i + 1} · 2026-01-0${(i % 9) + 1}`,
      body: `**What**: work ${i + 1}`,
      kind: "full",
    }));
    const result = compactEntries(entries, 10, 40, (e) => `- ${e.header}`);
    expect(result.filter((e) => e.kind === "full").length).toBe(10);
    expect(result.filter((e) => e.kind === "oneline").length).toBe(2);
  });
});

describe("runCompaction", () => {
  it("rejects an unknown mode", () => {
    expect(() => runCompaction(REPO_ROOT, "bogus")).toThrow(/unknown compaction mode/);
  });
});
