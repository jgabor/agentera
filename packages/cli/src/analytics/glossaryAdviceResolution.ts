import type { AcquiredGlossaryInputs, ConsumerGlossaryEntry, GlossaryInputAvailability } from "./glossaryInputAcquisition.js";
import { glossaryAdviceContract, type GlossaryAdviceContract } from "../registries/glossaryAdviceContract.js";
import type { GlossaryOwner } from "../registries/glossaryEntryContract.js";
import { unicodeCaselessExact } from "../registries/glossaryTermIdentity.js";

export type GlossaryAdviceFailureClass = "invalid_request" | "invalid_acquisition" | "invalid_host_review";

export interface GlossaryAdviceHostReview {
  relation: "inferred_equivalence";
  candidate_owner: "personal";
  candidate_term: string;
}

export interface GlossaryAdvice {
  outcome: string;
  applicable_meaning: string | null;
  applicable_owner: GlossaryOwner | null;
  review: string;
  tension: string;
  advisory: { reason: string; ownership_state: string } | null;
}

export interface GlossaryAdviceSelectionState {
  project_input: string;
  personal_input: string;
  exact_meaning: string;
  inferred_candidate: string;
}

const RECOVERY: Record<GlossaryAdviceFailureClass, string> = {
  invalid_request: "Provide one non-empty bounded requested term and retry advice resolution.",
  invalid_acquisition: "Reacquire bounded glossary inputs and retry advice resolution.",
  invalid_host_review: "Provide one contract-declared relation to a valid acquired personal candidate and retry advice resolution.",
};

