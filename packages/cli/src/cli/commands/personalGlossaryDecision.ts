import fs from "node:fs";

import { decidePersonalGlossaryCandidate } from "../../analytics/personalGlossaryDecision.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { personalGlossaryCandidateDecisionContract } from "../../registries/glossaryCandidateDecisionContract.js";
import type { PersonalGlossaryCandidateDecisionContract } from "../../registries/personalGlossaryContracts.js";
import type { Io } from "../dispatch/shared.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";

type Mapping = Record<string, unknown>;

const COMMAND = "agentera report personal-glossary-decision --input <file|-> --format json";
const RECOVERY =
  "Correct the bounded decision request and retry; no projection, review, profile, or project bytes were changed.";

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function invalid(io: Io, body: InvalidInputErrorBody): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery: body.recovery ?? RECOVERY } });
}

function contract(): PersonalGlossaryCandidateDecisionContract {
  const value = personalGlossaryCandidateDecisionContract();
  if (
    value.command !== "agentera report personal-glossary-decision" ||
    value.requestSchemaVersion !== "agentera.personalGlossaryAdmissionRequest.v1" ||
    JSON.stringify(value.requestFields) !== JSON.stringify(["schema_version", "receipt"]) ||
    value.maxRequestUtf8Bytes !== 16_384 ||
    value.resultSchemaVersion !== "agentera.personalGlossaryAdmissionResult.v1" ||
    JSON.stringify(value.resultFields) !==
      JSON.stringify(["schemaVersion", "command", "status", "decision", "reason", "effects"]) ||
    JSON.stringify(value.resultStatuses) !==
      JSON.stringify(["automatic_admission", "review_required", "abstain"]) ||
    value.maxResultUtf8Bytes !== 4_096 ||
    value.automaticProvenance !== "provenance_variants.personal_explicit_definition" ||
    value.inferredAutomaticAdmission !== "disabled" ||
    value.qualityGate !== "personal_mining_authority.admission.quality_threshold"
  ) {
    throw new Error("personal glossary decision contract is unavailable");
  }
  return value;
}

function parseArgs(argv: string[]): { input: string } | InvalidInputErrorBody {
  let input: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (name !== "--input" && name !== "--format") {
      return { class: "unrecognized_argument", message: `unrecognized arguments: ${name}`, syntax: COMMAND };
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) {
      return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    }
    if (name === "--format") {
      if (value !== "json") {
        return {
          class: "invalid_choice",
          message: "personal-glossary-decision requires --format json",
          valid_values: ["json"],
        };
      }
      continue;
    }
    if (input !== undefined) {
      return { class: "mutually_exclusive", message: "--input may only be supplied once" };
    }
    input = value;
  }
  return input ? { input } : { class: "missing_argument", message: "--input is required", syntax: COMMAND };
}

function readBoundedDescriptor(fd: number, maxBytes: number): Buffer {
  const bytes = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset > maxBytes) throw new Error("over bound");
  return bytes.subarray(0, offset);
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readBoundedFile(source: string, maxBytes: number): Buffer {
  const observed = fs.lstatSync(source, { bigint: true });
  if (observed.isSymbolicLink() || !observed.isFile() || observed.size > BigInt(maxBytes)) {
    throw new Error("over bound or unreadable");
  }
  let fd: number | null = null;
  try {
    fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(observed, opened) || opened.size > BigInt(maxBytes)) {
      throw new Error("over bound or unreadable");
    }
    return readBoundedDescriptor(fd, maxBytes);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function readBoundedStdin(maxBytes: number, io: Io): Buffer {
  if (io.stdin) {
    const value = io.stdin();
    if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error("over bound");
    return Buffer.from(value, "utf8");
  }
  if (process.stdin.isTTY) return Buffer.alloc(0);
  return readBoundedDescriptor(0, maxBytes);
}

function readRequest(source: string, maxBytes: number, io: Io): Mapping {
  const bytes = source === "-" ? readBoundedStdin(maxBytes, io) : readBoundedFile(source, maxBytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = mapping(loadYamlMapping(text));
  if (!value) throw new Error("not a mapping");
  return value;
}

function validateRequest(
  request: Mapping,
  value: PersonalGlossaryCandidateDecisionContract,
): { receipt: Mapping } | { error: InvalidInputErrorBody } {
  const keys = Object.keys(request);
  if (
    keys.some((key) => !value.requestFields.includes(key)) ||
    value.requestFields.some((field) => !(field in request))
  ) {
    return {
      error: {
        class: "schema_violation",
        message: "personal glossary decision request fields are invalid",
        valid_values: value.requestFields,
      },
    };
  }
  if (request.schema_version !== value.requestSchemaVersion || !mapping(request.receipt)) {
    return {
      error: {
        class: "schema_violation",
        message: `request requires ${value.requestSchemaVersion} and one receipt mapping`,
        valid_values: [value.requestSchemaVersion, "receipt"],
      },
    };
  }
  return { receipt: request.receipt as Mapping };
}

function emitResult(
  value: ReturnType<typeof decidePersonalGlossaryCandidate>,
  contractValue: PersonalGlossaryCandidateDecisionContract,
  io: Io,
): number {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > contractValue.maxResultUtf8Bytes) {
    return invalid(io, {
      class: "invalid_request",
      message: `personal glossary decision result exceeds ${contractValue.maxResultUtf8Bytes} UTF-8 bytes`,
    });
  }
  (io.out ?? ((line) => process.stdout.write(line)))(text);
  return 0;
}

/** Run the read-only host-receipt validation and deterministic decision boundary. */
export function runPersonalGlossaryDecisionCommand(argv: string[], io: Io): number {
  let contractValue: PersonalGlossaryCandidateDecisionContract;
  try {
    contractValue = contract();
  } catch {
    return invalid(io, {
      class: "invalid_request",
      message: "personal glossary decision contract is unavailable",
      recovery: "Restore the bundled glossary authority, then retry; no bytes were changed.",
    });
  }
  const parsedArgs = parseArgs(argv);
  if ("class" in parsedArgs) return invalid(io, parsedArgs);
  let request: Mapping;
  try {
    request = readRequest(parsedArgs.input, contractValue.maxRequestUtf8Bytes, io);
  } catch {
    return invalid(io, {
      class: "invalid_format",
      message: "--input must be one readable bounded UTF-8 YAML or JSON mapping",
    });
  }
  const validated = validateRequest(request, contractValue);
  if ("error" in validated) return invalid(io, validated.error);
  return emitResult(decidePersonalGlossaryCandidate(validated.receipt), contractValue, io);
}
