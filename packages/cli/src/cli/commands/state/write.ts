import path from "node:path";
import fs from "node:fs";

import { emitInvalidInput, type InvalidInputErrorBody } from "../../errors.js";
import type { Io } from "../../dispatch/shared.js";
import { emitStructured } from "../../structured.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import {
  normalizeArtifactProtocolId,
  VALIDATE_ARTIFACT_PROTOCOL_IDS,
} from "../../../registries/artifactProtocolIds.js";
import {
  buildExplain,
  buildExplainAll,
  assertMutationGrammarParity,
  exampleFor,
  executeStateWrite,
  isWritableArtifact,
  loadStructuredInput,
  operationSpec,
  projectedFields,
  renderExplainText,
  StateWriteInputError,
  verbsForArtifact,
  WRITABLE_ARTIFACTS,
  type OperationField,
  type OperationSpec,
  type WritableArtifact,
} from "../../../state/write/index.js";

interface ParsedWrite {
  artifact: WritableArtifact;
  spec: OperationSpec;
  format: "text" | "json";
  projectRoot: string;
  dryRun: boolean;
  force: boolean;
  values: Record<string, unknown>;
  callerPayload: Record<string, unknown>;
  inputSource: string | null;
}

function formatFromArgv(argv: string[]): "text" | "json" {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--format" && argv[i + 1] === "json") return "json";
    if (argv[i] === "--format=json") return "json";
  }
  return "text";
}

function invalid(body: InvalidInputErrorBody): never {
  throw new StateWriteInputError(body);
}

function emitRetrievalFailure(error: StateRetrievalFailure, format: "text" | "json", io: Io): number {
  if (format === "json") {
    emitStructured(error.body, "json", io.out ?? ((text) => process.stdout.write(text)));
  } else {
    const detail = error.body.error;
    (io.err ?? ((text) => process.stderr.write(text)))([
      `Error: ${detail.message}`,
      `Syntax: ${detail.syntax}`,
      `Example: ${detail.example}`,
      `Recovery: ${detail.recovery}`,
    ].join("\n") + "\n");
  }
  return error.exitCode;
}

function setNested(target: Record<string, unknown>, field: string, value: unknown): void {
  const parts = field.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part]))
      cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1) as string] = value;
}

function hasNested(target: Record<string, unknown>, field: string): boolean {
  let value: unknown = target;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (!(part in value)) return false;
    value = (value as Record<string, unknown>)[part];
  }
  return true;
}

function readFlag(
  argv: string[],
  index: number,
): { name: string; value: string | null; consumed: number } {
  const token = argv[index];
  const equals = token.indexOf("=");
  if (equals > 0)
    return { name: token.slice(0, equals), value: token.slice(equals + 1), consumed: 1 };
  return { name: token, value: argv[index + 1] ?? null, consumed: 2 };
}

function converted(field: OperationField, raw: string): unknown {
  if (field.kind === "boolean") {
    if (raw !== "true" && raw !== "false")
      invalid({
        class: "invalid_choice",
        message: `argument ${field.flag}: expected true or false, got '${raw}'`,
        valid_values: ["true", "false"],
      });
    return raw === "true";
  }
  if (field.kind === "integer") {
    const number = Number(raw);
    if (!Number.isInteger(number))
      invalid({
        class: "invalid_int",
        message: `argument ${field.flag}: invalid int value: '${raw}'`,
        syntax: `${field.flag} N`,
      });
    return number;
  }
  if (field.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    invalid({
      class: "invalid_format",
      message: `argument ${field.flag}: expected YYYY-MM-DD, got '${raw}'`,
      syntax: `${field.flag} YYYY-MM-DD`,
    });
  }
  if (field.kind === "datetime" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) {
    invalid({
      class: "invalid_format",
      message: `argument ${field.flag}: expected YYYY-MM-DD HH:MM, got '${raw}'`,
      syntax: `${field.flag} "YYYY-MM-DD HH:MM"`,
    });
  }
  if (field.validValues && !field.validValues.includes(raw)) {
    const privacySafe = field.field.startsWith("glossary_caveat.");
    invalid({
      class: "invalid_choice",
      message: privacySafe
        ? `argument ${field.flag}: invalid bounded glossary caveat value`
        : `argument ${field.flag}: invalid choice: '${raw}' (choose from ${field.validValues.map((v) => `'${v}'`).join(", ")})`,
      valid_values: field.validValues,
    });
  }
  return raw;
}

