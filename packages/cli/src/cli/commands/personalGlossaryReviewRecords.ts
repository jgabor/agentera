import fs from "node:fs";

import {
  dispositionPersonalGlossaryReviewRecord,
  queuePersonalGlossaryReviewRecord,
  validPersonalGlossaryReviewGenerationBinding,
  validPersonalGlossaryReviewMetadataBinding,
  type PersonalGlossaryReviewQueueResult,
  type PersonalGlossaryReviewDispositionResult,
  type PersonalGlossaryReviewReadRecord,
} from "../../analytics/personalGlossaryReviewRecords.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { personalGlossaryReviewRecordsContract } from "../../registries/glossaryReviewRecordsContract.js";
import {
  getPersonalGlossaryReviewRecord,
  listPersonalGlossaryReviewRecords,
} from "./personalGlossaryReviewRecordReads.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CURSOR_UTF8_BYTES = 4_096;

type Mapping = Record<string, unknown>;
type ReviewStatus = "pending" | "terminal";

interface ReviewRecordsCommandContract {
  command: string;
  queueRequestSchemaVersion: string;
  queueRequestFields: string[];
  queueMaxRequestUtf8Bytes: number;
  queueResultSchemaVersion: string;
  queueResultMaxUtf8Bytes: number;
  dispositionRequestSchemaVersion: string;
  dispositionRequestFields: string[];
  dispositionMaxRequestUtf8Bytes: number;
  dispositionResultSchemaVersion: string;
  dispositionResultMaxUtf8Bytes: number;
  dispositionPublicationAuthorizationDispositions: string[];
  dispositionPublicationAuthorizationFields: string[];
  retrievalSchemaVersion: string;
  owner: string;
  defaultLimit: number;
  maximumLimit: number;
  listMaxSerializedUtf8Bytes: number;
  order: string;
  statuses: ReviewStatus[];
  cursorAuthority: string;
  cursorVocabulary: string;
  cursorBinding: string[];
  cursorInvalidBehavior: string;
  cursorUnavailableBehavior: string;
  exactBindings: string[];
  exactMaxSerializedUtf8Bytes: number;
}

interface ListOptions {
  limit: number;
  cursor?: string;
  status?: ReviewStatus;
}

interface ExactOptions {
  reviewId: string;
  candidateId: string;
  candidateRevision: string;
  generation: string;
  policyVersion: string;
}

