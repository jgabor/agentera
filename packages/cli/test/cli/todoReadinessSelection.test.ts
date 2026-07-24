import { describe, expect, it } from "vitest";

import {
  evaluateTodoReadinessQueue,
  type TodoReadinessEntity,
} from "../../src/cli/todoReadinessSelection.js";

function readiness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: "build",
    reason: "The implementation boundary is settled.",
    dependencies: [],
    blocked: null,
    gate: null,
    queue_rank: 1,
    order_reason: "Highest-value ready work.",
    ...overrides,
  };
}

function todo(
  id: string,
  overrides: Record<string, unknown> = {},
): TodoReadinessEntity {
  return {
    id,
    artifact: "todo",
    record: {
      severity: "normal",
      status: "open",
      description: id,
      readiness: readiness(),
      ...overrides,
    },
  };
}

function outcome(items: TodoReadinessEntity[], id: string): string | undefined {
  return evaluateTodoReadinessQueue(items).evaluations.find((entry) => entry.id === id)?.result;
}

describe("TODO readiness selection", () => {
  it.each([
    ["todo_resolved", todo("aaaaaaaaaa", { status: "resolved" }), todo("aaaaaaaaaa"), "resolved", "actionable"],
    ["readiness_absent", todo("aaaaaaaaaa", { readiness: undefined }), todo("aaaaaaaaaa"), "needs-triage", "actionable"],
    ["blocked", todo("aaaaaaaaaa", { readiness: readiness({ blocked: { reason: "Vendor outage.", recovery: "Wait for vendor recovery." } }) }), todo("aaaaaaaaaa"), "blocked", "actionable"],
    ["gate_pending", todo("aaaaaaaaaa", { readiness: readiness({ gate: { state: "pending", reason: "Approval required.", recovery: "Obtain release approval." } }) }), todo("aaaaaaaaaa", { readiness: readiness({ gate: { state: "satisfied", reason: "Approved.", recovery: "Re-open approval if scope changes." } }) }), "gated", "actionable"],
    ["dependency_cross_artifact", todo("aaaaaaaaaa", { readiness: readiness({ dependencies: [{ artifact: "plan", id: "bbbbbbbbbb" }] }) }), todo("aaaaaaaaaa"), "needs-triage", "actionable"],
    ["dependency_missing", todo("aaaaaaaaaa", { readiness: readiness({ dependencies: [{ artifact: "todo", id: "bbbbbbbbbb" }] }) }), todo("aaaaaaaaaa"), "needs-triage", "actionable"],
  ])("handles %s before its adversarial non-match", (_name, positive, adversarial, expected, opposite) => {
    expect(outcome([positive], "aaaaaaaaaa")).toBe(expected);
    expect(outcome([adversarial], "aaaaaaaaaa")).toBe(opposite);
  });

  it("distinguishes cyclic, open, and resolved dependencies", () => {
    const dependent = todo("aaaaaaaaaa", {
      readiness: readiness({ dependencies: [{ artifact: "todo", id: "bbbbbbbbbb" }] }),
    });
    const open = todo("bbbbbbbbbb", {
      readiness: readiness({ queue_rank: 2, dependencies: [{ artifact: "todo", id: "aaaaaaaaaa" }] }),
    });
    expect(outcome([dependent, open], "aaaaaaaaaa")).toBe("needs-triage");

    open.record.readiness = readiness({ queue_rank: 2 });
    expect(outcome([dependent, open], "aaaaaaaaaa")).toBe("waiting");

    open.record.status = "resolved";
    expect(outcome([dependent, open], "aaaaaaaaaa")).toBe("actionable");
  });

  it("turns duplicate same-severity actionable ranks into ordering conflicts", () => {
    const duplicate = [todo("aaaaaaaaaa"), todo("bbbbbbbbbb")];
    const conflict = evaluateTodoReadinessQueue(duplicate);
    expect(conflict.selected).toBeNull();
    expect(conflict.evaluations).toEqual([
      expect.objectContaining({ outcome: "ordering_conflict", result: "needs-triage" }),
      expect.objectContaining({ outcome: "ordering_conflict", result: "needs-triage" }),
    ]);

    duplicate[1].record.readiness = readiness({ queue_rank: 2 });
    const ordered = evaluateTodoReadinessQueue(duplicate);
    expect(ordered.selected?.id).toBe("aaaaaaaaaa");
    expect(ordered.evaluations.map((entry) => entry.outcome)).toEqual(["actionable", "actionable"]);
  });

  it("uses severity then declared queue rank without IDs, prose, or input order as a tie-breaker", () => {
    const lowerRank = todo("zzzzzzzzzz", {
      description: "A".repeat(20_000),
      readiness: readiness({ capability: "discuss", reason: "Resolve the product decision.", queue_rank: 1 }),
    });
    const higherRank = todo("aaaaaaaaaa", { readiness: readiness({ queue_rank: 2 }) });
    const critical = todo("mmmmmmmmmm", { severity: "critical", readiness: readiness({ queue_rank: 9 }) });

    expect(evaluateTodoReadinessQueue([higherRank, lowerRank]).selected?.id).toBe("zzzzzzzzzz");
    expect(evaluateTodoReadinessQueue([lowerRank, higherRank]).selected?.id).toBe("zzzzzzzzzz");
    expect(evaluateTodoReadinessQueue([lowerRank, critical]).selected?.id).toBe("mmmmmmmmmm");
  });

  it("keeps actionable work selected while reporting bounded triage", () => {
    const result = evaluateTodoReadinessQueue([
      todo("aaaaaaaaaa", { readiness: undefined, severity: "critical" }),
      todo("bbbbbbbbbb", { readiness: readiness({ capability: "discuss", reason: "Choose the supported behavior." }) }),
    ]);

    expect(result.selected).toMatchObject({ id: "bbbbbbbbbb", capability: "discuss", phase: "deliberate" });
    expect(result.triage).toMatchObject({ count: 1, bounded: true });
  });

  it("abstains with contract-owned recovery when every item is non-actionable", () => {
    const result = evaluateTodoReadinessQueue([
      todo("aaaaaaaaaa", { readiness: undefined }),
      todo("bbbbbbbbbb", { readiness: readiness({ blocked: { reason: "Blocked.", recovery: "Remove the blocker." }, queue_rank: 2 }) }),
      todo("cccccccccc", { readiness: readiness({ gate: { state: "pending", reason: "Approval.", recovery: "Obtain approval." }, queue_rank: 3 }) }),
      todo("dddddddddd", { readiness: readiness({ dependencies: [{ artifact: "todo", id: "eeeeeeeeee" }], queue_rank: 4 }) }),
      todo("eeeeeeeeee", { readiness: readiness({ blocked: { reason: "Blocked prerequisite.", recovery: "Resolve the prerequisite blocker." }, queue_rank: 5 }) }),
    ]);

    expect(result.selected).toBeNull();
    expect(result.abstainRecovery).toBe(
      "Review the item and declare readiness through the typed TODO writer.",
    );
  });

  it("surfaces declared blocker and gate recovery without recommending implementation", () => {
    const blocked = evaluateTodoReadinessQueue([
      todo("aaaaaaaaaa", { readiness: readiness({ blocked: { reason: "Blocked.", recovery: "Remove the blocker." } }) }),
    ]);
    const gated = evaluateTodoReadinessQueue([
      todo("bbbbbbbbbb", { readiness: readiness({ gate: { state: "pending", reason: "Approval.", recovery: "Obtain approval." } }) }),
    ]);

    expect(blocked).toMatchObject({ selected: null, abstainRecovery: "Remove the blocker." });
    expect(gated).toMatchObject({ selected: null, abstainRecovery: "Obtain approval." });
  });
});
