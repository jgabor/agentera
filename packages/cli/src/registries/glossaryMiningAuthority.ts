import { createHash, verify as verifySignature, type KeyLike } from "node:crypto";

import type {
  GlossaryAdmissionContext,
  GlossaryConversationEvidenceExpectation,
} from "./glossaryEntryContract.js";
import { validatePersonalCandidateProjectionAuthority } from "./glossaryCandidateProjectionAuthority.js";
import { validateExplicitSegmentGrammar } from "./explicitSegmentGrammarContract.js";

type Mapping = Record<string, unknown>;

export const PERSONAL_GLOSSARY_MINING_POLICY_VERSION = "agentera.personalGlossaryMiningPolicy.v1";

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

function compareUnicodeStrings(left: string, right: string): number {
  const leftScalars = [...left];
  const rightScalars = [...right];
  for (let index = 0; index < Math.min(leftScalars.length, rightScalars.length); index += 1) {
    const leftCodePoint = leftScalars[index]!.codePointAt(0)!;
    const rightCodePoint = rightScalars[index]!.codePointAt(0)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftScalars.length - rightScalars.length;
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function glossaryEvidenceSetDigest(generation: string, anchors: readonly string[]): string {
  if (!nonEmpty(generation)) throw new TypeError("generation must be a non-empty string");
  if (
    anchors.length === 0 ||
    anchors.some((anchor) => !nonEmpty(anchor)) ||
    new Set(anchors).size !== anchors.length
  ) {
    throw new TypeError("qualifying evidence anchors must be non-empty and unique");
  }
  return sha256Utf8(
    JSON.stringify({
      schema_version: "agentera.personalGlossaryEvidenceSet.v1",
      generation,
      anchors: [...anchors].sort(compareUnicodeStrings),
    }),
  );
}

export type PersonalMiningConsentState = "absent" | "stale" | "degraded" | "present";

export interface PersonalMiningConsentInput {
  consentStatus: "absent" | "valid" | "stale";
  generationStatus: "absent" | "current" | "stale";
  coverageStatus: "complete" | "cap_selected" | "truncated" | "flagged_incomplete";
  signalTierBounded: boolean;
}

/** Apply the contract-owned ordered consent discriminator without reading history. */
export function classifyPersonalMiningConsent(
  input: PersonalMiningConsentInput,
): PersonalMiningConsentState {
  if (
    !["absent", "valid", "stale"].includes(input.consentStatus) ||
    !["absent", "current", "stale"].includes(input.generationStatus) ||
    !["complete", "cap_selected", "truncated", "flagged_incomplete"].includes(
      input.coverageStatus,
    ) ||
    typeof input.signalTierBounded !== "boolean"
  ) {
    throw new TypeError("consent discriminator input is invalid");
  }
  if (input.consentStatus === "absent" || input.generationStatus === "absent") return "absent";
  if (input.consentStatus === "stale" || input.generationStatus === "stale") return "stale";
  if (input.coverageStatus !== "complete") return "degraded";
  return "present";
}

const REVIEW_RECEIPT_FIELDS = [
  "schema_version",
  "issuer",
  "subject",
  "trusted_channel",
  "candidate_id",
  "candidate_revision",
  "generation",
  "disposition",
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
  candidateId: string;
  candidateRevision: string;
  generation: string;
  now: Date;
  trustedHostPublicKey: KeyLike;
  consumedReceiptDigests?: ReadonlyMap<string, string>;
}

function receiptField(receipt: Mapping, field: string): string {
  const value = receipt[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`review approval receipt field ${field} must be a non-empty string`);
  }
  return value;
}

function signedReviewReceiptPayload(receipt: Mapping): string {
  return JSON.stringify(
    Object.fromEntries(
      REVIEW_RECEIPT_SIGNED_FIELDS.map((field) => [field, receiptField(receipt, field)]),
    ),
  );
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

export function personalReviewApprovalReplayStatus(
  receipt: Mapping,
  consumedReceiptDigests: ReadonlyMap<string, string> = new Map(),
): "new" | "exact_replay" | "conflicting_replay" {
  const nonce = receiptField(receipt, "nonce");
  const consumedDigest = consumedReceiptDigests.get(nonce);
  if (!consumedDigest) return "new";
  return consumedDigest === personalReviewApprovalReceiptDigest(receipt)
    ? "exact_replay"
    : "conflicting_replay";
}

export function validatePersonalReviewApprovalReceipt(
  receipt: Mapping,
  expected: PersonalReviewApprovalVerification,
): string[] {
  const errors: string[] = [];
  const extraFields = Object.keys(receipt).filter(
    (field) => !REVIEW_RECEIPT_FIELDS.includes(field as (typeof REVIEW_RECEIPT_FIELDS)[number]),
  );
  if (extraFields.length > 0)
    errors.push(`review approval receipt has forbidden fields: ${extraFields.join(", ")}`);
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
  if (receipt.subject !== expected.currentUserSubject || receipt.subject === "agent") {
    errors.push("review approval receipt subject is not the trusted current user");
  }
  if (receipt.trusted_channel !== "agentera-local-host-ipc") {
    errors.push("review approval receipt trusted channel is invalid");
  }
  if (receipt.candidate_id !== expected.candidateId) {
    errors.push("review approval receipt candidate binding is invalid");
  }
  if (receipt.candidate_revision !== expected.candidateRevision) {
    errors.push("review approval receipt revision binding is invalid");
  }
  if (receipt.generation !== expected.generation) {
    errors.push("review approval receipt generation binding is invalid");
  }
  if (!["accept", "correct", "reject", "defer"].includes(String(receipt.disposition))) {
    errors.push("review approval receipt disposition is invalid");
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
      if (
        !verifySignature(
          null,
          Buffer.from(payload, "utf8"),
          expected.trustedHostPublicKey,
          Buffer.from(signature, "base64url"),
        )
      ) {
        errors.push("review approval receipt signature is not from the trusted host");
      }
    } catch {
      errors.push("review approval receipt signature verification failed");
    }
  }
  try {
    if (
      personalReviewApprovalReplayStatus(receipt, expected.consumedReceiptDigests) ===
      "conflicting_replay"
    ) {
      errors.push("review approval receipt nonce was replayed with changed content");
    }
  } catch (error) {
    errors.push((error as Error).message);
  }
  return errors;
}

export function personalReviewDispositionLifecycle(
  disposition: PersonalReviewDisposition,
): "terminal" | "pending" {
  if (["accept", "correct", "reject"].includes(disposition)) return "terminal";
  if (disposition === "defer") return "pending";
  throw new TypeError("review disposition is invalid");
}

export interface PersonalReviewRetentionProjection {
  excerpt: "retained" | "expired" | "purged";
  metadata: "retained" | "expired" | "purged";
}

export function projectPersonalReviewRetention(
  disposition: PersonalReviewDisposition,
  ageDays: number,
  purgeRequested = false,
): PersonalReviewRetentionProjection {
  if (!Number.isFinite(ageDays) || ageDays < 0)
    throw new TypeError("review age must be non-negative");
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

export function validatePersonalMiningAuthority(authority: Mapping): string[] {
  const errors: string[] = [];
  const mining = mapping(authority.personal_mining_authority);
  const replacement = mapping(mining?.replacement);
  const explicitDiscovery = mapping(mining?.explicit_discovery);
  const explicitGrammar = mapping(explicitDiscovery?.grammar);
  const adjacentDirectReference = mapping(explicitDiscovery?.adjacent_direct_reference_exclusion);
  const adjacentDirectionalBinding = mapping(adjacentDirectReference?.binding);
  const explicitForms = Array.isArray(explicitGrammar?.forms)
    ? explicitGrammar.forms.map(mapping).filter((value): value is Mapping => value !== null)
    : [];
  const form = (id: string): Mapping => explicitForms.find((value) => value.id === id) ?? {};
  if (
    mining?.status !== "active_partial" ||
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
  if (
    explicitDiscovery?.status !== "active" ||
    explicitDiscovery?.runtime !==
      "packages/cli/src/analytics/personalGlossaryExplicit.ts#discoverExplicitGlossaryCues" ||
    explicitDiscovery?.mining_runtime !==
      "packages/cli/src/analytics/personalGlossaryExplicitMining.ts#mineExplicitGlossaryCandidates" ||
    explicitDiscovery?.input !== "bounded_signal_tier_plus_direct_single_anchor_resolution" ||
    explicitDiscovery?.output !== "evidence_capsule_plus_exact_source_spans_only" ||
    explicitDiscovery?.scope_window !== "current_sentence_and_one_adjacent_sentence_each_side" ||
    explicitDiscovery?.scope_binding !==
      "explicit_scope_marker_must_contain_the_term_or_be_a_direct_qualifier" ||
    explicitDiscovery?.span_encoding !== "utf8_byte_offsets" ||
    explicitDiscovery?.strings !== "preserve_exact_source_bytes_without_unicode_normalization" ||
    !sameStrings(adjacentDirectReference?.references, [
      "this_definition",
      "this_term",
      "this_meaning",
      "following_definition",
      "following_term",
      "following_meaning",
    ]) ||
    !sameStrings(adjacentDirectReference?.qualifiers, [
      "question",
      "example",
      "future",
      "hypothetical",
    ]) ||
    adjacentDirectionalBinding?.preceding_sentence !== "following_reference_only" ||
    adjacentDirectionalBinding?.following_sentence !== "this_reference_only" ||
    adjacentDirectionalBinding?.exact_literal_term !== "either_direction" ||
    !sameStrings(
      explicitForms.map((value) => String(value.id)),
      [
        "quoted_means",
        "definition_list_colon",
        "acronym_stands_for",
        "acronym_parenthetical",
        "by_i_mean",
        "use_for",
        "use_to_mean",
        "refers_to",
        "clarification_prefer_to_mean",
        "correction_means",
      ],
    ) ||
    form("quoted_means").syntax !== "quoted_or_code_delimited_term_means_meaning" ||
    form("definition_list_colon").syntax !== "standalone_safe_definition_list_term_colon_meaning" ||
    form("definition_list_colon").prefix !==
      "sentence_or_line_start_with_optional_markdown_list_bullet" ||
    !sameStrings(form("definition_list_colon").unmarked_terms, [
      "quoted_or_code_delimited_term",
      "uppercase_acronym_with_exact_expansion_initials",
    ]) ||
    !sameStrings(form("definition_list_colon").markers, ["definition", "term"]) ||
    form("definition_list_colon").marked_term !== "bounded_nonempty_term" ||
    form("definition_list_colon").bare_multiword_term_without_marker !== "reject" ||
    form("definition_list_colon").meaning_start !== "nonempty_same_physical_line" ||
    form("definition_list_colon").continuation !==
      "after_nonempty_inline_meaning_within_maximum_meaning_bound_only" ||
    form("definition_list_colon").empty_marker_structure !==
      "reject_immediately_following_colon_line" ||
    form("acronym_stands_for").syntax !== "bounded_acronym_stands_for_expansion" ||
    form("acronym_parenthetical").syntax !== "bounded_acronym_parenthesized_expansion_or_reverse" ||
    form("by_i_mean").syntax !== "by_term_i_mean_meaning" ||
    form("use_for").syntax !== "use_term_for_meaning" ||
    form("use_to_mean").syntax !== "use_term_to_mean_meaning" ||
    form("refers_to").syntax !== "term_refers_to_meaning" ||
    form("clarification_prefer_to_mean").syntax !== "to_clarify_i_prefer_term_to_mean_meaning" ||
    form("correction_means").syntax !==
      "approved_correction_prefix_quoted_or_code_term_means_meaning" ||
    form("acronym_stands_for").validation !== "expansion_initials_must_match_acronym_exactly" ||
    form("acronym_parenthetical").validation !== "expansion_initials_must_match_acronym_exactly" ||
    Number(mapping(explicitGrammar?.bounds)?.maximum_term_utf8_bytes) !== 256 ||
    Number(mapping(explicitGrammar?.bounds)?.maximum_meaning_utf8_bytes) !== 4096 ||
    Number(mapping(explicitGrammar?.bounds)?.maximum_acronym_utf8_bytes) !== 32 ||
    Number(mapping(explicitGrammar?.bounds)?.maximum_acronym_words) !== 32
  ) {
    errors.push(
      "personal_mining_authority explicit discovery must declare the active ten-form bounded grammar",
    );
  }
  errors.push(...validateExplicitSegmentGrammar(explicitGrammar));
  const explicitSourceProvenance = mapping(
    mapping(authority.provenance_variants)?.personal_explicit_definition,
  );
  const explicitSourceFields = mapping(explicitSourceProvenance?.source_provenance);
  if (
    !sameStrings(explicitSourceFields?.required_fields, [
      "source_id",
      "evidence_anchor",
      "source_kind",
      "signal_type",
      "origin_id",
      "content_fingerprint",
      "author_class",
      "session_id",
      "project_id",
    ]) ||
    !sameStrings(explicitSourceFields?.allowed_source_kinds, ["conversation_turn"]) ||
    explicitSourceFields?.identity_fields_must_match_full_record !== true
  ) {
    errors.push(
      "personal_explicit_definition source provenance must require complete conversation identity",
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
    stable?.canonical_input !== "ecmascript_simple_case_fold_key" ||
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
    revision?.policy_version !== PERSONAL_GLOSSARY_MINING_POLICY_VERSION ||
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
  const expectedEvidence = mapping(conversationVariant?.expected_evidence);
  const setDigest = mapping(expectedEvidence?.set_digest);
  if (
    provenance?.existing_inferred_variant !== "provenance_variants.personal_inferred_usage" ||
    provenance?.conversation_variant !== "provenance_variants.personal_inferred_conversation" ||
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
    conversationVariant?.completeness_authority !== "expected_qualifying_anchor_set_exact_match" ||
    expectedEvidence?.binding !== "generation_bound" ||
    !sameStrings(expectedEvidence?.context_fields, [
      "generation",
      "qualifying_evidence_anchors",
      "qualifying_evidence_set_sha256",
    ]) ||
    expectedEvidence?.exact_set !== "required" ||
    setDigest?.algorithm !== "sha256" ||
    setDigest?.encoding !== "lowercase_hex" ||
    !nonEmpty(setDigest?.canonicalization) ||
    !nonEmpty(expectedEvidence?.duplicate_rule) ||
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
  const discriminator = mapping(consent?.discriminator);
  const discriminatorValues = mapping(discriminator?.values);
  const discriminatorPredicates = mapping(discriminator?.predicates);
  if (
    consent?.authority !== "references/analysis/evidence-tier-authority.yaml" ||
    consent?.operation !== "Profile_Full" ||
    consent?.policy !== "reuse_existing_generation" ||
    consent?.refresh !== "forbidden_during_profile_full" ||
    !nonEmpty(consent?.reuse) ||
    !sameStrings(discriminator?.inputs, [
      "consent_status",
      "generation_status",
      "coverage_status",
      "signal_tier_bounded",
    ]) ||
    !sameStrings(discriminator?.order, ["absent", "stale", "degraded", "present"]) ||
    !sameStrings(discriminatorValues?.consent_status, ["absent", "valid", "stale"]) ||
    !sameStrings(discriminatorValues?.generation_status, ["absent", "current", "stale"]) ||
    !sameStrings(discriminatorValues?.coverage_status, [
      "complete",
      "cap_selected",
      "truncated",
      "flagged_incomplete",
    ]) ||
    JSON.stringify(discriminatorValues?.signal_tier_bounded) !== JSON.stringify([true, false]) ||
    discriminatorPredicates?.absent !== "consent_absent_or_generation_absent" ||
    discriminatorPredicates?.stale !== "after_absent_consent_or_generation_stale" ||
    discriminatorPredicates?.degraded !==
      "valid_current_actual_cap_truncation_or_flagged_incomplete" ||
    discriminatorPredicates?.present !== "valid_current_complete_any_boundedness" ||
    !nonEmpty(discriminator?.exclusivity) ||
    !String(discriminator?.exclusivity).includes("first match") ||
    !nonEmpty(discriminator?.boundedness_rule) ||
    !String(discriminator?.boundedness_rule).includes("inherently bounded") ||
    present?.condition !== "valid_current_complete_any_boundedness" ||
    present?.action !== "reuse_generation_once_for_bounded_mining" ||
    present?.result !== "mining_authorized" ||
    absent?.condition !== "consent_absent_or_generation_absent" ||
    absent?.action !== "skip_mining_without_read_or_refresh" ||
    absent?.result !== "degraded_consent_required" ||
    stale?.condition !== "after_absent_consent_or_generation_stale" ||
    stale?.action !== "reject_generation_for_new_mining_and_preserve_existing_entries" ||
    stale?.result !== "degraded_refresh_required" ||
    degraded?.condition !== "valid_current_actual_cap_truncation_or_flagged_incomplete" ||
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
  const signature = mapping(authentication?.signature);
  const freshness = mapping(authentication?.freshness);
  const replay = mapping(authentication?.replay);
  const terminalDisposition = mapping(authentication?.terminal_disposition);
  const retention = mapping(privacy?.retention);
  const purge = mapping(privacy?.purge);
  const purgeBoundaries = mapping(purge?.boundaries);
  if (
    privacy?.owner !== "current_user" ||
    privacy?.scope !== "user_local" ||
    storage?.root !== "$AGENTERA_PROFILE_DIR/intermediate/personal-glossary" ||
    storage?.project_storage !== "forbidden" ||
    !sameStrings(storage?.records, [
      "candidate_metadata",
      "safe_excerpts",
      "review_dispositions",
    ]) ||
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
    authentication?.receipt_schema_version !== "agentera.personalGlossaryReviewApproval.v1" ||
    authentication?.issuer !== "agentera-local-host" ||
    authentication?.subject !== "current_user" ||
    authentication?.trusted_channel !== "agentera-local-host-ipc" ||
    !sameStrings(authentication?.required_fields, [
      "schema_version",
      "issuer",
      "subject",
      "trusted_channel",
      "candidate_id",
      "candidate_revision",
      "generation",
      "disposition",
      "disposed_at",
      "expires_at",
      "nonce",
      "signature",
    ]) ||
    signature?.algorithm !== "ed25519" ||
    signature?.encoding !== "base64url" ||
    signature?.key_source !== "user_local_trusted_host_key" ||
    !sameStrings(signature?.signed_fields, [
      "schema_version",
      "issuer",
      "subject",
      "trusted_channel",
      "candidate_id",
      "candidate_revision",
      "generation",
      "disposition",
      "disposed_at",
      "expires_at",
      "nonce",
    ]) ||
    signature?.verification !== "trusted_host_public_key_signature_check" ||
    freshness?.max_age_seconds !== 300 ||
    freshness?.disposed_at !== "trusted_host_clock" ||
    freshness?.expires_at_required !== true ||
    freshness?.rule !== "disposed_at_must_not_be_future_and_expires_at_must_be_after_now" ||
    replay?.nonce !== "required_unique_receipt_nonce" ||
    replay?.index !== "user_local_consumed_receipt_digest_index" ||
    replay?.exact_replay !== "no_op_only_when_nonce_and_receipt_digest_match" ||
    replay?.conflicting_replay !== "reject_reused_nonce_with_changed_bindings_or_signature" ||
    !sameStrings(terminalDisposition?.terminal, ["accept", "correct", "reject"]) ||
    !sameStrings(terminalDisposition?.pending, ["defer"]) ||
    retention?.pending_excerpt_days !== 30 ||
    retention?.terminal_excerpt_days !== 0 ||
    retention?.review_metadata_days_after_terminal !== 90 ||
    retention?.accepted_entry !== "ownership_contracts.personal.retention_and_decay" ||
    retention?.pending_review_metadata !== "retained_until_terminal_or_purge" ||
    retention?.terminal_review_metadata !== "retained_for_90_days_after_disposition" ||
    !nonEmpty(retention?.rule) ||
    purge?.authority !== "current_user" ||
    purge?.trigger !== "explicit_authenticated_user_request_or_retention_expiry" ||
    !sameStrings(purge?.removes, ["candidate_metadata", "safe_excerpts", "review_dispositions"]) ||
    purge?.behavior !== "atomic_remove_user_local_records_before_next_read" ||
    purge?.project_state !== "untouched" ||
    purge?.profile_entry !== "not_implicitly_deleted" ||
    purgeBoundaries?.pending !== "purge_removes_excerpt_and_metadata_immediately" ||
    purgeBoundaries?.terminal !== "purge_removes_excerpt_and_metadata_before_next_read" ||
    purgeBoundaries?.accepted_profile_entry !== "purge_does_not_implicitly_delete_profile_entry" ||
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
    admission?.quality_threshold !==
      "references/analysis/personal-glossary-evaluation-authority.yaml#gates.release_authorizing_gate" ||
    admission?.holdout !==
      "references/analysis/personal-glossary-evaluation-authority.yaml#holdout" ||
    !nonEmpty(admission?.rule)
  ) {
    errors.push(
      "personal_mining_authority must keep inferred automatic admission disabled and bind the evaluation authority",
    );
  }

  errors.push(...validatePersonalCandidateProjectionAuthority(authority));
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
    if (
      !sameStrings(variant.required_evidence_fields, expected.required_evidence_fields as string[])
    ) {
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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  );
}

function validateExpectedConversationEvidence(
  expectation: GlossaryConversationEvidenceExpectation | undefined,
  actualEvidence: Array<Mapping | null>,
): string[] {
  const errors: string[] = [];
  if (!expectation) {
    errors.push("conversation inference requires generation-bound expected evidence");
    return errors;
  }
  const expectedAnchors = [...expectation.qualifyingEvidenceAnchors];
  if (
    !nonEmpty(expectation.generation) ||
    expectedAnchors.length === 0 ||
    expectedAnchors.some((anchor) => !nonEmpty(anchor)) ||
    new Set(expectedAnchors).size !== expectedAnchors.length
  ) {
    errors.push("conversation inference expected evidence anchors are invalid");
    return errors;
  }
  let expectedDigest = "";
  try {
    expectedDigest = glossaryEvidenceSetDigest(expectation.generation, expectedAnchors);
  } catch {
    errors.push("conversation inference expected evidence digest cannot be computed");
  }
  if (expectation.qualifyingEvidenceSetSha256 !== expectedDigest) {
    errors.push("conversation inference expected evidence digest is invalid");
  }

  const completeEvidence = actualEvidence.filter((item): item is Mapping => item !== null);
  const actualAnchors = completeEvidence.map((item) => String(item.evidence_anchor));
  const actualSourceIds = completeEvidence.map((item) => String(item.source_id));
  const actualFingerprints = completeEvidence.map((item) => String(item.content_fingerprint));
  if (
    new Set(actualAnchors).size !== actualAnchors.length ||
    new Set(actualSourceIds).size !== actualSourceIds.length ||
    new Set(actualFingerprints).size !== actualFingerprints.length
  ) {
    errors.push("conversation inference rejects duplicate source, anchor, or content identities");
  }
  if (!sameStringSet(actualAnchors, expectedAnchors)) {
    errors.push(
      "conversation inference evidence must exactly match the generation-bound anchor set",
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
  errors.push(...validateExpectedConversationEvidence(context.conversationEvidence, evidence));
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
