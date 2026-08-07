import type {
  GlossaryAdmissionContext,
} from "./glossaryEntryContract.js";

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

function isLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function validatePersonalMiningAuthority(authority: Mapping): string[] {
  const errors: string[] = [];
  const mining = mapping(authority.personal_mining_authority);
  const replacement = mapping(mining?.replacement);
  if (
    mining?.status !== "authority_only" ||
    !nonEmpty(mining?.implementation_boundary) ||
    !sameStrings(mining?.preserved_decisions, ["prmnztjytv", "mcsmqqitnm", "zyvgyvjnsv"]) ||
    replacement?.shared_primitive !== "shared_primitive" ||
    replacement?.personal_owner !== "ownership_contracts.personal" ||
    replacement?.project_owner !== "ownership_contracts.project" ||
    replacement?.consumer_precedence !== "consumer_boundary.primary_selection" ||
    replacement?.project_publication !== "ownership_contracts.project.publication" ||
    !sameStrings(replacement?.allowed_effects, ["personal_profile_output"]) ||
    !sameStrings(replacement?.forbidden_effects, [
      "project_glossary_read",
      "project_glossary_mutation",
      "project_publication_replacement",
      "consumer_precedence_change",
      "personal_project_merge",
    ]) ||
    !nonEmpty(replacement?.rule)
  ) {
    errors.push(
      "personal_mining_authority replacement must preserve shared primitive, isolation, consumer precedence, and Build project publication",
    );
  }

  const termIdentity = mapping(mining?.term_identity);
  const equality = mapping(termIdentity?.equality);
  const stable = mapping(termIdentity?.stable_term_identity);
  const revision = mapping(termIdentity?.candidate_revision);
  if (
    equality?.runtime !==
      "packages/cli/src/registries/glossaryTermIdentity.ts#unicodeCaselessExact" ||
    equality?.semantics !== "unicode_caseless_exact_no_normalization" ||
    !nonEmpty(equality?.rule) ||
    stable?.schema_version !== "agentera.personalGlossaryTermIdentity.v1" ||
    stable?.runtime !==
      "packages/cli/src/registries/glossaryTermIdentity.ts#stableGlossaryTermIdentity" ||
    stable?.algorithm !== "sha256" ||
    stable?.encoding !== "lowercase_hex" ||
    stable?.canonical_input !== "ecmascript_simple_case_fold_closure_key" ||
    stable?.no_unicode_normalization !== true ||
    !nonEmpty(stable?.key_rule) ||
    !nonEmpty(stable?.invariant) ||
    revision?.schema_version !== "agentera.personalGlossaryCandidateRevision.v1" ||
    revision?.runtime !==
      "packages/cli/src/registries/glossaryTermIdentity.ts#glossaryCandidateRevision" ||
    revision?.algorithm !== "sha256" ||
    revision?.encoding !== "lowercase_hex" ||
    !sameStrings(revision?.bound_fields, [
      "stable_term_identity",
      "meaning",
      "scope",
      "evidence",
      "policy_version",
      "generation",
    ]) ||
    revision?.policy_version !== "agentera.personalGlossaryMiningPolicy.v1" ||
    revision?.generation !== "content_addressed_candidate_projection_generation" ||
    revision?.evidence !== "complete_source_id_anchor_identity_set" ||
    !nonEmpty(revision?.canonicalization) ||
    !nonEmpty(revision?.replay_rule)
  ) {
    errors.push(
      "personal_mining_authority term identity must preserve Unicode caseless-exact no-normalization semantics and stable identity runtime",
    );
  }

  const provenance = mapping(mining?.provenance);
  const evolution = mapping(provenance?.evolution);
  const provenanceVariants = mapping(authority.provenance_variants);
  const conversationVariant = mapping(provenanceVariants?.personal_inferred_conversation);
  const distinctness = mapping(conversationVariant?.distinctness);
  if (
    provenance?.existing_inferred_variant !== "provenance_variants.personal_inferred_usage" ||
    provenance?.conversation_variant !==
      "provenance_variants.personal_inferred_conversation" ||
    evolution?.status !== "explicit_append_only_extension" ||
    evolution?.shared_primitive !== "unchanged" ||
    !nonEmpty(evolution?.existing_variant_rule) ||
    !nonEmpty(evolution?.conversation_rule) ||
    !nonEmpty(evolution?.audit_rule) ||
    conversationVariant?.evidence_count !== "variable" ||
    conversationVariant?.minimum_evidence_count !== 3 ||
    !sameStrings(conversationVariant?.required_evidence_fields, [
      "source_id",
      "evidence_anchor",
      "source_kind",
      "signal_type",
      "session_id",
      "project_id",
      "content_fingerprint",
      "author_class",
    ]) ||
    conversationVariant?.additional_evidence_fields !== "forbidden" ||
    !sameStrings(conversationVariant?.allowed_signal_types, [
      "correction",
      "decision",
      "question",
      "instruction",
      "configuration",
    ]) ||
    !sameStrings(conversationVariant?.allowed_source_kinds, ["conversation_turn"]) ||
    !sameStrings(conversationVariant?.allowed_author_classes, ["user"]) ||
    distinctness?.source_ids !== 3 ||
    distinctness?.evidence_anchors !== 3 ||
    distinctness?.session_ids !== 2 ||
    distinctness?.project_ids !== 2 ||
    distinctness?.content_fingerprints !== 3 ||
    conversationVariant?.completeness_field !== "provenance.evidence_complete" ||
    conversationVariant?.completeness_value !== true ||
    conversationVariant?.admission !== "review_only"
  ) {
    errors.push(
      "personal_mining_authority provenance must append explicit complete conversation evidence without altering the two-record variant",
    );
  }

  const consent = mapping(mining?.consent_lifecycle);
  const consentStates = mapping(consent?.states);
  const present = mapping(consentStates?.present);
  const absent = mapping(consentStates?.absent);
  const stale = mapping(consentStates?.stale);
  const degraded = mapping(consentStates?.degraded);
  const recovery = mapping(consent?.recovery);
  if (
    consent?.authority !== "references/analysis/evidence-tier-authority.yaml" ||
    consent?.operation !== "Profile_Full" ||
    consent?.policy !== "reuse_existing_generation" ||
    consent?.refresh !== "forbidden_during_profile_full" ||
    !nonEmpty(consent?.reuse) ||
    present?.condition !== "valid_local_history_consent_and_current_complete_generation" ||
    present?.action !== "reuse_generation_once_for_bounded_mining" ||
    present?.result !== "mining_authorized" ||
    absent?.condition !== "no_valid_local_history_consent_or_no_generation" ||
    absent?.action !== "skip_mining_without_read_or_refresh" ||
    absent?.result !== "degraded_consent_required" ||
    stale?.condition !== "consent_or_generation_binding_does_not_match_the_current_generation" ||
    stale?.action !== "reject_generation_for_new_mining_and_preserve_existing_entries" ||
    stale?.result !== "degraded_refresh_required" ||
    degraded?.condition !== "current_generation_is_readable_but_coverage_is_flagged_or_bounded" ||
    degraded?.action !== "reuse_only_as_degraded_evidence_without_automatic_admission" ||
    degraded?.result !== "degraded_coverage" ||
    recovery?.command !== "npx -y agentera@next stats refresh --consent local-history" ||
    recovery?.explicit_consent !== "required" ||
    recovery?.after_refresh !== "retry_profile_full_with_the_new_generation" ||
    !sameStrings(recovery?.forbidden, [
      "live_extraction_without_consent",
      "silent_refresh",
      "stale_generation_reuse",
    ]) ||
    !nonEmpty(recovery?.rule)
  ) {
    errors.push(
      "personal_mining_authority consent lifecycle must reuse existing generations and define present, absent, stale, and degraded recovery",
    );
  }

  const privacy = mapping(mining?.privacy);
  const storage = mapping(privacy?.storage);
  const excerpts = mapping(privacy?.excerpts);
  const redaction = mapping(excerpts?.redaction);
  const reviews = mapping(privacy?.reviews);
  const authentication = mapping(reviews?.authentication);
  const retention = mapping(privacy?.retention);
  const purge = mapping(privacy?.purge);
  if (
    privacy?.owner !== "current_user" ||
    privacy?.scope !== "user_local" ||
    storage?.root !== "$AGENTERA_PROFILE_DIR/intermediate/personal-glossary" ||
    storage?.project_storage !== "forbidden" ||
    !sameStrings(storage?.records, ["candidate_metadata", "safe_excerpts", "review_dispositions"]) ||
    storage?.project_state !== "unchanged" ||
    !nonEmpty(storage?.rule) ||
    excerpts?.purpose !== "bounded_review_context_only" ||
    excerpts?.max_utf8_bytes !== 500 ||
    redaction?.before_persistence !== true ||
    redaction?.replacement !== "[REDACTED]" ||
    !sameStrings(redaction?.secret_classes, [
      "api_keys",
      "access_tokens",
      "passwords",
      "cookies",
      "private_keys",
      "authorization_headers",
      "personal_contact_data",
    ]) ||
    !nonEmpty(redaction?.rule) ||
    !sameStrings(excerpts?.forbidden_content, [
      "raw_transcript",
      "raw_tool_arguments",
      "raw_runtime_store_paths",
      "raw_session_identifiers",
      "unredacted_secret",
      "unrelated_conversation",
    ]) ||
    excerpts?.failure !== "reject_before_persistence" ||
    reviews?.owner !== "current_user" ||
    !sameStrings(reviews?.required_fields, [
      "candidate_id",
      "candidate_revision",
      "generation",
      "disposition",
      "disposed_at",
    ]) ||
    !sameStrings(reviews?.dispositions, ["accept", "correct", "reject", "defer"]) ||
    reviews?.trusted_disposition_authority !== "current_user" ||
    !nonEmpty(authentication?.proof) ||
    !sameStrings(authentication?.binding_fields, [
      "candidate_id",
      "candidate_revision",
      "generation",
      "disposition",
      "disposed_at",
    ]) ||
    !sameStrings(authentication?.forbidden_principals, [
      "agent",
      "model",
      "imported_record",
      "generic_consent",
    ]) ||
    retention?.pending_excerpt_days !== 30 ||
    retention?.terminal_excerpt_days !== 0 ||
    retention?.review_metadata_days_after_terminal !== 90 ||
    retention?.accepted_entry !== "ownership_contracts.personal.retention_and_decay" ||
    !nonEmpty(retention?.rule) ||
    purge?.authority !== "current_user" ||
    purge?.trigger !== "explicit_authenticated_user_request_or_retention_expiry" ||
    !sameStrings(purge?.removes, ["candidate_metadata", "safe_excerpts", "review_dispositions"]) ||
    purge?.behavior !== "atomic_remove_user_local_records_before_next_read" ||
    purge?.project_state !== "untouched" ||
    purge?.profile_entry !== "not_implicitly_deleted" ||
    !nonEmpty(purge?.recovery)
  ) {
    errors.push(
      "personal_mining_authority privacy must be user-local, redacted, authenticated, retained, and purgeable",
    );
  }

  const admission = mapping(mining?.admission);
  if (
    admission?.inferred_automatic_admission !== "disabled" ||
    admission?.inferred_review !== "allowed" ||
    admission?.quality_threshold !== "deferred_to_bcpkchatfu_task_ekgowckdus" ||
    admission?.holdout !== "deferred_to_bcpkchatfu_task_ekgowckdus" ||
    !nonEmpty(admission?.rule)
  ) {
    errors.push(
      "personal_mining_authority must keep inferred automatic admission disabled and defer quality authority",
    );
  }
  return errors;
}

