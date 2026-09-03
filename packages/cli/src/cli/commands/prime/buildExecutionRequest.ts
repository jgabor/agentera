import fs from "node:fs";

import { hasControlChars } from "../../argvalidate.js";
import type { InvalidInputErrorBody } from "../../errors.js";
import { loadYamlMapping } from "../../../core/yaml.js";
import { preCutoverCommand } from "../../preCutoverCommand.js";

export const BUILD_EXECUTION_REQUEST_SCHEMA = "agentera.buildExecutionRequest.v1";
export const BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES = 32 * 1024;
export const BUILD_EXECUTION_REQUEST_MAX_ITEMS = 12;
export const BUILD_EXECUTION_REQUEST_MAX_CODE_POINTS = 160;
const BUILD_EXECUTION_REQUEST_READ_CHUNK_BYTES = 8 * 1024;

export interface BuildExecutionRequest {
  schema_version: typeof BUILD_EXECUTION_REQUEST_SCHEMA;
  scope: string;
  acceptance: string[];
  source: {
    kind: "file" | "stdin";
    schema_version: typeof BUILD_EXECUTION_REQUEST_SCHEMA;
    persisted: false;
  };
}

export class BuildExecutionRequestError extends Error {
  constructor(readonly body: InvalidInputErrorBody) {
    super(body.message);
  }
}

function fail(body: InvalidInputErrorBody): never {
  throw new BuildExecutionRequestError(body);
}

function codePointLength(value: string): number {
  return [...value].length;
}

function validateText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail({
      class: "schema_violation",
      message: `Build execution request ${field} must be a non-empty string`,
    });
  }
  if (codePointLength(value) > BUILD_EXECUTION_REQUEST_MAX_CODE_POINTS) {
    fail({
      class: "schema_violation",
      message: `Build execution request ${field} exceeds 160 Unicode code points`,
    });
  }
  if (hasControlChars(value)) {
    fail({
      class: "schema_violation",
      message: `Build execution request ${field} contains control characters`,
    });
  }
  return value;
}

function unreadableInput(): never {
  return fail({
    class: "invalid_format",
    message: "Build execution request input must be one readable regular file or bounded stdin stream",
    syntax: preCutoverCommand("prime --context build --input <file|->"),
  });
}

function oversizedInput(): never {
  return fail({
    class: "schema_violation",
    message: "Build execution request input exceeds the 32768-byte UTF-8 bound",
  });
}

function readBoundedDescriptor(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES) {
    const remaining = BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(BUILD_EXECUTION_REQUEST_READ_CHUNK_BYTES, remaining));
    const count = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
    if (count === 0) break;
    chunks.push(chunk.subarray(0, count));
    total += count;
  }
  if (total > BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES) oversizedInput();
  return Buffer.concat(chunks, total);
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedFile(source: string): Buffer {
  let observed: fs.BigIntStats;
  try {
    observed = fs.lstatSync(source, { bigint: true });
  } catch {
    return unreadableInput();
  }
  if (observed.isSymbolicLink() || !observed.isFile()) unreadableInput();
  if (observed.size > BigInt(BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES)) oversizedInput();

  let fd: number | null = null;
  try {
    fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(observed, opened)) unreadableInput();
    if (opened.size > BigInt(BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES)) oversizedInput();
    return readBoundedDescriptor(fd);
  } catch (error) {
    if (error instanceof BuildExecutionRequestError) throw error;
    return unreadableInput();
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function readBytes(source: string, readStdin?: () => string | Buffer): Buffer {
  if (source !== "-") return readBoundedFile(source);
  if (readStdin) {
    let value: string | Buffer;
    try {
      value = readStdin();
    } catch {
      return unreadableInput();
    }
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    if (bytes.byteLength > BUILD_EXECUTION_REQUEST_MAX_UTF8_BYTES) oversizedInput();
    return bytes;
  }
  if (process.stdin.isTTY) return Buffer.alloc(0);
  try {
    return readBoundedDescriptor(0);
  } catch (error) {
    if (error instanceof BuildExecutionRequestError) throw error;
    return unreadableInput();
  }
}

export function loadBuildExecutionRequest(source: string, readStdin?: () => string | Buffer): BuildExecutionRequest {
  const bytes = readBytes(source, readStdin);

  let input: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    input = loadYamlMapping(text);
  } catch {
    return fail({
      class: "invalid_format",
      message: "Build execution request input must be one valid UTF-8 YAML or JSON mapping",
    });
  }

  const fields = Object.keys(input);
  const expected = ["schema_version", "scope", "acceptance"];
  if (fields.some((field) => !expected.includes(field))) {
    fail({
      class: "schema_violation",
      message: "Build execution request contains unsupported fields",
    });
  }
  if (fields.length !== expected.length || expected.some((field) => !Object.hasOwn(input, field))) {
    fail({
      class: "schema_violation",
      message: "Build execution request requires exactly schema_version, scope, and acceptance",
    });
  }
  if (input.schema_version !== BUILD_EXECUTION_REQUEST_SCHEMA) {
    fail({
      class: "schema_violation",
      message: `Build execution request schema_version must be ${BUILD_EXECUTION_REQUEST_SCHEMA}`,
    });
  }

  const scope = validateText(input.scope, "scope");
  if (!Array.isArray(input.acceptance) || input.acceptance.length < 1 || input.acceptance.length > BUILD_EXECUTION_REQUEST_MAX_ITEMS) {
    fail({
      class: "schema_violation",
      message: "Build execution request acceptance must contain 1 to 12 strings",
    });
  }
  const acceptance = input.acceptance.map((value, index) => validateText(value, `acceptance[${index}]`));
  if (new Set(acceptance).size !== acceptance.length) {
    fail({
      class: "schema_violation",
      message: "Build execution request acceptance must not contain duplicate values",
    });
  }

  return {
    schema_version: BUILD_EXECUTION_REQUEST_SCHEMA,
    scope,
    acceptance,
    source: {
      kind: source === "-" ? "stdin" : "file",
      schema_version: BUILD_EXECUTION_REQUEST_SCHEMA,
      persisted: false,
    },
  };
}
