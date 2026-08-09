import fs from "node:fs";

import { readPersonalGlossaryCandidateProjection, type ProjectedPersonalGlossaryCandidate } from "./personalGlossaryCandidateProjection.js";
import { decidePersonalGlossaryCandidate } from "./personalGlossaryDecision.js";
import {
  createGlossaryReviewRecord,
  validateGlossaryAdmissionDecision,
  validateGlossaryHostClassificationReceipt,
  validateGlossaryReviewRecord,
  type GlossaryAdmissionDecision,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
  type GlossaryReviewRecord,
} from "../registries/glossaryCandidateContracts.js";
import {
  personalReviewApprovalReceiptDigest,
  personalReviewApprovalReplayStatus,
  personalReviewDispositionLifecycle,
  validatePersonalReviewApprovalReceipt,
  type PersonalReviewDisposition,
} from "../registries/glossaryMiningAuthority.js";
import { canonicalGlossaryJson, compareGlossaryUnicodeStrings } from "../registries/glossaryTermIdentity.js";
import {
  activeReplayDigestMap,
  currentReplayIndex,
  ensurePersonalGlossaryReviewRecordsPrivate,
  isCurrentReviewRecord,
  isCurrentReviewStore,
  isLegacyReviewRecord,
  isLegacyReviewStore,
  makePersonalGlossaryReviewStore,
  migrateLegacyPendingReviewRecord,
  personalGlossaryReviewRecordsPath,
  personalGlossaryReviewRecordsStorageContract,
  personalGlossaryTrustedLocalHostPath,
  privateWritePersonalGlossaryReviewRecords,
  readPersonalGlossaryReviewRecords,
  readPersonalGlossaryTrustedLocalHost,
  readablePersonalGlossaryReviewRecord,
  recordMatchesProjection,
  replayDigestMap,
  replayNonceDigest,
  reviewExpiry,
  reviewIdentity,
  reviewScope,
  sealPersonalGlossaryReviewRecord,
  terminalReviewRecordExpired,
  validPersonalGlossaryReviewMetadataBinding,
  type PersonalGlossaryLegacyReviewRecord,
  type PersonalGlossaryReviewReadRecord,
  type PersonalGlossaryReviewRecord,
  type PersonalGlossaryReviewRecordsReadResult,
  type PersonalGlossaryReviewRecordsStorageOptions,
  type PersonalGlossaryReviewReopenReason,
  type PersonalGlossaryReviewReplayEntry,
  type PersonalGlossaryReviewStore,
  type PersonalGlossaryReviewStoreSource,
  type PersonalGlossaryReviewStoredRecord,
  type ReviewScope,
} from "./personalGlossaryReviewRecordStorage.js";

export {
  personalGlossaryReviewRecordsPath,
  personalGlossaryTrustedLocalHostPath,
  readPersonalGlossaryReviewRecords,
  validPersonalGlossaryReviewMetadataBinding,
};
export type {
  PersonalGlossaryLegacyReviewRecord,
  PersonalGlossaryReviewReadRecord,
  PersonalGlossaryReviewRecord,
  PersonalGlossaryReviewRecordsReadResult,
  PersonalGlossaryReviewRecordsStorageOptions,
  PersonalGlossaryReviewReopenReason,
  PersonalGlossaryReviewReplayEntry,
  PersonalGlossaryReviewStore,
  PersonalGlossaryReviewStoreSource,
  PersonalGlossaryReviewStoredRecord,
};

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

type Mapping = Record<string, unknown>;

export interface PersonalGlossaryCurrentReviewRecordsResult {
  status: "current" | "missing" | "corrupt" | "projection_unavailable";
  records: PersonalGlossaryReviewReadRecord[];
  expired_records: number;
  stale_records: number;
}

export interface PersonalGlossaryReviewQueueInput extends PersonalGlossaryReviewRecordsStorageOptions {
  receipt: unknown;
  now?: string;
}

export interface PersonalGlossaryReviewQueueResult {
  status:
    | "queued"
    | "unchanged_replay"
    | "suppressed"
    | "reopened"
    | "decision_not_review_required"
    | "current_binding_mismatch"
    | "records_unavailable"
    | "record_capacity_exceeded"
    | "already_terminal";
  reason: string;
  record: PersonalGlossaryReviewRecord | null;
  reopen_reason: PersonalGlossaryReviewReopenReason | null;
}

