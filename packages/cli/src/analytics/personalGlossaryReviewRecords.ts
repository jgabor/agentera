import fs from "node:fs";
import path from "node:path";

import { defaultProfileDir, type Env } from "./extractCorpus/core.js";
import {
  readPersonalGlossaryCandidateProjection,
  type PersonalGlossaryCandidateProjectionStorageOptions,
  type ProjectedPersonalGlossaryCandidate,
} from "./personalGlossaryCandidateProjection.js";
import { containsPersonalGlossarySensitiveContent } from "./personalGlossaryCandidateProjectionExcerpts.js";
import { decidePersonalGlossaryCandidate } from "./personalGlossaryDecision.js";
import {
  GLOSSARY_ADMISSION_REASONS_BY_OUTCOME,
  type GlossaryAdmissionReason,
} from "../registries/glossaryCandidateDecisionAuthority.js";
import {
  validateGlossaryAdmissionDecision,
  validateGlossaryHostClassificationReceipt,
  type GlossaryAdmissionDecision,
} from "../registries/glossaryCandidateContracts.js";
import { personalGlossaryReviewRecordsContract } from "../registries/glossaryReviewRecordsContract.js";
import {
  canonicalGlossaryJson,
  compareGlossaryUnicodeStrings,
  glossaryCanonicalSha256,
} from "../registries/glossaryTermIdentity.js";

const STORE_SCHEMA_VERSION = "agentera.personalGlossaryReviewStore.v1";
const RECORD_SCHEMA_VERSION = "agentera.personalGlossaryPendingReviewRecord.v1";
const REVIEW_OWNER = "current_user";
const REVIEW_ID_SCHEMA_VERSION = "agentera.personalGlossaryReviewIdentity.v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SENSITIVE_REVIEW_METADATA_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_])(?:api[_-]?key|access[_-]?token|token|password|passwd|cookie|private[_-]?key|authorization(?:[_-]?header)?|session(?:[_-]?id)?|email|phone|contact|secret)\s*[:=]/iu;

type Mapping = Record<string, unknown>;
type ReviewStatus = "pending" | "terminal";

export interface PersonalGlossaryReviewRecord {
  schema_version: typeof RECORD_SCHEMA_VERSION;
  owner: typeof REVIEW_OWNER;
  review_id: string;
  candidate_id: string;
  candidate_revision: string;
  candidate_capsule_sha256: string;
  candidate_projection_sha256: string;
  host_receipt_sha256: string;
  cli_decision_sha256: string;
  semantic_fingerprint: string;
  generation: string;
  policy_version: string;
  reason: GlossaryAdmissionReason;
  status: ReviewStatus;
  queued_at: string;
  terminal_at: string | null;
  expires_at: string | null;
  record_sha256: string;
}

export interface PersonalGlossaryReviewStore {
  schema_version: typeof STORE_SCHEMA_VERSION;
  owner: typeof REVIEW_OWNER;
  records: PersonalGlossaryReviewRecord[];
  store_sha256: string;
}

export interface PersonalGlossaryReviewRecordsStorageOptions
  extends PersonalGlossaryCandidateProjectionStorageOptions {
  env?: Env;
  platform?: NodeJS.Platform;
}

export interface PersonalGlossaryReviewRecordsReadResult {
  status: "current" | "missing" | "corrupt";
  store: PersonalGlossaryReviewStore | null;
}

export interface PersonalGlossaryCurrentReviewRecordsResult {
  status: "current" | "missing" | "corrupt" | "projection_unavailable";
  records: PersonalGlossaryReviewRecord[];
  expired_records: number;
  stale_records: number;
}

export interface PersonalGlossaryReviewQueueInput
  extends PersonalGlossaryReviewRecordsStorageOptions {
  receipt: unknown;
  now?: string;
}

export interface PersonalGlossaryReviewQueueResult {
  status:
    | "queued"
    | "unchanged_replay"
    | "decision_not_review_required"
    | "current_binding_mismatch"
    | "records_unavailable"
    | "record_capacity_exceeded"
    | "already_terminal";
  reason: string;
  record: PersonalGlossaryReviewRecord | null;
}

