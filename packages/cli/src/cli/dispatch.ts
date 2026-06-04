import { cmdPrime, PrimeArgs } from "./commands/prime.js";
import { cmdLint, LintArgs } from "./commands/lint.js";
import { cmdState, isPortedStateCommand, StateArgs } from "./commands/state/index.js";
import { COMMAND_FILTERS } from "./stateQuery.js";
import { cmdQuery, QueryArgs } from "./commands/query.js";
import { cmdCompact, cmdGate, CompactArgs } from "./commands/compact.js";
import { cmdSchema } from "./commands/schema.js";
import { cmdDoctor, DoctorArgs } from "./commands/doctor.js";
import { cmdUpgrade, UpgradeArgs, type UpgradeOnlyPhase } from "./commands/upgrade.js";
import { cmdVerify, VerifyArgs } from "./commands/verify.js";
import { cmdReport, ReportArgs } from "./commands/report.js";
import { runSessionStart } from "../hooks/sessionStart.js";
import { runSessionStop } from "../hooks/sessionStop.js";
import { runCursorSessionStart } from "../hooks/cursorSessionStart.js";
import { runCursorPreToolUse } from "../hooks/cursorPreToolUse.js";
import { HookCliAdapter } from "../hooks/validateArtifact/index.js";
import fsForHooks from "node:fs";
import { usageMain } from "../analytics/usageStats.js";
import { validatePathValue } from "./argvalidate.js";
import {
  emitInvalidInput,
  type InvalidInputErrorBody,
} from "./errors.js";
import { cmdCapability, CAPABILITY_ROUTING_NAMES } from "./commands/capability.js";
import {
  printCommandHelp,
  printDoctorHelp,
  printTopLevelHelp,
  printUpgradeHelp,
  splitHelpArgs,
  wantsHelp,
} from "./help.js";
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

/**
 * Map a legacy parse-error string (the kind returned by `parse*Args`) to the
 * canonical invalid-input envelope body. Lets the parse functions keep their
 * simple `{ error: string }` shape while every surface's error path still
 * funnels through `emitInvalidInput` for the frozen envelope contract.
 */
function classifyParseError(raw: string): InvalidInputErrorBody {
  const required = /^the following arguments are required: (.+)$/.exec(raw);
  if (required) {
    return { class: "missing_argument", message: raw };
  }
  const unrecognized = /^unrecognized arguments: (.+)$/.exec(raw);
  if (unrecognized) {
    return { class: "unrecognized_argument", message: raw };
  }
  const choice = /^argument (--[\w-]+): invalid choice: '([^']+)' \(choose from (.+)\)$/.exec(raw);
  if (choice) {
    const validValues = [...choice[3].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    return {
      class: "invalid_choice",
      message: raw,
      valid_values: validValues,
    };
  }
  const intBad = /^argument (--[\w-]+): invalid int value: '([^']+)'$/.exec(raw);
  if (intBad) {
    return { class: "invalid_int", message: raw };
  }
  const mutex = /^argument (--[\w-]+): not allowed with argument (--[\w-]+)$/.exec(raw);
  if (mutex) {
    return { class: "mutually_exclusive", message: raw };
  }
  return { class: "unrecognized_argument", message: raw };
}

/** Coerce the loose `string` format field on parsed args to the literal union. */
function asEnvelopeFormat(format: string | undefined | null): "text" | "json" {
  return format === "json" ? "json" : "text";
}

/**
 * Scan a top-level argv slice for `--format json` (or `--format=json`) so
 * main() can decide whether to route its error envelope to stdout or stderr.
 * Unknown format values fall through to "text" — the user will discover the
 * mis-spelling when the underlying command runs.
 */
