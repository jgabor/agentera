import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import {
  validateConsumerBoundary,
  validateConsumerEvidenceOwner,
} from "./glossaryConsumerContractValidation.js";

type Mapping = Record<string, unknown>;

export type GlossaryOwner = "personal" | "project";

export class GlossaryEntryBoundError extends Error {}
export type GlossaryProvenanceKind =
  | "personal_explicit_definition"
  | "personal_inferred_usage"
  | "project_file";

export interface RetainedEvidence {
  sourceId: string;
  sourceKind: string;
  signalType: string;
}

export interface GlossaryAdmissionContext {
  retainedHistory: ReadonlyMap<string, RetainedEvidence>;
}

export interface PersonalGlossaryAdmissionContract {
  explicitSignalTypes: string[];
  inferredSignalTypes: string[];
  inferredSourceKinds: string[];
  insufficientRecovery: string;
}

export interface ConfirmedVariantGuardContract {
  excludedDirectories: string[];
}

export interface PersonalGlossaryOutputContract {
  command: string;
  requestSchemaVersion: string;
  sectionSchemaVersion: string;
  outputStatuses: string[];
}

export interface PersonalProfileGroundingContract {
  command: string;
  schemaVersion: string;
  maxProfileUtf8Bytes: number;
}

export interface GlossaryConsumerContract {
  contractStatus: string;
  implementation: Record<string, string>;
  capabilityIntegrations: Record<string, string>;
  outcomes: string[];
  refreshRequired: string[];
  refreshNotRequired: string[];
  transientAllowed: string[];
  durableAllowed: string[];
  caveatOwner: string;
  caveatChannel: string;
  caveatEvents: string[];
  caveatExpiration: string;
  downstreamGateStatus: string;
}

export interface GlossaryAcquisitionContract {
  maxSourceUtf8Bytes: number;
  maxEntries: number;
  availabilityStates: string[];
  outputEntryFields: string[];
}

const DEFERRED_CAPABILITIES = ["profile", "audit", "discuss", "plan", "build"] as const;
export type DeferredGlossaryCapability = (typeof DEFERRED_CAPABILITIES)[number];

export function glossaryEntryAuthorityPath(root: string = resolveSourceRoot()): string {
  return path.join(root, "references", "artifacts", "glossary-entry-contract.yaml");
}

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

function contract(pathname: string): Mapping {
  return loadYamlMappingFile(pathname) as Mapping;
}

export function personalGlossaryAdmissionContract(
  pathname: string = glossaryEntryAuthorityPath(),
): PersonalGlossaryAdmissionContract {
  const authority = contract(pathname);
  const personal = mapping(mapping(authority.ownership_contracts)?.personal);
  const admission = mapping(personal?.admission);
  return {
    explicitSignalTypes: strings(mapping(admission?.explicit)?.candidate_signal_types),
    inferredSignalTypes: strings(mapping(admission?.inferred)?.candidate_signal_types),
    inferredSourceKinds: strings(mapping(admission?.inferred)?.source_kinds),
    insufficientRecovery:
      typeof admission?.insufficient_recovery === "string"
        ? admission.insufficient_recovery.trim()
        : "",
  };
}

export function confirmedVariantGuardContract(
  pathname: string = glossaryEntryAuthorityPath(),
): ConfirmedVariantGuardContract {
  const authority = contract(pathname);
  const project = mapping(mapping(authority.ownership_contracts)?.project);
  const guard = mapping(project?.confirmed_variant_guard);
  return { excludedDirectories: strings(guard?.excluded_directory_names) };
}

export function personalGlossaryOutputContract(
  pathname: string = glossaryEntryAuthorityPath(),
): PersonalGlossaryOutputContract {
  const authority = contract(pathname);
  const personal = mapping(mapping(authority.ownership_contracts)?.personal);
  const output = mapping(personal?.profile_output);
  const command = mapping(output?.command);
  const request = mapping(command?.request);
  const section = mapping(output?.section);
  return {
    command: typeof command?.canonical === "string" ? command.canonical : "",
    requestSchemaVersion: typeof request?.schema_version === "string" ? request.schema_version : "",
    sectionSchemaVersion:
      typeof section?.document_schema_version === "string" ? section.document_schema_version : "",
    outputStatuses: strings(command?.output_statuses),
  };
}

export function personalProfileGroundingContract(
  pathname: string = glossaryEntryAuthorityPath(),
): PersonalProfileGroundingContract {
  const grounding = mapping(mapping(contract(pathname).consumer_boundary)?.profile_grounding);
  return {
    command: typeof grounding?.command === "string" ? grounding.command : "",
    schemaVersion: typeof grounding?.schema_version === "string" ? grounding.schema_version : "",
    maxProfileUtf8Bytes:
      typeof grounding?.max_profile_utf8_bytes === "number" ? grounding.max_profile_utf8_bytes : 0,
  };
}

