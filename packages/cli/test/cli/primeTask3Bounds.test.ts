import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { buildOrientationJsonPayload, briefOrientationPayload, emitPrime } from "../../src/cli/commands/prime/orientationOutput.js";
import { cmdPrime, collectOrientationState } from "../../src/cli/commands/prime.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import { boundStartupValue, startupHistorySummary } from "../../src/state/startupProjection.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");
const BUDGET_MANIFEST_PATH = path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml");

let tmp: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

function authority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
}

function capabilityBudgets(): Record<string, { byte_budget: number; token_budget: number }> {
  const manifest = YAML.parse(fs.readFileSync(BUDGET_MANIFEST_PATH, "utf8")) as Record<string, any>;
  const surface = (manifest.surfaces as Array<Record<string, any>>).find(
    (entry) => entry.id === "prime-capability-context",
  );
  return surface?.budget_by_capability as Record<string, { byte_budget: number; token_budget: number }>;
}

function writeArtifact(name: string, content: string): void {
  fs.writeFileSync(path.join(project, ".agentera", name), content);
}

function currentRows(collection: string, count: number, unicode: string): string {
  const lines = [`${collection}:`];
  for (let number = 1; number <= count; number += 1) {
    lines.push(`  - number: ${number}`);
    lines.push(`    status: ${number % 2 === 0 ? "complete" : "open"}`);
    lines.push(`    timestamp: 2026-07-${String((number % 28) + 1).padStart(2, "0")} 00:00`);
    lines.push(`    what: ${unicode}`);
  }
  return `${lines.join("\n")}\n`;
}

function largeFixture(count = 1000, archiveCount = 100): void {
  const unicode = "😀漢字".repeat(4_000);
  writeArtifact("progress.yaml", currentRows("cycles", count, unicode));
  writeArtifact("decisions.yaml", currentRows("decisions", count, unicode));
  writeArtifact("health.yaml", `${currentRows("audits", count, unicode)}\n`);
  writeArtifact("plan.yaml", [
    "header:",
    "  title: Bounded fixture",
    "  status: open",
    "tasks:",
    "  - number: 1",
    "    name: Verify bounded startup",
    "    status: pending",
    "    depends_on: []",
    "    acceptance: [bounded output]",
    "",
  ].join("\n"));
  writeArtifact("docs.yaml", "mapping: []\nindex: []\n");
  writeArtifact("TODO.md", "# TODO\n\n## normal\n");
  for (const artifact of ["progress", "decisions", "health"]) {
    const directory = path.join(project, ".agentera", "archive", artifact);
    fs.mkdirSync(directory, { recursive: true });
    for (let number = 1; number <= archiveCount; number += 1) {
      fs.writeFileSync(path.join(directory, `${number}.yaml`), "broken: true\n");
    }
  }
}

