import { cmdPrime } from "./commands/prime.js";
import { cmdLint, LintArgs } from "./commands/lint.js";
import { cmdBackfill, BackfillArgs } from "./commands/backfill.js";
import { cmdState, isPortedStateCommand, StateArgs } from "./commands/state.js";
import { COMMAND_FILTERS } from "./stateQuery.js";

/**
 * Top-level command dispatch. The full argparse-shaped surface is being ported
 * incrementally; currently wired: `prime`, `lint` (+ `check lint`).
 */

type Io = { out?: (t: string) => void; err?: (t: string) => void };

function emitDeprecationAlias(legacy: string, canonical: string, err: (t: string) => void): void {
  err(`Deprecation: agentera ${legacy} is deprecated; use agentera ${canonical}\n`);
}

/** Minimal flag parser for the `lint` command surface. */
function parseLintArgs(argv: string[]): LintArgs | { error: string } {
  const args: LintArgs = { artifact: "", file: null, text: null, strict: false, format: "text" };
  let sawArtifact = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--artifact")) !== null) {
      args.artifact = v;
      sawArtifact = true;
    } else if ((v = value("--file")) !== null) {
      args.file = v;
    } else if ((v = value("--text")) !== null) {
      args.text = v;
    } else if (a === "--strict") {
      args.strict = true;
    } else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')` };
      }
      args.format = v;
    } else {
      return { error: `unrecognized arguments: ${a}` };
    }
  }
  if (!sawArtifact) return { error: "the following arguments are required: --artifact" };
  if (args.file !== null && args.text !== null) {
    return { error: "argument --text: not allowed with argument --file" };
  }
  return args;
}

function runLint(argv: string[], io: Io, prog = "agentera lint"): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const parsed = parseLintArgs(argv);
  if ("error" in parsed) {
    err(`${prog}: error: ${parsed.error}\n`);
    return 2;
  }
  try {
    return cmdLint(parsed, io);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function parseBackfillArgs(argv: string[]): BackfillArgs | { error: string } {
  const args: BackfillArgs = { project: null, mode: "check", commit: null, cycle: null, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--mode")) !== null) {
      if (v !== "check" && v !== "fix") {
        return { error: `argument --mode: invalid choice: '${v}' (choose from 'check', 'fix')` };
      }
      args.mode = v;
    } else if ((v = value("--commit")) !== null) args.commit = v;
    else if ((v = value("--cycle")) !== null) {
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: `argument --cycle: invalid int value: '${v}'` };
      args.cycle = n;
    } else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')` };
      }
      args.format = v;
    } else {
      return { error: `unrecognized arguments: ${a}` };
    }
  }
  return args;
}

function runBackfill(argv: string[], io: Io, prog = "agentera backfill"): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const parsed = parseBackfillArgs(argv);
  if ("error" in parsed) {
    err(`${prog}: error: ${parsed.error}\n`);
    return 2;
  }
  try {
    return cmdBackfill(parsed, io);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function parseStateArgs(command: string, argv: string[]): StateArgs | { error: string } {
  const args: StateArgs = {
    command,
    topic: null,
    status: null,
    dimension: null,
    severity: null,
    limit: 5,
    format: "text",
    fields: null,
  };
  const allowed = new Set([...(COMMAND_FILTERS[command] ?? []), "format", "fields"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    const named = (flag: string, key: string): boolean => allowed.has(key) && (a === flag || a.startsWith(flag + "="));
    let v: string | null;
    if (named("--topic", "topic")) args.topic = value("--topic");
    else if (named("--status", "status")) args.status = value("--status");
    else if (named("--dimension", "dimension")) args.dimension = value("--dimension");
    else if (named("--severity", "severity")) args.severity = value("--severity");
    else if (named("--limit", "limit")) {
      v = value("--limit");
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: `argument --limit: invalid int value: '${v}'` };
      args.limit = n;
    } else if (a === "--format" || a.startsWith("--format=")) {
      v = value("--format");
      if (v !== "text" && v !== "json" && v !== "yaml") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')` };
      }
      args.format = v;
    } else if (a === "--fields" || a.startsWith("--fields=")) args.fields = value("--fields");
    else return { error: `unrecognized arguments: ${a}` };
  }
  return args;
}

function runState(command: string, argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const parsed = parseStateArgs(command, argv);
  if ("error" in parsed) {
    err(`${prog}: error: ${parsed.error}\n`);
    return 2;
  }
  return cmdState(parsed, io);
}

export function main(argv: string[], io: Io = {}): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const args = argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "prime":
      return cmdPrime(rest);
    case "lint":
      emitDeprecationAlias("lint", "check lint", err);
      return runLint(rest, io);
    case "check": {
      const sub = rest[0];
      if (!sub) {
        err("agentera check: error: the following arguments are required: check_command\n");
        return 2;
      }
      if (sub === "lint") return runLint(rest.slice(1), io, "agentera check lint");
      if (sub === "backfill") return runBackfill(rest.slice(1), io, "agentera check backfill");
      err(`agentera: unknown or not-yet-ported check subcommand: ${sub}\n`);
      return 1;
    }
    case "state": {
      const sub = rest[0];
      if (!sub) {
        err("agentera state: error: the following arguments are required: state_command\n");
        return 2;
      }
      if (isPortedStateCommand(sub)) return runState(sub, rest.slice(1), io, `agentera state ${sub}`);
      err(`agentera: unknown or not-yet-ported state subcommand: ${sub}\n`);
      return 1;
    }
    default:
      if (command && isPortedStateCommand(command)) {
        emitDeprecationAlias(command, `state ${command}`, err);
        return runState(command, rest, io, `agentera ${command}`);
      }
      err(`agentera: unknown or not-yet-ported command: ${command ?? "(none)"}\n`);
      return 1;
  }
}
