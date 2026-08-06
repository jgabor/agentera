/**
 * Independent production projections of the accepted top-level command set.
 * They intentionally do not import the dispatcher inventory: activation must
 * detect drift in diagnostics, packaged schema, or public instructions.
 */
export const DIAGNOSTIC_TOP_LEVEL_COMMANDS = Object.freeze([
  "prime", "app-home", "doctor", "usage", "upgrade", "verify", "report", "stats", "schema", "lint", "check", "state", "query", "compact", "validate", "route",
  "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate",
]);

export const SCHEMA_TOP_LEVEL_COMMANDS = Object.freeze([
  "prime", "app-home", "doctor", "usage", "upgrade", "verify", "report", "stats", "schema", "lint", "check", "state", "query", "compact", "validate", "route",
  "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate",
]);

export const HELP_TOP_LEVEL_COMMANDS = Object.freeze([
  "prime", "app-home", "doctor", "usage", "upgrade", "verify", "report", "stats", "schema", "lint", "check", "state", "query", "compact", "validate", "route",
  "vision", "discuss", "research", "plan", "build", "optimize", "audit", "document", "profile", "design", "orchestrate",
]);
