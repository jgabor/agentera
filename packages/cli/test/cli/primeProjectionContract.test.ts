import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";
import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { buildOrientationJsonPayload, briefOrientationPayload, emitPrime } from "../../src/cli/commands/prime/orientationOutput.js";
import { cmdPrime, collectOrientationState } from "../../src/cli/commands/prime.js";
import { main } from "../../src/cli/dispatch/index.js";
import { dumpYamlMapping } from "../../src/core/yaml.js";
import { canonicalRecordJson } from "../../src/state/archiveDiscovery.js";
import { publishNumberedArchive } from "../../src/state/archivePublication.js";
import { boundStartupValue, startupHistorySummary } from "../../src/state/startupProjection.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLI_DISPATCH_URL = pathToFileURL(path.join(REPO_ROOT, "packages/cli/dist/cli/dispatch.js")).href;
const AUTHORITY_PATH = path.join(REPO_ROOT, "references/artifacts/state-storage-authority.yaml");

type ColdMeasurement = {
  elapsedMs: number;
  heapDeltaBytes: number;
  peakHeapBytes: number;
  baselineHeapBytes: number;
  samples: number;
  stdout: string;
};

function measureColdCli(args: string[]): Promise<ColdMeasurement> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const runner = `const { main } = await import(${JSON.stringify(CLI_DISPATCH_URL)}); debugger; process.exitCode = main(["node", "agentera", ...${JSON.stringify(args)}]);`;
    const child = spawn(process.execPath, ["--inspect-brk=127.0.0.1:0", "--input-type=module", "--eval", runner], {
      cwd: project,
      env: {
        ...process.env,
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
        AGENTERA_HOME: path.join(home, "agentera"),
        HOME: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputAt: number | undefined;
    let socket: WebSocket | undefined;
    let nextId = 1;
    let result: ColdMeasurement | undefined;
    let settled = false;
    const timeout = setTimeout(() => fail(new Error(`cold CLI did not complete serialized output: ${stderr || stdout}`)), 30_000);
    let continueFromFixtureBoundary: (() => void) | undefined;
    const fixtureBoundary = new Promise<void>((boundaryResolve) => {
      continueFromFixtureBoundary = boundaryResolve;
    });
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.close();
      child.kill();
      reject(error);
    };
    const request = (method: string): Promise<any> => new Promise((requestResolve, requestReject) => {
      const id = nextId++;
      pending.set(id, { resolve: requestResolve, reject: requestReject });
      socket?.send(JSON.stringify({ id, method }));
    });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      try {
        JSON.parse(stdout);
        outputAt ??= performance.now();
      } catch {
        // Wait for the complete serialized JSON envelope.
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const endpoint = stderr.match(/Debugger listening on (ws:\/\/\S+)/)?.[1];
      if (!endpoint || socket) return;
      socket = new WebSocket(endpoint);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; method?: string; result?: any; error?: { message: string } };
        if (message.method === "Debugger.paused") {
          continueFromFixtureBoundary?.();
          continueFromFixtureBoundary = undefined;
        }
        if (message.id === undefined) return;
        const handler = pending.get(message.id);
        if (!handler) return;
        pending.delete(message.id);
        if (message.error) handler.reject(new Error(message.error.message));
        else handler.resolve(message.result);
      };
      socket.onerror = () => fail(new Error(`inspector connection failed: ${stderr}`));
      socket.onopen = async () => {
        try {
          await request("Runtime.enable");
          await request("Debugger.enable");
          await request("Runtime.runIfWaitingForDebugger");
          await fixtureBoundary;
          const baseline = await request("Runtime.getHeapUsage") as { usedSize: number };
          let peakHeapBytes = baseline.usedSize;
          let samples = 1;
          await request("Debugger.resume");
          while (outputAt === undefined) {
            await new Promise((sample) => setTimeout(sample, 1));
            const usage = await request("Runtime.getHeapUsage") as { usedSize: number };
            peakHeapBytes = Math.max(peakHeapBytes, usage.usedSize);
            samples += 1;
          }
          const finalUsage = await request("Runtime.getHeapUsage") as { usedSize: number };
          peakHeapBytes = Math.max(peakHeapBytes, finalUsage.usedSize);
          samples += 1;
          result = {
            elapsedMs: outputAt - startedAt,
            heapDeltaBytes: peakHeapBytes - baseline.usedSize,
            peakHeapBytes,
            baselineHeapBytes: baseline.usedSize,
            samples,
            stdout,
          };
          socket?.close();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || !result) {
        fail(new Error(`cold CLI exited ${code}: ${stderr || stdout}`));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    });
  });
}

