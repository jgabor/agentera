import path from "node:path";
import os from "node:os";

import { describe, expect, it } from "vitest";

import statusInstructions from "../../src/capabilities/status/instructions.js";
import { collectOrientationState } from "../../src/cli/commands/prime.js";
import { buildOrientationJsonPayload } from "../../src/cli/commands/prime/orientationOutput.js";
import { buildOrientationAttention } from "../../src/cli/orientation/attention.js";
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
  const objective = payload.objective as Record<string, unknown>;
  const next = payload.next_action as Record<string, string>;
  const attention = payload.attention as string[];

  return [
    `⛶ health ${health.grade ?? "unknown"} (${String(health.worst ?? "none")})`,
    `⇶ todo ${todo.critical} critical · ${todo.degraded} degraded · ${todo.annoying} annoying`,
    `≡ plan ${plan.complete ?? 0}/${plan.total ?? 0} tasks`,
    `♾ profile ${profile.status ?? "unknown"}`,
    `⎘ objective ${objective.active ? String(objective.name ?? "active") : "none active"}`,
    "Lifecycle repair needs preview plus host verification before safety work.",
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
    const snapshot = structuredClone(baseState.runtime_lifecycle_snapshot);
    expect(snapshot).toBeTruthy();
    const manualActions = snapshot?.actions.filter(
      (action) => action.actionClass === "manual_verification" && action.manual !== null,
    ) ?? [];
    expect(manualActions.length).toBeGreaterThan(0);
    for (const action of manualActions) {
      action.manual!.instruction = Array.from({ length: 200 }, (_, index) => `host-instruction-${index}`).join(" ");
    }

    const state: OrientationState = {
      ...baseState,
      runtime_lifecycle_snapshot: snapshot,
      project_integration: {
        ...baseState.project_integration,
        phases: {
          ...baseState.project_integration.phases,
          app: { status: "stay", counts: { total: 0, pending: 0, blocked: 0 }, blockers: [] },
        },
      },
    };
    const lifecycleRows = buildOrientationAttention(state).filter((item) => item.includes("lifecycle action_class="));
    expect(lifecycleRows).toHaveLength(1);

    const payload = buildOrientationJsonPayload(
      {
        ...state,
        attention: [
          ...lifecycleRows,
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
    expect(rendered).toContain("/skills list");
    expect(rendered).toContain("agentera doctor --format json");
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
