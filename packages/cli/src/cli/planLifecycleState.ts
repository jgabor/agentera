import type { JsonObject } from "../core/jsonValue.js";
import { entityListFamily } from "../state/entityRetrievalHelp.js";
import { sourceProvenance } from "./capabilityContext/shared.js";
import { asList } from "./stateQuery.js";

const PLAN_LIST_COMMAND = `agentera state ${entityListFamily("plans").commandTokens.join(" ")} list --format json`;

function diagnosticEntries(value: unknown): JsonObject[] {
  return asList(value).filter(
    (entry): entry is JsonObject => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

/** Shared lifecycle health projection for status and plan-consuming capabilities. */
export function planLifecycleState(plan: JsonObject): JsonObject {
  const diagnostics = diagnosticEntries(plan.diagnostics);
  const degradedDiagnostics = diagnostics.filter((diagnostic) => diagnostic.category !== "legacy");
  const exists = Boolean(plan.exists);
  const active = plan.active === true;
  const activePath = typeof plan.active_path === "string" ? plan.active_path : null;
  const currentDiagnostics = activePath
    ? degradedDiagnostics.filter((diagnostic) => diagnostic.path === activePath)
    : degradedDiagnostics;
  const currentPlanDegraded = currentDiagnostics.length > 0;
  const status =
    degradedDiagnostics.length > 0 ? "degraded" : !exists ? "unavailable" : active ? "available" : "history_only";
  return {
    status,
    diagnostic_count: degradedDiagnostics.length,
    diagnostics: degradedDiagnostics,
    current_plan_degraded: currentPlanDegraded,
    execution_eligible: active && !currentPlanDegraded,
    source_provenance: sourceProvenance("plan", PLAN_LIST_COMMAND, "source.diagnostics"),
    caveats:
      status === "degraded"
        ? [
            currentPlanDegraded
              ? "Current plan lifecycle data is degraded; executable plan work is withheld until it is repaired."
              : "Historical plan lifecycle data is degraded; archived plans remain non-executable.",
          ]
        : [],
  };
}
