import type { JsonObject } from "../core/jsonValue.js";
import { createGlossaryEvidenceCapsule } from "../registries/glossaryCandidateContracts.js";
import { personalGlossaryAdmissionContract } from "../registries/glossaryEntryContract.js";
import { PERSONAL_GLOSSARY_MINING_POLICY_VERSION } from "../registries/glossaryMiningAuthority.js";
import { stableGlossaryTermIdentity } from "../registries/glossaryTermIdentity.js";
import { assessTiers, recoveryForState } from "./extractCorpus/tierReader.js";
import {
  readSignalTier,
  resolveEvidenceAnchor,
  type EvidenceTierCompatibilityState,
  type SignalRecord,
} from "./extractCorpus/evidenceTiers.js";
import {
  EXPLICIT_GLOSSARY_REASONS,
  candidateBounds,
  compareText,
  dataObject,
  rawCues,
  retractionInvalidatesCue,
  utf8Span,
  validCue,
  type CandidateBounds,
  type CandidateWithSource,
  type ExplicitGlossaryAbstention,
  type ExplicitGlossaryMiningInput,
  type ExplicitGlossaryMiningResult,
  type ExplicitGlossaryReason,
  type RawCue,
  type ValidCue,
} from "./personalGlossaryExplicit.js";

const SHA256_RE = /^[a-f0-9]{64}$/u;

function recordText(record: JsonObject): string {
  const data = dataObject(record);
  for (const field of ["text", "prompt", "content"]) {
    if (typeof data[field] === "string") return data[field] as string;
  }
  return "";
}

function recordIsUserAuthored(signal: SignalRecord, record: JsonObject): boolean {
  const data = dataObject(record);
  return (
    (record.source_kind === "conversation_turn" || record.source_kind === "history_prompt") &&
    record.author_class === "user" &&
    (signal.author_class === undefined || signal.author_class === "user") &&
    data.actor !== "assistant" &&
    data.actor !== "agent" &&
    data.injected !== true &&
    record.source_class !== "injected"
  );
}

function makeAbstention(
  sourceId: string,
  anchor: string,
  reason: ExplicitGlossaryReason,
  term: string | null = null,
): ExplicitGlossaryAbstention {
  const cleanTerm = term && term.trim() ? term.trim() : null;
  return {
    term: cleanTerm,
    candidate_id: cleanTerm ? stableGlossaryTermIdentity(cleanTerm) : null,
    source_id: sourceId,
    evidence_anchor: anchor,
    reason,
  };
}

function compareAbstentions(
  left: ExplicitGlossaryAbstention,
  right: ExplicitGlossaryAbstention,
): number {
  return (
    compareText(left.source_id, right.source_id) ||
    compareText(left.evidence_anchor, right.evidence_anchor) ||
    compareText(left.term ?? "", right.term ?? "") ||
    compareText(left.reason, right.reason)
  );
}

function compareCandidates(left: CandidateWithSource, right: CandidateWithSource): number {
  return (
    compareText(left.candidate.capsule.term, right.candidate.capsule.term) ||
    compareText(left.candidate.capsule.meaning, right.candidate.capsule.meaning) ||
    compareText(left.sourceId, right.sourceId) ||
    compareText(left.anchor, right.anchor) ||
    left.cue.termStart - right.cue.termStart ||
    left.cue.meaningStart - right.cue.meaningStart
  );
}

function sameRecord(signal: SignalRecord, record: JsonObject): "valid" | "stale" {
  if (
    signal.evidence_anchor !== signal.source_id ||
    record.source_id !== signal.source_id ||
    record.source_kind !== signal.source_kind
  ) {
    return "stale";
  }
  const dataSignal = dataObject(record).signal_type;
  if (record.source_kind === "conversation_turn" && dataSignal !== signal.signal_type)
    return "stale";
  for (const field of [
    "origin_id",
    "content_fingerprint",
    "author_class",
    "session_id",
    "project_id",
  ] as const) {
    const expected = signal[field];
    if (expected !== undefined && record[field] !== expected) return "stale";
  }
  return "valid";
}

function provenanceValue(signal: SignalRecord, field: string): unknown {
  return field === "evidence_anchor" ? signal.evidence_anchor : signal[field as keyof SignalRecord];
}

function recordProvenanceValue(record: JsonObject, field: string): unknown {
  if (field === "evidence_anchor") return record.source_id;
  if (field === "signal_type") return dataObject(record).signal_type;
  return record[field];
}

