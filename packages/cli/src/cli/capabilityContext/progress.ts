import { asList } from "../stateQuery.js";
import {
  evaluatorHandoffOutputRequirements,
  loadEvaluatorHandoffContract,
} from "../../registries/evaluatorHandoffContract.js";
import { capabilityInstructionContractPath } from "./contract.js";
import { hasRecordedValue, isFile, sourceProvenance, taskRef } from "./shared.js";
import type { Dict } from "./types.js";

export function progressVerificationSummary(progress: Dict): Dict {
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
  const cycle: Dict = {};
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

export function retryState(): Dict {
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

export function evaluatorHandoffOutputRequirementsFromContract(): Dict {
  const contractPath = capabilityInstructionContractPath();
  if (!isFile(contractPath)) return {};
  try {
    const contract = loadEvaluatorHandoffContract(contractPath);
    return evaluatorHandoffOutputRequirements(contract);
  } catch {
    return {};
  }
}

export function evaluatorHandoff(selected: Dict | null, progressVerification: Dict, retry: Dict, stateCaveats: string[]): Dict {
  const caveats = [...stateCaveats, ...(progressVerification.caveats ?? []), ...(retry.caveats ?? [])];
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
  const evidenceRequirements = (selected.evidence_summary?.items ?? []) as any[];
  if (evidenceRequirements.length === 0) {
    caveats.push("Selected task has no explicit evidence requirements recorded in plan state.");
  }
  return {
    status: "ready",
    task: taskRef(selected),
    acceptance_criteria: selected.acceptance_summary?.items ?? [],
    evidence_requirements: evidenceRequirements,
    latest_progress_verification_pointer: progressVerification.latest_progress_verification_pointer ?? null,
    evaluation_caveats: caveats,
    output_requirements: outputRequirements,
  };
}
