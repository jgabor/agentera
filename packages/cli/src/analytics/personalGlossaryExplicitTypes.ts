import type { GlossaryEvidenceCapsule } from "../registries/glossaryCandidateContracts.js";
import type { EvidenceTierCompatibilityState } from "./extractCorpus/evidenceTiers.js";

export const EXPLICIT_GLOSSARY_REASONS = {
  attributedQuotation: "attributed_quotation",
  ambiguousReference: "ambiguous_reference",
  conflictingMeaning: "conflicting_meaning",
  emptyMeaning: "empty_meaning",
  emptyTerm: "empty_term",
  exampleContext: "example_context",
  hypotheticalDefinition: "hypothetical_definition",
  malformedSpan: "malformed_span",
  meaningBoundExceeded: "meaning_bound_exceeded",
  negatedDefinition: "negated_definition",
  indirectQuestion: "indirect_question",
  futureDefinition: "future_definition",
  projectOnlyScope: "project_only_scope",
  questionDefinition: "question_definition",
  retractedDefinition: "retracted_definition",
  sarcasmMarker: "sarcasm_marker",
  staleAnchor: "stale_anchor",
  structuralFragment: "structural_fragment",
  termBoundExceeded: "term_bound_exceeded",
  unsafeSyntax: "unsafe_syntax",
  uncertainScope: "uncertain_scope",
  unresolvedAnchor: "unresolved_anchor",
  provenanceIncomplete: "provenance_incomplete",
  userAuthorshipRequired: "user_authorship_required",
} as const;

export type ExplicitGlossaryReason =
  (typeof EXPLICIT_GLOSSARY_REASONS)[keyof typeof EXPLICIT_GLOSSARY_REASONS];

export interface ExplicitGlossarySpan {
  start: number;
  end: number;
}

export interface ExplicitGlossaryCue {
  term: string;
  meaning: string;
  term_span: ExplicitGlossarySpan;
  meaning_span: ExplicitGlossarySpan;
}

export interface ExplicitGlossaryCandidate {
  capsule: GlossaryEvidenceCapsule;
  term_span: ExplicitGlossarySpan;
  meaning_span: ExplicitGlossarySpan;
  /** Transient source labels for bounded candidate-projection diversity. */
  project_ids: string[];
}

export interface ExplicitGlossaryAbstention {
  term: string | null;
  candidate_id: string | null;
  source_id: string;
  evidence_anchor: string;
  reason: ExplicitGlossaryReason;
}

export interface ExplicitGlossaryMiningInput {
  tiersDir: string;
}

export interface ExplicitGlossaryMiningResult {
  state: EvidenceTierCompatibilityState["state"];
  generation: string | null;
  candidates: ExplicitGlossaryCandidate[];
  abstentions: ExplicitGlossaryAbstention[];
  recovery: string | null;
}

export interface RawCue {
  kind: string;
  termStart: number;
  termEnd: number;
  meaningStart: number;
  meaningEnd: number;
  sentenceStart: number;
  sentenceEnd: number;
  rejectionReason?: ExplicitGlossaryReason;
}

export interface ValidCue extends RawCue {
  term: string;
  meaning: string;
}

export interface CandidateWithSource {
  candidate: ExplicitGlossaryCandidate;
  sourceId: string;
  anchor: string;
  identity: string;
  meaning: string;
  cue: ValidCue;
}

export interface CandidateBounds {
  term: number;
  meaning: number;
  binding: number;
}
