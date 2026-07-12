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

export function retryState(selected: JsonObject | null = null, tasks: JsonObject[] = []): JsonObject {
  const task =
    selected ??
    tasks.find((candidate) => {
      const evaluation = candidate.evaluation;
      return Boolean(evaluation && typeof evaluation === "object" && !Array.isArray(evaluation));
    }) ??
    null;
  const evaluation =
    task && task.evaluation_state && typeof task.evaluation_state === "object" && !Array.isArray(task.evaluation_state)
      ? (task.evaluation_state as JsonObject)
      : task && task.evaluation && typeof task.evaluation === "object" && !Array.isArray(task.evaluation)
        ? (task.evaluation as JsonObject)
        : null;
  const source = {
    source_family: "plan",
    command: "agentera state plan record-evaluation --task N --attempt-id ID --verdict {pass,fail}",
  };
  if (evaluation) {
    const attemptCount = Number(evaluation.attempt_count ?? 0);
    const failureCount = Number(evaluation.failure_count ?? 0);
    const exhausted = failureCount >= 2;
    return {
      status: exhausted ? "exhausted" : "recorded",
      task: taskRef(task as JsonObject),
      attempt_count: Number.isInteger(attemptCount) ? attemptCount : null,
      failure_count: Number.isInteger(failureCount) ? failureCount : null,
      retry_budget: 2,
      last_verdict: evaluation.last_verdict ?? null,
      failure_evidence: evaluation.last_failure_evidence ?? null,
      provenance: evaluation.provenance ?? null,
      source_provenance: source,
      caveats: exhausted ? ["Evaluation retry budget is exhausted; the task is blocked."] : [],
    };
  }
  return {
    status: "not_recorded",
    task: task ? taskRef(task) : null,
    attempt_count: 0,
    failure_count: 0,
    retry_budget: 2,
    last_verdict: null,
    failure_evidence: null,
    provenance: null,
    source_provenance: source,
    caveats: [],
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
