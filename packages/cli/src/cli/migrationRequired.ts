import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Io } from "./dispatch/shared.js";
import { emitStructured } from "./structured.js";
import { classifyProjectState, detectStateMode, initializeFreshEntityState, freshEntityStateMarker } from "../state/stateMode.js";
import { StateWriteInputError } from "../state/write/errors.js";
import { inspectWriterLockOwnership } from "../state/write/lock.js";
import { emitInvalidInput } from "./errors.js";
import { commandText, fullEntityUpgradeCommand, fullEntityUpgradePreviewCommand } from "../upgrade/upgradeCommands.js";
import { preCutoverCommand } from "./preCutoverCommand.js";
import type { NextAction } from "./contracts/orientationState.js";

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
  if (["--version", "version", "app-home", "doctor", "schema", "route", "upgrade", "init"].includes(command)) return false;
  if (command === "report" && ["personal-glossary-publish", "profile-grounding", "personal-glossary-candidates", "personal-glossary-decision", "personal-glossary-reviews"].includes(subcommand)) return false;
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
  return (command === "state" && subcommand === "plan" && verb === "create") || (command === "prime" && value(argv, "--context") === "plan");
}

/** Plan creation reads its input from stdin, so the command names no file that may not exist. */
function freshPlanCreateCommand(project: string): string {
  return commandText(["npx", "-y", "agentera@next", "state", "plan", "create", "--project", project, "--input", "-", "--format", "json"]);
}

export function initPreviewCommand(project: string): string {
  return commandText(["npx", "-y", "agentera@next", "init", "--project", project]);
}

export function initApplyCommand(project: string): string {
  return commandText(["npx", "-y", "agentera@next", "init", "--project", project, "--yes"]);
}

/** The one next step for a fresh project, shared by Prime and Doctor. Init
 *  must run before any capability that needs state, so vision and discuss
 *  wait behind its preview. The reason stays short because the bare brief
 *  bounds it; the exact command travels in `retrieval.exact`. */
export function freshInitNextAction(project: string): NextAction {
  return {
    object: "Agentera init preview",
    capability: "status",
    reason: "fresh project; nothing is written until the user approves init",
    phase: "envision",
    retrieval: { exact: initPreviewCommand(project) },
  };
}

/** The files `agentera init` writes for a fresh project. Init's preview and
 *  apply output and Prime's `fresh_start` all list exactly these writes. */
export function initWrites(markerPath: string): Array<{ path: string; action: "create"; content: ReturnType<typeof freshEntityStateMarker> }> {
  return [{ path: markerPath, action: "create", content: freshEntityStateMarker() }];
}

/** Bare-prime onboarding for a fresh project: what Agentera is, what has been
 *  written, the files init would write, and the init preview and apply
 *  commands. Carrying the writes lets an agent show them before it asks. */
export function freshStart(project: string): Record<string, unknown> {
  return {
    about: "Agentera keeps a project's direction, plans, decisions and progress as typed state in .agentera, so each coding-agent session starts where the last one stopped. Prime orients every session and routes each request to one of twelve capabilities, such as vision, plan and build.",
    written: "Nothing has been written to this project yet.",
    writes: initWrites(classifyProjectState(project).markerPath),
    preview_command: initPreviewCommand(project),
    apply_command: initApplyCommand(project),
    approval: "Show the user the files in writes and ask; run apply_command only after the user approves. Init then hands off to vision.",
  };
}

/** Recovery for a fresh project: the two initializers, preview first. */
function freshInitializationRecovery(project: string): string {
  return `Initialize the project with one of the two initializers. Preview init with ${initPreviewCommand(project)} and apply it with ${initApplyCommand(project)} only after the user approves, or start the plan capability with ${commandText(["npx", "-y", "agentera@next", "prime", "--context", "plan"])}, which builds the first plan from ${commandText(["npx", "-y", "agentera@next", "state", "plan", "explain", "--verb", "create"])} and sends it on stdin to ${freshPlanCreateCommand(project)}.`;
}

