import { type PersonalGlossaryCandidateProjection, type ProjectedPersonalGlossaryCandidate } from "./personalGlossaryCandidateProjection.js";
import { glossaryCanonicalSha256 } from "../registries/glossaryTermIdentity.js";

export interface PersonalGlossaryCandidateReadView {
  projection: PersonalGlossaryCandidateProjection;
  candidates: ProjectedPersonalGlossaryCandidate[];
  expiredSafeContexts: number;
  safeContextViewSha256: string;
}

/** Derive the expiry-aware candidate view without mutating its private projection. */
export function currentPersonalGlossaryCandidateReadView(projection: PersonalGlossaryCandidateProjection): PersonalGlossaryCandidateReadView {
  const readTime = Date.now();
  let expiredSafeContexts = 0;
  const candidates = projection.candidates.map((candidate) => {
    if (candidate.safe_excerpt !== null && Date.parse(candidate.safe_excerpt.expires_at) <= readTime) {
      expiredSafeContexts += 1;
      return { ...candidate, safe_excerpt: null };
    }
    return candidate;
  });
  const safeContextViewSha256 = glossaryCanonicalSha256({
    schema_version: "agentera.personalGlossaryCandidateSafeContextView.v1",
    candidates: candidates.map((candidate) => ({
      candidate_id: candidate.capsule.candidate_id,
      candidate_revision: candidate.capsule.candidate_revision,
      capsule_sha256: candidate.capsule.capsule_sha256,
      safe_context_available: candidate.safe_excerpt !== null,
    })),
  });
  return { projection, candidates, expiredSafeContexts, safeContextViewSha256 };
}
