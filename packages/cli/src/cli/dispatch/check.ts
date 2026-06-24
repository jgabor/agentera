import { cmdLint, LintArgs } from "../commands/lint.js";
import { cmdCompact, cmdGate, CompactArgs } from "../commands/compact.js";
import { cmdSchema } from "../commands/schema.js";
import {
  cmdValidate,
  cmdValidateCapability,
  cmdValidateCapabilityContract,
  cmdValidateArtifact,
  cmdValidateDescriptors,
  isDelegatedValidateFamily,
} from "../commands/validate.js";
import { LEGACY_PYTHON_PARITY_FLAG } from "../../validate/lifecycleAdapters.js";
import { makeArgvValueReader } from "./argvParser.js";
import { asEnvelopeFormat, classifyParseError, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";

/** Minimal flag parser for the `lint` command surface. */
export function parseLintArgs(argv: string[]): LintArgs | { error: string } {
  const args: LintArgs = { artifact: "", file: null, text: null, strict: false, format: "text" };
  let sawArtifact = false;
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
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

export function runLint(argv: string[], io: Io, prog = "agentera lint"): number {
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


export function compactModeOf(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") return "fix";
    if (argv[i] === "--mode") return argv[i + 1] ?? "check";
    if (argv[i].startsWith("--mode=")) return argv[i].slice("--mode=".length);
  }
  return "check";
}

export function parseCompactArgs(argv: string[]): CompactArgs | { error: string } {
  const args: CompactArgs = { project: null, mode: "check", format: "text" };
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
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

export function runCompact(argv: string[], io: Io, prog: string): number {
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

export function runValidate(argv: string[], io: Io, prog: string): number {
  let family: string | null = null;
  let capabilityTarget: string | null = null;
  let artifactFlag: string | null = null;
  let fileFlag: string | null = null;
  let cwdFlag: string | null = null;
  let legacyPythonParity = false;
  let format: "text" | "json" = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === LEGACY_PYTHON_PARITY_FLAG) {
      legacyPythonParity = true;
    } else if (a === "--format") {
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
            example: "agentera check validate capability plan",
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
      return cmdValidate(family, { format, legacyPythonParity }, io);
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

export function runSchema(argv: string[], io: Io, prog: string): number {
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