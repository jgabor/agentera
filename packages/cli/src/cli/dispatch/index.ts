import { isPortedStateCommand } from "../commands/state/index.js";
import { runEntityMigrate } from "../commands/entityMigrate.js";
import { CAPABILITY_ROUTING_NAMES } from "../commands/capability.js";
import { runRouteRequest } from "../commands/route.js";
import {
  printCommandHelp,
  printStateHelp,
  printTopLevelHelp,
  splitHelpArgs,
  stateCommandNames,
} from "../help.js";
import {
  compactModeOf,
  runCompact,
  runDurability,
  runLint,
  runSchema,
  runValidate,
} from "./check.js";
import { runQuery, runState } from "./state.js";
import { runCapability, runPrime } from "./prime.js";
import {
  runAppHome,
  runDoctor,
  runGate,
  runHook,
  readStdin,
  runReport,
  runUpgrade,
  runUsage,
  runVerify,
  runVersion,
} from "./lifecycle.js";
import { detectTopLevelFormat, emitDeprecationAlias, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";
import { isWriteVerb } from "../../state/write/operations.js";
import { REMOVED_TOP_LEVEL_CORRECTIONS } from "../commands/schema.js";
import {
  enforceCompletedEntityCutover,
  migrationProject,
  requestedMigrationFailureFormat,
  requiresCompletedEntityCutover,
} from "../migrationRequired.js";
import { isProjectBoundHook, parseProjectHookInput, type ParsedProjectHookInput } from "../../hooks/projectHookInput.js";

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

  if (command && REMOVED_TOP_LEVEL_CORRECTIONS[command]) {
    const canonical = REMOVED_TOP_LEVEL_CORRECTIONS[command];
    const example = `agentera ${canonical} --format json`;
    return emitInvalidInput(io, {
      format: detectTopLevelFormat(rest),
      body: {
        class: "unsupported_target",
        message: `unknown or not-yet-ported command: ${command}; this top-level name was removed, use '${canonical}'`,
        valid_values: [canonical],
        syntax: `agentera ${canonical} [options]`,
        example,
        recovery: `Run ${example}; no state was changed by the rejected command.`,
      },
    });
  }

  let projectHookInput: ParsedProjectHookInput | undefined;
  const hookName = rest[0] ?? "";
  if (command === "hook" && isProjectBoundHook(hookName)) {
    const raw = io.stdin ? io.stdin() : readStdin();
    projectHookInput = parseProjectHookInput(hookName, raw);
  }

  if (requiresCompletedEntityCutover(args)) {
    const failure = enforceCompletedEntityCutover(
      projectHookInput?.projectRoot ?? migrationProject(args),
      requestedMigrationFailureFormat(args),
      io,
    );
    if (failure !== null) return failure;
  }

  switch (command) {
    case "--version":
    case "version":
      return runVersion(rest, io);
    case "prime":
      return runPrime("prime", rest, io, "agentera prime");
    case "app-home":
      return runAppHome(rest, io, "agentera app-home");
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
      return runHook(name, rest.slice(1), io, projectHookInput);
    }
    case "schema":
      return runSchema(rest, io, "agentera schema");
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
            valid_values: ["validate", "verify", "lint", "compact", "durability"],
          },
        });
      }
      if (sub === "validate") return runValidate(rest.slice(1), io, "agentera check validate");
      if (sub === "verify") return runVerify(rest.slice(1), io, "agentera check verify");
      if (sub === "durability")
        return runDurability(rest.slice(1), io, "agentera check durability");
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
          valid_values: ["validate", "verify", "lint", "compact", "durability"],
        },
      });
    }
    case "state": {
      const sub = rest[0];
      const stateCommands = stateCommandNames();
      const stateSyntax = printStateHelp()
        .split("\n", 1)[0]
        .replace(/^usage:\s*/, "");
      const stateExample = "agentera state progress list --format json";
      if (!sub) {
        return emitInvalidInput(io, {
          format: "text",
          body: {
            class: "missing_argument",
            message: "the following arguments are required: state_command",
            valid_values: stateCommands,
            syntax: stateSyntax,
            example: stateExample,
          },
        });
      }
      if (sub === "query") return runQuery(rest.slice(1), io, "agentera state query");
      if (sub === "migrate" && rest[1] === "entities") return runEntityMigrate(rest.slice(2), io);
      if (isPortedStateCommand(sub) || isWriteVerb(rest[1]) || rest[1] === "get")
        return runState(sub, rest.slice(1), io, `agentera state ${sub}`);
      return emitInvalidInput(io, {
        format: "text",
        body: {
          class: "unsupported_target",
          message: `unknown or not-yet-ported state subcommand: ${sub}`,
          valid_values: stateCommands,
          syntax: stateSyntax,
          example: stateExample,
        },
      });
    }
    case "query":
      emitDeprecationAlias("query", "state query", err);
      return runQuery(rest, io, "agentera query");
    case "route":
      if (rest[0] === "request") return runRouteRequest(rest.slice(1), io);
      return emitInvalidInput(io, {
        format: detectTopLevelFormat(rest),
        body: {
          class: "unsupported_target",
          message: "route requires the request subcommand",
          valid_values: ["request"],
          syntax: "agentera route request --input PATH --format json",
          example: "agentera route request --input - --format json",
        },
      });
    case "compact":
      emitDeprecationAlias("compact", "check compact", err);
      return compactModeOf(rest) === "fix"
        ? runCompact(rest, io, "agentera compact")
        : runGate(rest, io, "agentera compact");
    case "validate":
      emitDeprecationAlias("validate", "check validate", err);
      return runValidate(rest, io, "agentera validate");
    default:
      if (command && CAPABILITY_ROUTING_NAMES.includes(command)) {
        return runCapability(command, rest, io, `agentera ${command}`);
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
