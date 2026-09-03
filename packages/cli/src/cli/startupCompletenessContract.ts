import type { JsonObject } from "../core/jsonValue.js";
import { STATE_FAMILY_FALLBACK_COMMANDS, STATE_FAMILY_LIST_COMMANDS } from "./capabilityContext/types.js";

export interface StartupCompletenessInput {
  schemaError?: string | null;
  profileStatus?: string;
}

export const STARTUP_AVAILABLE_STATE_FIELDS = [
  "app_home",
  "mode",
  "profile",
  "health",
  "todo",
  "plan",
  "docs",
  "progress",
  "objective",
  "state_presence",
  "project_integration",
  "attention",
  "decision_attention",
  "next_action",
  "orchestration_context",
  "closeout_context",
  "evidence_context",
  "benchmark_context",
  "execution_context",
] as const;

export const STARTUP_COMPLETENESS_CONFIDENCE_CAVEATS = ["representative benchmark evidence exists, but some source products remain degraded by schema divergence", "Audit evidence context uses existing status, plan, progress, docs, health, TODO, and decisions state outputs"] as const;

export const STARTUP_COMPLETENESS_CLI_FALLBACK = [STATE_FAMILY_FALLBACK_COMMANDS.plan, STATE_FAMILY_FALLBACK_COMMANDS.docs, STATE_FAMILY_LIST_COMMANDS.progress] as const;

export function startupCompletenessContract(input: StartupCompletenessInput = {}): JsonObject {
  const missingState: string[] = [];
  const schemaError = input.schemaError ?? null;
  if (schemaError) {
    missingState.push(schemaError);
  }
  if (input.profileStatus === "not found") missingState.push("profile not found");
  if (input.profileStatus === "absent") missingState.push("profile absent");
  if (input.profileStatus === "repair_needed") missingState.push("profile repair needed");
  const complete = missingState.length === 0;
  return {
    complete_for_capability_startup: complete,
    raw_artifact_reads_required: false,
    raw_artifact_read_policy: "Do not read raw artifacts when complete_for_capability_startup is true. " + "When incomplete, try cli_fallback first; raw reads are permitted only for a named corruption or CLI-defect diagnostic.",
    available_state: [...STARTUP_AVAILABLE_STATE_FIELDS],
    missing_state: missingState,
    confidence_caveats: [...STARTUP_COMPLETENESS_CONFIDENCE_CAVEATS],
    cli_fallback: [...STARTUP_COMPLETENESS_CLI_FALLBACK],
  };
}

export function capabilityStartupComplete(input: StartupCompletenessInput = {}): boolean {
  return Boolean(startupCompletenessContract(input).complete_for_capability_startup);
}
