import { createPublicKey, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { defaultProfileDir, type Env } from "./extractCorpus/core.js";
import type { ProjectedPersonalGlossaryCandidate } from "./personalGlossaryCandidateProjection.js";
import { containsPersonalGlossarySensitiveContent } from "./personalGlossaryCandidateProjectionExcerpts.js";
import { GLOSSARY_ADMISSION_REASONS_BY_OUTCOME, type GlossaryAdmissionReason } from "../registries/glossaryCandidateDecisionAuthority.js";
import type { GlossaryReviewRecord } from "../registries/glossaryCandidateContracts.js";
import { PERSONAL_REVIEW_DISPOSITIONS, type PersonalReviewDisposition } from "../registries/glossaryMiningAuthority.js";
import { personalGlossaryReviewRecordsContract } from "../registries/glossaryReviewRecordsContract.js";
import { canonicalGlossaryJson, compareGlossaryUnicodeStrings, glossaryCanonicalSha256 } from "../registries/glossaryTermIdentity.js";

const STORE_SCHEMA_VERSION = "agentera.personalGlossaryReviewStore.v2";
const RECORD_SCHEMA_VERSION = "agentera.personalGlossaryReviewRecord.v2";
const LEGACY_STORE_SCHEMA_VERSION = "agentera.personalGlossaryReviewStore.v1";
const LEGACY_RECORD_SCHEMA_VERSION = "agentera.personalGlossaryPendingReviewRecord.v1";
const TRUSTED_HOST_KEY_SCHEMA_VERSION = "agentera.personalGlossaryTrustedLocalHost.v1";
const REVIEW_OWNER = "current_user";
const REVIEW_ID_SCHEMA_VERSION = "agentera.personalGlossaryReviewIdentity.v1";
const REPLAY_NONCE_SCHEMA_VERSION = "agentera.personalGlossaryReviewReplayNonce.v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SENSITIVE_REVIEW_METADATA_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_])(?:api[_-]?key|access[_-]?token|token|password|passwd|cookie|private[_-]?key|authorization(?:[_-]?header)?|session(?:[_-]?id)?|email|phone|contact|secret)\s*[:=]/iu;

type Mapping = Record<string, unknown>;
type ReviewStatus = "pending" | "terminal";
export type ReviewScope = "personal" | "ambiguous";
export type PersonalGlossaryReviewReopenReason = "policy_changed" | "scope_changed" | "meaning_changed";

export interface PersonalGlossaryReviewReplayEntry {
  nonce_sha256: string;
  receipt_sha256: string;
  expires_at: string;
}

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
  scope: ReviewScope;
  reason: GlossaryAdmissionReason;
  status: ReviewStatus;
  disposition: PersonalReviewDisposition | null;
  review_record: GlossaryReviewRecord | null;
  reopen_reason: PersonalGlossaryReviewReopenReason | null;
  queued_at: string;
  terminal_at: string | null;
  expires_at: string | null;
  record_sha256: string;
}

export interface PersonalGlossaryLegacyReviewRecord {
  schema_version: typeof LEGACY_RECORD_SCHEMA_VERSION;
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

export type PersonalGlossaryReviewStoredRecord =
  | PersonalGlossaryReviewRecord
  | PersonalGlossaryLegacyReviewRecord;

export interface PersonalGlossaryReviewReadRecord
  extends Omit<PersonalGlossaryReviewRecord, "schema_version" | "scope"> {
  schema_version: typeof RECORD_SCHEMA_VERSION | typeof LEGACY_RECORD_SCHEMA_VERSION;
  scope: ReviewScope | null;
}

export interface PersonalGlossaryReviewStore {
  schema_version: typeof STORE_SCHEMA_VERSION;
  owner: typeof REVIEW_OWNER;
  records: PersonalGlossaryReviewStoredRecord[];
  replay_index: PersonalGlossaryReviewReplayEntry[];
  store_sha256: string;
}

export interface PersonalGlossaryLegacyReviewStore {
  schema_version: typeof LEGACY_STORE_SCHEMA_VERSION;
  owner: typeof REVIEW_OWNER;
  records: PersonalGlossaryLegacyReviewRecord[];
  store_sha256: string;
}

export type PersonalGlossaryReviewStoreSource =
  | PersonalGlossaryReviewStore
  | PersonalGlossaryLegacyReviewStore;

export interface PersonalGlossaryReviewRecordsStorageOptions {
  env?: Env;
  platform?: NodeJS.Platform;
}

export interface PersonalGlossaryReviewRecordsReadResult {
  status: "current" | "missing" | "corrupt";
  store: PersonalGlossaryReviewStoreSource | null;
}

export interface TrustedLocalHostKey {
  subject: string;
  publicKey: KeyObject;
}

export interface PersonalGlossaryReviewRecordsStorageContract {
  storeFile: string;
  trustedHostKeyFile: string;
  trustedHostKeyMaxSerializedUtf8Bytes: number;
  storeMaxSerializedUtf8Bytes: number;
  recordMaxSerializedUtf8Bytes: number;
  recordsMax: number;
  replayEntriesMax: number;
  terminalMetadataDays: number;
}

interface ReviewIdentityBinding {
  owner: typeof REVIEW_OWNER;
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
}

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  return boundedText(value, 256) && !/[\\/]/u.test(value) &&
    !SENSITIVE_REVIEW_METADATA_ASSIGNMENT.test(value) && !containsPersonalGlossarySensitiveContent(value);
}

