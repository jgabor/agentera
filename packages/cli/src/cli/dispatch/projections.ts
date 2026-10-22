/**
 * Independent production projections of the accepted top-level command set.
 * They intentionally do not import the dispatcher inventory: activation must
 * detect drift in diagnostics, packaged schema, or public instructions.
 */
export const DIAGNOSTIC_TOP_LEVEL_COMMANDS = Object.freeze([
  "prime",
  "init",
  "app-home",
  "doctor",
  "usage",
  "upgrade",
  "verify",
  "report",
  "stats",
  "schema",
  "lint",
  "check",
  "state",
  "query",
  "compact",
  "validate",
  "route",
  "vision",
  "discuss",
  "research",
  "plan",
  "build",
  "optimize",
  "audit",
  "document",
  "profile",
  "design",
  "orchestrate",
]);

export const SCHEMA_TOP_LEVEL_COMMANDS = Object.freeze([
  "prime",
  "init",
  "app-home",
  "doctor",
  "usage",
  "upgrade",
  "verify",
  "report",
  "stats",
  "schema",
  "lint",
  "check",
  "state",
  "query",
  "compact",
  "validate",
  "route",
  "vision",
  "discuss",
  "research",
  "plan",
  "build",
  "optimize",
  "audit",
  "document",
  "profile",
  "design",
  "orchestrate",
]);

/** Commands listed in top-level `--help`: agent and user commands only. */
export const HELP_TOP_LEVEL_COMMANDS = Object.freeze(["prime", "init", "app-home", "doctor", "upgrade", "report", "schema", "state", "route", "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate"]);

/**
 * Maintainer commands and compatibility aliases. They still dispatch, but
 * top-level help leaves them out; each is documented by its own `--help`.
 */
export const OWN_HELP_TOP_LEVEL_COMMANDS = Object.freeze(["usage", "verify", "stats", "lint", "check", "query", "compact", "validate"]);
