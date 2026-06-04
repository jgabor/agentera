import { cmdPrime, PrimeArgs } from "../commands/prime.js";
import { cmdCapability } from "../commands/capability.js";
import { asEnvelopeFormat, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";

export function runCapability(command: string, argv: string[], io: Io, prog: string): number {
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

export function runPrime(command: string, argv: string[], io: Io, prog: string): number {
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