export function glossaryConsumerContract(
  pathname: string = glossaryEntryAuthorityPath(),
): GlossaryConsumerContract {
  const consumer = mapping(contract(pathname).consumer_boundary);
  const implementation = mapping(consumer?.implementation);
  const integrations = mapping(implementation?.capability_integrations);
  const matrix = mapping(consumer?.outcome_matrix);
  const refresh = mapping(consumer?.refresh_events);
  const disclosure = mapping(consumer?.disclosure);
  const transient = mapping(disclosure?.transient_advice);
  const durable = mapping(disclosure?.durable_surfaces);
  const caveat = mapping(consumer?.autonomous_caveat);
  const lifecycle = mapping(caveat?.lifecycle);
  const gate = mapping(consumer?.downstream_gate);
  return {
    contractStatus: typeof consumer?.contract_status === "string" ? consumer.contract_status : "",
    implementation: Object.fromEntries(
      Object.entries(implementation ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    capabilityIntegrations: Object.fromEntries(
      Object.entries(integrations ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    outcomes: Object.keys(matrix ?? {}),
    refreshRequired: strings(refresh?.required),
    refreshNotRequired: strings(refresh?.not_required),
    transientAllowed: strings(transient?.allowed),
    durableAllowed: strings(durable?.allowed),
    caveatOwner: typeof caveat?.durable_owner === "string" ? caveat.durable_owner : "",
    caveatChannel: typeof caveat?.durable_channel === "string" ? caveat.durable_channel : "",
    caveatEvents: ["current", "resolved", "superseded"].filter((event) =>
      nonEmpty(lifecycle?.[event]),
    ),
    caveatExpiration: typeof lifecycle?.expiration === "string" ? lifecycle.expiration : "",
    downstreamGateStatus: typeof gate?.status === "string" ? gate.status : "",
  };
}

export function glossaryAcquisitionContract(
  pathname: string = glossaryEntryAuthorityPath(),
): GlossaryAcquisitionContract {
  const acquisition = mapping(mapping(contract(pathname).consumer_boundary)?.acquisition);
  const bounds = mapping(acquisition?.bounds);
  const availability = mapping(acquisition?.availability);
  const output = mapping(acquisition?.output);
  return {
    maxSourceUtf8Bytes:
      typeof bounds?.max_source_utf8_bytes === "number" ? bounds.max_source_utf8_bytes : 0,
    maxEntries: typeof bounds?.max_entries === "number" ? bounds.max_entries : 0,
    availabilityStates: strings(availability?.states),
    outputEntryFields: strings(output?.entry_fields),
  };
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return JSON.stringify(strings(actual)) === JSON.stringify(expected);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function isSafeProjectSourcePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export function validateGlossaryEntryContract(
  pathname: string = glossaryEntryAuthorityPath(),
): string[] {
  let authority: Mapping;
  try {
    authority = contract(pathname);
  } catch (error) {
    return [`glossary-entry-contract.yaml: ${(error as Error).message}`];
  }

  const errors: string[] = [];
  if (authority.schema_version !== "agentera.glossaryEntryContract.v1") {
    errors.push("schema_version must be agentera.glossaryEntryContract.v1");
  }

  const occurrence = mapping(authority.term_occurrence);
  if (
    occurrence?.runtime !==
      "packages/cli/src/registries/glossaryTermOccurrence.ts#containsGlossaryTerm" ||
    !sameStrings(occurrence?.consumers, [
      "audit_evidence",
      "project_publication_revalidation",
      "confirmed_variant_guard",
    ]) ||
    occurrence?.comparison !== "exact_case_sensitive_literal" ||
    occurrence?.normalization !== "none" ||
    occurrence?.identifier_continuation !== "unicode_ID_Continue_plus_dollar_ZWNJ_ZWJ" ||
    !nonEmpty(occurrence?.rule)
  ) {
    errors.push(
      "term_occurrence must define one exact-case escaped literal matcher with ECMAScript identifier-continuation boundaries",
    );
  }

  const primitive = mapping(authority.shared_primitive);
  const required = strings(primitive?.required_fields);
  const expected = ["term", "meaning", "confidence", "permanence", "temporal", "provenance"];
  if (!sameStrings(required, expected)) {
    errors.push("shared_primitive.required_fields must define the canonical entry shape once");
  }

  const fields = mapping(primitive?.fields);
  for (const field of expected) {
    if (!mapping(fields?.[field])) errors.push(`shared_primitive.fields.${field} is required`);
  }
  for (const field of ["term", "meaning"]) {
    if (mapping(fields?.[field])?.type !== "non_empty_string") {
      errors.push(`shared_primitive.fields.${field}.type must be non_empty_string`);
    }
  }
  const confidence = mapping(fields?.confidence);
  if (
    confidence?.type !== "integer" ||
    confidence?.range_from !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE"
  ) {
    errors.push("confidence must derive integer bounds from protocol CONFIDENCE_SCALE");
  }
  const permanence = mapping(fields?.permanence);
  if (
    permanence?.type !== "enum" ||
    !sameStrings(permanence?.values, ["stable", "durable", "situational"])
  ) {
    errors.push("permanence must use the existing profile permanence classes");
  }
  if (!nonEmpty(permanence?.classification_rule)) {
    errors.push("permanence classification must remain independent from confidence");
  }
  const temporal = mapping(fields?.temporal);
  if (
    temporal?.type !== "object" ||
    temporal?.field_type !== "iso_date" ||
    !sameStrings(temporal?.required_fields, ["observed_at", "last_confirmed_at"])
  ) {
    errors.push("temporal metadata must include observed_at and last_confirmed_at");
  }
  const provenance = mapping(fields?.provenance);
  if (
    provenance?.type !== "discriminated_union" ||
    provenance?.discriminator !== "kind" ||
    provenance?.evidence_field !== "evidence" ||
    provenance?.variants_from !== "provenance_variants"
  ) {
    errors.push("provenance must derive its kind and evidence variants from provenance_variants");
  }

  const variants = mapping(authority.provenance_variants);
  const variantExpectations: Record<string, Mapping> = {
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
    project_file: {
      owner: "project",
      evidence_count: 1,
      required_evidence_fields: ["source_path", "source_record_sha256"],
    },
  };
  for (const [kind, expectedVariant] of Object.entries(variantExpectations)) {
    const variant = mapping(variants?.[kind]);
    if (!variant) {
      errors.push(`provenance variant ${kind} is required`);
      continue;
    }
    if (variant.owner !== expectedVariant.owner)
      errors.push(`${kind}.owner must be ${expectedVariant.owner}`);
    if (variant.evidence_count !== expectedVariant.evidence_count) {
      errors.push(`${kind}.evidence_count must be ${expectedVariant.evidence_count}`);
    }
    if (
      !sameStrings(
        variant.required_evidence_fields,
        expectedVariant.required_evidence_fields as string[],
      )
    ) {
      errors.push(`${kind}.required_evidence_fields must match its provenance variant`);
    }
    if (variant.additional_evidence_fields !== "forbidden") {
      errors.push(`${kind}.additional_evidence_fields must be forbidden`);
    }
    for (const allowedField of ["allowed_signal_types", "allowed_source_kinds"]) {
      if (
        allowedField in expectedVariant &&
        !sameStrings(variant[allowedField], expectedVariant[allowedField] as string[])
      ) {
        errors.push(`${kind}.${allowedField} must preserve the admitted evidence classes`);
      }
    }
    if (!nonEmpty(variant.resolution_rule)) errors.push(`${kind}.resolution_rule is required`);
  }

  const ownership = mapping(authority.ownership_contracts);
  const personal = mapping(ownership?.personal);
  if (personal?.scope !== "user") errors.push("personal ownership scope must be user");
  if (
    !sameStrings(personal?.allowed_provenance, [
      "personal_explicit_definition",
      "personal_inferred_usage",
    ])
  ) {
    errors.push("personal ownership must admit only personal provenance variants");
  }
  const personalInput = mapping(personal?.input);
  const excluded = strings(personalInput?.excluded_categories);
  for (const category of [
    "project_glossary_artifact_identity",
    "project_glossary_path",
    "project_glossary_record",
    "project_file_provenance",
  ]) {
    if (!excluded.includes(category)) errors.push(`personal input must exclude ${category}`);
  }
  if (personalInput?.tier !== "signal")
    errors.push("personal input must use the bounded signal tier");
  if (personalInput?.authority !== "references/analysis/evidence-tier-authority.yaml") {
    errors.push("personal input must use evidence-tier authority");
  }
  if (!nonEmpty(personalInput?.bounded_rule)) {
    errors.push("personal input bounded_rule is required");
  }
  const personalImplementation = mapping(personal?.implementation);
  const admission = mapping(personal?.admission);
  if (
    personalImplementation?.status !== "active_partial" ||
    !sameStrings(personalImplementation?.active, [
      "bounded_admission",
      "explicit_classification",
      "inferred_evidence_check",
      "profile_full_rendering",
      "profile_persistence",
    ]) ||
    !sameStrings(personalImplementation?.inactive, ["lookup"])
  ) {
    errors.push(
      "personal rendering and persistence must be active_partial while lookup remains inactive",
    );
  }
  if (
    !sameStrings(mapping(admission?.explicit)?.candidate_signal_types, [
      "correction",
      "decision",
    ]) ||
    !sameStrings(mapping(admission?.inferred)?.candidate_signal_types, [
      "instruction",
      "configuration",
    ]) ||
    !sameStrings(mapping(admission?.inferred)?.source_kinds, [
      "instruction_document",
      "project_config_signal",
    ]) ||
    !nonEmpty(admission?.read_rule) ||
    !nonEmpty(admission?.insufficient_recovery) ||
    !nonEmpty(admission?.isolation_rule)
  ) {
    errors.push(
      "personal admission must declare bounded classifier, recovery, and isolation rules",
    );
  }

  const decay = mapping(personal?.retention_and_decay);
  if (decay?.authority !== "packages/cli/src/capabilities/profile/instructions.ts#Profile-format") {
    errors.push("personal decay must delegate to the existing profile decay authority");
  }
  if (
    mapping(authority.authority)?.confidence !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE"
  ) {
    errors.push("contract confidence authority must be protocol CONFIDENCE_SCALE");
  }
  for (const field of ["retention", "confidence", "permanence"]) {
    if (!nonEmpty(decay?.[field])) errors.push(`personal retention_and_decay.${field} is required`);
  }
  const profileOutput = mapping(personal?.profile_output);
  const profileSection = mapping(profileOutput?.section);
  const mergeIdentity = mapping(profileOutput?.merge_identity);
  const profileCommand = mapping(profileOutput?.command);
  const profileRequest = mapping(profileCommand?.request);
  if (
    profileOutput?.owner !== "profile_full" ||
    profileOutput?.lifecycle_callable !==
      "packages/cli/src/analytics/personalGlossaryProfile.ts#updatePersonalGlossaryProfile" ||
    profileCommand?.canonical !== "agentera report profile-glossary" ||
    profileCommand?.namespace !== "report" ||
    profileCommand?.input_flag !== "--input" ||
    profileCommand?.stdin_value !== "-" ||
    profileCommand?.format !== "json" ||
    profileCommand?.dry_run_flag !== "--dry-run" ||
    profileCommand?.project_checkout !== "not_required" ||
    profileRequest?.schema_version !== "agentera.personalGlossaryUpdateRequest.v1" ||
    !sameStrings(profileRequest?.required_fields, [
      "schema_version",
      "profile_path",
      "as_of",
      "fresh_entries",
      "retained_history",
    ]) ||
    profileRequest?.additional_fields !== "forbidden" ||
    !nonEmpty(profileRequest?.profile_path_rule) ||
    !nonEmpty(profileRequest?.retained_history_shape) ||
    !sameStrings(profileCommand?.output_statuses, [
      "changed",
      "unchanged_replay",
      "dry_run_candidate",
    ]) ||
    !nonEmpty(profileCommand?.rule) ||
    profileSection?.heading !== "## Glossary" ||
    profileSection?.start_marker !== "<!-- agentera:personal-glossary:start -->" ||
    profileSection?.end_marker !== "<!-- agentera:personal-glossary:end -->" ||
    profileSection?.encoding !== "deterministic_json_fence" ||
    profileSection?.document_schema_version !== "agentera.personalGlossarySection.v1" ||
    profileSection?.entry_shape !== "shared_primitive" ||
    !sameStrings(profileSection?.lifecycle_metadata, ["as_of", "confidence_basis"]) ||
    !nonEmpty(profileSection?.boundary_rule) ||
    mergeIdentity?.normalization !== "unicode_caseless_exact_no_normalization" ||
    !nonEmpty(mergeIdentity?.rule) ||
    !nonEmpty(profileOutput?.refresh_rule) ||
    !nonEmpty(profileOutput?.decay_rule) ||
    !nonEmpty(profileOutput?.isolation_rule)
  ) {
    errors.push(
      "personal profile output must define deterministic isolated rendering and lifecycle rules",
    );
  }

  const project = mapping(ownership?.project);
  const projectInput = mapping(project?.input);
  const projectImplementation = mapping(project?.implementation);
  const proposalDigest = mapping(project?.proposal_digest);
  const proposalValidation = mapping(project?.proposal_validation);
  const entryDerivation = mapping(project?.entry_derivation);
  const publication = mapping(project?.publication);
  const confirmedVariantGuard = mapping(project?.confirmed_variant_guard);
  const publicationRequest = mapping(publication?.request);
  const persistedDocument = mapping(publication?.persisted_document);
  const terminologySetIdentity = mapping(persistedDocument?.terminology_set_identity);
  if (
    project?.scope !== "repository" ||
    !sameStrings(project?.allowed_provenance, ["project_file"])
  ) {
    errors.push("project ownership must be repository-scoped project_file provenance");
  }
  if (
    projectImplementation?.status !== "active" ||
    !sameStrings(projectImplementation?.active, [
      "audit_proposal_digest",
      "build_publication",
      "confirmed_variant_guard",
    ]) ||
    !sameStrings(projectImplementation?.inactive, [
      "lookup",
      "precedence",
      "semantic_equivalence_review",
    ]) ||
    proposalDigest?.algorithm !== "sha256" ||
    proposalDigest?.encoding !== "lowercase_hex" ||
    !nonEmpty(proposalDigest?.canonicalization)
  ) {
    errors.push(
      "project glossary digest and build publication must remain active under the declared consumer boundary",
    );
  }
  if (
    confirmedVariantGuard?.owner !==
      "packages/cli/src/validate/v1LegacyCruft.ts#scanPost30CruftViolations" ||
    confirmedVariantGuard?.validation_surface !== "packages/cli/test/cli/v1LegacyCruft.test.ts" ||
    confirmedVariantGuard?.loader !==
      "packages/cli/src/state/write/glossaryPublication.ts#loadProjectGlossaryDocument" ||
    confirmedVariantGuard?.matching !== "exact_case_sensitive_boundary_aware_literal" ||
    !nonEmpty(confirmedVariantGuard?.source_rule) ||
    !nonEmpty(confirmedVariantGuard?.approved_evidence_rule) ||
    !nonEmpty(confirmedVariantGuard?.failure_rule) ||
    !sameStrings(confirmedVariantGuard?.exclusions, [
      "generated_output",
      "vendor_and_dependency_state",
      "cache_state",
      "repository_metadata",
      "historical_agentera_state",
      "project_glossary_document",
      "unrelated_agentera_state",
    ]) ||
    !sameStrings(confirmedVariantGuard?.excluded_directory_names, [
      ".agentera",
      ".agentera-generated",
      ".cache",
      ".git",
      ".next",
      ".pnpm",
      ".turbo",
      ".venv",
      ".vite",
      "build",
      "bundle",
      "coverage",
      "dist",
      "node_modules",
      "target",
      "vendor",
    ]) ||
    !nonEmpty(confirmedVariantGuard?.exclusion_rule)
  ) {
    errors.push(
      "confirmed variant guard must reuse validated project glossary pairs and bounded legacy-cruft exclusions",
    );
  }
  if (
    proposalValidation?.owner !== "audit" ||
    proposalValidation?.shared_runtime !==
      "packages/cli/src/audit/terminologyDrift.ts#validateTerminologyProposal" ||
    !sameStrings(proposalValidation?.required_rules, [
      "safe_distinct_evidence_identities_per_term",
      "unicode_caseless_exact_unique_term_identities",
      "best_supported_canonical_term_with_lexicographic_tie_break",
      "authority_confidence_floor_and_range",
      "confidence_below_70_forces_info_severity",
      "canonical_evidence_and_variant_order",
      "canonical_proposal_digest",
    ]) ||
    !nonEmpty(proposalValidation?.publication_rule)
  ) {
    errors.push("project publication must reuse the Audit-owned canonical proposal validator");
  }
  if (
    entryDerivation?.term !== "proposal.proposed_canonical_term" ||
    entryDerivation?.meaning !== "proposal.concept" ||
    entryDerivation?.confidence !== "proposal.confidence" ||
    entryDerivation?.permanence !== "stable" ||
    entryDerivation?.["provenance.kind"] !== "project_file" ||
    !nonEmpty(entryDerivation?.["provenance.evidence"]) ||
    !nonEmpty(entryDerivation?.rejection_rule)
  ) {
    errors.push("project entry derivation must produce only the shared project_file primitive");
  }
  if (
    publication?.owner !== "build" ||
    publication?.command !== "agentera state glossary publish --input REQUEST --format json" ||
    publicationRequest?.schema_version !== "agentera.glossaryPublicationRequest.v1" ||
    !sameStrings(publicationRequest?.required_fields, [
      "schema_version",
      "proposal",
      "confirmation",
    ]) ||
    persistedDocument?.schema_version !== "agentera.projectGlossary.v1" ||
    !sameStrings(persistedDocument?.required_fields, ["schema_version", "approvals", "entries"]) ||
    terminologySetIdentity?.normalization !== "unicode_caseless_exact_no_normalization" ||
    !sameStrings(terminologySetIdentity?.members, [
      "paired_entry.term",
      "paired_approval.proposal.variants.term",
    ]) ||
    terminologySetIdentity?.uniqueness !== "global_across_complete_document" ||
    !nonEmpty(terminologySetIdentity?.rule) ||
    !nonEmpty(publication?.transaction) ||
    !nonEmpty(publication?.merge_and_replay)
  ) {
    errors.push(
      "project publication must define one versioned atomic build-owned request and document",
    );
  }
  if (
    projectInput?.authority !== "repository_files" ||
    !nonEmpty(projectInput?.bounded_rule) ||
    !sameStrings(projectInput?.excluded_categories, [
      "personal_history_record",
      "personal_history_anchor",
    ])
  ) {
    errors.push(
      "project input must be bounded repository-file evidence excluding personal history",
    );
  }

  const consumer = mapping(authority.consumer_boundary);
  errors.push(...validateConsumerBoundary(consumer));
  errors.push(...validateConsumerEvidenceOwner(consumer));
  const profileGrounding = mapping(consumer?.profile_grounding);
  if (
    !sameStrings(consumer?.forbidden_persisted_entry_fields, [
      "precedence",
      "collision",
      "review",
    ]) ||
    profileGrounding?.implementation !== "active_exclusion_only" ||
    !sameStrings(profileGrounding?.capabilities, ["discuss", "plan", "build"]) ||
    profileGrounding?.command !== "agentera report profile-grounding --format json" ||
    profileGrounding?.schema_version !== "agentera.profileGrounding.v1" ||
    profileGrounding?.parser !==
      "packages/cli/src/analytics/personalGlossaryProfile.ts#personalProfileGrounding" ||
    profileGrounding?.max_profile_utf8_bytes !== 65536 ||
    profileGrounding?.raw_profile_read !== "forbidden" ||
    !nonEmpty(profileGrounding?.content_rule) ||
    !nonEmpty(profileGrounding?.failure_rule)
  ) {
    errors.push(
      "sanitized profile grounding must continue excluding the owned glossary while consumer acquisition remains separate",
    );
  }
  const exactCollision = mapping(consumer?.exact_collision);
  if (
    exactCollision?.behavior !== "project_precedence_at_consumption" ||
    exactCollision?.persistence !== "forbidden" ||
    exactCollision?.personal_entry_suppression !== "forbidden"
  ) {
    errors.push(
      "exact collisions must defer project precedence to consumption without persistence or suppression",
    );
  }
  const inferred = mapping(consumer?.inferred_semantic_equivalence);
  if (
    inferred?.behavior !== "user_review" ||
    inferred?.automatic_merge !== "forbidden" ||
    inferred?.suppression !== "forbidden" ||
    inferred?.precedence !== "forbidden"
  ) {
    errors.push(
      "inferred equivalence must defer to user review without merge, suppression, or precedence",
    );
  }

  const capabilities = mapping(authority.deferred_capability_contracts);
  const profile = mapping(capabilities?.profile);
  const profileContracts = mapping(profile?.contracts);
  if (
    profile?.implementation !== "active_partial" ||
    !sameStrings(profile?.capabilities, ["profile"]) ||
    !sameStrings(profile?.active_behavior, [
      "ownership_contracts.personal.admission",
      "ownership_contracts.personal.profile_output",
    ]) ||
    !sameStrings(profile?.inactive_behavior, ["lookup"]) ||
    profileContracts?.admission !== "ownership_contracts.personal.input" ||
    profileContracts?.provenance !== "ownership_contracts.personal.allowed_provenance" ||
    profileContracts?.confidence !== "shared_primitive.fields.confidence" ||
    profileContracts?.retention_and_decay !== "ownership_contracts.personal.retention_and_decay" ||
    !sameStrings(profile?.forbidden_current_claims, ["lookup", "project_glossary_consumption"])
  ) {
    errors.push(
      "profile glossary rendering and persistence must be active while lookup remains deferred",
    );
  }
  const audit = mapping(capabilities?.audit);
  const findingFamily = mapping(audit?.finding_family);
  const proposalOutput = mapping(audit?.proposal_output);
  const auditInputs = mapping(audit?.inputs);
  if (
    audit?.implementation !== "active_partial" ||
    !sameStrings(audit?.capabilities, ["audit"]) ||
    audit?.active_behavior !== "terminology_drift_finding_generation" ||
    findingFamily?.status !== "implemented" ||
    findingFamily?.mutation !== "forbidden" ||
    findingFamily?.evidence !== "ownership_contracts.project.input" ||
    findingFamily?.confidence !== "skills/agentera/protocol.yaml#CONFIDENCE_SCALE" ||
    findingFamily?.filtering !== "skills/agentera/capabilities/audit/schemas/validation.yaml" ||
    !nonEmpty(findingFamily?.canonical_proposal_rule) ||
    !nonEmpty(findingFamily?.personal_comparison_rule) ||
    proposalOutput?.implementation !== "active" ||
    proposalOutput?.intended_output !== "read_only_terminology_drift_finding" ||
    proposalOutput?.digest !== "ownership_contracts.project.proposal_digest" ||
    auditInputs?.personal_history !== "ownership_contracts.personal.input" ||
    auditInputs?.project_file !== "ownership_contracts.project.input" ||
    auditInputs?.project_file_history_classification !== "forbidden" ||
    !sameStrings(audit?.forbidden_current_claims, [
      "persistence",
      "approval",
      "docs_mapping_mutation",
      "lookup",
    ])
  ) {
    errors.push("audit findings and proposal digests must be active and read-only");
  }
  const buildPublication = mapping(capabilities?.build_publication);
  if (
    buildPublication?.implementation !== "active" ||
    !sameStrings(buildPublication?.capabilities, ["build"]) ||
    buildPublication?.active_behavior !== "ownership_contracts.project.publication" ||
    buildPublication?.output !== "skills/agentera/schemas/artifacts/glossary.yaml" ||
    !sameStrings(buildPublication?.inactive_behavior, [
      "lookup",
      "precedence",
      "semantic_equivalence_review",
      "personal_profile_mutation",
      "docs_mapping_mutation",
    ])
  ) {
    errors.push("build must own only active typed glossary publication");
  }
  const consumers = mapping(capabilities?.consumers);
  const consumerImplementations = mapping(consumers?.implementation);
  if (
    consumerImplementations?.build !== "active" ||
    consumerImplementations?.discuss !== "active" ||
    consumerImplementations?.plan !== "active" ||
    consumerImplementations?.prime !== "active" ||
    !sameStrings(consumers?.capabilities, ["discuss", "plan", "build", "prime"]) ||
    consumers?.behavior !== "consumer_boundary" ||
    !sameStrings(consumers?.forbidden_current_claims, [])
  ) {
    errors.push(
      "build, discuss, plan, and prime glossary consumption must be active",
    );
  }
  return errors;
}

export function validateGlossaryCapabilityImplementationClaim(
  capability: string,
  claimedImplementation: string,
  pathname: string = glossaryEntryAuthorityPath(),
): string[] {
  if (!DEFERRED_CAPABILITIES.includes(capability as DeferredGlossaryCapability)) {
    return [`${capability} is not an affected glossary capability`];
  }
  const authority = contract(pathname);
  const declarations = mapping(authority.deferred_capability_contracts);
  const declaration = Object.values(declarations ?? {})
    .map(mapping)
    .find((candidate) => strings(candidate?.capabilities).includes(capability));
  if (!declaration) return [`${capability} has no deferred glossary declaration`];
  const declaredImplementation =
    mapping(declaration.implementation)?.[capability] ?? declaration.implementation;
  if (claimedImplementation !== declaredImplementation) {
    return [
      `${capability} glossary behavior is ${String(declaredImplementation)}; ${claimedImplementation} is a false implementation claim`,
    ];
  }
  return [];
}

function requiredEntryShape(entry: Mapping, authority: Mapping): string[] {
  const errors: string[] = [];
  const primitive = mapping(authority.shared_primitive);
  const fields = mapping(primitive?.fields);
  const consumer = mapping(authority.consumer_boundary);
  const forbidden = strings(consumer?.forbidden_persisted_entry_fields).filter(
    (field) => field in entry,
  );
  if (forbidden.length > 0) {
    errors.push(`entry contains forbidden persisted fields: ${forbidden.join(", ")}`);
  }
  const requiredFields = strings(primitive?.required_fields);
  const additional = Object.keys(entry).filter((field) => !requiredFields.includes(field));
  if (additional.length > 0)
    errors.push(`entry contains fields outside the shared primitive: ${additional.join(", ")}`);
  for (const field of requiredFields) {
    if (!(field in entry)) errors.push(`${field} is required`);
  }
  if (typeof entry.term !== "string" || entry.term.trim() === "")
    errors.push("term must be a non-empty string");
  if (typeof entry.meaning !== "string" || entry.meaning.trim() === "")
    errors.push("meaning must be a non-empty string");
  if (
    !Number.isInteger(entry.confidence) ||
    Number(entry.confidence) < 0 ||
    Number(entry.confidence) > 100
  ) {
    errors.push("confidence must be an integer from protocol CS1-CS5");
  }
  if (!strings(mapping(fields?.permanence)?.values).includes(String(entry.permanence))) {
    errors.push("permanence must be an existing profile permanence class");
  }
  const temporal = mapping(entry.temporal);
  for (const field of strings(mapping(fields?.temporal)?.required_fields)) {
    if (!isIsoCalendarDate(temporal?.[field])) {
      errors.push(`temporal.${field} must be an ISO date`);
    }
  }
  return errors;
}

function evidenceShape(
  evidence: Mapping,
  requiredFields: string[],
  kind: string,
  index: number,
): string[] {
  const errors: string[] = [];
  const missing = requiredFields.filter((field) => !(field in evidence));
  const forbidden = Object.keys(evidence).filter((field) => !requiredFields.includes(field));
  if (missing.length > 0) {
    errors.push(`provenance.evidence[${index}] is missing ${kind} fields: ${missing.join(", ")}`);
  }
  if (forbidden.length > 0) {
    errors.push(
      `provenance.evidence[${index}] contains fields forbidden for ${kind}: ${forbidden.join(", ")}`,
    );
  }
  return errors;
}

function validateHistoryEvidence(
  evidence: Mapping,
  context: GlossaryAdmissionContext,
  index: number,
): string[] {
  const errors: string[] = [];
  const sourceId = typeof evidence.source_id === "string" ? evidence.source_id : "";
  const anchor = typeof evidence.evidence_anchor === "string" ? evidence.evidence_anchor : "";
  const retained = context.retainedHistory.get(anchor);
  if (!sourceId || !anchor)
    errors.push(`provenance.evidence[${index}] requires source_id and evidence_anchor`);
  if (!retained || retained.sourceId !== sourceId) {
    errors.push(
      `provenance.evidence[${index}].evidence_anchor must resolve to its retained source_id`,
    );
  }
  return errors;
}

export function validateGlossaryEntry(
  entry: Mapping,
  owner: GlossaryOwner,
  context: GlossaryAdmissionContext = { retainedHistory: new Map() },
  pathname: string = glossaryEntryAuthorityPath(),
): string[] {
  const authorityErrors = validateGlossaryEntryContract(pathname);
  if (authorityErrors.length > 0) {
    return authorityErrors.map((error) => `glossary authority invalid: ${error}`);
  }
  const authority = contract(pathname);
  const variants = mapping(authority.provenance_variants) as Mapping;
  const ownership = mapping(authority.ownership_contracts) as Mapping;
  const ownerContract = mapping(ownership[owner]) as Mapping;
  const errors = requiredEntryShape(entry, authority);
  const provenance = mapping(entry.provenance);
  const kind = provenance?.kind as GlossaryProvenanceKind | undefined;
  const evidence = Array.isArray(provenance?.evidence) ? provenance.evidence.map(mapping) : [];

  if (!kind || !strings(ownerContract.allowed_provenance).includes(kind)) {
    errors.push(
      owner === "personal"
        ? "personal entries admit only bounded personal-history provenance"
        : "project entries admit only repository-file provenance",
    );
    return errors;
  }
  const variant = mapping(variants[kind]) as Mapping;
  const requiredEvidenceFields = strings(variant.required_evidence_fields);
  for (const [index, item] of evidence.entries()) {
    if (item) errors.push(...evidenceShape(item, requiredEvidenceFields, kind, index));
  }
  const evidenceCount = Number(variant.evidence_count);

  if (kind === "personal_explicit_definition") {
    if (evidence.length !== evidenceCount || evidence[0] === null) {
      errors.push("explicit personal definitions require exactly one retained record");
    } else {
      errors.push(...validateHistoryEvidence(evidence[0], context, 0));
      const retained = context.retainedHistory.get(String(evidence[0].evidence_anchor));
      if (
        !retained ||
        evidence[0].signal_type !== retained.signalType ||
        !strings(variant.allowed_signal_types).includes(retained.signalType)
      ) {
        errors.push("explicit personal definition evidence has an inadmissible signal type");
      }
    }
  }

  if (kind === "personal_inferred_usage") {
    if (evidence.length !== evidenceCount || evidence.some((item) => item === null)) {
      errors.push("inferred personal usage requires exactly two retained records");
    } else {
      for (const [index, item] of (evidence as Mapping[]).entries()) {
        errors.push(...validateHistoryEvidence(item, context, index));
        const retained = context.retainedHistory.get(String(item.evidence_anchor));
        if (
          !retained ||
          item.source_kind !== retained.sourceKind ||
          !strings(variant.allowed_source_kinds).includes(retained.sourceKind)
        ) {
          errors.push(`provenance.evidence[${index}] has an inadmissible inferred source kind`);
        }
      }
      const sourceIds = evidence.map((item) => String(item?.source_id));
      const anchors = evidence.map((item) => String(item?.evidence_anchor));
      if (new Set(sourceIds).size !== 2 || new Set(anchors).size !== 2) {
        errors.push(
          "inferred personal usage requires two distinct retained identities and anchors",
        );
      }
    }
  }

  if (kind === "project_file") {
    if (evidence.length !== evidenceCount || evidence[0] === null) {
      errors.push("project file provenance requires exactly one source record");
    } else {
      const sourcePath = evidence[0].source_path;
      const digest = evidence[0].source_record_sha256;
      if (!isSafeProjectSourcePath(sourcePath)) {
        errors.push("project source_path must be safe and project-relative");
      }
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        errors.push("project source_record_sha256 must be a lowercase SHA-256 digest");
      }
    }
  }
  return errors;
}
