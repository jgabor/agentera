/**
 * Plan Task 3 acceptance criteria: bounded default decision brief.
 *
 * AC1: GIVEN returning, fresh, empty, missing, and degraded project fixtures
 *      WHEN bare prime runs THEN it reports mode, work summary, attention, next
 *      action, and startup completeness needed for routing.
 * AC2: Covered by primeProjectionContract.test.ts (large fixture ≤16000 bytes, stderr
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

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { BriefBudgetError, briefByteGate, briefOrientationPayload, briefUtf8Bytes, PRIME_BRIEF_MAX_UTF8_BYTES } from "../../src/cli/commands/prime/briefOrientation.js";
import { emitPrime } from "../../src/cli/commands/prime/orientationOutput.js";
import { seedPrimeEvidenceProject } from "../helpers/primeEvidenceProject.js";
import { humanReference } from "../../src/capabilities/humanReferences.js";

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

function capturePrime(): {
  rc: number;
  out: string;
  err: string;
  payload: Record<string, unknown>;
} {
  let out = "";
  let err = "";
  const rc = cmdPrime({ command: "prime", format: "json", home, installRoot: appHome }, { out: (t: string) => (out += t), err: (t: string) => (err += t) });
  expect(rc, "bare prime must exit 0").toBe(0);
  return { rc, out, err, payload: JSON.parse(out) };
}

function capturePrimeDashboard(): {
  rc: number;
  out: string;
  err: string;
  payload: Record<string, unknown>;
} {
  let out = "";
  let err = "";
  const rc = cmdPrime({ command: "prime", format: "json", dashboard: true, home, installRoot: appHome }, { out: (t: string) => (out += t), err: (t: string) => (err += t) });
  expect(rc, "prime --dashboard must exit 0").toBe(0);
  return { rc, out, err, payload: JSON.parse(out) };
}

function writeArtifact(name: string, content: string): void {
  const dir = path.join(project, ".agentera");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function docsRichFixture(): Record<string, unknown> {
  return {
    exists: true,
    status: "available",
    indexed_documents: 94,
    caveats: ["Documentation inventory includes current, intent, and stale records."],
    entries: Array.from({ length: 20 }, (_, index) => ({
      id: `${String.fromCharCode(97 + index)}ddddddddd`,
      artifact: "docs",
      record: {
        document: `Documentation inventory entry ${index + 1}: ${"bounded orientation ".repeat(14).trim()}`,
        path: `.agentera/archive/documentation-inventory-${String(index + 1).padStart(2, "0")}.md`,
        last_updated: "2026-08-12",
        status: index === 0 ? "stale" : index === 1 ? "intent" : "current",
        ...(index === 0 ? { caveats: ["This stale entry needs exact review before update."] } : {}),
      },
      provenance: {
        storage: "canonical_entity_file",
        path: `.agentera/entities/docs/documentation_inventory_entry/${String.fromCharCode(97 + index)}ddddddddd.yaml`,
        immutable: false,
      },
      retrieval: {
        get: `agentera state docs get --id ${String.fromCharCode(97 + index)}ddddddddd`,
      },
    })),
  };
}

function nestedPathAtLeast(base: string, minimumLength: number, label: string): string {
  let current = path.join(base, label);
  fs.mkdirSync(current, { recursive: true });
  let index = 0;
  while (current.length < minimumLength) {
    const remaining = minimumLength - current.length - 1;
    const segment = `${label}-${String(index).padStart(3, "0")}`.padEnd(Math.min(80, Math.max(12, remaining)), "x");
    current = path.join(current, segment);
    fs.mkdirSync(current);
    index += 1;
  }
  return current;
}

function returningFixture(): void {
  writeArtifact("plan.yaml", ["header:", "  title: Returning Task", "  status: in_progress", "tasks:", "  - number: 1", "    name: Ship feature", "    status: pending", "    depends_on: []", "    acceptance: [tests pass]", ""].join("\n"));
  writeArtifact("progress.yaml", ["cycles:", "  - number: 1", "    status: complete", "    what: Initial setup", "    next: Ship feature", "    verification: tests pass", ""].join("\n"));
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
  writeArtifact("plan.yaml", ["header:", "  title: Stale project", "  status: in_progress", "tasks:", "  - number: 1", "    name: Fix staleness", "    status: pending", "    depends_on: []", "    acceptance: [audit passes]", ""].join("\n"));
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
    const startup = payload.startup as Record<string, unknown> | undefined;
    expect(startup, `${label}: startup is present`).toBeDefined();
    expect(["ok", "degraded", "blocked"]).toContain(startup?.outcome);
    expect(Array.isArray(startup?.availability), `${label}: availability is an array`).toBe(true);
    // Brief meta
    const brief = payload.brief as Record<string, unknown> | undefined;
    expect(brief, `${label}: brief meta is present`).toBeDefined();
    expect(typeof brief?.projection, `${label}: brief.projection is a string`).toBe("string");
  }

  it("returning project: mode=returning, brief projection=ok, all routing signals present", () => {
    returningFixture();
    const { payload } = capturePrime();
    expect(payload.mode, "returning fixture has mode=returning").toBe("returning");
    expect((payload.brief as Record<string, unknown>).projection).toBe("ok");
    assertRoutingSignals(payload, "returning");
  });

  it("fresh project (no .agentera): mode=fresh, brief projection=ok, all routing signals present", () => {
    // No .agentera directory created — fresh state
    const { payload } = capturePrime();
    expect(payload.mode, "fresh fixture has mode=fresh").toBe("fresh");
    expect((payload.brief as Record<string, unknown>).projection).toBe("ok");
    assertRoutingSignals(payload, "fresh");
  });

  it("empty project (present-but-empty artifacts): mode=fresh, brief projection=ok, routing signals present", () => {
    emptyFixture();
    const { payload } = capturePrime();
    expect((payload.brief as Record<string, unknown>).projection).toBe("ok");
    assertRoutingSignals(payload, "empty");
  });

  it("missing project (no plan/progress/decisions artifacts): routing signals present without error", () => {
    // .agentera directory exists but has no state artifacts (only TODO.md)
    const dir = path.join(project, ".agentera");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "TODO.md"), "# TODO\n");
    const { payload } = capturePrime();
    expect((payload.brief as Record<string, unknown>).projection).toBe("ok");
    assertRoutingSignals(payload, "missing");
  });

  it("degraded project (stale health, incomplete plan): routing signals present", () => {
    degradedProjectFixture();
    const { payload } = capturePrime();
    expect((payload.brief as Record<string, unknown>).projection).toBe("ok");
    assertRoutingSignals(payload, "degraded");
    // A degraded project generates attention entries (audit staleness)
    const attention = payload.attention as unknown[];
    expect(attention.length, "degraded project has ≥1 attention entry").toBeGreaterThan(0);
  });
});

describe("Task 3 AC4: omitted rich state has named recovery without raw artifact access", () => {
  it("every brief.omitted entry maps a field path to a named recovery command (not a raw artifact read)", () => {
    returningFixture();
    const { payload } = capturePrime();
    const brief = payload.brief as Record<string, unknown>;
    expect(brief.projection, "ok brief for returning fixture").toBe("ok");

    const omitted = brief.omitted as Record<string, unknown>;
    expect(Object.keys(omitted).length, "brief.omitted names at least one omission").toBeGreaterThan(0);

    for (const [field, recovery] of Object.entries(omitted) as Array<[string, string]>) {
      expect(field, "omission key is a dotted field path").toMatch(/^[a-z_]+(\.[a-z_]+)*$/);
      expect(typeof recovery, "recovery is a string").toBe("string");
      // Recovery must be a named agentera command, not a raw file path read
      expect(recovery.startsWith("npx -y agentera@next "), "recovery starts with the pre-cutover development channel").toBe(true);
      expect(recovery, "recovery is NOT a raw artifact read (no .agentera/ path)").not.toMatch(/\.agentera\//);
      expect(recovery, "recovery is NOT a raw file read (no cat/head/tail)").not.toMatch(/\b(cat|head|tail|vi|nano)\b/);
    }
  });

  it("keeps --dashboard as a deprecated status startup alias", () => {
    returningFixture();
    // Bare default → brief projected
    const bareResult = capturePrime();
    expect(bareResult.payload, "bare default has brief meta").toHaveProperty("brief");
    const dashboard = capturePrimeDashboard();
    expect(dashboard.err).toContain("Deprecation: prime --dashboard");
    expect(dashboard.payload.capability_context.context.status_context.outcome).toBe(dashboard.payload.capability_context.startup.outcome);
    expect(JSON.stringify(dashboard.payload)).not.toContain('"write_contract"');
  });

  it("--dashboard does not reintroduce the retired full orientation payload", () => {
    returningFixture();
    const result = capturePrimeDashboard();
    const dashboard = result.payload;
    expect(dashboard.capability_context.capability).toBe("status");
    expect(dashboard).not.toHaveProperty("plan");
    expect(dashboard).not.toHaveProperty("source_contract");
  });
});

describe("Task 3 AC5: byte gate accepts passing and rejects over-budget fixtures", () => {
  it.each(["decision", "task", "todo"] as const)("retains bounded %s action meaning even in the irreducible brief", (family) => {
    const state = family === "decision" ? "confidence firm; satisfaction unavailable" : "pending";
    const object = humanReference(family, "Readable 漢😀 ".repeat(100), "aaaaaaaaaa", state);
    const payload = {
      next_action: {
        id: "aaaaaaaaaa",
        artifact: family === "decision" ? "decisions" : family === "task" ? "plan" : "todo",
        object,
        reason: "r".repeat(200),
        capability: "build",
        phase: "build",
        alternatives: [],
      },
      // Prose that the degraded tiers shorten, so a fallback can be smaller
      // than the normal projection and the 32-point tier is reachable.
      progress: { exists: true, latest: { what: "p".repeat(200), next: "p".repeat(200) } },
      health: { exists: true, trajectory: "p".repeat(200) },
      plan: { exists: true, title: "p".repeat(200) },
      project_integration: { recommendation: "stay", message: "p".repeat(200) },
      shared_skill: { name: "canonical_skill", status: "pass", message: "p".repeat(200) },
    };
    let irreducible = false;
    for (const budgetBytes of [16000, 2000, 1725, 1500, 1000]) {
      try {
        const result = briefOrientationPayload(payload, { budgetBytes });
        const action = result.next_action as Record<string, string>;
        expect(action.object).toBe(object);
        expect(action.id).toBe("aaaaaaaaaa");
        expect(briefUtf8Bytes(result)).toBeLessThanOrEqual(budgetBytes);
        if (Array.from(action.reason).length === 32) irreducible = true;
      } catch (error) {
        if (!(error instanceof BriefBudgetError)) throw error;
      }
    }
    expect(irreducible, "exercise the 32-point fallback, not only the normal presenter").toBe(true);
  });

  it("briefByteGate accepts a small payload (bytes ≤ budget)", () => {
    const small = { hello: "world" };
    const result = briefByteGate(small, PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(result.accepted, "small payload is accepted").toBe(true);
    expect(result.bytes, "small payload bytes > 0").toBeGreaterThan(0);
  });

  it("briefByteGate rejects a large payload (bytes > budget)", () => {
    // Build a payload that exceeds the brief budget
    const large: Record<string, unknown> = {};
    for (let i = 0; i < 500; i += 1) {
      large[`field_${i}`] = "x".repeat(50);
    }
    const result = briefByteGate(large, PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(result.bytes, "large payload exceeds budget").toBeGreaterThan(PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(result.accepted, "over-budget payload is rejected").toBe(false);
  });

  it("briefOrientationPayload returns projection=ok for a projected payload within budget", () => {
    returningFixture();
    const { payload } = capturePrime();
    const brief = payload.brief as Record<string, unknown>;
    expect(brief.projection, "returning fixture brief is ok").toBe("ok");
    const bytes = briefUtf8Bytes(payload);
    expect(bytes, "ok brief is within budget").toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);
  });

  it("keeps docs to a summary and names the docs list for omitted entries", () => {
    returningFixture();
    const { payload } = capturePrime();
    const result = briefOrientationPayload({
      ...payload,
      docs: {
        exists: true,
        status: "summary_only",
        indexed_documents: 1,
        entries: [{ id: "abcdefghij", artifact: "docs", retrieval: { get: "agentera state docs get --id abcdefghij" } }],
      },
    }) as any;
    expect(result.docs).toEqual({ exists: true, status: "summary_only", indexed_documents: 1 });
    expect(result.brief.omitted["docs.entries"]).toBe("npx -y agentera@next state docs list");
    expect(briefUtf8Bytes(result)).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);

    const empty = briefOrientationPayload({ ...payload, docs: { exists: false, status: "missing", indexed_documents: 0, entries: [] } }) as any;
    expect(empty.brief.omitted).not.toHaveProperty("docs.entries");
  });

  it("briefOrientationPayload returns projection=degraded when projected brief exceeds budget", () => {
    // Use a real returning-fixture payload with a budget one byte below its
    // projected brief, forcing the degraded envelope.
    returningFixture();
    const { payload } = capturePrime();
    const rawPayload = { ...payload } as Record<string, unknown>;
    delete rawPayload.brief;
    // A smaller budget can drop a digit from budget_utf8_bytes, so leave a
    // margin that no digit change can close.
    const budgetBytes = briefUtf8Bytes(briefOrientationPayload(rawPayload)) - 10;
    const degraded = briefOrientationPayload(rawPayload, { budgetBytes });
    const brief = degraded.brief as Record<string, unknown>;
    expect(brief.projection, "reduced budget forces degraded").toBe("degraded");
    expect(brief.attempted_utf8_bytes, "attempted bytes recorded").toBeGreaterThan(budgetBytes);
    // The degraded envelope must satisfy the configured gate, not merely the
    // production 16000-byte authority.
    const bytes = briefUtf8Bytes(degraded);
    expect(bytes, "degraded envelope is within the configured budget").toBeLessThanOrEqual(budgetBytes);
    expect(brief.utf8_bytes, "degraded utf8_bytes matches exact output bytes").toBe(bytes);
    // The degraded envelope keeps routing-essential fields
    expect(degraded, "degraded keeps command").toHaveProperty("command");
    expect(degraded, "degraded keeps outcome").toHaveProperty("outcome");
    expect(degraded, "degraded keeps mode").toHaveProperty("mode");
    expect(degraded, "degraded keeps state_presence").toHaveProperty("state_presence");
    expect(degraded, "degraded keeps source_contract").toHaveProperty("source_contract");
    expect(degraded, "degraded keeps plan").toHaveProperty("plan");
    expect(degraded, "degraded keeps next_action").toHaveProperty("next_action");
    expect(degraded, "degraded keeps history").toHaveProperty("history");
  });

  it("keeps canonical TODO in a degraded emission and rejects its comma-form retired alias before projection", () => {
    returningFixture();
    const { payload } = capturePrime();
    const rawPayload = { ...payload } as Record<string, unknown>;
    delete rawPayload.brief;
    const budgetBytes = briefUtf8Bytes(briefOrientationPayload(rawPayload)) - 10;

    let canonicalOut = "";
    let canonicalErr = "";
    const canonicalRc = emitPrime(
      "prime",
      rawPayload,
      "json",
      undefined,
      (text) => (canonicalOut += text),
      (text) => (canonicalErr += text),
      { bareBrief: true, briefBudgetBytes: budgetBytes },
    );
    expect(canonicalRc).toBe(0);
    expect(canonicalErr).toBe("");
    const canonical = JSON.parse(canonicalOut) as Record<string, any>;
    expect(canonical.brief.projection).toBe("degraded");
    expect(canonical.todo).toBeTruthy();
    expect(canonical).not.toHaveProperty("issues");

    let rejectedOut = "";
    let rejectedErr = "";
    const rejectedRc = emitPrime(
      "prime",
      rawPayload,
      "json",
      "todo,issues",
      (text) => (rejectedOut += text),
      (text) => (rejectedErr += text),
      { bareBrief: true, briefBudgetBytes: budgetBytes },
    );
    expect(rejectedRc).toBe(2);
    expect(rejectedErr).toBe("");
    const rejected = JSON.parse(rejectedOut) as Record<string, any>;
    expect(rejected).not.toHaveProperty("brief");
    expect(rejected).toMatchObject({
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: { valid_values: ["todo"] },
    });
  });

  it("trims optional 21-task, docs-rich, and path diagnostics before selected routing and canonical history evidence", () => {
    const selectedTask = {
      id: "vvvvvvvvvv",
      artifact: "plan",
      name: "Run the dependency-ready host task",
      status: "pending",
      depends_on: ["uuuuuuuuuu"],
      dependency_count: 1,
      omitted_dependency_count: 0,
      acceptance: ["Preserve selected task identity and dependency evidence.", "Retain one exact recovery command in every successful envelope."],
      acceptance_count: 2,
      omitted_acceptance_count: 0,
      retrieval: { get: "agentera state plan tasks get --id vvvvvvvvvv" },
    };
    const historyEntry = (artifact: string) => ({
      artifact,
      status: "degraded",
      compatibility: "mixed",
      detail_availability: "omitted",
      counts: { total: 13, returned: 0, remaining: 13, full: 1, summary: 12 },
      caveats: [
        `${artifact} compacted history is incomplete and requires exact review.`,
        ...(artifact === "decisions"
          ? [
              {
                class: "review_needed",
                confidence: "firm",
                satisfaction_state: "provisionally_satisfied",
                review_needed: true,
                message: "Use explicit state; never infer satisfaction.",
              },
            ]
          : []),
      ],
      degraded_history: {
        summary_count: 12,
        returned_count: 0,
        omitted_count: 12,
        retrieval: {
          list: `agentera state ${artifact} list --limit 20`,
          get: `agentera state ${artifact} get --id ID`,
        },
      },
      retrieval: {
        list: `agentera state ${artifact} list --limit 20`,
        get: `agentera state ${artifact} get --id ID`,
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
        source_contract: { detail_availability: "summary", retrieval: "agentera state plan list" },
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
        retrieval: { exact: "agentera state plan tasks get --id vvvvvvvvvv" },
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
      progress: {
        exists: true,
        status: "degraded_history",
        degraded_history: {
          status: "degraded",
          summary_count: 12,
          returned_count: 0,
          omitted_count: 12,
          caveats: ["Progress summary history remains exact and read-only."],
          retrieval: {
            list: "agentera state progress list --limit 20",
            get: "agentera state progress get --id ID",
          },
        },
      },
      health: {
        exists: true,
        degraded_history: {
          status: "degraded",
          summary_count: 12,
          returned_count: 0,
          omitted_count: 12,
          caveats: ["Health summary history remains exact and read-only."],
          retrieval: {
            list: "agentera state health list --limit 20",
            get: "agentera state health get --id ID",
          },
        },
      },
      source_contract: {
        fields: ["plan", "next_action", "history", "state_presence", "source_contract"],
        render: "decision brief",
        access: "bounded",
        empty_state: "explicit",
        capability_context: {
          capability: "status",
          fetch_command: "agentera prime --context status",
          required_before_rendering: true,
        },
      },
      startup: {
        schemaVersion: "agentera.primeStartup.v1",
        outcome: "ok",
        availability: Array.from({ length: 8 }, (_, index) => ({
          family: `optional-${index}`,
          availability: "deferred",
          detail_command: "agentera schema",
        })),
        detail_discovery: { schema: "agentera schema" },
        raw_artifact_reads_required: false,
        raw_artifact_read_policy: "Use the exact detail command.",
      },
      source: { artifacts_present: true },
    };

    expect(briefByteGate(rawPayload, PRIME_BRIEF_MAX_UTF8_BYTES).accepted).toBe(false);
    const normal = briefOrientationPayload(rawPayload);
    expect((normal.brief as Record<string, unknown>).projection).toBe("ok");
    expect(briefUtf8Bytes(normal)).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);

    const docs = docsRichFixture();
    const docsRich = briefOrientationPayload({ ...rawPayload, docs }, { degradedMode: "status_routing" });
    const docsRichBytes = briefUtf8Bytes(docsRich);
    const projectedDocs = docsRich.docs as Record<string, any>;
    // Docs entries never enter the brief, so a docs-rich project stays in the
    // normal projection with room to spare.
    expect((docsRich.brief as Record<string, unknown>).projection).toBe("ok");
    expect(PRIME_BRIEF_MAX_UTF8_BYTES - docsRichBytes).toBeGreaterThanOrEqual(1_000);
    expect(projectedDocs).toEqual({
      exists: true,
      status: "available",
      indexed_documents: 94,
      caveats: (docs as any).caveats,
    });
    expect((docsRich.brief as Record<string, any>).omitted["docs.entries"]).toBe("npx -y agentera@next state docs list");
    expect(JSON.stringify(docsRich)).not.toContain("ddddddddd");
    expect((docs as any).entries).toHaveLength(20);
    for (const artifact of ["progress", "health"] as const) {
      const projected = docsRich[artifact] as Record<string, any>;
      expect(projected.degraded_history).toMatchObject({
        status: "degraded",
        summary_count: 12,
        returned_count: 0,
        omitted_count: 12,
        caveats: [expect.stringContaining("summary history remains exact")],
      });
      expect(projected.degraded_history).not.toHaveProperty("retrieval");
      // The list route appears once, as the history continuation.
      expect(JSON.stringify(docsRich).split(`agentera state ${artifact} list --limit 20`)).toHaveLength(2);
    }

    const longPath = `/tmp/${"nested/".repeat(350)}project`;
    const pathPressured = briefOrientationPayload({
      ...rawPayload,
      app_home: {
        install_track: "source",
        status: "ready",
        source: "bootstrap_source_root",
        home: longPath,
        managed_app_root: longPath,
        user_data_root: longPath,
      },
      app: {
        status: "ready",
        expectedVersion: "3.0.0",
        updateChannel: "development",
        appHome: longPath,
        skillRoot: longPath,
        runtimeRoot: longPath,
        sourceRoot: longPath,
      },
      shared_skill: {
        name: "canonical_skill",
        status: "warn",
        message: "canonical shared Agentera skill is missing or invalid",
        source: null,
        path: longPath,
        gap: "skill_path_drift",
        details: ["install or repair through the documented setup command"],
      },
      source: { schemas_dir: longPath, project: longPath, artifacts_present: true },
    });
    expect((pathPressured.brief as Record<string, unknown>).projection).toBe("ok");
    expect(briefUtf8Bytes(pathPressured)).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);
    expect(pathPressured.app_home).not.toHaveProperty("home");
    expect(pathPressured.app).not.toHaveProperty("sourceRoot");
    expect(pathPressured.shared_skill).not.toHaveProperty("path");

    const degradedBudget = briefUtf8Bytes(normal) - 10;
    const degraded = briefOrientationPayload(rawPayload, { budgetBytes: degradedBudget });
    expect((degraded.brief as Record<string, unknown>).projection).toBe("degraded");
    expect(briefUtf8Bytes(degraded)).toBeLessThanOrEqual(degradedBudget);

    for (const payload of [normal, pathPressured, degraded]) {
      expect(payload.plan).toMatchObject({
        id: "zzzzzzzzzz",
        total: 21,
        first_pending: {
          id: "vvvvvvvvvv",
          depends_on: ["uuuuuuuuuu"],
          acceptance: expect.arrayContaining([expect.stringContaining("Preserve selected task identity")]),
          retrieval: { get: "agentera state plan tasks get --id vvvvvvvvvv" },
        },
      });
      expect(payload.plan).not.toHaveProperty("tasks");
      expect(payload.next_action).toMatchObject({
        id: "vvvvvvvvvv",
        capability: "orchestrate",
        eligible: true,
        retrieval: { exact: "agentera state plan tasks get --id vvvvvvvvvv" },
      });
      expect(payload.history).toMatchObject({
        progress: { counts: { total: 13, full: 1, summary: 12 } },
        decisions: {
          caveats: expect.arrayContaining([
            expect.objectContaining({
              class: "review_needed",
              confidence: "firm",
              satisfaction_state: "provisionally_satisfied",
              review_needed: true,
            }),
          ]),
        },
        health: { degraded_history: { summary_count: 12, omitted_count: 12 } },
      });
      for (const artifact of ["progress", "decisions", "health"]) {
        expect((payload.history as Record<string, any>)[artifact]).not.toHaveProperty("source_contract");
        expect((payload.history as Record<string, any>)[artifact]).not.toHaveProperty("retrieval");
      }
      expect(payload.progress).toMatchObject({
        status: "degraded_history",
        degraded_history: { summary_count: 12, returned_count: 0, omitted_count: 12 },
      });
      expect(payload.health).toMatchObject({
        exists: true,
        degraded_history: { summary_count: 12, returned_count: 0, omitted_count: 12 },
      });
      expect(payload.profile as Record<string, unknown>).not.toHaveProperty("path");
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
          fetch_command: "agentera prime --context status",
          required_before_rendering: true,
          attacker_controlled: attackerControlled,
        },
        attacker_controlled: attackerControlled,
      },
      // Unknown source diagnostics are not routing evidence and must not
      // consume the bounded brief budget.
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
    expect(brief.projection).toBe("ok");
    expect(bytes, "integrated output satisfies its configured gate").toBeLessThanOrEqual(7000);
    expect(brief.utf8_bytes, "integrated utf8_bytes matches stdout").toBe(bytes);
    expect(out).not.toContain(attackerControlled);
    expect(payload.state_presence).toMatchObject({
      active: { plan: true, objective: false },
      available: { docs: false },
      absence: { docs: "missing docs mapping" },
    });
    expect(payload.source_contract).toEqual({
      capability_context: { capability: "status", fetch_command: "agentera prime --context status", required_before_rendering: true },
    });
  });

  it("keeps real cmdPrime routing and history stable across short, 600-, and 2400-character startup paths", () => {
    const fixture = seedPrimeEvidenceProject(project);
    const outputs: Array<{ bytes: number; payload: Record<string, unknown> }> = [];

    for (const minimumLength of [80, 600, 2400]) {
      const matrixRoot = path.join(tmp, `path-matrix-${minimumLength}`);
      fs.mkdirSync(matrixRoot);
      const matrixHome = nestedPathAtLeast(matrixRoot, minimumLength, "home");
      const matrixSource = nestedPathAtLeast(matrixRoot, minimumLength, "source");
      fs.cpSync(path.join(REPO_ROOT, "skills"), path.join(matrixSource, "skills"), {
        recursive: true,
      });
      fs.cpSync(path.join(REPO_ROOT, "references"), path.join(matrixSource, "references"), {
        recursive: true,
      });
      fs.copyFileSync(path.join(REPO_ROOT, "registry.json"), path.join(matrixSource, "registry.json"));
      fs.writeFileSync(path.join(matrixSource, ".agentera-npx-bundle.json"), "{}\n");
      process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = matrixSource;

      const capture = (fields?: string): { out: string; payload: Record<string, unknown> } => {
        let out = "";
        let err = "";
        const rc = cmdPrime({ command: "prime", format: "json", home: matrixHome, installRoot: matrixSource, fields }, { out: (text) => (out += text), err: (text) => (err += text) });
        expect(rc, err).toBe(0);
        return { out, payload: JSON.parse(out) as Record<string, unknown> };
      };

      const sparse = capture("app_home,app,shared_skill").payload;
      expect(String(getPath(sparse, "app_home.home")).length).toBeGreaterThanOrEqual(minimumLength);
      expect(String(getPath(sparse, "app.sourceRoot")).length).toBeGreaterThanOrEqual(minimumLength);
      expect(String(getPath(sparse, "shared_skill.path")).length).toBeGreaterThanOrEqual(minimumLength);

      const bare = capture();
      expect(bare.payload.app_home).not.toHaveProperty("home");
      expect(bare.payload.app).not.toHaveProperty("sourceRoot");
      expect(bare.payload.shared_skill).not.toHaveProperty("path");
      expect(bare.payload).toMatchObject({
        plan: { exists: true, id: fixture.planId, first_pending: { id: fixture.selectedTaskId } },
        next_action: {
          id: fixture.selectedTaskId,
          object: expect.any(String),
          capability: expect.any(String),
          retrieval: {
            exact: `npx -y agentera@next state plan tasks get --id ${fixture.selectedTaskId}`,
          },
        },
        history: {
          progress: {
            counts: {
              total: expect.any(Number),
              full: expect.any(Number),
              summary: expect.any(Number),
            },
          },
          decisions: { counts: { total: expect.any(Number) } },
          health: { counts: { total: expect.any(Number) } },
        },
        brief: {
          omitted: {
            "history.progress.entries": "npx -y agentera@next state progress list --limit 20",
            "history.decisions.entries": "npx -y agentera@next state decisions list --limit 20",
            "history.health.entries": "npx -y agentera@next state health list --limit 20",
          },
        },
      });
      expect(["ok", "degraded"]).toContain((bare.payload.brief as Record<string, unknown>).projection);
      expect(Buffer.byteLength(bare.out, "utf8")).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);
      outputs.push({ bytes: Buffer.byteLength(bare.out, "utf8"), payload: bare.payload });
    }

    expect(outputs.map(({ bytes }) => bytes)).toEqual([outputs[0]!.bytes, outputs[0]!.bytes, outputs[0]!.bytes]);
    expect(outputs[1]!.payload).toEqual(outputs[0]!.payload);
    expect(outputs[2]!.payload).toEqual(outputs[0]!.payload);
  });

  it("fails explicitly when a tiny configured budget cannot contain the irreducible envelope", () => {
    expect(() =>
      briefOrientationPayload(
        {
          command: "prime",
          status: "ok",
          mode: "fresh",
          state_presence: {
            active: {},
            available: {},
            any_active: false,
            absence_explained: false,
            absence: {},
          },
          source_contract: {},
        },
        { budgetBytes: 1 },
      ),
    ).toThrow(BriefBudgetError);
  });

  it("keeps a fixed status-routing envelope inside the public budget and rejects a smaller budget", () => {
    const payload = {
      command: "prime",
      outcome: "ok",
      mode: "v3",
      state_presence: {
        active: {},
        available: {},
        any_active: true,
        absence_explained: false,
        absence: {},
      },
      source_contract: {},
      todo: {
        exists: true,
        total: 1,
        // Keep the payload fixed so metadata growth cannot silently consume
        // the gate: the envelope size below is pinned.
        items: [{ id: "vvvvvvvvvv", text: "x".repeat(11_145) }],
      },
    };
    const brief = briefOrientationPayload(payload, {
      budgetBytes: PRIME_BRIEF_MAX_UTF8_BYTES,
      degradedMode: "status_routing",
    });
    const briefBytes = briefUtf8Bytes(brief);
    expect(brief).toEqual({
      command: "prime",
      outcome: "ok",
      mode: "v3",
      state_presence: payload.state_presence,
      source_contract: {},
      todo: payload.todo,
      brief: {
        budget_utf8_bytes: PRIME_BRIEF_MAX_UTF8_BYTES,
        projection: "ok",
        omitted: {},
        utf8_bytes: briefBytes,
      },
    });
    expect(briefBytes).toBe(11_624);
    // Every degraded tier repeats the same TODO payload and adds error
    // metadata, so none fits where the normal projection does not.
    expect(() =>
      briefOrientationPayload(payload, {
        budgetBytes: briefBytes - 10,
        degradedMode: "status_routing",
      }),
    ).toThrow(BriefBudgetError);
  });

  it("keeps one canonical TODO reconciliation route in a degraded brief", () => {
    const reconciliation = {
      state: "unsafe_inactive",
      status: "action_required",
      preview_command: "npx -y agentera@next state todo correct-owners --input OWNER_MAPPING.yaml --dry-run",
      apply_command: "npx -y agentera@next state todo correct-owners --input OWNER_MAPPING.yaml --effect-sha256 SHA256 --yes",
      risks: {
        resurrected_count: 161,
        resurrected_ids: Array.from({ length: 20 }, (_, index) => `todo-${index}`),
        omitted_count: 141,
      },
    };
    const payload: Record<string, unknown> = {
      command: "prime",
      outcome: "blocked",
      mode: "returning",
      state_presence: {
        active: {},
        available: {},
        any_active: true,
        absence_explained: false,
        absence: {},
      },
      source_contract: {},
      todo_reconciliation: reconciliation,
      startup: {
        schemaVersion: "agentera.primeStartup.v1",
        outcome: "blocked",
        todo_reconciliation: reconciliation,
        availability: [],
      },
      // Sized so the normal projection, which repeats the reconciliation in
      // startup, exceeds the budget and the degraded envelope does not.
      todo: { detail: "x".repeat(PRIME_BRIEF_MAX_UTF8_BYTES - 2_000) },
    };

    const compact = briefOrientationPayload(payload, { degradedMode: "status_routing" });
    expect((compact.brief as Record<string, unknown>).projection).toBe("degraded");
    expect(compact.todo_reconciliation).toEqual(reconciliation);
    expect(compact.startup).not.toHaveProperty("todo_reconciliation");
    expect(briefUtf8Bytes(compact)).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);
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