export interface PersonalGlossaryReviewDispositionInput extends PersonalGlossaryReviewRecordsStorageOptions {
  review_id: string;
  receipt: unknown;
  approval: unknown;
  now?: string;
}

export interface PersonalGlossaryReviewPublicationAuthorization {
  review_id: string;
  review_record_sha256: string;
}

export interface PersonalGlossaryReviewDispositionResult {
  status:
    | "disposed"
    | "unchanged_replay"
    | "review_not_found"
    | "review_not_pending"
    | "current_binding_mismatch"
    | "approval_invalid"
    | "approval_conflicting_replay"
    | "approval_unavailable"
    | "records_unavailable"
    | "replay_capacity_exceeded";
  record: PersonalGlossaryReviewRecord | null;
  publication_authorization: PersonalGlossaryReviewPublicationAuthorization | null;
}

export interface PersonalGlossaryReviewPublicationAuthorizationInput extends PersonalGlossaryReviewRecordsStorageOptions {
  review_id: string;
  review_record_sha256: string;
  capsule: GlossaryEvidenceCapsule;
  receipt: GlossaryHostClassificationReceipt;
  decision: GlossaryAdmissionDecision;
  candidate_projection_sha256: string;
  now?: string;
}

export interface PersonalGlossaryReviewPublicationAuthorizationResult {
  status: "authorized" | "unavailable" | "binding_mismatch" | "not_publishable";
  review: GlossaryReviewRecord | null;
}

export interface PersonalGlossaryReviewRecordsMaintenanceInput extends PersonalGlossaryReviewRecordsStorageOptions {
  now: string;
  current_user_purge_authorized?: boolean;
}

export interface PersonalGlossaryReviewRecordsMaintenanceResult {
  status: "missing" | "corrupt" | "unchanged" | "changed" | "purged";
  expired_records: number;
  expired_receipts: number;
}

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function exactCandidate(
  candidates: readonly ProjectedPersonalGlossaryCandidate[],
  decision: GlossaryAdmissionDecision,
): ProjectedPersonalGlossaryCandidate | null {
  return candidates.find((candidate) =>
    candidate.capsule.candidate_id === decision.candidate_id &&
    candidate.capsule.candidate_revision === decision.candidate_revision &&
    candidate.capsule.capsule_sha256 === decision.candidate_capsule_sha256 &&
    candidate.capsule.generation === decision.generation &&
    candidate.capsule.policy_version === decision.policy_version) ?? null;
}

function pendingRecord(
  decision: GlossaryAdmissionDecision,
  scope: ReviewScope,
  queuedAt: string,
  reopenReason: PersonalGlossaryReviewReopenReason | null,
): PersonalGlossaryReviewRecord {
  const body = {
    schema_version: "agentera.personalGlossaryReviewRecord.v2" as const,
    owner: "current_user" as const,
    candidate_id: decision.candidate_id,
    candidate_revision: decision.candidate_revision,
    candidate_capsule_sha256: decision.candidate_capsule_sha256,
    candidate_projection_sha256: decision.candidate_projection_sha256,
    host_receipt_sha256: decision.host_receipt_sha256,
    cli_decision_sha256: decision.decision_sha256,
    semantic_fingerprint: decision.semantic_fingerprint,
    generation: decision.generation,
    policy_version: decision.policy_version,
    scope,
    reason: decision.reason,
    status: "pending" as const,
    disposition: null,
    review_record: null,
    reopen_reason: reopenReason,
    queued_at: queuedAt,
    terminal_at: null,
    expires_at: null,
  };
  return sealPersonalGlossaryReviewRecord({ ...body, review_id: reviewIdentity(body) });
}

function suppresses(record: PersonalGlossaryReviewRecord): boolean {
  return record.disposition === "reject" || record.disposition === "defer";
}

function sameSuppressionBinding(previous: PersonalGlossaryReviewRecord, current: PersonalGlossaryReviewRecord): boolean {
  return previous.candidate_id === current.candidate_id &&
    previous.semantic_fingerprint === current.semantic_fingerprint &&
    previous.scope === current.scope && previous.policy_version === current.policy_version;
}

function reopeningReason(
  previous: PersonalGlossaryReviewRecord,
  current: PersonalGlossaryReviewRecord,
): PersonalGlossaryReviewReopenReason | null {
  if (previous.candidate_id !== current.candidate_id) return null;
  if (previous.policy_version !== current.policy_version) return "policy_changed";
  if (previous.scope !== current.scope) return "scope_changed";
  if (previous.semantic_fingerprint !== current.semantic_fingerprint) return "meaning_changed";
  return null;
}

