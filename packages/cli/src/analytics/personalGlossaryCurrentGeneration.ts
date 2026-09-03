import { defaultTiersDir, readCurrentGeneration } from "./extractCorpus/evidenceTiers.js";
import { readPersonalGlossaryCandidateProjection, type PersonalGlossaryCandidateProjection, type PersonalGlossaryCandidateProjectionStorageOptions } from "./personalGlossaryCandidateProjection.js";

export interface PersonalGlossaryCurrentGenerationOptions extends PersonalGlossaryCandidateProjectionStorageOptions {
  tiersDir?: string;
}

export type PersonalGlossaryCurrentGenerationStatus = "current" | "current_generation_unavailable" | "projection_missing" | "projection_corrupt" | "projection_stale";

export interface PersonalGlossaryCurrentGenerationResult {
  status: PersonalGlossaryCurrentGenerationStatus;
  projection: PersonalGlossaryCandidateProjection | null;
}

/**
 * Read the private candidate projection only when it is bound to the readable
 * current evidence-tier generation. A projection from a prior generation is
 * never a current candidate source.
 */
export function readCurrentPersonalGlossaryCandidateProjection(options: PersonalGlossaryCurrentGenerationOptions = {}): PersonalGlossaryCurrentGenerationResult {
  const generation = readCurrentGeneration(options.tiersDir ?? defaultTiersDir(options.env, options.platform));
  if (generation === null || generation.pointer.generation !== generation.manifest.generation) {
    return { status: "current_generation_unavailable", projection: null };
  }

  const projection = readPersonalGlossaryCandidateProjection(options);
  if (projection.status === "missing") {
    return { status: "projection_missing", projection: null };
  }
  if (projection.status !== "current" || projection.projection === null) {
    return { status: "projection_corrupt", projection: null };
  }
  if (projection.projection.generation !== generation.pointer.generation) {
    return { status: "projection_stale", projection: null };
  }
  return { status: "current", projection: projection.projection };
}
