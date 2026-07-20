import YAML from "yaml";

import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getPlanEntity, listPlanEntities } from "../../../state/planEntities.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";

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
        ? "agentera state plan list [--status open|complete|archived] [--limit N] [--cursor TOKEN] --format json"
        : "agentera state plan get --id ID --format json",
      example: list
        ? "agentera state plan list --limit 20 --format json"
        : "agentera state plan get --id qjtrmnpvka --format json",
      recovery: "Correct the command using one of the valid forms and retry; no state was changed.",
      valid_values: list
        ? ["list", "--status open|complete|archived", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
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

function parse(argv: string[], verb: "list" | "get"): { format: Format; limit: number; cursor?: string; plan?: string; id?: string; status?: string } {
  let format: Format = "text";
  let limit = 20;
  let cursor: string | undefined;
  let plan: string | undefined;
  let id: string | undefined;
  let status: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    const name = ["--format", "--limit", "--cursor", "--plan", "--id", "--status"].find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name || (verb === "list" && (name === "--plan" || name === "--id")) || (verb === "get" && (name === "--limit" || name === "--cursor" || name === "--status"))) {
      throw failure(`unrecognized argument '${token}'`, verb);
    }
    if (seen.has(name)) throw failure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try { parsed = readValue(argv, index, name); }
    catch (error) { throw failure((error as Error).message, verb); }
    index = parsed.next;
    if (name === "--format") {
      if (!( ["text", "json", "yaml"] as string[]).includes(parsed.value)) throw failure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--limit") {
      if (!/^[1-9][0-9]*$/.test(parsed.value)) throw failure("--limit must be an integer from 1 through 100", verb);
      limit = Number(parsed.value);
    } else if (name === "--cursor") cursor = parsed.value;
    else if (name === "--status") {
      if (!["open", "complete", "archived"].includes(parsed.value)) throw failure(`invalid --status '${parsed.value}'`, verb);
      status = parsed.value;
    } else if (name === "--plan") plan = parsed.value;
    else id = parsed.value;
  }
  return { format, limit, ...(cursor ? { cursor } : {}), ...(plan ? { plan } : {}), ...(id ? { id } : {}), ...(status ? { status } : {}) };
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

export function runPlans(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(failure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    const args = parse(argv.slice(1), verb);
    if (verb === "get" && (!args.id || args.plan)) throw failure("entity mode requires --id ID and does not accept --plan", verb);
    const response = verb === "list"
      ? listPlanEntities(process.cwd(), args.limit, args.cursor, { format: args.format, ...(args.status ? { statuses: [args.status] } : {}) })
      : getPlanEntity(process.cwd(), args.id!);
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
        syntax: "agentera state plan {list|get} [options]",
        example: "agentera state plan list --format json",
        recovery: "Use supported plan state and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
