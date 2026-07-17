import YAML from "yaml";

import { emitStructured } from "../../structured.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getExperiment, listExperiments, type ExperimentListResponse } from "../../../state/experimentRetrieval.js";
import type { Io } from "../../dispatch/shared.js";
import { detectStateMode } from "../../../state/stateMode.js";
import { getExperimentEntity, listExperimentEntities } from "../../../state/objectiveExperimentEntities.js";

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
        ? "agentera state experiments list --objective OBJECTIVE_ID [--limit N] [--cursor TOKEN] --format json"
        : "agentera state experiments get --objective OBJECTIVE_ID --number N --format json",
      example: list
        ? "agentera state experiments list --objective objective:123e4567-e89b-42d3-a456-426614174000 --limit 20 --format json"
        : "agentera state experiments get --objective objective:123e4567-e89b-42d3-a456-426614174000 --number 0 --format json",
      recovery: "Correct the command using a valid objective-scoped form and retry; no state was changed.",
      valid_values: list
        ? ["list", "--objective OBJECTIVE_ID", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
        : ["get", "--objective OBJECTIVE_ID", "--number 0..N", "--format text|json|yaml"],
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

function parse(argv: string[], verb: "list" | "get"): { format: Format; objective: string; limit: number; cursor?: string; number?: number } {
  let format: Format = "text";
  let objective: string | undefined;
  let limit = 20;
  let cursor: string | undefined;
  let number: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    const name = ["--format", "--objective", "--limit", "--cursor", "--number"].find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name || (verb === "list" && name === "--number") || (verb === "get" && (name === "--limit" || name === "--cursor"))) throw failure(`unrecognized argument '${token}'`, verb);
    if (seen.has(name)) throw failure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try { parsed = value(argv, index, name); } catch (error) { throw failure((error as Error).message, verb); }
    index = parsed.next;
    if (name === "--format") {
      if (!(["text", "json", "yaml"] as string[]).includes(parsed.value)) throw failure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--objective") objective = parsed.value;
    else if (name === "--cursor") cursor = parsed.value;
    else if (name === "--limit") {
      if (!/^[1-9][0-9]*$/.test(parsed.value)) throw failure("--limit must be an integer from 1 through 100", verb);
      limit = Number(parsed.value);
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(parsed.value)) throw failure("--number must be a non-negative integer without leading zeros", verb);
      number = Number(parsed.value);
    }
  }
  if (!objective) throw failure("--objective is required", verb);
  if (verb === "get" && number === undefined) throw failure("--number is required", verb);
  return { format, objective, limit, cursor, number };
}

function entityFailure(message: string, verb: "list" | "get"): StateRetrievalFailure {
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

function parseEntity(argv: string[], verb: "list" | "get"): { format: Format; objective?: string; id?: string; limit: number; cursor?: string } {
  let format: Format = "text";
  let objective: string | undefined;
  let id: string | undefined;
  let limit = 20;
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    const allowed = verb === "list" ? ["--format", "--objective", "--limit", "--cursor"] : ["--format", "--objective", "--id"];
    const name = allowed.find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name) throw entityFailure(`unrecognized argument '${token}'`, verb);
    if (seen.has(name)) throw entityFailure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try { parsed = value(argv, index, name); } catch (error) { throw entityFailure((error as Error).message, verb); }
    index = parsed.next;
    if (name === "--format") {
      if (!( ["text", "json", "yaml"] as string[]).includes(parsed.value)) throw entityFailure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--objective") objective = parsed.value;
    else if (name === "--id") id = parsed.value;
    else if (name === "--cursor") cursor = parsed.value;
    else {
      if (!/^[1-9][0-9]*$/.test(parsed.value)) throw entityFailure("--limit must be an integer from 1 through 100", verb);
      limit = Number(parsed.value);
    }
  }
  if (verb === "list" && !objective) throw entityFailure("--objective is required", verb);
  if (verb === "get" && !id) throw entityFailure("--id is required", verb);
  return { format, objective, id, limit, cursor };
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

function renderList(response: ExperimentListResponse): string {
  const lines = [`Experiments: objective=${response.filters.objective} | order=${response.order} | returned=${response.counts.returned}/${response.counts.total} | status=${response.status}`];
  for (const value of response.entries) {
    const entry = value as Record<string, any>;
    lines.push(`Experiment: number=${entry.experiment_number ?? "unavailable"} | stable_id=${entry.stable_id ?? "unavailable"} | detail=${entry.detail_availability} | source=${entry.source}`);
  }
  if (response.omitted) {
    lines.push(`Omitted: ${response.omitted_count} experiment(s) | reason=${response.omission_reason}`);
    lines.push(`Continue: ${(response.retrieval as any).continue}`);
  }
  lines.push(`Get one: ${(response.retrieval as any).get}`);
  return lines.join("\n") + "\n";
}

export function runExperimentRecords(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(failure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    if (detectStateMode(process.cwd()) === "entities") {
      const args = parseEntity(argv.slice(1), verb);
      const response = verb === "list"
        ? listExperimentEntities(process.cwd(), args.objective!, args.limit, args.cursor, { format: args.format })
        : getExperimentEntity(process.cwd(), args.id!, args.objective);
      const out = io.out ?? ((text: string) => process.stdout.write(text));
      if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, out);
      else out(YAML.stringify(response));
      return 0;
    }
    const args = parse(argv.slice(1), verb);
    const response = verb === "list"
      ? listExperiments(process.cwd(), args.objective, { limit: args.limit, cursor: args.cursor, format: args.format })
      : getExperiment(process.cwd(), args.objective, args.number!);
    const out = io.out ?? ((text: string) => process.stdout.write(text));
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, out);
    else if (verb === "list") out(renderList(response as ExperimentListResponse));
    else out(YAML.stringify(response));
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitFailure(error, format, io);
    return emitFailure(new StateRetrievalFailure({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "unsupported_state",
        message: (error as Error).message,
        syntax: "agentera state experiments {list|get} --objective OBJECTIVE_ID [options]",
        example: "agentera state experiments list --objective objective:123e4567-e89b-42d3-a456-426614174000 --format json",
        recovery: "Use supported objective-scoped experiment state and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