export class GlossaryAdviceInputError extends Error {
  constructor(public readonly code: GlossaryAdviceFailureClass) {
    super(RECOVERY[code]);
    this.name = "GlossaryAdviceInputError";
  }
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function boundedNonEmpty(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function validateEntries(source: GlossaryInputAvailability, owner: GlossaryOwner, maxEntries: number, maxBytes: number): void {
  if (!Array.isArray(source.entries) || source.entries.length > maxEntries) {
    throw new GlossaryAdviceInputError("invalid_acquisition");
  }
  const terms: string[] = [];
  for (const candidate of source.entries) {
    if (candidate === null || typeof candidate !== "object" || !hasOnlyKeys(candidate, ["term", "meaning", "owner"]) || candidate.owner !== owner || !boundedNonEmpty(candidate.term, maxBytes) || !boundedNonEmpty(candidate.meaning, maxBytes)) {
      throw new GlossaryAdviceInputError("invalid_acquisition");
    }
    if (terms.some((term) => unicodeCaselessExact(term, candidate.term))) {
      throw new GlossaryAdviceInputError("invalid_acquisition");
    }
    terms.push(candidate.term);
  }
}

function validateSource(source: unknown, owner: GlossaryOwner, maxEntries: number, maxBytes: number, availabilityStates: readonly string[]): asserts source is GlossaryInputAvailability {
  if (source === null || typeof source !== "object" || !hasOnlyKeys(source, ["owner", "availability", "entries", "gap_proving", "diagnostic"])) {
    throw new GlossaryAdviceInputError("invalid_acquisition");
  }
  const candidate = source as GlossaryInputAvailability;
  if (candidate.owner !== owner || !availabilityStates.includes(candidate.availability) || typeof candidate.gap_proving !== "boolean") {
    throw new GlossaryAdviceInputError("invalid_acquisition");
  }
  validateEntries(candidate, owner, maxEntries, maxBytes);

  const valid = ["absent", "valid_empty", "valid_present"].includes(candidate.availability);
  const expectedGap = owner === "project" && ["absent", "valid_empty"].includes(candidate.availability);
  if (valid) {
    const expectedEntryPresence = candidate.availability === "valid_present";
    if (candidate.diagnostic !== null || candidate.gap_proving !== expectedGap || expectedEntryPresence !== candidate.entries.length > 0) {
      throw new GlossaryAdviceInputError("invalid_acquisition");
    }
    return;
  }

  const diagnostic = candidate.diagnostic;
  if (candidate.entries.length !== 0 || candidate.gap_proving || diagnostic === null || typeof diagnostic !== "object" || !hasOnlyKeys(diagnostic, ["class", "recovery"]) || diagnostic.class !== candidate.availability || typeof diagnostic.recovery !== "string" || diagnostic.recovery.trim().length === 0) {
    throw new GlossaryAdviceInputError("invalid_acquisition");
  }
}

function validateAcquired(acquired: unknown, contract: GlossaryAdviceContract): asserts acquired is AcquiredGlossaryInputs {
  if (acquired === null || typeof acquired !== "object" || !hasOnlyKeys(acquired, ["project", "personal"])) {
    throw new GlossaryAdviceInputError("invalid_acquisition");
  }
  const candidate = acquired as AcquiredGlossaryInputs;
  validateSource(candidate.project, "project", contract.maxEntries, contract.maxRequestedTermUtf8Bytes, contract.availabilityStates);
  validateSource(candidate.personal, "personal", contract.maxEntries, contract.maxRequestedTermUtf8Bytes, contract.availabilityStates);
}

function exactEntry(entries: readonly ConsumerGlossaryEntry[], requestedTerm: string): ConsumerGlossaryEntry | undefined {
  return entries.find((candidate) => unicodeCaselessExact(candidate.term, requestedTerm));
}

function validatedHostReview(requestedTerm: string, personal: GlossaryInputAvailability, hostReview: unknown, contract: GlossaryAdviceContract): GlossaryAdviceHostReview | undefined {
  if (hostReview === undefined) return undefined;
  if (hostReview === null || typeof hostReview !== "object" || !hasOnlyKeys(hostReview, ["relation", "candidate_owner", "candidate_term"])) {
    throw new GlossaryAdviceInputError("invalid_host_review");
  }
  const candidate = hostReview as GlossaryAdviceHostReview;
  if (
    !contract.hostReviewRelations.includes(candidate.relation) ||
    !contract.hostReviewCandidateOwners.includes(candidate.candidate_owner) ||
    !boundedNonEmpty(candidate.candidate_term, contract.maxRequestedTermUtf8Bytes) ||
    unicodeCaselessExact(candidate.candidate_term, requestedTerm) ||
    !personal.entries.some((entry) => unicodeCaselessExact(entry.term, candidate.candidate_term))
  ) {
    throw new GlossaryAdviceInputError("invalid_host_review");
  }
  return candidate;
}

export function classifyGlossaryAdviceInputs(requestedTerm: string, acquired: AcquiredGlossaryInputs, hostReview?: GlossaryAdviceHostReview): GlossaryAdviceSelectionState {
  const projectExact = exactEntry(acquired.project.entries, requestedTerm);
  const personalExact = exactEntry(acquired.personal.entries, requestedTerm);
  const projectValid = ["absent", "valid_empty", "valid_present"].includes(acquired.project.availability);
  const personalUsable = ["valid_empty", "valid_present"].includes(acquired.personal.availability);
  return {
    project_input: !projectValid ? "invalid" : projectExact ? "valid_exact" : "valid_gap",
    personal_input: personalExact ? "valid_exact" : personalUsable ? "valid_without_exact" : "invalid",
    exact_meaning: projectExact && personalExact ? (projectExact.meaning === personalExact.meaning ? "equivalent" : "divergent") : "not_applicable",
    inferred_candidate: hostReview ? "present" : "absent",
  };
}

function matches(match: Record<string, string[]>, state: GlossaryAdviceSelectionState): boolean {
  return Object.entries(state).every(([dimension, value]) => match[dimension]?.includes(value));
}

export function resolveGlossaryAdvice(requestedTerm: string, acquired: AcquiredGlossaryInputs, hostReview?: GlossaryAdviceHostReview): GlossaryAdvice {
  const contract = glossaryAdviceContract();
  if (!boundedNonEmpty(requestedTerm, contract.maxRequestedTermUtf8Bytes)) {
    throw new GlossaryAdviceInputError("invalid_request");
  }
  validateAcquired(acquired, contract);
  const review = validatedHostReview(requestedTerm, acquired.personal, hostReview, contract);
  const state = classifyGlossaryAdviceInputs(requestedTerm, acquired, review);
  const rows = contract.rows.filter((row) => matches(row.match, state));
  if (rows.length !== 1) throw new GlossaryAdviceInputError("invalid_acquisition");
  const row = rows[0]!;
  const selectedOwner = row.selectedOwner === "project" || row.selectedOwner === "personal" ? row.selectedOwner : null;
  const selectedEntry = selectedOwner ? exactEntry(acquired[selectedOwner].entries, requestedTerm) : undefined;
  const advisories = contract.advisories.filter((advisory) => advisory.primaryOutcome === row.name && matches(advisory.match, state));
  if (advisories.length > 1) throw new GlossaryAdviceInputError("invalid_acquisition");
  const advisory = advisories[0];
  return {
    outcome: row.name,
    applicable_meaning: selectedEntry?.meaning ?? null,
    applicable_owner: selectedOwner,
    review: advisory?.review ?? row.review,
    tension: row.tension,
    advisory: advisory ? { reason: advisory.caveatReason, ownership_state: advisory.ownershipState } : null,
  };
}
