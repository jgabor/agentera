import { CAPABILITY_ROUTING_NAMES } from "../commands/capability.js";

/**
 * Top-level commands routed by `dispatch/main` (includes migration aliases still
 * accepted at the CLI surface).
 */
export const DISPATCHER_TOP_LEVEL_COMMANDS = [
  "prime",
  "app-home",
  "doctor",
  "usage",
  "upgrade",
  "verify",
  "report",
  "stats",
  "hook",
  "schema",
  "lint",
  "check",
  "state",
  "query",
  "compact",
  "validate",
  ...CAPABILITY_ROUTING_NAMES,
] as const;

/** Set view for doctor in-process CLI probe checks. */
export const DISPATCHER_COMMANDS = new Set<string>(DISPATCHER_TOP_LEVEL_COMMANDS);
