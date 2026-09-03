import type { JsonObject } from "../core/jsonValue.js";

const indexes = new WeakMap<object, JsonObject[]>();

/** Retain the complete canonical task graph for in-process capability projections. */
export function rememberPlanTaskIndex(plan: JsonObject, tasks: JsonObject[]): void {
  indexes.set(plan, tasks);
}

/** Public plan projections remain bounded; orchestration reads this exact internal graph. */
export function planTaskIndex(plan: JsonObject): JsonObject[] {
  return indexes.get(plan) ?? (Array.isArray(plan.tasks) ? plan.tasks.filter((task): task is JsonObject => Boolean(task) && typeof task === "object" && !Array.isArray(task)) : []);
}
