import { cmdPrime, PrimeArgs } from "./commands/prime.js";
import { cmdLint, LintArgs } from "./commands/lint.js";
import { cmdBackfill, BackfillArgs } from "./commands/backfill.js";
import { cmdState, isPortedStateCommand, StateArgs } from "./commands/state.js";
import { COMMAND_FILTERS } from "./stateQuery.js";
import { cmdQuery, QueryArgs } from "./commands/query.js";
import { cmdCompact, cmdGate, CompactArgs } from "./commands/compact.js";
import { cmdSchema } from "./commands/schema.js";
import { cmdDoctor, DoctorArgs } from "./commands/doctor.js";
import { cmdUpgrade, UpgradeArgs } from "./commands/upgrade.js";
import { cmdVerify, VerifyArgs } from "./commands/verify.js";
import { runSessionStart } from "../hooks/sessionStart.js";
import { runSessionStop } from "../hooks/sessionStop.js";
import { runCursorSessionStart } from "../hooks/cursorSessionStart.js";
import { runCursorPreToolUse } from "../hooks/cursorPreToolUse.js";
import { HookCliAdapter } from "../hooks/validateArtifact.js";
import fsForHooks from "node:fs";
import { usageMain } from "../analytics/usageStats.js";
import { validatePathValue } from "./argvalidate.js";
import { cmdCapability, CAPABILITY_ROUTING_NAMES } from "./commands/capability.js";
import {
  cmdValidate,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  cmdValidateArtifact,
  cmdValidateDescriptors,
  isDelegatedValidateFamily,
} from "./commands/validate.js";

/**
 * Top-level command dispatch. The full argparse-shaped surface is being ported
 * incrementally; currently wired: `prime`, `lint` (+ `check lint`).
 */

type Io = { out?: (t: string) => void; err?: (t: string) => void; stdin?: () => string };

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

function parseQueryArgs(argv: string[]): QueryArgs | { error: string } {
  const args: QueryArgs = {
    query: null,
    list_artifacts: false,
    topic: null,
    severity: null,
    dimension: null,
    status: null,
    limit: null,
    format: "text",
    fields: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if (a === "--list-artifacts") args.list_artifacts = true;
    else if ((v = value("--topic")) !== null) args.topic = v;
    else if ((v = value("--severity")) !== null) args.severity = v;
    else if ((v = value("--dimension")) !== null) args.dimension = v;
    else if ((v = value("--status")) !== null) args.status = v;
    else if ((v = value("--limit")) !== null) {
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: `argument --limit: invalid int value: '${v}'` };
      args.limit = n;
    } else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json" && v !== "yaml") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')` };
      }
      args.format = v;
    } else if ((v = value("--fields")) !== null) args.fields = v;
    else if (a.startsWith("--")) return { error: `unrecognized arguments: ${a}` };
    else if (args.query === null) args.query = a;
    else return { error: `unrecognized arguments: ${a}` };
  }
  return args;
}

function runQuery(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const parsed = parseQueryArgs(argv);
  if ("error" in parsed) {
    err(`${prog}: error: ${parsed.error}\n`);
    return 2;
  }
  try {
    return cmdQuery(parsed, io);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function compactModeOf(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode") return argv[i + 1] ?? "check";
    if (argv[i].startsWith("--mode=")) return argv[i].slice("--mode=".length);
  }
  return "check";
}

function parseCompactArgs(argv: string[]): CompactArgs | { error: string } {
  const args: CompactArgs = { project: null, mode: "check", format: "text" };
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
    } else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')` };
      }
      args.format = v;
    } else return { error: `unrecognized arguments: ${a}` };
  }
  return args;
}