function latestComparableRecord(
  records: readonly PersonalGlossaryReviewStoredRecord[],
  candidateId: string,
  now: string,
): PersonalGlossaryReviewRecord | null {
  return records.filter(isCurrentReviewRecord).filter((record) =>
    record.candidate_id === candidateId && record.disposition !== null && !terminalReviewRecordExpired(record, now),
  ).sort((left, right) => Date.parse(right.queued_at) - Date.parse(left.queued_at) || compareGlossaryUnicodeStrings(left.review_id, right.review_id))[0] ?? null;
}

function publicationAuthorization(record: PersonalGlossaryReviewRecord): PersonalGlossaryReviewPublicationAuthorization | null {
  return record.review_record && ["accept", "correct"].includes(String(record.disposition))
    ? { review_id: record.review_id, review_record_sha256: record.review_record.record_sha256 }
    : null;
}

export function currentPersonalGlossaryReviewRecords(
  options: PersonalGlossaryReviewRecordsStorageOptions = {},
  now = new Date().toISOString(),
): PersonalGlossaryCurrentReviewRecordsResult {
  if (!timestamp(now)) throw new TypeError("review read time must be an ISO timestamp");
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status === "missing") return { status: "current", records: [], expired_records: 0, stale_records: 0 };
  if (current.status !== "current" || current.store === null) return { status: current.status, records: [], expired_records: 0, stale_records: 0 };
  const projection = readPersonalGlossaryCandidateProjection(options);
  if (projection.status !== "current" || projection.projection === null) return { status: "projection_unavailable", records: [], expired_records: 0, stale_records: 0 };
  let expiredRecords = 0;
  let staleRecords = 0;
  const records = current.store.records.filter((record) => {
    if (terminalReviewRecordExpired(record, now)) { expiredRecords += 1; return false; }
    if (!recordMatchesProjection(record, projection.projection!)) { staleRecords += 1; return false; }
    return true;
  }).map(readablePersonalGlossaryReviewRecord);
  return { status: "current", records, expired_records: expiredRecords, stale_records: staleRecords };
}

/** Queue one current review-required decision without accepting a user disposition. */
export function queuePersonalGlossaryReviewRecord(input: PersonalGlossaryReviewQueueInput): PersonalGlossaryReviewQueueResult {
  const queuedAt = input.now ?? new Date().toISOString();
  if (!timestamp(queuedAt)) throw new TypeError("review queue time must be an ISO timestamp");
  if (!mapping(input.receipt)) return { status: "decision_not_review_required", reason: "receipt_invalid", record: null, reopen_reason: null };
  const options = { env: input.env, platform: input.platform };
  const decisionResult = decidePersonalGlossaryCandidate(input.receipt, options);
  if (decisionResult.status !== "review_required" || decisionResult.decision === null) return { status: "decision_not_review_required", reason: decisionResult.reason, record: null, reopen_reason: null };
  const decision = decisionResult.decision;
  const projection = readPersonalGlossaryCandidateProjection(options);
  if (projection.status !== "current" || projection.projection === null || projection.projection.projection_sha256 !== decision.candidate_projection_sha256) return { status: "current_binding_mismatch", reason: "projection_unavailable", record: null, reopen_reason: null };
  const candidate = exactCandidate(projection.projection.candidates, decision);
  const scope = reviewScope(input.receipt);
  if (!validPersonalGlossaryReviewMetadataBinding(decision.generation) || !validPersonalGlossaryReviewMetadataBinding(decision.policy_version)) return { status: "current_binding_mismatch", reason: "record_binding_mismatch", record: null, reopen_reason: null };
  if (candidate === null || scope === null || validateGlossaryHostClassificationReceipt(input.receipt, candidate.capsule, { candidateProjectionSha256: projection.projection.projection_sha256 }).length > 0 || validateGlossaryAdmissionDecision(decision, candidate.capsule, input.receipt).length > 0) return { status: "current_binding_mismatch", reason: "candidate_binding_mismatch", record: null, reopen_reason: null };
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status === "corrupt" || (current.store !== null && isLegacyReviewStore(current.store))) return { status: "records_unavailable", reason: "review_records_unavailable", record: null, reopen_reason: null };
  const records = current.store?.records ?? [];
  const candidateRecord = pendingRecord(decision, scope, queuedAt, null);
  const existing = records.find((record) => record.review_id === candidateRecord.review_id);
  if (existing) {
    if (!isCurrentReviewRecord(existing)) return { status: "records_unavailable", reason: "review_records_unavailable", record: null, reopen_reason: null };
    if (suppresses(existing)) return { status: "suppressed", reason: existing.reason, record: existing, reopen_reason: null };
    if (existing.status === "pending") {
      ensurePersonalGlossaryReviewRecordsPrivate(personalGlossaryReviewRecordsPath(options));
      return { status: "unchanged_replay", reason: existing.reason, record: existing, reopen_reason: existing.reopen_reason };
    }
    return { status: "already_terminal", reason: "review_already_terminal", record: null, reopen_reason: null };
  }
  const suppressed = records.filter(isCurrentReviewRecord).find((record) => !terminalReviewRecordExpired(record, queuedAt) && suppresses(record) && sameSuppressionBinding(record, candidateRecord));
  if (suppressed) return { status: "suppressed", reason: suppressed.reason, record: suppressed, reopen_reason: null };
  const previous = latestComparableRecord(records, decision.candidate_id, queuedAt);
  const reopenReason = previous ? reopeningReason(previous, candidateRecord) : null;
  const record = reopenReason === null ? candidateRecord : pendingRecord(decision, scope, queuedAt, reopenReason);
  if (records.length >= personalGlossaryReviewRecordsStorageContract().recordsMax) return { status: "record_capacity_exceeded", reason: "review_record_capacity_exceeded", record: null, reopen_reason: null };
  privateWritePersonalGlossaryReviewRecords(
    personalGlossaryReviewRecordsPath(options),
    `${canonicalGlossaryJson(makePersonalGlossaryReviewStore(
      [...records, record],
      current.store?.replay_index ?? [],
    ))}\n`,
  );
  return { status: reopenReason === null ? "queued" : "reopened", reason: record.reason, record, reopen_reason: reopenReason };
}