function artifactOrReject(raw: string): WritableArtifact {
  const normalized = normalizeArtifactProtocolId(raw);
  if (normalized === null) {
    invalid({
      class: "unsupported_target",
      message: `unsupported artifact "${raw}"; valid artifact_id values: ${VALIDATE_ARTIFACT_PROTOCOL_IDS.join(", ")}`,
      valid_values: [...WRITABLE_ARTIFACTS],
    });
  }
  if (!isWritableArtifact(normalized)) {
    invalid({
      class: "unsupported_target",
      message: `artifact "${normalized}" is read-only through the state writer`,
      valid_values: [...WRITABLE_ARTIFACTS],
      example: "agentera state progress append --input progress.yaml --format json",
    });
  }
  return normalized;
}

function specOrReject(artifact: WritableArtifact, verb: string): OperationSpec {
  const spec = operationSpec(artifact, verb);
  if (!spec) {
    const retrievalVerbs = artifact === "plan" ? ["list", "get", "tasks"] : artifact === "experiments" ? ["list", "get"] : [];
    invalid({
      class: "invalid_choice",
      message: `verb "${verb}" does not apply to ${artifact}`,
      valid_values: [...retrievalVerbs, ...verbsForArtifact(artifact)],
      example: artifact === "experiments"
        ? "agentera state experiments list --objective OBJECTIVE_ID --format json"
        : `agentera state ${artifact} ${artifact === "plan" ? "list --format json" : "explain --format json"}`,
    });
  }
  return spec;
}

