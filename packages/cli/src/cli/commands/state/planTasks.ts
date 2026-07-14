import YAML from "yaml";

import { artifactPath, discoverSchemasDir, loadSchemas } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { getPlanTask, listPlanTasks, type PlanTaskListResponse } from "../../../state/planTaskRetrieval.js";
import type { Io } from "../../dispatch/shared.js";

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

function parse(argv: string[], verb: "list" | "get"): { format: Format; plan?: string; limit: number; cursor?: string; task?: number } {
  let format: Format = "text";
  let plan: string | undefined;
  let limit = 20;
  let cursor: string | undefined;
  let task: number | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; ) {
    const token = argv[index];
    const name = ["--format", "--plan", "--limit", "--cursor", "--task"].find((flag) => token === flag || token.startsWith(`${flag}=`));
    if (!name || (verb === "list" && name === "--task") || (verb === "get" && (name === "--limit" || name === "--cursor"))) {
      throw requestFailure(`unrecognized argument '${token}'`, verb);
    }
    if (seen.has(name)) throw requestFailure(`${name} may only be supplied once`, verb);
    seen.add(name);
    let value: string;
    try {
      const parsed = readValue(argv, index, name);
      value = parsed.value;
      index = parsed.next;
    } catch (error) {
      throw requestFailure((error as Error).message, verb);
    }
    if (name === "--format") {
      if (!(["text", "json", "yaml"] as string[]).includes(value)) throw requestFailure(`invalid --format '${value}'`, verb);
      format = value as Format;
    } else if (name === "--plan") plan = value;
    else if (name === "--cursor") cursor = value;
    else if (name === "--limit") {
      if (!/^[1-9][0-9]*$/.test(value)) throw requestFailure("--limit must be an integer from 1 through 100", verb);
      limit = Number(value);
    } else {
      if (!/^[1-9][0-9]*$/.test(value)) throw requestFailure("--task must be a positive integer without leading zeros", verb);
      task = Number(value);
    }
  }
  if (verb === "get" && task === undefined) throw requestFailure("--task is required", verb);
  return { format, plan, limit, cursor, task };
}

function requestFailure(message: string, verb: "list" | "get"): StateRetrievalFailure {
  const list = verb === "list";
  return new StateRetrievalFailure({
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message,
      syntax: list
        ? "agentera state plan tasks list [--plan PLAN_ID] [--limit N] [--cursor TOKEN] --format json"
        : "agentera state plan tasks get [--plan PLAN_ID] --task N --format json",
      example: list
        ? "agentera state plan tasks list --limit 20 --format json"
        : "agentera state plan tasks get --task 1 --format json",
      recovery: "Correct the command using one of the valid forms and retry; no state was changed.",
      valid_values: list
        ? ["list", "--plan PLAN_ID", "--limit 1..100", "--cursor TOKEN", "--format text|json|yaml"]
        : ["get", "--task N", "--plan PLAN_ID", "--format text|json|yaml"],
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
    const args = parse(argv.slice(1), verb);
    const schema = loadSchemas(discoverSchemasDir()).plan;
    if (!schema) throw new Error("plan schema is unavailable");
    const activePath = artifactPath(schema, "plan");
    const response = verb === "list"
      ? listPlanTasks(process.cwd(), activePath, { plan: args.plan, limit: args.limit, cursor: args.cursor, format: args.format })
      : getPlanTask(process.cwd(), activePath, args.task!, args.plan);
    const out = io.out ?? ((text: string) => process.stdout.write(text));
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, out);
    else if (verb === "list") out(renderList(response as PlanTaskListResponse));
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
