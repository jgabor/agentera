/**
 * Plan Task 4 acceptance coverage.
 *
 * Status startup must be one bounded capsule: the response carries the
 * canonical bounded decision brief and the full status instructions, while
 * status does not preload unrelated lifecycle detail or require raw reads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES } from "../../src/cli/commands/prime/orientationOutput.js";
import { runState } from "../../src/cli/dispatch/state.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const BUDGET_MANIFEST_PATH = path.join(REPO_ROOT, "scripts/json_output_surface_manifest.yaml");

let tempRoot: string;
let project: string;
let home: string;
let appHome: string;
let previousCwd: string;
let previousHome: string | undefined;
let previousAgenteraHome: string | undefined;
let previousProfileDir: string | undefined;
let previousProfileraProfileDir: string | undefined;
let previousBootstrapSourceRoot: string | undefined;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "status-context-task4-"));
  project = path.join(tempRoot, "project");
  home = path.join(tempRoot, "home");
  appHome = path.join(home, "agentera");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(appHome, { recursive: true });
  previousCwd = process.cwd();
  previousHome = process.env.HOME;
  previousAgenteraHome = process.env.AGENTERA_HOME;
  previousProfileDir = process.env.AGENTERA_PROFILE_DIR;
  previousProfileraProfileDir = process.env.PROFILERA_PROFILE_DIR;
  previousBootstrapSourceRoot = process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  process.env.HOME = home;
  process.env.AGENTERA_HOME = appHome;
  process.env.AGENTERA_PROFILE_DIR = path.join(tempRoot, "profile");
  process.env.PROFILERA_PROFILE_DIR = path.join(tempRoot, "profile");
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.chdir(project);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgenteraHome === undefined) delete process.env.AGENTERA_HOME;
  else process.env.AGENTERA_HOME = previousAgenteraHome;
  if (previousProfileDir === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = previousProfileDir;
  if (previousProfileraProfileDir === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = previousProfileraProfileDir;
  if (previousBootstrapSourceRoot === undefined) delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  else process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = previousBootstrapSourceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function writeProjectFile(relativePath: string, contents: string): void {
  const target = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function writeTodoEntity(
  id: string,
  severity: string,
  status: string,
  description: string,
  readiness?: Record<string, unknown>,
): void {
  writeProjectFile(`.agentera/entities/todo/todo_item/${id}.yaml`, YAML.stringify({
    id,
    artifact: "todo",
    record: { severity, status, description, ...(readiness ? { readiness } : {}) },
  }));
}

function readyTodo(capability: string, reason: string, queueRank: number): Record<string, unknown> {
  return {
    capability,
    reason,
    dependencies: [],
    blocked: null,
    gate: null,
    queue_rank: queueRank,
    order_reason: "Reviewer-declared queue order.",
  };
}

function runStatus(): { rc: number; out: string; err: string; payload: Record<string, any> } {
  let out = "";
  let err = "";
  const rc = cmdPrime(
    { command: "prime", context: "status", format: "json", home, installRoot: appHome },
    { out: (text) => (out += text), err: (text) => (err += text) },
  );
  return { rc, out, err, payload: JSON.parse(out) as Record<string, any> };
}

function statusState(payload: Record<string, any>): Record<string, any> {
  return payload.capability_context.context.status_context;
}

/** The consumer contract is the nested status_context, not the capability
 * envelope metadata. Keep this renderer deliberately dependent on that object
 * alone so fixtures catch accidental cross-boundary reads. */
function renderStatusDashboard(statusContext: Record<string, any>): Record<string, any> {
  return {
    mode: statusContext.mode,
    plan: statusContext.plan,
    attention: statusContext.attention,
    next_action: statusContext.next_action,
    project_integration: statusContext.project_integration,
  };
}

