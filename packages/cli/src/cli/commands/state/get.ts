import { resolveSourceRoot } from "../../../core/sourceRoot.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getDecisionEntity } from "../../../state/decisionEntities.js";
import { getHealthEntity } from "../../../state/healthEntities.js";
import { getObjectiveEntity } from "../../../state/objectiveExperimentEntities.js";
import { getProgressEntity } from "../../../state/progressEntities.js";
import { getTodoDocsEntity } from "../../../state/todoDocsEntities.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";
import { entityListFamily } from "../../../state/entityRetrievalHelp.js";
import { runtimeGenericEntityListFamily, type EntityListRuntimeFamilyKey } from "../../../state/entityListRuntimeRegistry.js";

function requestedFormat(argv: string[]): "text" | "json" | "yaml" {
  void argv;
  return "json";
}

function failure(message: string, id?: string, artifact = "progress"): StateRetrievalFailure {
  const runtime = runtimeGenericEntityListFamily(artifact);
  const family = runtime ? entityListFamily(runtime.key as EntityListRuntimeFamilyKey) : undefined;
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: family?.get ?? `agentera state ${artifact} get --id ID`,
      example: `agentera state ${artifact} get --id ${id ?? "qjtrmnpvka"}`,
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

function emitFailure(error: StateRetrievalFailure, _format: "text" | "json" | "yaml", io: Io): number {
  emitStructured(error.body, "json", io.out ?? ((text) => process.stdout.write(text)));
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
    if (!runtimeGenericEntityListFamily(artifactId)) throw failure(`unsupported state artifact '${artifactId}'`, undefined, artifactId);
    let id: string | undefined;
    let entityFormat: "text" | "json" | "yaml" = "json";
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
        if (parsed.value !== "json") throw failure(`invalid --format '${parsed.value}'`, id, artifactId);
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
    emitStructured(response, "json", output);
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitFailure(error, format, io);
    return emitFailure(failure((error as Error).message, undefined, artifactId), format, io);
  }
}
