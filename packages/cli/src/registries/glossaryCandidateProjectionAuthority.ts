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

/** Validate the authority-owned bounds for the internal candidate projection. */
export function validatePersonalCandidateProjectionAuthority(authority: Mapping): string[] {
  const mining = mapping(authority.personal_mining_authority);
  const projection = mapping(mining?.candidate_projection);
  const selection = mapping(projection?.selection);
  const sourceFamilies = mapping(selection?.source_families);
  const projectIdentity = mapping(selection?.project_identity);
  const excerpts = mapping(projection?.excerpts);
  const excerptCompatibility = mapping(excerpts?.compatibility);
  const retention = mapping(projection?.retention);
  const persistence = mapping(projection?.persistence);
  const retrieval = mapping(mining?.candidate_retrieval);
  const retrievalCommand = mapping(retrieval?.command);
  const list = mapping(retrieval?.list);
  const filters = mapping(list?.filters);
  const cursor = mapping(list?.cursor);
  const safeContextView = mapping(retrieval?.safe_context_view);
  const exact = mapping(retrieval?.exact);
  const occurrence = mapping(exact?.occurrence);
  const privacy = mapping(mining?.privacy);
  const contentExclusion = mapping(privacy?.content_exclusion);
  const storageFilesystem = mapping(mapping(privacy?.storage)?.filesystem);
  if (
    projection?.status !== "active" ||
    projection?.runtime !==
      "packages/cli/src/analytics/personalGlossaryCandidateProjection.ts#projectPersonalGlossaryCandidates" ||
    projection?.schema_version !== "agentera.personalGlossaryCandidateProjection.v1" ||
    projection?.owner !== "deterministic_discovery_projection" ||
    !nonEmpty(projection?.input) ||
    !nonEmpty(projection?.output) ||
    !nonEmpty(projection?.implementation_boundary) ||
    selection?.candidates_max !== 50 ||
    selection?.project_ids_max_per_candidate !== 100 ||
    !sameStrings(Object.keys(sourceFamilies ?? {}), ["explicit", "recurring"]) ||
    !sameStrings(sourceFamilies?.explicit, ["personal_explicit_definition"]) ||
    !sameStrings(sourceFamilies?.recurring, [
      "personal_inferred_usage",
      "personal_inferred_conversation",
    ]) ||
    selection?.algorithm !== "least_retained_source_family_then_project_then_canonical_candidate" ||
    selection?.tie_break !== "candidate_id_then_candidate_revision_then_capsule_sha256" ||
    projectIdentity?.schema_version !== "agentera.personalGlossaryProjectionProjectIdentity.v1" ||
    projectIdentity?.algorithm !== "sha256" ||
    projectIdentity?.input !== "canonical_utf8_json_of_exact_transient_project_id" ||
    projectIdentity?.output !== "lowercase_hex" ||
    !nonEmpty(projectIdentity?.rule) ||
    !nonEmpty(selection?.coverage) ||
    excerpts?.source_max_utf8_bytes !== 4096 ||
    excerpts?.max_per_candidate !== 1 ||
    excerpts?.authority !== "personal_mining_authority.privacy.excerpts" ||
    excerpts?.input_rule !== "candidate_adjacent_text_must_contain_the_exact_candidate_term" ||
    !sameStrings(excerpts?.output_fields, ["text", "expires_at", "redacted"]) ||
    excerptCompatibility?.redacted_field !== "retained_for_v1_consumers" ||
    excerptCompatibility?.new_projection_value !== false ||
    !sameStrings(excerpts?.omission_reasons, [
      "no_excerpt",
      "unrelated_context",
      "source_bound_exceeded",
      "unsafe_tool_arguments",
      "unsafe_content",
    ]) ||
    !nonEmpty(excerpts?.rule) ||
    retention?.authority !== "personal_mining_authority.privacy.retention" ||
    retention?.purge !== "personal_mining_authority.privacy.purge" ||
    !nonEmpty(retention?.rule) ||
    persistence?.root !== "$AGENTERA_PROFILE_DIR/intermediate/personal-glossary" ||
    persistence?.file !== "candidate-projection.json" ||
    persistence?.canonicalization !== "candidate_contracts.canonicalization" ||
    !sameStrings(persistence?.fields, [
      "schema_version",
      "owner",
      "generation",
      "policy_version",
      "retained_at",
      "candidates",
      "report",
      "projection_sha256",
    ]) ||
    persistence?.replay !== "byte_identical_projection_is_unchanged_replay" ||
    persistence?.project_storage !== "forbidden" ||
    persistence?.public_reads !== "forbidden" ||
    !sameStrings(persistence?.private_machine_reads, ["candidate_retrieval", "cli_decision"]) ||
    persistence?.review_disposition_writes !== "forbidden" ||
    retrieval?.status !== "active" ||
    retrieval?.owner !== "private_user_local_candidate_retrieval" ||
    retrieval?.runtime !==
      "packages/cli/src/cli/commands/personalGlossaryCandidateReads.ts#runPersonalGlossaryCandidateReadsCommand" ||
    !nonEmpty(retrieval?.input) ||
    !nonEmpty(retrieval?.rule) ||
    retrievalCommand?.canonical !==
      "npx -y agentera@next report personal-glossary-candidates" ||
    retrievalCommand?.namespace !== "report" ||
    retrievalCommand?.format !== "json" ||
    retrievalCommand?.project_checkout !== "not_required" ||
    list?.schema_version !== "agentera.personalGlossaryCandidateRetrieval.v1" ||
    list?.default_limit !== 20 ||
    list?.maximum_limit !== 50 ||
    list?.max_serialized_utf8_bytes !== 32768 ||
    list?.order !== "candidate_id_then_candidate_revision_then_capsule_sha256" ||
    list?.projection_binding_field !== "candidate_projection_sha256" ||
    !sameStrings(filters?.source_family, ["explicit", "recurring"]) ||
    filters?.provenance_kind_from !== "candidate_projection.selection.source_families" ||
    !sameStrings(filters?.scope, ["personal", "ambiguous"]) ||
    cursor?.authority !==
      "references/artifacts/state-storage-authority.yaml#entity_target.public_retrieval.policy.cursor" ||
    cursor?.vocabulary !== "opaque_snapshot_cursor" ||
    !sameStrings(cursor?.binding, [
      "collection",
      "generation",
      "policy_version",
      "filters",
      "limit",
      "order",
      "snapshot",
    ]) ||
    cursor?.invalid_behavior !== "cursor_invalid" ||
    cursor?.unavailable_behavior !== "cursor_snapshot_unavailable" ||
    !nonEmpty(list?.summaries) ||
    !nonEmpty(list?.abstentions) ||
    !nonEmpty(list?.coverage) ||
    safeContextView?.authority !== "personal_mining_authority.privacy.retention" ||
    safeContextView?.retention_days !== 30 ||
    safeContextView?.expiry !== "expires_at_lte_read_time_is_unavailable" ||
    safeContextView?.mutation !== "forbidden" ||
    safeContextView?.snapshot !== "effective_availability_bound_to_opaque_cursor_snapshot" ||
    !nonEmpty(safeContextView?.rule) ||
    exact?.schema_version !== "agentera.personalGlossaryCandidateRetrieval.v1" ||
    !sameStrings(exact?.required_bindings, [
      "candidate_id",
      "candidate_revision",
      "generation",
      "policy_version",
    ]) ||
    exact?.projection_binding_field !== "candidate_projection_sha256" ||
    exact?.occurrences_max !== 100 ||
    exact?.safe_context_max_utf8_bytes !== 500 ||
    exact?.max_serialized_utf8_bytes !== 32768 ||
    occurrence?.schema_version !== "agentera.personalGlossaryCandidateOccurrence.v1" ||
    occurrence?.identity !== "opaque_sha256_of_validated_evidence_and_candidate_binding" ||
    !sameStrings(occurrence?.allowed_fields, [
      "occurrence_id",
      "source_kind",
      "signal_type",
      "author_class",
    ]) ||
    !nonEmpty(exact?.rule) ||
    contentExclusion?.owner !== "glossary_content_policy" ||
    contentExclusion?.classification !== "actual_secret_or_sensitive_value" ||
    contentExclusion?.conceptual_terminology !== "eligible" ||
    !sameStrings(contentExclusion?.candidate_fields, ["term", "meaning"]) ||
    contentExclusion?.candidate_action !== "reject_before_projection" ||
    contentExclusion?.candidate_reason !== "secret_content" ||
    contentExclusion?.excerpt_action !== "omit_complete_excerpt_before_projection" ||
    !sameStrings(contentExclusion?.secret_classes, [
      "api_keys",
      "access_tokens",
      "passwords",
      "cookies",
      "private_keys",
      "authorization_headers",
      "personal_contact_data",
      "session_identifiers",
      "runtime_store_paths",
    ]) ||
    !nonEmpty(contentExclusion?.rule) ||
    storageFilesystem?.authority !== "host_filesystem" ||
    storageFilesystem?.configured_path !== "use_as_provided" ||
    storageFilesystem?.outcomes !== "ordinary_permissions_and_io" ||
    storageFilesystem?.same_user_path_manipulation !== "outside_agentera_threat_model" ||
    storageFilesystem?.symlink_confinement !== "not_claimed" ||
    !nonEmpty(storageFilesystem?.rule) ||
    !nonEmpty(persistence?.rule)
  ) {
    return [
      "personal_mining_authority candidate projection must bound deterministic allocation, private retrieval, content exclusion, safe excerpts, host-filesystem storage, retention, and user-local replay",
    ];
  }
  return [];
}
