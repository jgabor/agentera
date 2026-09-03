import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

export interface PersonalGlossaryProfileFullContract {
  candidateListLimit: number;
  questionReviewMaximum: number;
}

function exactPositiveLimit(value: unknown, expected: number): number {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new TypeError("personal glossary Profile Full contract is unavailable");
  }
  return value;
}

/** Load the bounded Profile Full integration settings from the glossary authority. */
export function personalGlossaryProfileFullContract(pathname: string = glossaryEntryAuthorityPath()): PersonalGlossaryProfileFullContract {
  const authority = loadYamlMappingFile(pathname) as Mapping;
  const profileFull = mapping(mapping(authority.personal_mining_authority)?.profile_full);
  const existingGeneration = mapping(profileFull?.existing_generation);
  const review = mapping(profileFull?.review);
  return {
    candidateListLimit: exactPositiveLimit(existingGeneration?.list_limit, 20),
    questionReviewMaximum: exactPositiveLimit(review?.question_channel_maximum, 3),
  };
}
