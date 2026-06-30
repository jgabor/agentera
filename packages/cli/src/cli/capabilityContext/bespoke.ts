import type { JsonObject } from "../../core/jsonValue.js";
import type { SchemaInfo } from "../appContext.js";
import { orchestrationContext } from "./orchestration.js";
import { documentCloseoutContext } from "./closeout.js";
import { auditEvidenceContext } from "./evidence.js";
import { optimizeBenchmarkContext } from "./benchmark.js";
import { buildExecutionContext } from "./build.js";
import { slimOrchestrationContext, slimEvidenceContext, slimCloseoutContext } from "./slim.js";

export function slimBespokeContext(name: string, value: JsonObject): JsonObject {
  if (name === "orchestration_context") return slimOrchestrationContext(value);
  if (name === "evidence_context") return slimEvidenceContext(value);
  if (name === "closeout_context") return slimCloseoutContext(value);
  return value;
}

export function bespokeCapabilityContexts(capabilityName: string | null, state: JsonObject): JsonObject {
  // cast: orientation state fields are assembled from parsed .agentera artifacts;
  // bespoke builders consume JsonObject/typed shapes for these state families.
  const plan = state.plan as JsonObject;
  const progress = state.progress as JsonObject;
  const health = state.health as JsonObject;
  const docs = state.docs as JsonObject;
  const profile = state.profile_dict as JsonObject;
  const nextAction = (state.next_action as { recommended: JsonObject }).recommended;
  const bundle = state.app as JsonObject;
  const todoItems = state.todo_items as unknown as Array<Record<string, string>>;
  const schemas = state.schemas as unknown as Record<string, SchemaInfo>;
  return {
    orchestration_context: orchestrationContext(
      capabilityName,
      plan,
      progress,
      health,
      todoItems,
      docs,
      profile,
      nextAction,
    ),
    closeout_context: documentCloseoutContext(
      capabilityName,
      schemas,
      plan,
      progress,
      todoItems,
      docs,
      profile,
      bundle,
    ),
    evidence_context: auditEvidenceContext(
      capabilityName,
      schemas,
      plan,
      progress,
      health,
      todoItems,
      docs,
      profile,
      bundle,
    ),
    benchmark_context: optimizeBenchmarkContext(capabilityName),
    execution_context: buildExecutionContext(
      capabilityName,
      schemas,
      plan,
      progress,
      health,
      todoItems,
      docs,
      profile,
      bundle,
    ),
  };
}
