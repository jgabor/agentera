import YAML from "yaml";

import { artifactPath, discoverSchemasDir, loadSchemas } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getPlanTask, listPlanTasks, type PlanTaskListResponse } from "../../../state/planTaskRetrieval.js";
import type { Io } from "../../dispatch/shared.js";
import { detectStateMode } from "../../../state/stateMode.js";
import { getPlanTaskEntity, listPlanTaskEntities } from "../../../state/planEntities.js";

type Format = "text" | "json" | "yaml";

function requestedFormat(argv: string[]): Format {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = token === "--format" ? argv[index + 1] : token.startsWith("--format=") ? token.slice(9) : undefined;
    if (value === "json" || value === "yaml") return value;
  }
  return "text";
}

function readValue(argv: string[], index: number, name: string): { value: string; next: number } {
  const token = argv[index];
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), next: index + 1 };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return { value, next: index + 2 };
}

function parse(argv: string[], verb: "list" | "get", entityMode: boolean): { format: Format; plan?: string; limit: number; cursor?: string; task?: number; id?: string } {
  let format: Format = "text";
  let plan: string | undefined;
  let limit = 20;
  let cursor: string | undefined;
  let task: number | undefined;
  let id: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; ) {
    const token = argv[index];
    const name = ["--format", "--plan", "--plan-id", "--limit", "--cursor", "--task", "--id"].find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name || (entityMode && ["--plan", "--plan-id", "--task"].includes(name)) || (verb === "list" && (name === "--task" || name === "--id")) || (verb === "get" && (name === "--limit" || name === "--cursor"))) {
      throw requestFailure(`unrecognized argument '${token}'`, verb, entityMode);
    }
    if (seen.has(name)) throw requestFailure(`${name} may only be supplied once`, verb, entityMode);
    seen.add(name);
    let value: string;
    try {
      const parsed = readValue(argv, index, name);
      value = parsed.value;
      index = parsed.next;
    } catch (error) {
      throw requestFailure((error as Error).message, verb, entityMode);
    }
    if (name === "--format") {
      if (!(["text", "json", "yaml"] as string[]).includes(value)) throw requestFailure(`invalid --format '${value}'`, verb, entityMode);
      format = value as Format;
    } else if (name === "--plan" || name === "--plan-id") {
      if (entityMode && name === "--plan") throw requestFailure("entity mode rejects legacy --plan; use --plan-id ID with a bare plan ID", verb, true);
      if (!entityMode && name === "--plan-id") throw requestFailure("legacy mode rejects --plan-id; use --plan PLAN_ID", verb, false);
      plan = value;
    }
    else if (name === "--cursor") cursor = value;
    else if (name === "--limit") {
      if (!/^[1-9][0-9]*$/.test(value)) throw requestFailure("--limit must be an integer from 1 through 100", verb, entityMode);
      limit = Number(value);
    } else if (name === "--task") {
      if (!/^[1-9][0-9]*$/.test(value)) throw requestFailure("--task must be a positive integer without leading zeros", verb, entityMode);
      task = Number(value);
    } else id = value;
  }
  return { format, plan, limit, cursor, task, id };
}

function requestFailure(message: string, verb: "list" | "get", entityMode = false): StateRetrievalFailure {
  const list = verb === "list";
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: list
        ? entityMode ? "agentera state plan tasks list [--limit N] [--cursor TOKEN] --format json" : "agentera state plan tasks list [legacy plan selector] [--limit N] [--cursor TOKEN] --format json"
        : entityMode ? "agentera state plan tasks get --id ID --format json" : "agentera state plan tasks get [legacy plan selector] [legacy task selector] --format json",
      example: list
        ? "agentera state plan tasks list --limit 20 --format json"
        : entityMode ? "agentera state plan tasks get --id qjtrmnpvka --format json" : "agentera state plan tasks get --task 1 --format json",
      recovery: "Correct the command using one of the valid forms and retry; no state was changed.",
      valid_values: list
        ? entityMode ? ["list", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"] : ["list", "legacy plan selector", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
        : entityMode ? ["get", "--id ID", "--format text|json|yaml"] : ["get", "legacy selectors", "--format text|json|yaml"],
    },
  }, 2);
}

function emitFailure(error: StateRetrievalFailure, format: Format, io: Io): number {
  if (format === "json" || format === "yaml") emitStructured(error.body, format, io.out ?? ((text) => process.stdout.write(text)));
  else {
    const detail = error.body.error;
    (io.err ?? ((text) => process.stderr.write(text)))([
      `Error: ${detail.message}`,
      `Class: ${detail.class}`,
      `Valid forms: ${(detail.valid_values ?? [detail.syntax]).join("; ")}`,
      `Syntax: ${detail.syntax}`,
      `Example: ${detail.example}`,
      `Recovery: ${detail.recovery}`,
    ].join("\n") + "\n");
  }
  return error.exitCode;
}

function renderList(response: PlanTaskListResponse): string {
  const lines = [
    `Plan tasks: plan=${response.filters.plan} | order=${response.order} | returned=${response.counts.returned}/${response.counts.total}`,
  ];
  for (const value of response.entries) {
    const entry = value as Record<string, any>;
    lines.push(`Task: number=${entry.task_number} | stable_id=${entry.stable_id} | get=${entry.retrieval.get}`);
  }
  if (response.omitted === true) {
    lines.push(`Omitted: ${response.omitted_count} task(s) | reason=${response.omission_reason}`);
    lines.push(`Continue: ${(response.retrieval as any).continue}`);
    lines.push(`Get one: ${(response.retrieval as any).get}`);
  }
  return lines.join("\n") + "\n";
}

export function runPlanTasks(argv: string[], io: Io): number {
  const format = requestedFormat(argv);
  const verb = argv[0];
  if (verb !== "list" && verb !== "get") return emitFailure(requestFailure(`expected 'list' or 'get', received '${verb ?? "nothing"}'`, "list"), format, io);
  try {
    const entityMode = detectStateMode(process.cwd()) === "entities";
    const args = parse(argv.slice(1), verb, entityMode);
    if (verb === "get" && entityMode && (!args.id || args.task !== undefined)) throw requestFailure("entity mode requires --id ID and rejects numeric --task selectors", verb, true);
    if (verb === "get" && !entityMode && (args.task === undefined || args.id)) throw requestFailure("legacy mode requires --task N and rejects --id", verb);
    const schema = loadSchemas(discoverSchemasDir()).plan;
    if (!schema) throw new Error("plan schema is unavailable");
    const activePath = artifactPath(schema, "plan");
    const response = entityMode
      ? verb === "list" ? listPlanTaskEntities(process.cwd(), undefined, args.limit, args.cursor, { format: args.format }) : getPlanTaskEntity(process.cwd(), args.id!)
      : verb === "list" ? listPlanTasks(process.cwd(), activePath, { plan: args.plan, limit: args.limit, cursor: args.cursor, format: args.format }) : getPlanTask(process.cwd(), activePath, args.task!, args.plan);
    const out = io.out ?? ((text: string) => process.stdout.write(text));
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, out);
    else if (verb === "list") out(entityMode ? YAML.stringify(response) : renderList(response as PlanTaskListResponse));
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
        syntax: "agentera state plan tasks {list|get} [options]",
        example: "agentera state plan tasks list --format json",
        recovery: "Use a supported active plan and retry; no state was changed.",
      },
    }, 1), format, io);
  }
}