function capture(fn: (out: (text: string) => void, err: (text: string) => void) => number): { rc: number; out: string; err: string } {
  let out = "";
  let err = "";
  return { rc: fn((text) => (out += text), (text) => (err += text)), out, err };
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasUnpairedSurrogateInValue(value: unknown): boolean {
  if (typeof value === "string") return hasUnpairedSurrogate(value);
  if (Array.isArray(value)) return value.some((item) => hasUnpairedSurrogateInValue(item));
  if (value && typeof value === "object") return Object.values(value).some((item) => hasUnpairedSurrogateInValue(item));
  return false;
}

function boundaryAlignedFixtureText(): { taskName: string; blockedReason: string; todoText: string } {
  return {
    taskName: `${"a".repeat(93)}😀${"b".repeat(160)}😀tail`,
    blockedReason: `${"r".repeat(158)}😀${"s".repeat(18)}😀tail`,
    todoText: `${"t".repeat(158)}😀${"u".repeat(18)}😀tail`,
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-task3-"));
  project = path.join(tmp, "project");
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(project, ".agentera"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  previousCwd = process.cwd();
  previousEnv = {
    AGENTERA_BOOTSTRAP_SOURCE_ROOT: process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT,
    AGENTERA_HOME: process.env.AGENTERA_HOME,
    HOME: process.env.HOME,
  };
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.AGENTERA_HOME = path.join(home, "agentera");
  process.env.HOME = home;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prime Task3 bounded source projections", () => {
  it("keeps large current projections and archive directories within authority budgets", () => {
    largeFixture();
    const limits = authority().budgets.startup;
    const sourceLimits = limits.source_work.large;
    const budgets = capabilityBudgets();
    expect(Object.keys(budgets).sort()).toEqual([...CAPABILITY_NAMES].sort());
    expect(
      Object.values(budgets).every(
        (budget) => budget.byte_budget <= limits.source_work.serialized_output.prime_capability_context_max_utf8_bytes,
      ),
    ).toBe(true);
    const start = performance.now();
    const beforeHeap = process.memoryUsage().heapUsed;
    const state = collectOrientationState({ home, env: process.env });
    const elapsed = performance.now() - start;
    const heapDelta = Math.max(0, process.memoryUsage().heapUsed - beforeHeap);

    expect(elapsed).toBeLessThanOrEqual(sourceLimits.max_latency_ms);
    expect(heapDelta).toBeLessThanOrEqual(sourceLimits.max_heap_delta_bytes);
    for (const history of Object.values(state.history)) {
      const scan = (history.source as Record<string, any>).input_scan as Record<string, number>;
      expect(scan.current_entries).toBeLessThanOrEqual(sourceLimits.max_current_entries);
      expect(scan.archive_files).toBeLessThanOrEqual(sourceLimits.max_archive_files);
      const counts = history.counts as Record<string, number>;
      expect(counts.physical).toBe(1_100);
      expect(counts.omitted).toBeGreaterThan(0);
    }

    const orientation = buildOrientationJsonPayload(state, "prime");
    // The bare default emits a bounded decision brief (prime-briefing, 12000
    // bytes); the full payload stays on --dashboard (prime-dashboard). The brief
    // must fit even with accumulated plans/history/lifecycle findings.
    const brief = capture((out, err) =>
      emitPrime("prime", orientation, "json", undefined, out, err, { bareBrief: true }),
    );
    expect(brief.rc).toBe(0);
    expect(Buffer.byteLength(brief.out, "utf8")).toBeLessThanOrEqual(limits.surfaces.prime_briefing.max_utf8_bytes);
    expect((JSON.parse(brief.out).brief as Record<string, unknown>).status).toBe("ok");
    // The full dashboard payload stays within its own larger budget.
    expect(jsonBytes(orientation)).toBeLessThanOrEqual(limits.surfaces.prime_dashboard.max_utf8_bytes);
    const sparse = capture((out, err) =>
      emitPrime("prime", orientation, "json", "plan,progress,docs", out, err),
    );
    expect(sparse.rc).toBe(0);
    expect(Buffer.byteLength(sparse.out, "utf8")).toBeLessThanOrEqual(limits.surfaces.prime_sparse.max_utf8_bytes);

     for (const capability of CAPABILITY_NAMES) {
       const payload = buildPrimeCapabilityContextPayload(state, capability);
       const selected = capture((out, err) => emitPrime("prime", payload, "json", "capability_context", out, err));
       expect(selected.rc, capability).toBe(0);
       const capabilityBytes = Buffer.byteLength(selected.out, "utf8");
       expect(capabilityBytes, capability).toBeLessThanOrEqual(budgets[capability]?.byte_budget ?? 0);
     }
  }, 30_000);

  it("reports omitted, unaddressable, ambiguous, and corrupt history with valid routes", () => {
    writeArtifact("decisions.yaml", [
      "decisions:",
      "  - summary: D7 explicit shorthand",
      "  - summary: D7+D8 compound shorthand",
      "  - summary: legacy decision without an identity",
      "    what: not emitted in startup detail",
      "",
    ].join("\n"));
    const archiveDirectory = path.join(project, ".agentera", "archive", "decisions");
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(path.join(archiveDirectory, "1.yaml"), "broken: true\n");

    const history = startupHistorySummary(project, "decisions", REPO_ROOT);
    expect(history.status).toBe("degraded");
    expect(history.counts).toMatchObject({
      physical: 4,
      addressable: 2,
      addressable_ids: 2,
      unaddressable: 1,
      ambiguous: 1,
    });
    expect(history.counts.omitted).toBeGreaterThan(0);
    expect(history.retrieval).toEqual({
      list: "agentera state decisions list --limit 20 --format json",
      get: "agentera state decisions get --number N --format json",
    });
    expect(JSON.stringify(history)).not.toContain("not emitted in startup detail");
  });

  it("uses canonical row classifications for bounded per-entry history", () => {
    writeArtifact("progress.yaml", [
      "cycles:",
      "  - number: 9",
      "    timestamp: 2026-07-09 00:00",
      "    type: feat",
      "    phase: build",
      "    what: first projection",
      "  - number: 9",
      "    timestamp: 2026-07-09 00:00",
      "    type: feat",
      "    phase: build",
      "    what: conflicting projection",
      "",
    ].join("\n"));
    const conflict = startupHistorySummary(project, "progress", REPO_ROOT);
    expect(conflict.counts.conflict).toBe(1);
    expect((conflict.entries as Array<Record<string, any>>).every((entry) => entry.classification === "conflict")).toBe(true);
    expect((conflict.entries as Array<Record<string, any>>)[0].provenance).toMatchObject({
      source: "current_projection",
      origin: "active",
    });

    writeArtifact("progress.yaml", [
      "cycles:",
      "  - number: 8",
      "    timestamp: 2026-07-08 00:00",
      "    type: feat",
      "    phase: build",
      "    what: mirrored projection",
      "",
    ].join("\n"));
    publishNumberedArchive(project, "progress", 8, {
      number: 8,
      timestamp: "2026-07-08 00:00",
      type: "feat",
      phase: "build",
      what: "mirrored projection",
      context: { intent: "Task3 fixture" },
    });
    const mirrored = startupHistorySummary(project, "progress", REPO_ROOT);
    expect(mirrored.counts.mirrored).toBe(1);
    expect((mirrored.entries as Array<Record<string, any>>).map((entry) => entry.provenance.origin)).toEqual([
      "active",
      "numbered_archive",
    ]);
    expect((mirrored.entries as Array<Record<string, any>>)[0].detail_availability).toBe("summary");
    expect((mirrored.entries as Array<Record<string, any>>)[1].detail_availability).toBe("full");
    expect((mirrored.entries as Array<Record<string, any>>).every((entry) => entry.classification === "mirrored")).toBe(true);
  });

  it("preserves Unicode-safe identity, status, and continuation metadata", () => {
    const unicode = "😀漢字".repeat(10_000);
    writeArtifact("progress.yaml", [
      "cycles:",
      "  - number: 42",
      "    status: open",
      `    what: ${unicode}`,
      "",
    ].join("\n"));
    writeArtifact("decisions.yaml", "decisions: []\n");
    writeArtifact("health.yaml", "audits: []\n");
    writeArtifact("plan.yaml", "header:\n  title: Unicode\n  status: open\ntasks: []\n");
    writeArtifact("docs.yaml", "mapping: []\nindex: []\n");

    const state = collectOrientationState({ home, env: process.env });
    const payload = buildOrientationJsonPayload(state, "prime");
    const bounded = boundStartupValue(unicode, "what");
    expect(Array.from(bounded as string)).toHaveLength(200);
    expect((bounded as string).endsWith("…")).toBe(true);
    expect(hasUnpairedSurrogate(JSON.stringify(payload))).toBe(false);
    expect(payload.progress).toMatchObject({
      exists: true,
      latest: { number: 42, status: "open" },
    });
    expect((payload.history as any).progress.retrieval.get).toBe("agentera state progress get --number N --format json");
    // The bare default brief (not the full payload) must fit the briefing
    // budget; the full payload stays on --dashboard.
    const brief = briefOrientationPayload(payload);
    expect(jsonBytes(brief)).toBeLessThanOrEqual(authority().budgets.startup.surfaces.prime_briefing.max_utf8_bytes);
    expect(hasUnpairedSurrogate(JSON.stringify(brief))).toBe(false);
    expect(JSON.stringify(payload)).not.toContain(unicode);
    const sparse = capture((out, err) => emitPrime("prime", payload, "json", "plan,progress,docs", out, err));
    expect(hasUnpairedSurrogate(sparse.out)).toBe(false);
    for (const capability of CAPABILITY_NAMES) {
      const selected = capture((out, err) => emitPrime(
        "prime",
        buildPrimeCapabilityContextPayload(state, capability),
        "json",
        "capability_context",
        out,
        err,
      ));
      expect(hasUnpairedSurrogate(selected.out), capability).toBe(false);
    }
  });

  it("keeps boundary-aligned emoji intact on every prime output surface", () => {
    const { taskName, blockedReason, todoText } = boundaryAlignedFixtureText();
    writeArtifact("plan.yaml", [
      "header:",
      "  title: Boundary fixture",
      "  status: open",
      "tasks:",
      "  - number: 1",
      `    name: ${taskName}`,
      "    status: pending",
      "    depends_on: []",
      `    blocked_reasons: [\"${blockedReason}\"]`,
      "",
    ].join("\n"));
    writeArtifact("TODO.md", `# TODO\n\n## normal\n- [ ] ${todoText}\n`);
    writeArtifact("progress.yaml", "cycles: []\n");
    writeArtifact("decisions.yaml", "decisions: []\n");
    writeArtifact("health.yaml", "audits: []\n");
    writeArtifact("docs.yaml", "mapping: []\nindex: []\n");

    const outputs: Array<[string, string]> = [];
    for (const [label, args] of [
      ["default text", { command: "prime" }],
      ["default json", { command: "prime", format: "json" }],
      ["dashboard", { command: "prime", dashboard: true, format: "json" }],
      ["sparse", { command: "prime", format: "json", fields: "plan,progress,docs" }],
    ] as const) {
      const result = capture((out, err) => cmdPrime(args, { out, err }));
      expect(result.rc, label).toBe(0);
      outputs.push([label, result.out]);
    }
    for (const capability of CAPABILITY_NAMES) {
      const result = capture((out, err) => cmdPrime({ command: "prime", context: capability, format: "json" }, { out, err }));
      expect(result.rc, `${capability}: ${result.err}`).toBe(0);
      outputs.push([`context ${capability}`, result.out]);
    }

    for (const [label, output] of outputs) {
      expect(hasUnpairedSurrogate(output), label).toBe(false);
      if (label !== "default text") {
        const parsed = JSON.parse(output);
        expect(hasUnpairedSurrogateInValue(parsed), label).toBe(false);
        expect(hasUnpairedSurrogate(JSON.stringify(parsed)), label).toBe(false);
      }
    }
    expect(outputs.find(([label]) => label === "dashboard")?.[1]).not.toContain(blockedReason);
    expect(outputs.find(([label]) => label === "context audit")?.[1]).not.toContain(todoText);
    expect(outputs.find(([label]) => label === "context document")?.[1]).not.toContain(todoText);
  });
});
