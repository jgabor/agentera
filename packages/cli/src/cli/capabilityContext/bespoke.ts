import type { Dict } from "./types.js";
import { orchestrationContext } from "./orchestration.js";
import { dokumenteraCloseoutContext } from "./closeout.js";
import { inspekteraEvidenceContext } from "./evidence.js";
import { optimeraBenchmarkContext } from "./benchmark.js";
import { realiseraExecutionContext } from "./realisera.js";
import { slimOrchestrationContext, slimEvidenceContext, slimCloseoutContext } from "./slim.js";

export function slimBespokeContext(name: string, value: Dict): Dict {
  if (name === "orchestration_context") return slimOrchestrationContext(value);
  if (name === "evidence_context") return slimEvidenceContext(value);
  if (name === "closeout_context") return slimCloseoutContext(value);
  return value;
}

export function bespokeCapabilityContexts(capabilityName: string | null, state: Dict): Dict {
  return {
    orchestration_context: orchestrationContext(
      capabilityName,
      state.plan,
      state.progress,
      state.health,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.next_action,
    ),
    closeout_context: dokumenteraCloseoutContext(
      capabilityName,
      state.schemas,
      state.plan,
      state.progress,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.app,
    ),
    evidence_context: inspekteraEvidenceContext(
      capabilityName,
      state.schemas,
      state.plan,
      state.progress,
      state.health,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.app,
    ),
    benchmark_context: optimeraBenchmarkContext(capabilityName),
    execution_context: realiseraExecutionContext(
      capabilityName,
      state.schemas,
      state.plan,
      state.progress,
      state.health,
      state.todo_items,
      state.docs,
      state.profile_dict,
      state.app,
    ),
  };
}
