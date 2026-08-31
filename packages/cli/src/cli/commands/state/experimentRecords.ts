import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getExperimentEntity, listExperimentEntities } from "../../../state/objectiveExperimentEntities.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";
import type { EntityListSelectorInput } from "../../../state/entityListProjection.js";
import { entityListFamily, entityListValidValues } from "../../../state/entityRetrievalHelp.js";

type Format = "text" | "json" | "yaml";

function requestedFormat(argv: string[]): Format {
  void argv;
  return "json";
}

function failure(message: string, verb: "list" | "get"): StateRetrievalFailure {
  const list = verb === "list";
  const family = entityListFamily("experiments");
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: list
        ? family.syntax
        : family.get,
      example: list
        ? family.example
        : "agentera state experiments get --id qjtrmnpvka --format json",
      recovery: list ? `Run \`${family.example}\`; no state was changed.` : "Use bare ten-letter entity IDs and retry; no state was changed.",
      valid_values: list
        ? entityListValidValues(family)
        : ["get", "--id ID", "--format text|json|yaml"],
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
  const family = entityListFamily("experiments");
  let format: Format = "json";
  let objective: string | undefined;
  let id: string | undefined;
  let limit = family.bounds.default;
  let cursor: string | undefined;
  const selector: EntityListSelectorInput = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    if (verb === "list" && token === "--ids-only") {
      if (selector.idsOnly) throw failure("--ids-only may only be supplied once", verb);
      selector.idsOnly = true; index += 1; continue;
    }
    const allowed = verb === "list" ? ["--format", "--objective", "--limit", "--cursor", "--fields"] : ["--format", "--id"];
    const name = allowed.find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name) throw failure(`unrecognized argument '${token}'`, verb);
    if (seen.has(name)) throw failure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try { parsed = value(argv, index, name); }
    catch (error) { throw failure((error as Error).message, verb); }
    index = parsed.next;
    if (name === "--format") {
      if (parsed.value !== "json") throw failure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--objective") objective = parsed.value;
    else if (name === "--id") id = parsed.value;
    else if (name === "--cursor") cursor = parsed.value;
    else if (name === "--fields") selector.fields = parsed.value;
    else {
      if (!/^[1-9][0-9]*$/.test(parsed.value) || Number(parsed.value) < family.bounds.minimum || Number(parsed.value) > family.bounds.maximum) throw failure(`--limit must be an integer from ${family.bounds.minimum} through ${family.bounds.maximum}`, verb);
      limit = Number(parsed.value);
    }
  }
  if (verb === "list" && !objective) throw failure("--objective is required", verb);
  if (verb === "get" && !id) throw failure("--id is required", verb);
  return { format, objective, id, limit, cursor, selector };
}

function emitFailure(error: StateRetrievalFailure, _format: Format, io: Io): number {
  emitStructured(error.body, "json", io.out ?? ((text) => process.stdout.write(text)));
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
      : getExperimentEntity(process.cwd(), args.id!);
    const output = io.out ?? ((text: string) => process.stdout.write(text));
    emitStructured(response, "json", output);
    return 0;
  } catch (error) {
    if (error instanceof StateRetrievalFailure) return emitFailure(error, format, io);
    return emitFailure(new StateRetrievalFailure({
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: "unsupported_state",
        message: (error as Error).message,
        syntax: "agentera state experiments list --objective ID [options] | agentera state experiments get --id ID [--format text|json|yaml]",
        example: "agentera state experiments list --objective qjtrmnpvka --format json",
        recovery: "Use supported objective-scoped experiment state and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
