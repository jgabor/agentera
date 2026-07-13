import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkCompaction,
  compactYamlFile,
  compactEntries,
  computeCompactionStatus,
  fixCompaction,
  parseEntries,
  runCompaction,
} from "../../src/hooks/compaction/index.js";
import { MAX_FULL_ENTRIES, MAX_TOTAL_ENTRIES } from "../../src/hooks/common.js";
import { cleanupFixtureProject, useFixtureProject } from "../helpers/useFixtureProject.js";
import { InjectedMutationFailure } from "../../src/state/write/mutation.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";

let tmp: string;
const fixtureRoots: string[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compaction-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  while (fixtureRoots.length) cleanupFixtureProject(fixtureRoots.pop()!);
});

function progressCycleEntry(n: number): Record<string, unknown> {
  return {
    number: n,
    timestamp: `2026-01-${String((n % 28) + 1).padStart(2, "0")} 10:00`,
    type: "feat",
    phase: "build",
    what: `Work cycle ${n}`,
    context: { intent: "test" },
  };
}

function writeProgressYaml(dir: string, cycleCount: number, archiveCount = 0): string {
  const p = path.join(dir, ".agentera", "progress.yaml");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cycles = Array.from({ length: cycleCount }, (_, i) => progressCycleEntry(i + 1));
  const archive = Array.from({ length: archiveCount }, (_, i) => ({
    summary: `Cycle ${i + 1} (2026-01-01): archived ${i + 1}`,
  }));
  fs.writeFileSync(p, YAML.stringify({ cycles, archive }));
  for (const cycle of cycles) publishNumberedArchive(dir, "progress", cycle.number, cycle);
  return p;
}

describe("checkCompaction (repo-state fixtures)", () => {
  it("flags 46 full Resolved entries as 16 over the full-entry limit", () => {
    const root = useFixtureProject("todo-resolved-over-limit");
    fixtureRoots.push(root);
    const op = checkCompaction(root).find((o) => o.status.artifact === "todo#Resolved");
    expect(op?.action).toBe("over_limit");
    expect(op?.status.over_limit_count).toBe(16);
  });

  it("reports ok for all compactable artifacts within uniform_10_40_50", () => {
    const root = useFixtureProject("ok");
    fixtureRoots.push(root);
    const present = checkCompaction(root).filter(
      (o) => o.status.classification === "compactable" && o.status.exists,
    );
    expect(present.length).toBeGreaterThan(0);
    expect(present.every((o) => o.action === "ok")).toBe(true);
    expect(present.every((o) => (o.status.over_limit_count ?? 0) === 0)).toBe(true);
  });

  it("keeps progress-at-cap within limits at 50 total entries", () => {
    const root = useFixtureProject("progress-at-cap");
    fixtureRoots.push(root);
    const progressOp = checkCompaction(root).find((o) => o.status.artifact === "progress");
    expect(progressOp?.status.total_count).toBe(50);
    expect(progressOp?.action).toBe("ok");
    expect(progressOp?.status.over_limit_count).toBe(0);
  });
});

describe("progress.yaml over-limit gate", () => {
  it("fails the compaction gate when cycle count exceeds 50", () => {
    writeProgressYaml(tmp, 55);
    const progressOp = checkCompaction(tmp).find((o) => o.status.artifact === "progress");
    expect(progressOp?.action).toBe("over_limit");
    expect(progressOp?.status.total_count).toBe(55);
    expect(progressOp?.status.over_limit_count).toBeGreaterThan(0);
    expect(runCompaction(tmp, "check").some((o) => o.action === "over_limit")).toBe(true);
  });

  it("compacts over-limit progress.yaml under the cap with archive preservation", () => {
    writeProgressYaml(tmp, 55);
    const ops = fixCompaction(tmp);
    const progressOp = ops.find((o) => o.status.artifact === "progress");
    expect(progressOp?.action).toBe("compacted");
    expect(progressOp?.changed).toBe(true);

    const data = YAML.parse(fs.readFileSync(path.join(tmp, ".agentera", "progress.yaml"), "utf8")) as {
      cycles: { number: number }[];
      archive: { summary: string }[];
    };
    expect(data.cycles.length).toBe(10);
    expect(data.archive.length).toBe(40);
    expect(data.cycles.length + data.archive.length).toBeLessThanOrEqual(MAX_TOTAL_ENTRIES);
    expect(data.cycles[0].number).toBe(55);
    expect(data.archive.some((e) => e.summary.includes("Cycle 1"))).toBe(true);
    expect(checkCompaction(tmp).find((o) => o.status.artifact === "progress")?.action).toBe("ok");
  });

  it.each(["staged-write", "projection-publication", "directory-sync"] as const)(
    "retries explicit projection repair after %s",
    (boundary) => {
      writeProgressYaml(tmp, 55);
      expect(() => fixCompaction(tmp, { failAfter: boundary })).toThrow(InjectedMutationFailure);
      expect(fs.readdirSync(path.join(tmp, ".agentera")).filter((name) => name.includes(".writer."))).toEqual([]);

      fixCompaction(tmp);
      const progressOp = checkCompaction(tmp).find((o) => o.status.artifact === "progress");
      expect(progressOp?.status.over_limit_count).toBe(0);
    },
  );
});

