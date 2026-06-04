import { isPortedStateCommand } from "../commands/state/index.js";
import { CAPABILITY_ROUTING_NAMES } from "../commands/capability.js";
import { printCommandHelp, printTopLevelHelp, splitHelpArgs } from "../help.js";
import { compactModeOf, runCompact, runLint, runSchema, runValidate } from "./check.js";
import { runQuery, runState } from "./state.js";
import { runCapability, runPrime } from "./prime.js";
import { runDoctor, runGate, runHook, runReport, runUpgrade, runUsage, runVerify } from "./lifecycle.js";
import { emitDeprecationAlias, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";

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