function currentRecordForDisposition(
  record: PersonalGlossaryReviewStoredRecord,
  receipt: Mapping,
): PersonalGlossaryReviewRecord | null {
  if (isCurrentReviewRecord(record)) return record;
  const scope = reviewScope(receipt);
  if (scope === null) return null;
  try { return migrateLegacyPendingReviewRecord(record, scope); } catch { return null; }
}

/** Record one signed current-user disposition after current source and replay validation. */
export function dispositionPersonalGlossaryReviewRecord(
  input: PersonalGlossaryReviewDispositionInput,
): PersonalGlossaryReviewDispositionResult {
  const now = input.now ?? new Date().toISOString();
  if (!timestamp(now)) throw new TypeError("review disposition time must be an ISO timestamp");
  if (!digest(input.review_id) || !mapping(input.receipt) || !mapping(input.approval)) return { status: "approval_invalid", record: null, publication_authorization: null };
  const options = { env: input.env, platform: input.platform };
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status !== "current" || current.store === null) return { status: current.status === "corrupt" ? "records_unavailable" : "review_not_found", record: null, publication_authorization: null };
  const storedRecord = current.store.records.find((record) => record.review_id === input.review_id);
  if (!storedRecord || terminalReviewRecordExpired(storedRecord, now)) return { status: "review_not_found", record: null, publication_authorization: null };
  const decisionResult = decidePersonalGlossaryCandidate(input.receipt, options);
  if (decisionResult.status !== "review_required" || decisionResult.decision === null) return { status: "current_binding_mismatch", record: null, publication_authorization: null };
  const decision = decisionResult.decision;
  const projection = readPersonalGlossaryCandidateProjection(options);
  if (projection.status !== "current" || projection.projection === null || !recordMatchesProjection(storedRecord, projection.projection)) return { status: "current_binding_mismatch", record: null, publication_authorization: null };
  const candidate = exactCandidate(projection.projection.candidates, decision);
  if (candidate === null || decision.candidate_id !== storedRecord.candidate_id || decision.candidate_revision !== storedRecord.candidate_revision || decision.candidate_capsule_sha256 !== storedRecord.candidate_capsule_sha256 || decision.candidate_projection_sha256 !== storedRecord.candidate_projection_sha256 || decision.host_receipt_sha256 !== storedRecord.host_receipt_sha256 || decision.decision_sha256 !== storedRecord.cli_decision_sha256 || decision.semantic_fingerprint !== storedRecord.semantic_fingerprint || decision.generation !== storedRecord.generation || decision.policy_version !== storedRecord.policy_version || validateGlossaryHostClassificationReceipt(input.receipt, candidate.capsule, { candidateProjectionSha256: projection.projection.projection_sha256 }).length > 0 || validateGlossaryAdmissionDecision(decision, candidate.capsule, input.receipt).length > 0) return { status: "current_binding_mismatch", record: null, publication_authorization: null };
  const record = currentRecordForDisposition(storedRecord, input.receipt);
  if (!record) return { status: "current_binding_mismatch", record: null, publication_authorization: null };
  const trustedHost = readPersonalGlossaryTrustedLocalHost(options);
  if (!trustedHost) return { status: "approval_unavailable", record: null, publication_authorization: null };
  const replayEntries = isCurrentReviewStore(current.store) ? currentReplayIndex(current.store.replay_index, now) : [];
  const replayNonceKey = typeof input.approval.nonce === "string" ? replayNonceDigest(input.approval.nonce) : undefined;
  const errors = validatePersonalReviewApprovalReceipt(input.approval, {
    currentUserSubject: trustedHost.subject,
    reviewId: record.review_id,
    candidateId: record.candidate_id,
    candidateRevision: record.candidate_revision,
    candidateProjectionSha256: record.candidate_projection_sha256,
    semanticFingerprint: record.semantic_fingerprint,
    generation: record.generation,
    policyVersion: record.policy_version,
    now: new Date(now),
    trustedHostPublicKey: trustedHost.publicKey,
    consumedReceiptDigests: activeReplayDigestMap(replayEntries, now),
    replayNonceKey,
  });
  let replay: "new" | "exact_replay" | "conflicting_replay";
  let receiptDigest: string;
  let nonceDigest: string;
  try {
    replay = personalReviewApprovalReplayStatus(input.approval, replayDigestMap(replayEntries), replayNonceKey);
    receiptDigest = personalReviewApprovalReceiptDigest(input.approval);
    nonceDigest = replayNonceDigest(String(input.approval.nonce));
  } catch { return { status: "approval_invalid", record: null, publication_authorization: null }; }
  if (replay === "conflicting_replay") return { status: "approval_conflicting_replay", record: null, publication_authorization: null };
  if (errors.length > 0) return { status: "approval_invalid", record: null, publication_authorization: null };
  if (replay === "exact_replay") return { status: "unchanged_replay", record, publication_authorization: publicationAuthorization(record) };
  if (record.status === "terminal") return { status: "review_not_pending", record: null, publication_authorization: null };
  const disposition = input.approval.disposition as PersonalReviewDisposition;
  if (disposition === "correct" && typeof input.approval.corrected_meaning !== "string") return { status: "approval_invalid", record: null, publication_authorization: null };
  if (replayEntries.length >= personalGlossaryReviewRecordsStorageContract().replayEntriesMax) return { status: "replay_capacity_exceeded", record: null, publication_authorization: null };
  let review: GlossaryReviewRecord;
  try {
    review = createGlossaryReviewRecord({
      capsule: candidate.capsule,
      receipt: input.receipt as GlossaryHostClassificationReceipt,
      decision,
      disposition,
      corrected_meaning: input.approval.corrected_meaning as string | null,
      corrected_scope: input.approval.corrected_scope as "personal" | null,
      disposed_at: input.approval.disposed_at as string,
      expires_at: reviewExpiry(input.approval.disposed_at as string),
    });
  } catch { return { status: "approval_invalid", record: null, publication_authorization: null }; }
  const terminal = personalReviewDispositionLifecycle(disposition) === "terminal";
  let nextRecord: PersonalGlossaryReviewRecord;
  try {
    nextRecord = sealPersonalGlossaryReviewRecord({
      ...record,
      scope: disposition === "correct" ? "personal" : record.scope,
      status: terminal ? "terminal" : "pending",
      disposition,
      review_record: review,
      terminal_at: terminal ? review.disposed_at : null,
      expires_at: terminal ? review.expires_at : null,
    });
  } catch { return { status: "approval_invalid", record: null, publication_authorization: null }; }
  const replayEntry: PersonalGlossaryReviewReplayEntry = { nonce_sha256: nonceDigest, receipt_sha256: receiptDigest, expires_at: input.approval.expires_at as string };
  const next = makePersonalGlossaryReviewStore(current.store.records.map((item) => item.review_id === record.review_id ? nextRecord : item), [...replayEntries, replayEntry]);
  try { privateWritePersonalGlossaryReviewRecords(personalGlossaryReviewRecordsPath(options), `${canonicalGlossaryJson(next)}\n`); }
  catch { return { status: "records_unavailable", record: null, publication_authorization: null }; }
  return { status: "disposed", record: nextRecord, publication_authorization: publicationAuthorization(nextRecord) };
}

