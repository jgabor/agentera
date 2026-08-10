import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { runGlossaryEvaluationProcess } from "../eval/glossaryEvaluationProcess.js";
import { validateGlossaryEvaluationSuccessReport } from "../eval/glossaryEvaluationSuccessReport.js";
import {
  createGlossaryAdmissionDecision,
  validateGlossaryHostClassificationReceipt,
  type GlossaryAdmissionDecision,
  type GlossaryAdmissionReason,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
} from "../registries/glossaryCandidateContracts.js";
import {
  type PersonalGlossaryCandidateProjectionStorageOptions,
  type ProjectedPersonalGlossaryCandidate,
} from "./personalGlossaryCandidateProjection.js";
import {
  readCurrentPersonalGlossaryCandidateProjection,
  type PersonalGlossaryCurrentGenerationResult,
} from "./personalGlossaryCurrentGeneration.js";
import { defaultTiersDir } from "./extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "./personalGlossaryExplicitMining.js";

type Mapping = Record<string, unknown>;

export type PersonalGlossaryAdmissionStatus =
  | "automatic_admission"
  | "review_required"
  | "abstain";

export interface PersonalGlossaryAdmissionResult {
  schemaVersion: "agentera.personalGlossaryAdmissionResult.v1";
  command: "report personal-glossary-decision";
  status: PersonalGlossaryAdmissionStatus;
  decision: GlossaryAdmissionDecision | null;
  reason: string;
  effects: [];
}

export interface PersonalGlossaryDecisionOptions
  extends PersonalGlossaryCandidateProjectionStorageOptions {
  tiersDir?: string;
  sourceRoot?: string;
}

type ExplicitEvidenceState =
  | "current"
  | "unavailable"
  | "changed"
  | "retracted_or_conflicted";

const QUALITY_GATE_CACHE_LIMIT = 16;
const qualityGateCache = new Map<string, { fingerprint: string; status: "pass" | "fail" | "unavailable" }>();

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function result(
  status: PersonalGlossaryAdmissionStatus,
  reason: string,
  decision: GlossaryAdmissionDecision | null = null,
): PersonalGlossaryAdmissionResult {
  return {
    schemaVersion: "agentera.personalGlossaryAdmissionResult.v1",
    command: "report personal-glossary-decision",
    status,
    decision,
    reason,
    effects: [],
  };
}

function exactCandidate(
  candidates: readonly ProjectedPersonalGlossaryCandidate[],
  receipt: Mapping,
): ProjectedPersonalGlossaryCandidate | null {
  const candidateId = receipt.candidate_id;
  if (typeof candidateId !== "string") return null;
  const sameIdentity = candidates.filter(
    (candidate) => candidate.capsule.candidate_id === candidateId,
  );
  const exact = sameIdentity.filter(
    (candidate) =>
      candidate.capsule.candidate_revision === receipt.candidate_revision &&
      candidate.capsule.capsule_sha256 === receipt.candidate_capsule_sha256 &&
      candidate.capsule.generation === receipt.generation &&
      candidate.capsule.policy_version === receipt.policy_version,
  );
  if (exact.length === 1) return exact[0]!;
  return sameIdentity.length === 1 ? sameIdentity[0]! : null;
}

function hasEntryConflict(
  candidates: readonly ProjectedPersonalGlossaryCandidate[],
  capsule: GlossaryEvidenceCapsule,
): boolean {
  return candidates.some(
    ({ capsule: other }) =>
      other.candidate_id === capsule.candidate_id &&
      other.candidate_revision !== capsule.candidate_revision &&
      (other.meaning !== capsule.meaning ||
        other.scope !== capsule.scope ||
        other.provenance_kind !== capsule.provenance_kind),
  );
}

function currentExplicitEvidence(
  capsule: GlossaryEvidenceCapsule,
  tiersDir: string,
  precomputed?: ReturnType<typeof mineExplicitGlossaryCandidates>,
): ExplicitEvidenceState {
  const mined = precomputed ?? mineExplicitGlossaryCandidates({ tiersDir });
  if (mined.state !== "current") return "unavailable";
  if (mined.generation !== capsule.generation) return "changed";
  if (
    mined.candidates.some(
      ({ capsule: current }) =>
        current.candidate_revision === capsule.candidate_revision &&
        current.capsule_sha256 === capsule.capsule_sha256,
    )
  ) {
    return "current";
  }
  if (
    mined.abstentions.some(
      (item) =>
        item.candidate_id === capsule.candidate_id &&
        ["retracted_definition", "conflicting_meaning"].includes(item.reason),
    )
  ) {
    return "retracted_or_conflicted";
  }
  return "changed";
}

