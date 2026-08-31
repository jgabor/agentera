import {
  currentPersonalGlossaryReviewRecords,
  personalGlossaryReviewRecordsPath,
  readPersonalGlossaryReviewRecords,
  type PersonalGlossaryReviewReadRecord,
} from "../../analytics/personalGlossaryReviewRecords.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { shellQuoteArgument } from "../../core/shell.js";
import { canonicalGlossaryJson, compareGlossaryUnicodeStrings } from "../../registries/glossaryTermIdentity.js";
import { glossaryEntryAuthorityPath } from "../../registries/glossaryEntryContract.js";
import { decodeListCursor, encodeListCursor, projectedListSnapshot } from "../../state/listCursor.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";

const COLLECTION = "personal_glossary_review_records";
const CURSOR_VERSION = 1;
const MAX_CURSOR_UTF8_BYTES = 4_096;

type Mapping = Record<string, unknown>;
type ReviewStatus = "pending" | "terminal";

interface ReviewRecordsReadContract {
  command: string;
  retrievalSchemaVersion: string;
  owner: string;
  defaultLimit: number;
  listMaxSerializedUtf8Bytes: number;
  order: string;
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
  class: "review_records_unavailable" | "current_binding_mismatch" | "cursor_invalid" | "cursor_snapshot_unavailable" | "not_found" | "output_bound_exceeded";
  message: string;
  recovery: string;
}

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function listSyntax(value: ReviewRecordsReadContract): string {
  return `${value.command} list [--status pending|terminal] [--limit N] [--cursor TOKEN]`;
}

function exactSyntax(value: ReviewRecordsReadContract): string {
  return `${value.command} get --review-id ID --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY`;
}

