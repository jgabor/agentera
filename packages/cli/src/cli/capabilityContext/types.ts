import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import type { JsonObject } from "../../core/jsonValue.js";

export type Dict = JsonObject;
export type Env = Record<string, string | undefined>;

export const CAPABILITY_NAMES = Object.keys(CAPABILITY_INSTRUCTIONS);
export const BESPOKE_CONTEXT_CAPABILITIES = new Set<string>([]);

export const STATE_FAMILY_FALLBACK_COMMANDS: Record<string, string> = {
  plan: "agentera state plan --format json",
  docs: "agentera state docs --format json",
  progress: "agentera state progress --format json",
  health: "agentera state health --format json",
  todo: "agentera state todo --format json",
  decisions: "agentera state decisions --format json",
  changelog: "agentera state query changelog --format json",
  objective: "agentera state objective --format json",
  experiments: "agentera state experiments --format json",
};
export const STARTUP_ENVELOPE_STATE_FAMILIES = new Set([
  "plan", "docs", "progress", "health", "todo", "objective", "benchmark_context",
]);

export const PLAN_STARTUP_CONTRACT_VERSION = "agentera.planeraStartup.v1";
export const PLAN_PLANNING_LEVELS = ["skip", "light", "full"];
export const PLAN_STEP_VERBS = ["orient", "specify", "review", "audit", "write", "handoff"];
export const PLAN_INSTRUCTIONS_AUTHORITY_EXCEPTIONS = [
  "editing Plan behavior or instructions",
  "resolving contradiction or ambiguity in compact context",
  "validating detailed behavior not covered by compact context",
  "investigating benchmark or read-trigger evidence",
];
export const PLAN_RAW_PLAN_ACCESS_ALLOWED_FOR = [
  "writing a new plan",
  "archiving a completed plan",
  "artifact validation",
  "corruption diagnostics",
  "unavailable or incomplete CLI state after CLI fallbacks",
];
export const PLAN_COMPLETED_PLAN_ARCHIVE_CONFIRMATION = {
  direct_plan_invocation:
    "Archiving an already completed existing plan before writing its replacement is implicit " +
    "in the direct Plan invocation and does not require a separate pre-write confirmation.",
  human_initiated_plan_write: "Plan approval is still required before writing a human-initiated replacement plan.",
  active_or_incomplete_plan:
    "Replacing, discarding, or archiving an active or incomplete plan is not implicit; " +
    "ask for explicit confirmation before the write.",
};