function runCompact(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const parsed = parseCompactArgs(argv);
  if ("error" in parsed) {
    err(`${prog}: error: ${parsed.error}\n`);
    return 2;
  }
  try {
    return cmdCompact(parsed, io);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function runValidate(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let family: string | null = null;
  let capabilityTarget: string | null = null;
  let artifactFlag: string | null = null;
  let fileFlag: string | null = null;
  let cwdFlag: string | null = null;
  let format = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json") {
        err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json')\n`);
        return 2;
      }
      format = v;
    } else if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v !== "text" && v !== "json") {
        err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json')\n`);
        return 2;
      }
      format = v;
    } else if (a === "--artifact" || a.startsWith("--artifact=")) {
      artifactFlag = a === "--artifact" ? argv[++i] : a.slice("--artifact=".length);
    } else if (a === "--file" || a.startsWith("--file=")) {
      fileFlag = a === "--file" ? argv[++i] : a.slice("--file=".length);
    } else if (a === "--cwd" || a.startsWith("--cwd=")) {
      cwdFlag = a === "--cwd" ? argv[++i] : a.slice("--cwd=".length);
    } else if (a.startsWith("--")) {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    } else if (family === null) {
      family = a;
    } else if (capabilityTarget === null) {
      capabilityTarget = a;
    } else {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }
  if (family === null) {
    err(`${prog}: error: the following arguments are required: validate_family\n`);
    return 2;
  }
  try {
    if (family === "capability") {
      if (capabilityTarget === null) {
        err(`${prog} capability: error: the following arguments are required: target\n`);
        return 2;
      }
      return cmdValidateCapability(capabilityTarget, { format }, io);
    }
    if (family === "capability-contract") {
      return cmdValidateCapabilityContract({ format }, io);
    }
    if (family === "descriptors") {
      return cmdValidateDescriptors({ format }, io);
    }
    if (family === "artifact") {
      if (artifactFlag === null) {
        err(`${prog} artifact: error: the following arguments are required: --artifact\n`);
        return 2;
      }
      return cmdValidateArtifact({ artifact: artifactFlag, file: fileFlag, cwd: cwdFlag, format }, io);
    }
    if (isDelegatedValidateFamily(family)) {
      return cmdValidate(family, { format }, io);
    }
    err(`agentera: validate family not yet ported: ${family}\n`);
    return 1;
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function runSchema(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let format = "json";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null = null;
    if (a === "--format") v = argv[++i];
    else if (a.startsWith("--format=")) v = a.slice("--format=".length);
    else {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
    if (v !== "json" && v !== "yaml") {
      err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'json', 'yaml')\n`);
      return 2;
    }
    format = v;
  }
  try {
    return cmdSchema({ format }, io);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function runCapability(command: string, argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let format = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null = null;
    if (a === "--format") v = argv[++i];
    else if (a.startsWith("--format=")) v = a.slice("--format=".length);
    else if (a === "--fields" || a.startsWith("--fields=")) {
      // accepted by the parser but unused by capability routing
      if (a === "--fields") i++;
      continue;
    } else {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
    if (v !== "text" && v !== "json" && v !== "yaml") {
      err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')\n`);
      return 2;
    }
    format = v;
  }
  return cmdCapability(command, { format }, io);
}

