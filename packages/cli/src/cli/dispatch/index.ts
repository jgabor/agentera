import { CAPABILITY_ROUTING_NAMES } from "../commands/capability.js";
import { runRouteEvaluation, runRouteReceipt, runRouteRequest } from "../commands/route.js";
import { preCutoverCommand } from "../preCutoverCommand.js";
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
import { entityListFamily } from "../../state/entityRetrievalHelp.js";
import { ENTITY_LIST_RUNTIME_FAMILIES, runtimeEntityFamiliesForCommand, type EntityListRuntimeFamilyKey } from "../../state/entityListRuntimeRegistry.js";
import { runCapability, runPrime } from "./prime.js";
import {
  runAppHome,
  runDoctor,
  runGate,
  runReport,
  runUpgrade,
  runUsage,
  runVerify,
  runVersion,
} from "./lifecycle.js";
import { detectTopLevelFormat, emitDeprecationAlias, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";
import { applyOutputPolicy } from "../outputPolicy.js";
import { verbsForArtifact } from "../../state/write/operations.js";
import { REMOVED_TOP_LEVEL_CORRECTIONS } from "../commands/schema.js";
import {
  enforceCompletedEntityCutover,
  migrationProject,
  requestedMigrationFailureFormat,
  requiresCompletedEntityCutover,
} from "../migrationRequired.js";
import { enforceProductV1Eol } from "../productV1Eol.js";

function splitNestedSubcommand(argv: string[]): [string | undefined, string[]] {
  let subcommand: string | undefined;
  const nestedArgs: string[] = [];
  const formatArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--format") {
      formatArgs.push(token);
      if (argv[index + 1] !== undefined) formatArgs.push(argv[index + 1]);
      index++;
      continue;
    }
    if (token.startsWith("--format=")) {
      formatArgs.push(token);
      continue;
    }
    if (subcommand === undefined) subcommand = token;
    else nestedArgs.push(token);
  }
  return [subcommand, [...nestedArgs, ...formatArgs]];
}

export function main(argv: string[], io: Io = {}): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const requestedArgs = argv.slice(2);
  const governedArgs = applyOutputPolicy(requestedArgs, io);
  if (typeof governedArgs === "number") return governedArgs;
  const args = governedArgs;
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
      format: "json",
      body: {
        class: "unsupported_target",
        message: `unknown or not-yet-ported command: ${command}`,
      },
    });
  }

  if (command && REMOVED_TOP_LEVEL_CORRECTIONS[command]) {
    const canonical = REMOVED_TOP_LEVEL_CORRECTIONS[command];
    const canonicalTokens = canonical.split(" ");
    const runtimeFamily = canonicalTokens[0] === "state"
      ? ENTITY_LIST_RUNTIME_FAMILIES.find(({ commandTokens }) => commandTokens.join(" ") === canonicalTokens.slice(1).join(" "))
      : undefined;
    const family = runtimeFamily ? entityListFamily(runtimeFamily.key as EntityListRuntimeFamilyKey) : undefined;
    const example = family
      ? family.bareRecovery ?? `agentera state ${family.commandTokens.join(" ")} list --limit ${family.bounds.default}`
      : `agentera ${canonical}`;
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

  const productV1Reset = command === "upgrade" && rest.includes("--reset-product-v1");
  if (command !== "--version" && command !== "version" && !productV1Reset) {
    const failure = enforceProductV1Eol(
      migrationProject(args),
      requestedMigrationFailureFormat(args),
      io,
    );
    if (failure !== null) return failure;
  }

  // Retained-reference validation audits package source, not project state. It
  // must report its source-checkout boundary before project migration checks.
  const sourceOnlyReferenceValidation =
    args[0] === "check" && args[1] === "validate" && ["retained-references", "activation-conjunction"].includes(args[2] ?? "");
  if (!sourceOnlyReferenceValidation && requiresCompletedEntityCutover(args)) {
    const failure = enforceCompletedEntityCutover(
      migrationProject(args),
      requestedMigrationFailureFormat(args),
      io,
      args,
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
      return runVerify(rest, io, "agentera verify");
    case "report":
      return runReport(rest, io, "agentera report");
    case "stats":
      emitDeprecationAlias("stats", "report", err);
      return runReport(rest, io, "agentera stats");
    case "schema":
      return runSchema(rest, io, "agentera schema");
    case "lint":
      return runLint(rest, io);
    case "check": {
      const [sub, subArgs] = splitNestedSubcommand(rest);
      if (!sub) {
        return emitInvalidInput(io, {
          format: "json",
          body: {
            class: "missing_argument",
            message: "the following arguments are required: check_command",
            valid_values: ["validate", "verify", "lint", "compact", "durability"],
          },
        });
      }
      if (sub === "validate") return runValidate(subArgs, io, "agentera check validate");
      if (sub === "verify") return runVerify(subArgs, io, "agentera check verify");
      if (sub === "durability")
        return runDurability(subArgs, io, "agentera check durability");
      if (sub === "lint") return runLint(subArgs, io, "agentera check lint");
      if (sub === "compact") {
        const mode = compactModeOf(subArgs);
        if (mode === "fix") return runCompact(subArgs, io, "agentera check compact");
        return runGate(subArgs, io, "agentera check compact");
      }
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: "unsupported_target",
          message: `unknown or not-yet-ported check subcommand: ${sub}`,
          valid_values: ["validate", "verify", "lint", "compact", "durability"],
        },
      });
    }
    case "state": {
      const [sub, subArgs] = splitNestedSubcommand(rest);
      const stateCommands = stateCommandNames();
      const stateSyntax = printStateHelp()
        .split("\n", 1)[0]
        .replace(/^usage:\s*/, "");
      const stateExample = "agentera state progress list";
      if (!sub) {
        return emitInvalidInput(io, {
          format: detectTopLevelFormat(rest),
          body: {
            class: "missing_argument",
            message: "the following arguments are required: state_command",
            valid_values: stateCommands,
            syntax: stateSyntax,
            example: stateExample,
          },
        });
      }
      if (sub === "query") return runQuery(subArgs, io, "agentera state query");
      if (runtimeEntityFamiliesForCommand(sub).length > 0 || verbsForArtifact(sub).some((verb) => verb === subArgs[0]))
        return runState(sub, subArgs, io, `agentera state ${sub}`);
      return emitInvalidInput(io, {
        format: detectTopLevelFormat(rest),
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
      if (rest[0] === "receipt") return runRouteReceipt(rest.slice(1), io);
      if (rest[0] === "evaluate") return runRouteEvaluation(rest.slice(1), io);
      return emitInvalidInput(io, {
        format: detectTopLevelFormat(rest),
        body: {
          class: "unsupported_target",
          message: "route requires the request subcommand",
            valid_values: ["request", "receipt", "evaluate"],
            syntax: `${preCutoverCommand("route <request|receipt> --input PATH")} | ${preCutoverCommand("route evaluate")}`,
          example: preCutoverCommand("route receipt --input -"),
        },
      });
    case "compact":
      return compactModeOf(rest) === "fix"
        ? runCompact(rest, io, "agentera compact")
        : runGate(rest, io, "agentera compact");
    case "validate":
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