export interface PersonalGlossaryReviewRecordsMaintenanceInput
  extends PersonalGlossaryReviewRecordsStorageOptions {
  now: string;
  /** Set only after the local host has authenticated the current user's purge action. */
  current_user_purge_authorized?: boolean;
}

export interface PersonalGlossaryReviewRecordsMaintenanceResult {
  status: "missing" | "corrupt" | "unchanged" | "changed" | "purged";
  expired_records: number;
}

interface ReviewRecordsContract {
  storeFile: string;
  storeMaxSerializedUtf8Bytes: number;
  recordMaxSerializedUtf8Bytes: number;
  recordsMax: number;
  terminalMetadataDays: number;
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function exactKeys(value: Mapping, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

/** Keep review binding metadata opaque and safe to persist or return. */
export function validPersonalGlossaryReviewMetadataBinding(value: unknown): value is string {
  return (
    boundedText(value, 256) &&
    !/[\\/]/u.test(value) &&
    !SENSITIVE_REVIEW_METADATA_ASSIGNMENT.test(value) &&
    !containsPersonalGlossarySensitiveContent(value)
  );
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(`${canonicalGlossaryJson(value)}\n`, "utf8");
}

function contract(): ReviewRecordsContract {
  const value = personalGlossaryReviewRecordsContract();
  if (
    value.command !== "agentera report personal-glossary-reviews" ||
    value.queueRequestSchemaVersion !== "agentera.personalGlossaryReviewQueueRequest.v1" ||
    !sameStrings(value.queueRequestFields, ["schema_version", "receipt"]) ||
    value.queueMaxRequestUtf8Bytes !== 16_384 ||
    value.queueDecisionOutcome !== "review_required" ||
    !sameStrings(value.queueCurrentBindings, [
      "candidate_id",
      "candidate_revision",
      "candidate_capsule_sha256",
      "candidate_projection_sha256",
      "host_receipt_sha256",
      "cli_decision_sha256",
      "semantic_fingerprint",
      "generation",
      "policy_version",
      "reason",
    ]) ||
    value.queueResultSchemaVersion !== "agentera.personalGlossaryReviewQueueResult.v1" ||
    !sameStrings(value.queueResultStatuses, ["queued", "unchanged_replay"]) ||
    value.queueMaxResultUtf8Bytes !== 4_096 ||
    value.queueNoQuestionChannel !== "queue_without_prompt_or_disposition" ||
    value.storeSchemaVersion !== STORE_SCHEMA_VERSION ||
    value.recordSchemaVersion !== RECORD_SCHEMA_VERSION ||
    value.storeOwner !== REVIEW_OWNER ||
    value.storeFile !== "review-records.json" ||
    !sameStrings(value.storeFields, ["schema_version", "owner", "records", "store_sha256"]) ||
    !sameStrings(value.recordFields, [
      "schema_version",
      "owner",
      "review_id",
      "candidate_id",
      "candidate_revision",
      "candidate_capsule_sha256",
      "candidate_projection_sha256",
      "host_receipt_sha256",
      "cli_decision_sha256",
      "semantic_fingerprint",
      "generation",
      "policy_version",
      "reason",
      "status",
      "queued_at",
      "terminal_at",
      "expires_at",
      "record_sha256",
    ]) ||
    value.recordsMax !== 100 ||
    value.recordMaxSerializedUtf8Bytes !== 2_048 ||
    value.storeMaxSerializedUtf8Bytes !== 262_144 ||
    value.storeOrder !== "review_id_asc" ||
    value.replay !== "exact_current_binding_is_unchanged_replay" ||
    value.conflict !== "changed_binding_or_reason_creates_distinct_record" ||
    !sameStrings(value.forbiddenFields, [
      "term",
      "meaning",
      "corrected_meaning",
      "excerpt",
      "raw_evidence",
      "source_id",
      "evidence_anchor",
      "session_id",
      "project_id",
      "source_path",
      "tool_content",
      "review_approval",
      "signature",
      "nonce",
    ]) ||
    value.retrievalSchemaVersion !== "agentera.personalGlossaryReviewRetrieval.v1" ||
    value.retrievalOwner !== REVIEW_OWNER ||
    value.listDefaultLimit !== 20 ||
    value.listMaximumLimit !== 50 ||
    value.listMaxSerializedUtf8Bytes !== 32_768 ||
    value.listOrder !== "queued_at_desc_then_review_id_asc" ||
    !sameStrings(value.listStatuses, ["pending", "terminal"]) ||
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
    value.exactMaxSerializedUtf8Bytes !== 8_192 ||
    value.terminalMetadataDays !== 90 ||
    value.maintenanceExposure !== "authenticated_review_owner_only" ||
    value.maintenancePurge !== "current_user_authorized_review_records_only" ||
    !sameStrings(value.maintenanceForbiddenEffects, [
      "profile_entry",
      "project_state",
      "candidate_projection",
      "publication",
    ])
  ) {
    throw new TypeError("personal glossary review-record contract is unavailable");
  }
  return {
    storeFile: value.storeFile,
    storeMaxSerializedUtf8Bytes: value.storeMaxSerializedUtf8Bytes,
    recordMaxSerializedUtf8Bytes: value.recordMaxSerializedUtf8Bytes,
    recordsMax: value.recordsMax,
    terminalMetadataDays: value.terminalMetadataDays,
  };
}

function reviewIdentity(record: Pick<
  PersonalGlossaryReviewRecord,
  | "owner"
  | "candidate_id"
  | "candidate_revision"
  | "candidate_capsule_sha256"
  | "candidate_projection_sha256"
  | "host_receipt_sha256"
  | "cli_decision_sha256"
  | "semantic_fingerprint"
  | "generation"
  | "policy_version"
  | "reason"
>): string {
  return glossaryCanonicalSha256({
    schema_version: REVIEW_ID_SCHEMA_VERSION,
    owner: record.owner,
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
  });
}

function reviewRecordOrder(left: PersonalGlossaryReviewRecord, right: PersonalGlossaryReviewRecord): number {
  return compareGlossaryUnicodeStrings(left.review_id, right.review_id);
}

function bodyWithoutDigest(value: Mapping, field: string): Mapping {
  const body = { ...value };
  delete body[field];
  return body;
}

function validReviewRecord(value: unknown, valueContract: ReviewRecordsContract): value is PersonalGlossaryReviewRecord {
  const record = mapping(value);
  if (
    record === null ||
    !exactKeys(record, [
      "schema_version",
      "owner",
      "review_id",
      "candidate_id",
      "candidate_revision",
      "candidate_capsule_sha256",
      "candidate_projection_sha256",
      "host_receipt_sha256",
      "cli_decision_sha256",
      "semantic_fingerprint",
      "generation",
      "policy_version",
      "reason",
      "status",
      "queued_at",
      "terminal_at",
      "expires_at",
      "record_sha256",
    ]) ||
    record.schema_version !== RECORD_SCHEMA_VERSION ||
    record.owner !== REVIEW_OWNER ||
    ![
      record.review_id,
      record.candidate_id,
      record.candidate_revision,
      record.candidate_capsule_sha256,
      record.candidate_projection_sha256,
      record.host_receipt_sha256,
      record.cli_decision_sha256,
      record.semantic_fingerprint,
      record.record_sha256,
    ].every(digest) ||
    !validPersonalGlossaryReviewMetadataBinding(record.generation) ||
    !validPersonalGlossaryReviewMetadataBinding(record.policy_version) ||
    !boundedText(record.reason, 512) ||
    !(GLOSSARY_ADMISSION_REASONS_BY_OUTCOME.review_required as readonly string[]).includes(
      record.reason as GlossaryAdmissionReason,
    ) ||
    !timestamp(record.queued_at) ||
    (record.status !== "pending" && record.status !== "terminal")
  ) {
    return false;
  }
  if (record.status === "pending") {
    if (record.terminal_at !== null || record.expires_at !== null) return false;
  } else {
    if (!timestamp(record.terminal_at) || !timestamp(record.expires_at)) return false;
    if (Date.parse(record.terminal_at) < Date.parse(record.queued_at)) return false;
    if (
      Date.parse(record.expires_at) - Date.parse(record.terminal_at) !==
      valueContract.terminalMetadataDays * 86_400_000
    ) {
      return false;
    }
  }
  const typed = record as unknown as PersonalGlossaryReviewRecord;
  if (typed.review_id !== reviewIdentity(typed)) return false;
  if (typed.record_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(record, "record_sha256"))) {
    return false;
  }
  return serializedBytes(typed) <= valueContract.recordMaxSerializedUtf8Bytes;
}

function validReviewStore(value: unknown, valueContract: ReviewRecordsContract): value is PersonalGlossaryReviewStore {
  const store = mapping(value);
  if (
    store === null ||
    !exactKeys(store, ["schema_version", "owner", "records", "store_sha256"]) ||
    store.schema_version !== STORE_SCHEMA_VERSION ||
    store.owner !== REVIEW_OWNER ||
    !Array.isArray(store.records) ||
    store.records.length > valueContract.recordsMax ||
    !digest(store.store_sha256) ||
    serializedBytes(store) > valueContract.storeMaxSerializedUtf8Bytes
  ) {
    return false;
  }
  const records = store.records as PersonalGlossaryReviewRecord[];
  if (
    !records.every((record) => validReviewRecord(record, valueContract)) ||
    records.some((record, index) =>
      index > 0 && reviewRecordOrder(records[index - 1]!, record) >= 0,
    )
  ) {
    return false;
  }
  return store.store_sha256 === glossaryCanonicalSha256(bodyWithoutDigest(store, "store_sha256"));
}

function makeStore(records: readonly PersonalGlossaryReviewRecord[]): PersonalGlossaryReviewStore {
  const valueContract = contract();
  const body = {
    schema_version: STORE_SCHEMA_VERSION,
    owner: REVIEW_OWNER,
    records: [...records].sort(reviewRecordOrder),
  } as Omit<PersonalGlossaryReviewStore, "store_sha256">;
  const store = {
    ...body,
    store_sha256: glossaryCanonicalSha256(body),
  } as PersonalGlossaryReviewStore;
  if (!validReviewStore(store, valueContract)) throw new TypeError("review record store is invalid");
  return store;
}

function privateWrite(pathname: string, text: string): void {
  const directory = path.dirname(pathname);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${pathname}.tmp.${process.pid}.${Date.now()}`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporary, "w", 0o600);
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, pathname);
    fs.chmodSync(pathname, 0o600);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

function ensurePrivateMode(pathname: string): void {
  const metadata = fs.statSync(pathname);
  if (!metadata.isFile()) throw new TypeError("stored review records are not a private file");
  if ((metadata.mode & 0o777) === 0o600) return;
  fs.chmodSync(pathname, 0o600);
  if ((fs.statSync(pathname).mode & 0o777) !== 0o600) {
    throw new TypeError("stored review records could not be made private");
  }
}

function readBoundedFile(pathname: string, maximum: number): string {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(pathname, fs.constants.O_RDONLY);
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > maximum) throw new TypeError("review record store is over bound");
    const bytes = Buffer.allocUnsafe(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximum) throw new TypeError("review record store is over bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function exactCandidate(
  candidates: readonly ProjectedPersonalGlossaryCandidate[],
  decision: GlossaryAdmissionDecision,
): ProjectedPersonalGlossaryCandidate | null {
  return candidates.find(
    (candidate) =>
      candidate.capsule.candidate_id === decision.candidate_id &&
      candidate.capsule.candidate_revision === decision.candidate_revision &&
      candidate.capsule.capsule_sha256 === decision.candidate_capsule_sha256 &&
      candidate.capsule.generation === decision.generation &&
      candidate.capsule.policy_version === decision.policy_version,
  ) ?? null;
}

function recordMatchesProjection(
  record: PersonalGlossaryReviewRecord,
  projection: { projection_sha256: string; candidates: ProjectedPersonalGlossaryCandidate[] },
): boolean {
  if (record.candidate_projection_sha256 !== projection.projection_sha256) return false;
  const candidate = projection.candidates.find(
    (item) =>
      item.capsule.candidate_id === record.candidate_id &&
      item.capsule.candidate_revision === record.candidate_revision &&
      item.capsule.capsule_sha256 === record.candidate_capsule_sha256 &&
      item.capsule.generation === record.generation &&
      item.capsule.policy_version === record.policy_version,
  );
  return candidate !== undefined;
}

function pendingRecord(decision: GlossaryAdmissionDecision, queuedAt: string): PersonalGlossaryReviewRecord {
  const body = {
    schema_version: RECORD_SCHEMA_VERSION,
    owner: REVIEW_OWNER,
    candidate_id: decision.candidate_id,
    candidate_revision: decision.candidate_revision,
    candidate_capsule_sha256: decision.candidate_capsule_sha256,
    candidate_projection_sha256: decision.candidate_projection_sha256,
    host_receipt_sha256: decision.host_receipt_sha256,
    cli_decision_sha256: decision.decision_sha256,
    semantic_fingerprint: decision.semantic_fingerprint,
    generation: decision.generation,
    policy_version: decision.policy_version,
    reason: decision.reason,
    status: "pending" as const,
    queued_at: queuedAt,
    terminal_at: null,
    expires_at: null,
  } as Omit<PersonalGlossaryReviewRecord, "review_id" | "record_sha256">;
  const record = {
    ...body,
    review_id: reviewIdentity(body),
  } as Omit<PersonalGlossaryReviewRecord, "record_sha256">;
  return {
    ...record,
    record_sha256: glossaryCanonicalSha256(record),
  };
}

export function personalGlossaryReviewRecordsPath(
  options: PersonalGlossaryReviewRecordsStorageOptions = {},
): string {
  return path.join(
    defaultProfileDir(options.env ?? process.env, options.platform ?? process.platform),
    "intermediate",
    "personal-glossary",
    contract().storeFile,
  );
}

export function readPersonalGlossaryReviewRecords(
  options: PersonalGlossaryReviewRecordsStorageOptions = {},
): PersonalGlossaryReviewRecordsReadResult {
  const valueContract = contract();
  const pathname = personalGlossaryReviewRecordsPath(options);
  let text: string;
  try {
    text = readBoundedFile(pathname, valueContract.storeMaxSerializedUtf8Bytes);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing", store: null }
      : { status: "corrupt", store: null };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!validReviewStore(parsed, valueContract) || text !== `${canonicalGlossaryJson(parsed)}\n`) {
      return { status: "corrupt", store: null };
    }
    return { status: "current", store: parsed };
  } catch {
    return { status: "corrupt", store: null };
  }
}

export function currentPersonalGlossaryReviewRecords(
  options: PersonalGlossaryReviewRecordsStorageOptions = {},
  now = new Date().toISOString(),
): PersonalGlossaryCurrentReviewRecordsResult {
  if (!timestamp(now)) throw new TypeError("review read time must be an ISO timestamp");
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status === "missing") {
    return { status: "current", records: [], expired_records: 0, stale_records: 0 };
  }
  if (current.status !== "current" || current.store === null) {
    return { status: current.status, records: [], expired_records: 0, stale_records: 0 };
  }
  const projection = readPersonalGlossaryCandidateProjection(options);
  if (projection.status !== "current" || projection.projection === null) {
    return { status: "projection_unavailable", records: [], expired_records: 0, stale_records: 0 };
  }
  let expiredRecords = 0;
  let staleRecords = 0;
  const records = current.store.records.filter((record) => {
    if (record.status === "terminal" && Date.parse(record.expires_at!) <= Date.parse(now)) {
      expiredRecords += 1;
      return false;
    }
    if (!recordMatchesProjection(record, projection.projection!)) {
      staleRecords += 1;
      return false;
    }
    return true;
  });
  return {
    status: "current",
    records,
    expired_records: expiredRecords,
    stale_records: staleRecords,
  };
}

/** Queue one current review-required decision without accepting a user disposition. */
export function queuePersonalGlossaryReviewRecord(
  input: PersonalGlossaryReviewQueueInput,
): PersonalGlossaryReviewQueueResult {
  const queuedAt = input.now ?? new Date().toISOString();
  if (!timestamp(queuedAt)) throw new TypeError("review queue time must be an ISO timestamp");
  const receipt = mapping(input.receipt);
  if (!receipt) {
    return { status: "decision_not_review_required", reason: "receipt_invalid", record: null };
  }
  const options = { env: input.env, platform: input.platform };
  const result = decidePersonalGlossaryCandidate(receipt, options);
  if (result.status !== "review_required" || result.decision === null) {
    return { status: "decision_not_review_required", reason: result.reason, record: null };
  }
  const decision = result.decision;
  const projection = readPersonalGlossaryCandidateProjection(options);
  if (
    projection.status !== "current" ||
    projection.projection === null ||
    projection.projection.projection_sha256 !== decision.candidate_projection_sha256
  ) {
    return { status: "current_binding_mismatch", reason: "projection_unavailable", record: null };
  }
  const candidate = exactCandidate(projection.projection.candidates, decision);
  if (candidate === null) {
    return { status: "current_binding_mismatch", reason: "candidate_binding_mismatch", record: null };
  }
  if (
    validateGlossaryHostClassificationReceipt(receipt, candidate.capsule, {
      candidateProjectionSha256: projection.projection.projection_sha256,
    }).length > 0 ||
    validateGlossaryAdmissionDecision(decision, candidate.capsule, receipt).length > 0 ||
    decision.outcome !== "review_required"
  ) {
    return { status: "current_binding_mismatch", reason: "decision_binding_mismatch", record: null };
  }
  const record = pendingRecord(decision, queuedAt);
  if (!validReviewRecord(record, contract())) {
    return { status: "current_binding_mismatch", reason: "record_binding_mismatch", record: null };
  }
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status === "corrupt") {
    return { status: "records_unavailable", reason: "review_records_unavailable", record: null };
  }
  const records = current.store?.records ?? [];
  const existing = records.find((item) => item.review_id === record.review_id);
  if (existing) {
    if (existing.status !== "pending") {
      return { status: "already_terminal", reason: "review_already_terminal", record: null };
    }
    ensurePrivateMode(personalGlossaryReviewRecordsPath(options));
    return { status: "unchanged_replay", reason: record.reason, record: existing };
  }
  if (records.length >= contract().recordsMax) {
    return { status: "record_capacity_exceeded", reason: "review_record_capacity_exceeded", record: null };
  }
  const next = makeStore([...records, record]);
  privateWrite(personalGlossaryReviewRecordsPath(options), `${canonicalGlossaryJson(next)}\n`);
  return { status: "queued", reason: record.reason, record };
}

/** Remove expired terminal metadata or an authenticated current user's review-record file only. */
export function maintainPersonalGlossaryReviewRecords(
  input: PersonalGlossaryReviewRecordsMaintenanceInput,
): PersonalGlossaryReviewRecordsMaintenanceResult {
  if (!timestamp(input.now)) throw new TypeError("review maintenance time must be an ISO timestamp");
  const options = { env: input.env, platform: input.platform };
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status === "missing" || current.status === "corrupt") {
    return { status: current.status, expired_records: 0 };
  }
  const pathname = personalGlossaryReviewRecordsPath(options);
  if (input.current_user_purge_authorized === true) {
    fs.rmSync(pathname, { force: true });
    return { status: "purged", expired_records: 0 };
  }
  const records = current.store!.records.filter(
    (record) => record.status !== "terminal" || Date.parse(record.expires_at!) > Date.parse(input.now),
  );
  const expiredRecords = current.store!.records.length - records.length;
  if (expiredRecords === 0) return { status: "unchanged", expired_records: 0 };
  if (records.length === 0) {
    fs.rmSync(pathname, { force: true });
  } else {
    privateWrite(pathname, `${canonicalGlossaryJson(makeStore(records))}\n`);
  }
  return { status: "changed", expired_records: expiredRecords };
}
