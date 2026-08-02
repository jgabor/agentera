import YAML from "yaml";

import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getExperimentEntity, listExperimentEntities } from "../../../state/objectiveExperimentEntities.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";
import type { EntityListSelectorInput } from "../../../state/entityListProjection.js";

type Format = "text" | "json" | "yaml";

function requestedFormat(argv: string[]): Format {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const value = token === "--format" ? argv[index + 1] : token.startsWith("--format=") ? token.slice(9) : undefined;
    if (value === "json" || value === "yaml") return value;
  }
  return "text";
}

function failure(message: string, verb: "list" | "get"): StateRetrievalFailure {
  const list = verb === "list";
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: list
        ? "agentera state experiments list --objective ID [--limit N] [--cursor TOKEN] --format json"
        : "agentera state experiments get --id ID [--objective ID] --format json",
      example: list
        ? "agentera state experiments list --objective qjtrmnpvka --limit 20 --format json"
        : "agentera state experiments get --id qjtrmnpvka --format json",
      recovery: "Use bare ten-letter entity IDs and retry; no state was changed.",
      valid_values: list
        ? ["list", "--objective ID", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
        : ["get", "--id ID", "--objective ID", "--format text|json|yaml"],
    },
  }, 2);
}

function value(argv: string[], index: number, name: string): { value: string; next: number } {
  const token = argv[index]!;
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value: next, next: index + 2 };
}

function parse(argv: string[], verb: "list" | "get"): { format: Format; objective?: string; id?: string; limit: number; cursor?: string; selector: EntityListSelectorInput } {
  let format: Format = "text";
  let objective: string | undefined;
  let id: string | undefined;
  let limit = 20;
  let cursor: string | undefined;
  const selector: EntityListSelectorInput = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    if (verb === "list" && token === "--ids-only") {
      if (selector.idsOnly) throw failure("--ids-only may only be supplied once", verb);
      selector.idsOnly = true; index += 1; continue;
    }
    const allowed = verb === "list" ? ["--format", "--objective", "--limit", "--cursor", "--fields"] : ["--format", "--objective", "--id"];
    const name = allowed.find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name) throw failure(`unrecognized argument '${token}'`, verb);
    if (seen.has(name)) throw failure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try { parsed = value(argv, index, name); }
    catch (error) { throw failure((error as Error).message, verb); }
    index = parsed.next;
    if (name === "--format") {
      if (!( ["text", "json", "yaml"] as string[]).includes(parsed.value)) throw failure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--objective") objective = parsed.value;
    else if (name === "--id") id = parsed.value;
    else if (name === "--cursor") cursor = parsed.value;
    else if (name === "--fields") selector.fields = parsed.value;
    else {
      if (!/^[1-9][0-9]*$/.test(parsed.value)) throw failure("--limit must be an integer from 1 through 100", verb);
      limit = Number(parsed.value);
    }
  }
  if (verb === "list" && !objective) throw failure("--objective is required", verb);
  if (verb === "get" && !id) throw failure("--id is required", verb);
  return { format, objective, id, limit, cursor, selector };
}

function emitFailure(error: StateRetrievalFailure, format: Format, io: Io): number {
  if (format === "json" || format === "yaml") emitStructured(error.body, format, io.out ?? ((text) => process.stdout.write(text)));
  else {
    const detail = error.body.error;
    (io.err ?? ((text) => process.stderr.write(text)))([
      `Error: ${detail.message}`,
      `Class: ${detail.class}`,
      `Valid forms: ${(detail.valid_values ?? [detail.syntax]).join("; ")}`,
      `Example: ${detail.example}`,
      `Recovery: ${detail.recovery}`,
    ].join("\n") + "\n");
  }
  return error.exitCode;
}

export function runExperimentRecords(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(failure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    const args = parse(argv.slice(1), verb);
    const response = verb === "list"
      ? listExperimentEntities(process.cwd(), args.objective!, args.limit, args.cursor, { format: args.format, selector: args.selector })
      : getExperimentEntity(process.cwd(), args.id!, args.objective);
    const output = io.out ?? ((text: string) => process.stdout.write(text));
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, output);
    else output(YAML.stringify(response));
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitFailure(error, format, io);
    return emitFailure(new StateRetrievalFailure({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "unsupported_state",
        message: (error as Error).message,
        syntax: "agentera state experiments {list|get} --objective ID [options]",
        example: "agentera state experiments list --objective qjtrmnpvka --format json",
        recovery: "Use supported objective-scoped experiment state and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