function detectTopLevelFormat(args: string[]): "text" | "json" {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format") {
      const v = args[++i];
      if (v === "json" || v === "text" || v === "yaml") return v === "json" ? "json" : "text";
    } else if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v === "json" || v === "text" || v === "yaml") return v === "json" ? "json" : "text";
    }
  }
  return "text";
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
  const parsed = parseLintArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdLint(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
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
  const parsed = parseStateArgs(command, argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdState(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
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
  const parsed = parseQueryArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdQuery(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function compactModeOf(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") return "fix";
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
    if (a === "--apply") {
      args.mode = "fix";
    } else if ((v = value("--project")) !== null) args.project = v;
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
  const parsed = parseCompactArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdCompact(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runValidate(argv: string[], io: Io, prog: string): number {
  let family: string | null = null;
  let capabilityTarget: string | null = null;
  let artifactFlag: string | null = null;
  let fileFlag: string | null = null;
  let cwdFlag: string | null = null;
  let format: "text" | "json" = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format,
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      format = v;
    } else if (a.startsWith("--format=")) {
      const v = a.slice("--format=".length);
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format,
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      format = v;
    } else if (a === "--artifact" || a.startsWith("--artifact=")) {
      artifactFlag = a === "--artifact" ? argv[++i] : a.slice("--artifact=".length);
    } else if (a === "--file" || a.startsWith("--file=")) {
      fileFlag = a === "--file" ? argv[++i] : a.slice("--file=".length);
    } else if (a === "--cwd" || a.startsWith("--cwd=")) {
      cwdFlag = a === "--cwd" ? argv[++i] : a.slice("--cwd=".length);
    } else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format,
        body: {
          class: "unrecognized_argument",
          message: `unrecognized arguments: ${a}`,
        },
      });
    } else if (family === null) {
      family = a;
    } else if (capabilityTarget === null) {
      capabilityTarget = a;
    } else {
      return emitInvalidInput(io, {
        format,
        body: {
          class: "unrecognized_argument",
          message: `unrecognized arguments: ${a}`,
        },
      });
    }
  }
  if (family === null) {
    return emitInvalidInput(io, {
      format,
      body: {
        class: "missing_argument",
        message: "the following arguments are required: validate_family",
        valid_values: [
          "cross-capability",
          "lifecycle-adapters",
          "app-home-contract",
          "vocabularyAuthority",
          "selfAudit",
          "release-metadata",
          "capability",
          "capability-contract",
          "descriptors",
          "artifact",
        ],
        example: "agentera check validate cross-capability",
      },
    });
  }
  try {
    if (family === "capability") {
      if (capabilityTarget === null) {
        return emitInvalidInput(io, {
          format,
          body: {
            class: "missing_argument",
            message: "the following arguments are required: target",
            example: "agentera check validate capability planera",
          },
        });
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
        return emitInvalidInput(io, {
          format,
          body: {
            class: "missing_argument",
            message: "the following arguments are required: --artifact",
            example: "agentera check validate artifact --artifact plan",
          },
        });
      }
      return cmdValidateArtifact({ artifact: artifactFlag, file: fileFlag, cwd: cwdFlag, format }, io);
    }
    if (isDelegatedValidateFamily(family)) {
      return cmdValidate(family, { format }, io);
    }
    return emitInvalidInput(io, {
      format,
      body: {
        class: "unsupported_target",
        message: `validate family not yet ported: ${family}`,
        valid_values: [
          "cross-capability",
          "lifecycle-adapters",
          "app-home-contract",
          "vocabularyAuthority",
          "selfAudit",
          "release-metadata",
          "capability",
          "capability-contract",
          "descriptors",
          "artifact",
        ],
      },
    });
  } catch (exc) {
    return emitInvalidInput(io, {
      format,
      body: {
        class: "unsupported_target",
        message: (exc as Error).message,
      },
    });
  }
}

function runSchema(argv: string[], io: Io, prog: string): number {
  let format = "json";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null = null;
    if (a === "--format") v = argv[++i];
    else if (a.startsWith("--format=")) v = a.slice("--format=".length);
    else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
    if (v !== "json" && v !== "yaml") {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: {
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${v}' (choose from 'json', 'yaml')`,
          valid_values: ["json", "yaml"],
        },
      });
    }
    format = v;
  }
  try {
    return cmdSchema({ format }, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runCapability(command: string, argv: string[], io: Io, prog: string): number {
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
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
    if (v !== "text" && v !== "json" && v !== "yaml") {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: {
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')`,
          valid_values: ["text", "json", "yaml"],
        },
      });
    }
    format = v;
  }
  try {
    return cmdCapability(command, { format }, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runPrime(command: string, argv: string[], io: Io, prog: string): number {
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
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')`,
            valid_values: ["text", "json", "yaml"],
          },
        });
      }
      args.format = v;
    } else if (a === "--fields") {
      args.fields = argv[++i];
    } else if (a.startsWith("--fields=")) {
      args.fields = a.slice("--fields=".length);
    } else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  try {
    return cmdPrime(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runGate(argv: string[], io: Io, prog: string): number {
  const parsed = parseCompactArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdGate(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runDoctor(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  if (wantsHelp(argv)) {
    out(printDoctorHelp() + "\n");
    return 0;
  }
  const args: DoctorArgs = {
    installRoot: null,
    home: null,
    project: null,
    expectedVersion: null,
    expectCommand: [],
    smoke: false,
    allowLiveModel: false,
    format: "text",
  };
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
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      args.format = v;
    } else if (a === "--json") jsonFlag = true;
    else if (a === "--smoke") args.smoke = true;
    else if (a === "--allow-live-model") args.allowLiveModel = true;
    else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  if (jsonFlag) {
    emitDeprecationAlias("doctor --json", "doctor --format json", err);
    args.format = "json";
  }
  try {
    return cmdDoctor(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
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
      return emitInvalidInput(io, {
        format: "text",
        body: {
          class: "unsupported_target",
          message: `unknown hook '${name}'`,
          valid_values: [
            "session-start",
            "session-stop",
            "cursor-session-start",
            "cursor-pre-tool-use",
            "validate-artifact",
          ],
        },
      });
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
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  if (corpus !== null) {
    try {
      validatePathValue(corpus, "path");
    } catch (e) {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: {
          class: "invalid_format",
          message: `argument --corpus: ${(e as Error).message}`,
        },
      });
    }
  }
  if (format !== "text" && format !== "json") {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(format),
      body: {
        class: "invalid_choice",
        message: `unsupported usage format '${format}'; valid formats: text, json.`,
        valid_values: ["text", "json"],
        syntax: "agentera usage [--format text|json] [--corpus PATH] [--project VALUE]",
        example: "agentera usage --format json --project agentera",
      },
    });
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
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  if (wantsHelp(argv)) {
    out(printUpgradeHelp() + "\n");
    return 0;
  }
  const args: UpgradeArgs = {
    installRoot: null,
    home: null,
    project: null,
    expectedVersion: null,
    channel: null,
    yes: false,
    dryRun: false,
    only: [],
    force: false,
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
    else if ((v = value("--channel")) !== null) args.channel = v;
    else if ((v = value("--target-major")) !== null) {
      void v;
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: {
          class: "unsupported_target",
          message: "--target-major was removed; use --channel with dry-run preview then --yes",
        },
      });
    }
    else if ((v = value("--runtime")) !== null) void v; // accepted; orchestrator uses fixture runtimes
    else if ((v = value("--only")) !== null) {
      if (v !== "artifacts" && v !== "runtime" && v !== "cleanup") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --only: invalid choice: '${v}' (choose from 'artifacts', 'runtime', 'cleanup')`,
            valid_values: ["artifacts", "runtime", "cleanup"],
          },
        });
      }
      (args.only as UpgradeOnlyPhase[]).push(v);
    }
    else if ((v = value("--opencode-config-dir")) !== null) void v; // accepted; ignored
    else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--update-packages") void 0; // deferred for 3.x channel model
    else if (a === "--json") jsonFlag = true;
    else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      args.format = v;
    } else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  if (jsonFlag) args.format = "json";
  try {
    return cmdUpgrade(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runVerify(argv: string[], io: Io, prog: string): number {
  const args: VerifyArgs = {
    family: null,
    target: null,
    format: "text",
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
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      args.format = v;
    } else if ((v = value("--skill")) !== null) args.skill = v;
    else if ((v = value("--runtime")) !== null) args.runtime = v;
    else if ((v = value("--timeout")) !== null) args.timeout = Number(v);
    else if ((v = value("--parallel")) !== null) args.parallel = Number(v);
    else if (a === "--run") args.run = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    } else {
      positionals.push(a);
    }
  }
  args.family = positionals[0] ?? null;
  args.target = positionals[1] ?? null;
  args.fixtures = positionals.slice(2);
  try {
    return cmdVerify(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

function runReport(argv: string[], io: Io, prog: string): number {
  const args: ReportArgs = {
    action: null,
    format: "text",
    project: null,
    dryRun: false,
    consent: null,
    projectRoot: [],
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
    if ((v = value("--format")) !== null) args.format = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--consent")) !== null) {
      if (v !== "local-history") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --consent: invalid choice: '${v}' (choose from 'local-history')`,
            valid_values: ["local-history"],
          },
        });
      }
      args.consent = v;
    } else if ((v = value("--project-root")) !== null) (args.projectRoot as string[]).push(v);
    else if ((v = value("--output")) !== null) args.output = v;
    else if ((v = value("--codex-sessions-dir")) !== null) args.codexSessionsDir = v;
    else if ((v = value("--claude-projects-dir")) !== null) args.claudeProjectsDir = v;
    else if ((v = value("--opencode-conversations-dir")) !== null) args.opencodeConversationsDir = v;
    else if ((v = value("--copilot-conversations-dir")) !== null) args.copilotConversationsDir = v;
    else if ((v = value("--cursor-projects-dir")) !== null) args.cursorProjectsDir = v;
    else if ((v = value("--cursor-chats-dir")) !== null) args.cursorChatsDir = v;
    else if (a === "--no-codex") args.noCodex = true;
    else if (a === "--no-claude") args.noClaude = true;
    else if (a === "--no-opencode") args.noOpencode = true;
    else if (a === "--no-copilot") args.noCopilot = true;
    else if (a === "--no-cursor") args.noCursor = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    } else {
      positionals.push(a);
    }
  }
  args.action = positionals[0] ?? null;
  try {
    return cmdReport(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

export function main(argv: string[], io: Io = {}): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    out(printTopLevelHelp() + "\n");
    return 0;
  }
  const command = args[0];
  const { args: rest, help } = splitHelpArgs(args.slice(1));
  if (help) {
    const text = printCommandHelp(command, rest);
    if (text) {
      out(text + "\n");
      return 0;
    }
    return emitInvalidInput(io, {
      format: "text",
      body: {
        class: "unsupported_target",
        message: `unknown or not-yet-ported command: ${command}`,
      },
    });
  }

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
    case "report":
      return runReport(rest, io, "agentera report");
    case "stats":
      emitDeprecationAlias("stats", "report", err);
      return runReport(rest, io, "agentera stats");
    case "hook": {
      const name = rest[0];
      if (!name) {
        return emitInvalidInput(io, {
          format: "text",
          body: {
            class: "missing_argument",
            message: "the following arguments are required: hook_name",
            valid_values: [
              "session-start",
              "session-stop",
              "cursor-session-start",
              "cursor-pre-tool-use",
              "validate-artifact",
            ],
          },
        });
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
        return emitInvalidInput(io, {
          format: "text",
          body: {
            class: "missing_argument",
            message: "the following arguments are required: check_command",
            valid_values: ["validate", "verify", "lint", "compact"],
          },
        });
      }
      if (sub === "validate") return runValidate(rest.slice(1), io, "agentera check validate");
      if (sub === "verify") return runVerify(rest.slice(1), io, "agentera check verify");
      if (sub === "lint") return runLint(rest.slice(1), io, "agentera check lint");
      if (sub === "compact") {
        const subArgs = rest.slice(1);
        const mode = compactModeOf(subArgs);
        if (mode === "fix") return runCompact(subArgs, io, "agentera check compact");
        return runGate(subArgs, io, "agentera check compact");
      }
      return emitInvalidInput(io, {
        format: "text",
        body: {
          class: "unsupported_target",
          message: `unknown or not-yet-ported check subcommand: ${sub}`,
          valid_values: ["validate", "verify", "lint", "compact"],
        },
      });
    }
    case "state": {
      const sub = rest[0];
      if (!sub) {
        return emitInvalidInput(io, {
          format: "text",
          body: {
            class: "missing_argument",
            message: "the following arguments are required: state_command",
            valid_values: [
              "progress",
              "plan",
              "health",
              "docs",
              "objective",
              "experiments",
              "todo",
              "decisions",
              "query",
            ],
          },
        });
      }
      if (sub === "query") return runQuery(rest.slice(1), io, "agentera state query");
      if (isPortedStateCommand(sub)) return runState(sub, rest.slice(1), io, `agentera state ${sub}`);
      return emitInvalidInput(io, {
        format: "text",
        body: {
          class: "unsupported_target",
          message: `unknown or not-yet-ported state subcommand: ${sub}`,
          valid_values: [
            "progress",
            "plan",
            "health",
            "docs",
            "objective",
            "experiments",
            "todo",
            "decisions",
            "query",
          ],
        },
      });
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
      return emitInvalidInput(io, {
        format: "text",
        body: {
          class: "unsupported_target",
          message: `unknown or not-yet-ported command: ${command ?? "(none)"}`,
        },
      });
  }
}