interface ReviewFailure {
  class:
    | "review_records_unavailable"
    | "current_binding_mismatch"
    | "review_not_required"
    | "review_record_capacity_exceeded"
    | "review_already_terminal"
    | "review_not_pending"
    | "review_approval_invalid"
    | "review_approval_replayed"
    | "review_approval_unavailable"
    | "review_replay_capacity_exceeded"
    | "cursor_invalid"
    | "cursor_snapshot_unavailable"
    | "not_found"
    | "output_bound_exceeded"
    | "unsupported_state";
  message: string;
  recovery: string;
}

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function contract(): ReviewRecordsCommandContract {
  const value = personalGlossaryReviewRecordsContract();
  const statuses = value.listStatuses as ReviewStatus[];
  if (
    value.command !== "agentera report personal-glossary-reviews" ||
    value.queueRequestSchemaVersion !== "agentera.personalGlossaryReviewQueueRequest.v1" ||
    !sameStrings(value.queueRequestFields, ["schema_version", "receipt"]) ||
    value.queueMaxRequestUtf8Bytes !== 16_384 ||
    value.queueResultSchemaVersion !== "agentera.personalGlossaryReviewQueueResult.v1" ||
    !sameStrings(value.queueResultStatuses, ["queued", "unchanged_replay", "suppressed", "reopened"]) ||
    value.queueMaxResultUtf8Bytes !== 4_096 ||
    value.dispositionRequestSchemaVersion !== "agentera.personalGlossaryReviewDispositionRequest.v1" ||
    !sameStrings(value.dispositionRequestFields, ["schema_version", "review_id", "receipt", "approval"]) ||
    value.dispositionMaxRequestUtf8Bytes !== 16_384 ||
    value.dispositionResultSchemaVersion !== "agentera.personalGlossaryReviewDispositionResult.v1" ||
    !sameStrings(value.dispositionResultStatuses, ["disposed", "unchanged_replay"]) ||
    value.dispositionMaxResultUtf8Bytes !== 4_096 ||
    !sameStrings(value.dispositionPublicationAuthorizationDispositions, ["accept", "correct"]) ||
    !sameStrings(value.dispositionPublicationAuthorizationFields, ["review_id", "review_record_sha256"]) ||
    value.retrievalSchemaVersion !== "agentera.personalGlossaryReviewRetrieval.v1" ||
    value.retrievalOwner !== "current_user" ||
    value.listDefaultLimit !== 20 ||
    value.listMaximumLimit !== 50 ||
    value.listMaxSerializedUtf8Bytes !== 32_768 ||
    value.listOrder !== "queued_at_desc_then_review_id_asc" ||
    !sameStrings(statuses, ["pending", "terminal"]) ||
    value.cursorAuthority !==
      "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor" ||
    value.cursorVocabulary !== "opaque_snapshot_cursor" ||
    !sameStrings(value.cursorBinding, ["collection", "owner", "filters", "limit", "order", "snapshot"]) ||
    value.cursorInvalidBehavior !== "cursor_invalid" ||
    value.cursorUnavailableBehavior !== "cursor_snapshot_unavailable" ||
    !sameStrings(value.exactRequiredBindings, [
      "review_id",
      "candidate_id",
      "candidate_revision",
      "generation",
      "policy_version",
    ]) ||
    value.exactCurrentBindingField !== "candidate_projection_sha256" ||
    value.exactMaxSerializedUtf8Bytes !== 8_192
  ) {
    throw new TypeError("personal glossary review-record command contract is unavailable");
  }
  return {
    command: value.command,
    queueRequestSchemaVersion: value.queueRequestSchemaVersion,
    queueRequestFields: value.queueRequestFields,
    queueMaxRequestUtf8Bytes: value.queueMaxRequestUtf8Bytes,
    queueResultSchemaVersion: value.queueResultSchemaVersion,
    queueResultMaxUtf8Bytes: value.queueMaxResultUtf8Bytes,
    dispositionRequestSchemaVersion: value.dispositionRequestSchemaVersion,
    dispositionRequestFields: value.dispositionRequestFields,
    dispositionMaxRequestUtf8Bytes: value.dispositionMaxRequestUtf8Bytes,
    dispositionResultSchemaVersion: value.dispositionResultSchemaVersion,
    dispositionResultMaxUtf8Bytes: value.dispositionMaxResultUtf8Bytes,
    dispositionPublicationAuthorizationDispositions: value.dispositionPublicationAuthorizationDispositions,
    dispositionPublicationAuthorizationFields: value.dispositionPublicationAuthorizationFields,
    retrievalSchemaVersion: value.retrievalSchemaVersion,
    owner: value.retrievalOwner,
    defaultLimit: value.listDefaultLimit,
    maximumLimit: value.listMaximumLimit,
    listMaxSerializedUtf8Bytes: value.listMaxSerializedUtf8Bytes,
    order: value.listOrder,
    statuses,
    cursorAuthority: value.cursorAuthority,
    cursorVocabulary: value.cursorVocabulary,
    cursorBinding: value.cursorBinding,
    cursorInvalidBehavior: value.cursorInvalidBehavior,
    cursorUnavailableBehavior: value.cursorUnavailableBehavior,
    exactBindings: value.exactRequiredBindings,
    exactMaxSerializedUtf8Bytes: value.exactMaxSerializedUtf8Bytes,
  };
}