/** Read-only cutover gate. It only inspects the durable marker and emits a failure. */
export function enforceCompletedEntityCutover(projectRoot: string, format: Format, io: Io = {}, argv: string[] = []): number | null {
  const project = path.resolve(projectRoot);
  let mode: "legacy" | "entities";
  try {
    mode = detectStateMode(project);
  } catch (error) {
    const recovery = `Restore the exact durable migration marker, then run ${preCutoverCommand("check validate state")}.`;
    const envelope = {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "invalid_state_marker",
        message: (error as Error).message,
        project,
        recovery,
      },
    };
    if (format === "json" || format === "yaml") emitStructured(envelope, format, io.out ?? ((text) => process.stdout.write(text)));
    else (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${envelope.error.message}\nRecovery: ${recovery}\n`);
    return 1;
  }
  if (mode === "entities") return null;
  const classification = classifyProjectState(project);
  if (classification.state === "fresh_uninitialized") {
    if (permitsFreshPlanInitialization(argv)) return null;
    const recovery = freshInitializationRecovery(project);
    const envelope = {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "fresh_initialization_required",
        message: "This fresh project has no Agentera state yet. Only init and state plan create can initialize it; no other command or state writer creates entity authority.",
        project,
        recovery,
        initializers: [initPreviewCommand(project), freshPlanCreateCommand(project)],
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
      message: legacy ? "This command requires the completed entity-state cutover; legacy aggregates remain migration input only." : `This command cannot adopt marker-absent ${classification.state} Agentera state; inspect it with the read-only recovery command before any mutation.`,
      project,
      recovery,
    },
  };
  if (format === "json" || format === "yaml") emitStructured(envelope, format, io.out ?? ((text) => process.stdout.write(text)));
  else (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${envelope.error.message}\nRecovery: ${recovery}\n`);
  return 1;
}

type InitRefusal = { class: string; message: string; recovery: string; reason?: string };

function initRefusal(project: string, state: string, stateRoot: boolean, reason: string | undefined): InitRefusal | null {
  if (state === "fresh_uninitialized") return null;
  if (state === "entities") {
    return {
      class: "already_initialized",
      message: "This project already has Agentera state; init writes nothing.",
      recovery: `Nothing to initialize. Run ${commandText(["npx", "-y", "agentera@next", "prime"])} for the next step.`,
    };
  }
  if (state === "corrupt") {
    return {
      class: "corrupt_state",
      message: "Agentera state in this project is corrupt or unsafe; init never repairs, replaces or adopts existing state.",
      recovery: `Repair the reported path by hand, then run ${commandText(["npx", "-y", "agentera@next", "doctor", "--project", project])}.`,
      reason,
    };
  }
  if (state === "legacy") {
    return {
      class: "migration_required",
      message: "This project holds v2 Agentera state; init does not migrate it.",
      recovery: `Preview the migration with ${fullEntityUpgradePreviewCommand(project)} and apply it only after the user approves.`,
    };
  }
  if (state === "partial" || stateRoot) {
    return {
      class: state === "partial" ? "partial_state" : "unknown_state",
      message: `This project has ${state} Agentera state without the entity marker; init never adopts or completes existing state.`,
      recovery: `Inspect it with the read-only ${fullEntityUpgradePreviewCommand(project)} before any change.`,
    };
  }
  const repositoryRoot = gitRepositoryRoot(project);
  if (repositoryRoot) {
    return {
      class: "not_git_root",
      message: "init runs only at the root of a Git repository; this directory is inside one but is not its root.",
      recovery: `Preview init at the repository root with ${initPreviewCommand(repositoryRoot)}.`,
    };
  }
  return {
    class: "not_git_root",
    message: "init runs only at the root of a Git repository; this directory is not in one.",
    recovery: `Run git init in the project directory first, then preview again with ${commandText(["npx", "-y", "agentera@next", "init"])}.`,
  };
}

