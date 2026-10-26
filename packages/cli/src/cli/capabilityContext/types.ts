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
