import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getPlanTaskEntity, listPlanTaskEntities } from "../../../state/planEntities.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";
import type { EntityListSelectorInput } from "../../../state/entityListProjection.js";
import { entityListFamily, entityListValidValues } from "../../../state/entityRetrievalHelp.js";

type Format = "text" | "json" | "yaml";

function requestedFormat(argv: string[]): Format {
  void argv;
  return "json";
}

function readValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const token = argv[index];
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, next: index + 2 };
}

function failure(message: string, verb: "list" | "get"): StateRetrievalFailure {
  const list = verb === "list";
  const family = entityListFamily("plan_tasks");
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
        : "agentera state plan tasks get --id qjtrmnpvka --format json",
      recovery: list ? `Run \`${family.example}\`; no state was changed.` : "Correct the command using one of the valid forms and retry; no state was changed.",
      valid_values: list
        ? entityListValidValues(family)
        : ["get", "--id ID", "--format text|json|yaml"],
    },
  }, 2);
}

function parse(argv: string[], verb: "list" | "get"): { format: Format; plan?: string; limit: number; cursor?: string; id?: string; selector: EntityListSelectorInput } {
  const family = entityListFamily("plan_tasks");
  let format: Format = "json";
  let plan: string | undefined;
  let limit = family.bounds.default;
  let cursor: string | undefined;
  let id: string | undefined;
  const selector: EntityListSelectorInput = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index];
    if (verb === "list" && token === "--ids-only") {
      if (selector.idsOnly) throw failure("--ids-only may only be supplied once", verb);
      selector.idsOnly = true; index += 1; continue;
    }
    if (verb === "list" && !token.startsWith("--")) {
      if (plan) throw failure(`unrecognized argument '${token}'`, verb);
      plan = token;
      index += 1;
      continue;
    }
    const allowed = verb === "list" ? ["--format", "--limit", "--cursor", "--fields"] : ["--format", "--id"];
    const name = allowed.find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name) throw failure(`unrecognized argument '${token}'`, verb);
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
    else id = parsed.value;
  }
  if (verb === "get" && !id) throw failure("entity mode requires a bare ten-letter --id selector", verb);
  return { format, limit, ...(plan ? { plan } : {}), ...(cursor ? { cursor } : {}), ...(id ? { id } : {}), selector };
}

function emitFailure(error: StateRetrievalFailure, _format: Format, io: Io): number {
  emitStructured(error.body, "json", io.out ?? ((text) => process.stdout.write(text)));
  return error.exitCode;
}

export function runPlanTasks(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(failure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    const args = parse(argv.slice(1), verb);
    const response = verb === "list"
      ? listPlanTaskEntities(process.cwd(), args.plan, args.limit, args.cursor, { format: args.format, selector: args.selector })
      : getPlanTaskEntity(process.cwd(), args.id!);
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
        syntax: "agentera state plan tasks {list|get} [options]",
        example: "agentera state plan tasks list --format json",
        recovery: "Use a supported active plan and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
