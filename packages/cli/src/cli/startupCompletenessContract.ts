import type { JsonObject } from "../core/jsonValue.js";

export const STARTUP_COMPLETENESS_MISSING_STATE: string[] = [];

export const STARTUP_AVAILABLE_STATE_FIELDS = [
  "app_home",
  "mode",
  "profile",
  "v1_migration",
  "health",
  "issues",
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

export const STARTUP_COMPLETENESS_CONFIDENCE_CAVEATS = [
  "representative benchmark evidence exists, but claude-code and github-copilot coverage is degraded by schema divergence",
  "Audit evidence context uses existing hej, plan, progress, docs, health, TODO, and decisions state outputs",
] as const;

export const STARTUP_COMPLETENESS_CLI_FALLBACK = [
  "agentera plan --format json",
  "agentera docs --format json",
  "agentera progress --format json",
] as const;

export function startupCompletenessContract(): JsonObject {
  const complete = STARTUP_COMPLETENESS_MISSING_STATE.length === 0;
  return {
    complete_for_capability_startup: complete,
    raw_artifact_reads_required: false,
    raw_artifact_read_policy:
      "Do not read raw artifacts when complete_for_capability_startup is true. " +
      "When incomplete, try cli_fallback first; raw artifact reads are only a last-resort fallback.",
    available_state: [...STARTUP_AVAILABLE_STATE_FIELDS],
    missing_state: STARTUP_COMPLETENESS_MISSING_STATE,
    confidence_caveats: [...STARTUP_COMPLETENESS_CONFIDENCE_CAVEATS],
    cli_fallback: [...STARTUP_COMPLETENESS_CLI_FALLBACK],
  };
}

export function capabilityStartupComplete(): boolean {
  return STARTUP_COMPLETENESS_MISSING_STATE.length === 0;
}
