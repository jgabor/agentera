import path from "node:path";

import { resolveSourceRoot } from "../core/sourceRoot.js";
import { evaluateGlossaryHoldout } from "../eval/glossaryEvaluation.js";
import {
  createGlossaryAdmissionDecision,
  validateGlossaryHostClassificationReceipt,
  type GlossaryAdmissionDecision,
  type GlossaryAdmissionReason,
  type GlossaryEvidenceCapsule,
  type GlossaryHostClassificationReceipt,
} from "../registries/glossaryCandidateContracts.js";
import {
  readPersonalGlossaryCandidateProjection,
  type PersonalGlossaryCandidateProjectionStorageOptions,
  type ProjectedPersonalGlossaryCandidate,
} from "./personalGlossaryCandidateProjection.js";
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
): ExplicitEvidenceState {
  const mined = mineExplicitGlossaryCandidates({ tiersDir });
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

function qualityGate(sourceRoot: string): "pass" | "fail" | "unavailable" {
  try {
    const report = mapping(
      evaluateGlossaryHoldout(
        sourceRoot,
        path.join(sourceRoot, "references", "analysis", "personal-glossary-observations.yaml"),
      ),
    );
    const gates = mapping(report?.gates);
    const explicit = mapping(gates?.explicit_admission);
    return gates?.release_authorizing === "pass" && explicit?.status === "pass"
      ? "pass"
      : "fail";
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
export function decidePersonalGlossaryCandidate(
  receiptInput: unknown,
  options: PersonalGlossaryDecisionOptions = {},
): PersonalGlossaryAdmissionResult {
  let read;
  try {
    read = readPersonalGlossaryCandidateProjection(options);
  } catch {
    return result("abstain", "projection_unavailable");
  }
  if (read.status !== "current" || read.projection === null) {
    return result("abstain", "projection_unavailable");
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

  const gate = qualityGate(options.sourceRoot ?? resolveSourceRoot());
  if (gate !== "pass") {
    return decision(capsule, receipt, "review_required", "quality_gate_not_authorizing");
  }
  return decision(capsule, receipt, "automatic_admission", "explicit_current_authorized");
}
