import { loadYamlMappingFile } from "../core/yaml.js";
import { projectGlossaryDevelopmentValue } from "../core/developmentInvocation.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";
import type { PersonalGlossaryCandidateProjectionContract } from "./personalGlossaryContracts.js";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

/** Load the internal projection settings from the glossary authority. */
export function personalGlossaryCandidateProjectionContract(
  pathname: string = glossaryEntryAuthorityPath(),
): PersonalGlossaryCandidateProjectionContract {
  const authority = loadYamlMappingFile(pathname) as Mapping;
  const mining = mapping(authority.personal_mining_authority);
  const projection = mapping(mining?.candidate_projection);
  const selection = mapping(projection?.selection);
  const excerpts = mapping(projection?.excerpts);
  const privacy = mapping(mining?.privacy);
  const contentExclusion = mapping(privacy?.content_exclusion);
  const retention = mapping(privacy?.retention);
  const projectIdentity = mapping(selection?.project_identity);
  const persistence = mapping(projection?.persistence);
  const families = mapping(selection?.source_families);
  const sourceFamilies = Object.fromEntries(
    Object.entries(families ?? {}).flatMap(([family, values]) =>
      Array.isArray(values) && values.every((value) => typeof value === "string")
        ? [[family, [...values] as string[]]]
        : [],
    ),
  );
  const retrieval = mapping(mining?.candidate_retrieval);
  const retrievalCommand = mapping(retrieval?.command);
  const list = mapping(retrieval?.list);
  const filters = mapping(list?.filters);
  const cursor = mapping(list?.cursor);
  const exact = mapping(retrieval?.exact);
  const safeContextView = mapping(retrieval?.safe_context_view);
  return {
    schemaVersion: typeof projection?.schema_version === "string" ? projection.schema_version : "",
    owner: typeof projection?.owner === "string" ? projection.owner : "",
    candidatesMax: typeof selection?.candidates_max === "number" ? selection.candidates_max : 0,
    projectIdsMaxPerCandidate:
      typeof selection?.project_ids_max_per_candidate === "number"
        ? selection.project_ids_max_per_candidate
        : 0,
    sourceExcerptMaxUtf8Bytes:
      typeof excerpts?.source_max_utf8_bytes === "number" ? excerpts.source_max_utf8_bytes : 0,
    pendingExcerptDays:
      typeof retention?.pending_excerpt_days === "number" ? retention.pending_excerpt_days : 0,
    sourceFamilies,
    selectionAlgorithm: typeof selection?.algorithm === "string" ? selection.algorithm : "",
    tieBreak: typeof selection?.tie_break === "string" ? selection.tie_break : "",
    projectIdentitySchemaVersion:
      typeof projectIdentity?.schema_version === "string" ? projectIdentity.schema_version : "",
    storageFile: typeof persistence?.file === "string" ? persistence.file : "",
    candidateSecretReason:
      typeof contentExclusion?.candidate_reason === "string"
        ? contentExclusion.candidate_reason
        : "",
    excerptSensitiveContentAction:
      typeof contentExclusion?.excerpt_action === "string" ? contentExclusion.excerpt_action : "",
    candidateReadCommand: projectGlossaryDevelopmentValue(
      retrievalCommand?.canonical,
      "candidate_retrieval.command",
    ),
    candidateReadSchemaVersion:
      typeof list?.schema_version === "string" ? list.schema_version : "",
    candidateReadDefaultLimit:
      typeof list?.default_limit === "number" ? list.default_limit : 0,
    candidateReadMaximumLimit:
      typeof list?.maximum_limit === "number" ? list.maximum_limit : 0,
    candidateReadOrder: typeof list?.order === "string" ? list.order : "",
    candidateReadListProjectionBindingField:
      typeof list?.projection_binding_field === "string" ? list.projection_binding_field : "",
    candidateReadSourceFamilies: Object.keys(sourceFamilies),
    candidateReadProvenanceKinds: [
      ...new Set(Object.values(sourceFamilies).flat()),
    ].sort(),
    candidateReadScopes: strings(filters?.scope),
    candidateReadMaxSerializedUtf8Bytes:
      typeof list?.max_serialized_utf8_bytes === "number"
        ? list.max_serialized_utf8_bytes
        : 0,
    candidateReadCursorVocabulary:
      typeof cursor?.vocabulary === "string" ? cursor.vocabulary : "",
    candidateReadCursorBinding: strings(cursor?.binding),
    candidateReadCursorInvalidBehavior:
      typeof cursor?.invalid_behavior === "string" ? cursor.invalid_behavior : "",
    candidateReadCursorUnavailableBehavior:
      typeof cursor?.unavailable_behavior === "string"
        ? cursor.unavailable_behavior
        : "",
    candidateReadExactRequiredBindings: strings(exact?.required_bindings),
    candidateReadExactProjectionBindingField:
      typeof exact?.projection_binding_field === "string" ? exact.projection_binding_field : "",
    candidateReadExactOccurrencesMax:
      typeof exact?.occurrences_max === "number" ? exact.occurrences_max : 0,
    candidateReadSafeContextMaxUtf8Bytes:
      typeof exact?.safe_context_max_utf8_bytes === "number"
        ? exact.safe_context_max_utf8_bytes
        : 0,
    candidateReadExactMaxSerializedUtf8Bytes:
      typeof exact?.max_serialized_utf8_bytes === "number"
        ? exact.max_serialized_utf8_bytes
        : 0,
    candidateReadCursorAuthority:
      typeof cursor?.authority === "string" ? cursor.authority : "",
    candidateReadSafeContextViewAuthority:
      typeof safeContextView?.authority === "string" ? safeContextView.authority : "",
    candidateReadSafeContextRetentionDays:
      typeof safeContextView?.retention_days === "number"
        ? safeContextView.retention_days
        : 0,
    candidateReadSafeContextViewExpiry:
      typeof safeContextView?.expiry === "string" ? safeContextView.expiry : "",
    candidateReadSafeContextViewMutation:
      typeof safeContextView?.mutation === "string" ? safeContextView.mutation : "",
    candidateReadSafeContextViewSnapshot:
      typeof safeContextView?.snapshot === "string" ? safeContextView.snapshot : "",
  };
}
