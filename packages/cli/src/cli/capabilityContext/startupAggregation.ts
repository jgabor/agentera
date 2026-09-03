import type { JsonObject } from "../../core/jsonValue.js";
import { preCutoverCommand } from "../preCutoverCommand.js";

export type StartupAvailability = "included" | "deferred";
export type StartupOutcome = "ok" | "degraded" | "blocked";

export const STARTUP_INCLUDED_FAMILIES = new Set(["plan", "docs", "progress", "health", "todo", "objective"]);

const DETAIL_COMMANDS: Record<string, string> = {
  plan: preCutoverCommand("state plan list"),
  docs: preCutoverCommand("state docs list"),
  progress: preCutoverCommand("state progress list"),
  health: preCutoverCommand("state health list"),
  todo: preCutoverCommand("state todo list"),
  decisions: preCutoverCommand("state decisions list"),
  changelog: preCutoverCommand("state query changelog"),
  objective: preCutoverCommand("state objective list"),
  experiments: preCutoverCommand("state experiments list --objective OBJECTIVE_ID"),
  vision: preCutoverCommand("state query vision"),
  design: preCutoverCommand("state query design"),
  profile: preCutoverCommand("report profile-grounding"),
};

function detailCommand(family: string): string {
  return DETAIL_COMMANDS[family] ?? preCutoverCommand("schema");
}

/**
 * The only per-family startup inventory. `included` means the bounded capsule
 * carries a summary for that family; `deferred` means callers can discover
 * detail through the exact read command without receiving a writer payload.
 */
export function startupAvailabilityProjection(families: readonly string[]): JsonObject[] {
  return [...new Set(families)].map((family) => ({
    family,
    availability: STARTUP_INCLUDED_FAMILIES.has(family) ? "included" : ("deferred" as StartupAvailability),
    detail_command: detailCommand(family),
  }));
}

export function deferredStartupFamilies(contract: JsonObject): string[] {
  const availability = Array.isArray(contract.availability) ? contract.availability : [];
  return availability.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as JsonObject;
    return row.availability === "deferred" && typeof row.family === "string" ? [row.family] : [];
  });
}

/**
 * Prime aggregates read availability. Mutation grammar remains discoverable
 * only through `agentera schema`, never through a startup payload.
 */
export function startupAggregation(contract: JsonObject, health: JsonObject, cutover: JsonObject | null = null, todoReconciliation: JsonObject | null = null): JsonObject {
  const cutoverRequired = cutover?.status === "required" || cutover?.status === "invalid_lifecycle";
  const reconciliationRequired = todoReconciliation?.status === "action_required";
  const blocked = cutoverRequired || reconciliationRequired || (typeof contract.schema_error === "string" && contract.schema_error.length > 0);
  const degraded = health.startup_outcome === "degraded";
  const outcome: StartupOutcome = blocked ? "blocked" : degraded ? "degraded" : "ok";
  return {
    schemaVersion: "agentera.primeStartup.v1",
    outcome,
    state_cutover: cutover ?? { status: "complete", project_state: "v3", recovery_command: null },
    ...(reconciliationRequired ? { todo_reconciliation: todoReconciliation } : {}),
    availability: Array.isArray(contract.availability) ? contract.availability : [],
    detail_discovery: { schema: preCutoverCommand("schema") },
    raw_artifact_reads_required: false,
    raw_artifact_read_policy: "Use included bounded state first. For deferred detail, run that family's detail_command; raw reads are only for a named corruption or CLI-defect diagnostic.",
  };
}
