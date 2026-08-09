import type { DiscoveredEntity, EntityDiagnostic } from "./entityStorage.js";

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function planStatus(plan: DiscoveredEntity): unknown {
  const header = plan.record?.header;
  return mapping(header) ? header.status : undefined;
}

export function planLineageIssues(
  plans: DiscoveredEntity[],
  recovery: (action: string) => string,
): EntityDiagnostic[] {
  const plansById = new Map(plans.map((plan) => [plan.id!, plan]));
  const successorsByPredecessor = new Map<string, DiscoveredEntity[]>();
  const issues: EntityDiagnostic[] = [];

  for (const successor of plans) {
    const predecessorId = successor.record?.previous_plan_archived;
    if (typeof predecessorId !== "string") continue;
    const predecessor = plansById.get(predecessorId);
    if (predecessorId === successor.id || (predecessor && planStatus(predecessor) !== "archived")) {
      issues.push({
        code: "unresolved_relation",
        path: successor.relativePath,
        id: successor.id!,
        artifact: successor.artifact ?? undefined,
        boundary: successor.boundary ?? undefined,
        relation: "previous_plan_archived",
        targetId: predecessorId,
        message: predecessorId === successor.id
          ? `plan '${successor.id}' cannot name itself as its archived predecessor`
          : `plan '${successor.id}' predecessor '${predecessorId}' must be archived`,
        recovery: recovery(`set record.previous_plan_archived in '${successor.relativePath}' to one distinct archived plan ID, or remove the writer-owned field from invalid state`),
      });
    }
    successorsByPredecessor.set(predecessorId, [...(successorsByPredecessor.get(predecessorId) ?? []), successor]);
  }

  for (const [predecessorId, successors] of successorsByPredecessor) {
    if (successors.length < 2) continue;
    for (const successor of successors) {
      issues.push({
        code: "conflicting_ownership",
        path: successor.relativePath,
        id: successor.id!,
        artifact: successor.artifact ?? undefined,
        boundary: successor.boundary ?? undefined,
        relation: "previous_plan_archived",
        targetId: predecessorId,
        message: `archived predecessor '${predecessorId}' has multiple successor plan records: ${successors.map((candidate) => candidate.id!).sort().join(", ")}`,
        recovery: recovery(`retain record.previous_plan_archived on only one canonical successor of archived plan '${predecessorId}'`),
      });
    }
  }
  return issues;
}
