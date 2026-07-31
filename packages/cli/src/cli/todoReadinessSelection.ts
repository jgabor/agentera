import path from "node:path";

import { loadTodoReadinessContract } from "../registries/todoReadinessContract.js";
import { TODO_SEVERITY_ORDER } from "./todoSeverity.js";
import { renderTodoPublicRecord } from "./todoMarkdown.js";

export interface TodoReadinessEntity {
  id: string;
  artifact: string;
  record: Record<string, unknown>;
}

export interface TodoReadinessEvaluation {
  id: string;
  artifact: string;
  severity: string;
  description: string;
  outcome: string;
  result: string;
  eligible: boolean;
  attention: string;
  recovery: string | null;
  retrieval: { exact: string };
  capability?: string;
  phase?: string;
  reason?: string;
  queueRank?: number;
}

export interface TodoReadinessQueueSelection {
  selected: TodoReadinessEvaluation | null;
  evaluations: TodoReadinessEvaluation[];
  triage: { count: number; bounded: true; recovery: string | null };
  abstainRecovery: string | null;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function dependencies(readiness: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(readiness.dependencies)
    ? readiness.dependencies.filter(mapping)
    : [];
}

function hasDependencyCycle(
  itemId: string,
  byId: Map<string, TodoReadinessEntity>,
): boolean {
  const visit = (id: string, visiting: Set<string>, visited: Set<string>): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    const entity = byId.get(id);
    const readiness = mapping(entity?.record.readiness) ? entity.record.readiness : null;
    if (!readiness) return false;
    visiting.add(id);
    for (const dependency of dependencies(readiness)) {
      if (dependency.artifact === "todo" && typeof dependency.id === "string") {
        if (visit(dependency.id, visiting, visited)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return visit(itemId, new Set(), new Set());
}

export function evaluateTodoReadinessQueue(
  entities: TodoReadinessEntity[],
  sourceRoot?: string,
): TodoReadinessQueueSelection {
  if (entities.length === 0) {
    return {
      selected: null,
      evaluations: [],
      triage: { count: 0, bounded: true, recovery: null },
      abstainRecovery: null,
    };
  }
  const contract = sourceRoot
    ? loadTodoReadinessContract(
      path.join(sourceRoot, "skills/agentera/schemas/artifacts/todo.yaml"),
      path.join(sourceRoot, "skills/agentera/protocol.yaml"),
      path.join(sourceRoot, "skills/agentera/capability_schema_contract.yaml"),
    )
    : loadTodoReadinessContract();
  const byId = new Map(entities.map((entity) => [entity.id, entity]));

  const evaluate = (entity: TodoReadinessEntity): TodoReadinessEvaluation => {
    const { record } = entity;
    const readiness = mapping(record.readiness) ? record.readiness : null;
    const dependencyList = readiness ? dependencies(readiness) : [];
    let outcome = "actionable";
    let declaredRecovery: string | null = null;

    if (record.status === "resolved") outcome = "todo_resolved";
    else if (!readiness) outcome = "readiness_absent";
    else if (readiness.blocked !== null) {
      outcome = "blocked";
      declaredRecovery = mapping(readiness.blocked) && typeof readiness.blocked.recovery === "string"
        ? readiness.blocked.recovery
        : null;
    } else if (mapping(readiness.gate) && readiness.gate.state === "pending") {
      outcome = "gate_pending";
      declaredRecovery = typeof readiness.gate.recovery === "string" ? readiness.gate.recovery : null;
    } else if (dependencyList.some((dependency) => dependency.artifact !== "todo")) {
      outcome = "dependency_cross_artifact";
    } else if (dependencyList.some((dependency) => typeof dependency.id !== "string" || !byId.has(dependency.id))) {
      outcome = "dependency_missing";
    } else if (hasDependencyCycle(entity.id, byId)) {
      outcome = "dependency_cycle";
    } else if (dependencyList.some((dependency) => byId.get(String(dependency.id))?.record.status !== "resolved")) {
      outcome = "dependency_open";
    }

    const authority = contract.outcomes[outcome];
    const capability = readiness && typeof readiness.capability === "string" ? readiness.capability : undefined;
    const queueRank = readiness && Number.isInteger(readiness.queue_rank) ? Number(readiness.queue_rank) : undefined;
    return {
      id: entity.id,
      artifact: entity.artifact,
      severity: String(record.severity ?? "normal"),
       description: renderTodoPublicRecord(record),
      outcome,
      result: String(authority.result),
      eligible: authority.eligible === true,
      attention: String(authority.attention),
      recovery: declaredRecovery ?? (typeof authority.recovery === "string" ? authority.recovery : null),
      retrieval: { exact: `agentera state todo get --id ${entity.id} --format json` },
      ...(capability ? {
        capability,
        phase: contract.phaseByCapability.get(capability),
        reason: typeof readiness?.reason === "string" ? readiness.reason : "",
      } : {}),
      ...(queueRank === undefined ? {} : { queueRank }),
    };
  };

  const evaluations = entities.map(evaluate);
  const actionable = evaluations.filter((entry) => entry.eligible);
  const ranks = new Map<string, TodoReadinessEvaluation[]>();
  for (const entry of actionable) {
    const key = `${entry.severity}\0${String(entry.queueRank)}`;
    ranks.set(key, [...(ranks.get(key) ?? []), entry]);
  }
  for (const conflicts of ranks.values()) {
    if (conflicts.length < 2) continue;
    const authority = contract.outcomes.ordering_conflict;
    for (const entry of conflicts) {
      entry.outcome = "ordering_conflict";
      entry.result = String(authority.result);
      entry.eligible = false;
      entry.attention = String(authority.attention);
      entry.recovery = typeof authority.recovery === "string" ? authority.recovery : null;
    }
  }

  const selected = evaluations
    .filter((entry) => entry.eligible)
    .sort((left, right) =>
      (TODO_SEVERITY_ORDER[left.severity] ?? TODO_SEVERITY_ORDER.normal)
      - (TODO_SEVERITY_ORDER[right.severity] ?? TODO_SEVERITY_ORDER.normal)
      || (left.queueRank ?? Number.MAX_SAFE_INTEGER) - (right.queueRank ?? Number.MAX_SAFE_INTEGER),
    )[0] ?? null;
  const triageCount = evaluations.filter((entry) => entry.attention === "item").length;
  const mixedRecovery = contract.queueOutcomes.mixed_actionable_and_triage?.recovery;
  const queueRecovery = contract.queueOutcomes.all_non_actionable?.recovery;
  const nonActionable = evaluations
    .filter((entry) => !entry.eligible && entry.result !== "resolved")
    .sort((left, right) =>
      (TODO_SEVERITY_ORDER[left.severity] ?? TODO_SEVERITY_ORDER.normal)
      - (TODO_SEVERITY_ORDER[right.severity] ?? TODO_SEVERITY_ORDER.normal)
      || contract.precedence.indexOf(left.outcome) - contract.precedence.indexOf(right.outcome)
      || (left.queueRank ?? Number.MAX_SAFE_INTEGER) - (right.queueRank ?? Number.MAX_SAFE_INTEGER),
    );
  const recoveryCandidate = nonActionable[0];
  const equallyRankedRecoveries = recoveryCandidate
    ? new Set(nonActionable
      .filter((entry) =>
        entry.severity === recoveryCandidate.severity
        && entry.outcome === recoveryCandidate.outcome
        && entry.queueRank === recoveryCandidate.queueRank,
      )
      .map((entry) => entry.recovery))
    : new Set<string | null>();
  const abstainRecovery = equallyRankedRecoveries.size === 1
    ? recoveryCandidate?.recovery ?? null
    : typeof queueRecovery === "string" ? queueRecovery : null;
  return {
    selected,
    evaluations,
    triage: {
      count: triageCount,
      bounded: true,
      recovery: triageCount > 0 && typeof mixedRecovery === "string" ? mixedRecovery : null,
    },
    abstainRecovery: !selected ? abstainRecovery : null,
  };
}
