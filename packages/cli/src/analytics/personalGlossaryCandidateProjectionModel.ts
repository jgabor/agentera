import type { GlossaryEvidenceCapsule } from "../registries/glossaryCandidateContracts.js";
import type { Env } from "./extractCorpus/core.js";
import type { ExcerptOmissionReason } from "./personalGlossaryCandidateProjectionExcerpts.js";

export type PersonalGlossaryProjectionSourceFamily = "explicit" | "recurring";

export interface PersonalGlossaryProjectionCandidateInput {
  capsule: GlossaryEvidenceCapsule;
  /** Transient diversity labels. Projection fields persist only their hashed identities. */
  project_ids: readonly string[];
  /** Candidate-adjacent source text. Sensitive excerpts are omitted completely. */
  excerpts?: readonly string[];
}

export interface PersonalGlossaryMiningFamilySummary {
  candidate_count: number;
  abstention_count: number;
  abstentions_by_reason: Record<string, number>;
}

export interface PersonalGlossaryMiningSummary {
  schema_version: "agentera.personalGlossaryMiningSummary.v1";
  explicit: PersonalGlossaryMiningFamilySummary;
  recurring: PersonalGlossaryMiningFamilySummary;
  total_candidate_count: number;
  total_abstention_count: number;
}

export interface PersonalGlossaryCandidateProjectionInput {
  generation: string;
  policy_version: string;
  /** Stable source-generation time used to derive the excerpt expiry. */
  retained_at: string;
  candidates: readonly PersonalGlossaryProjectionCandidateInput[];
  mining_summary?: PersonalGlossaryMiningSummary;
}

export interface PersonalGlossarySafeExcerpt {
  text: string;
  expires_at: string;
  redacted: boolean;
}

export interface ProjectedPersonalGlossaryCandidate {
  capsule: GlossaryEvidenceCapsule;
  source_family: PersonalGlossaryProjectionSourceFamily;
  project_keys: string[];
  safe_excerpt: PersonalGlossarySafeExcerpt | null;
}

export interface PersonalGlossaryCandidateProjectionReport {
  schema_version: "agentera.personalGlossaryCandidateProjectionReport.v1";
  input_count: number;
  duplicate_count: number;
  unique_count: number;
  retained_count: number;
  dropped_count: number;
  cap: { maximum: number; applied: boolean };
  allocation: { algorithm: string; tie_break: string; tie_breaks_resolved: number };
  source_families: Array<{
    family: PersonalGlossaryProjectionSourceFamily;
    available: number;
    retained: number;
    dropped: number;
  }>;
  projects: { available: number; retained: number; dropped: number };
  coverage: {
    status: "complete" | "degraded";
    reasons: string[];
    uncovered_source_families: PersonalGlossaryProjectionSourceFamily[];
    uncovered_projects: number;
  };
  excerpts: {
    provided: number;
    retained: number;
    redacted: number;
    truncated: number;
    expired: number;
    omissions: Record<ExcerptOmissionReason, number>;
  };
  mining_summary: PersonalGlossaryMiningSummary;
}

export interface PersonalGlossaryCandidateProjection {
  schema_version: "agentera.personalGlossaryCandidateProjection.v1";
  owner: "deterministic_discovery_projection";
  generation: string;
  policy_version: string;
  retained_at: string;
  candidates: ProjectedPersonalGlossaryCandidate[];
  report: PersonalGlossaryCandidateProjectionReport;
  projection_sha256: string;
}

export interface PersonalGlossaryCandidateProjectionStorageOptions {
  env?: Env;
  platform?: NodeJS.Platform;
}

export interface PersonalGlossaryCandidateProjectionReadResult {
  status: "current" | "missing" | "corrupt";
  projection: PersonalGlossaryCandidateProjection | null;
}

export interface PersonalGlossaryCandidateProjectionMaintenanceInput extends PersonalGlossaryCandidateProjectionStorageOptions {
  now: string;
  /** Set only after the local host has authenticated the current user's purge action. */
  current_user_purge_authorized?: boolean;
}

export interface PersonalGlossaryCandidateProjectionMaintenanceResult {
  status: "missing" | "corrupt" | "unchanged" | "changed" | "purged";
  expired_excerpts: number;
}
