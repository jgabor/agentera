import fs from "node:fs";
import path from "node:path";

import type { Io } from "./dispatch/shared.js";
import { emitStructured } from "./structured.js";
import { detectStateMode } from "../state/stateMode.js";
import { fullEntityUpgradeCommand } from "../upgrade/upgradeCommands.js";

type Format = "text" | "json" | "yaml";

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

/** Marker-absent projects expose only the forward upgrade and static discovery. */
export function requiresCompletedEntityCutover(argv: string[]): boolean {
  const [command, subcommand, verb] = argv;
  if (["--version", "version", "app-home", "doctor", "schema", "upgrade"].includes(command)) return false;
  if (command === "prime" && argv.includes("--guidance")) return false;
  if (command === "query") return !argv.includes("--list-artifacts");
  if (command === "state" && subcommand === "query" && argv.includes("--list-artifacts")) return false;
  if (command === "state" && subcommand === "migrate" && verb === "entities" && argv.includes("--dry-run")) return false;
  if (command === "state" && verb === "explain") return false;
  return true;
}

export function migrationProject(argv: string[], fallback = process.cwd()): string {
  const explicit = value(argv, "--project");
  if (explicit) return path.resolve(explicit);
  let candidate = path.resolve(fallback);
  while (true) {
    if (fs.existsSync(path.join(candidate, ".agentera", "state-mode.yaml"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return path.resolve(fallback);
    candidate = parent;
  }
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
  const recovery = fullEntityUpgradeCommand(project);
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
