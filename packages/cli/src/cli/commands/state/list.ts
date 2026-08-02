import { resolveSourceRoot } from "../../../core/sourceRoot.js";
import type { StateListFilters } from "../../../state/listRetrieval.js";
import { StateRetrievalFailure, type StateFailureBody } from "../../../state/directRetrieval.js";
import { emitStructured } from "../../structured.js";
import type { Io } from "../../dispatch/shared.js";
import { listProgressEntities, renderProgressEntityListText } from "../../../state/progressEntities.js";
import { listDecisionEntities } from "../../../state/decisionEntities.js";
import { listHealthEntities } from "../../../state/healthEntities.js";
import { listObjectiveEntities } from "../../../state/objectiveExperimentEntities.js";
import { listTodoDocsEntities } from "../../../state/todoDocsEntities.js";
import YAML from "yaml";
import type { JsonObject } from "../../../core/jsonValue.js";
import type { EntityListSelectorInput } from "../../../state/entityListProjection.js";

interface StateListArgs {
  limit: number;
  cursor?: string;
  format: "text" | "json" | "yaml";
  filters: StateListFilters;
  selector: EntityListSelectorInput;
}

const ENTITY_LIST_ARTIFACTS = ["progress", "decisions", "health", "objective", "todo", "docs"];

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

function syntax(artifactId: string): string {
  return `agentera state ${artifactId} list [--limit N] [--cursor TOKEN] --format json`;
}

