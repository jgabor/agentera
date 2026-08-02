import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import statusInstructions from "../../src/capabilities/status/instructions.js";
import { buildPrimeCapabilityContextPayload } from "../../src/cli/capabilityContext.js";
import { STATE_FAMILY_FALLBACK_COMMANDS } from "../../src/cli/capabilityContext/types.js";
import {
  buildStatusCapabilityContextPayload,
  collectOrientationState,
  finalizeStatusCapabilityContextPayload,
} from "../../src/cli/commands/prime.js";
import {
  buildOrientationJsonPayload,
  buildStatusContextState,
  emitPrime,
  PRIME_BRIEF_MAX_UTF8_BYTES,
  PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES,
} from "../../src/cli/commands/prime/orientationOutput.js";
import type { OrientationState } from "../../src/cli/contracts/orientationState.js";
import { evaluateFixture } from "../../src/eval/semanticEval.js";
import { loadFixture } from "../../src/eval/semanticFixtures.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function withSyntheticOrientationState<T>(run: (state: OrientationState) => T): T {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "asb-"));
  const home = path.join(fixture, "h");
  const project = path.join(fixture, "p");
  const dataHome = path.join(home, "d");
  const installRoot = path.join(dataHome, "agentera");
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, "PROFILE.md"), "");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(home, ".agents", "skills", "agentera"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".agents", "skills", "agentera", "SKILL.md"),
    "---\nname: agentera\n---\n",
  );
  try {
    process.chdir(project);
    process.env.HOME = home;
    return run(
      collectOrientationState({
        home,
        env: {
          ...process.env,
          HOME: home,
          XDG_DATA_HOME: dataHome,
          AGENTERA_HOME: undefined,
          AGENTERA_DEFAULT_INSTALL_ROOT: undefined,
          AGENTERA_PROFILE_DIR: undefined,
          PROFILERA_PROFILE_DIR: undefined,
          AGENTERA_VISIBLE_SKILL_ROOT: undefined,
          AGENTERA_BOOTSTRAP_SOURCE_ROOT: REPO_ROOT,
        },
      }),
    );
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function renderStatusContractBriefing(payload: Record<string, unknown>): string {
  const health = payload.health as Record<string, unknown>;
  const todo = payload.todo as Record<string, number>;
  const plan = payload.plan as Record<string, unknown>;
  const profile = payload.profile as Record<string, unknown>;
  const next = payload.next_action as Record<string, string>;
  const attention = payload.attention as string[];

  return [
    `⛶ health ${health.grade ?? "unknown"} (${String(health.worst ?? "none")})`,
    `⇶ todo ${todo.critical} critical · ${todo.degraded} degraded · ${todo.annoying} annoying`,
    `≡ plan ${plan.complete ?? 0}/${plan.total ?? 0} tasks`,
    `♾ profile ${profile.status ?? "unknown"}`,
    // objective is a conditional top-level field, omitted from the default
    // briefing when no objective is active (state_presence.active.objective is
    // the missing-vs-empty signal). Treat its absence as "none active".
    `⎘ objective ${payload.objective && (payload.objective as Record<string, unknown>).active ? String((payload.objective as Record<string, unknown>).name ?? "active") : "none active"}`,
    "Shared-skill and CLI state are the active integration contract.",
    "attention:",
    ...attention.map((item) => `→ ${item}`),
    `suggested → ${next.capability} (${next.object})`,
  ].join("\n");
}

function statusBudget(): { briefing: number; suggestion: number } {
  const briefing = Number(/≤(\d+) words total briefing/.exec(statusInstructions)?.[1] ?? 0);
  const suggestion = Number(
    /≤(\d+) words per routing suggestion/.exec(statusInstructions)?.[1] ?? 0,
  );
  return { briefing, suggestion };
}

describe("status dashboard contract", () => {
  it("keeps a complete worst-case rendered briefing within the canonical budget", () => {
    const baseState = collectOrientationState({ home: os.homedir(), env: process.env });
    const state: OrientationState = {
      ...baseState,
      project_integration: {
        ...baseState.project_integration,
        phases: {
          ...baseState.project_integration.phases,
          app: { status: "stay", counts: { total: 0, pending: 0, blocked: 0 }, blockers: [] },
        },
      },
    };
    const payload = buildOrientationJsonPayload(
      {
        ...state,
        attention: [
          "degraded: shared skill missing at ~/.agents/skills/agentera; install or repair that path",
          "normal: profile stale; suggest profile",
          "normal: PLAN Task 6: verify selectors and safety",
          "normal: TODO: refresh release notes",
        ],
      },
      "prime",
    );
    const rendered = renderStatusContractBriefing(payload);
    const budget = statusBudget();

    expect(budget).toEqual({ briefing: 120, suggestion: 15 });
    expect(rendered).toContain("~/.agents/skills/agentera");
    expect(wordCount(rendered)).toBeLessThanOrEqual(budget.briefing);
    expect(
      wordCount(
        `suggested → ${String((payload.next_action as Record<string, string>).capability)} ` +
          `(${String((payload.next_action as Record<string, string>).object)})`,
      ),
    ).toBeLessThanOrEqual(budget.suggestion);

    const [fixture, fixtureErrors] = loadFixture(
      path.resolve(process.cwd(), "../../fixtures/semantic/status-cli-budget.md"),
    );
    expect(fixtureErrors).toEqual([]);
    expect(fixture).toBeTruthy();
    const semanticResult = evaluateFixture(
      {
        ...fixture!,
        capturedOutput: rendered,
        toolTrace: { calls: [] },
        expectedFacts: {
          required_output: ["⛶ health", "attention:", "suggested →"],
          forbidden_output: ["--yes"],
          artifact_expectations: { writes: "none" },
        },
      },
      "status-dashboard-budget",
    );
    expect(semanticResult.status).toBe("pass");
  });

  it("retains required routing fields in a near-budget full startup context", () => {
    withSyntheticOrientationState((baseState) => {
    const boundedText = "routing context ".repeat(12).slice(0, 142);
      const state: OrientationState = {
        ...baseState,
        counts: { critical: 1, degraded: 7, normal: 23, annoying: 2 },
        todo_detail: {
          total: 33,
          returned: 20,
          omitted: 13,
          retrieval: {
            get: "agentera state todo get --id ID --format json",
            continue: `agentera state todo list --status 'open' --limit 20 --cursor ${"c".repeat(320)} --format json`,
          },
        },
        attention: Array.from({ length: 6 }, (_, index) => `degraded: ${index} ${boundedText}`),
        decision_attention: {
          type: "decision_review",
          count: 3,
          states: { open: 3 },
          entries: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].map((id, index) => ({
            id,
            artifact: "decisions",
            title: boundedText,
            state: "open",
            source: { path: `.agentera/entities/decisions/decision${index}.yaml` },
          })),
          max_entries: 3,
          bounded: false,
          attention: boundedText,
        },
        next_action: {
          recommended: {
            object: boundedText,
            capability: "build",
            reason: boundedText,
            phase: "build",
          },
          alternatives: Array.from({ length: 2 }, () => ({
            object: boundedText,
            capability: "discuss",
            reason: boundedText,
            phase: "deliberate",
          })),
        },
      };

      const statusContext = buildStatusContextState(state);
      const brief = statusContext.brief as Record<string, unknown>;

      expect(brief.status, JSON.stringify(brief)).toBe("ok");
      expect(brief.utf8_bytes).toEqual(expect.any(Number));
      expect(brief).not.toHaveProperty("error");
      for (const family of ["plan", "docs", "progress", "health", "todo", "decisions", "objective"]) {
        expect(STATE_FAMILY_FALLBACK_COMMANDS[family]).toMatch(/^agentera state .+ list --format json$/);
        expect(STATE_FAMILY_FALLBACK_COMMANDS[family]).not.toContain("--limit 20");
      }
      expect(brief.utf8_bytes as number).toBeGreaterThan(11_500);
      expect(brief.utf8_bytes as number).toBeLessThanOrEqual(PRIME_BRIEF_MAX_UTF8_BYTES);
      expect(statusContext.todo).toMatchObject({
        critical: 1,
        detail: { total: 33, returned: 20, omitted: 13 },
      });
      expect(statusContext.attention).toHaveLength(6);
      expect(statusContext.next_action).toMatchObject({ capability: "build", object: boundedText });
      expect((statusContext.source_contract as Record<string, unknown>).empty_state).toBe(
        "fresh: summaries absent; zero issues",
      );

      const capsule = buildStatusCapabilityContextPayload(state);
      let out = "";
      let err = "";
      const rc = emitPrime(
        "prime",
        capsule,
        "json",
        null,
        (text) => (out += text),
        (text) => (err += text),
        { maxUtf8Bytes: PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES },
      );
      expect(rc, err).toBe(0);
      const emitted = JSON.parse(out) as Record<string, any>;
      const emittedCapability = emitted.capability_context;
      const emittedState = emittedCapability.context.status_context;
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(
        PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES,
      );
      expect(emittedCapability.state).toEqual(
        expect.objectContaining({
          declared_read_needs: expect.any(Array),
          declared_write_targets: expect.any(Array),
          artifact_inventory: expect.any(Object),
          included: expect.any(Array),
          schema_error: null,
        }),
      );
      expect(emittedState.profile.validity).toEqual(state.profile_dict.validity);
      expect(emittedState.profile).not.toHaveProperty("path");
      expect(emittedCapability.context).toHaveProperty("first_invocation_read");
      expect(emittedCapability.context).toHaveProperty("schema_error", null);
      expect(emittedState.brief).toMatchObject({
        status: "degraded",
        error: { class: "brief_output_budget" },
      });
      expect(emittedState.todo).toMatchObject({
        critical: 1,
        detail: { total: 33, returned: 20, omitted: 13 },
      });
      expect(emittedState.todo.detail.retrieval.continue).toMatch(/^agentera state todo list/);
      expect(emittedState.attention).toHaveLength(6);
      expect(emittedState.next_action).toMatchObject({ capability: "build", object: boundedText });

      const boundaryState: OrientationState = {
        ...state,
        attention: state.attention.slice(0, 5),
        decision_attention: null,
        next_action: {
          ...state.next_action,
          alternatives: state.next_action.alternatives.slice(0, 1),
        },
      };
      const baseline = buildPrimeCapabilityContextPayload(boundaryState, "status") as Record<
        string,
        any
      >;
      baseline.capability_context.state.schema_error = "";
      baseline.capability_context.context.schema_error = "";
      const preparedBaseline = finalizeStatusCapabilityContextPayload(
        baseline,
        boundaryState,
      ) as Record<string, any>;
      const unboundedBaseline = structuredClone(preparedBaseline);
      unboundedBaseline.capability_context.context.status_context =
        buildStatusContextState(boundaryState);
      const baselineBytes = Buffer.byteLength(
        `${JSON.stringify(unboundedBaseline, null, 2)}\n`,
        "utf8",
      );
      const diagnosticBytes = PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES + 1 - baselineBytes;
      expect(diagnosticBytes).toBeGreaterThan(0);
      expect(diagnosticBytes).toBeLessThan(2_500);
      const stateDiagnosticBytes = Math.floor(diagnosticBytes / 2);
      const contextDiagnosticBytes = diagnosticBytes - stateDiagnosticBytes;
      expect(stateDiagnosticBytes).toBeGreaterThan(0);
      expect(contextDiagnosticBytes).toBeGreaterThan(0);

      const malformed = buildPrimeCapabilityContextPayload(boundaryState, "status") as Record<
        string,
        any
      >;
      malformed.capability_context.state.schema_error = "s".repeat(stateDiagnosticBytes);
      malformed.capability_context.context.schema_error = "c".repeat(contextDiagnosticBytes);
      const finalizedMalformed = finalizeStatusCapabilityContextPayload(
        malformed,
        boundaryState,
      ) as Record<string, any>;
      const unboundedMalformed = structuredClone(finalizedMalformed);
      unboundedMalformed.capability_context.context.status_context =
        buildStatusContextState(boundaryState);
      expect(Buffer.byteLength(`${JSON.stringify(unboundedMalformed, null, 2)}\n`, "utf8")).toBe(
        PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES + 1,
      );

      let malformedOut = "";
      let malformedErr = "";
      const malformedRc = emitPrime(
        "prime",
        finalizedMalformed,
        "json",
        null,
        (text) => (malformedOut += text),
        (text) => (malformedErr += text),
        { maxUtf8Bytes: PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES },
      );
      expect(malformedRc, malformedErr).toBe(0);
      expect(Buffer.byteLength(malformedOut, "utf8")).toBeLessThanOrEqual(
        PRIME_STATUS_CONTEXT_MAX_UTF8_BYTES,
      );
      const malformedEmitted = JSON.parse(malformedOut) as Record<string, any>;
      expect(malformedEmitted.capability_context.context.status_context.brief.status).toBe("degraded");
      expect(malformedEmitted.capability_context.state.schema_error).toBe(
        "s".repeat(stateDiagnosticBytes),
      );
      expect(malformedEmitted.capability_context.context.schema_error).toBe(
        "c".repeat(contextDiagnosticBytes),
      );
      expect(malformedEmitted.capability_context.context.status_context).toMatchObject({
        profile: { validity: boundaryState.profile_dict.validity },
        todo: { critical: 1, detail: { total: 33, returned: 20, omitted: 13 } },
        attention: expect.any(Array),
        next_action: { capability: "build" },
      });
      expect(malformedEmitted.capability_context.context.status_context.profile).not.toHaveProperty("path");
    });
  });
});