export function validateProvenanceVariants(variants: Mapping | null): string[] {
  const errors: string[] = [];
  const expectations: Record<string, Mapping> = {
    personal_explicit_definition: {
      owner: "personal",
      evidence_count: 1,
      required_evidence_fields: ["source_id", "evidence_anchor", "signal_type"],
      allowed_signal_types: ["correction", "decision", "instruction"],
    },
    personal_inferred_usage: {
      owner: "personal",
      evidence_count: 2,
      required_evidence_fields: ["source_id", "evidence_anchor", "source_kind"],
      allowed_source_kinds: ["instruction_document", "project_config_signal"],
    },
    personal_inferred_conversation: {
      owner: "personal",
      evidence_count: "variable",
      minimum_evidence_count: 3,
      required_evidence_fields: [
        "source_id",
        "evidence_anchor",
        "source_kind",
        "signal_type",
        "session_id",
        "project_id",
        "content_fingerprint",
        "author_class",
      ],
      allowed_signal_types: ["correction", "decision", "question", "instruction", "configuration"],
      allowed_source_kinds: ["conversation_turn"],
      allowed_author_classes: ["user"],
    },
    project_file: {
      owner: "project",
      evidence_count: 1,
      required_evidence_fields: ["source_path", "source_record_sha256"],
    },
  };
  for (const [kind, expected] of Object.entries(expectations)) {
    const variant = mapping(variants?.[kind]);
    if (!variant) {
      errors.push(`provenance variant ${kind} is required`);
      continue;
    }
    if (variant.owner !== expected.owner) errors.push(`${kind}.owner must be ${expected.owner}`);
    if (variant.evidence_count !== expected.evidence_count) {
      errors.push(`${kind}.evidence_count must be ${expected.evidence_count}`);
    }
    if (
      "minimum_evidence_count" in expected &&
      variant.minimum_evidence_count !== expected.minimum_evidence_count
    ) {
      errors.push(`${kind}.minimum_evidence_count must be ${expected.minimum_evidence_count}`);
    }
    if (!sameStrings(variant.required_evidence_fields, expected.required_evidence_fields as string[])) {
      errors.push(`${kind}.required_evidence_fields must match its provenance variant`);
    }
    if (variant.additional_evidence_fields !== "forbidden") {
      errors.push(`${kind}.additional_evidence_fields must be forbidden`);
    }
    for (const allowedField of [
      "allowed_signal_types",
      "allowed_source_kinds",
      "allowed_author_classes",
    ]) {
      if (
        allowedField in expected &&
        !sameStrings(variant[allowedField], expected[allowedField] as string[])
      ) {
        errors.push(`${kind}.${allowedField} must preserve the admitted evidence classes`);
      }
    }
    if (!nonEmpty(variant.resolution_rule)) errors.push(`${kind}.resolution_rule is required`);
  }
  return errors;
}

