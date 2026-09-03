import { createHash, verify as verifySignature, type KeyLike } from "node:crypto";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const REVIEW_RECEIPT_FIELDS = [
  "schema_version",
  "issuer",
  "subject",
  "trusted_channel",
  "review_id",
  "candidate_id",
  "candidate_revision",
  "candidate_projection_sha256",
  "semantic_fingerprint",
  "generation",
  "policy_version",
  "disposition",
  "corrected_meaning",
  "corrected_scope",
  "disposed_at",
  "expires_at",
  "nonce",
  "signature",
] as const;

const REVIEW_RECEIPT_SIGNED_FIELDS = REVIEW_RECEIPT_FIELDS.filter((field) => field !== "signature");

export const PERSONAL_REVIEW_DISPOSITIONS = ["accept", "correct", "reject", "defer"] as const;
export type PersonalReviewDisposition = (typeof PERSONAL_REVIEW_DISPOSITIONS)[number];

export interface PersonalReviewApprovalVerification {
  currentUserSubject: string;
  reviewId: string;
  candidateId: string;
  candidateRevision: string;
  candidateProjectionSha256: string;
  semanticFingerprint: string;
  generation: string;
  policyVersion: string;
  now: Date;
  trustedHostPublicKey: KeyLike;
  consumedReceiptDigests?: ReadonlyMap<string, string>;
  /** The caller may index consumed receipts by a private nonce digest. */
  replayNonceKey?: string;
}

function receiptField(receipt: Mapping, field: string): string {
  const value = receipt[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`review approval receipt field ${field} must be a non-empty string`);
  }
  return value;
}

function nullableReceiptField(receipt: Mapping, field: string): string | null {
  const value = receipt[field];
  if (value !== null && typeof value !== "string") {
    throw new TypeError(`review approval receipt field ${field} must be a string or null`);
  }
  return value;
}

function signedReviewReceiptPayload(receipt: Mapping): string {
  return JSON.stringify(Object.fromEntries(REVIEW_RECEIPT_SIGNED_FIELDS.map((field) => [field, ["corrected_meaning", "corrected_scope"].includes(field) ? nullableReceiptField(receipt, field) : receiptField(receipt, field)])));
}

export function personalReviewApprovalReceiptDigest(receipt: Mapping): string {
  const payload = signedReviewReceiptPayload(receipt);
  return sha256Utf8(
    JSON.stringify({
      signed: JSON.parse(payload),
      signature: receiptField(receipt, "signature"),
    }),
  );
}

export function personalReviewApprovalReplayStatus(receipt: Mapping, consumedReceiptDigests: ReadonlyMap<string, string> = new Map(), replayNonceKey?: string): "new" | "exact_replay" | "conflicting_replay" {
  const nonce = receiptField(receipt, "nonce");
  const key = replayNonceKey ?? nonce;
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("review approval replay nonce key must be a non-empty string");
  }
  const consumedDigest = consumedReceiptDigests.get(key);
  if (!consumedDigest) return "new";
  return consumedDigest === personalReviewApprovalReceiptDigest(receipt) ? "exact_replay" : "conflicting_replay";
}