function gitRepositoryRoot(directory: string): string | null {
  const env = { ...process.env };
  for (const name of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[name];
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: directory, env, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const root = String(result.stdout).trim();
  return root ? root : null;
}

/**
 * `agentera init`: the second fresh-state initializer, next to `state plan
 * create`. It previews by default and writes only the entity-mode marker after
 * `--yes`. Refusals and conflicts write nothing.
 */
export function runInit(argv: string[], io: Io = {}): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  let apply = false;
  let projectArg: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--yes") apply = true;
    else if (arg === "--format" && argv[index + 1] === "json") index++;
    else if (arg === "--format=json") continue;
    else if (arg === "--project" && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) projectArg = argv[++index];
    else if (arg.startsWith("--project=") && arg.length > "--project=".length) projectArg = arg.slice("--project=".length);
    else {
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: arg === "--project" || arg === "--project=" ? "missing_argument" : "unrecognized_argument",
          message: arg === "--project" || arg === "--project=" ? "argument --project: expected one directory" : `unrecognized argument: ${arg}`,
          valid_values: ["--project PROJECT", "--yes"],
          syntax: "agentera init [--project PROJECT] [--yes]",
          example: "agentera init",
          recovery: "Correct the arguments and retry; no state was changed.",
        },
      });
    }
  }
  const project = projectArg ? path.resolve(projectArg) : migrationProject([], process.cwd());
  let classification: ReturnType<typeof classifyProjectState>;
  try {
    classification = classifyProjectState(project);
  } catch (error) {
    return emitInvalidInput(io, {
      format: "json",
      body: {
        class: "unsupported_target",
        message: `init cannot use project '${project}': ${(error as Error).message}`,
        syntax: "agentera init [--project PROJECT] [--yes]",
        example: "agentera init",
        recovery: "Run init from an existing Git repository root, or pass it with --project; no state was changed.",
      },
    });
  }
  const refuse = (refusal: InitRefusal, state: string): number => {
    emitStructured({ schemaVersion: "agentera.stateFailure.v1", status: "fail", error: { ...refusal, project, project_state: state } }, "json", out);
    return 1;
  };
  let stateRoot = true;
  try {
    fs.lstatSync(path.join(project, ".agentera"));
  } catch {
    stateRoot = false;
  }
  const conflict = (reason: string, recovery = `Check the project with ${commandText(["npx", "-y", "agentera@next", "prime"])}; if it is still uninitialized, preview again with ${initPreviewCommand(project)}.`): number =>
    refuse(
      {
        class: "initialization_conflict",
        message: "Another Agentera writer, most likely state plan create, is initializing or changing this project; init wrote nothing.",
        recovery,
        reason,
      },
      classifyProjectState(project).state,
    );
  // The other initializer holds the project writer lock while it publishes. A
  // lock whose owner died is classified as fresh and never reaches this check.
  if (classification.state === "unknown" || classification.state === "partial") {
    const lockPath = path.join(project, ".agentera", ".writer.lock");
    const owner = inspectWriterLockOwnership(path.join(project, ".agentera"));
    const holder = owner.pid === undefined ? "another process" : `process ${owner.pid}`;
    if (owner.state === "live") {
      return conflict(`the project writer lock is held by ${holder}`, `Wait for ${holder} to finish, then run ${initPreviewCommand(project)} again. If ${holder} is not an Agentera command (its pid may be reused after a reboot), ask the user to confirm, then remove ${lockPath} and preview again.`);
    }
    if (owner.state === "indeterminate") {
      return conflict(`Agentera cannot tell whether ${holder} still owns the project writer lock`, `Ask the user to confirm that no Agentera command is running in this project. Only then remove ${lockPath} and any .agentera/.writer.*.tmp directory, and run ${initPreviewCommand(project)} again.`);
    }
  }
  const refusal = initRefusal(project, classification.state, stateRoot, classification.reason);
  if (refusal) return refuse(refusal, classification.state);
  const writes = initWrites(classification.markerPath);
  const nextStep = {
    capability: "vision",
    command: commandText(["npx", "-y", "agentera@next", "prime", "--context", "vision"]),
    alternative: { capability: "discuss", command: commandText(["npx", "-y", "agentera@next", "prime", "--context", "discuss"]), when: "direction is unclear" },
  };
  if (!apply) {
    emitStructured(
      {
        schemaVersion: "agentera.init.v1",
        command: "init",
        status: "preview",
        project,
        project_state: classification.state,
        writes,
        changed: false,
        approval: "Show these writes to the user. Run apply_command only after the user explicitly approves; init writes nothing without --yes.",
        apply_command: initApplyCommand(project),
        initializers: ["init", "state plan create"],
      },
      "json",
      out,
    );
    return 0;
  }
  try {
    if (!initializeFreshEntityState(project)) return conflict("the project was no longer fresh when init started to write");
  } catch (error) {
    if (!(error instanceof StateWriteInputError) || error.body.class !== "conflict") throw error;
    return conflict(error.body.message);
  }
  emitStructured(
    {
      schemaVersion: "agentera.init.v1",
      command: "init",
      status: "initialized",
      project,
      project_state: "v3",
      writes,
      changed: true,
      next_step: nextStep,
    },
    "json",
    out,
  );
  return 0;
}