/** Resolve one stored accept/correct authorization without treating it as current evidence. */
export function personalGlossaryReviewPublicationAuthorization(
  input: PersonalGlossaryReviewPublicationAuthorizationInput,
): PersonalGlossaryReviewPublicationAuthorizationResult {
  const now = input.now ?? new Date().toISOString();
  if (!timestamp(now) || !digest(input.review_id) || !digest(input.review_record_sha256)) return { status: "binding_mismatch", review: null };
  const current = readPersonalGlossaryReviewRecords({ env: input.env, platform: input.platform });
  if (current.status !== "current" || current.store === null) return { status: "unavailable", review: null };
  const storedRecord = current.store.records.find((record) => record.review_id === input.review_id);
  if (!storedRecord || !isCurrentReviewRecord(storedRecord) || terminalReviewRecordExpired(storedRecord, now) || !storedRecord.review_record || storedRecord.status !== "terminal") return { status: "not_publishable", review: null };
  if (storedRecord.review_record.record_sha256 !== input.review_record_sha256 || !["accept", "correct"].includes(String(storedRecord.disposition)) || storedRecord.candidate_projection_sha256 !== input.candidate_projection_sha256 || storedRecord.candidate_id !== input.capsule.candidate_id || storedRecord.candidate_revision !== input.capsule.candidate_revision || storedRecord.candidate_capsule_sha256 !== input.capsule.capsule_sha256 || storedRecord.host_receipt_sha256 !== input.receipt.receipt_sha256 || storedRecord.cli_decision_sha256 !== input.decision.decision_sha256 || storedRecord.semantic_fingerprint !== input.receipt.semantic_fingerprint || storedRecord.generation !== input.capsule.generation || storedRecord.policy_version !== input.capsule.policy_version || validateGlossaryReviewRecord(storedRecord.review_record, input.capsule, input.receipt, input.decision).length > 0) return { status: "binding_mismatch", review: null };
  return { status: "authorized", review: storedRecord.review_record };
}

