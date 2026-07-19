import path from "node:path";
import os from "node:os";

import { describe, expect, it } from "vitest";

import statusInstructions from "../../src/capabilities/status/instructions.js";
import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { buildOrientationJsonPayload } from "../../src/cli/commands/prime/orientationOutput.js";
import type { OrientationState } from "../../src/cli/contracts/orientationState.js";
import { evaluateFixture } from "../../src/eval/semanticEval.js";
import { loadFixture } from "../../src/eval/semanticFixtures.js";

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
  const suggestion = Number(/≤(\d+) words per routing suggestion/.exec(statusInstructions)?.[1] ?? 0);
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
    expect(wordCount(`suggested → ${String((payload.next_action as Record<string, string>).capability)} ` +
      `(${String((payload.next_action as Record<string, string>).object)})`)).toBeLessThanOrEqual(budget.suggestion);

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
});