export function validateHistoryEvidence(
  evidence: Mapping,
  context: GlossaryAdmissionContext,
  index: number,
): string[] {
  const errors: string[] = [];
  const sourceId = typeof evidence.source_id === "string" ? evidence.source_id : "";
  const anchor = typeof evidence.evidence_anchor === "string" ? evidence.evidence_anchor : "";
  const retained = context.retainedHistory.get(anchor);
  if (!sourceId || !anchor) {
    errors.push(`provenance.evidence[${index}] requires source_id and evidence_anchor`);
  }
  if (!retained || retained.sourceId !== sourceId) {
    errors.push(
      `provenance.evidence[${index}].evidence_anchor must resolve to its retained source_id`,
    );
  }
  return errors;
}

export function validateConversationProvenance(
  evidence: Array<Mapping | null>,
  provenance: Mapping | null,
  variant: Mapping,
  context: GlossaryAdmissionContext,
): string[] {
  const errors: string[] = [];
  const minimumEvidenceCount = Number(variant.minimum_evidence_count);
  if (evidence.length < minimumEvidenceCount || evidence.some((item) => item === null)) {
    errors.push("conversation inference requires at least three complete retained records");
    return errors;
  }
  if (provenance?.evidence_complete !== true) {
    errors.push("conversation inference requires complete provenance evidence");
  }
  for (const [index, item] of (evidence as Mapping[]).entries()) {
    errors.push(...validateHistoryEvidence(item, context, index));
    const retained = context.retainedHistory.get(String(item.evidence_anchor));
    if (
      !nonEmpty(item.source_kind) ||
      !nonEmpty(item.signal_type) ||
      !nonEmpty(item.session_id) ||
      !nonEmpty(item.project_id) ||
      !isLowerSha256(item.content_fingerprint) ||
      !nonEmpty(item.author_class) ||
      !retained ||
      item.source_kind !== retained.sourceKind ||
      item.signal_type !== retained.signalType ||
      item.session_id !== retained.sessionId ||
      item.project_id !== retained.projectId ||
      item.content_fingerprint !== retained.contentFingerprint ||
      item.author_class !== retained.authorClass ||
      !strings(variant.allowed_source_kinds).includes(String(item.source_kind)) ||
      !strings(variant.allowed_signal_types).includes(String(item.signal_type)) ||
      !strings(variant.allowed_author_classes).includes(String(item.author_class))
    ) {
      errors.push(`provenance.evidence[${index}] has inadmissible conversation provenance`);
    }
  }
  const sourceIds = evidence.map((item) => String(item?.source_id));
  const anchors = evidence.map((item) => String(item?.evidence_anchor));
  const sessions = evidence.map((item) => String(item?.session_id));
  const projects = evidence.map((item) => String(item?.project_id));
  const fingerprints = evidence.map((item) => String(item?.content_fingerprint));
  if (
    new Set(sourceIds).size < 3 ||
    new Set(anchors).size < 3 ||
    new Set(sessions).size < 2 ||
    new Set(projects).size < 2 ||
    new Set(fingerprints).size < 3
  ) {
    errors.push(
      "conversation inference requires distinct source identities, anchors, sessions, projects, and content fingerprints",
    );
  }
  return errors;
}
