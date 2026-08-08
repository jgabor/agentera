import type { JsonObject } from "../core/jsonValue.js";
import { personalGlossaryAdmissionContract } from "../registries/glossaryEntryContract.js";
import {
  readSignalTier,
  resolveEvidenceAnchor,
  type EvidenceTierCompatibilityState,
  type SignalRecord,
} from "./extractCorpus/evidenceTiers.js";
import { assessTiers, recoveryForState } from "./extractCorpus/tierReader.js";

export interface ExplicitGlossaryCandidate {
  kind: "personal_explicit_definition";
  term: string;
  meaning: string;
  evidence: Array<{ source_id: string; evidence_anchor: string; signal_type: string }>;
}

export interface InferredGlossaryCandidate {
  kind: "personal_inferred_usage";
  term: string;
  evidence: Array<{ source_id: string; evidence_anchor: string; source_kind: string }>;
}

export type PersonalGlossaryCandidate = ExplicitGlossaryCandidate | InferredGlossaryCandidate;

export interface PersonalGlossaryAdmissionResult {
  state: EvidenceTierCompatibilityState["state"];
  status: "admitted" | "insufficient" | "unavailable";
  candidates: PersonalGlossaryCandidate[];
  recovery: string | null;
}

export interface PersonalGlossaryAdmissionInput {
  tiersDir: string;
  corpusPath?: string;
  requestedTerms: string[];
}

type AnchorResolver = (anchor: string, tiersDir: string) => JsonObject | null;

function trimMeaning(value: string): string {
  return value
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

/** Classify only authority-supported explicit correction or clarification forms. */
export function classifyExplicitGlossaryLanguage(
  text: string,
): { term: string; meaning: string } | null {
  const correction =
    /\b(?:actually|not quite|instead|correction)\b[^`"']*([`"'])([^`"']+)\1\s+means\s+(.+)$/i.exec(
      text,
    );
  const clarification = /\bto clarify\b.*?\bprefer\s+([`"'])([^`"']+)\1\s+to mean\s+(.+)$/i.exec(
    text,
  );
  const match = correction ?? clarification;
  if (!match) return null;
  const term = match[2].trim();
  const meaning = trimMeaning(match[3]);
  return term && meaning ? { term, meaning } : null;
}

function recordText(record: JsonObject): string {
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const object = data as JsonObject;
  for (const field of ["text", "prompt", "content"]) {
    if (typeof object[field] === "string") return object[field];
  }
  return "";
}

function semanticValues(record: JsonObject): string[] {
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const object = data as JsonObject;
  if (record.source_kind === "instruction_document") {
    return typeof object.content === "string" ? [object.content] : [];
  }
  if (record.source_kind === "project_config_signal") {
    return Array.isArray(object.signals)
      ? object.signals.filter((value): value is string => typeof value === "string")
      : [];
  }
  return [];
}

function containsCompleteTerm(text: string, term: string): boolean {
  // Personal admission intentionally classifies case-insensitive prose signals;
  // it is not project terminology's exact-case source occurrence contract.
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.length > 0 && new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
}

function hasInferredProvenance(signal: SignalRecord): boolean {
  return (
    /^[a-f0-9]{64}$/.test(signal.origin_id ?? "") &&
    /^[a-f0-9]{64}$/.test(signal.content_fingerprint ?? "")
  );
}

function unavailable(
  state: EvidenceTierCompatibilityState["state"],
): PersonalGlossaryAdmissionResult {
  return { state, status: "unavailable", candidates: [], recovery: recoveryForState(state) };
}

/**
 * Admit personal glossary evidence from one bounded signal read and direct
 * resolution of selected anchors only. Profile rendering and persistence are
 * deliberately outside this partial producer boundary.
 */
export function admitPersonalGlossaryEvidence(
  input: PersonalGlossaryAdmissionInput,
  resolveAnchor: AnchorResolver = resolveEvidenceAnchor,
): PersonalGlossaryAdmissionResult {
  const authority = personalGlossaryAdmissionContract();
  const assessment = assessTiers(input.tiersDir, input.corpusPath);
  if (!assessment.analyzable) return unavailable(assessment.state);

  const tier = readSignalTier(input.tiersDir);
  if (!tier) return unavailable("corrupt");

  const explicitTypes = new Set(authority.explicitSignalTypes);
  const inferredTypes = new Set(authority.inferredSignalTypes);
  const inferredKinds = new Set(authority.inferredSourceKinds);
  const selected = tier.records.filter(
    (signal) =>
      explicitTypes.has(signal.signal_type) ||
      (input.requestedTerms.length > 0 &&
        inferredTypes.has(signal.signal_type) &&
        inferredKinds.has(signal.source_kind)),
  );
  const resolved = new Map<string, { signal: SignalRecord; record: JsonObject }>();
  for (const signal of selected) {
    if (resolved.has(signal.evidence_anchor)) continue;
    const record = resolveAnchor(signal.evidence_anchor, input.tiersDir);
    if (
      record &&
      record.source_id === signal.source_id &&
      record.source_kind === signal.source_kind
    ) {
      resolved.set(signal.evidence_anchor, { signal, record });
    }
  }

  const candidates: PersonalGlossaryCandidate[] = [];
  for (const { signal, record } of resolved.values()) {
    if (!explicitTypes.has(signal.signal_type)) continue;
    const classified = classifyExplicitGlossaryLanguage(recordText(record));
    if (!classified) continue;
    candidates.push({
      kind: "personal_explicit_definition",
      ...classified,
      evidence: [
        {
          source_id: signal.source_id,
          evidence_anchor: signal.evidence_anchor,
          signal_type: signal.signal_type,
        },
      ],
    });
  }

  for (const term of new Set(input.requestedTerms.map((value) => value.trim()).filter(Boolean))) {
    const evidence = [...resolved.values()]
      .filter(
        ({ signal, record }) =>
          inferredTypes.has(signal.signal_type) &&
          inferredKinds.has(signal.source_kind) &&
          hasInferredProvenance(signal) &&
          semanticValues(record).some((value) => containsCompleteTerm(value, term)),
      )
      .map(({ signal }) => ({
        source_id: signal.source_id,
        evidence_anchor: signal.evidence_anchor,
        source_kind: signal.source_kind,
      }))
      .filter(
        (item, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.source_id === item.source_id ||
              candidate.evidence_anchor === item.evidence_anchor,
          ) === index,
      )
      .sort((left, right) => left.source_id.localeCompare(right.source_id));
    if (
      evidence.length === 2 &&
      new Set(evidence.map((item) => item.source_id)).size === 2 &&
      new Set(evidence.map((item) => item.evidence_anchor)).size === 2
    ) {
      candidates.push({ kind: "personal_inferred_usage", term, evidence });
    }
  }

  return candidates.length > 0
    ? { state: assessment.state, status: "admitted", candidates, recovery: null }
    : {
        state: assessment.state,
        status: "insufficient",
        candidates: [],
        recovery: authority.insufficientRecovery,
      };
}

export {
  mineRecurringGlossaryCandidates,
  mineRecurringGlossaryEvidence,
  PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
  RECURRING_MEANING_PENDING_REVIEW,
  RECURRING_REASONS,
  type RecurringAbstentionReason,
  type RecurringGlossaryAbstention,
  type RecurringGlossaryCandidate,
  type RecurringGlossaryMiningInput,
  type RecurringGlossaryMiningResult,
  type RecurringReviewReason,
} from "./personalGlossaryRecurrence.js";
