import type { JsonObject } from "../../core/jsonValue.js";
import type { SchemaInfo } from "../appContext.js";
import { orchestrationContext } from "./orchestration.js";
import { documentCloseoutContext } from "./closeout.js";
import { auditEvidenceContext } from "./evidence.js";
import { optimizeBenchmarkContext } from "./benchmark.js";
import { buildExecutionContext } from "./build.js";
import { slimOrchestrationContext, slimEvidenceContext, slimCloseoutContext, slimBenchmarkContext } from "./slim.js";
import type { BuildExecutionRequest } from "../commands/prime/buildExecutionRequest.js";

export function slimBespokeContext(name: string, value: JsonObject): JsonObject {
  if (name === "orchestration_context") return slimOrchestrationContext(value);
  if (name === "evidence_context") return slimEvidenceContext(value);
  if (name === "closeout_context") return slimCloseoutContext(value);
  if (name === "benchmark_context") return slimBenchmarkContext(value);
  return value;
}

export function bespokeCapabilityContexts(
  capabilityName: string | null,
  state: JsonObject,
  buildRequest: BuildExecutionRequest | null = null,
): JsonObject {
  // cast: orientation state fields are assembled from parsed .agentera artifacts;
  // bespoke builders consume JsonObject/typed shapes for these state families.
  const plan = state.plan as JsonObject;
  const progress = state.progress as JsonObject;
  const health = state.health as JsonObject;
  const docs = state.docs as JsonObject;
  const profile = state.profile_dict as JsonObject;
  const nextAction = (state.next_action as { recommended: JsonObject }).recommended;
  const bundle = state.app as JsonObject;
  const todoItems = state.todo_items as unknown as JsonObject[];
  const schemas = state.schemas as unknown as Record<string, SchemaInfo>;
  const projectRoot = String(state.project_root);
  const history = state.history && typeof state.history === "object" && !Array.isArray(state.history)
    ? state.history as JsonObject
    : {};
  const decisionHistory = history.decisions && typeof history.decisions === "object" && !Array.isArray(history.decisions)
    ? history.decisions as JsonObject
    : {};
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
      decisionHistory,
      projectRoot,
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
      decisionHistory,
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
      projectRoot,
      buildRequest,
    ),
  };
}
