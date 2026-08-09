import fs from "node:fs";

import {
  currentPersonalGlossaryReviewRecords,
  personalGlossaryReviewRecordsPath,
  queuePersonalGlossaryReviewRecord,
  readPersonalGlossaryReviewRecords,
  validPersonalGlossaryReviewMetadataBinding,
  type PersonalGlossaryReviewQueueResult,
  type PersonalGlossaryReviewRecord,
} from "../../analytics/personalGlossaryReviewRecords.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { shellQuoteArgument } from "../../core/shell.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { personalGlossaryReviewRecordsContract } from "../../registries/glossaryReviewRecordsContract.js";
import { canonicalGlossaryJson, compareGlossaryUnicodeStrings } from "../../registries/glossaryTermIdentity.js";
import { glossaryEntryAuthorityPath } from "../../registries/glossaryEntryContract.js";
import { decodeListCursor, encodeListCursor, projectedListSnapshot } from "../../state/listCursor.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";

const COLLECTION = "personal_glossary_review_records";
const CURSOR_VERSION = 1;
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
    !sameStrings(value.queueResultStatuses, ["queued", "unchanged_replay"]) ||
    value.queueMaxResultUtf8Bytes !== 4_096 ||
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

function queueSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} queue --input <file|-> --format json`;
}

function listSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} list [--status pending|terminal] [--limit N] [--cursor TOKEN] --format json`;
}

