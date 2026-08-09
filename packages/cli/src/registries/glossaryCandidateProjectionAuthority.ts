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
    persistence?.review_disposition_writes !== "forbidden" ||
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
      "personal_mining_authority candidate projection must bound deterministic allocation, content exclusion, safe excerpts, host-filesystem storage, retention, and user-local replay",
    ];
  }
  return [];
}