function hasCompleteProvenance(
  signal: SignalRecord,
  record: JsonObject,
  requiredFields: readonly string[],
): boolean {
  if (requiredFields.length === 0 || signal.source_kind !== "conversation_turn") return false;
  for (const field of requiredFields) {
    const signalValue = provenanceValue(signal, field);
    const recordValue = recordProvenanceValue(record, field);
    if (typeof signalValue !== "string" || signalValue.length === 0) return false;
    if (typeof recordValue !== "string" || recordValue.length === 0) return false;
    if (signalValue !== recordValue) return false;
    if (
      (field === "origin_id" || field === "content_fingerprint") &&
      !SHA256_RE.test(signalValue)
    ) {
      return false;
    }
  }
  return true;
}

function unavailable(state: EvidenceTierCompatibilityState["state"]): ExplicitGlossaryMiningResult {
  return {
    state,
    generation: null,
    candidates: [],
    abstentions: [],
    recovery: recoveryForState(state),
  };
}

function candidateWithSource(
  signal: SignalRecord,
  cue: ValidCue,
  text: string,
  generation: string,
): CandidateWithSource {
  const capsule = createGlossaryEvidenceCapsule({
    term: cue.term,
    meaning: cue.meaning,
    scope: "personal",
    provenance_kind: "personal_explicit_definition",
    evidence: [
      {
        source_id: signal.source_id,
        evidence_anchor: signal.evidence_anchor,
        signal_type: signal.signal_type,
      },
    ],
    policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
    generation,
  });
  return {
    candidate: {
      capsule,
      term_span: utf8Span(text, cue.termStart, cue.termEnd),
      meaning_span: utf8Span(text, cue.meaningStart, cue.meaningEnd),
    },
    sourceId: signal.source_id,
    anchor: signal.evidence_anchor,
    identity: stableGlossaryTermIdentity(cue.term),
    meaning: cue.meaning,
    cue,
  };
}

function userCue(
  signal: SignalRecord,
  record: JsonObject,
  text: string,
  rawCue: RawCue,
  allCues: readonly RawCue[],
  bounds: CandidateBounds,
  generation: string,
): { candidate: CandidateWithSource | null; abstention: ExplicitGlossaryAbstention | null } {
  const result = validCue(text, rawCue, bounds, record);
  if (!result.cue) {
    return {
      candidate: null,
      abstention: result.reason
        ? makeAbstention(
            signal.source_id,
            signal.evidence_anchor,
            result.reason,
            text.slice(rawCue.termStart, rawCue.termEnd),
          )
        : null,
    };
  }
  const cue = result.cue;
  if (!recordIsUserAuthored(signal, record)) {
    return {
      candidate: null,
      abstention: makeAbstention(
        signal.source_id,
        signal.evidence_anchor,
        EXPLICIT_GLOSSARY_REASONS.userAuthorshipRequired,
        cue.term,
      ),
    };
  }
  if (retractionInvalidatesCue(text, cue, allCues)) {
    return {
      candidate: null,
      abstention: makeAbstention(
        signal.source_id,
        signal.evidence_anchor,
        EXPLICIT_GLOSSARY_REASONS.retractedDefinition,
        cue.term,
      ),
    };
  }
  return { candidate: candidateWithSource(signal, cue, text, generation), abstention: null };
}

function uniqueCandidateSources(candidates: readonly CandidateWithSource[]): CandidateWithSource[] {
  const unique = new Map<string, CandidateWithSource>();
  for (const item of candidates) {
    const key = `${item.identity}:${item.meaning}:${item.anchor}`;
    const previous = unique.get(key);
    if (!previous || compareCandidates(item, previous) < 0) unique.set(key, item);
  }
  return [...unique.values()].sort(compareCandidates);
}

