import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import { stateDurabilityContract } from "../../state/archiveDiscovery.js";
import { StateRetrievalFailure } from "../../state/directRetrieval.js";
import {
  inspectDurability,
  renderDurabilityText,
  type DurabilityArgs,
} from "../../state/durability.js";
import { entityArtifactValues } from "../../state/entityStorage.js";

export function requestedDurabilityFormat(_argv: string[]): "text" | "json" | "yaml" {
  return "json";
}

export function validateDurabilityArgs(args: DurabilityArgs, sourceRoot: string): void {
  const contract = stateDurabilityContract(sourceRoot);
  const validArtifacts = entityArtifactValues(sourceRoot);
  if (args.number !== undefined) throw entityDurabilityFailure("entity mode rejects --number; use --artifact ARTIFACT --id ID", args.artifact, args.id ?? undefined, validArtifacts);
  if (!args.artifact || !args.id) throw entityDurabilityFailure("entity-mode durability requires --artifact ARTIFACT --id ID", args.artifact, args.id ?? undefined, validArtifacts);
  if (!/^[a-z]{10}$/.test(args.id)) throw entityDurabilityFailure(`entity ID '${args.id}' must be ten lowercase letters`, args.artifact, args.id, validArtifacts);
  if (args.artifact && !validArtifacts.includes(args.artifact)) {
    throw entityDurabilityFailure(`unsupported durability artifact '${args.artifact}'`, args.artifact, args.id ?? undefined, validArtifacts);
  }
  if (args.limit !== undefined && (args.limit < 1 || args.limit > contract.maximumLimit)) {
    throw entityDurabilityFailure(`argument --limit must be between 1 and ${contract.maximumLimit}`, args.artifact, args.id ?? undefined, validArtifacts);
  }
}

export function entityDurabilityFailure(message: string, artifact?: string | null, id?: string, validValues?: string[]): StateRetrievalFailure {
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: "agentera check durability --artifact ARTIFACT --id ID",
      example: "agentera check durability --artifact progress --id qjtrmnpvka",
      recovery: "Use one bare entity ID returned by the artifact list; no state was changed.",
      ...(artifact ? { artifact } : {}),
      ...(id ? { id } : {}),
      ...(validValues ? { valid_values: validValues } : {}),
    },
  }, 2);
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