function qualityGateFingerprint(sourceRoot: string): string | null {
  const digest = crypto.createHash("sha256");
  try {
    for (const relative of [
      "references/analysis/personal-glossary-evaluation-authority.yaml",
      "references/analysis/personal-glossary-holdout.yaml",
      "references/analysis/personal-glossary-evaluation-corpus.yaml",
      "references/analysis/evidence-tier-authority.yaml",
      "references/artifacts/glossary-entry-contract.yaml",
    ]) {
      digest.update(relative).update("\0").update(fs.readFileSync(path.join(sourceRoot, relative))).update("\0");
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

function qualityGate(sourceRoot: string): "pass" | "fail" | "unavailable" {
  try {
    const fingerprint = qualityGateFingerprint(sourceRoot);
    const cached = fingerprint === null ? undefined : qualityGateCache.get(sourceRoot);
    if (cached?.fingerprint === fingerprint) return cached.status;
    const evaluation = runGlossaryEvaluationProcess(sourceRoot);
    const status = validateGlossaryEvaluationSuccessReport(evaluation, sourceRoot) !== null
      ? "pass"
      : "fail";
    if (fingerprint !== null && status === "pass") {
      qualityGateCache.set(sourceRoot, { fingerprint, status });
      if (qualityGateCache.size > QUALITY_GATE_CACHE_LIMIT) {
        qualityGateCache.delete(qualityGateCache.keys().next().value!);
      }
    }
    return status;
  } catch {
    return "unavailable";
  }
}

function decision(
  capsule: GlossaryEvidenceCapsule,
  receipt: Mapping,
  outcome: PersonalGlossaryAdmissionStatus,
  reason: GlossaryAdmissionReason,
): PersonalGlossaryAdmissionResult {
  try {
    const value = createGlossaryAdmissionDecision({
      capsule,
      receipt: receipt as GlossaryHostClassificationReceipt,
      outcome,
      reason,
    });
    return result(outcome, reason, value);
  } catch {
    return result("abstain", "decision_validation_failed");
  }
}

/**
 * Validate one untrusted host classification against current private evidence and
 * derive its only permitted admission outcome. This function never persists a
 * review, profile entry, projection, or project artifact.
 */
function decidePersonalGlossaryCandidateInternal(
  receiptInput: unknown,
  options: PersonalGlossaryDecisionOptions,
  evaluationQualityGate: boolean,
  precomputedExplicitMining?: ReturnType<typeof mineExplicitGlossaryCandidates>,
  precomputedCurrentProjection?: PersonalGlossaryCurrentGenerationResult,
): PersonalGlossaryAdmissionResult {
  let read = precomputedCurrentProjection;
  if (read === undefined) {
    try {
      read = readCurrentPersonalGlossaryCandidateProjection(options);
    } catch {
      return result("abstain", "projection_unavailable");
    }
  }
  if (read.status !== "current" || read.projection === null) {
    return result(
      "abstain",
      read.status === "current_generation_unavailable"
        ? "current_generation_unavailable"
        : read.status === "projection_stale"
          ? "projection_stale"
          : "projection_unavailable",
    );
  }
  const receipt = mapping(receiptInput);
  if (!receipt) return result("abstain", "receipt_invalid");
  const selected = exactCandidate(read.projection.candidates, receipt);
  if (!selected) return result("abstain", "candidate_unavailable");
  const capsule = selected.capsule;
  const receiptErrors = validateGlossaryHostClassificationReceipt(receipt, capsule, {
    candidateProjectionSha256: read.projection.projection_sha256,
  });
  if (receiptErrors.length > 0) {
    return result(
      "abstain",
      receiptErrors.includes(
        "host_classification_receipt.candidate_projection_sha256 does not match the current projection",
      )
        ? "projection_changed"
        : "receipt_invalid",
    );
  }

  const classification = mapping(receipt.classification)!;
  if (capsule.scope === "project" || classification.scope === "project") {
    return decision(capsule, receipt, "abstain", "scope_project");
  }
  if (capsule.scope !== "personal" || classification.scope !== "personal") {
    return decision(capsule, receipt, "review_required", "scope_ambiguous");
  }
  if (classification.consistency === "inconsistent") {
    return decision(capsule, receipt, "review_required", "classification_inconsistent");
  }
  if (
    classification.consistency !== "consistent" ||
    classification.term !== capsule.term ||
    classification.meaning !== capsule.meaning
  ) {
    return decision(capsule, receipt, "review_required", "classification_changed");
  }
  if (hasEntryConflict(read.projection.candidates, capsule)) {
    return decision(capsule, receipt, "review_required", "entry_conflict");
  }
  if (capsule.provenance_kind !== "personal_explicit_definition") {
    return decision(capsule, receipt, "review_required", "inferred_requires_review");
  }

  const evidence = currentExplicitEvidence(
    capsule,
    options.tiersDir ?? defaultTiersDir(options.env, options.platform),
    precomputedExplicitMining,
  );
  if (evidence === "unavailable") {
    return decision(capsule, receipt, "abstain", "evidence_unavailable");
  }
  if (evidence === "changed") {
    return decision(capsule, receipt, "abstain", "evidence_changed");
  }
  if (evidence === "retracted_or_conflicted") {
    return decision(capsule, receipt, "review_required", "evidence_retracted_or_conflicted");
  }

  const gate = evaluationQualityGate ? "pass" : qualityGate(options.sourceRoot ?? resolveSourceRoot());
  if (gate !== "pass") {
    return decision(capsule, receipt, "review_required", "quality_gate_not_authorizing");
  }
  return decision(capsule, receipt, "automatic_admission", "explicit_current_authorized");
}

/** Apply the release-authorizing quality report before an explicit admission. */
export function decidePersonalGlossaryCandidate(
  receiptInput: unknown,
  options: PersonalGlossaryDecisionOptions = {},
): PersonalGlossaryAdmissionResult {
  return decidePersonalGlossaryCandidateInternal(receiptInput, options, false);
}

/**
 * Exercise the same bounded decision boundary while measuring the prerequisite
 * explicit policy. This internal evaluator seam is never wired to CLI dispatch;
 * inferred candidates still return review_required before the quality branch.
 */
export function evaluatePersonalGlossaryCandidate(
  receiptInput: unknown,
  options: PersonalGlossaryDecisionOptions = {},
  precomputedExplicitMining?: ReturnType<typeof mineExplicitGlossaryCandidates>,
  precomputedCurrentProjection?: PersonalGlossaryCurrentGenerationResult,
): PersonalGlossaryAdmissionResult {
  return decidePersonalGlossaryCandidateInternal(
    receiptInput,
    options,
    true,
    precomputedExplicitMining,
    precomputedCurrentProjection,
  );
}