let tmp: string;
let project: string;
let home: string;
let previousCwd: string;
let previousEnv: Record<string, string | undefined>;

function authority(): Record<string, any> {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8")) as Record<string, any>;
}

function writeArtifact(name: string, content: string): void {
  fs.writeFileSync(path.join(project, ".agentera", name), content);
}

function entityId(index: number): string {
  let value = index;
  const letters = Array.from({ length: 10 }, () => {
    const letter = String.fromCharCode(97 + (value % 26));
    value = Math.floor(value / 26);
    return letter;
  });
  return letters.reverse().join("");
}

type FixtureEntity = { id: string; artifact: string; boundary: string; record: Record<string, any> };

function entityFixture(count: number, contract: Record<string, any>): {
  exactId: string;
  progressCount: number;
  boundaryCounts: Record<string, number>;
  relationshipEdges: string[];
} {
  fs.rmSync(path.join(project, ".agentera"), { recursive: true, force: true });
  fs.mkdirSync(path.join(project, ".agentera"));
  fs.writeFileSync(path.join(project, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  const entities: FixtureEntity[] = [];
  const add = (artifact: string, boundary: string, record: Record<string, any>): string => {
    const id = entityId(entities.length);
    const directory = path.join(project, ".agentera", "entities", artifact, boundary);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.yaml`), dumpYamlMapping({
      id,
      artifact,
      record,
    }));
    entities.push({ id, artifact, boundary, record });
    return id;
  };
  const progress = (index: number): string => add("progress", "progress_cycle", {
    timestamp: `2026-07-${String((index % 28) + 1).padStart(2, "0")} 00:00`,
    type: "test",
    phase: "audit",
    what: `Fixture ${index}`,
    context: { intent: "Measure" },
  });

  let exactId = "";
  for (let group = 0; group < 1; group += 1) {
    const decisionRecord = {
      date: "2026-07-19",
      question: `Decision ${group}?`,
      context: "Budget graph",
      alternatives: [{ name: "E", status: "chosen" }],
      choice: "E",
      reasoning: "R",
      confidence: "firm",
    };
    const decision = add("decisions", "decision", decisionRecord);
    add("decisions", "decision_satisfaction", {
      decision,
      state: "user_confirmed_satisfied",
      user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-19T00:00:00Z" },
    });
    add("decisions", "decision_revision", {
      decision,
      date: "2026-07-19",
      provenance: "historical_revision",
      base_sha256: createHash("sha256").update(canonicalRecordJson(decisionRecord)).digest("hex"),
      changes: { choice: `E${group}` },
    });
    const plan = add("plan", "plan", {
      header: { title: `Plan ${group}`, created: "2026-07-19", status: "complete" },
      what: "W",
      why: "Y",
      scope: { included: ["T"], excluded: [] },
    });
    const dependency = add("plan", "plan_task", { plan, name: "A", status: "complete", depends_on: [], acceptance: ["V"] });
    add("plan", "plan_task", { plan, name: "B", status: "complete", depends_on: [dependency], acceptance: ["V"] });
    const objective = add("objective", "objective", {
      header: { title: `Objective ${group}`, status: "complete", created: "2026-07-19" },
      objective: { description: "D", measurement: "M" },
      metric: {},
      baseline: {},
      scope: {},
    });
    add("experiments", "experiment", {
      objective,
      date: "2026-07-19 00:00",
      label: `Experiment ${group}`,
      hypothesis: "H",
      method: "M",
      change: "C",
      metric: {},
      regression: "R",
      status: "baseline",
      conclusion: "C",
    });
    exactId ||= progress(group);
    add("health", "health_audit", {
      date: "2026-07-19",
      dimensions: ["test_health"],
      findings_summary: { critical: 0, warning: 0, info: 0 },
      trajectory: "S",
      grades: { test_health: "A" },
    });
    add("todo", "todo_item", { severity: "normal", status: "resolved", description: `TODO ${group}` });
    add("docs", "documentation_inventory_entry", { document: `Doc ${group}`, path: `docs/${group}.md`, last_updated: "2026-07-19", status: "current" });
  }
  while (entities.length < count) {
    const id = progress(entities.length);
    exactId ||= id;
  }

  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const relationshipEdges = (contract.entity_target.relationships.declarations as Array<Record<string, string>>)
    .filter((declaration) => entities.some((entity) => {
      if (entity.boundary !== declaration.source) return false;
      const values = Array.isArray(entity.record[declaration.field]) ? entity.record[declaration.field] : [entity.record[declaration.field]];
      return values.some((id) => byId.get(id)?.boundary === declaration.target);
    }))
    .map((declaration) => `${declaration.source}.${declaration.field}->${declaration.target}`);
  const boundaryCounts = Object.fromEntries(
    (contract.entity_target.entities as Array<Record<string, string>>).map(({ boundary }) => [
      boundary,
      entities.filter((entity) => entity.boundary === boundary).length,
    ]),
  );
  return { exactId, progressCount: boundaryCounts.progress_cycle, boundaryCounts, relationshipEdges };
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

describe("prime projection contract", () => {
  it("keeps cold entity-mode startup and retrieval within authority budgets at declared scales", async () => {
    const contract = authority();
    const measurements: Array<Record<string, number | string>> = [];
    const target = contract.entity_target.measurement_contract.targets;
    const repetitions = contract.entity_target.measurement_contract.sampling.repetitions as number;
    const fixtureEvidence: Record<string, unknown> = {};
    for (const [label, count] of [["small", 100], ["large", 1000]] as const) {
      const fixture = entityFixture(count, contract);
      const declaredBoundaries = (contract.entity_target.entities as Array<Record<string, string>>).map(({ boundary }) => boundary);
      const declaredRelationships = (contract.entity_target.relationships.declarations as Array<Record<string, string>>)
        .map(({ source, field, target }) => `${source}.${field}->${target}`);
      expect(Object.keys(fixture.boundaryCounts)).toEqual(declaredBoundaries);
      expect(Object.values(fixture.boundaryCounts).every((boundaryCount) => boundaryCount > 0)).toBe(true);
      expect(Object.values(fixture.boundaryCounts).reduce((sum, boundaryCount) => sum + boundaryCount, 0)).toBe(count);
      expect(fixture.relationshipEdges).toEqual(declaredRelationships);
      const validated = capture((out, err) => main(["node", "agentera", "check", "validate", "state", "--format", "json"], { out, err }));
      expect(validated.rc, validated.out || validated.err).toBe(0);
      fixtureEvidence[label] = { entities: count, boundaryCounts: fixture.boundaryCounts, relationshipEdges: fixture.relationshipEdges };
      const startupTarget = target[`startup_${label}`];
      const listTarget = target[`bounded_list_${label}`];
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const [operation, args, limits] of [
          ["startup", ["prime", "--dashboard", "--format", "json"], startupTarget],
          ["bounded_list", ["state", "progress", "list", "--limit", "100", "--format", "json"], listTarget],
        ] as const) {
          const measured = await measureColdCli([...args]);
          const bytes = Buffer.byteLength(measured.stdout, "utf8");
          expect(measured.elapsedMs, `${operation} ${label} repetition ${repetition}`).toBeLessThanOrEqual(limits.max_latency_ms);
          expect(measured.heapDeltaBytes, `${operation} ${label} repetition ${repetition}`).toBeLessThanOrEqual(limits.max_heap_delta_bytes);
          expect(bytes, `${operation} ${label} repetition ${repetition}`).toBeLessThanOrEqual(
            operation === "startup"
              ? contract.budgets.startup.surfaces.prime_dashboard.max_utf8_bytes
              : limits.max_utf8_bytes,
          );
          if (operation === "startup" && label === "small" && repetition === 1) {
            const payload = JSON.parse(measured.stdout) as Record<string, any>;
            const latest = payload.progress.latest;
            const fullEntry = payload.history.progress.entries[0];
            expect(latest).toEqual({
              id: fullEntry.id,
              artifact: "progress",
              what: fullEntry.record.what,
            });
            expect(fullEntry.retrieval.get).toBe(`agentera state progress get --id ${latest.id} --format json`);
            expect(payload.history.progress).toMatchObject({ omitted: true, omission_reason: "page_limit" });
            expect(payload.history.progress.next_cursor).toBeTruthy();
          }
          if (operation === "bounded_list") expect(JSON.parse(measured.stdout).counts.total).toBe(fixture.progressCount);
          measurements.push({ operation, scale: label, entities: count, repetition, ...measured, bytes, stdout: "recorded separately" });
        }
      }
      if (label === "large") {
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          const measured = await measureColdCli(["state", "progress", "get", "--id", fixture.exactId, "--format", "json"]);
          const bytes = Buffer.byteLength(measured.stdout, "utf8");
          expect(measured.elapsedMs, `exact_get repetition ${repetition}`).toBeLessThanOrEqual(target.exact_get.max_latency_ms);
          expect(measured.heapDeltaBytes, `exact_get repetition ${repetition}`).toBeLessThanOrEqual(target.exact_get.max_heap_delta_bytes);
          expect(bytes, `exact_get repetition ${repetition}`).toBeLessThanOrEqual(target.exact_get.max_utf8_bytes);
          expect(JSON.parse(measured.stdout).entry.id).toBe(fixture.exactId);
          measurements.push({ operation: "exact_get", scale: label, entities: count, repetition, ...measured, bytes, stdout: "recorded separately" });
        }
      }
    }
    const maxima = Object.fromEntries(
      ["exact_get", "bounded_list_small", "bounded_list_large", "startup_small", "startup_large"].map((targetName) => {
        const samples = measurements.filter((measurement) =>
          targetName === "exact_get"
            ? measurement.operation === "exact_get"
            : `${measurement.operation}_${measurement.scale}` === targetName,
        );
        return [targetName, {
          repetitions: samples.length,
          maxElapsedMs: Math.max(...samples.map((sample) => Number(sample.elapsedMs))),
          maxHeapDeltaBytes: Math.max(...samples.map((sample) => Number(sample.heapDeltaBytes))),
          maxBytes: Math.max(...samples.map((sample) => Number(sample.bytes))),
          minInspectorSamples: Math.min(...samples.map((sample) => Number(sample.samples))),
        }];
      }),
    );
    console.info("entity authority fixture", fixtureEvidence);
    console.info("entity authority maxima", maxima);
  }, 120_000);

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
    const unicode = "😀漢字".repeat(1_000);
    const directory = path.join(project, ".agentera/entities/progress/progress_cycle");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    fs.writeFileSync(path.join(directory, "aaaaaaaaaa.yaml"), dumpYamlMapping({
      id: "aaaaaaaaaa",
      artifact: "progress",
      record: { timestamp: "2026-07-19 00:00", type: "test", phase: "audit", what: unicode, context: { intent: "Unicode safety" } },
    }));

    const state = collectOrientationState({ home, env: process.env });
    const payload = buildOrientationJsonPayload(state, "prime");
    const bounded = boundStartupValue(unicode, "what");
    expect(Array.from(bounded as string)).toHaveLength(200);
    expect((bounded as string).endsWith("…")).toBe(true);
    expect(hasUnpairedSurrogate(JSON.stringify(payload))).toBe(false);
    expect(payload.progress).toMatchObject({
      exists: true,
      latest: { id: "aaaaaaaaaa", artifact: "progress" },
    });
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