export const PERSONAL_GLOSSARY_REVIEW_STRUCTURED_INPUT_SPECS = [
  { action: "queue", option: "--input" },
  { action: "disposition", option: "--input" },
] as const;
const [QUEUE_STRUCTURED_INPUT_SPEC, DISPOSITION_STRUCTURED_INPUT_SPEC] = PERSONAL_GLOSSARY_REVIEW_STRUCTURED_INPUT_SPECS;

function queueSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} ${QUEUE_STRUCTURED_INPUT_SPEC.action} ${QUEUE_STRUCTURED_INPUT_SPEC.option} <file|->`;
}

function dispositionSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} ${DISPOSITION_STRUCTURED_INPUT_SPEC.action} ${DISPOSITION_STRUCTURED_INPUT_SPEC.option} <file|->`;
}

function listSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} list [--status pending|terminal] [--limit N] [--cursor TOKEN]`;
}

function exactSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} get --review-id ID --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY`;
}

function invalid(io: Io, body: InvalidInputErrorBody): number {
  return emitInvalidInput(io, { format: "json", body });
}

function failure(
  io: Io,
  schemaVersion: string,
  command: string,
  syntax: string,
  example: string,
  body: ReviewFailure,
): number {
  emitStructured(
    {
      schemaVersion,
      command,
      status: "fail",
      error: { ...body, syntax, example },
    },
    "json",
    io.out ?? ((text) => process.stdout.write(text)),
  );
  return 1;
}

function argvPart(argument: string): { name: string; inline?: string } {
  const separator = argument.indexOf("=");
  return separator < 0
    ? { name: argument }
    : { name: argument.slice(0, separator), inline: argument.slice(separator + 1) };
}

function boundedText(value: string, maximum: number): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function parseQueue(argv: string[], value: ReviewRecordsCommandContract): { input: string } | InvalidInputErrorBody {
  let input: string | undefined;
  let format = false;
  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = argvPart(argv[index]!);
    if (name !== QUEUE_STRUCTURED_INPUT_SPEC.option && name !== "--format") {
      return { class: "unrecognized_argument", message: "unrecognized review-record argument", syntax: queueSyntax(value) };
    }
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) {
      return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    }
    if (name === "--format") {
      if (format) return { class: "mutually_exclusive", message: "--format may only be supplied once", syntax: queueSyntax(value) };
      if (option !== "json") return { class: "invalid_choice", message: "personal-glossary-reviews requires", valid_values: ["json"] };
      format = true;
      continue;
    }
    if (input !== undefined) return { class: "mutually_exclusive", message: `${QUEUE_STRUCTURED_INPUT_SPEC.option} may only be supplied once`, syntax: queueSyntax(value) };
    input = option;
  }
  return input ? { input } : { class: "missing_argument", message: `${QUEUE_STRUCTURED_INPUT_SPEC.option} is required`, syntax: queueSyntax(value) };
}

function parseDisposition(argv: string[], value: ReviewRecordsCommandContract): { input: string } | InvalidInputErrorBody {
  let input: string | undefined;
  let format = false;
  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = argvPart(argv[index]!);
    if (name !== DISPOSITION_STRUCTURED_INPUT_SPEC.option && name !== "--format") {
      return { class: "unrecognized_argument", message: "unrecognized review disposition argument", syntax: dispositionSyntax(value) };
    }
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) {
      return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    }
    if (name === "--format") {
      if (format) return { class: "mutually_exclusive", message: "--format may only be supplied once", syntax: dispositionSyntax(value) };
      if (option !== "json") return { class: "invalid_choice", message: "personal-glossary-reviews requires", valid_values: ["json"] };
      format = true;
      continue;
    }
    if (input !== undefined) return { class: "mutually_exclusive", message: `${DISPOSITION_STRUCTURED_INPUT_SPEC.option} may only be supplied once`, syntax: dispositionSyntax(value) };
    input = option;
  }
  return input ? { input } : { class: "missing_argument", message: `${DISPOSITION_STRUCTURED_INPUT_SPEC.option} is required`, syntax: dispositionSyntax(value) };
}