function failure(io: Io, schemaVersion: string, command: string, syntax: string, example: string, body: ReviewFailure): number {
  emitStructured({ schemaVersion, command, status: "fail", error: { ...body, syntax, example } }, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 1;
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

function filters(options: ListOptions): Mapping {
  return { status: options.status ?? null };
}

function reviewOrder(left: PersonalGlossaryReviewReadRecord, right: PersonalGlossaryReviewReadRecord): number {
  return Date.parse(right.queued_at) - Date.parse(left.queued_at) || compareGlossaryUnicodeStrings(left.review_id, right.review_id);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listFlags(options: ListOptions): string {
  return options.status ? ` --status ${shellQuoteArgument(options.status)}` : "";
}

function currentRecords(io: Io, value: ReviewRecordsReadContract, operation: "list" | "get") {
  const result = currentPersonalGlossaryReviewRecords();
  if (result.status === "current") return result;
  return failure(
    io,
    value.retrievalSchemaVersion,
    `${value.command} ${operation}`,
    operation === "list" ? listSyntax(value) : exactSyntax(value),
    operation === "list" ? `${value.command} list --limit ${value.defaultLimit}` : exactSyntax(value),
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
}

/** Emit the bounded read-only list view for private review records. */
export function listPersonalGlossaryReviewRecords(
  io: Io,
  options: ListOptions,
  value: ReviewRecordsReadContract,
): number {
  const view = currentRecords(io, value, "list");
  if (typeof view === "number") return view;
  const selectedFilters = filters(options);
  const records = view.records.filter((record) => !options.status || record.status === options.status).sort(reviewOrder);
  const snapshotId = projectedListSnapshot({ schemaVersion: value.retrievalSchemaVersion, command: `${value.command} list`, collection: COLLECTION, owner: value.owner, filters: selectedFilters as JsonObject, order: value.order, records: records.map((record) => record.record_sha256) });
  let start = 0;
  if (options.cursor) {
    let cursor: Mapping;
    try { cursor = decodeListCursor(options.cursor, personalGlossaryReviewRecordsPath(), glossaryEntryAuthorityPath()); }
    catch {
      return failure(io, value.retrievalSchemaVersion, `${value.command} list`, listSyntax(value), `${value.command} list --limit ${value.defaultLimit}`, {
        class: "cursor_invalid",
        message: "review-list cursor is malformed or belongs to another local profile",
        recovery: "Copy next_cursor exactly, or omit --cursor to restart from the current private review records; no review metadata was changed.",
      });
    }
    if (cursor.version !== CURSOR_VERSION || cursor.collection !== COLLECTION || cursor.owner !== value.owner || cursor.limit !== options.limit || !mapping(cursor.filters) || canonicalGlossaryJson(cursor.filters) !== canonicalGlossaryJson(selectedFilters)) {
      return failure(io, value.retrievalSchemaVersion, `${value.command} list`, listSyntax(value), `${value.command} list --limit ${value.defaultLimit}`, {
        class: "cursor_invalid",
        message: "review-list cursor filters, owner, or limit do not match this request",
        recovery: "Repeat the original status filter and limit, or omit --cursor to restart; no review metadata was changed.",
      });
    }
    if (cursor.order !== value.order || cursor.snapshot_id !== snapshotId || typeof cursor.after !== "string") {
      return failure(io, value.retrievalSchemaVersion, `${value.command} list`, listSyntax(value), `${value.command} list --limit ${value.defaultLimit}`, {
        class: "cursor_snapshot_unavailable",
        message: "review-list cursor cannot resume the current private review snapshot",
        recovery: "Omit --cursor to restart from the current private review records; no review metadata was changed.",
      });
    }
    const position = records.findIndex((record) => record.review_id === cursor.after);
    if (position < 0) {
      return failure(io, value.retrievalSchemaVersion, `${value.command} list`, listSyntax(value), `${value.command} list --limit ${value.defaultLimit}`, {
        class: "cursor_snapshot_unavailable",
        message: "review-list cursor continuation is unavailable",
        recovery: "Omit --cursor to restart from the current private review records; no review metadata was changed.",
      });
    }
    start = position + 1;
  }
  const entries = records.slice(start, start + options.limit);
  const remaining = records.length - start - entries.length;
  const nextCursor = remaining > 0 && entries.length > 0
    ? encodeListCursor({ version: CURSOR_VERSION, collection: COLLECTION, owner: value.owner, filters: selectedFilters as JsonObject, limit: options.limit, order: value.order, snapshot_id: snapshotId, after: entries.at(-1)!.review_id }, personalGlossaryReviewRecordsPath(), glossaryEntryAuthorityPath())
    : undefined;
  const response: Mapping = {
    schemaVersion: value.retrievalSchemaVersion,
    command: `${value.command} list`,
    status: view.expired_records > 0 || view.stale_records > 0 ? "degraded" : "ok",
    owner: value.owner,
    entries: entries.map(reviewSummary),
    counts: { total: records.length, candidate: records.length, returned: entries.length, remaining, omitted: remaining, continuation: remaining },
    filters: selectedFilters,
    snapshot: { id: snapshotId, first_page: !options.cursor, order: value.order, has_more: remaining > 0, candidate_count: records.length },
    retention: { expired_records: view.expired_records, stale_records: view.stale_records, mutation: "forbidden" },
    source: { kind: "user_local_review_records", owner: value.owner },
    source_contract: {
      authority: "references/artifacts/glossary-entry-contract.yaml",
      cursor: value.cursorVocabulary,
      cursor_authority: value.cursorAuthority,
      cursor_binding: [...value.cursorBinding],
      cursor_invalid_behavior: value.cursorInvalidBehavior,
      cursor_unavailable_behavior: value.cursorUnavailableBehavior,
    },
    retrieval: {
      get: `${value.command} get --review-id ID --candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY`,
      ...(nextCursor ? { continue: `${value.command} list${listFlags(options)} --limit ${options.limit} --cursor ${nextCursor}` } : {}),
    },
    ...(remaining > 0 ? { omitted: true, omitted_count: remaining, omission_reason: "page_limit", next_cursor: nextCursor } : {}),
  };
  if (serializedBytes(response) > value.listMaxSerializedUtf8Bytes) {
    return failure(io, value.retrievalSchemaVersion, `${value.command} list`, listSyntax(value), `${value.command} list --limit ${value.defaultLimit}`, {
      class: "output_bound_exceeded",
      message: `review-list response exceeds its ${value.listMaxSerializedUtf8Bytes}-byte bound`,
      recovery: "Request fewer rows and retry; no partial review metadata was returned.",
    });
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}

/** Emit one bounded exact read after rechecking the current projection binding. */
export function getPersonalGlossaryReviewRecord(
  io: Io,
  options: ExactOptions,
  value: ReviewRecordsReadContract,
): number {
  const view = currentRecords(io, value, "get");
  if (typeof view === "number") return view;
  const raw = readPersonalGlossaryReviewRecords().store?.records.find((record) => record.review_id === options.reviewId);
  if (!raw) {
    return failure(io, value.retrievalSchemaVersion, `${value.command} get`, exactSyntax(value), exactSyntax(value), {
      class: "not_found",
      message: "review identity was not found in the current private record store",
      recovery: "List the current private review records and retry with one returned identity; no review metadata was changed.",
    });
  }
  const record = view.records.find((item) => item.review_id === options.reviewId);
  if (!record) {
    return failure(io, value.retrievalSchemaVersion, `${value.command} get`, exactSyntax(value), exactSyntax(value), {
      class: "current_binding_mismatch",
      message: "review identity is stale, expired, or not bound to the current candidate projection",
      recovery: "List the current private review records and retry with one current identity; no review metadata was changed.",
    });
  }
  if (record.candidate_id !== options.candidateId || record.candidate_revision !== options.candidateRevision || record.generation !== options.generation || record.policy_version !== options.policyVersion) {
    return failure(io, value.retrievalSchemaVersion, `${value.command} get`, exactSyntax(value), exactSyntax(value), {
      class: "current_binding_mismatch",
      message: "review exact-read bindings do not match the current record",
      recovery: "List the current private review records and copy every exact binding; no review metadata was changed.",
    });
  }
  const response: Mapping = {
    schemaVersion: value.retrievalSchemaVersion,
    command: `${value.command} get`,
    status: "ok",
    owner: value.owner,
    record: reviewSummary(record),
    source: { kind: "user_local_review_records", owner: value.owner },
    source_contract: {
      authority: "references/artifacts/glossary-entry-contract.yaml",
      bindings: [...value.exactBindings],
      max_serialized_utf8_bytes: value.exactMaxSerializedUtf8Bytes,
      current_binding: "candidate_projection_sha256",
      mutation: "forbidden",
    },
  };
  if (serializedBytes(response) > value.exactMaxSerializedUtf8Bytes) {
    return failure(io, value.retrievalSchemaVersion, `${value.command} get`, exactSyntax(value), exactSyntax(value), {
      class: "output_bound_exceeded",
      message: `review exact-read response exceeds its ${value.exactMaxSerializedUtf8Bytes}-byte bound`,
      recovery: "Repair the private review records before retrying; no partial review metadata was returned.",
    });
  }
  emitStructured(response, "json", io.out ?? ((text) => process.stdout.write(text)));
  return 0;
}