export function validatePersonalReviewApprovalReceipt(receipt: Mapping, expected: PersonalReviewApprovalVerification): string[] {
  const errors: string[] = [];
  const extraFields = Object.keys(receipt).filter((field) => !REVIEW_RECEIPT_FIELDS.includes(field as (typeof REVIEW_RECEIPT_FIELDS)[number]));
  if (extraFields.length > 0) errors.push(`review approval receipt has forbidden fields: ${extraFields.join(", ")}`);
  let payload = "";
  let signature = "";
  try {
    payload = signedReviewReceiptPayload(receipt);
    signature = receiptField(receipt, "signature");
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (receipt.schema_version !== "agentera.personalGlossaryReviewApproval.v1") {
    errors.push("review approval receipt schema_version is invalid");
  }
  if (receipt.issuer !== "agentera-local-host") {
    errors.push("review approval receipt issuer is not trusted");
  }
  if (receipt.subject !== expected.currentUserSubject || ["agent", "model", "imported_record", "generic_consent"].includes(String(receipt.subject))) {
    errors.push("review approval receipt subject is not the trusted current user");
  }
  if (receipt.trusted_channel !== "agentera-local-host-ipc") {
    errors.push("review approval receipt trusted channel is invalid");
  }
  if (receipt.review_id !== expected.reviewId) {
    errors.push("review approval receipt review binding is invalid");
  }
  if (receipt.candidate_id !== expected.candidateId) {
    errors.push("review approval receipt candidate binding is invalid");
  }
  if (receipt.candidate_revision !== expected.candidateRevision) {
    errors.push("review approval receipt revision binding is invalid");
  }
  if (receipt.candidate_projection_sha256 !== expected.candidateProjectionSha256) {
    errors.push("review approval receipt projection binding is invalid");
  }
  if (receipt.semantic_fingerprint !== expected.semanticFingerprint) {
    errors.push("review approval receipt semantic fingerprint binding is invalid");
  }
  if (receipt.generation !== expected.generation) {
    errors.push("review approval receipt generation binding is invalid");
  }
  if (receipt.policy_version !== expected.policyVersion) {
    errors.push("review approval receipt policy binding is invalid");
  }
  if (!PERSONAL_REVIEW_DISPOSITIONS.includes(receipt.disposition as PersonalReviewDisposition)) {
    errors.push("review approval receipt disposition is invalid");
  }
  if (receipt.disposition === "correct") {
    if (typeof receipt.corrected_meaning !== "string" || receipt.corrected_meaning.trim().length === 0 || Buffer.byteLength(receipt.corrected_meaning, "utf8") > 4_096) {
      errors.push("review approval receipt corrected_meaning is invalid");
    }
    if (receipt.corrected_scope !== "personal") {
      errors.push("review approval receipt corrected_scope is invalid");
    }
  } else if (receipt.corrected_meaning !== null || receipt.corrected_scope !== null) {
    errors.push("review approval receipt correction fields are invalid");
  }
  const disposedAt = Date.parse(String(receipt.disposed_at));
  const expiresAt = Date.parse(String(receipt.expires_at));
  const now = expected.now.getTime();
  if (!Number.isFinite(disposedAt) || !Number.isFinite(expiresAt)) {
    errors.push("review approval receipt freshness timestamps are invalid");
  } else {
    if (disposedAt > now) errors.push("review approval receipt disposed_at is in the future");
    if (now - disposedAt > 300_000) errors.push("review approval receipt is stale");
    if (expiresAt <= now || expiresAt <= disposedAt) {
      errors.push("review approval receipt expires_at is not current");
    }
    if (expiresAt - disposedAt > 300_000) {
      errors.push("review approval receipt freshness window is too long");
    }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    errors.push("review approval receipt signature encoding is invalid");
  } else if (payload) {
    try {
      if (!verifySignature(null, Buffer.from(payload, "utf8"), expected.trustedHostPublicKey, Buffer.from(signature, "base64url"))) {
        errors.push("review approval receipt signature is not from the trusted host");
      }
    } catch {
      errors.push("review approval receipt signature verification failed");
    }
  }
  try {
    if (personalReviewApprovalReplayStatus(receipt, expected.consumedReceiptDigests, expected.replayNonceKey) === "conflicting_replay") {
      errors.push("review approval receipt nonce was replayed with changed content");
    }
  } catch (error) {
    errors.push((error as Error).message);
  }
  return errors;
}

export function personalReviewDispositionLifecycle(disposition: PersonalReviewDisposition): "terminal" | "pending" {
  if (["accept", "correct", "reject"].includes(disposition)) return "terminal";
  if (disposition === "defer") return "pending";
  throw new TypeError("review disposition is invalid");
}

export interface PersonalReviewRetentionProjection {
  excerpt: "retained" | "expired" | "purged";
  metadata: "retained" | "expired" | "purged";
}

export function projectPersonalReviewRetention(disposition: PersonalReviewDisposition, ageDays: number, purgeRequested = false): PersonalReviewRetentionProjection {
  if (!Number.isFinite(ageDays) || ageDays < 0) throw new TypeError("review age must be non-negative");
  if (purgeRequested) return { excerpt: "purged", metadata: "purged" };
  if (personalReviewDispositionLifecycle(disposition) === "pending") {
    return {
      excerpt: ageDays >= 30 ? "expired" : "retained",
      metadata: "retained",
    };
  }
  return {
    excerpt: "purged",
    metadata: ageDays >= 90 ? "expired" : "retained",
  };
}

/** Validate the authority-owned private review-record persistence and read contract. */
export function validatePersonalGlossaryReviewRecordsAuthority(authority: Mapping): string[] {
  const mining = mapping(authority.personal_mining_authority);
  const records = mapping(mining?.review_records);
  const persistence = mapping(records?.persistence);
  const compatibility = mapping(persistence?.compatibility);
  const queue = mapping(records?.queue);
  const queueCommand = mapping(queue?.command);
  const request = mapping(queue?.request);
  const queueResult = mapping(queue?.result);
  const disposition = mapping(records?.disposition);
  const dispositionCommand = mapping(disposition?.command);
  const dispositionRequest = mapping(disposition?.request);
  const dispositionResult = mapping(disposition?.result);
  const publicationAuthorization = mapping(disposition?.publication_authorization);
  const trustedHostKey = mapping(records?.trusted_host_key);
  const retrieval = mapping(records?.retrieval);
  const retrievalCommand = mapping(retrieval?.command);
  const list = mapping(retrieval?.list);
  const filters = mapping(list?.filters);
  const cursor = mapping(list?.cursor);
  const exact = mapping(retrieval?.exact);
  const maintenance = mapping(records?.maintenance);

  if (
    records?.status !== "active" ||
    records?.owner !== "user_local_review_lifecycle" ||
    records?.runtime !== "packages/cli/src/analytics/personalGlossaryReviewRecords.ts#queuePersonalGlossaryReviewRecord" ||
    records?.input !== "current_validated_review_required_cli_decision_and_host_receipt" ||
    persistence?.root !== "$AGENTERA_PROFILE_DIR/intermediate/personal-glossary" ||
    persistence?.file !== "review-records.json" ||
    persistence?.schema_version !== "agentera.personalGlossaryReviewStore.v2" ||
    persistence?.record_schema_version !== "agentera.personalGlossaryReviewRecord.v2" ||
    persistence?.owner !== "current_user" ||
    !sameStrings(persistence?.fields, ["schema_version", "owner", "records", "replay_index", "store_sha256"]) ||
    !sameStrings(persistence?.record_fields, [
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
      "scope",
      "reason",
      "status",
      "disposition",
      "review_record",
      "reopen_reason",
      "queued_at",
      "terminal_at",
      "expires_at",
      "record_sha256",
    ]) ||
    persistence?.records_max !== 100 ||
    !sameStrings(persistence?.replay_index_fields, ["nonce_sha256", "receipt_sha256", "expires_at"]) ||
    persistence?.replay_entries_max !== 100 ||
    persistence?.record_max_serialized_utf8_bytes !== 8_192 ||
    persistence?.max_serialized_utf8_bytes !== 1_048_576 ||
    persistence?.canonicalization !== "candidate_contracts.canonicalization" ||
    persistence?.order !== "review_id_asc" ||
    persistence?.replay !== "exact_current_binding_is_unchanged_replay_and_exact_receipt_is_idempotent" ||
    persistence?.conflict !== "changed_receipt_nonce_binding_or_signature_fails_before_effects" ||
    !sameStrings(compatibility?.accepted_store_schema_versions, ["agentera.personalGlossaryReviewStore.v1", "agentera.personalGlossaryReviewStore.v2"]) ||
    !sameStrings(compatibility?.accepted_record_schema_versions, ["agentera.personalGlossaryPendingReviewRecord.v1", "agentera.personalGlossaryReviewRecord.v2"]) ||
    compatibility?.read_mutation !== "forbidden" ||
    compatibility?.migration_operation !== "disposition_only" ||
    compatibility?.scope_derivation !== "current_validated_host_receipt_only" ||
    compatibility?.invalid_behavior !== "fail_before_effects" ||
    !sameStrings(compatibility?.preserved_bindings, ["review_id", "candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "reason"]) ||
    compatibility?.legacy_digest !== "validate_before_migration" ||
    compatibility?.migrated_digest !== "reseal_v2_lifecycle_record" ||
    !nonEmpty(compatibility?.rule) ||
    !sameStrings(persistence?.suppression_binding, ["candidate_id", "semantic_fingerprint", "scope", "policy_version"]) ||
    !sameStrings(persistence?.suppression_dispositions, ["reject", "defer"]) ||
    !sameStrings(persistence?.reopen_reasons, ["policy_changed", "scope_changed", "meaning_changed"]) ||
    persistence?.project_storage !== "forbidden" ||
    !sameStrings(persistence?.forbidden_fields, ["term", "meaning", "excerpt", "raw_evidence", "source_id", "evidence_anchor", "session_id", "project_id", "source_path", "tool_content", "review_approval", "signature", "nonce"]) ||
    !nonEmpty(persistence?.rule) ||
    trustedHostKey?.root !== "$AGENTERA_PROFILE_DIR/intermediate/personal-glossary" ||
    trustedHostKey?.file !== "trusted-local-host.json" ||
    trustedHostKey?.schema_version !== "agentera.personalGlossaryTrustedLocalHost.v1" ||
    !sameStrings(trustedHostKey?.fields, ["schema_version", "owner", "subject", "public_key_spki_base64url"]) ||
    trustedHostKey?.owner !== "current_user" ||
    trustedHostKey?.public_key_algorithm !== "ed25519" ||
    trustedHostKey?.max_serialized_utf8_bytes !== 4_096 ||
    !nonEmpty(trustedHostKey?.rule) ||
    queueCommand?.canonical !== "npx -y agentera@next report personal-glossary-reviews" ||
    queueCommand?.namespace !== "report" ||
    queueCommand?.input_flag !== "--input" ||
    queueCommand?.stdin_value !== "-" ||
    queueCommand?.format !== "json" ||
    queueCommand?.project_checkout !== "not_required" ||
    request?.schema_version !== "agentera.personalGlossaryReviewQueueRequest.v1" ||
    !sameStrings(request?.required_fields, ["schema_version", "receipt"]) ||
    request?.additional_fields !== "forbidden" ||
    request?.max_utf8_bytes !== 16_384 ||
    queue?.decision_outcome !== "review_required" ||
    !sameStrings(queue?.current_bindings, ["candidate_id", "candidate_revision", "candidate_capsule_sha256", "candidate_projection_sha256", "host_receipt_sha256", "cli_decision_sha256", "semantic_fingerprint", "generation", "policy_version", "reason"]) ||
    queueResult?.schema_version !== "agentera.personalGlossaryReviewQueueResult.v1" ||
    !sameStrings(queueResult?.statuses, ["queued", "unchanged_replay", "suppressed", "reopened"]) ||
    queueResult?.max_utf8_bytes !== 4_096 ||
    queue?.no_question_channel !== "queue_without_prompt_or_disposition" ||
    !nonEmpty(queue?.rule) ||
    dispositionCommand?.canonical !== "npx -y agentera@next report personal-glossary-reviews" ||
    dispositionCommand?.namespace !== "report" ||
    dispositionCommand?.input_flag !== "--input" ||
    dispositionCommand?.stdin_value !== "-" ||
    dispositionCommand?.format !== "json" ||
    dispositionCommand?.project_checkout !== "not_required" ||
    dispositionRequest?.schema_version !== "agentera.personalGlossaryReviewDispositionRequest.v1" ||
    !sameStrings(dispositionRequest?.required_fields, ["schema_version", "review_id", "receipt", "approval"]) ||
    dispositionRequest?.additional_fields !== "forbidden" ||
    dispositionRequest?.max_utf8_bytes !== 16_384 ||
    dispositionResult?.schema_version !== "agentera.personalGlossaryReviewDispositionResult.v1" ||
    !sameStrings(dispositionResult?.statuses, ["disposed", "unchanged_replay"]) ||
    dispositionResult?.max_utf8_bytes !== 4_096 ||
    !sameStrings(publicationAuthorization?.dispositions, ["accept", "correct"]) ||
    !sameStrings(publicationAuthorization?.fields, ["review_id", "review_record_sha256"]) ||
    !nonEmpty(disposition?.rule) ||
    retrievalCommand?.canonical !== "npx -y agentera@next report personal-glossary-reviews" ||
    retrievalCommand?.namespace !== "report" ||
    retrievalCommand?.format !== "json" ||
    retrievalCommand?.project_checkout !== "not_required" ||
    retrieval?.owner !== "current_user" ||
    retrieval?.schema_version !== "agentera.personalGlossaryReviewRetrieval.v1" ||
    list?.default_limit !== 20 ||
    list?.maximum_limit !== 50 ||
    list?.max_serialized_utf8_bytes !== 32_768 ||
    list?.order !== "queued_at_desc_then_review_id_asc" ||
    !sameStrings(filters?.status, ["pending", "terminal"]) ||
    cursor?.authority !== "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor" ||
    cursor?.vocabulary !== "opaque_snapshot_cursor" ||
    !sameStrings(cursor?.binding, ["collection", "owner", "filters", "limit", "order", "snapshot"]) ||
    cursor?.invalid_behavior !== "cursor_invalid" ||
    cursor?.unavailable_behavior !== "cursor_snapshot_unavailable" ||
    !nonEmpty(list?.summaries) ||
    !sameStrings(exact?.required_bindings, ["review_id", "candidate_id", "candidate_revision", "generation", "policy_version"]) ||
    exact?.current_binding_field !== "candidate_projection_sha256" ||
    exact?.max_serialized_utf8_bytes !== 8_192 ||
    !nonEmpty(exact?.rule) ||
    !nonEmpty(retrieval?.rule) ||
    maintenance?.entrypoint !== "packages/cli/src/analytics/personalGlossaryReviewRecords.ts#maintainPersonalGlossaryReviewRecords" ||
    maintenance?.exposure !== "authenticated_review_owner_only" ||
    maintenance?.terminal_metadata_days !== 90 ||
    maintenance?.pending_metadata !== "retained_until_terminal_or_purge" ||
    maintenance?.cache !== "replay_index_until_receipt_expiry" ||
    maintenance?.purge !== "current_user_authorized_review_records_only" ||
    !sameStrings(maintenance?.forbidden_effects, ["profile_entry", "project_state", "candidate_projection", "publication"]) ||
    !nonEmpty(maintenance?.rule)
  ) {
    return ["personal_mining_authority review records must remain bounded, current-user local, privacy-safe, replay-safe, and independently retained"];
  }
  return [];
}