function parseList(argv: string[], value: ReviewRecordsCommandContract): ListOptions | InvalidInputErrorBody {
  let limit = value.defaultLimit;
  let cursor: string | undefined;
  let status: ReviewStatus | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = argvPart(argv[index]!);
    if (![
      "--format",
      "--limit",
      "--cursor",
      "--status",
    ].includes(name)) {
      return { class: "unrecognized_argument", message: "unrecognized review-record argument", syntax: listSyntax(value) };
    }
    if (seen.has(name)) return { class: "mutually_exclusive", message: `${name} may only be supplied once`, syntax: listSyntax(value) };
    seen.add(name);
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    if (name === "--format") {
      if (option !== "json") return { class: "invalid_choice", message: "--format must be json", valid_values: ["json"] };
      continue;
    }
    if (name === "--limit") {
      if (!/^[1-9]\d*$/u.test(option)) return { class: "invalid_int", message: "--limit must be a positive integer", syntax: listSyntax(value) };
      const parsed = Number(option);
      if (parsed > value.maximumLimit) return { class: "invalid_choice", message: `--limit must be from 1 to ${value.maximumLimit}`, valid_values: [`1..${value.maximumLimit}`], syntax: listSyntax(value) };
      limit = parsed;
      continue;
    }
    if (name === "--cursor") {
      if (!boundedText(option, MAX_CURSOR_UTF8_BYTES)) return { class: "invalid_request", message: `--cursor must be a non-empty value within ${MAX_CURSOR_UTF8_BYTES} UTF-8 bytes`, syntax: listSyntax(value) };
      cursor = option;
      continue;
    }
    if (!value.statuses.includes(option as ReviewStatus)) {
      return { class: "invalid_choice", message: "--status must be pending or terminal", valid_values: value.statuses, syntax: listSyntax(value) };
    }
    status = option as ReviewStatus;
  }
  return { limit, cursor, status };
}

function parseExact(argv: string[], value: ReviewRecordsCommandContract): ExactOptions | InvalidInputErrorBody {
  const names: Record<string, keyof ExactOptions> = {
    "--review-id": "reviewId",
    "--candidate-id": "candidateId",
    "--candidate-revision": "candidateRevision",
    "--generation": "generation",
    "--policy-version": "policyVersion",
  };
  const fields: Partial<ExactOptions> = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const { name, inline } = argvPart(argv[index]!);
    if (name !== "--format" && !(name in names)) return { class: "unrecognized_argument", message: "unrecognized review-record argument", syntax: exactSyntax(value) };
    if (seen.has(name)) return { class: "mutually_exclusive", message: `${name} may only be supplied once`, syntax: exactSyntax(value) };
    seen.add(name);
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    if (name === "--format") {
      if (option !== "json") return { class: "invalid_choice", message: "--format must be json", valid_values: ["json"] };
      continue;
    }
    fields[names[name]!] = option;
  }
  for (const [flag, field] of Object.entries(names)) {
    if (!fields[field]) return { class: "missing_argument", message: `${flag} is required`, syntax: exactSyntax(value) };
  }
  for (const [flag, field] of [
    ["--review-id", "reviewId"],
    ["--candidate-id", "candidateId"],
    ["--candidate-revision", "candidateRevision"],
  ] as const) {
    if (!SHA256.test(fields[field]!)) {
      return { class: "invalid_request", message: `${flag} must be a lowercase SHA-256 identity`, valid_values: ["64 lowercase hexadecimal characters"], syntax: exactSyntax(value) };
    }
  }
  for (const [flag, field, valid] of [
    ["--generation", "generation", validPersonalGlossaryReviewGenerationBinding],
    ["--policy-version", "policyVersion", validPersonalGlossaryReviewMetadataBinding],
  ] as const) {
    if (!valid(fields[field]!)) {
      return {
        class: "invalid_request",
        message: `${flag} must be a non-secret, non-path value within 256 UTF-8 bytes`,
        syntax: exactSyntax(value),
      };
    }
  }
  return fields as ExactOptions;
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
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(observed, opened) || opened.size > BigInt(maxBytes)) {
      throw new Error("over bound or unreadable");
    }
    return readBoundedDescriptor(descriptor, maxBytes);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
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
  const value = loadYamlMapping(text);
  if (!mapping(value)) throw new Error("not a mapping");
  return value;
}

