/**
 * Plan Task 3 acceptance criteria: bounded default decision brief.
 *
 * AC1: GIVEN returning, fresh, empty, missing, and degraded project fixtures
 *      WHEN bare prime runs THEN it reports mode, work summary, attention, next
 *      action, and startup completeness needed for routing.
 * AC2: Covered by primeProjectionContract.test.ts (large fixture ≤12000 bytes, stderr
 *      separation).
 * AC3: GIVEN state is missing versus present-but-empty WHEN an agent reads the
 *      brief THEN the two conditions remain behaviorally distinguishable.
 * AC4: GIVEN omitted rich state WHEN an agent follows the named recovery command
 *      THEN the current authoritative detail is available without raw artifact
 *      access.
 * AC5: GIVEN one passing and one over-budget fixture WHEN focused tests run THEN
 *      the byte gate accepts the former and rejects the latter.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { collectOrientationState } from "../../src/cli/commands/prime/collectOrientationState.js";
import {
  BriefBudgetError,
  briefByteGate,
  briefOrientationPayload,
  briefUtf8Bytes,
  PRIME_BRIEF_MAX_UTF8_BYTES,
} from "../../src/cli/commands/prime/briefOrientation.js";
import { buildOrientationJsonPayload, emitPrime } from "../../src/cli/commands/prime/orientationOutput.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let tmp: string;
let home: string;
let appHome: string;
let project: string;
let prevCwd: string;
let prevHome: string | undefined;
let prevAgenteraHome: string | undefined;
let prevBootstrapSourceRoot: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prime-task3-ac-"));
  home = path.join(tmp, "home");
  appHome = path.join(home, "agentera");
  fs.mkdirSync(appHome, { recursive: true });
  project = path.join(tmp, "project");
  fs.mkdirSync(project, { recursive: true });
  prevCwd = process.cwd();
  prevHome = process.env.HOME;
  prevAgenteraHome = process.env.AGENTERA_HOME;
  prevBootstrapSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = appHome;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
  else process.env.AGENTERA_HOME = prevAgenteraHome;
  if (prevBootstrapSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = prevBootstrapSourceRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capturePrime(): { rc: number; out: string; err: string; payload: Record<string, unknown> } {
  let out = "";
  let err = "";
  const rc = cmdPrime(
    { command: "prime", format: "json", home, installRoot: appHome },
    { out: (t: string) => (out += t), err: (t: string) => (err += t) },
  );
  expect(rc, "bare prime --format json must exit 0").toBe(0);
  return { rc, out, err, payload: JSON.parse(out) };
}

function capturePrimeDashboard(): { rc: number; out: string; err: string; payload: Record<string, unknown> } {
  let out = "";
  let err = "";
  const rc = cmdPrime(
    { command: "prime", format: "json", dashboard: true, home, installRoot: appHome },
    { out: (t: string) => (out += t), err: (t: string) => (err += t) },
  );
  expect(rc, "prime --dashboard --format json must exit 0").toBe(0);
  return { rc, out, err, payload: JSON.parse(out) };
}

function writeArtifact(name: string, content: string): void {
  const dir = path.join(project, ".agentera");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function returningFixture(): void {
  writeArtifact("plan.yaml", [
    "header:",
    "  title: Returning Task",
    "  status: in_progress",
    "tasks:",
    "  - number: 1",
    "    name: Ship feature",
    "    status: pending",
    "    depends_on: []",
    "    acceptance: [tests pass]",
    "",
  ].join("\n"));
  writeArtifact("progress.yaml", [
    "cycles:",
    "  - number: 1",
    "    status: complete",
    "    what: Initial setup",
    "    next: Ship feature",
    "    verification: tests pass",
    "",
  ].join("\n"));
  writeArtifact("decisions.yaml", "decisions:\n  - summary: Use SQLite\n    what: picked embedded store\n");
  writeArtifact("health.yaml", "audits:\n  - number: 1\n    status: complete\n    what: Initial audit\n");
  writeArtifact("docs.yaml", "mapping: []\nindex: []\n");
  writeArtifact("TODO.md", "# TODO\n\n## normal\n");
}

function emptyFixture(): void {
  writeArtifact("plan.yaml", "header:\n  title: null\n  status: open\ntasks: []\n");
  writeArtifact("progress.yaml", "cycles: []\n");
  writeArtifact("decisions.yaml", "decisions: []\n");
  writeArtifact("health.yaml", "audits: []\n");
  writeArtifact("docs.yaml", "mapping: []\nindex: []\n");
  writeArtifact("TODO.md", "# TODO\n");
}

/** A project with many progress cycles since the last health audit, an
 *  in-progress plan with pending tasks, and no decisions. Exercises the
 *  stale-health and incomplete-plan routing paths that generate attention
 *  entries in the brief. */