/** Remove expired terminal metadata and receipt replay digests, or a purged local store only. */
export function maintainPersonalGlossaryReviewRecords(
  input: PersonalGlossaryReviewRecordsMaintenanceInput,
): PersonalGlossaryReviewRecordsMaintenanceResult {
  if (!timestamp(input.now)) throw new TypeError("review maintenance time must be an ISO timestamp");
  const options = { env: input.env, platform: input.platform };
  const current = readPersonalGlossaryReviewRecords(options);
  if (current.status === "missing" || current.status === "corrupt") return { status: current.status, expired_records: 0, expired_receipts: 0 };
  const pathname = personalGlossaryReviewRecordsPath(options);
  if (input.current_user_purge_authorized === true) {
    fs.rmSync(pathname, { force: true });
    return { status: "purged", expired_records: 0, expired_receipts: 0 };
  }
  if (isLegacyReviewStore(current.store!)) return { status: "unchanged", expired_records: 0, expired_receipts: 0 };
  const records = current.store!.records.filter((record) => !terminalReviewRecordExpired(record, input.now));
  const replayIndex = currentReplayIndex(current.store!.replay_index, input.now);
  const expiredRecords = current.store!.records.length - records.length;
  const expiredReceipts = current.store!.replay_index.length - replayIndex.length;
  if (expiredRecords === 0 && expiredReceipts === 0) return { status: "unchanged", expired_records: 0, expired_receipts: 0 };
  if (records.length === 0 && replayIndex.length === 0) fs.rmSync(pathname, { force: true });
  else privateWritePersonalGlossaryReviewRecords(pathname, `${canonicalGlossaryJson(makePersonalGlossaryReviewStore(records, replayIndex))}\n`);
  return { status: "changed", expired_records: expiredRecords, expired_receipts: expiredReceipts };
}