function validateQueueRequest(
  request: Mapping,
  value: ReviewRecordsCommandContract,
): { receipt: Mapping } | { error: InvalidInputErrorBody } {
  const keys = Object.keys(request);
  if (
    keys.some((key) => !value.queueRequestFields.includes(key)) ||
    value.queueRequestFields.some((field) => !(field in request))
  ) {
    return { error: { class: "schema_violation", message: "personal glossary review queue request fields are invalid", valid_values: value.queueRequestFields } };
  }
  if (request.schema_version !== value.queueRequestSchemaVersion || !mapping(request.receipt)) {
    return { error: { class: "schema_violation", message: `request requires ${value.queueRequestSchemaVersion} and one receipt mapping`, valid_values: [value.queueRequestSchemaVersion, "receipt"] } };
  }
  return { receipt: request.receipt };
}

function validateDispositionRequest(
  request: Mapping,
  value: ReviewRecordsCommandContract,
): { reviewId: string; receipt: Mapping; approval: Mapping } | { error: InvalidInputErrorBody } {
  const keys = Object.keys(request);
  if (
    keys.some((key) => !value.dispositionRequestFields.includes(key)) ||
    value.dispositionRequestFields.some((field) => !(field in request))
  ) {
    return {
      error: {
        class: "schema_violation",
        message: "personal glossary review disposition request fields are invalid",
        valid_values: value.dispositionRequestFields,
      },
    };
  }
  if (
    request.schema_version !== value.dispositionRequestSchemaVersion ||
    typeof request.review_id !== "string" ||
    !SHA256.test(request.review_id) ||
    !mapping(request.receipt) ||
    !mapping(request.approval)
  ) {
    return {
      error: {
        class: "schema_violation",
        message: `request requires ${value.dispositionRequestSchemaVersion}, one review identity, receipt, and approval mappings`,
        valid_values: [value.dispositionRequestSchemaVersion, "review_id", "receipt", "approval"],
      },
    };
  }
  return { reviewId: request.review_id, receipt: request.receipt, approval: request.approval };
}

