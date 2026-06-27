import { asList } from "../stateQuery.js";
import {
  evaluatorHandoffOutputRequirements,
  loadEvaluatorHandoffContract,
} from "../../registries/evaluatorHandoffContract.js";
import { capabilityInstructionContractPath } from "./contract.js";
import { hasRecordedValue, isFile, sourceProvenance, taskRef } from "./shared.js";
import type { JsonObject } from "../../core/jsonValue.js";

export function progressVerificationSummary(progress: JsonObject): JsonObject {
  const source = { source_family: "progress", command: "agentera progress --format json" };
  if (!progress.exists) {
    return {
      status: "unavailable",
      source_provenance: source,
      cycle: null,
      verified_present: false,
      non_empty_evidence_present: false,
      non_empty_evidence_fields: [],
      verified: null,
      verification_summary: null,
      latest_progress_verification_pointer: null,
      caveats: ["No progress cycles are recorded in CLI progress state."],
    };
  }
  const latest = progress.latest && typeof progress.latest === "object" && !Array.isArray(progress.latest) ? progress.latest : {};
  const verified = latest.verified;
  const verifiedPresent = hasRecordedValue(verified);
  const cycle: JsonObject = {};
  for (const key of ["number", "timestamp", "type", "phase"]) {
    if (latest[key] !== null && latest[key] !== undefined && latest[key] !== "") cycle[key] = latest[key];
  }
  const pointer = { ...source, cycle_number: latest.number ?? null, field: "verified" };
  const caveats = verifiedPresent ? [] : ["Latest progress cycle has no non-empty verified evidence."];
  const evidenceFields = verifiedPresent ? ["verified"] : [];
  return {
    status: "available",
    source_provenance: source,
    cycle,
    verified_present: verifiedPresent,
    non_empty_evidence_present: verifiedPresent,
    non_empty_evidence_fields: evidenceFields,
    verified: verifiedPresent ? verified : null,
    verification_summary: verifiedPresent ? verified : null,
    latest_progress_verification_pointer: pointer,
    caveats,
  };
}

export function retryState(): JsonObject {
  return {
    status: "not_recorded",
    source_provenance: {
      source_family: "progress",
      command: "agentera progress --format json",
      reason: "Current CLI/artifact state records progress cycles but no retry attempt state for orchestration tasks.",
    },
    caveats: ["Retry attempt state is not recorded; no attempt count is exposed."],
  };
}

export function evaluatorHandoffOutputRequirementsFromContract(): JsonObject {
  const contractPath = capabilityInstructionContractPath();
  if (!isFile(contractPath)) return {};
  try {
    const contract = loadEvaluatorHandoffContract(contractPath);
    // cast: contract loaded from parsed capability-instruction-contract.yaml; registry returns Record<string,unknown>
    return evaluatorHandoffOutputRequirements(contract) as unknown as JsonObject;
  } catch {
    return {};
  }
}

export function evaluatorHandoff(selected: JsonObject | null, progressVerification: JsonObject, retry: JsonObject, stateCaveats: string[]): JsonObject {
  const caveats = [...stateCaveats, ...((progressVerification.caveats ?? []) as string[]), ...((retry.caveats ?? []) as string[])];
  const outputRequirements = evaluatorHandoffOutputRequirementsFromContract();
  if (selected === null) {
    caveats.push("No dependency-ready task is selected for evaluator handoff.");
    return {
      status: "unavailable",
      task: null,
      acceptance_criteria: [],
      evidence_requirements: [],
      latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
      evaluation_caveats: caveats,
      output_requirements: outputRequirements,
    };
  }
  const evidenceSummary =
    selected.evidence_summary && typeof selected.evidence_summary === "object" && !Array.isArray(selected.evidence_summary)
      ? (selected.evidence_summary as JsonObject)
      : null;
  const evidenceRequirements = (evidenceSummary?.items ?? []) as any[];
  if (evidenceRequirements.length === 0) {
    caveats.push("Selected task has no explicit evidence requirements recorded in plan state.");
  }
  const acceptanceSummary =
    selected.acceptance_summary && typeof selected.acceptance_summary === "object" && !Array.isArray(selected.acceptance_summary)
      ? (selected.acceptance_summary as JsonObject)
      : null;
  return {
    status: "ready",
    task: taskRef(selected),
    acceptance_criteria: acceptanceSummary?.items ?? [],
    evidence_requirements: evidenceRequirements,
    latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
    evaluation_caveats: caveats,
    output_requirements: outputRequirements,
  };
}
