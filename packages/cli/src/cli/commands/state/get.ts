import YAML from "yaml";

import { resolveSourceRoot } from "../../../core/sourceRoot.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getDecisionEntity } from "../../../state/decisionEntities.js";
import { getHealthEntity } from "../../../state/healthEntities.js";
import { getObjectiveEntity } from "../../../state/objectiveExperimentEntities.js";
import { getProgressEntity } from "../../../state/progressEntities.js";
import { getTodoDocsEntity } from "../../../state/todoDocsEntities.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";

const ENTITY_GET_ARTIFACTS = ["progress", "decisions", "health", "objective", "todo", "docs"];

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

function failure(message: string, id?: string, artifact = "progress"): StateRetrievalFailure {
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: `agentera state ${artifact} get --id ID --format json`,
      example: `agentera state ${artifact} get --id ${id ?? "qjtrmnpvka"} --format json`,
      recovery: `Use a bare ten-letter ${artifact} ID returned by append or list; no state was changed.`,
      artifact,
      ...(id ? { id } : {}),
    },
  }, 2);
}

function readValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const token = argv[index];
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, next: index + 2 };
}

function emitFailure(error: StateRetrievalFailure, format: "text" | "json" | "yaml", io: Io): number {
  if (format === "json" || format === "yaml") {
    emitStructured(error.body, format, io.out ?? ((text) => process.stdout.write(text)));
  } else {
    const detail = error.body.error;
    (io.err ?? ((text) => process.stderr.write(text)))([
      `Error: ${detail.message}`,
      `Syntax: ${detail.syntax}`,
      `Example: ${detail.example}`,
      `Recovery: ${detail.recovery}`,
    ].join("\n") + "\n");
  }
  return error.exitCode;
}

export function runStateGet(
  artifactId: string,
  argv: string[],
  io: Io,
  projectRoot = process.cwd(),
): number {
  const format = requestedFormat(argv);
  const sourceRoot = resolveSourceRoot();
  try {
    if (!ENTITY_GET_ARTIFACTS.includes(artifactId)) throw failure(`unsupported state artifact '${artifactId}'`, undefined, artifactId);
    let id: string | undefined;
    let entityFormat: "text" | "json" | "yaml" = "text";
    let formatSupplied = false;
    for (let index = 0; index < argv.length; ) {
      const token = argv[index];
      if (token !== "--id" && !token.startsWith("--id=") && token !== "--format" && !token.startsWith("--format=")) {
        throw failure(`unrecognized argument '${token}'; entity-mode ${artifactId} retrieval requires --id ID`, id, artifactId);
      }
      const name = token.startsWith("--id") ? "--id" : "--format";
      let parsed: { value: string; next: number };
      try { parsed = readValue(argv, index, name); }
      catch (error) { throw failure((error as Error).message, id, artifactId); }
      index = parsed.next;
      if (name === "--id") {
        if (id !== undefined) throw failure("--id may only be supplied once", id, artifactId);
        id = parsed.value;
      } else {
        if (formatSupplied) throw failure("--format may only be supplied once", id, artifactId);
        formatSupplied = true;
        if (parsed.value !== "text" && parsed.value !== "json" && parsed.value !== "yaml") throw failure(`invalid --format '${parsed.value}'`, id, artifactId);
        entityFormat = parsed.value;
      }
    }
    if (!id) throw failure(`--id is required for entity-mode ${artifactId} retrieval`, id, artifactId);
    const response = artifactId === "progress"
      ? getProgressEntity(projectRoot, id, sourceRoot)
      : artifactId === "decisions"
        ? getDecisionEntity(projectRoot, id, sourceRoot)
        : artifactId === "health"
          ? getHealthEntity(projectRoot, id, sourceRoot)
          : artifactId === "objective"
            ? getObjectiveEntity(projectRoot, id, sourceRoot)
            : getTodoDocsEntity(projectRoot, artifactId as "todo" | "docs", id, sourceRoot);
    const output = io.out ?? ((text: string) => process.stdout.write(text));
    if (entityFormat === "json" || entityFormat === "yaml") emitStructured(response, entityFormat, output);
    else output(YAML.stringify(response));
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitFailure(error, format, io);
    return emitFailure(failure((error as Error).message, undefined, artifactId), format, io);
  }
}
