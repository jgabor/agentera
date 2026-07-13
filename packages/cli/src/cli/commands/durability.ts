import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import {
  numberedArchiveArtifacts,
  stateDurabilityContract,
} from "../../state/archiveDiscovery.js";
import {
  StateRetrievalFailure,
  type StateFailureClass,
  type StateFailureBody,
} from "../../state/directRetrieval.js";
import {
  inspectDurability,
  renderDurabilityText,
  type DurabilityArgs,
} from "../../state/durability.js";

export function requestedDurabilityFormat(argv: string[]): "text" | "json" | "yaml" {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--format") {
      const value = argv[index + 1];
      if (value === "json" || value === "yaml") return value;
    }
    if (argv[index].startsWith("--format=")) {
      const value = argv[index].slice("--format=".length);
      if (value === "json" || value === "yaml") return value;
    }
  }
  return "text";
}

export function durabilityFailure(
  className: StateFailureClass,
  message: string,
  sourceRoot: string,
  artifact?: string | null,
  entryNumber?: number,
  validValues?: string[],
): StateRetrievalFailure {
  const contract = stateDurabilityContract(sourceRoot);
  const exampleArtifact = artifact && validValues?.includes(artifact) ? artifact : "progress";
  const exampleNumber = entryNumber ?? 1;
  const example = `agentera check durability --artifact ${exampleArtifact} --number ${exampleNumber} --format json`;
  const body: StateFailureBody = {
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: className,
      message,
      syntax: contract.command,
      example,
      recovery: "Correct the command using the valid syntax and retry; no state was changed.",
      ...(artifact ? { artifact_id: artifact } : {}),
      ...(entryNumber !== undefined
        ? { entry_number: entryNumber, stable_id: `${artifact ?? exampleArtifact}:${entryNumber}` }
        : {}),
      ...(validValues ? { valid_values: validValues } : {}),
    },
  };
  return new StateRetrievalFailure(body, 2);
}

export function validateDurabilityArgs(args: DurabilityArgs, sourceRoot: string): void {
  const contract = stateDurabilityContract(sourceRoot);
  const validArtifacts = numberedArchiveArtifacts(sourceRoot);
  if (args.artifact && !validArtifacts.includes(args.artifact)) {
    throw durabilityFailure(
      "unsupported_artifact",
      `unsupported durability artifact '${args.artifact}'`,
      sourceRoot,
      args.artifact,
      undefined,
      validArtifacts,
    );
  }
  if (args.number !== undefined && !args.artifact) {
    throw durabilityFailure(
      "invalid_request",
      "argument --number requires --artifact",
      sourceRoot,
      undefined,
      args.number,
      validArtifacts,
    );
  }
  if (args.limit !== undefined && (args.limit < 1 || args.limit > contract.maximumLimit)) {
    throw durabilityFailure(
      "invalid_request",
      `argument --limit must be between 1 and ${contract.maximumLimit}`,
      sourceRoot,
      args.artifact,
      undefined,
      validArtifacts,
    );
  }
}

export function emitDurabilityFailure(
  failure: StateRetrievalFailure,
  format: "text" | "json" | "yaml",
  io: Io,
): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "json" || format === "yaml") emitStructured(failure.body, format, out);
  else {
    const details = failure.body.error;
    out(
      [
        `Error: ${details.message}`,
        `Class: ${details.class}`,
        `Syntax: ${details.syntax}`,
        `Example: ${details.example}`,
        `Recovery: ${details.recovery}`,
      ].join("\n") + "\n",
    );
  }
  return failure.exitCode;
}

export function cmdDurability(args: DurabilityArgs, io: Io = {}): number {
  const output = io.out ?? ((text: string) => process.stdout.write(text));
  const response = inspectDurability(
    resolvePath(args.project ?? process.cwd()),
    args,
    { sourceRoot: resolveSourceRoot() },
  );
  if (args.format === "json" || args.format === "yaml") {
    emitStructured(response, args.format, output);
  } else {
    renderDurabilityText(response, output);
  }
  return 0;
}