function reviewSummary(record: PersonalGlossaryReviewReadRecord): Mapping {
  return {
    review_id: record.review_id,
    candidate_id: record.candidate_id,
    candidate_revision: record.candidate_revision,
    candidate_capsule_sha256: record.candidate_capsule_sha256,
    candidate_projection_sha256: record.candidate_projection_sha256,
    host_receipt_sha256: record.host_receipt_sha256,
    cli_decision_sha256: record.cli_decision_sha256,
    semantic_fingerprint: record.semantic_fingerprint,
    generation: record.generation,
    policy_version: record.policy_version,
    scope: record.scope,
    reason: record.reason,
    status: record.status,
    disposition: record.disposition,
    reopen_reason: record.reopen_reason,
    queued_at: record.queued_at,
    terminal_at: record.terminal_at,
    expires_at: record.expires_at,
    record_sha256: record.record_sha256,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function emitQueueSuccess(
  io: Io,
  value: ReviewRecordsCommandContract,
  result: PersonalGlossaryReviewQueueResult,
): number {
  const response: Mapping = {
    schemaVersion: value.queueResultSchemaVersion,
    command: `${value.command} ${QUEUE_STRUCTURED_INPUT_SPEC.action}`,
    status: result.status,
    reason: result.reason,
    reopen_reason: result.reopen_reason,
    owner: value.owner,
    record: reviewSummary(result.record!),
    effects: {
      review_metadata: result.status === "queued" || result.status === "reopened"
        ? "created"
        : result.status === "suppressed"
          ? "unchanged_suppressed"
          : "unchanged_replay",
      profile_entry: "unchanged",
      project_state: "unchanged",
      candidate_projection: "unchanged",
      publication: "unchanged",
    },
  };
  if (serializedBytes(response) > value.queueResultMaxUtf8Bytes) {
    return failure(
      io,
      value.queueResultSchemaVersion,
      `${value.command} ${QUEUE_STRUCTURED_INPUT_SPEC.action}`,
      queueSyntax(value),
      queueSyntax(value),
      {
        class: "output_bound_exceeded",
        message: `review queue response exceeds its ${value.queueResultMaxUtf8Bytes}-byte bound`,
        recovery: "Repair the private review records before retrying; no partial review metadata was returned.",
      },
    );
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

function queueReview(io: Io, input: string, value: ReviewRecordsCommandContract): number {
  let request: Mapping;
  try {
    request = readRequest(input, value.queueMaxRequestUtf8Bytes, io);
  } catch {
    return invalid(io, { class: "invalid_format", message: `${QUEUE_STRUCTURED_INPUT_SPEC.option} must be one readable bounded UTF-8 YAML or JSON mapping` });
  }
  const validated = validateQueueRequest(request, value);
  if ("error" in validated) return invalid(io, validated.error);
  let result: PersonalGlossaryReviewQueueResult;
  try {
    result = queuePersonalGlossaryReviewRecord({ receipt: validated.receipt });
  } catch {
    return failure(
      io,
      value.queueResultSchemaVersion,
      `${value.command} ${QUEUE_STRUCTURED_INPUT_SPEC.action}`,
      queueSyntax(value),
      queueSyntax(value),
      {
        class: "review_records_unavailable",
        message: "the private current-user review records could not be read or written",
        recovery: "Repair the configured profile path or its permissions, then retry; no profile, project, or candidate-projection bytes were changed.",
      },
    );
  }
  if (["queued", "unchanged_replay", "suppressed", "reopened"].includes(result.status)) {
    return emitQueueSuccess(io, value, result);
  }
  const failures: Record<Exclude<PersonalGlossaryReviewQueueResult["status"], "queued" | "unchanged_replay" | "suppressed" | "reopened">, ReviewFailure> = {
    decision_not_review_required: {
      class: "review_not_required",
      message: "the current deterministic decision is not review_required",
      recovery: "Use the current decision outcome without queueing, or submit one current review-required receipt; no review metadata was changed.",
    },
    current_binding_mismatch: {
      class: "current_binding_mismatch",
      message: "the review receipt or decision does not bind the current candidate projection",
      recovery: "Read the current candidate projection, create one matching host receipt, and retry; no review metadata was changed.",
    },
    records_unavailable: {
      class: "review_records_unavailable",
      message: "the private current-user review records are unavailable or invalid",
      recovery: "Repair the private review-record file, then retry; no profile, project, or candidate-projection bytes were changed.",
    },
    record_capacity_exceeded: {
      class: "review_record_capacity_exceeded",
      message: "the bounded private review-record store is full",
      recovery: "Run authenticated review maintenance or purge expired terminal metadata, then retry; no review metadata was changed.",
    },
    already_terminal: {
      class: "review_already_terminal",
      message: "the matching review record is terminal and cannot be silently replaced",
      recovery: "Use the existing terminal review lifecycle or queue a distinct current binding; no review metadata was changed.",
    },
  };
  return failure(
    io,
    value.queueResultSchemaVersion,
    `${value.command} ${QUEUE_STRUCTURED_INPUT_SPEC.action}`,
    queueSyntax(value),
    queueSyntax(value),
    failures[result.status as Exclude<PersonalGlossaryReviewQueueResult["status"], "queued" | "unchanged_replay" | "suppressed" | "reopened">],
  );
}

function emitDispositionSuccess(
  io: Io,
  value: ReviewRecordsCommandContract,
  result: PersonalGlossaryReviewDispositionResult,
): number {
  const response: Mapping = {
    schemaVersion: value.dispositionResultSchemaVersion,
    command: `${value.command} ${DISPOSITION_STRUCTURED_INPUT_SPEC.action}`,
    status: result.status,
    owner: value.owner,
    record: reviewSummary(result.record!),
    publication_authorization: result.publication_authorization,
    effects: {
      review_metadata: result.status === "disposed" ? "changed" : "unchanged_replay",
      profile_entry: "unchanged",
      project_state: "unchanged",
      candidate_projection: "unchanged",
      publication: "unchanged",
    },
  };
  if (serializedBytes(response) > value.dispositionResultMaxUtf8Bytes) {
    return failure(
      io,
      value.dispositionResultSchemaVersion,
      `${value.command} ${DISPOSITION_STRUCTURED_INPUT_SPEC.action}`,
      dispositionSyntax(value),
      dispositionSyntax(value),
      {
        class: "output_bound_exceeded",
        message: `review disposition response exceeds its ${value.dispositionResultMaxUtf8Bytes}-byte bound`,
        recovery: "Repair the private review records before retrying; no partial review metadata was returned.",
      },
    );
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

function dispositionReview(io: Io, input: string, value: ReviewRecordsCommandContract): number {
  let request: Mapping;
  try {
    request = readRequest(input, value.dispositionMaxRequestUtf8Bytes, io);
  } catch {
    return invalid(io, { class: "invalid_format", message: `${DISPOSITION_STRUCTURED_INPUT_SPEC.option} must be one readable bounded UTF-8 YAML or JSON mapping` });
  }
  const validated = validateDispositionRequest(request, value);
  if ("error" in validated) return invalid(io, validated.error);
  let result: PersonalGlossaryReviewDispositionResult;
  try {
    result = dispositionPersonalGlossaryReviewRecord({
      review_id: validated.reviewId,
      receipt: validated.receipt,
      approval: validated.approval,
    });
  } catch {
    return failure(
      io,
      value.dispositionResultSchemaVersion,
      `${value.command} ${DISPOSITION_STRUCTURED_INPUT_SPEC.action}`,
      dispositionSyntax(value),
      dispositionSyntax(value),
      {
        class: "review_records_unavailable",
        message: "the private current-user review records could not be read or written",
        recovery: "Repair the configured profile path or its permissions, then retry; no profile, project, or candidate-projection bytes were changed.",
      },
    );
  }
  if (result.status === "disposed" || result.status === "unchanged_replay") {
    return emitDispositionSuccess(io, value, result);
  }
  const failures: Record<Exclude<PersonalGlossaryReviewDispositionResult["status"], "disposed" | "unchanged_replay">, ReviewFailure> = {
    review_not_found: {
      class: "not_found",
      message: "the requested current review record was not found",
      recovery: "List current private review records and copy one current review identity; no review metadata was changed.",
    },
    review_not_pending: {
      class: "review_not_pending",
      message: "the requested review is terminal and cannot receive another disposition",
      recovery: "Use its existing publication authorization or queue a current distinct review; no review metadata was changed.",
    },
    current_binding_mismatch: {
      class: "current_binding_mismatch",
      message: "the review receipt or deterministic decision no longer binds the current candidate projection",
      recovery: "Read the current candidate, create matching host classification evidence, and retry; no review metadata was changed.",
    },
    approval_invalid: {
      class: "review_approval_invalid",
      message: "the current-user review approval is invalid or no longer fresh",
      recovery: "Request a new signed current-user local-host approval for this current review, then retry; no review metadata was changed.",
    },
    approval_conflicting_replay: {
      class: "review_approval_replayed",
      message: "the review approval nonce was already used with different signed content",
      recovery: "Request a new signed current-user local-host approval with a new nonce, then retry; no review metadata was changed.",
    },
    approval_unavailable: {
      class: "review_approval_unavailable",
      message: "the configured trusted local-host key is unavailable or invalid",
      recovery: "Repair the user-local trusted host key configuration, then retry; no review metadata was changed.",
    },
    records_unavailable: {
      class: "review_records_unavailable",
      message: "the private current-user review records are unavailable or invalid",
      recovery: "Repair the private review-record file, then retry; no profile, project, or candidate-projection bytes were changed.",
    },
    replay_capacity_exceeded: {
      class: "review_replay_capacity_exceeded",
      message: "the bounded review approval replay index is full",
      recovery: "Run authenticated review maintenance after receipt expiry, then retry; no review metadata was changed.",
    },
  };
  return failure(
    io,
    value.dispositionResultSchemaVersion,
    `${value.command} ${DISPOSITION_STRUCTURED_INPUT_SPEC.action}`,
    dispositionSyntax(value),
    dispositionSyntax(value),
    failures[result.status],
  );
}

/** Run the private, noninteractive review queue, disposition, and read operations. */
export function runPersonalGlossaryReviewRecordsCommand(argv: string[], io: Io): number {
  let value: ReviewRecordsCommandContract;
  try {
    value = contract();
  } catch {
    return failure(
      io,
      "agentera.personalGlossaryReviewRetrieval.v1",
      "agentera report personal-glossary-reviews",
      "agentera report personal-glossary-reviews {queue,disposition,list,get}",
      "agentera report personal-glossary-reviews list --limit 20",
      {
        class: "unsupported_state",
        message: "personal glossary review-record contract is unavailable",
        recovery: "Restore the bundled glossary authority, then retry; no review metadata was changed.",
      },
    );
  }
  const operation = argv[0];
  const structuredInputSpec = PERSONAL_GLOSSARY_REVIEW_STRUCTURED_INPUT_SPECS.find(({ action }) => action === operation);
  const validOperations = [...PERSONAL_GLOSSARY_REVIEW_STRUCTURED_INPUT_SPECS.map(({ action }) => action), "list", "get"];
  if (!structuredInputSpec && operation !== "list" && operation !== "get") {
    return invalid(io, {
      class: operation ? "unsupported_target" : "missing_argument",
      message: operation ? "unsupported personal glossary review operation" : "review operation is required",
      valid_values: validOperations,
      syntax: `${value.command} {${validOperations.join(",")}}`,
      example: `${value.command} list --limit ${value.defaultLimit}`,
      recovery: "Choose queue, disposition, list, or get and retry; no review metadata was changed.",
    });
  }
  if (structuredInputSpec === QUEUE_STRUCTURED_INPUT_SPEC) {
    const parsed = parseQueue(argv.slice(1), value);
    if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the bounded queue request and retry; no review metadata was changed." });
    return queueReview(io, parsed.input, value);
  }
  if (structuredInputSpec === DISPOSITION_STRUCTURED_INPUT_SPEC) {
    const parsed = parseDisposition(argv.slice(1), value);
    if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the bounded disposition request and retry; no review metadata was changed." });
    return dispositionReview(io, parsed.input, value);
  }
  if (operation === "list") {
    const parsed = parseList(argv.slice(1), value);
    if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the bounded list request and retry; no review metadata was changed." });
    return listPersonalGlossaryReviewRecords(io, parsed, value);
  }
  const parsed = parseExact(argv.slice(1), value);
  if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the exact review binding and retry; no review metadata was changed." });
  return getPersonalGlossaryReviewRecord(io, parsed, value);
}