function runPrime(command: string, argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const args: PrimeArgs = { command, guidance: false, context: null, dashboard: false, orientation: false, format: "text" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null = null;
    if (a === "--guidance") args.guidance = true;
    else if (a === "--dashboard") args.dashboard = true;
    else if (a === "--orientation") args.orientation = true;
    else if (a === "--context") args.context = argv[++i];
    else if (a.startsWith("--context=")) args.context = a.slice("--context=".length);
    else if (a === "--format" || a.startsWith("--format=")) {
      v = a === "--format" ? argv[++i] : a.slice("--format=".length);
      if (v !== "text" && v !== "json" && v !== "yaml") {
        err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')\n`);
        return 2;
      }
      args.format = v;
    } else if (a === "--fields") {
      args.fields = argv[++i];
    } else if (a.startsWith("--fields=")) {
      args.fields = a.slice("--fields=".length);
    } else {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }
  return cmdPrime(args, io);
}

function runGate(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const parsed = parseCompactArgs(argv);
  if ("error" in parsed) {
    err(`${prog}: error: ${parsed.error}\n`);
    return 2;
  }
  try {
    return cmdGate(parsed, io);
  } catch (exc) {
    err(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}

function runDoctor(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const args: DoctorArgs = { installRoot: null, home: null, project: null, expectedVersion: null, expectCommand: [], format: "text" };
  let jsonFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--expected-version")) !== null) args.expectedVersion = v;
    else if ((v = value("--expect-command")) !== null) (args.expectCommand as string[]).push(v);
    else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json')\n`);
        return 2;
      }
      args.format = v;
    } else if (a === "--json") jsonFlag = true;
    else {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }
  if (jsonFlag) {
    emitDeprecationAlias("doctor --json", "doctor --format json", err);
    args.format = "json";
  }
  return cmdDoctor(args, io);
}

function readStdin(): string {
  try {
    return fsForHooks.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function runHook(name: string, argv: string[], io: Io): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const raw = io.stdin ? io.stdin() : readStdin();
  // Each hook owns its own stdout newline convention; do not wrap stdout here.
  switch (name) {
    case "session-start":
      return runSessionStart(raw);
    case "session-stop":
      return runSessionStop(raw);
    case "cursor-session-start":
      return runCursorSessionStart(raw);
    case "cursor-pre-tool-use":
      return runCursorPreToolUse(raw);
    case "validate-artifact": {
      const [rc, violations] = new HookCliAdapter().run(raw, null);
      for (const v of violations) err(`${v}\n`);
      return rc;
    }
    default:
      err(`agentera hook: unknown hook '${name}'\n`);
      return 2;
  }
}

function runUsage(argv: string[], io: Io, prog: string): number {
  const realOut = io.out ?? ((t: string) => process.stdout.write(t));
  const realErr = io.err ?? ((t: string) => process.stderr.write(t));
  let format = "text";
  let corpus: string | null = null;
  let project: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--format")) !== null) format = v;
    else if ((v = value("--corpus")) !== null) corpus = v;
    else if ((v = value("--project")) !== null) project = v;
    else {
      realErr(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }
  if (corpus !== null) {
    try {
      validatePathValue(corpus, "path");
    } catch (e) {
      realErr(`${prog}: error: argument --corpus: ${(e as Error).message}\n`);
      return 2;
    }
  }
  if (format !== "text" && format !== "json") {
    const syntax = "agentera usage [--format text|json] [--corpus PATH] [--project VALUE]";
    const example = "agentera usage --format json --project agentera";
    realErr(
      `Error: unsupported usage format '${format}'; valid formats: text, json. ` +
        `Syntax: ${syntax}. Example: ${example}\n`,
    );
    return 2;
  }
  const engineArgv: string[] = [];
  if (corpus !== null) engineArgv.push("--corpus", corpus);
  if (project !== null) engineArgv.push("--project", project);
  if (format === "json") engineArgv.push("--json");
  return usageMain(engineArgv, {
    out: (t) => realOut(t + "\n"),
    err: (t) => realErr(t + "\n"),
  });
}

function runUpgrade(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const args: UpgradeArgs = {
    installRoot: null,
    home: null,
    project: null,
    expectedVersion: null,
    yes: false,
    dryRun: false,
    format: "text",
  };
  let jsonFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--expected-version")) !== null) args.expectedVersion = v;
    else if ((v = value("--runtime")) !== null) void v; // accepted; self-contained ignores
    else if ((v = value("--only")) !== null) void v; // accepted; self-contained ignores
    else if ((v = value("--opencode-config-dir")) !== null) void v; // accepted; ignored
    else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") void 0; // accepted; no install to force in self-contained mode
    else if (a === "--update-packages") void 0; // accepted; ignored
    else if (a === "--json") jsonFlag = true;
    else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json')\n`);
        return 2;
      }
      args.format = v;
    } else {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    }
  }
  if (jsonFlag) args.format = "json";
  return cmdUpgrade(args, io);
}

