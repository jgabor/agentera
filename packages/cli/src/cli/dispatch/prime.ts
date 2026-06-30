import { cmdPrime, PrimeArgs } from "../commands/prime.js";
import { cmdCapability } from "../commands/capability.js";
import { makeArgvValueReader } from "./argvParser.js";
import { asEnvelopeFormat, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";

export function runCapability(command: string, argv: string[], io: Io, prog: string): number {
  let format = "text";
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null = null;
    if ((v = value("--format")) !== null) {
      // format handled below
    } else if (a === "--fields" || a.startsWith("--fields=")) {
      // accepted by the parser but unused by capability routing
      if (a === "--fields") i++;
      continue;
    } else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
    if (v !== null) {
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
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null = null;
    if (a === "--guidance") args.guidance = true;
    else if (a === "--dashboard") args.dashboard = true;
    else if (a === "--orientation") args.orientation = true;
    else if ((v = value("--context")) !== null) args.context = v;
    else if ((v = value("--format")) !== null) {
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
    } else if ((v = value("--fields")) !== null) {
      args.fields = v;
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