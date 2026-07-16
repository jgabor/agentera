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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES } from "../../src/cli/commands/prime/orientationOutput.js";
import { runState } from "../../src/cli/dispatch/state.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

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
        expect.objectContaining({ field: "runtime_lifecycle.runtimes", recovery: "agentera upgrade --dry-run --format json" }),
      ]),
    );
    expect(result.payload.runtime_lifecycle).toBeUndefined();
    expect(state.runtime_lifecycle.runtimes).toBeUndefined();
    expect(state.project_integration).not.toHaveProperty("phases");
    expect(state.project_integration).not.toHaveProperty("guidance");
    expect(state.project_integration).not.toHaveProperty("retry");
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

  it("keeps fresh and returning mode, while incomplete state names CLI-first recovery", () => {
    const fresh = runStatus();
    const freshDashboard = renderStatusDashboard(statusState(fresh.payload));
    expect(freshDashboard.mode).toBe("fresh");
    expect(freshDashboard.project_integration).toBeDefined();
    expect(statusState(fresh.payload).state_presence.any_active).toBe(false);

    writeProjectFile(".agentera/progress.yaml", "cycles:\n  - number: 1\n    timestamp: 2026-07-16\n    what: returning\n\n");
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
    const rows = Array.from({ length: 400 }, (_, index) => {
      return `  - number: ${index + 1}\n    status: open\n    what: ${"😀漢字".repeat(300)}\n`;
    }).join("");
    writeProjectFile(".agentera/progress.yaml", `cycles:\n${rows}`);
    writeProjectFile(".agentera/decisions.yaml", `decisions:\n${rows}`);
    writeProjectFile(".agentera/health.yaml", `audits:\n${rows}`);
    const result = runStatus();
    expect(result.rc).toBe(0);
    expect(Buffer.byteLength(result.out, "utf8")).toBeLessThanOrEqual(PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES);
    expect(result.out).not.toContain("😀漢字".repeat(100));
    expect(result.err).toBe("");
  });
});
