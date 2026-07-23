import fs from "node:fs";

import { loadStructuredInput } from "../../state/write/input.js";
import { HybridRouteRegistryError, resolveRouteRequest } from "../../registries/hybridRoute.js";
import { emitStructured } from "../structured.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import type { Io } from "../dispatch/shared.js";

type RouteInput = { version?: unknown; request?: unknown };

function parse(argv: string[]): { input: string; format: "json" } | InvalidInputErrorBody {
  let input: string | undefined;
  let format: "json" = "json";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split("=", 2);
    if (name === "--input" || name === "--format") {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
      if (name === "--input") {
        if (input) return { class: "mutually_exclusive", message: "--input may only be supplied once" };
        input = value;
      } else if (value !== "json") {
        return { class: "invalid_choice", message: `argument --format: invalid choice: '${value}' (choose from 'json')`, valid_values: ["json"] };
      }
      continue;
    }
    return { class: "unrecognized_argument", message: "unrecognized route argument; request text must be supplied through --input" };
  }
  if (!input) return { class: "missing_argument", message: "--input is required so request text is not placed in argv", syntax: "--input PATH", example: "agentera route request --input - --format json" };
  return { input, format };
}

export function runRouteRequest(argv: string[], io: Io): number {
  const parsed = parse(argv);
  if ("class" in parsed) return emitInvalidInput(io, { format: "json", body: parsed });
  let input: RouteInput;
  try {
    input = loadStructuredInput(parsed.input, io.stdin ?? readStdin);
  } catch {
    return emitInvalidInput(io, {
      format: "json",
      body: { class: "invalid_format", message: "route request input must be a readable YAML or JSON mapping", syntax: "--input PATH" },
    });
  }
  if (Object.keys(input).some((key) => key !== "version" && key !== "request")) {
    return emitInvalidInput(io, { format: "json", body: { class: "schema_violation", message: "route request input contains unsupported fields" } });
  }
  if (input.version !== undefined && input.version !== "agentera.route_request.v1") {
    return emitInvalidInput(io, { format: "json", body: { class: "schema_violation", message: "route request version must be agentera.route_request.v1" } });
  }
  if (typeof input.request !== "string") {
    return emitInvalidInput(io, { format: "json", body: { class: "invalid_request", message: "route request input requires a string request field" } });
  }
  try {
    emitStructured(resolveRouteRequest(input.request), parsed.format, io.out ?? ((text) => process.stdout.write(text)));
    return 0;
  } catch (error) {
    if (error instanceof HybridRouteRegistryError) {
      return emitInvalidInput(io, { format: "json", body: { class: "conflict", message: "routing authority validation failed before routing" } });
    }
    return emitInvalidInput(io, { format: "json", body: { class: "invalid_request", message: "route request could not be resolved" } });
  }
}

function readStdin(): string {
  return process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
}
