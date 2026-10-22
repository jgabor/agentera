import fs from "node:fs";
import { TextDecoder } from "node:util";

import { loadYamlMapping } from "../../core/yaml.js";
import { HybridRouteRegistryError, resolveRouteRequest } from "../../registries/hybridRoute.js";
import { RouteReceiptValidationError, validateRouteReceiptSubmission } from "../../registries/hybridRouteReceipt.js";
import { evaluateHybridRoute } from "../../eval/hybridRouteEvaluation.js";
import { emitStructured } from "../structured.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import type { Io } from "../dispatch/shared.js";
import { preCutoverCommand } from "../preCutoverCommand.js";
import { BUILD_EXECUTION_REQUEST_SCHEMA } from "./prime/buildExecutionRequest.js";

type RouteInput = { version?: unknown; request?: unknown };
type RouteIo = Omit<Io, "stdin"> & { stdin?: () => string | Buffer };

/** A conformance report that fails is a failed CLI gate, not a successful invocation. */
export const ROUTE_EVALUATION_FAILED_EXIT_CODE = 1;

export function routeEvaluationExitCode(report: { status?: unknown }): number {
  return report.status === "fail" ? ROUTE_EVALUATION_FAILED_EXIT_CODE : 0;
}

function decodeRouteInput(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function loadRouteInput(source: string, readStdin: () => string | Buffer): RouteInput {
  let bytes: Buffer;
  try {
    if (source === "-") {
      const stdin = readStdin();
      bytes = typeof stdin === "string" ? Buffer.from(stdin, "utf8") : stdin;
    } else {
      bytes = fs.readFileSync(source);
    }
  } catch {
    throw new Error("route request input is not readable");
  }
  return loadYamlMapping(decodeRouteInput(bytes)) as RouteInput;
}

function invalidRouteInput(io: RouteIo, body: InvalidInputErrorBody): number {
  return emitInvalidInput({ out: io.out, err: io.err }, { format: "json", body });
}

function parse(argv: string[]): { input: string; format: "json" } | InvalidInputErrorBody {
  let input: string | undefined;
  let format = "json" as const;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inline] = argument.split("=", 2);
    if (name === "--input" || name === "--format") {
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--"))
        return {
          class: "missing_argument",
          message: `${name} requires a value`,
          syntax: `${name} VALUE`,
        };
      if (name === "--input") {
        if (input) return { class: "mutually_exclusive", message: "--input may only be supplied once" };
        input = value;
      } else if (value !== "json") {
        return {
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${value}' (choose from 'json')`,
          valid_values: ["json"],
        };
      }
      continue;
    }
    return {
      class: "unrecognized_argument",
      message: "unrecognized route argument; request text must be supplied through --input",
    };
  }
  if (!input)
    return {
      class: "missing_argument",
      message: "--input is required so request text is not placed in argv",
      syntax: "--input PATH",
      example: preCutoverCommand("route request --input -"),
    };
  return { input, format };
}

/** The request text from an agentera.route_request.v1 mapping, or the input
 *  error that rejects it. Route request and prime --input share this check. */
export function routeRequestText(input: RouteInput): string | InvalidInputErrorBody {
  if (Object.keys(input).some((key) => key !== "version" && key !== "request")) {
    return { class: "schema_violation", message: "route request input contains unsupported fields" };
  }
  if (input.version !== undefined && input.version !== "agentera.route_request.v1") {
    return { class: "schema_violation", message: "route request version must be agentera.route_request.v1" };
  }
  if (typeof input.request !== "string") {
    return { class: "invalid_request", message: "route request input requires a string request field" };
  }
  return input.request;
}

export function runRouteRequest(argv: string[], io: Io): number;
export function runRouteRequest(argv: string[], io: RouteIo): number;
export function runRouteRequest(argv: string[], io: RouteIo): number {
  const parsed = parse(argv);
  if ("class" in parsed) return invalidRouteInput(io, parsed);
  let input: RouteInput;
  try {
    input = loadRouteInput(parsed.input, io.stdin ?? readStdin);
  } catch {
    return invalidRouteInput(io, {
      class: "invalid_format",
      message: "route request input must be a readable YAML or JSON mapping",
      syntax: "--input PATH",
    });
  }
  const request = routeRequestText(input);
  if (typeof request !== "string") return invalidRouteInput(io, request);
  try {
    emitStructured(resolveRouteRequest(request), parsed.format, io.out ?? ((text) => process.stdout.write(text)));
    return 0;
  } catch (error) {
    if (error instanceof HybridRouteRegistryError) {
      return invalidRouteInput(io, {
        class: "conflict",
        message: "routing authority validation failed before routing",
      });
    }
    return invalidRouteInput(io, {
      class: "invalid_request",
      message: "route request could not be resolved",
    });
  }
}

