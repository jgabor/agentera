type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
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

/** Validate the authority-owned private review-record persistence and read contract. */
export function validatePersonalGlossaryReviewRecordsAuthority(authority: Mapping): string[] {
  const mining = mapping(authority.personal_mining_authority);
  const records = mapping(mining?.review_records);
  const persistence = mapping(records?.persistence);
  const queue = mapping(records?.queue);
  const queueCommand = mapping(queue?.command);
  const request = mapping(queue?.request);
  const queueResult = mapping(queue?.result);
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
    records?.runtime !==
      "packages/cli/src/analytics/personalGlossaryReviewRecords.ts#queuePersonalGlossaryReviewRecord" ||
    records?.input !== "current_validated_review_required_cli_decision_and_host_receipt" ||
    persistence?.root !== "$AGENTERA_PROFILE_DIR/intermediate/personal-glossary" ||
    persistence?.file !== "review-records.json" ||
    persistence?.schema_version !== "agentera.personalGlossaryReviewStore.v1" ||
    persistence?.record_schema_version !== "agentera.personalGlossaryPendingReviewRecord.v1" ||
    persistence?.owner !== "current_user" ||
    !sameStrings(persistence?.fields, ["schema_version", "owner", "records", "store_sha256"]) ||
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
      "reason",
      "status",
      "queued_at",
      "terminal_at",
      "expires_at",
      "record_sha256",
    ]) ||
    persistence?.records_max !== 100 ||
    persistence?.record_max_serialized_utf8_bytes !== 2_048 ||
    persistence?.max_serialized_utf8_bytes !== 262_144 ||
    persistence?.canonicalization !== "candidate_contracts.canonicalization" ||
    persistence?.order !== "review_id_asc" ||
    persistence?.replay !== "exact_current_binding_is_unchanged_replay" ||
    persistence?.conflict !== "changed_binding_or_reason_creates_distinct_record" ||
    persistence?.project_storage !== "forbidden" ||
    !sameStrings(persistence?.forbidden_fields, [
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
    !nonEmpty(persistence?.rule) ||
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
    !sameStrings(queue?.current_bindings, [
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
    queueResult?.schema_version !== "agentera.personalGlossaryReviewQueueResult.v1" ||
    !sameStrings(queueResult?.statuses, ["queued", "unchanged_replay"]) ||
    queueResult?.max_utf8_bytes !== 4_096 ||
    queue?.no_question_channel !== "queue_without_prompt_or_disposition" ||
    !nonEmpty(queue?.rule) ||
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
    cursor?.authority !==
      "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor" ||
    cursor?.vocabulary !== "opaque_snapshot_cursor" ||
    !sameStrings(cursor?.binding, ["collection", "owner", "filters", "limit", "order", "snapshot"]) ||
    cursor?.invalid_behavior !== "cursor_invalid" ||
    cursor?.unavailable_behavior !== "cursor_snapshot_unavailable" ||
    !nonEmpty(list?.summaries) ||
    !sameStrings(exact?.required_bindings, [
      "review_id",
      "candidate_id",
      "candidate_revision",
      "generation",
      "policy_version",
    ]) ||
    exact?.current_binding_field !== "candidate_projection_sha256" ||
    exact?.max_serialized_utf8_bytes !== 8_192 ||
    !nonEmpty(exact?.rule) ||
    !nonEmpty(retrieval?.rule) ||
    maintenance?.entrypoint !==
      "packages/cli/src/analytics/personalGlossaryReviewRecords.ts#maintainPersonalGlossaryReviewRecords" ||
    maintenance?.exposure !== "authenticated_review_owner_only" ||
    maintenance?.terminal_metadata_days !== 90 ||
    maintenance?.pending_metadata !== "retained_until_terminal_or_purge" ||
    maintenance?.cache !== "none_excerpts_lack_review_record_persistence_authority" ||
    maintenance?.purge !== "current_user_authorized_review_records_only" ||
    !sameStrings(maintenance?.forbidden_effects, [
      "profile_entry",
      "project_state",
      "candidate_projection",
      "publication",
    ]) ||
    !nonEmpty(maintenance?.rule)
  ) {
    return [
      "personal_mining_authority review records must remain bounded, current-user local, privacy-safe, replay-safe, and independently retained",
    ];
  }
  return [];
}
