import YAML from "yaml";

import { emitStructured } from "../../structured.js";
import { resolveSourceRoot } from "../../../core/sourceRoot.js";
import {
  type StateFailureBody,
  retrieveStateEntry,
  StateRetrievalFailure,
} from "../../../state/directRetrieval.js";
import { numberedArchiveArtifacts } from "../../../state/archiveDiscovery.js";
import type { Io } from "../../dispatch/shared.js";

interface StateGetArgs {
  number: number;
  format: "text" | "json" | "yaml";
}

function requestedFormat(argv: string[]): "text" | "json" | "yaml" {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--format") {
      const value = argv[index + 1];
      if (value === "json" || value === "yaml") return value;
    }
    if (token.startsWith("--format=")) {
      const value = token.slice("--format=".length);
      if (value === "json" || value === "yaml") return value;
    }
  }
  return "text";
}

function parseFailure(
  className: StateFailureBody["error"]["class"],
  message: string,
  artifactId?: string,
  entryNumber?: number,
  validValues?: string[],
): StateRetrievalFailure {
  const syntax = `agentera state ${artifactId ?? "<artifact-id>"} get --number N --format json`;
  const example = `agentera state ${artifactId ?? "progress"} get --number ${entryNumber ?? 1} --format json`;
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax,
        example,
        recovery: "Correct the command using the valid syntax and retry; no state was changed.",
        ...(artifactId ? { artifact_id: artifactId } : {}),
        ...(entryNumber ? { entry_number: entryNumber, stable_id: `${artifactId}:${entryNumber}` } : {}),
        ...(validValues ? { valid_values: validValues } : {}),
      },
    },
    2,
  );
}

function readValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const token = argv[index];
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, next: index + 2 };
}

function parseGetArgs(artifactId: string, argv: string[], sourceRoot: string): StateGetArgs {
  const validValues = numberedArchiveArtifacts(sourceRoot);
  if (!validValues.includes(artifactId)) {
    throw parseFailure(
      "unsupported_artifact",
      `unsupported state artifact '${artifactId}'`,
      artifactId,
      undefined,
      validValues,
    );
  }
  let number: number | undefined;
  let format: StateGetArgs["format"] = "text";
  for (let index = 0; index < argv.length; ) {
    const token = argv[index];
    if (token !== "--number" && !token.startsWith("--number=") && token !== "--format" && !token.startsWith("--format=")) {
      throw parseFailure("invalid_request", `unrecognized argument '${token}'`, artifactId, number);
    }
    const name = token.startsWith("--number") ? "--number" : "--format";
    let parsed: { value: string; next: number };
    try {
      parsed = readValue(argv, index, name);
    } catch (error) {
      throw parseFailure("invalid_request", (error as Error).message, artifactId, number);
    }
    index = parsed.next;
    if (name === "--number") {
      if (number !== undefined) throw parseFailure("invalid_request", "--number may only be supplied once", artifactId, number);
      if (!/^[1-9][0-9]*$/.test(parsed.value)) {
        throw parseFailure("invalid_request", `argument --number: expected a positive canonical integer, got '${parsed.value}'`, artifactId);
      }
      const parsedNumber = Number(parsed.value);
      if (!Number.isSafeInteger(parsedNumber) || parsedNumber < 1) {
        throw parseFailure("invalid_request", `argument --number is outside the supported safe integer range: '${parsed.value}'`, artifactId);
      }
      number = parsedNumber;
    } else {
      if (parsed.value !== "text" && parsed.value !== "json" && parsed.value !== "yaml") {
        throw parseFailure(
          "invalid_request",
          `argument --format: invalid choice: '${parsed.value}'`,
          artifactId,
          number,
          ["text", "json", "yaml"],
        );
      }
      format = parsed.value;
    }
  }
  if (number === undefined) throw parseFailure("invalid_request", "the required selector --number N is missing", artifactId);
  return { number, format };
}

function emitFailure(failure: StateRetrievalFailure, format: "text" | "json" | "yaml", io: Io): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  const err = io.err ?? ((text: string) => process.stderr.write(text));
  if (format === "json" || format === "yaml") {
    emitStructured(failure.body, format, out);
  } else {
    const details = failure.body.error;
    err(
      [
        `Error: ${details.message}`,
        `Syntax: ${details.syntax}`,
        `Example: ${details.example}`,
        `Recovery: ${details.recovery}`,
      ].join("\n") + "\n",
    );
  }
  return failure.exitCode;
}

export function runStateGet(
  artifactId: string,
  argv: string[],
  io: Io,
): number {
  const format = requestedFormat(argv);
  const sourceRoot = resolveSourceRoot();
  try {
    const args = parseGetArgs(artifactId, argv, sourceRoot);
    const response = retrieveStateEntry(process.cwd(), artifactId, args.number, { sourceRoot });
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, io.out ?? ((text: string) => process.stdout.write(text)));
    else {
      const out = io.out ?? ((text: string) => process.stdout.write(text));
      out(`${response.entry.stable_id} source=${response.entry.source} compatibility=${response.entry.compatibility}\n`);
      out(YAML.stringify(response.entry.record));
    }
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitFailure(error, format, io);
    return emitFailure(
      new StateRetrievalFailure(
        {
          schemaVersion: "agentera.stateFailure.v1",
          status: "fail",
          error: {
            class: "unsupported_state",
            message: (error as Error).message,
            syntax: `agentera state ${artifactId} get --number N --format json`,
            example: `agentera state ${artifactId} get --number 1 --format json`,
            recovery: "Use a state format supported by the storage authority, then retry.",
          },
        },
        1,
      ),
      format,
      io,
    );
  }
}