function parseWrite(artifactRaw: string, argv: string[]): ParsedWrite {
  const artifact = artifactOrReject(artifactRaw);
  const verb = argv[0];
  if (!verb)
    invalid({
      class: "missing_argument",
      message: `write verb is required for ${artifact}`,
      valid_values: verbsForArtifact(artifact),
    });
  const spec = specOrReject(artifact, verb);
  let initialProjectRoot = process.cwd();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project" && argv[index + 1]) initialProjectRoot = path.resolve(argv[index + 1]);
    else if (token.startsWith("--project=")) initialProjectRoot = path.resolve(token.slice("--project=".length));
  }
  const fields = projectedFields(spec);
  const byFlag = new Map(fields.map((field) => [field.flag, field]));
  const values: Record<string, unknown> = {};
  const callerPayload: Record<string, unknown> = {};
  const occurrences = new Map<string, number>();
  let format: "text" | "json" = "text";
  let projectRoot = initialProjectRoot;
  let dryRun = false;
  let force = false;
  let inputSource: string | null = null;
  for (let i = 1; i < argv.length; ) {
    const token = argv[i];
    if (!token.startsWith("--"))
      invalid({ class: "unrecognized_argument", message: `unrecognized arguments: ${token}` });
    if (token === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    if (token === "--force") {
      force = true;
      i += 1;
      continue;
    }
    const bareBoolean = byFlag.get(token);
    if (bareBoolean?.kind === "boolean") {
      if ((occurrences.get(token) ?? 0) > 0)
        invalid({ class: "mutually_exclusive", message: `${token} may only be supplied once` });
      occurrences.set(token, 1);
      setNested(values, bareBoolean.field, true);
      setNested(callerPayload, bareBoolean.field, true);
      i += 1;
      continue;
    }
    const parsed = readFlag(argv, i);
    if (parsed.value === null || parsed.value.startsWith("--"))
      invalid({
        class: "missing_argument",
        message: `${parsed.name} requires a value`,
        syntax: `${parsed.name} VALUE`,
      });
    i += parsed.consumed;
    if (parsed.name === "--format") {
      if (parsed.value !== "text" && parsed.value !== "json")
        invalid({
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${parsed.value}' (choose from 'text', 'json')`,
          valid_values: ["text", "json"],
        });
      format = parsed.value;
      continue;
    }
    if (parsed.name === "--project") {
      projectRoot = path.resolve(parsed.value);
      continue;
    }
    if (parsed.name === "--input") {
      if (inputSource !== null)
        invalid({ class: "mutually_exclusive", message: "--input may only be supplied once" });
      inputSource = parsed.value;
      continue;
    }
    if (artifact === "decisions" && verb === "append" && parsed.name === "--number") {
      invalid({
        class: "unrecognized_argument",
        message: "--number is assigned by the CLI on append and cannot be supplied",
        example: exampleFor(artifact, verb),
      });
    }
    const field = byFlag.get(parsed.name);
    if (!field) {
      if (spec.inputRoot && inputSource)
        invalid({
          class: "mutually_exclusive",
          message: `--input cannot be combined with ${parsed.name}`,
          syntax: "--input PATH",
          example: exampleFor(artifact, verb),
        });
      invalid({
        class: "unrecognized_argument",
        message: `unrecognized arguments: ${parsed.name}`,
        example: exampleFor(artifact, verb),
      });
    }
    const count = (occurrences.get(parsed.name) ?? 0) + 1;
    occurrences.set(parsed.name, count);
    if (!field.repeatable && count > 1) {
      const message =
        parsed.name === "--alternative-chosen"
          ? `exactly one alternative must be chosen (DV3); received ${count} --alternative-chosen flags`
          : `${parsed.name} may only be supplied once`;
      invalid({ class: "mutually_exclusive", message });
    }
    const value = converted(field, parsed.value);
    if (field.repeatable) {
      const current = (mappingPath(values, field.field) as unknown[] | undefined) ?? [];
      setNested(values, field.field, [...current, value]);
      setNested(callerPayload, field.field, [...current, value]);
    } else {
      setNested(values, field.field, value);
      setNested(callerPayload, field.field, value);
    }
  }
  if (force && !spec.allowForce)
    invalid({
      class: "unrecognized_argument",
      message: `--force does not apply to ${artifact} ${verb}`,
    });
  if (inputSource && !spec.inputRoot)
    invalid({
      class: "mutually_exclusive",
      message: `${artifact} ${verb} accepts field flags, not --input`,
      example: exampleFor(artifact, verb),
    });
  if (spec.inputRoot && !inputSource)
    invalid({
      class: "missing_argument",
      message: `--input is required for ${artifact} ${verb}`,
      syntax: "--input PATH",
      example: exampleFor(artifact, verb),
    });
  const selectorFields = new Set(spec.fields.filter((field) => spec.selectors.includes(field.flag)).map((field) => field.field));
  if (spec.inputRoot && Object.keys(values).some((field) => !selectorFields.has(field)))
    invalid({
      class: "mutually_exclusive",
      message: `--input cannot be combined with field flags for ${artifact} ${verb}`,
    });
  for (const field of fields.filter((candidate) => candidate.required)) {
    if (mappingPath(values, field.field) === undefined) {
      invalid({
        class: "missing_argument",
        message: `${field.flag} is required for ${artifact} ${verb}`,
        valid_values: field.validValues,
        syntax: `${field.flag} VALUE`,
        example: exampleFor(artifact, verb),
      });
    }
  }
  if (artifact === "decisions" && (verb === "update" || verb === "amend")) {
    const id = mappingPath(values, "id");
    const number = mappingPath(values, "number");
    if (number !== undefined) invalid({ class: "unrecognized_argument", message: "numeric decision selectors are unavailable in entity mode; use --id ID" });
    if (id === undefined) invalid({ class: "missing_argument", message: `--id is required for decisions ${verb} in entity mode` });
    if (verb === "amend" && mappingPath(values, "base_sha256") === undefined)
      invalid({ class: "missing_argument", message: "--base-sha256 is required for decisions amend in entity mode" });
  }
  if (artifact === "plan" && verb !== "create") {
    const taskVerb = ["update", "set-status", "supersede", "record-evaluation"].includes(verb);
    const id = mappingPath(values, "id");
    if (taskVerb && id === undefined) invalid({ class: "missing_argument", message: `--id is required for plan ${verb} in entity mode` });
  }
  return { artifact, spec, format, projectRoot, dryRun, force, values, callerPayload, inputSource };
}

