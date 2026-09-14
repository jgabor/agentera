import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import { entityListFamily } from "../../state/entityRetrievalHelp.js";
import type { EntityListRuntimeFamilyKey } from "../../state/entityListRuntimeRegistry.js";
import { preCutoverCommand, preCutoverCommandFromBare } from "../preCutoverCommand.js";

export type Env = Record<string, string | undefined>;

export const CAPABILITY_NAMES = Object.keys(CAPABILITY_INSTRUCTIONS);

function canonicalListCommand(key: EntityListRuntimeFamilyKey): string {
  const family = entityListFamily(key);
  return preCutoverCommand(`state ${family.commandTokens.join(" ")} list`);
}

export const STATE_FAMILY_FALLBACK_COMMANDS: Record<string, string> = {
  // Resolve authority only when selected, inside the caller's error boundary.
  // Static detail imports must not open authority files at module load time.
  get plan() {
    return canonicalListCommand("plans");
  },
  get docs() {
    return canonicalListCommand("docs");
  },
  get progress() {
    return canonicalListCommand("progress");
  },
  get health() {
    return canonicalListCommand("health");
  },
  get todo() {
    return canonicalListCommand("todo");
  },
  get decisions() {
    return canonicalListCommand("decisions");
  },
  changelog: preCutoverCommand("state query changelog"),
  get objective() {
    return canonicalListCommand("objective");
  },
  get experiments() {
    return preCutoverCommandFromBare(entityListFamily("experiments").syntax);
  },
};

export const STATE_FAMILY_LIST_COMMANDS: Record<string, string> = {
  get progress() {
    return canonicalListCommand("progress");
  },
  get decisions() {
    return canonicalListCommand("decisions");
  },
  get health() {
    return canonicalListCommand("health");
  },
};

export const STATE_FAMILY_GET_COMMANDS: Record<string, string> = {
  get progress() {
    return entityListFamily("progress").get;
  },
  get decisions() {
    return entityListFamily("decisions").get;
  },
  get health() {
    return entityListFamily("health").get;
  },
};
export const STARTUP_ENVELOPE_STATE_FAMILIES = new Set(["plan", "docs", "progress", "health", "todo", "objective", "benchmark_context"]);

export const PLAN_STARTUP_CONTRACT_VERSION = "agentera.planeraStartup.v1";
export const PLAN_PLANNING_LEVELS = ["skip", "light", "full"];
export const PLAN_STEP_VERBS = ["orient", "specify", "review", "audit", "write", "handoff"];
export const PLAN_TASK_COHERENCE_RULE = "Keep full-plan tasks within a coherent lifecycle boundary; split only at real lifecycle or coherence boundaries.";
export const PLAN_INSTRUCTIONS_AUTHORITY_EXCEPTIONS = ["editing Plan behavior or instructions", "resolving contradiction or ambiguity in compact context", "validating detailed behavior not covered by compact context", "investigating benchmark or read-trigger evidence"];
export const PLAN_RAW_PLAN_ACCESS_ALLOWED_FOR = ["writing a new plan", "archiving a completed plan", "artifact validation", "corruption diagnostics", "unavailable or incomplete CLI state after CLI fallbacks"];
export const PLAN_COMPLETED_PLAN_ARCHIVE_CONFIRMATION = {
  direct_plan_invocation: "Archiving an already completed existing plan before writing its replacement is implicit " + "in the direct Plan invocation and does not require a separate pre-write confirmation.",
  human_initiated_plan_write: "Plan approval is still required before writing a human-initiated replacement plan.",
  active_or_incomplete_plan: "Replacing, discarding, or archiving an active or incomplete plan is not implicit; " + "ask for explicit confirmation before the write.",
};