function runVerify(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const args: VerifyArgs = {
    family: null,
    target: null,
    format: "text",
    installedRoot: null,
    realNpx: false,
    live: false,
    yes: false,
    run: false,
    dryRun: false,
    skill: null,
    timeout: 120,
    parallel: 1,
    runtime: "auto",
    fixtures: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        err(`${prog}: error: argument --format: invalid choice: '${v}' (choose from 'text', 'json')\n`);
        return 2;
      }
      args.format = v;
    } else if ((v = value("--installed-root")) !== null) args.installedRoot = v;
    else if ((v = value("--skill")) !== null) args.skill = v;
    else if ((v = value("--runtime")) !== null) args.runtime = v;
    else if ((v = value("--timeout")) !== null) args.timeout = Number(v);
    else if ((v = value("--parallel")) !== null) args.parallel = Number(v);
    else if (a === "--real-npx") args.realNpx = true;
    else if (a === "--live") args.live = true;
    else if (a === "--yes") args.yes = true;
    else if (a === "--run") args.run = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      err(`${prog}: error: unrecognized arguments: ${a}\n`);
      return 2;
    } else {
      positionals.push(a);
    }
  }
  args.family = positionals[0] ?? null;
  args.target = positionals[1] ?? null;
  args.fixtures = positionals.slice(2);
  return cmdVerify(args, io);
}

export function main(argv: string[], io: Io = {}): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const args = argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  switch (command) {
    case "prime":
      return runPrime("prime", rest, io, "agentera prime");
    case "doctor":
      return runDoctor(rest, io, "agentera doctor");
    case "usage":
      return runUsage(rest, io, "agentera usage");
    case "upgrade":
      return runUpgrade(rest, io, "agentera upgrade");
    case "verify":
      emitDeprecationAlias("verify", "check verify", err);
      return runVerify(rest, io, "agentera verify");
    case "hook": {
      const name = rest[0];
      if (!name) {
        err("agentera hook: error: the following arguments are required: hook_name\n");
        return 2;
      }
      return runHook(name, rest.slice(1), io);
    }
    case "hej":
      emitDeprecationAlias("hej", "prime", err);
      return runPrime("hej", rest, io, "agentera hej");
    case "schema":
      return runSchema(rest, io, "agentera schema");
    case "describe":
      emitDeprecationAlias("describe", "schema", err);
      return runSchema(rest, io, "agentera describe");
    case "lint":
      emitDeprecationAlias("lint", "check lint", err);
      return runLint(rest, io);
    case "check": {
      const sub = rest[0];
      if (!sub) {
        err("agentera check: error: the following arguments are required: check_command\n");
        return 2;
      }
      if (sub === "validate") return runValidate(rest.slice(1), io, "agentera check validate");
      if (sub === "verify") return runVerify(rest.slice(1), io, "agentera check verify");
      if (sub === "lint") return runLint(rest.slice(1), io, "agentera check lint");
      if (sub === "backfill") return runBackfill(rest.slice(1), io, "agentera check backfill");
      if (sub === "compact") {
        const subArgs = rest.slice(1);
        const mode = compactModeOf(subArgs);
        if (mode === "fix") return runCompact(subArgs, io, "agentera check compact");
        return runGate(subArgs, io, "agentera check compact");
      }
      err(`agentera: unknown or not-yet-ported check subcommand: ${sub}\n`);
      return 1;
    }
    case "state": {
      const sub = rest[0];
      if (!sub) {
        err("agentera state: error: the following arguments are required: state_command\n");
        return 2;
      }
      if (sub === "query") return runQuery(rest.slice(1), io, "agentera state query");
      if (isPortedStateCommand(sub)) return runState(sub, rest.slice(1), io, `agentera state ${sub}`);
      err(`agentera: unknown or not-yet-ported state subcommand: ${sub}\n`);
      return 1;
    }
    case "query":
      emitDeprecationAlias("query", "state query", err);
      return runQuery(rest, io, "agentera query");
    case "compact":
      emitDeprecationAlias("compact", "check compact", err);
      return runCompact(rest, io, "agentera compact");
    case "gate":
      emitDeprecationAlias("gate", "check compact", err);
      return runGate(rest, io, "agentera gate");
    case "validate":
      emitDeprecationAlias("validate", "check validate", err);
      return runValidate(rest, io, "agentera validate");
    default:
      if (command && CAPABILITY_ROUTING_NAMES.includes(command)) {
        return runCapability(command, rest, io, `agentera ${command}`);
      }
      if (command && isPortedStateCommand(command)) {
        emitDeprecationAlias(command, `state ${command}`, err);
        return runState(command, rest, io, `agentera ${command}`);
      }
      err(`agentera: unknown or not-yet-ported command: ${command ?? "(none)"}\n`);
      return 1;
  }
}