function mappingPath(entry: Record<string, unknown>, field: string): unknown {
  let value: unknown = entry;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function explainArgs(argv: string[]): {
  format: "text" | "json";
  project: string;
  verb: string | null;
  all: boolean;
} {
  let format: "text" | "json" = "text";
  let project = process.cwd();
  let verb: string | null = null;
  let all = false;
  for (let i = 1; i < argv.length; ) {
    if (argv[i] === "--all") {
      all = true;
      i += 1;
      continue;
    }
    const parsed = readFlag(argv, i);
    if (parsed.value === null || parsed.value.startsWith("--"))
      invalid({ class: "missing_argument", message: `${parsed.name} requires a value` });
    i += parsed.consumed;
    if (parsed.name === "--format") {
      if (parsed.value !== "text" && parsed.value !== "json")
        invalid({
          class: "invalid_choice",
          message: `argument --format: invalid choice: '${parsed.value}' (choose from 'text', 'json')`,
          valid_values: ["text", "json"],
        });
      format = parsed.value;
    } else if (parsed.name === "--project") project = path.resolve(parsed.value);
    else if (parsed.name === "--verb") verb = parsed.value;
    else
      invalid({
        class: "unrecognized_argument",
        message: `unrecognized arguments: ${parsed.name}`,
      });
  }
  if (all && verb) invalid({ class: "mutually_exclusive", message: "--all cannot be combined with --verb" });
  return { format, project, verb, all };
}

export function runStateWrite(artifactRaw: string, argv: string[], io: Io): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  const err = io.err ?? ((text: string) => process.stderr.write(text));
  const detectedFormat = formatFromArgv(argv);
  try {
    const artifact = artifactOrReject(artifactRaw);
    assertMutationGrammarParity();
    if (argv[0] === "explain") {
      const args = explainArgs(argv);
      const explanation = args.all
        ? buildExplainAll(artifact, args.project)
        : buildExplain(artifact, args.project, args.verb);
      if (args.format === "json") out(JSON.stringify(explanation, null, 2) + "\n");
      else out(renderExplainText(explanation));
      return 0;
    }
    const parsed = parseWrite(artifactRaw, argv);
    let input: Record<string, unknown> | null = null;
    if (parsed.inputSource) {
      try {
        input = loadStructuredInput(parsed.inputSource, io.stdin ?? (() => fsStdin()), parsed.spec.inputMaxBytes);
      } catch (error) {
        const message = (error as Error).message;
        invalid({
          class: message.startsWith("input file") ? "unsupported_target" : message.includes("UTF-8 limit") ? "schema_violation" : "invalid_format",
          message,
          syntax: "--input PATH",
          example: exampleFor(parsed.artifact, parsed.spec.verb),
          ...(message.includes("UTF-8 limit") ? { violations: [message] } : {}),
        });
      }
      for (const owned of parsed.spec.cliOwnedFields ?? []) {
        if (hasNested(input, owned))
          invalid({
            class: "schema_violation",
            message: `${parsed.artifact} ${parsed.spec.verb} assigns ${owned}; remove '${owned}' from the input document`,
            violations: [`CLI-owned field: ${owned}`],
          });
      }
      parsed.callerPayload = structuredClone(input);
    }
    const envelope = executeStateWrite({ ...parsed, input });
    if (parsed.format === "json") out(JSON.stringify(envelope, null, 2) + "\n");
    else if (parsed.dryRun) out(String(envelope.diff ?? "No changes.\n"));
    else {
      const operation = envelope.operation as Record<string, unknown>;
      out(
        `${envelope.command}: ${operation.idempotent_replay ? "idempotent replay" : "wrote"} ${envelope.path}\n`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof StateWriteInputError)
      return emitInvalidInput(io, { format: detectedFormat, body: error.body });
    if (error instanceof StateRetrievalFailure)
      return emitRetrievalFailure(error, detectedFormat, io);
    err(`Error: ${(error as Error).message}\n`);
    return 1;
  }
}

function fsStdin(): Buffer {
  return process.stdin.isTTY ? Buffer.alloc(0) : fs.readFileSync(0);
}
