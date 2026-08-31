import fs from "node:fs";
import path from "node:path";

import type { Io } from "./dispatch/shared.js";
import { emitStructured } from "./structured.js";
import { classifyProjectState, detectStateMode } from "../state/stateMode.js";
import { commandText, fullEntityUpgradeCommand, fullEntityUpgradePreviewCommand } from "../upgrade/upgradeCommands.js";
import { preCutoverCommand } from "./preCutoverCommand.js";

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
  if (["--version", "version", "app-home", "doctor", "schema", "route", "upgrade"].includes(command)) return false;
  if (
    command === "report" &&
    ["personal-glossary-publish", "profile-grounding", "personal-glossary-candidates", "personal-glossary-decision", "personal-glossary-reviews"].includes(subcommand)
  ) return false;
  if (command === "check" && subcommand === "verify" && verb === "eval" && argv[3] === "glossary") return false;
  if (command === "prime" && (argv.includes("--guidance") || !argv.includes("--context") || value(argv, "--context") === "status")) return false;
  if (command === "query") return !argv.includes("--list-artifacts");
  if (command === "state" && subcommand === "query" && argv.includes("--list-artifacts")) return false;
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

function permitsFreshPlanInitialization(argv: string[]): boolean {
  const [command, subcommand, verb] = argv;
  return command === "state" && subcommand === "plan" && verb === "create"
    || command === "prime" && value(argv, "--context") === "plan";
}

function freshPlanCreateCommand(project: string): string {
  return commandText([
    "npx", "-y", "agentera@next", "state", "plan", "create", "--project", project,
    "--input", "PLAN.yaml", "--format", "json",
  ]);
}

/** Read-only cutover gate. It only inspects the durable marker and emits a failure. */
export function enforceCompletedEntityCutover(
  projectRoot: string,
  format: Format,
  io: Io = {},
  argv: string[] = [],
): number | null {
  const project = path.resolve(projectRoot);
  let mode: "legacy" | "entities";
  try {
    mode = detectStateMode(project);
  } catch (error) {
    const recovery = `Restore the exact durable migration marker, then run ${preCutoverCommand("check validate state")}.`;
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
  const classification = classifyProjectState(project);
  if (classification.state === "fresh_uninitialized") {
    if (permitsFreshPlanInitialization(argv)) return null;
    const recovery = freshPlanCreateCommand(project);
    const envelope = {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "fresh_initialization_required",
        message: "Fresh project state is initialized only by state plan create; no other state writer can create entity authority.",
        project,
        recovery,
      },
    };
    if (format === "json" || format === "yaml") emitStructured(envelope, format, io.out ?? ((text) => process.stdout.write(text)));
    else (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${envelope.error.message}\nRecovery: ${recovery}\n`);
    return 1;
  }
  const legacy = classification.state === "legacy";
  const recovery = legacy ? fullEntityUpgradeCommand(project) : fullEntityUpgradePreviewCommand(project);
  const envelope = {
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "migration_required",
      message: legacy
        ? "This command requires the completed entity-state cutover; legacy aggregates remain migration input only."
        : `This command cannot adopt marker-absent ${classification.state} Agentera state; inspect it with the read-only recovery command before any mutation.`,
      project,
      recovery,
    },
  };
  if (format === "json" || format === "yaml") emitStructured(envelope, format, io.out ?? ((text) => process.stdout.write(text)));
  else (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${envelope.error.message}\nRecovery: ${recovery}\n`);
  return 1;
}