function degradedProjectFixture(): void {
  // Many progress cycles (triggers audit-staleness attention)
  const lines = ["cycles:"];
  for (let n = 1; n <= 200; n += 1) {
    lines.push(`  - number: ${n}`);
    lines.push(`    status: complete`);
    lines.push(`    what: cycle ${n}`);
    lines.push(`    next: next cycle`);
    lines.push(`    verification: pass`);
  }
  writeArtifact("progress.yaml", `${lines.join("\n")}\n`);
  // One stale health audit (many cycles since)
  writeArtifact("health.yaml", "audits:\n  - number: 1\n    status: complete\n    what: Old audit\n");
  // In-progress plan with pending tasks
  writeArtifact("plan.yaml", [
    "header:",
    "  title: Stale project",
    "  status: in_progress",
    "tasks:",
    "  - number: 1",
    "    name: Fix staleness",
    "    status: pending",
    "    depends_on: []",
    "    acceptance: [audit passes]",
    "",
  ].join("\n"));
  writeArtifact("docs.yaml", "mapping: []\nindex: []\n");
  writeArtifact("TODO.md", "# TODO\n\n## normal\n");
}

describe("Task 3 AC1: bare prime reports routing signals across project states", () => {
  function assertRoutingSignals(payload: Record<string, unknown>, label: string): void {
    // Mode
    expect(typeof payload.mode, `${label}: mode is a string`).toBe("string");
    // Work summary: plan or progress or todo
    expect(payload, `${label}: plan is present`).toHaveProperty("plan");
    expect(payload, `${label}: progress is present`).toHaveProperty("progress");
    expect(payload, `${label}: todo is present`).toHaveProperty("todo");
    // Attention
    expect(Array.isArray(payload.attention), `${label}: attention is an array`).toBe(true);
    // Next action
    const na = payload.next_action as Record<string, unknown> | undefined;
    expect(na, `${label}: next_action is present`).toBeDefined();
    expect(typeof na?.object, `${label}: next_action.object is a string`).toBe("string");
    expect(typeof na?.capability, `${label}: next_action.capability is a string`).toBe("string");
    // Startup completeness
    const cs = getPath(payload, "source_contract.capability_startup") as Record<string, unknown> | undefined;
    expect(cs, `${label}: capability_startup is present`).toBeDefined();
    expect(typeof cs?.complete_for_capability_startup, `${label}: complete_for_capability_startup is boolean`).toBe("boolean");
    // Brief meta
    const brief = payload.brief as Record<string, unknown> | undefined;
    expect(brief, `${label}: brief meta is present`).toBeDefined();
    expect(typeof brief?.status, `${label}: brief.status is a string`).toBe("string");
  }

  it("returning project: mode=returning, brief.status=ok, all routing signals present", () => {
    returningFixture();
    const { payload } = capturePrime();
    expect(payload.mode, "returning fixture has mode=returning").toBe("returning");
    expect((payload.brief as Record<string, unknown>).status).toBe("ok");
    assertRoutingSignals(payload, "returning");
  });

  it("fresh project (no .agentera): mode=fresh, brief.status=ok, all routing signals present", () => {
    // No .agentera directory created — fresh state
    const { payload } = capturePrime();
    expect(payload.mode, "fresh fixture has mode=fresh").toBe("fresh");
    expect((payload.brief as Record<string, unknown>).status).toBe("ok");
    assertRoutingSignals(payload, "fresh");
  });

  it("empty project (present-but-empty artifacts): mode=fresh, brief.status=ok, routing signals present", () => {
    emptyFixture();
    const { payload } = capturePrime();
    expect((payload.brief as Record<string, unknown>).status).toBe("ok");
    assertRoutingSignals(payload, "empty");
  });

  it("missing project (no plan/progress/decisions artifacts): routing signals present without error", () => {
    // .agentera directory exists but has no state artifacts (only TODO.md)
    const dir = path.join(project, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TODO.md"), "# TODO\n");
    const { payload } = capturePrime();
    expect((payload.brief as Record<string, unknown>).status).toBe("ok");
    assertRoutingSignals(payload, "missing");
  });

  it("degraded project (stale health, incomplete plan): routing signals present", () => {
    degradedProjectFixture();
    const { payload } = capturePrime();
    expect((payload.brief as Record<string, unknown>).status).toBe("ok");
    assertRoutingSignals(payload, "degraded");
    // A degraded project generates attention entries (audit staleness)
    const attention = payload.attention as unknown[];
    expect(attention.length, "degraded project has ≥1 attention entry").toBeGreaterThan(0);
  });
});

describe("Task 3 AC4: omitted rich state has named recovery without raw artifact access", () => {
  it("every omitted_rich_state entry has a named recovery command (not a raw artifact read)", () => {
    returningFixture();
    const { payload } = capturePrime();
    const brief = payload.brief as Record<string, unknown>;
    expect(brief.status, "ok brief for returning fixture").toBe("ok");

    const omitted = brief.omitted_rich_state as Array<Record<string, unknown>>;
    expect(Array.isArray(omitted), "omitted_rich_state is an array").toBe(true);
    expect(omitted.length, "omitted_rich_state has ≥1 entry").toBeGreaterThan(0);

    for (const entry of omitted) {
      expect(typeof entry.field, "entry.field is a string").toBe("string");
      expect(typeof entry.reason, "entry.reason is a string").toBe("string");
      const recovery = entry.recovery as string;
      expect(typeof recovery, "entry.recovery is a string").toBe("string");
      // Recovery must be a named agentera command, not a raw file path read
      expect(recovery.startsWith("agentera "), "recovery starts with 'agentera '").toBe(true);
      expect(recovery, "recovery is NOT a raw artifact read (no .agentera/ path)").not.toMatch(/\.agentera\//);
      expect(recovery, "recovery is NOT a raw file read (no cat/head/tail)").not.toMatch(/\b(cat|head|tail|vi|nano)\b/);
    }
  });

  it("brief mode flag distinguishes brief from full dashboard (--dashboard has no brief meta)", () => {
    returningFixture();
    // Bare default → brief projected
    const bareResult = capturePrime();
    expect(bareResult.payload, "bare default has brief meta").toHaveProperty("brief");
    // Dashboard → full fidelity, no brief
    let out = "";
    let err = "";
    cmdPrime(
      { command: "prime", format: "json", dashboard: true, home, installRoot: appHome },
      { out: (t: string) => (out += t), err: (t: string) => (err += t) },
    );
    const dashboard = JSON.parse(out);
    expect(dashboard, "--dashboard has NO brief meta").not.toHaveProperty("brief");
    // Dashboard keeps full artifact_writes.artifacts (projected out in brief)
    const sc = dashboard.source_contract as Record<string, unknown>;
    const aw = sc.artifact_writes as Record<string, unknown>;
    expect(aw.artifacts, "--dashboard keeps full artifact_writes.artifacts").toBeDefined();
  });

  it("--dashboard preserves every input field and value, including inactive defaults", () => {
    returningFixture();
    const input = buildOrientationJsonPayload(
      collectOrientationState({ home, installRoot: appHome }),
      "prime",
    );
    const result = capturePrimeDashboard();
    const dashboard = result.payload;
    const inputFields = Object.keys(input).sort();
    const outputFields = Object.keys(dashboard).sort();

    expect(outputFields, "dashboard preserves the complete top-level field set").toEqual(inputFields);
    for (const field of inputFields) {
      expect(dashboard[field], `dashboard preserves ${field}`).toEqual(input[field]);
    }
    expect(dashboard.v1_migration).toEqual(input.v1_migration);
    expect(dashboard.docs).toEqual(input.docs);
    expect(dashboard.objective).toEqual(input.objective);
  });
});

describe("Task 3 AC5: byte gate accepts passing and rejects over-budget fixtures", () => {
  it("briefByteGate accepts a small payload (bytes ≤ budget)", () => {
    const small = { hello: "world" };
    const result = briefByteGate(small, PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(result.accepted, "small payload is accepted").toBe(true);
    expect(result.bytes, "small payload bytes > 0").toBeGreaterThan(0);
  });

  it("briefByteGate rejects a large payload (bytes > budget)", () => {
    // Build a payload that exceeds 12000 bytes
    const large: Record<string, unknown> = {};
    for (let i = 0; i < 500; i += 1) {
      large[`field_${i}`] = "x".repeat(50);
    }
    const result = briefByteGate(large, PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(result.bytes, "large payload exceeds budget").toBeGreaterThan(PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(result.accepted, "over-budget payload is rejected").toBe(false);
  });

  it("briefOrientationPayload returns status=ok for a projected payload within budget", () => {
    returningFixture();
    const { payload } = capturePrime();
    const brief = payload.brief as Record<string, unknown>;
    expect(brief.status, "returning fixture brief is ok").toBe("ok");
    const bytes = briefUtf8Bytes(payload);
    expect(bytes, "ok brief is within budget").toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);
  });

  it("briefOrientationPayload returns status=degraded when projected brief exceeds budget", () => {
    // Use a real returning-fixture payload with a reduced budget so the
    // projected brief (~9475 bytes) exceeds it, forcing the degraded envelope.
    // The budget sits between the degraded envelope size (~5165 bytes) and the
    // full projected brief, so the envelope fits within the production budget.
    returningFixture();
    const { payload } = capturePrime();
    const rawPayload = { ...payload } as Record<string, unknown>;
    delete rawPayload.brief;
    const degraded = briefOrientationPayload(rawPayload, { budgetBytes: 7000 });
    const brief = degraded.brief as Record<string, unknown>;
    expect(brief.status, "reduced budget forces degraded").toBe("degraded");
    expect(brief.attempted_utf8_bytes, "attempted bytes recorded").toBeGreaterThan(7000);
    // The degraded envelope must satisfy the configured 7000-byte gate, not
    // merely the production 12000-byte authority.
    const bytes = briefUtf8Bytes(degraded);
    expect(bytes, "degraded envelope is within the configured budget").toBeLessThanOrEqual(7000);
    expect(brief.utf8_bytes, "degraded utf8_bytes matches exact output bytes").toBe(bytes);
    // The degraded envelope keeps routing-essential fields
    expect(degraded, "degraded keeps command").toHaveProperty("command");
    expect(degraded, "degraded keeps status").toHaveProperty("status");
    expect(degraded, "degraded keeps mode").toHaveProperty("mode");
    expect(degraded, "degraded keeps state_presence").toHaveProperty("state_presence");
    expect(degraded, "degraded keeps source_contract").toHaveProperty("source_contract");
    expect(degraded, "degraded keeps plan").toHaveProperty("plan");
    expect(degraded, "degraded keeps next_action").toHaveProperty("next_action");
    expect(degraded, "degraded keeps history").toHaveProperty("history");
  });

  it("trims optional 21-task detail before selected routing and canonical history evidence", () => {
    const selectedTask = {
      id: "vvvvvvvvvv",
      artifact: "plan",
      name: "Run the dependency-ready host task",
      status: "pending",
      depends_on: ["uuuuuuuuuu"],
      dependency_count: 1,
      omitted_dependency_count: 0,
      acceptance: [
        "Preserve selected task identity and dependency evidence.",
        "Retain one exact recovery command in every successful envelope.",
      ],
      acceptance_count: 2,
      omitted_acceptance_count: 0,
      retrieval: { get: "agentera state plan tasks get --id vvvvvvvvvv --format json" },
    };
    const historyEntry = (artifact: string) => ({
      artifact,
      status: "degraded",
      compatibility: "mixed",
      detail_availability: "omitted",
      counts: { total: 13, returned: 0, remaining: 13, full: 1, summary: 12 },
      caveats: [
        `${artifact} compacted history is incomplete and requires exact review.`,
        ...(artifact === "decisions" ? [{
          class: "review_needed",
          confidence: "firm",
          satisfaction_state: "provisionally_satisfied",
          review_needed: true,
          message: "Use explicit state; never infer satisfaction.",
        }] : []),
      ],
      degraded_history: {
        summary_count: 12,
        returned_count: 0,
        omitted_count: 12,
        retrieval: {
          list: `agentera state ${artifact} list --limit 20 --format json`,
          get: `agentera state ${artifact} get --id ID --format json`,
        },
      },
      retrieval: {
        list: `agentera state ${artifact} list --limit 20 --format json`,
        get: `agentera state ${artifact} get --id ID --format json`,
      },
      source_contract: {
        authority: "references/artifacts/state-storage-authority.yaml",
        detail: "mixed",
        cursor: "opaque_snapshot_cursor",
      },
    });
    const rawPayload: Record<string, unknown> = {
      command: "prime",
      status: "ok",
      mode: "returning",
      profile: {
        status: "valid",
        validity: { status: "valid" },
        freshness: { state: "fresh" },
        path: "/private/profile/path",
      },
      state_presence: {
        active: { plan: true, objective: false },
        available: { plan: true, docs: true, progress: true, health: true, objective: false },
        any_active: true,
        absence_explained: true,
        absence: {},
      },
      plan: {
        exists: true,
        id: "zzzzzzzzzz",
        artifact: "plan",
        active: true,
        status: "open",
        title: "Host-real 21-task fixture",
        complete: 20,
        total: 21,
        complete_plan: false,
        first_pending: selectedTask,
        tasks: Array.from({ length: 21 }, (_, index) => ({
          id: `${String.fromCharCode(97 + index)}aaaaaaaaa`,
          artifact: "plan",
          name: `Optional task ${index + 1}: ${"detail ".repeat(60)}`,
          status: index === 20 ? "pending" : "complete",
        })),
        task_count: 21,
        omitted_task_count: 11,
        source_contract: { detail_availability: "summary", retrieval: "agentera state plan list --format json" },
      },
      next_action: {
        object: "PLAN Task vvvvvvvvvv: Run the dependency-ready host task",
        capability: "orchestrate",
        reason: "first pending plan task",
        phase: "build",
        id: "vvvvvvvvvv",
        artifact: "plan",
        outcome: "pending",
        eligible: true,
        retrieval: { exact: "agentera state plan tasks get --id vvvvvvvvvv --format json" },
        alternatives: Array.from({ length: 3 }, (_, index) => ({
          object: `Optional route ${index}: ${"context ".repeat(40)}`,
          capability: "status",
          reason: "optional alternative",
          phase: "audit",
        })),
      },
      history: {
        progress: historyEntry("progress"),
        decisions: historyEntry("decisions"),
        health: historyEntry("health"),
      },
      source_contract: {
        fields: ["plan", "next_action", "history", "state_presence", "source_contract"],
        render: "decision brief",
        access: "bounded",
        empty_state: "explicit",
        capability_context: {
          capability: "status",
          fetch_command: "agentera prime --context status --format json",
          required_before_rendering: true,
        },
        capability_startup: {
          complete_for_capability_startup: true,
          raw_artifact_reads_required: false,
          confidence_caveats: Array.from({ length: 8 }, (_, index) => `Rich caveat ${index}: ${"optional ".repeat(20)}`),
        },
      },
      source: { artifacts_present: true },
    };

    expect(briefByteGate(rawPayload, PRIME_BRIEF_MAX_UTF8_BYTES).accepted).toBe(false);
    const normal = briefOrientationPayload(rawPayload);
    expect((normal.brief as Record<string, unknown>).status).toBe("ok");
    expect(briefUtf8Bytes(normal)).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);

    const degraded = briefOrientationPayload({
      ...rawPayload,
      source: { artifacts_present: true, optional_diagnostic: "x".repeat(8_000) },
    }, { budgetBytes: 8_000 });
    expect((degraded.brief as Record<string, unknown>).status).toBe("degraded");
    expect(briefUtf8Bytes(degraded)).toBeLessThanOrEqual(8_000);

    for (const payload of [normal, degraded]) {
      expect(payload.plan).toMatchObject({
        id: "zzzzzzzzzz",
        total: 21,
        first_pending: {
          id: "vvvvvvvvvv",
          depends_on: ["uuuuuuuuuu"],
          acceptance: expect.arrayContaining([expect.stringContaining("Preserve selected task identity")]),
          retrieval: { get: "agentera state plan tasks get --id vvvvvvvvvv --format json" },
        },
      });
      expect(payload.plan).not.toHaveProperty("tasks");
      expect(payload.next_action).toMatchObject({
        id: "vvvvvvvvvv",
        capability: "orchestrate",
        eligible: true,
        retrieval: { exact: "agentera state plan tasks get --id vvvvvvvvvv --format json" },
      });
      expect(payload.history).toMatchObject({
        progress: { counts: { total: 13, returned: 0, remaining: 13, full: 1, summary: 12 } },
        decisions: {
          caveats: expect.arrayContaining([
            expect.objectContaining({
              class: "review_needed",
              confidence: "firm",
              satisfaction_state: "provisionally_satisfied",
              review_needed: true,
            }),
          ]),
          source_contract: { authority: "references/artifacts/state-storage-authority.yaml", detail: "mixed" },
        },
        health: { degraded_history: { summary_count: 12, omitted_count: 12 } },
      });
      expect((payload.profile as Record<string, unknown>)).not.toHaveProperty("path");
    }
  });

  it("integrated bare emission bounds adversarial state_presence and source_contract projections", () => {
    const attackerControlled = "x".repeat(20_000);
    const rawPayload: Record<string, unknown> = {
      command: "prime",
      status: "ok",
      mode: "returning",
      // This extra field must not survive the bounded presence projection.
      state_presence: {
        active: { plan: true, objective: false },
        available: { plan: true, docs: false, progress: true, health: true, objective: false },
        any_active: true,
        absence_explained: true,
        absence: { docs: "missing docs mapping" },
        attacker_controlled: attackerControlled,
      },
      source_contract: {
        fields: ["plan", "state_presence", "source_contract"],
        capability_context: {
          capability: "status",
          fetch_command: "agentera prime --context status --format json",
          required_before_rendering: true,
          attacker_controlled: attackerControlled,
        },
        attacker_controlled: attackerControlled,
      },
      // Force the projected body over the configured gate so the integrated
      // path exercises the degraded envelope rather than only the normal path.
      source: { attacker_controlled: attackerControlled },
    };
    let out = "";
    let err = "";
    const rc = emitPrime(
      "prime",
      rawPayload,
      "json",
      undefined,
      (text) => (out += text),
      (text) => (err += text),
      { bareBrief: true, briefBudgetBytes: 7000 },
    );
    expect(rc).toBe(0);
    expect(err).toBe("");
    const payload = JSON.parse(out) as Record<string, unknown>;
    const bytes = Buffer.byteLength(out, "utf8");
    const brief = payload.brief as Record<string, unknown>;
    expect(brief.status).toBe("degraded");
    expect(bytes, "integrated output satisfies its configured gate").toBeLessThanOrEqual(7000);
    expect(brief.utf8_bytes, "integrated utf8_bytes matches stdout").toBe(bytes);
    expect(out).not.toContain(attackerControlled);
    expect(payload.state_presence).toMatchObject({
      active: { plan: true, objective: false },
      available: { docs: false },
      absence: { docs: "missing docs mapping" },
    });
    expect(payload.source_contract).toMatchObject({
      fields: ["plan", "state_presence", "source_contract"],
      capability_context: { fetch_command: "agentera prime --context status --format json" },
    });
  });

  it("fails explicitly when a tiny configured budget cannot contain the irreducible envelope", () => {
    expect(() => briefOrientationPayload({
      command: "prime",
      status: "ok",
      mode: "fresh",
      state_presence: { active: {}, available: {}, any_active: false, absence_explained: false, absence: {} },
      source_contract: {},
    }, { budgetBytes: 1 })).toThrow(BriefBudgetError);
  });
});

/** Read a dotted path from a JSON payload. Returns undefined when any segment
 *  is absent, mirroring how a consumer experiences a missing field. */
function getPath(payload: unknown, dotted: string): unknown {
  let cur: unknown = payload;
  for (const segment of dotted.split(".")) {
    if (cur && typeof cur === "object" && segment in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cur;
}
