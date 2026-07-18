import path from "node:path";

import type { Io } from "./dispatch/shared.js";
import { emitStructured } from "./structured.js";
import { detectStateMode } from "../state/stateMode.js";
import { CAPABILITY_ROUTING_NAMES } from "./commands/capability.js";
import { isWriteVerb } from "../state/write/operations.js";
import { commandText } from "../upgrade/upgradeCommands.js";

type Format = "text" | "json" | "yaml";

const LEGACY_EVIDENCE_ARTIFACTS = new Set(["progress", "decisions", "health", "plan"]);
const ROUTINE_STATE_ARTIFACTS = new Set([
  "progress", "decisions", "health", "plan", "objective", "experiments", "todo", "docs",
]);

function value(argv: string[], flag: string): string | undefined {
  const equals = argv.find((arg) => typeof arg === "string" && arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function requestedMigrationFailureFormat(argv: string[]): Format {
  const format = value(argv, "--format");
  return format === "json" || format === "yaml" ? format : "text";
}

/** Explicit allowlist boundary for marker-absent commands that must remain usable. */
export function requiresCompletedEntityCutover(argv: string[]): boolean {
  const [command, subcommand, verb] = argv;
  if (command === "prime" || CAPABILITY_ROUTING_NAMES.includes(command)) return true;
  if (command === "query") return !argv.includes("--list-artifacts");
  if (command !== "state") return false;
  if (subcommand === "migrate" || subcommand === "backfill") return false;
  if (subcommand === "query") return !argv.includes("--list-artifacts");
  if (!subcommand || !ROUTINE_STATE_ARTIFACTS.has(subcommand)) return false;
  if (verb === "explain") return false;
  if (LEGACY_EVIDENCE_ARTIFACTS.has(subcommand) && isWriteVerb(verb)) return false;
  return true;
}

export function migrationProject(argv: string[], fallback = process.cwd()): string {
  return path.resolve(value(argv, "--project") ?? fallback);
}

/** Read-only cutover gate. It only inspects the durable marker and emits a failure. */
export function enforceCompletedEntityCutover(
  projectRoot: string,
  format: Format,
  io: Io = {},
): number | null {
  const project = path.resolve(projectRoot);
  let mode: "legacy" | "entities";
  try {
    mode = detectStateMode(project);
  } catch (error) {
    const recovery = "Restore the exact durable migration marker, then run agentera check validate state --format json.";
    const envelope = {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: { class: "invalid_state_marker", message: (error as Error).message, project, recovery },
    };
    if (format === "json" || format === "yaml") emitStructured(envelope, format, io.out ?? ((text) => process.stdout.write(text)));
    else (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${envelope.error.message}\nRecovery: ${recovery}\n`);
    return 1;
  }
  if (mode === "entities") return null;
  const recovery = commandText([
    "npx", "-y", "agentera@next", "upgrade", "--channel", "development", "--project", project, "--yes",
  ]);
  const envelope = {
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "migration_required",
      message: "This command requires the completed entity-state cutover; legacy aggregates remain migration input only.",
      project,
      recovery,
    },
  };
  if (format === "json" || format === "yaml") emitStructured(envelope, format, io.out ?? ((text) => process.stdout.write(text)));
  else (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${envelope.error.message}\nRecovery: ${recovery}\n`);
  return 1;
}
