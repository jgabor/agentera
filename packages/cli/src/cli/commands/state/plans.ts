import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getPlanEntity, listPlanEntities } from "../../../state/planEntities.js";
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
  const family = entityListFamily("plans");
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
        : "agentera state plan get --id qjtrmnpvka",
      recovery: list ? `Run \`${family.example}\`; no state was changed.` : "Correct the command using one of the valid forms and retry; no state was changed.",
      valid_values: list
        ? entityListValidValues(family)
        : ["get", "--id ID", "--format text|json|yaml"],
    },
  }, 2);
}

function readValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const token = argv[index]!;
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, next: index + 2 };
}

function parse(argv: string[], verb: "list" | "get"): { format: Format; limit: number; cursor?: string; id?: string; status?: string; selector: EntityListSelectorInput } {
  const family = entityListFamily("plans");
  let format: Format = "json";
  let limit = family.bounds.default;
  let cursor: string | undefined;
  let id: string | undefined;
  let status: string | undefined;
  const selector: EntityListSelectorInput = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    if (verb === "list" && token === "--ids-only") {
      if (selector.idsOnly) throw failure("--ids-only may only be supplied once", verb);
      selector.idsOnly = true; index += 1; continue;
    }
    const allowed = verb === "list" ? ["--format", "--limit", "--cursor", "--status", "--fields"] : ["--format", "--id"];
    const name = allowed.find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name) {
      throw failure(`unrecognized argument '${token}'`, verb);
    }
    if (seen.has(name)) throw failure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try { parsed = readValue(argv, index, name); }
    catch (error) { throw failure((error as Error).message, verb); }
    index = parsed.next;
    if (name === "--format") {
      if (parsed.value !== "json") throw failure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--limit") {
      if (!/^[1-9][0-9]*$/.test(parsed.value) || Number(parsed.value) < family.bounds.minimum || Number(parsed.value) > family.bounds.maximum) throw failure(`--limit must be an integer from ${family.bounds.minimum} through ${family.bounds.maximum}`, verb);
      limit = Number(parsed.value);
    } else if (name === "--cursor") cursor = parsed.value;
    else if (name === "--fields") selector.fields = parsed.value;
    else if (name === "--status") {
      const validStatuses = family.filters.find(({ name }) => name === "status")?.values;
      if (!Array.isArray(validStatuses) || !validStatuses.includes(parsed.value)) throw failure(`invalid --status '${parsed.value}'`, verb);
      status = parsed.value;
    } else id = parsed.value;
  }
  return { format, limit, ...(cursor ? { cursor } : {}), ...(id ? { id } : {}), ...(status ? { status } : {}), selector };
}

function emitFailure(error: StateRetrievalFailure, _format: Format, io: Io): number {
  emitStructured(error.body, "json", io.out ?? ((text) => process.stdout.write(text)));
  return error.exitCode;
}

export function runPlans(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(failure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    const args = parse(argv.slice(1), verb);
    if (verb === "get" && !args.id) throw failure("entity mode requires --id ID", verb);
    const response = verb === "list"
      ? listPlanEntities(process.cwd(), args.limit, args.cursor, { format: args.format, selector: args.selector, ...(args.status ? { statuses: [args.status] } : {}) })
      : getPlanEntity(process.cwd(), args.id!);
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
        syntax: "agentera state plan {list|get} [options]",
        example: "agentera state plan list",
        recovery: "Use supported plan state and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