describe("compactYamlFile", () => {
  it("keeps the newest cycles up to cap and archives the rest", () => {
    const cycles = Array.from({ length: 25 }, (_, i) => {
      const n = i + 1;
      return {
        number: n,
        timestamp: `2026-01-${String(n).padStart(2, "0")} 10:00`,
        type: "feat",
        phase: "build",
        what: `Did work ${n}`,
        context: { intent: `Test cycle ${n}` },
      };
    });
    const p = path.join(tmp, "progress.yaml");
    fs.writeFileSync(p, YAML.stringify({ cycles }));
    for (let n = 1; n <= 25; n++) {
      publishNumberedArchive(tmp, "progress", n, {
        number: n,
        timestamp: `2026-01-${String(n).padStart(2, "0")} 10:00`,
        type: "feat",
        phase: "build",
        what: `Did work ${n}`,
        context: { intent: `Test cycle ${n}` },
      });
    }

    const result = compactYamlFile(p, "progress");
    expect(result.changed).toBe(true);
    expect(result.full_before).toBe(25);
    expect(result.full_after).toBe(MAX_FULL_ENTRIES);
    expect(result.oneline_after).toBe(25 - MAX_FULL_ENTRIES);

    const data = YAML.parse(fs.readFileSync(p, "utf8"));
    expect(data.cycles.length).toBe(MAX_FULL_ENTRIES);
    expect(data.archive.length).toBe(25 - MAX_FULL_ENTRIES);
    // Newest cycle (25) retained full; oldest archived as summaries (archive is descending).
    expect(data.cycles[0].number).toBe(25);
    expect(data.archive[0].summary).toContain("Cycle 15");
    expect(data.archive[data.archive.length - 1].summary).toContain("Cycle 1");
  });

  it("no-ops when under the limit", () => {
    const p = path.join(tmp, "progress.yaml");
    fs.writeFileSync(p, "cycles:\n- number: 1\n  what: x\n");
    expect(compactYamlFile(p, "progress").changed).toBe(false);
  });
});

describe("compactYamlFile decisions archive ordering", () => {
  function decisionEntry(n: number): Record<string, unknown> {
    return {
      number: n,
      date: `2026-01-${String((n % 28) + 1).padStart(2, "0")}`,
      question: `Should we do thing ${n}?`,
      context: `The project needs decision ${n}.`,
      choice: `Yes, do thing ${n}`,
      alternatives: [
        { name: `Yes, do thing ${n}`, status: "chosen" },
        { name: `No to thing ${n}`, status: "rejected" },
      ],
      reasoning: `The evidence supports thing ${n}.`,
      confidence: "firm",
      satisfaction: {
        state: "user_confirmed_satisfied",
        user_confirmation: { confirmed_by: "test", confirmed_at: "2026-01-01" },
      },
    };
  }

  it("writes the decisions archive in ascending order after compaction", () => {
    const decisions = Array.from({ length: 25 }, (_, i) => decisionEntry(i + 1));
    const p = path.join(tmp, "decisions.yaml");
    fs.writeFileSync(p, YAML.stringify({ decisions, archive: [] }));
    for (const entry of decisions) {
      publishNumberedArchive(tmp, "decisions", Number(entry.number), entry);
    }

    const result = compactYamlFile(p, "decisions");
    expect(result.changed).toBe(true);
    expect(result.full_after).toBe(MAX_FULL_ENTRIES);
    expect(result.oneline_after).toBe(25 - MAX_FULL_ENTRIES);

    const data = YAML.parse(fs.readFileSync(p, "utf8")) as {
      decisions: { number: number }[];
      archive: { number?: number; summary: string }[];
    };
    // Active entries ascending (newest kept).
    expect(data.decisions[0].number).toBe(16);
    expect(data.decisions[MAX_FULL_ENTRIES - 1].number).toBe(25);
    // Archive entries ascending (1-15) — the prior bug produced descending order.
    const archiveNumbers = data.archive.map((e) => e.number ?? 0);
    const sorted = [...archiveNumbers].sort((a, b) => a - b);
    expect(archiveNumbers).toEqual(sorted);
    expect(archiveNumbers[0]).toBe(1);
    expect(archiveNumbers[archiveNumbers.length - 1]).toBe(15);
  });
});

describe("parseEntries todo-resolved + compactEntries", () => {
  it("parses resolved checkbox bullets and detects full vs oneline", () => {
    const todo = "# TODO\n\n## Resolved\n- [x] Fixed the leak\n    detail line\n- [x] Quick fix\n";
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
    expect(() => runCompaction(tmp, "bogus")).toThrow(/unknown compaction mode/);
  });
});

describe("computeCompactionStatus YAML errors", () => {
  it("classifies invalid YAML without a Python-style yaml.YAMLError prefix", () => {
    const p = path.join(tmp, ".agentera", "progress.yaml");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "cycles: bad: yaml: here\n");
    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "progress");
    expect(status?.classification).toBe("error");
    expect(status?.reason).toBeTruthy();
    expect(status?.reason).not.toContain("yaml.YAMLError:");
    const op = checkCompaction(tmp).find((o) => o.status.artifact === "progress");
    expect(op?.action).toBe("error");
  });

  it("classifies a non-mapping YAML root like the Python oracle", () => {
    const p = path.join(tmp, ".agentera", "decisions.yaml");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "- item\n");
    const status = computeCompactionStatus(tmp).find((s) => s.artifact === "decisions");
    expect(status?.classification).toBe("error");
    expect(status?.reason).toBe("YAML root must be a mapping");
  });
});