function exactSyntax(value: ReviewRecordsCommandContract): string {
  return `${value.command} get --review-id ID --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY --format json`;
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
    if (name !== "--input" && name !== "--format") {
      return { class: "unrecognized_argument", message: "unrecognized review-record argument", syntax: queueSyntax(value) };
    }
    const option = inline ?? argv[++index];
    if (!option || option.startsWith("--")) {
      return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    }
    if (name === "--format") {
      if (format) return { class: "mutually_exclusive", message: "--format may only be supplied once", syntax: queueSyntax(value) };
      if (option !== "json") return { class: "invalid_choice", message: "personal-glossary-reviews requires --format json", valid_values: ["json"] };
      format = true;
      continue;
    }
    if (input !== undefined) return { class: "mutually_exclusive", message: "--input may only be supplied once", syntax: queueSyntax(value) };
    input = option;
  }
  return input ? { input } : { class: "missing_argument", message: "--input is required", syntax: queueSyntax(value) };
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
  for (const [flag, field] of [
    ["--generation", "generation"],
    ["--policy-version", "policyVersion"],
  ] as const) {
    if (!validPersonalGlossaryReviewMetadataBinding(fields[field]!)) {
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

function reviewSummary(record: PersonalGlossaryReviewRecord): Mapping {
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
    reason: record.reason,
    status: record.status,
    queued_at: record.queued_at,
    terminal_at: record.terminal_at,
    expires_at: record.expires_at,
    record_sha256: record.record_sha256,
  };
}

function filters(options: ListOptions): Mapping {
  return { status: options.status ?? null };
}

function reviewOrder(left: PersonalGlossaryReviewRecord, right: PersonalGlossaryReviewRecord): number {
  return (
    Date.parse(right.queued_at) - Date.parse(left.queued_at) ||
    compareGlossaryUnicodeStrings(left.review_id, right.review_id)
  );
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listFlags(options: ListOptions): string {
  return options.status ? ` --status ${shellQuoteArgument(options.status)}` : "";
}

function currentRecords(
  io: Io,
  value: ReviewRecordsCommandContract,
  operation: "list" | "get",
) {
  const result = currentPersonalGlossaryReviewRecords();
  if (result.status === "current") return result;
  failure(
    io,
    value.retrievalSchemaVersion,
    `${value.command} ${operation}`,
    operation === "list" ? listSyntax(value) : exactSyntax(value),
    operation === "list" ? `${value.command} list --limit ${value.defaultLimit} --format json` : exactSyntax(value),
    {
      class: result.status === "projection_unavailable" ? "current_binding_mismatch" : "review_records_unavailable",
      message: result.status === "projection_unavailable"
        ? "current review metadata cannot bind the current candidate projection"
        : "the private current-user review records are unavailable or invalid",
      recovery: result.status === "projection_unavailable"
        ? "Create or repair the current candidate projection, then retry; no review metadata was changed."
        : "Create or repair the private current-user review records, then retry; no review metadata was changed.",
    },
  );
  return null;
}

function emitQueueSuccess(
  io: Io,
  value: ReviewRecordsCommandContract,
  result: PersonalGlossaryReviewQueueResult,
): number {
  const response: Mapping = {
    schemaVersion: value.queueResultSchemaVersion,
    command: `${value.command} queue`,
    status: result.status,
    reason: result.reason,
    owner: value.owner,
    record: reviewSummary(result.record!),
    effects: {
      review_metadata: result.status === "queued" ? "created" : "unchanged_replay",
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
      `${value.command} queue`,
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
    return invalid(io, { class: "invalid_format", message: "--input must be one readable bounded UTF-8 YAML or JSON mapping" });
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
      `${value.command} queue`,
      queueSyntax(value),
      queueSyntax(value),
      {
        class: "review_records_unavailable",
        message: "the private current-user review records could not be read or written",
        recovery: "Repair the configured profile path or its permissions, then retry; no profile, project, or candidate-projection bytes were changed.",
      },
    );
  }
  if (result.status === "queued" || result.status === "unchanged_replay") {
    return emitQueueSuccess(io, value, result);
  }
  const failures: Record<Exclude<PersonalGlossaryReviewQueueResult["status"], "queued" | "unchanged_replay">, ReviewFailure> = {
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
    `${value.command} queue`,
    queueSyntax(value),
    queueSyntax(value),
    failures[result.status],
  );
}

function listReviews(io: Io, options: ListOptions, value: ReviewRecordsCommandContract): number {
  const view = currentRecords(io, value, "list");
  if (!view) return 1;
  const selectedFilters = filters(options);
  const records = view.records
    .filter((record) => !options.status || record.status === options.status)
    .sort(reviewOrder);
  const snapshotId = projectedListSnapshot({
    schemaVersion: value.retrievalSchemaVersion,
    command: `${value.command} list`,
    collection: COLLECTION,
    owner: value.owner,
    filters: selectedFilters as JsonObject,
    order: value.order,
    records: records.map((record) => record.record_sha256),
  });
  let start = 0;
  if (options.cursor) {
    let cursor: Mapping;
    try {
      cursor = decodeListCursor(options.cursor, personalGlossaryReviewRecordsPath(), glossaryEntryAuthorityPath());
    } catch {
      return failure(
        io,
        value.retrievalSchemaVersion,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_invalid",
          message: "review-list cursor is malformed or belongs to another local profile",
          recovery: "Copy next_cursor exactly, or omit --cursor to restart from the current private review records; no review metadata was changed.",
        },
      );
    }
    if (
      cursor.version !== CURSOR_VERSION ||
      cursor.collection !== COLLECTION ||
      cursor.owner !== value.owner ||
      cursor.limit !== options.limit ||
      !mapping(cursor.filters) ||
      canonicalGlossaryJson(cursor.filters) !== canonicalGlossaryJson(selectedFilters)
    ) {
      return failure(
        io,
        value.retrievalSchemaVersion,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_invalid",
          message: "review-list cursor filters, owner, or limit do not match this request",
          recovery: "Repeat the original status filter and limit, or omit --cursor to restart; no review metadata was changed.",
        },
      );
    }
    if (
      cursor.order !== value.order ||
      cursor.snapshot_id !== snapshotId ||
      typeof cursor.after !== "string"
    ) {
      return failure(
        io,
        value.retrievalSchemaVersion,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_snapshot_unavailable",
          message: "review-list cursor cannot resume the current private review snapshot",
          recovery: "Omit --cursor to restart from the current private review records; no review metadata was changed.",
        },
      );
    }
    const position = records.findIndex((record) => record.review_id === cursor.after);
    if (position < 0) {
      return failure(
        io,
        value.retrievalSchemaVersion,
        `${value.command} list`,
        listSyntax(value),
        `${value.command} list --limit ${value.defaultLimit} --format json`,
        {
          class: "cursor_snapshot_unavailable",
          message: "review-list cursor continuation is unavailable",
          recovery: "Omit --cursor to restart from the current private review records; no review metadata was changed.",
        },
      );
    }
    start = position + 1;
  }
  const entries = records.slice(start, start + options.limit);
  const remaining = records.length - start - entries.length;
  const nextCursor = remaining > 0 && entries.length > 0
    ? encodeListCursor(
      {
        version: CURSOR_VERSION,
        collection: COLLECTION,
        owner: value.owner,
        filters: selectedFilters as JsonObject,
        limit: options.limit,
        order: value.order,
        snapshot_id: snapshotId,
        after: entries.at(-1)!.review_id,
      },
      personalGlossaryReviewRecordsPath(),
      glossaryEntryAuthorityPath(),
    )
    : undefined;
  const response: Mapping = {
    schemaVersion: value.retrievalSchemaVersion,
    command: `${value.command} list`,
    status: view.expired_records > 0 || view.stale_records > 0 ? "degraded" : "ok",
    owner: value.owner,
    entries: entries.map(reviewSummary),
    counts: {
      total: records.length,
      candidate: records.length,
      returned: entries.length,
      remaining,
      omitted: remaining,
      continuation: remaining,
    },
    filters: selectedFilters,
    snapshot: {
      id: snapshotId,
      first_page: !options.cursor,
      order: value.order,
      has_more: remaining > 0,
      candidate_count: records.length,
    },
    retention: {
      expired_records: view.expired_records,
      stale_records: view.stale_records,
      mutation: "forbidden",
    },
    source: {
      kind: "user_local_review_records",
      owner: value.owner,
    },
    source_contract: {
      authority: "references/artifacts/glossary-entry-contract.yaml",
      cursor: value.cursorVocabulary,
      cursor_authority: value.cursorAuthority,
      cursor_binding: [...value.cursorBinding],
      cursor_invalid_behavior: value.cursorInvalidBehavior,
      cursor_unavailable_behavior: value.cursorUnavailableBehavior,
    },
    retrieval: {
      get: `${value.command} get --review-id ID --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY --format json`,
      ...(nextCursor
        ? { continue: `${value.command} list${listFlags(options)} --limit ${options.limit} --cursor ${nextCursor} --format json` }
        : {}),
    },
    ...(remaining > 0 ? { omitted: true, omitted_count: remaining, omission_reason: "page_limit", next_cursor: nextCursor } : {}),
  };
  if (serializedBytes(response) > value.listMaxSerializedUtf8Bytes) {
    return failure(
      io,
      value.retrievalSchemaVersion,
      `${value.command} list`,
      listSyntax(value),
      `${value.command} list --limit ${value.defaultLimit} --format json`,
      {
        class: "output_bound_exceeded",
        message: `review-list response exceeds its ${value.listMaxSerializedUtf8Bytes}-byte bound`,
        recovery: "Request fewer rows and retry; no partial review metadata was returned.",
      },
    );
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

function exactReview(io: Io, options: ExactOptions, value: ReviewRecordsCommandContract): number {
  const view = currentRecords(io, value, "get");
  if (!view) return 1;
  const stored = readPersonalGlossaryReviewRecords();
  const raw = stored.store?.records.find((record) => record.review_id === options.reviewId);
  if (!raw) {
    return failure(
      io,
      value.retrievalSchemaVersion,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "not_found",
        message: "review identity was not found in the current private record store",
        recovery: "List the current private review records and retry with one returned identity; no review metadata was changed.",
      },
    );
  }
  const record = view.records.find((item) => item.review_id === options.reviewId);
  if (!record) {
    return failure(
      io,
      value.retrievalSchemaVersion,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "current_binding_mismatch",
        message: "review identity is stale, expired, or not bound to the current candidate projection",
        recovery: "List the current private review records and retry with one current identity; no review metadata was changed.",
      },
    );
  }
  if (
    record.candidate_id !== options.candidateId ||
    record.candidate_revision !== options.candidateRevision ||
    record.generation !== options.generation ||
    record.policy_version !== options.policyVersion
  ) {
    return failure(
      io,
      value.retrievalSchemaVersion,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "current_binding_mismatch",
        message: "review exact-read bindings do not match the current record",
        recovery: "List the current private review records and copy every exact binding; no review metadata was changed.",
      },
    );
  }
  const response: Mapping = {
    schemaVersion: value.retrievalSchemaVersion,
    command: `${value.command} get`,
    status: "ok",
    owner: value.owner,
    record: reviewSummary(record),
    source: {
      kind: "user_local_review_records",
      owner: value.owner,
    },
    source_contract: {
      authority: "references/artifacts/glossary-entry-contract.yaml",
      bindings: [...value.exactBindings],
      max_serialized_utf8_bytes: value.exactMaxSerializedUtf8Bytes,
      current_binding: "candidate_projection_sha256",
      mutation: "forbidden",
    },
  };
  if (serializedBytes(response) > value.exactMaxSerializedUtf8Bytes) {
    return failure(
      io,
      value.retrievalSchemaVersion,
      `${value.command} get`,
      exactSyntax(value),
      exactSyntax(value),
      {
        class: "output_bound_exceeded",
        message: `review exact-read response exceeds its ${value.exactMaxSerializedUtf8Bytes}-byte bound`,
        recovery: "Repair the private review records before retrying; no partial review metadata was returned.",
      },
    );
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

/** Run the private, noninteractive queue and read operations for glossary review metadata. */
export function runPersonalGlossaryReviewRecordsCommand(argv: string[], io: Io): number {
  let value: ReviewRecordsCommandContract;
  try {
    value = contract();
  } catch {
    return failure(
      io,
      "agentera.personalGlossaryReviewRetrieval.v1",
      "agentera report personal-glossary-reviews",
      "agentera report personal-glossary-reviews {queue,list,get} --format json",
      "agentera report personal-glossary-reviews list --limit 20 --format json",
      {
        class: "unsupported_state",
        message: "personal glossary review-record contract is unavailable",
        recovery: "Restore the bundled glossary authority, then retry; no review metadata was changed.",
      },
    );
  }
  const operation = argv[0];
  if (operation !== "queue" && operation !== "list" && operation !== "get") {
    return invalid(io, {
      class: operation ? "unsupported_target" : "missing_argument",
      message: operation ? "unsupported personal glossary review operation" : "review operation is required",
      valid_values: ["queue", "list", "get"],
      syntax: `${value.command} {queue,list,get} --format json`,
      example: `${value.command} list --limit ${value.defaultLimit} --format json`,
      recovery: "Choose queue, list, or get and retry; no review metadata was changed.",
    });
  }
  if (operation === "queue") {
    const parsed = parseQueue(argv.slice(1), value);
    if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the bounded queue request and retry; no review metadata was changed." });
    return queueReview(io, parsed.input, value);
  }
  if (operation === "list") {
    const parsed = parseList(argv.slice(1), value);
    if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the bounded list request and retry; no review metadata was changed." });
    return listReviews(io, parsed, value);
  }
  const parsed = parseExact(argv.slice(1), value);
  if ("class" in parsed) return invalid(io, { ...parsed, recovery: "Correct the exact review binding and retry; no review metadata was changed." });
  return exactReview(io, parsed, value);
}