/** Validate a host's nullable receipt and emit startup authorization only. */
export function runRouteReceipt(argv: string[], io: Io): number;
export function runRouteReceipt(argv: string[], io: RouteIo): number;
export function runRouteReceipt(argv: string[], io: RouteIo): number {
  const parsed = parse(argv);
  if ("class" in parsed) return invalidRouteInput(io, parsed);
  let input: unknown;
  try {
    input = loadRouteInput(parsed.input, io.stdin ?? readStdin);
    emitStructured(validateRouteReceiptSubmission(input), parsed.format, io.out ?? ((text) => process.stdout.write(text)));
    return 0;
  } catch (error) {
    const message = error instanceof RouteReceiptValidationError ? `invalid route receipt at ${error.field}: ${error.message}` : "route receipt input must be a readable UTF-8 YAML or JSON mapping";
    return emitInvalidInput(
      { out: io.out, err: io.err },
      {
        format: "json",
        body: {
          class: "invalid_receipt",
          message,
          recovery: "Submit the original request and a complete nullable host receipt through --input; no capability was started.",
        },
        exitCode: 64,
      },
    );
  }
}

/** Run the contract-owned frozen synthetic corpus without invoking a semantic host. */
export function runRouteEvaluation(argv: string[], io: RouteIo): number {
  if (argv.length !== 2 || argv[0] !== "--format" || argv[1] !== "json") {
    return invalidRouteInput(io, {
      class: "unrecognized_argument",
      message: "route evaluation accepts only and never accepts request text or corpus overrides",
      syntax: preCutoverCommand("route evaluate"),
    });
  }
  try {
    const report = evaluateHybridRoute();
    emitStructured(report, "json", io.out ?? ((text) => process.stdout.write(text)));
    return routeEvaluationExitCode(report);
  } catch {
    return invalidRouteInput(io, {
      class: "conflict",
      message: "routing evaluation authority validation failed before evaluation",
      recovery: "Restore the contract-owned corpus and authorities, then retry; no request was sent or persisted.",
    });
  }
}

function readStdin(): Buffer {
  return process.stdin.isTTY ? Buffer.alloc(0) : fs.readFileSync(0);
}

/** Bound for the route request mapping prime reads through --input. */
export const PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES = 32 * 1024;
const READ_CHUNK_BYTES = 8 * 1024;

export class PrimeRouteRequestError extends Error {
  constructor(readonly body: InvalidInputErrorBody) {
    super(body.message);
  }
}

function fail(body: InvalidInputErrorBody): never {
  throw new PrimeRouteRequestError(body);
}

const SYNTAX = preCutoverCommand("prime --input <file|->");

function unreadable(): never {
  return fail({ class: "invalid_format", message: "route request input must be one readable file or a piped stdin stream", syntax: SYNTAX });
}

function oversized(): never {
  return fail({ class: "schema_violation", message: `route request input exceeds the ${PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES}-byte UTF-8 bound` });
}

const RETRY_WAIT = new Int32Array(new SharedArrayBuffer(4));

/** A host that spawns the CLI may hand it a non-blocking stdin that has no
 *  bytes yet; wait for them instead of failing with EAGAIN. */
function readChunk(fd: number, chunk: Buffer): number {
  for (;;) {
    try {
      return fs.readSync(fd, chunk, 0, chunk.byteLength, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      Atomics.wait(RETRY_WAIT, 0, 0, 10);
    }
  }
}

/** Read at most one byte past the bound, so an oversized stream is never read whole. */
function readBounded(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES + 1 - total));
    const count = readChunk(fd, chunk);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES) oversized();
  return Buffer.concat(chunks, total);
}

function readBytes(source: string, readStdin?: () => string | Buffer): Buffer {
  try {
    if (source === "-") {
      if (readStdin) {
        const value = readStdin();
        return typeof value === "string" ? Buffer.from(value, "utf8") : value;
      }
      // An interactive terminal has no request mapping to read.
      if (process.stdin.isTTY) return Buffer.alloc(0);
      return readBounded(0);
    }
    // Check the path before opening it, so a FIFO or device never blocks the open.
    const observed = fs.lstatSync(source);
    if (observed.isSymbolicLink() || !observed.isFile()) unreadable();
    const fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== observed.ino || opened.dev !== observed.dev) unreadable();
      return readBounded(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error instanceof PrimeRouteRequestError) throw error;
    return unreadable();
  }
}

/** Load the agentera.route_request.v1 mapping that route request accepts and
 *  return its request text. Request text never comes from argv. */
export function loadPrimeRouteRequest(source: string, readStdin?: () => string | Buffer): string {
  const bytes = readBytes(source, readStdin);
  if (bytes.byteLength > PRIME_ROUTE_REQUEST_MAX_UTF8_BYTES) oversized();
  if (bytes.byteLength === 0) {
    fail({ class: "invalid_format", message: "route request input is empty", syntax: SYNTAX });
  }
  let input: Record<string, unknown>;
  try {
    input = loadYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail({ class: "invalid_format", message: "route request input must be one valid UTF-8 YAML or JSON mapping", syntax: SYNTAX });
  }
  if (input.schema_version === BUILD_EXECUTION_REQUEST_SCHEMA) {
    fail({
      class: "unsupported_target",
      message: `an ${BUILD_EXECUTION_REQUEST_SCHEMA} request needs prime --context build`,
      syntax: preCutoverCommand("prime --context build --input <file|->"),
    });
  }
  const request = routeRequestText(input);
  if (typeof request !== "string") fail({ ...request, syntax: SYNTAX });
  return request;
}
