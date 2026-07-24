import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  loadTodoReadinessContract,
  todoReadinessRecordViolations,
  todoReadinessReferenceViolations,
  validateTodoReadinessContract,
} from "../../src/registries/todoReadinessContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const TODO_PATH = path.join(REPO_ROOT, "skills/agentera/schemas/artifacts/todo.yaml");
const PROTOCOL_PATH = path.join(REPO_ROOT, "skills/agentera/protocol.yaml");
const CAPABILITY_CONTRACT_PATH = path.join(REPO_ROOT, "skills/agentera/capability_schema_contract.yaml");

function loadYaml(filePath: string): any {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

function validDocuments(): { todo: any; protocol: any; capabilities: any } {
  return {
    todo: loadYaml(TODO_PATH),
    protocol: loadYaml(PROTOCOL_PATH),
    capabilities: loadYaml(CAPABILITY_CONTRACT_PATH),
  };
}

const EXPECTED_OUTCOMES: Record<string, { result: string; eligible: boolean | null; recovery: "null" | "required" }> = {
  todo_resolved: { result: "resolved", eligible: false, recovery: "null" },
  readiness_absent: { result: "needs-triage", eligible: false, recovery: "required" },
  blocked: { result: "blocked", eligible: false, recovery: "required" },
  gate_pending: { result: "gated", eligible: false, recovery: "required" },
  dependency_cross_artifact: { result: "needs-triage", eligible: false, recovery: "required" },
  dependency_missing: { result: "needs-triage", eligible: false, recovery: "required" },
  dependency_cycle: { result: "needs-triage", eligible: false, recovery: "required" },
  dependency_open: { result: "waiting", eligible: false, recovery: "required" },
  dependency_resolved: { result: "satisfied", eligible: null, recovery: "null" },
  ordering_conflict: { result: "needs-triage", eligible: false, recovery: "required" },
  actionable: { result: "actionable", eligible: true, recovery: "null" },
};

type FailingRule = [string, (documents: ReturnType<typeof validDocuments>) => void, string];

describe("TODO readiness contract", () => {
  it("derives the exact destination and phase model from one valid authority", () => {
    const model = loadTodoReadinessContract(TODO_PATH, PROTOCOL_PATH, CAPABILITY_CONTRACT_PATH);

    expect(model.schemaVersion).toBe("agentera.todoReadiness.v1");
    expect(model.allowedDestinations).toEqual([
      "vision",
      "discuss",
      "research",
      "plan",
      "build",
      "optimize",
      "document",
      "profile",
      "design",
      "audit",
    ]);
    expect(Object.fromEntries(model.phaseByCapability)).toEqual({
      vision: "envision",
      discuss: "deliberate",
      research: "deliberate",
      plan: "plan",
      build: "build",
      optimize: "build",
      document: "build",
      profile: "build",
      design: "build",
      audit: "audit",
    });
    expect(model.excludedCapabilities).toEqual({
      status: expect.stringMatching(/Orientation/),
      orchestrate: expect.stringMatching(/Execution mode/),
    });
    expect(model.fields).toHaveProperty("capability.enum_source", "protocol.yaml#PHASES[*].capabilities");
    expect(model.fields).toHaveProperty("reason.non_empty", true);
    expect(model.fields).toHaveProperty("dependencies.entries.artifact.const", "todo");
    expect(model.fields).toHaveProperty("gate.fields.state.enum", ["pending", "satisfied"]);
    expect(model.outcomes.readiness_absent).toMatchObject({ result: "needs-triage", eligible: false, attention: "item" });
    expect(model.outcomes.blocked).toMatchObject({ result: "blocked", eligible: false, attention: "item" });
    expect(model.outcomes.gate_pending).toMatchObject({ result: "gated", eligible: false, attention: "none" });
    expect(model.outcomes.dependency_missing).toMatchObject({ result: "needs-triage", eligible: false, attention: "item" });
    expect(model.outcomes.dependency_cycle).toMatchObject({ result: "needs-triage", eligible: false, attention: "item" });
    expect(model.outcomes.dependency_resolved).toEqual({ result: "satisfied", eligible: null, attention: "none", recovery: null });
    expect(model.outcomes.dependency_cross_artifact).toMatchObject({ result: "needs-triage", eligible: false, attention: "item" });
    expect(model.queueOutcomes).toMatchObject({
      mixed_actionable_and_triage: { selection: "highest_ordered_actionable", attention: "bounded_triage_summary" },
      all_non_actionable: { selection: "abstain", attention: "bounded_highest_severity_summary" },
    });
    expect(model.ordering).toMatchObject({
      primary: "protocol.yaml#SEVERITY_ISSUE",
      within_severity: "queue_rank_ascending",
      duplicate_rank: "ordering_conflict",
    });
    expect(model.ordering.prohibited_tiebreakers).toEqual([
      "entity_id",
      "file_order",
      "filesystem_time",
      "created_or_modified_time",
      "description_text",
    ]);
  });

  it("passes criterion 5 with every exact outcome and deterministic intent-ordering rule", () => {
    const documents = validDocuments();
    expect(validateTodoReadinessContract(
      documents.todo,
      documents.protocol,
      documents.capabilities,
      "fixture",
    )).toEqual([]);

    for (const [name, expected] of Object.entries(EXPECTED_OUTCOMES)) {
      expect(documents.todo.READINESS.outcomes[name]).toMatchObject({
        result: expected.result,
        eligible: expected.eligible,
        recovery: expected.recovery === "null" ? null : expect.stringMatching(/\S/),
      });
    }
    expect(documents.todo.READINESS.queue_outcomes).toMatchObject({
      mixed_actionable_and_triage: { recovery: expect.stringMatching(/\S/) },
      all_non_actionable: { recovery: expect.stringMatching(/\S/) },
    });
    expect(documents.todo.READINESS.ordering).toMatchObject({
      primary: "protocol.yaml#SEVERITY_ISSUE",
      within_severity: "queue_rank_ascending",
      duplicate_rank: "ordering_conflict",
    });
  });

  const outcomeRules: FailingRule[] = Object.entries(EXPECTED_OUTCOMES).flatMap(([name, expected]) => [
    [
      `${name} has its exact result`,
      ({ todo }) => { todo.READINESS.outcomes[name].result = "wrong"; },
      `READINESS.outcomes.${name}.result must be ${expected.result}`,
    ],
    [
      `${name} has its exact eligibility`,
      ({ todo }) => { todo.READINESS.outcomes[name].eligible = expected.eligible === true ? false : true; },
      `READINESS.outcomes.${name}.eligible must be ${String(expected.eligible)}`,
    ],
    [
      `${name} has its exact recovery shape`,
      ({ todo }) => { todo.READINESS.outcomes[name].recovery = expected.recovery === "null" ? "unexpected" : ""; },
      `READINESS.outcomes.${name}.recovery must be ${expected.recovery === "null" ? "null" : "a non-empty string"}`,
    ],
  ] as FailingRule[]);

  const failingRules: FailingRule[] = [
    ["readiness authority is required", ({ todo }) => { delete todo.READINESS; }, "READINESS must be a mapping"],
    ["schema version is fixed", ({ todo }) => { todo.READINESS.schema_version = "other"; }, "schema_version must be agentera.todoReadiness.v1"],
    ["phase mapping has one source", ({ todo }) => { todo.READINESS.destination.phase_authority = "local"; }, "phase_authority must be protocol.yaml#PHASES[*].capabilities"],
    ["destination values are not duplicated", ({ todo }) => { todo.READINESS.destination.allowed_destinations = ["build"]; }, "allowed_destinations duplicates the canonical PHASES authority"],
    ["phase capabilities are unique", ({ protocol }) => { protocol.PHASES[3].capabilities.push("research"); }, "capability 'research' appears in multiple PHASES entries"],
    ["phase capabilities are canonical", ({ protocol }) => { protocol.PHASES[3].capabilities.push("ghost"); }, "PHASES capability 'ghost' is not canonical"],
    ["every canonical capability is mapped or excluded", ({ todo }) => { delete todo.READINESS.destination.excluded_capabilities.status; }, "canonical capability 'status' must be mapped to one phase or explicitly excluded"],
    ["exclusions carry a reason", ({ todo }) => { todo.READINESS.destination.excluded_capabilities.status = ""; }, "excluded capability 'status' must have a non-empty reason"],
    ["readiness fields are complete", ({ todo }) => { delete todo.READINESS.fields.reason; }, "READINESS.fields.reason must be a mapping"],
    ["readiness fields are required when readiness exists", ({ todo }) => { todo.READINESS.fields.queue_rank.required = false; }, "READINESS.fields.queue_rank.required must be true"],
    ["capability values use the phase authority", ({ todo }) => { todo.READINESS.fields.capability.enum_source = "local"; }, "READINESS.fields.capability.enum_source must be protocol.yaml#PHASES[*].capabilities"],
    ["dependencies remain TODO-local", ({ todo }) => { todo.READINESS.fields.dependencies.entries.artifact.const = "plan"; }, "dependency artifact const must be todo"],
    ["evaluation precedence is exact", ({ todo }) => { todo.READINESS.evaluation.precedence.pop(); }, "READINESS.evaluation.precedence must equal"],
    ["all bounded outcomes exist", ({ todo }) => { delete todo.READINESS.outcomes.dependency_cycle; }, "READINESS.outcomes.dependency_cycle must be a mapping"],
    ["outcomes use bounded attention values", ({ todo }) => { todo.READINESS.outcomes.blocked.attention = "verbose"; }, "READINESS.outcomes.blocked.attention must be one of: none, item"],
    ...outcomeRules,
    ["queue outcomes are complete", ({ todo }) => { delete todo.READINESS.queue_outcomes.all_non_actionable; }, "READINESS.queue_outcomes.all_non_actionable must be a mapping"],
    ["mixed queue recovery is bounded", ({ todo }) => { todo.READINESS.queue_outcomes.mixed_actionable_and_triage.recovery = ""; }, "READINESS.queue_outcomes.mixed_actionable_and_triage.recovery must be a non-empty string"],
    ["all-non-actionable queue recovery is bounded", ({ todo }) => { todo.READINESS.queue_outcomes.all_non_actionable.recovery = ""; }, "READINESS.queue_outcomes.all_non_actionable.recovery must be a non-empty string"],
    ["canonical severity owns primary ordering", ({ todo }) => { todo.READINESS.ordering.primary = "queue_rank"; }, "READINESS.ordering.primary must be protocol.yaml#SEVERITY_ISSUE"],
    ["severity and intent own ordering", ({ todo }) => { todo.READINESS.ordering.within_severity = "entity_id"; }, "READINESS.ordering.within_severity must be queue_rank_ascending"],
    ["duplicate ranks require triage", ({ todo }) => { todo.READINESS.ordering.duplicate_rank = "entity_id"; }, "READINESS.ordering.duplicate_rank must be ordering_conflict"],
    ["fabricated chronology is prohibited", ({ todo }) => { todo.READINESS.ordering.prohibited_tiebreakers.pop(); }, "READINESS.ordering.prohibited_tiebreakers must equal"],
  ];

  it.each(failingRules)("rejects invalid contract: %s", (_name, mutate, expected) => {
    const documents = validDocuments();
    mutate(documents);

    expect(validateTodoReadinessContract(
      documents.todo,
      documents.protocol,
      documents.capabilities,
      "fixture",
    )).toContainEqual(expect.stringContaining(expected));
  });

  it("validates each persisted readiness field rule at the contract authority", () => {
    const contract = loadTodoReadinessContract(TODO_PATH, PROTOCOL_PATH, CAPABILITY_CONTRACT_PATH);
    const valid = {
      capability: "build",
      reason: "The implementation boundary is ready.",
      dependencies: [{ artifact: "todo", id: "bbbbbbbbbb" }],
      blocked: { reason: "Waiting for input.", recovery: "Provide the input." },
      gate: { state: "pending", reason: "Approval required.", recovery: "Approve the change." },
      queue_rank: 1,
      order_reason: "Highest-value ready implementation work.",
    };
    expect(todoReadinessRecordViolations(valid, contract)).toEqual([]);
    expect(todoReadinessRecordViolations({ ...valid, blocked: null, gate: null }, contract)).toEqual([]);

    const cases: Array<[string, unknown, string]> = [
      ["mapping", null, "readiness must be a mapping"],
      ["exact fields", { ...valid, extra: true }, "unsupported field 'extra'"],
      ["complete fields", (() => { const value: any = structuredClone(valid); delete value.reason; return value; })(), "reason is required"],
      ["capability", { ...valid, capability: "status" }, "capability must be one of"],
      ["reason", { ...valid, reason: "" }, "reason must be a non-empty string"],
      ["dependencies list", { ...valid, dependencies: {} }, "dependencies must be a list"],
      ["dependency mapping", { ...valid, dependencies: ["bbbbbbbbbb"] }, "dependencies[0] must be a mapping"],
      ["dependency exact fields", { ...valid, dependencies: [{ artifact: "todo", id: "bbbbbbbbbb", extra: true }] }, "dependencies[0] has unsupported field 'extra'"],
      ["dependency shape", { ...valid, dependencies: [{ artifact: "plan", id: "bbbbbbbbbb" }] }, "dependency artifact must be 'todo'"],
      ["dependency identity", { ...valid, dependencies: [{ artifact: "todo", id: "plan:bbbbbbbbbb" }] }, "dependency ID must be ten lowercase letters"],
      ["blocked mapping", { ...valid, blocked: "blocked" }, "blocked must be a mapping or null"],
      ["blocked required fields", { ...valid, blocked: { reason: "Why" } }, "blocked.recovery is required"],
      ["blocked reason", { ...valid, blocked: { reason: "", recovery: "Fix it." } }, "blocked.reason must be a non-empty string"],
      ["blocked recovery", { ...valid, blocked: { reason: "Why", recovery: "" } }, "blocked.recovery must be a non-empty string"],
      ["blocked exact fields", { ...valid, blocked: { reason: "Why", recovery: "Fix", extra: true } }, "blocked has unsupported field 'extra'"],
      ["gate mapping", { ...valid, gate: "pending" }, "gate must be a mapping or null"],
      ["gate required fields", { ...valid, gate: { state: "pending", reason: "Why" } }, "gate.recovery is required"],
      ["gate state", { ...valid, gate: { state: "invented", reason: "Why", recovery: "Fix" } }, "gate.state must be one of"],
      ["gate reason", { ...valid, gate: { state: "pending", reason: "", recovery: "Fix" } }, "gate.reason must be a non-empty string"],
      ["gate recovery", { ...valid, gate: { state: "pending", reason: "Why", recovery: "" } }, "gate.recovery must be a non-empty string"],
      ["gate exact fields", { ...valid, gate: { state: "pending", reason: "Why", recovery: "Fix", extra: true } }, "gate has unsupported field 'extra'"],
      ["queue rank integer", { ...valid, queue_rank: 1.5 }, "queue_rank must be an integer greater than or equal to 1"],
      ["queue rank minimum", { ...valid, queue_rank: 0 }, "queue_rank must be an integer greater than or equal to 1"],
      ["order reason", { ...valid, order_reason: "" }, "order_reason must be a non-empty string"],
    ];
    for (const [name, value, expected] of cases) {
      expect(todoReadinessRecordViolations(value, contract), name).toContainEqual(expect.stringContaining(expected));
    }
  });

  it("validates dependency existence and cycles against complete current TODO state", () => {
    const readiness = {
      capability: "build",
      reason: "Ready after the prerequisite.",
      dependencies: [{ artifact: "todo", id: "bbbbbbbbbb" }],
      blocked: null,
      gate: null,
      queue_rank: 1,
      order_reason: "Dependency-aware order.",
    };
    const records = [
      { id: "aaaaaaaaaa", record: { severity: "normal", status: "open", description: "A", readiness } },
      { id: "bbbbbbbbbb", record: { severity: "normal", status: "open", description: "B" } },
    ];
    expect(todoReadinessReferenceViolations("aaaaaaaaaa", readiness, records)).toEqual([]);
    expect(todoReadinessReferenceViolations("aaaaaaaaaa", { ...readiness, dependencies: [{ artifact: "todo", id: "cccccccccc" }] }, records)).toContainEqual(expect.stringContaining("does not exist"));
    expect(todoReadinessReferenceViolations("aaaaaaaaaa", { ...readiness, dependencies: [{ artifact: "todo", id: "aaaaaaaaaa" }] }, records)).toContainEqual(expect.stringContaining("cannot depend on itself"));
    const cycle = structuredClone(records);
    cycle[1].record.readiness = { ...readiness, dependencies: [{ artifact: "todo", id: "aaaaaaaaaa" }] };
    expect(todoReadinessReferenceViolations("aaaaaaaaaa", readiness, cycle)).toContainEqual(expect.stringContaining("dependency cycle"));
  });
});
