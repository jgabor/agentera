import YAML from "yaml";

import { artifactPath, discoverSchemasDir, loadSchemas } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getPlan, listPlans, type PlanListResponse } from "../../../state/planRetrieval.js";
import type { Io } from "../../dispatch/shared.js";

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
        ? "agentera state plan list [--limit N] [--cursor TOKEN] --format json"
        : "agentera state plan get --plan PLAN_ID --format json",
      example: list
        ? "agentera state plan list --limit 20 --format json"
        : "agentera state plan get --plan plan:123e4567-e89b-42d3-a456-426614174000 --format json",
      recovery: "Correct the command using one of the valid forms and retry; no state was changed.",
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

function parse(argv: string[], verb: "list" | "get"): { format: Format; limit: number; cursor?: string; plan?: string } {
  let format: Format = "text";
  let limit = 20;
  let cursor: string | undefined;
  let plan: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length;) {
    const token = argv[index]!;
    const name = ["--format", "--limit", "--cursor", "--plan"].find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name || (verb === "list" && name === "--plan") || (verb === "get" && (name === "--limit" || name === "--cursor"))) {
      throw failure(`unrecognized argument '${token}'`, verb);
    }
    if (seen.has(name)) throw failure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let parsed: { value: string; next: number };
    try {
      parsed = readValue(argv, index, name);
    } catch (error) {
      throw failure((error as Error).message, verb);
    }
    index = parsed.next;
    if (name === "--format") {
      if (!(["text", "json", "yaml"] as string[]).includes(parsed.value)) throw failure(`invalid --format '${parsed.value}'`, verb);
      format = parsed.value as Format;
    } else if (name === "--limit") {
      if (!/^[1-9][0-9]*$/.test(parsed.value)) throw failure("--limit must be an integer from 1 through 100", verb);
      limit = Number(parsed.value);
    } else if (name === "--cursor") cursor = parsed.value;
    else plan = parsed.value;
  }
  if (verb === "get" && plan === undefined) throw failure("--plan is required", verb);
  return { format, limit, ...(cursor ? { cursor } : {}), ...(plan ? { plan } : {}) };
}

function emitFailure(error: StateRetrievalFailure, format: Format, io: Io): number {
  if (format === "json" || format === "yaml") emitStructured(error.body, format, io.out ?? ((text) => process.stdout.write(text)));
  else {
    const detail = error.body.error;
    (io.err ?? ((text) => process.stderr.write(text)))(`Error: ${detail.message}\nClass: ${detail.class}\nRecovery: ${detail.recovery}\n`);
  }
  return error.exitCode;
}

function renderList(response: PlanListResponse): string {
  const lines = [`Plans: order=${response.order} | returned=${response.counts.returned}/${response.counts.total} | status=${response.status}`];
  for (const value of response.entries) {
    const entry = value as Record<string, any>;
    lines.push(`Plan: created=${entry.created} | stable_id=${entry.stable_id} | status=${entry.status} | active=${entry.active} | archived=${entry.archived}`);
  }
  if (response.omitted) {
    lines.push(`Omitted: ${response.omitted_count} plan(s) | reason=${response.omission_reason}`);
    lines.push(`Continue: ${(response.retrieval as any).continue}`);
  }
  lines.push("Get one: agentera state plan get --plan PLAN_ID --format json");
  return lines.join("\n") + "\n";
}

export function runPlans(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(failure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    const args = parse(argv.slice(1), verb);
    const schema = loadSchemas(discoverSchemasDir()).plan;
    if (!schema) throw new Error("plan schema is unavailable");
    const activePath = artifactPath(schema, "plan");
    const response = verb === "list"
      ? listPlans(process.cwd(), activePath, { limit: args.limit, cursor: args.cursor, format: args.format })
      : getPlan(activePath, args.plan!);
    const out = io.out ?? ((text: string) => process.stdout.write(text));
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, out);
    else if (verb === "list") out(renderList(response as PlanListResponse));
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
        syntax: "agentera state plan {list|get} [options]",
        example: "agentera state plan list --format json",
        recovery: "Use supported plan state and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