describe("status capability self-contained startup", () => {
  it("delegates TODO selection to typed readiness without prose inference", () => {
    const instructions = runStatus().payload.capability_context.instructions as string;

    expect(instructions).toContain("selected from complete typed readiness state");
    expect(instructions).toContain("preserve its TODO ID, declared reason, derived phase, and exact retrieval");
    expect(instructions).not.toContain("route by shape");
    expect(instructions).not.toContain("contract-shaped, multi-surface");
  });

  it("uses the manifest's dedicated one-call status budget", () => {
    const manifest = YAML.parse(fs.readFileSync(BUDGET_MANIFEST_PATH, "utf8")) as {
      surfaces: Array<{ id: string; byte_budget: number }>;
    };
    const surface = manifest.surfaces.find((entry) => entry.id === "prime-status-context");
    expect(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES).toBe(surface?.byte_budget);
    expect(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES).toBe(25000);
  });

  it.each([
    ["fresh", () => undefined],
    ["returning", () => writeProjectFile(".agentera/progress.yaml", "cycles: []\n")],
    [
      "flagged",
      () => {
        writeProjectFile("TODO.md", "# TODO\n\n## critical\n- [ ] Repair the blocked release path\n");
        writeProjectFile(
          ".agentera/health.yaml",
          [
            "audits:",
            "  - number: 1",
            "    date: 2026-07-16",
            "    overall: degraded",
            "    dimension_grades:",
            "      - dimension: architecture_alignment",
            "        grade: D",
            "    findings:",
            "      - severity: critical",
            "        title: Release path is blocked",
            "        confidence: 95",
            "        location: release.ts:1",
            "        evidence: The release path cannot proceed.",
            "        impact: Shipping is blocked.",
            "        suggested_action: Repair the release path.",
            "",
          ].join("\n"),
        );
      },
    ],
    [
      "waiting",
      () =>
        writeProjectFile(
          ".agentera/plan.yaml",
          [
            "header:",
            "  title: Waiting for a decision",
            "  status: open",
            "tasks:",
            "  - number: 1",
            "    name: Choose the release boundary",
            "    status: pending",
            "    depends_on: []",
            "",
          ].join("\n"),
        ),
    ],
    [
      "upgrade",
      () =>
        writeProjectFile(
          ".agentera/PROGRESS.md",
          "# Progress\n\n## Cycle 1 · 2026-01-01 00:00 · feat\n\n**What**: fixture\n",
        ),
    ],
    ["incomplete-state", () => writeProjectFile(".agentera/progress.yaml", "cycles: []\n")],
  ] as const)("keeps safety rails and routing markers for $0 state", (name, setup) => {
    setup();
    const result = runStatus();
    expect(result.rc).toBe(0);
    expect(result.out.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
    expect(result.err).toBe("");

    const capsule = result.payload.capability_context;
    const state = statusState(result.payload);
    expect(typeof capsule.instructions).toBe("string");
    expect(capsule.instructions).toContain("capability_context.instructions");
    expect(capsule.instructions).toContain("capability_context.context.status_context");
    expect(capsule.instructions).toContain("⌂ status · <status>");
    expect(capsule.instructions).toContain("NEVER execute implementation work");
    expect(capsule.instructions).toContain("NEVER modify any state artifact");
    expect(capsule.instructions).toContain("authoritative recovery command");
    expect(capsule.instructions).not.toContain("Status MUST source state from `agentera prime --format json`");

    expect(state.health).toBeDefined();
    expect(state.todo).toBeDefined();
    expect(state.plan).toBeDefined();
    expect(state.profile).toBeDefined();
    expect(state.next_action).toBeDefined();
    expect(state.attention).toBeDefined();
    expect(state.state_presence).toBeDefined();
    expect(state.source_contract).toBeDefined();
    expect(state.brief.omitted_rich_state).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "plan.tasks", recovery: "agentera state plan tasks list --format json" }),
      ]),
    );
    expect(result.payload.runtime_lifecycle).toBeUndefined();
    expect(result.payload.shared_skill).toBeDefined();
    expect(state.shared_skill).toBeDefined();
    expect(capsule.state).toEqual(expect.objectContaining({
      declared_read_needs: expect.any(Array),
      declared_write_targets: expect.any(Array),
      artifact_inventory: expect.any(Object),
      included: expect.any(Array),
    }));
    expect(capsule.state).toHaveProperty("schema_error");
    expect(capsule.context).toHaveProperty("first_invocation_read");
    expect(capsule.context).toHaveProperty("schema_error");
    expect(state.project_integration).not.toHaveProperty("phases");
    expect(state.project_integration).not.toHaveProperty("guidance");
    expect(state.project_integration).not.toHaveProperty("retry");
    expect(state.source_contract).toEqual({
      capability_startup: expect.objectContaining({
        complete_for_capability_startup: expect.any(Boolean),
        raw_artifact_reads_required: expect.any(Boolean),
      }),
      empty_state: "fresh: summaries absent; zero issues",
    });
    if (name === "flagged") expect(state.attention.length).toBeGreaterThan(0);
    if (name === "waiting") expect(state.next_action.object).toBeTruthy();
    if (name === "upgrade") {
      expect(state.project_integration.recommendation).toBe("upgrade");
      expect(state.project_integration.dry_run_command).toContain("upgrade");
      expect(state.project_integration.dry_run_command).toContain("--dry-run");
      expect(state.project_integration.apply_command).toContain("upgrade");
      expect(state.project_integration.apply_command).toContain("--yes");
    } else {
      expect(state.project_integration).not.toHaveProperty("dry_run_command");
      expect(state.project_integration).not.toHaveProperty("apply_command");
    }
    if (name === "incomplete-state") {
      expect(state.source_contract.capability_startup.complete_for_capability_startup).toBe(false);
      expect(state.source_contract.capability_startup.raw_artifact_reads_required).toBe(false);
      expect(capsule.state.missing).toContain("decisions");
      const decisionsFallback = "agentera state decisions list --limit 20 --format json";
      expect(capsule.state.fallback_commands).toContain(decisionsFallback);

      let fallbackOut = "";
      let fallbackErr = "";
      const fallbackRc = runState(
        "decisions",
        ["list", "--limit", "20", "--format", "json"],
        { out: (text) => (fallbackOut += text), err: (text) => (fallbackErr += text) },
        "agentera",
      );
      expect(fallbackRc).toBe(0);
      expect(fallbackErr).toBe("");
      expect(JSON.parse(fallbackOut)).toMatchObject({ command: "state decisions list" });
    }
  });

  it("projects only open entity TODOs before applying the 20-item bound", () => {
    writeProjectFile(".agentera/state-mode.yaml", "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (let index = 0; index < 19; index += 1) {
      writeTodoEntity(`aaaaaaaa${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`, "critical", "resolved", `Resolved critical ${index}`);
    }
    writeTodoEntity("aaaaaaaaba", "degraded", "resolved", "Resolved degraded");
    writeTodoEntity("aaaaaaaabb", "normal", "open", "Ship open fix", readyTodo("build", "The fix is scoped.", 1));

    const result = runStatus();
    const state = statusState(result.payload);

    expect(result.rc).toBe(0);
    expect(state.todo).toMatchObject({ critical: 0, degraded: 0, normal: 1, annoying: 0 });
    expect(state.attention).toContain("normal: TODO: Ship open fix");
    expect(state.attention.join("\n")).not.toContain("Resolved critical");
    expect(state.attention.join("\n")).not.toContain("Resolved degraded");
    expect(state.next_action).toMatchObject({ object: "TODO aaaaaaaabb: Ship open fix", capability: "build" });
  });

  it("reports complete open TODO totals while keeping detail bounded and recoverable", () => {
    writeProjectFile(".agentera/state-mode.yaml", "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    writeTodoEntity("aaaaaaaaaa", "critical", "resolved", "Resolved critical must not count");
    for (let index = 0; index < 21; index += 1) {
      const suffix = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
      writeTodoEntity(`bbbbbbbb${suffix}`, "normal", "open", `Normal open ${index}`);
    }
    writeTodoEntity("ccccccccaa", "degraded", "open", "Degraded open");
    writeTodoEntity("zzzzzzzzzz", "critical", "open", "Critical open", readyTodo("build", "The critical fix is scoped.", 1));

    const result = runStatus();
    const state = statusState(result.payload);

    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
    expect(state.todo).toMatchObject({
      critical: 1,
      degraded: 1,
      normal: 21,
      annoying: 0,
      detail: { total: 23, returned: 20, omitted: 3 },
    });
    expect(state.attention).toContain("critical: TODO: Critical open");
    expect(state.next_action).toMatchObject({ object: "TODO zzzzzzzzzz: Critical open", capability: "build" });

    const recovery = state.todo.detail.retrieval.continue as string;
    expect(recovery).toMatch(/^agentera state todo list --status 'open' --limit 20 --cursor \S+ --format json$/);
    const cursor = recovery.match(/--cursor (\S+) --format json$/)?.[1];
    expect(cursor).toBeTruthy();

    let recoveryOut = "";
    let recoveryErr = "";
    const recoveryRc = runState(
      "todo",
      ["list", "--status", "open", "--limit", "20", "--cursor", cursor!, "--format", "json"],
      { out: (text) => (recoveryOut += text), err: (text) => (recoveryErr += text) },
      "agentera",
    );
    expect(recoveryRc).toBe(0);
    expect(recoveryErr).toBe("");
    expect(JSON.parse(recoveryOut)).toMatchObject({ counts: { total: 23, returned: 3, remaining: 0 } });
  });

  it("selects from complete TODO records before bounding and preserves discuss identity", () => {
    writeProjectFile(".agentera/state-mode.yaml", "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (let index = 0; index < 21; index += 1) {
      const suffix = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
      writeTodoEntity(`aaaaaaaa${suffix}`, "critical", "open", `Needs triage ${index}`);
    }
    const decisiveSuffix = "The visible prefix is intentionally irrelevant. ".repeat(600);
    writeTodoEntity(
      "zzzzzzzzzz",
      "critical",
      "open",
      decisiveSuffix,
      readyTodo("discuss", "Resolve the declared product boundary.", 1),
    );

    const result = runStatus();
    const state = statusState(result.payload);

    expect(result.rc).toBe(0);
    expect(state.todo.detail).toMatchObject({ total: 22, returned: 20, omitted: 2 });
    expect(state.next_action).toMatchObject({
      id: "zzzzzzzzzz",
      artifact: "todo",
      capability: "discuss",
      reason: "Resolve the declared product boundary.",
      phase: "deliberate",
      outcome: "actionable",
      retrieval: { exact: "agentera state todo get --id zzzzzzzzzz --format json" },
    });
    expect(state.next_action.alternatives).toContainEqual(expect.objectContaining({
      capability: "status",
      outcome: "needs-triage",
    }));
  });

  it("reports an exact full detail page without continuation at the 20-item bound", () => {
    writeProjectFile(".agentera/state-mode.yaml", "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    for (let index = 0; index < 20; index += 1) {
      const suffix = `${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
      writeTodoEntity(`dddddddd${suffix}`, "degraded", "open", `Bounded open ${index}`);
    }
    writeTodoEntity("eeeeeeeeaa", "critical", "resolved", "Resolved at exact bound");

    const result = runStatus();
    const state = statusState(result.payload);

    expect(result.rc).toBe(0);
    expect(state.todo).toMatchObject({
      critical: 0,
      degraded: 20,
      normal: 0,
      annoying: 0,
      detail: { total: 20, returned: 20, omitted: 0 },
    });
    expect(state.todo.detail.retrieval.get).toBe("agentera state todo get --id ID --format json");
    expect(state.todo.detail.retrieval).not.toHaveProperty("continue");
  });

  it("keeps fresh and returning mode, while incomplete state names CLI-first recovery", () => {
    const fresh = runStatus();
    const freshDashboard = renderStatusDashboard(statusState(fresh.payload));
    expect(freshDashboard.mode).toBe("fresh");
    expect(freshDashboard.project_integration).toBeDefined();
    expect(statusState(fresh.payload).state_presence.any_active).toBe(false);

    writeProjectFile(".agentera/state-mode.yaml", "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    writeProjectFile(".agentera/entities/progress/progress_cycle/aaaaaaaaaa.yaml", [
      "id: aaaaaaaaaa",
      "artifact: progress",
      "record:",
      "  timestamp: 2026-07-16 00:00",
      "  type: test",
      "  phase: build",
      "  what: returning",
      "  context:",
      "    intent: exercise returning status",
      "",
    ].join("\n"));
    const returning = runStatus();
    const returningDashboard = renderStatusDashboard(statusState(returning.payload));
    expect(returningDashboard.mode).toBe("returning");
    expect(statusState(returning.payload).state_presence.available.progress).toBe(true);
    expect(returning.payload.capability_context.raw_artifact_read_policy).toContain("included state families");
    expect(returning.payload.capability_context.state.fallback_commands).toEqual(expect.any(Array));
  });

  it("renders an upgrade recommendation and executable commands strictly from status_context", () => {
    writeProjectFile(
      ".agentera/PROGRESS.md",
      "# Progress\n\n## Cycle 1 · 2026-01-01 00:00 · feat\n\n**What**: fixture\n",
    );
    const dashboard = renderStatusDashboard(statusState(runStatus().payload));
    const integration = dashboard.project_integration as Record<string, unknown>;

    expect(integration.recommendation).toBe("upgrade");
    expect(integration.dry_run_command).toEqual(expect.stringContaining("--dry-run"));
    expect(integration.apply_command).toEqual(expect.stringContaining("--yes"));
  });

  it("bounds adversarial UTF-8 state without moving diagnostics to stdout", () => {
    const unicodeSample = "\u{10400}\u20ac\u2030";
    const rows = Array.from({ length: 400 }, (_, index) => {
      return `  - number: ${index + 1}\n    status: open\n    what: ${unicodeSample.repeat(300)}\n`;
    }).join("");
    writeProjectFile(".agentera/progress.yaml", `cycles:\n${rows}`);
    writeProjectFile(".agentera/decisions.yaml", `decisions:\n${rows}`);
    writeProjectFile(".agentera/health.yaml", `audits:\n${rows}`);
    const result = runStatus();
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
    expect(result.out).not.toContain(unicodeSample.repeat(100));
    expect(result.err).toBe("");
  });
});
