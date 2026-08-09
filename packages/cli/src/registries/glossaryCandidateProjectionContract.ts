import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";
import type { PersonalGlossaryCandidateProjectionContract } from "./personalGlossaryContracts.js";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
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
  const retention = mapping(mapping(mining?.privacy)?.retention);
  const projectIdentity = mapping(selection?.project_identity);
  const persistence = mapping(projection?.persistence);
  const families = mapping(selection?.source_families);
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
    sourceFamilies: Object.fromEntries(
      Object.entries(families ?? {}).flatMap(([family, values]) =>
        Array.isArray(values) && values.every((value) => typeof value === "string")
          ? [[family, [...values]]]
          : [],
      ),
    ),
    selectionAlgorithm: typeof selection?.algorithm === "string" ? selection.algorithm : "",
    tieBreak: typeof selection?.tie_break === "string" ? selection.tie_break : "",
    projectIdentitySchemaVersion:
      typeof projectIdentity?.schema_version === "string" ? projectIdentity.schema_version : "",
    storageFile: typeof persistence?.file === "string" ? persistence.file : "",
  };
}