function failure(
  className: StateFailureBody["error"]["class"],
  artifactId: string,
  message: string,
  example = `agentera state ${artifactId} list --limit 20 --format json`,
  validValues?: string[],
): StateRetrievalFailure {
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: syntax(artifactId),
        example,
        recovery: "Correct the command using the valid syntax and retry; no state was changed.",
        artifact_id: artifactId,
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

function parseListArgs(artifactId: string, argv: string[]): StateListArgs {
  const validValues = ENTITY_LIST_ARTIFACTS;
  if (!validValues.includes(artifactId)) {
    throw failure("unsupported_artifact", artifactId, `unsupported state artifact '${artifactId}'`, undefined, validValues);
  }
  let limit = 20;
  let cursor: string | undefined;
  let format: StateListArgs["format"] = "text";
  const filters: StateListFilters = {};
  const selector: EntityListSelectorInput = {};
  const allowedFilters = artifactId === "progress" ? new Set(["--topic", "--status"]) : artifactId === "decisions" ? new Set(["--topic"]) : artifactId === "todo" ? new Set(["--severity", "--status"]) : artifactId === "docs" ? new Set(["--topic", "--status"]) : artifactId === "objective" ? new Set<string>() : new Set(["--dimension"]);
  let limitSupplied = false;
  let cursorSupplied = false;
  let formatSupplied = false;
  const filterSupplied = new Set<string>();
  for (let index = 0; index < argv.length; ) {
    const token = argv[index];
    if (token === "--ids-only") {
      if (selector.idsOnly) throw failure("invalid_request", artifactId, "--ids-only may only be supplied once");
      selector.idsOnly = true;
      index += 1;
      continue;
    }
    const matches = (flag: string): boolean => token === flag || token.startsWith(`${flag}=`);
    const name = matches("--limit") ? "--limit" : matches("--cursor") ? "--cursor" : matches("--format") ? "--format" : matches("--fields") ? "--fields" : [...allowedFilters].find(matches) ?? null;
    if (!name) throw failure("invalid_request", artifactId, `unrecognized argument '${token}'`);
    let parsed: { value: string; next: number };
    try {
      parsed = readValue(argv, index, name);
    } catch (error) {
      throw failure("invalid_request", artifactId, (error as Error).message);
    }
    index = parsed.next;
    if (name === "--limit") {
      if (limitSupplied) throw failure("invalid_request", artifactId, "--limit may only be supplied once");
      limitSupplied = true;
      if (!/^[1-9][0-9]*$/.test(parsed.value)) throw failure("invalid_request", artifactId, "argument --limit must be a positive canonical integer from 1 through 100");
      limit = Number(parsed.value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure("invalid_request", artifactId, "argument --limit must be between 1 and 100", `agentera state ${artifactId} list --limit 20 --format json`);
    } else if (name === "--cursor") {
      if (cursorSupplied) throw failure("invalid_request", artifactId, "--cursor may only be supplied once");
      cursorSupplied = true;
      if (parsed.value.length === 0) throw failure("invalid_request", artifactId, "argument --cursor must be a non-empty opaque token");
      cursor = parsed.value;
    } else if (name === "--fields") {
      if (selector.fields !== undefined) throw failure("invalid_request", artifactId, "--fields may only be supplied once");
      selector.fields = parsed.value;
    } else {
      if (name !== "--format") {
        if (filterSupplied.has(name)) throw failure("invalid_request", artifactId, `${name} may only be supplied once`);
        filterSupplied.add(name);
        const key = name.slice(2) as keyof StateListFilters;
        filters[key] = parsed.value;
        continue;
      }
      if (formatSupplied) throw failure("invalid_request", artifactId, "--format may only be supplied once");
      formatSupplied = true;
      if (parsed.value !== "text" && parsed.value !== "json" && parsed.value !== "yaml") {
        throw failure("invalid_request", artifactId, `argument --format: invalid choice: '${parsed.value}' (choose from 'text', 'json', 'yaml')`);
      }
      format = parsed.value;
    }
  }
  return { limit, ...(cursor ? { cursor } : {}), format, filters, selector };
}

function emitFailure(error: StateRetrievalFailure, format: "text" | "json" | "yaml", io: Io): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  if (format === "json" || format === "yaml") emitStructured(error.body, format, out);
  else {
    const details = error.body.error;
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
  return error.exitCode;
}

export function runStateList(artifactId: string, argv: string[], io: Io, projectRoot = process.cwd()): number {
  const format = requestedFormat(argv);
  const sourceRoot = resolveSourceRoot();
  try {
    const args = parseListArgs(artifactId, argv);
    const response = artifactId === "progress"
      ? listProgressEntities(projectRoot, args.limit, args.filters, args.cursor, { sourceRoot, format: args.format, selector: args.selector })
      : artifactId === "decisions"
        ? listDecisionEntities(projectRoot, args.limit, args.filters.topic ?? undefined, args.cursor, { sourceRoot, format: args.format, selector: args.selector })
        : artifactId === "health"
          ? listHealthEntities(projectRoot, args.limit, args.filters.dimension ?? undefined, args.cursor, { sourceRoot, format: args.format, selector: args.selector })
          : artifactId === "objective"
            ? listObjectiveEntities(projectRoot, args.limit, args.cursor, { sourceRoot, format: args.format, selector: args.selector })
            : listTodoDocsEntities(projectRoot, artifactId as "todo" | "docs", args.limit, args.cursor, args.filters as JsonObject, { sourceRoot, format: args.format, selector: args.selector });
    const output = io.out ?? ((text: string) => process.stdout.write(text));
    if (args.format === "text") output(artifactId === "progress" ? renderProgressEntityListText(response) : YAML.stringify(response));
    else emitStructured(response, args.format, output);
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) {
      const body = structuredClone(error.body);
      delete body.error.artifact_id;
      body.error.artifact = artifactId;
      return emitFailure(new StateRetrievalFailure(body, error.exitCode), format, io);
    }
    return emitFailure(
      new StateRetrievalFailure(
        {
          schemaVersion: "agentera.stateFailure.v1",
          status: "fail",
          error: {
            class: "unsupported_state",
            message: (error as Error).message,
            syntax: syntax(artifactId),
            example: `agentera state ${artifactId} list --limit 20 --format json`,
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