function validCorrectedMeaning(value: unknown): value is string {
  return boundedText(value, 4_096) && !containsPersonalGlossarySensitiveContent(value);
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

export function personalGlossaryReviewRecordsStorageContract(): PersonalGlossaryReviewRecordsStorageContract {
  const value = personalGlossaryReviewRecordsContract();
  if (
    value.command !== "agentera report personal-glossary-reviews" ||
    value.queueRequestSchemaVersion !== "agentera.personalGlossaryReviewQueueRequest.v1" ||
    !sameStrings(value.queueRequestFields, ["schema_version", "receipt"]) ||
    value.queueMaxRequestUtf8Bytes !== 16_384 || value.queueDecisionOutcome !== "review_required" ||
    !sameStrings(value.queueCurrentBindings, ["candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "reason"]) ||
    value.queueResultSchemaVersion !== "agentera.personalGlossaryReviewQueueResult.v1" ||
    !sameStrings(value.queueResultStatuses, ["queued", "unchanged_replay", "suppressed", "reopened"]) ||
    value.queueMaxResultUtf8Bytes !== 4_096 || value.queueNoQuestionChannel !== "queue_without_prompt_or_disposition" ||
    value.dispositionRequestSchemaVersion !== "agentera.personalGlossaryReviewDispositionRequest.v1" ||
    !sameStrings(value.dispositionRequestFields, ["schema_version", "review_id", "receipt", "approval"]) ||
    value.dispositionMaxRequestUtf8Bytes !== 16_384 ||
    value.dispositionResultSchemaVersion !== "agentera.personalGlossaryReviewDispositionResult.v1" ||
    !sameStrings(value.dispositionResultStatuses, ["disposed", "unchanged_replay"]) ||
    value.dispositionMaxResultUtf8Bytes !== 4_096 ||
    !sameStrings(value.dispositionPublicationAuthorizationDispositions, ["accept", "correct"]) ||
    !sameStrings(value.dispositionPublicationAuthorizationFields, ["review_id", "review_record_sha256"]) ||
    value.trustedHostKeyFile !== "trusted-local-host.json" ||
    value.trustedHostKeySchemaVersion !== TRUSTED_HOST_KEY_SCHEMA_VERSION ||
    !sameStrings(value.trustedHostKeyFields, ["schema_version", "owner", "subject", "public_key_spki_base64url"]) ||
    value.trustedHostKeyOwner !== REVIEW_OWNER || value.trustedHostKeyAlgorithm !== "ed25519" ||
    value.trustedHostKeyMaxSerializedUtf8Bytes !== 4_096 || value.storeSchemaVersion !== STORE_SCHEMA_VERSION ||
    value.recordSchemaVersion !== RECORD_SCHEMA_VERSION || value.storeOwner !== REVIEW_OWNER ||
    value.storeFile !== "review-records.json" ||
    !sameStrings(value.storeFields, ["schema_version", "owner", "records", "replay_index", "store_sha256"]) ||
    !sameStrings(value.recordFields, ["schema_version", "owner", "review_id", "candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "scope", "reason", "status", "disposition", "review_record", "reopen_reason", "queued_at", "terminal_at", "expires_at", "record_sha256"]) ||
    value.recordsMax !== 100 || !sameStrings(value.replayIndexFields, ["nonce_sha256", "receipt_sha256", "expires_at"]) ||
    value.replayEntriesMax !== 100 || value.recordMaxSerializedUtf8Bytes !== 8_192 ||
    value.storeMaxSerializedUtf8Bytes !== 1_048_576 || value.storeOrder !== "review_id_asc" ||
    value.replay !== "exact_current_binding_is_unchanged_replay_and_exact_receipt_is_idempotent" ||
    value.conflict !== "changed_receipt_nonce_binding_or_signature_fails_before_effects" ||
    !sameStrings(value.compatibilityStoreSchemaVersions, [LEGACY_STORE_SCHEMA_VERSION, STORE_SCHEMA_VERSION]) ||
    !sameStrings(value.compatibilityRecordSchemaVersions, [LEGACY_RECORD_SCHEMA_VERSION, RECORD_SCHEMA_VERSION]) ||
    value.compatibilityReadMutation !== "forbidden" || value.compatibilityMigrationOperation !== "disposition_only" ||
    value.compatibilityScopeDerivation !== "current_validated_host_receipt_only" ||
    value.compatibilityInvalidBehavior !== "fail_before_effects" ||
    !sameStrings(value.compatibilityPreservedBindings, ["review_id", "candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "reason"]) ||
    value.compatibilityLegacyDigest !== "validate_before_migration" ||
    value.compatibilityMigratedDigest !== "reseal_v2_lifecycle_record" ||
    !sameStrings(value.suppressionBinding, ["candidate_id", "semantic_fingerprint", "scope", "policy_version"]) ||
    !sameStrings(value.suppressionDispositions, ["reject", "defer"]) ||
    !sameStrings(value.reopenReasons, ["policy_changed", "scope_changed", "meaning_changed"]) ||
    !sameStrings(value.forbiddenFields, ["term", "meaning", "excerpt", "raw_evidence", "source_id", "evidence_anchor", "session_id", "project_id", "source_path", "tool_content", "review_approval", "signature", "nonce"]) ||
    value.retrievalSchemaVersion !== "agentera.personalGlossaryReviewRetrieval.v1" || value.retrievalOwner !== REVIEW_OWNER ||
    value.listDefaultLimit !== 20 || value.listMaximumLimit !== 50 || value.listMaxSerializedUtf8Bytes !== 32_768 ||
    value.listOrder !== "queued_at_desc_then_review_id_asc" || !sameStrings(value.listStatuses, ["pending", "terminal"]) ||
    value.cursorAuthority !== "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor" ||
    value.cursorVocabulary !== "opaque_snapshot_cursor" ||
    !sameStrings(value.cursorBinding, ["collection", "owner", "filters", "limit", "order", "snapshot"]) ||
    value.cursorInvalidBehavior !== "cursor_invalid" || value.cursorUnavailableBehavior !== "cursor_snapshot_unavailable" ||
    !sameStrings(value.exactRequiredBindings, ["review_id", "candidate_id", "candidate_revision", "generation", "policy_version"]) ||
    value.exactCurrentBindingField !== "candidate_projection_sha256" || value.exactMaxSerializedUtf8Bytes !== 8_192 ||
    value.terminalMetadataDays !== 90 || value.maintenanceExposure !== "authenticated_review_owner_only" ||
    value.maintenancePurge !== "current_user_authorized_review_records_only" ||
    !sameStrings(value.maintenanceForbiddenEffects, ["profile_entry", "project_state", "candidate_projection", "publication"])
  ) throw new TypeError("personal glossary review-record contract is unavailable");
  return {
    storeFile: value.storeFile,
    trustedHostKeyFile: value.trustedHostKeyFile,
    trustedHostKeyMaxSerializedUtf8Bytes: value.trustedHostKeyMaxSerializedUtf8Bytes,
    storeMaxSerializedUtf8Bytes: value.storeMaxSerializedUtf8Bytes,
    recordMaxSerializedUtf8Bytes: value.recordMaxSerializedUtf8Bytes,
    recordsMax: value.recordsMax,
    replayEntriesMax: value.replayEntriesMax,
    terminalMetadataDays: value.terminalMetadataDays,
  };
}

export function reviewIdentity(record: ReviewIdentityBinding): string {
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

function reviewRecordOrder(left: PersonalGlossaryReviewStoredRecord, right: PersonalGlossaryReviewStoredRecord): number {
  return compareGlossaryUnicodeStrings(left.review_id, right.review_id);
}

function replayEntryOrder(left: PersonalGlossaryReviewReplayEntry, right: PersonalGlossaryReviewReplayEntry): number {
  return compareGlossaryUnicodeStrings(left.nonce_sha256, right.nonce_sha256);
}

function bodyWithoutDigest(value: Mapping, field: string): Mapping {
  const body = { ...value };
  delete body[field];
  return body;
}

export function reviewExpiry(disposedAt: string): string {
  return new Date(Date.parse(disposedAt) + personalGlossaryReviewRecordsStorageContract().terminalMetadataDays * 86_400_000).toISOString();
}

function validStoredReviewRecord(
  value: unknown,
  record: PersonalGlossaryReviewRecord,
): value is GlossaryReviewRecord {
  if (!mapping(value) || !exactKeys(value, ["schema_version", "owner", "candidate_id", "candidate_revision", "candidate_capsule_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "disposition", "corrected_meaning", "corrected_scope", "disposed_at", "expires_at", "record_sha256"])) return false;
  if (
    value.schema_version !== "agentera.personalGlossaryReviewRecord.v1" || value.owner !== "user_local_review_lifecycle" ||
    ![value.candidate_id, value.candidate_revision, value.candidate_capsule_sha256, value.host_receipt_sha256, value.cli_decision_sha256, value.semantic_fingerprint, value.record_sha256].every(digest) ||
    !validPersonalGlossaryReviewMetadataBinding(value.generation) || !validPersonalGlossaryReviewMetadataBinding(value.policy_version) ||
    value.candidate_id !== record.candidate_id || value.candidate_revision !== record.candidate_revision ||
    value.candidate_capsule_sha256 !== record.candidate_capsule_sha256 || value.host_receipt_sha256 !== record.host_receipt_sha256 ||
    value.cli_decision_sha256 !== record.cli_decision_sha256 || value.semantic_fingerprint !== record.semantic_fingerprint ||
    value.generation !== record.generation || value.policy_version !== record.policy_version ||
    value.disposition !== record.disposition || !timestamp(value.disposed_at) || !timestamp(value.expires_at) ||
    value.expires_at !== reviewExpiry(value.disposed_at) ||
    value.record_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(value, "record_sha256"))
  ) return false;
  return value.disposition === "correct"
    ? value.corrected_scope === "personal" && validCorrectedMeaning(value.corrected_meaning)
    : value.corrected_scope === null && value.corrected_meaning === null;
}

function commonRecordIsValid(value: Mapping): value is Mapping & ReviewIdentityBinding {
  return value.owner === REVIEW_OWNER &&
    [value.review_id, value.candidate_id, value.candidate_revision, value.candidate_capsule_sha256, value.candidate_projection_sha256, value.host_receipt_sha256, value.cli_decision_sha256, value.semantic_fingerprint, value.record_sha256].every(digest) &&
    validPersonalGlossaryReviewMetadataBinding(value.generation) && validPersonalGlossaryReviewMetadataBinding(value.policy_version) &&
    boundedText(value.reason, 512) &&
    (GLOSSARY_ADMISSION_REASONS_BY_OUTCOME.review_required as readonly string[]).includes(value.reason as string) &&
    timestamp(value.queued_at) && (value.status === "pending" || value.status === "terminal");
}

export function isLegacyReviewRecord(value: PersonalGlossaryReviewStoredRecord): value is PersonalGlossaryLegacyReviewRecord {
  return value.schema_version === LEGACY_RECORD_SCHEMA_VERSION;
}

export function isCurrentReviewRecord(value: PersonalGlossaryReviewStoredRecord): value is PersonalGlossaryReviewRecord {
  return value.schema_version === RECORD_SCHEMA_VERSION;
}

function validLegacyReviewRecord(value: unknown, valueContract: PersonalGlossaryReviewRecordsStorageContract): value is PersonalGlossaryLegacyReviewRecord {
  if (!mapping(value) || !exactKeys(value, ["schema_version", "owner", "review_id", "candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "reason", "status", "queued_at", "terminal_at", "expires_at", "record_sha256"]) ||
    value.schema_version !== LEGACY_RECORD_SCHEMA_VERSION || !commonRecordIsValid(value) ||
    value.review_id !== reviewIdentity(value as ReviewIdentityBinding) ||
    value.record_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(value, "record_sha256"))) return false;
  if (value.status === "pending") return value.terminal_at === null && value.expires_at === null && serializedBytes(value) <= valueContract.recordMaxSerializedUtf8Bytes;
  return timestamp(value.terminal_at) && timestamp(value.expires_at) &&
    Date.parse(value.terminal_at as string) >= Date.parse(value.queued_at as string) && serializedBytes(value) <= valueContract.recordMaxSerializedUtf8Bytes;
}

function validCurrentReviewRecord(value: unknown, valueContract: PersonalGlossaryReviewRecordsStorageContract): value is PersonalGlossaryReviewRecord {
  if (!mapping(value) || !exactKeys(value, ["schema_version", "owner", "review_id", "candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "scope", "reason", "status", "disposition", "review_record", "reopen_reason", "queued_at", "terminal_at", "expires_at", "record_sha256"]) ||
    value.schema_version !== RECORD_SCHEMA_VERSION || !commonRecordIsValid(value) ||
    !["personal", "ambiguous"].includes(String(value.scope)) ||
    (value.disposition !== null && !PERSONAL_REVIEW_DISPOSITIONS.includes(value.disposition as PersonalReviewDisposition)) ||
    (value.reopen_reason !== null && !["policy_changed", "scope_changed", "meaning_changed"].includes(String(value.reopen_reason)))) return false;
  const record = value as unknown as PersonalGlossaryReviewRecord;
  if (record.review_id !== reviewIdentity(record) || record.record_sha256 !== glossaryCanonicalSha256(bodyWithoutDigest(value, "record_sha256"))) return false;
  if (record.disposition === null) return record.status === "pending" && record.review_record === null && record.terminal_at === null && record.expires_at === null && serializedBytes(record) <= valueContract.recordMaxSerializedUtf8Bytes;
  if (!validStoredReviewRecord(record.review_record, record) || Date.parse(record.review_record.disposed_at) < Date.parse(record.queued_at)) return false;
  if (record.disposition === "defer") return record.status === "pending" && record.terminal_at === null && record.expires_at === null && serializedBytes(record) <= valueContract.recordMaxSerializedUtf8Bytes;
  return record.status === "terminal" && record.terminal_at === record.review_record.disposed_at && record.expires_at === record.review_record.expires_at && Date.parse(record.terminal_at) >= Date.parse(record.queued_at) && serializedBytes(record) <= valueContract.recordMaxSerializedUtf8Bytes;
}

function validReplayEntry(value: unknown): value is PersonalGlossaryReviewReplayEntry {
  return mapping(value) && exactKeys(value, ["nonce_sha256", "receipt_sha256", "expires_at"]) && digest(value.nonce_sha256) && digest(value.receipt_sha256) && timestamp(value.expires_at);
}

function validLegacyReviewStore(value: unknown, valueContract: PersonalGlossaryReviewRecordsStorageContract): value is PersonalGlossaryLegacyReviewStore {
  if (!mapping(value) || !exactKeys(value, ["schema_version", "owner", "records", "store_sha256"]) ||
    value.schema_version !== LEGACY_STORE_SCHEMA_VERSION || value.owner !== REVIEW_OWNER || !Array.isArray(value.records) ||
    value.records.length > valueContract.recordsMax || !digest(value.store_sha256) || serializedBytes(value) > valueContract.storeMaxSerializedUtf8Bytes) return false;
  const records = value.records as PersonalGlossaryLegacyReviewRecord[];
  return records.every((record) => validLegacyReviewRecord(record, valueContract)) &&
    !records.some((record, index) => index > 0 && reviewRecordOrder(records[index - 1]!, record) >= 0) &&
    value.store_sha256 === glossaryCanonicalSha256(bodyWithoutDigest(value, "store_sha256"));
}

function validCurrentReviewStore(value: unknown, valueContract: PersonalGlossaryReviewRecordsStorageContract): value is PersonalGlossaryReviewStore {
  if (!mapping(value) || !exactKeys(value, ["schema_version", "owner", "records", "replay_index", "store_sha256"]) ||
    value.schema_version !== STORE_SCHEMA_VERSION || value.owner !== REVIEW_OWNER || !Array.isArray(value.records) ||
    value.records.length > valueContract.recordsMax || !Array.isArray(value.replay_index) ||
    value.replay_index.length > valueContract.replayEntriesMax || !digest(value.store_sha256) ||
    serializedBytes(value) > valueContract.storeMaxSerializedUtf8Bytes) return false;
  const records = value.records as PersonalGlossaryReviewStoredRecord[];
  const replayIndex = value.replay_index as PersonalGlossaryReviewReplayEntry[];
  return records.every((record) => validLegacyReviewRecord(record, valueContract) || validCurrentReviewRecord(record, valueContract)) &&
    !records.some((record, index) => index > 0 && reviewRecordOrder(records[index - 1]!, record) >= 0) &&
    replayIndex.every(validReplayEntry) && !replayIndex.some((entry, index) => index > 0 && replayEntryOrder(replayIndex[index - 1]!, entry) >= 0) &&
    value.store_sha256 === glossaryCanonicalSha256(bodyWithoutDigest(value, "store_sha256"));
}

export function isLegacyReviewStore(value: PersonalGlossaryReviewStoreSource): value is PersonalGlossaryLegacyReviewStore {
  return value.schema_version === LEGACY_STORE_SCHEMA_VERSION;
}

export function isCurrentReviewStore(value: PersonalGlossaryReviewStoreSource): value is PersonalGlossaryReviewStore {
  return value.schema_version === STORE_SCHEMA_VERSION;
}

export function makePersonalGlossaryReviewStore(
  records: readonly PersonalGlossaryReviewStoredRecord[],
  replayIndex: readonly PersonalGlossaryReviewReplayEntry[],
): PersonalGlossaryReviewStore {
  const body = { schema_version: STORE_SCHEMA_VERSION, owner: REVIEW_OWNER, records: [...records].sort(reviewRecordOrder), replay_index: [...replayIndex].sort(replayEntryOrder) };
  const store = { ...body, store_sha256: glossaryCanonicalSha256(body) } as PersonalGlossaryReviewStore;
  if (!validCurrentReviewStore(store, personalGlossaryReviewRecordsStorageContract())) throw new TypeError("review record store is invalid");
  return store;
}

export function sealPersonalGlossaryReviewRecord(
  body: Omit<PersonalGlossaryReviewRecord, "record_sha256">,
): PersonalGlossaryReviewRecord {
  const recordBody = bodyWithoutDigest(body as Mapping, "record_sha256");
  const record = { ...recordBody, record_sha256: glossaryCanonicalSha256(recordBody) } as PersonalGlossaryReviewRecord;
  if (!validCurrentReviewRecord(record, personalGlossaryReviewRecordsStorageContract())) throw new TypeError("review record is invalid");
  return record;
}

export function migrateLegacyPendingReviewRecord(
  record: PersonalGlossaryLegacyReviewRecord,
  scope: ReviewScope,
): PersonalGlossaryReviewRecord {
  if (record.status !== "pending" || record.terminal_at !== null || record.expires_at !== null) {
    throw new TypeError("legacy review record is not pending");
  }
  return sealPersonalGlossaryReviewRecord({
    schema_version: RECORD_SCHEMA_VERSION,
    owner: REVIEW_OWNER,
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
    scope,
    reason: record.reason,
    status: "pending",
    disposition: null,
    review_record: null,
    reopen_reason: null,
    queued_at: record.queued_at,
    terminal_at: null,
    expires_at: null,
  });
}

export function privateWritePersonalGlossaryReviewRecords(pathname: string, text: string): void {
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
    try { fs.rmSync(temporary, { force: true }); } catch { /* already absent or renamed */ }
    throw error;
  }
}

export function ensurePersonalGlossaryReviewRecordsPrivate(pathname: string): void {
  const metadata = fs.statSync(pathname);
  if (!metadata.isFile()) throw new TypeError("stored review records are not a private file");
  if ((metadata.mode & 0o777) === 0o600) return;
  fs.chmodSync(pathname, 0o600);
  if ((fs.statSync(pathname).mode & 0o777) !== 0o600) throw new TypeError("stored review records could not be made private");
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

export function reviewScope(receipt: Mapping): ReviewScope | null {
  const classification = mapping(receipt.classification) ? receipt.classification : null;
  return classification?.scope === "personal" || classification?.scope === "ambiguous" ? classification.scope : null;
}

export function recordMatchesProjection(
  record: PersonalGlossaryReviewStoredRecord,
  projection: { projection_sha256: string; candidates: ProjectedPersonalGlossaryCandidate[] },
): boolean {
  return record.candidate_projection_sha256 === projection.projection_sha256 && projection.candidates.some((item) =>
    item.capsule.candidate_id === record.candidate_id && item.capsule.candidate_revision === record.candidate_revision &&
    item.capsule.capsule_sha256 === record.candidate_capsule_sha256 && item.capsule.generation === record.generation &&
    item.capsule.policy_version === record.policy_version);
}

export function terminalReviewRecordExpired(record: PersonalGlossaryReviewStoredRecord, now: string): boolean {
  return record.status === "terminal" && Date.parse(record.expires_at!) <= Date.parse(now);
}

export function readablePersonalGlossaryReviewRecord(record: PersonalGlossaryReviewStoredRecord): PersonalGlossaryReviewReadRecord {
  if (isCurrentReviewRecord(record)) return record;
  return { ...record, scope: null, disposition: null, review_record: null, reopen_reason: null };
}

export function replayNonceDigest(nonce: string): string {
  return glossaryCanonicalSha256({ schema_version: REPLAY_NONCE_SCHEMA_VERSION, nonce });
}

export function currentReplayIndex(entries: readonly PersonalGlossaryReviewReplayEntry[], now: string): PersonalGlossaryReviewReplayEntry[] {
  return entries.filter((entry) => Date.parse(entry.expires_at) > Date.parse(now));
}

export function replayDigestMap(entries: readonly PersonalGlossaryReviewReplayEntry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.nonce_sha256, entry.receipt_sha256]));
}

export function activeReplayDigestMap(entries: readonly PersonalGlossaryReviewReplayEntry[], now: string): Map<string, string> {
  return replayDigestMap(currentReplayIndex(entries, now));
}

export function personalGlossaryReviewRecordsPath(options: PersonalGlossaryReviewRecordsStorageOptions = {}): string {
  return path.join(defaultProfileDir(options.env ?? process.env, options.platform ?? process.platform), "intermediate", "personal-glossary", personalGlossaryReviewRecordsStorageContract().storeFile);
}

export function personalGlossaryTrustedLocalHostPath(options: PersonalGlossaryReviewRecordsStorageOptions = {}): string {
  return path.join(path.dirname(personalGlossaryReviewRecordsPath(options)), personalGlossaryReviewRecordsStorageContract().trustedHostKeyFile);
}

export function readPersonalGlossaryTrustedLocalHost(options: PersonalGlossaryReviewRecordsStorageOptions): TrustedLocalHostKey | null {
  let text: string;
  try { text = readBoundedFile(personalGlossaryTrustedLocalHostPath(options), personalGlossaryReviewRecordsStorageContract().trustedHostKeyMaxSerializedUtf8Bytes); } catch { return null; }
  try {
    const value = JSON.parse(text) as unknown;
    if (!mapping(value) || !exactKeys(value, ["schema_version", "owner", "subject", "public_key_spki_base64url"]) ||
      value.schema_version !== TRUSTED_HOST_KEY_SCHEMA_VERSION || value.owner !== REVIEW_OWNER ||
      !validPersonalGlossaryReviewMetadataBinding(value.subject) || !boundedText(value.public_key_spki_base64url, 4_096) ||
      !BASE64URL.test(value.public_key_spki_base64url) || text !== `${canonicalGlossaryJson(value)}\n`) return null;
    const encoded = Buffer.from(value.public_key_spki_base64url, "base64url");
    const publicKey = createPublicKey({ key: encoded, format: "der", type: "spki" });
    const normalized = publicKey.export({ format: "der", type: "spki" });
    return publicKey.asymmetricKeyType === "ed25519" && Buffer.from(normalized).equals(encoded)
      ? { subject: value.subject, publicKey }
      : null;
  } catch { return null; }
}

export function readPersonalGlossaryReviewRecords(
  options: PersonalGlossaryReviewRecordsStorageOptions = {},
): PersonalGlossaryReviewRecordsReadResult {
  const valueContract = personalGlossaryReviewRecordsStorageContract();
  let text: string;
  try { text = readBoundedFile(personalGlossaryReviewRecordsPath(options), valueContract.storeMaxSerializedUtf8Bytes); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "missing", store: null } : { status: "corrupt", store: null }; }
  try {
    const parsed = JSON.parse(text) as unknown;
    if ((!validLegacyReviewStore(parsed, valueContract) && !validCurrentReviewStore(parsed, valueContract)) || text !== `${canonicalGlossaryJson(parsed)}\n`) return { status: "corrupt", store: null };
    return { status: "current", store: parsed };
  } catch { return { status: "corrupt", store: null }; }
}