function classifyRecord(
  signal: SignalRecord,
  record: JsonObject,
  generation: string,
  bounds: CandidateBounds,
  requiredProvenanceFields: readonly string[],
): { candidates: CandidateWithSource[]; abstentions: ExplicitGlossaryAbstention[] } {
  if (!hasCompleteProvenance(signal, record, requiredProvenanceFields)) {
    return {
      candidates: [],
      abstentions: [
        makeAbstention(
          signal.source_id,
          signal.evidence_anchor,
          EXPLICIT_GLOSSARY_REASONS.provenanceIncomplete,
        ),
      ],
    };
  }
  const text = recordText(record);
  const raw = rawCues(text);
  const candidates: CandidateWithSource[] = [];
  const abstentions: ExplicitGlossaryAbstention[] = [];
  const local = raw.map((cue) => userCue(signal, record, text, cue, raw, bounds, generation));
  for (const item of local) {
    if (item.abstention) abstentions.push(item.abstention);
    if (item.candidate) candidates.push(item.candidate);
  }
  const byIdentity = new Map<string, CandidateWithSource[]>();
  for (const item of candidates) {
    const group = byIdentity.get(item.identity) ?? [];
    group.push(item);
    byIdentity.set(item.identity, group);
  }
  const filtered: CandidateWithSource[] = [];
  for (const group of byIdentity.values()) {
    if (new Set(group.map((item) => item.meaning)).size > 1) {
      const first = [...group].sort(compareCandidates)[0]!;
      abstentions.push(
        makeAbstention(
          first.sourceId,
          first.anchor,
          EXPLICIT_GLOSSARY_REASONS.conflictingMeaning,
          first.candidate.capsule.term,
        ),
      );
      continue;
    }
    filtered.push([...group].sort(compareCandidates)[0]!);
  }
  return { candidates: filtered, abstentions };
}

export function mineExplicitGlossaryCandidates(
  input: ExplicitGlossaryMiningInput,
  resolveAnchor: (anchor: string, tiersDir: string) => JsonObject | null = resolveEvidenceAnchor,
): ExplicitGlossaryMiningResult {
  const assessment = assessTiers(input.tiersDir);
  if (!assessment.analyzable) return unavailable(assessment.state);
  const tier = readSignalTier(input.tiersDir, { allowProvenanceGaps: true });
  if (!tier) return unavailable("corrupt");
  const authority = personalGlossaryAdmissionContract();
  const allowedSignalTypes = new Set(authority.explicitSignalTypes);
  const selected = tier.records
    .filter((signal) => allowedSignalTypes.has(signal.signal_type))
    .sort(
      (left, right) =>
        compareText(left.source_id, right.source_id) ||
        compareText(left.evidence_anchor, right.evidence_anchor) ||
        compareText(left.signal_type, right.signal_type),
    );
  const bounds = candidateBounds();
  const resolvedByAnchor = new Map<string, JsonObject | null>();
  for (const signal of selected) {
    if (!resolvedByAnchor.has(signal.evidence_anchor)) {
      resolvedByAnchor.set(
        signal.evidence_anchor,
        resolveAnchor(signal.evidence_anchor, input.tiersDir),
      );
    }
  }

  const candidates: CandidateWithSource[] = [];
  const abstentions: ExplicitGlossaryAbstention[] = [];
  for (const signal of selected) {
    const record = resolvedByAnchor.get(signal.evidence_anchor) ?? null;
    if (!record) {
      abstentions.push(
        makeAbstention(
          signal.source_id,
          signal.evidence_anchor,
          EXPLICIT_GLOSSARY_REASONS.unresolvedAnchor,
        ),
      );
      continue;
    }
    if (sameRecord(signal, record) === "stale") {
      abstentions.push(
        makeAbstention(
          signal.source_id,
          signal.evidence_anchor,
          EXPLICIT_GLOSSARY_REASONS.staleAnchor,
        ),
      );
      continue;
    }
    const classified = classifyRecord(
      signal,
      record,
      tier.manifest.generation,
      bounds,
      authority.explicitProvenanceFields,
    );
    candidates.push(...classified.candidates);
    abstentions.push(...classified.abstentions);
  }
  const uniqueCandidates = uniqueCandidateSources(candidates);
  const globalGroups = new Map<string, CandidateWithSource[]>();
  for (const item of uniqueCandidates) {
    const group = globalGroups.get(item.identity) ?? [];
    group.push(item);
    globalGroups.set(item.identity, group);
  }
  const globallyEligible: CandidateWithSource[] = [];
  for (const group of globalGroups.values()) {
    const ordered = [...group].sort(compareCandidates);
    if (new Set(ordered.map((item) => item.meaning)).size > 1) {
      for (const item of ordered) {
        abstentions.push(
          makeAbstention(
            item.sourceId,
            item.anchor,
            EXPLICIT_GLOSSARY_REASONS.conflictingMeaning,
            item.candidate.capsule.term,
          ),
        );
      }
      continue;
    }
    globallyEligible.push(ordered[0]!);
  }
  return {
    state: assessment.state,
    generation: tier.manifest.generation,
    candidates: globallyEligible.sort(compareCandidates).map((item) => item.candidate),
    abstentions: abstentions.sort(compareAbstentions),
    recovery: null,
  };
}

export const minePersonalExplicitGlossaryCandidates = mineExplicitGlossaryCandidates;
export const mineExplicitGlossaryEvidence = mineExplicitGlossaryCandidates;
