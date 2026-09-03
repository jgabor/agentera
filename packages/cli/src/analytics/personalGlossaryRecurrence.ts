import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath, personalGlossaryAdmissionContract, type GlossaryAdmissionContext, type GlossaryConversationEvidenceExpectation, type RetainedEvidence } from "../registries/glossaryEntryContract.js";
import { createGlossaryEvidenceCapsule, type GlossaryEvidenceCapsule } from "../registries/glossaryCandidateContracts.js";
import { PERSONAL_GLOSSARY_MINING_POLICY_VERSION, validateConversationProvenance } from "../registries/glossaryMiningAuthority.js";
import { compareGlossaryUnicodeStrings, stableGlossaryTermIdentity } from "../registries/glossaryTermIdentity.js";
import { readSignalTier, resolveEvidenceAnchor, type EvidenceTierCompatibilityState, type SignalRecord } from "./extractCorpus/evidenceTiers.js";
import { assessTiers, recoveryForState } from "./extractCorpus/tierReader.js";
import { classifyRecurringLexicalToken } from "./personalGlossaryLexicalClassifier.js";

type Mapping = Record<string, unknown>;

/** The only semantic text put in a recurrence capsule before host review. */
export const RECURRING_MEANING_PENDING_REVIEW = "meaning pending semantic review";

export const RECURRING_REASONS = {
  agentOnlyEvidence: "agent_only_evidence",
  copiedContent: "copied_content",
  provenanceMissing: "provenance_missing",
  insufficientIndependentOrigins: "insufficient_independent_origins",
  insufficientProjects: "insufficient_projects",
  insufficientSessions: "insufficient_sessions",
  conversationEvidenceIncomplete: "conversation_evidence_incomplete",
  conversationEvidenceBoundExceeded: "conversation_evidence_bound_exceeded",
  projectOnlyScope: "project_only_scope",
  noiseTerm: "noise_term",
  tooManyQualifyingOrigins: "too_many_qualifying_origins",
  userAuthorshipRequired: "user_authorship_required",
  conflictingMeaning: "conflicting_meaning",
  uncertainScope: "uncertain_scope",
  inferredUsageRequiresReview: "inferred_usage_requires_review",
} as const;

export type RecurringAbstentionReason =
  | typeof RECURRING_REASONS.agentOnlyEvidence
  | typeof RECURRING_REASONS.copiedContent
  | typeof RECURRING_REASONS.provenanceMissing
  | typeof RECURRING_REASONS.insufficientIndependentOrigins
  | typeof RECURRING_REASONS.insufficientProjects
  | typeof RECURRING_REASONS.insufficientSessions
  | typeof RECURRING_REASONS.conversationEvidenceIncomplete
  | typeof RECURRING_REASONS.conversationEvidenceBoundExceeded
  | typeof RECURRING_REASONS.projectOnlyScope
  | typeof RECURRING_REASONS.noiseTerm
  | typeof RECURRING_REASONS.tooManyQualifyingOrigins
  | typeof RECURRING_REASONS.userAuthorshipRequired;

export type RecurringReviewReason = typeof RECURRING_REASONS.conflictingMeaning | typeof RECURRING_REASONS.uncertainScope | typeof RECURRING_REASONS.inferredUsageRequiresReview;

export interface RecurringGlossaryCandidate {
  capsule: GlossaryEvidenceCapsule;
  outcome: "review_required";
  reason: RecurringReviewReason;
  /** Transient source labels for bounded candidate-projection diversity. */
  project_ids: string[];
}

export interface RecurringGlossaryAbstention {
  term: string;
  candidate_id: string;
  reason: RecurringAbstentionReason;
}

export interface RecurringGlossaryMiningInput {
  tiersDir: string;
  corpusPath?: string;
  /** Restrict mining to these terms. Omit to mine every deterministic cue. */
  requestedTerms?: readonly string[];
  /** Expected anchor set for a targeted conversation-derived candidate. */
  conversationEvidence?: GlossaryConversationEvidenceExpectation;
  /** Expected anchor sets keyed by stable term identity or observed term. */
  conversationEvidenceByTerm?: ReadonlyMap<string, GlossaryConversationEvidenceExpectation>;
}

export interface RecurringGlossaryMiningResult {
  state: EvidenceTierCompatibilityState["state"];
  generation: string | null;
  candidates: RecurringGlossaryCandidate[];
  abstentions: RecurringGlossaryAbstention[];
  recovery: string | null;
}

interface ResolvedSignal {
  signal: SignalRecord;
  record: JsonObject;
  values: string[];
  originId: string | null;
  contentFingerprint: string | null;
  sessionId: string | null;
  projectId: string;
  authorClass: string | null;
  provenanceValid: boolean;
}

interface TermOccurrence {
  term: string;
  source: ResolvedSignal;
  meaningCues: Set<string>;
  projectScope: boolean;
  personalScope: boolean;
}

interface TermGroup {
  identity: string;
  terms: Set<string>;
  occurrences: TermOccurrence[];
}

interface IndependentEvidence {
  records: ResolvedSignal[];
  copied: boolean;
  provenanceMissing: boolean;
}

const IDENTIFIER_CONTINUATION = "[\\p{ID_Continue}$\\u200C\\u200D]";
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-_$\u200C\u200D][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*/gu;
const COMBINING_MARK_RE = /^\p{M}$/u;
const INTERNAL_SEPARATOR_RE = /^[-_$\u200C\u200D]$/u;
const SHA256_RE = /^[a-f0-9]{64}$/;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Mapping) : null;
}

function compareText(left: string, right: string): number {
  return compareGlossaryUnicodeStrings(left, right);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function dataObject(record: JsonObject): Mapping {
  return mapping(record.data) ?? {};
}

function semanticValues(record: JsonObject): string[] {
  const data = dataObject(record);
  if (record.source_kind === "instruction_document") {
    return typeof data.content === "string" ? [data.content] : [];
  }
  if (record.source_kind === "project_config_signal") {
    return Array.isArray(data.signals) ? data.signals.filter((value): value is string => typeof value === "string") : [];
  }
  if (record.source_kind === "conversation_turn") {
    return ["text", "prompt", "content"].flatMap((field) => (typeof data[field] === "string" ? [data[field] as string] : []));
  }
  return [];
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => nonEmpty(value)) ?? null;
}

function validDigest(value: string | null): boolean {
  return value !== null && SHA256_RE.test(value);
}

function resolvedSignal(signal: SignalRecord, record: JsonObject): ResolvedSignal | null {
  if (record.source_id !== signal.source_id || record.source_kind !== signal.source_kind) return null;
  const retainedProjectId = typeof record.project_id === "string" ? record.project_id : "";
  if (signal.project_id !== retainedProjectId) return null;
  for (const [signalField, recordField] of [
    ["origin_id", "origin_id"],
    ["content_fingerprint", "content_fingerprint"],
    ["session_id", "session_id"],
    ["author_class", "author_class"],
  ] as const) {
    const signalValue = signal[signalField];
    if (signalValue !== undefined && signalValue !== record[recordField]) return null;
  }
  const values = semanticValues(record);
  if (values.length === 0) return null;
  return {
    signal,
    record,
    values,
    originId: firstString(signal.origin_id, record.origin_id),
    contentFingerprint: firstString(signal.content_fingerprint, record.content_fingerprint),
    sessionId: firstString(signal.session_id, record.session_id),
    projectId: signal.project_id || String(record.project_id ?? ""),
    authorClass: firstString(signal.author_class, record.author_class),
    provenanceValid: validDigest(firstString(signal.origin_id, record.origin_id)) && validDigest(firstString(signal.content_fingerprint, record.content_fingerprint)),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCaselessTerm(text: string, term: string): boolean {
  const characters = [...term];
  const prefix = characters[0] && new RegExp(`^${IDENTIFIER_CONTINUATION}$`, "u").test(characters[0]) ? `(?<!${IDENTIFIER_CONTINUATION})` : "";
  const last = characters.at(-1) ?? "";
  const suffix = new RegExp(`^${IDENTIFIER_CONTINUATION}$`, "u").test(last) ? `(?!${IDENTIFIER_CONTINUATION})` : "";
  return new RegExp(`${prefix}${escapeRegExp(term)}${suffix}`, "iu").test(text);
}

function hasCase(value: string): boolean {
  return value.toLowerCase() !== value.toUpperCase();
}

function startsWithUppercase(value: string): boolean {
  const first = [...value][0];
  return first !== undefined && hasCase(first) && first.toUpperCase() === first;
}

function scalarBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const lastUnit = text.charCodeAt(index - 1);
  const previousUnit = text.charCodeAt(index - 2);
  const start = lastUnit >= 0xdc00 && lastUnit <= 0xdfff && previousUnit >= 0xd800 && previousUnit <= 0xdbff ? index - 2 : index - 1;
  return text.slice(start, index);
}

function scalarAt(text: string, index: number): string {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function touchesMalformedCombiningSequence(text: string, start: number, end: number): boolean {
  if (COMBINING_MARK_RE.test(scalarBefore(text, start))) return true;
  const next = scalarAt(text, end);
  return INTERNAL_SEPARATOR_RE.test(next) && COMBINING_MARK_RE.test(scalarAt(text, end + next.length));
}

function isNoiseToken(value: string, text: string, start: number, end: number): boolean {
  if ([...value].length < 3 || [...value].length > 64) return true;
  if (touchesMalformedCombiningSequence(text, start, end)) return true;
  if (/^\d+$/.test(value) || classifyRecurringLexicalToken(value, text, start, end) !== null) return true;
  if (startsWithUppercase(value)) return true;
  const previous = text[start - 1] ?? "";
  const beforePrevious = text[start - 2] ?? "";
  const next = text[end] ?? "";
  if ([":", "=", "@", "#"].includes(previous)) return true;
  if ([":", "=", "@", "#"].includes(next)) return true;
  if (beforePrevious === "-" && previous === "-") return true;
  return false;
}

function candidateTokens(text: string): Array<{ value: string; start: number; end: number }> {
  const tokens = [...text.matchAll(TOKEN_RE)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  return tokens.filter((token) => !isNoiseToken(token.value, text, token.start, token.end));
}

function cueTerms(values: string[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    const tokens = candidateTokens(value);
    for (const token of tokens) terms.add(token.value);
    for (let index = 1; index < tokens.length; index += 1) {
      const previous = tokens[index - 1]!;
      const current = tokens[index]!;
      if (/^[\s]+$/.test(value.slice(previous.end, current.start))) {
        const phrase = `${previous.value} ${current.value}`;
        if (!isNoiseToken(phrase, phrase, 0, phrase.length)) terms.add(phrase);
      }
    }
  }
  return [...terms];
}

function meaningCues(term: string, values: string[]): Set<string> {
  const escaped = escapeRegExp(term);
  const cues = new Set<string>();
  const patterns = [new RegExp(`${escaped}\\s+(?:means|refers to|is)\\s+([^.!?\\n]+)`, "giu"), new RegExp(`(?:means|refers to)\\s+${escaped}\\s+([^.!?\\n]+)`, "giu")];
  for (const value of values) {
    for (const pattern of patterns) {
      for (const match of value.matchAll(pattern)) {
        const cue = match[1]?.trim();
        if (cue) cues.add(cue);
      }
    }
  }
  return cues;
}

function scopeMarkers(term: string, values: string[]): { project: boolean; personal: boolean } {
  const escaped = escapeRegExp(term);
  const projectPattern = new RegExp(`(?:project[- ]only|repository[- ]only|for this project|project\\s+(?:term|meaning|definition)\\s*[:=]?\\s*${escaped})`, "iu");
  const personalPattern = new RegExp(`(?:personal[- ]only|for me|my\\s+(?:term|meaning|definition)\\s*[:=]?\\s*${escaped})`, "iu");
  return {
    project: values.some((value) => projectPattern.test(value)),
    personal: values.some((value) => personalPattern.test(value)),
  };
}

function isProjectOnly(records: readonly ResolvedSignal[], occurrences: readonly TermOccurrence[], route: "instruction" | "conversation"): boolean {
  if (records.length === 0) return false;
  const dataScopes = records.map((item) => String(dataObject(item.record).scope ?? ""));
  const explicitProjectScope = dataScopes.every((scope) => scope === "project" || scope === "project_only");
  const projectConfigOnly = records.every((item) => item.signal.source_kind === "project_config_signal");
  const oneProject = new Set(records.map((item) => item.projectId)).size === 1;
  const markedProject = occurrences.length > 0 && occurrences.every((item) => item.projectScope && !item.personalScope);
  if (route === "conversation") return explicitProjectScope || markedProject;
  return (projectConfigOnly && oneProject) || (explicitProjectScope && projectConfigOnly) || markedProject;
}

function groupOccurrences(resolved: readonly ResolvedSignal[], allowedSourceKinds: ReadonlySet<string>, allowedSignalTypes: ReadonlySet<string>, includeAgents: boolean): Map<string, TermGroup> {
  const groups = new Map<string, TermGroup>();
  for (const source of resolved) {
    if (!allowedSourceKinds.has(source.signal.source_kind) || !allowedSignalTypes.has(source.signal.signal_type)) continue;
    if (!includeAgents && source.authorClass !== null && source.authorClass !== "user") continue;
    const terms = cueTerms(source.values);
    const seenInRecord = new Set<string>();
    for (const term of terms) {
      const identity = stableGlossaryTermIdentity(term);
      if (seenInRecord.has(identity)) continue;
      seenInRecord.add(identity);
      const scope = scopeMarkers(term, source.values);
      const occurrence: TermOccurrence = {
        term,
        source,
        meaningCues: meaningCues(term, source.values),
        projectScope: scope.project,
        personalScope: scope.personal,
      };
      const group = groups.get(identity) ?? { identity, terms: new Set<string>(), occurrences: [] };
      group.terms.add(term);
      group.occurrences.push(occurrence);
      groups.set(identity, group);
    }
  }
  return groups;
}

function requestedIdentitySet(terms: readonly string[] | undefined): Map<string, string> {
  const requested = new Map<string, string>();
  for (const value of terms ?? []) {
    const term = value.trim();
    if (!term) continue;
    requested.set(stableGlossaryTermIdentity(term), term);
  }
  return requested;
}

function orderedSignals(signals: readonly ResolvedSignal[]): ResolvedSignal[] {
  return [...signals].sort((left, right) => compareText(left.signal.source_id, right.signal.source_id) || compareText(left.signal.evidence_anchor, right.signal.evidence_anchor));
}

function independentEvidence(records: readonly ResolvedSignal[]): IndependentEvidence {
  const selected: ResolvedSignal[] = [];
  const sourceIds = new Set<string>();
  const anchors = new Set<string>();
  const origins = new Set<string>();
  const fingerprints = new Set<string>();
  let copied = false;
  let provenanceMissing = false;
  for (const record of orderedSignals(records)) {
    if (!record.provenanceValid) {
      provenanceMissing = true;
      continue;
    }
    const duplicate = sourceIds.has(record.signal.source_id) || anchors.has(record.signal.evidence_anchor) || (record.originId !== null && origins.has(record.originId)) || (record.contentFingerprint !== null && fingerprints.has(record.contentFingerprint));
    if (duplicate) {
      copied = true;
      continue;
    }
    sourceIds.add(record.signal.source_id);
    anchors.add(record.signal.evidence_anchor);
    if (record.originId !== null) origins.add(record.originId);
    if (record.contentFingerprint !== null) fingerprints.add(record.contentFingerprint);
    selected.push(record);
  }
  return { records: selected, copied, provenanceMissing };
}

function canonicalTerm(group: TermGroup, requested: string | undefined): string {
  if (requested !== undefined) return requested;
  return [...group.terms].sort(compareText)[0] ?? "";
}

function retainedEvidence(record: ResolvedSignal): RetainedEvidence {
  return {
    sourceId: record.signal.source_id,
    sourceKind: record.signal.source_kind,
    signalType: record.signal.signal_type,
    ...(record.sessionId === null ? {} : { sessionId: record.sessionId }),
    projectId: record.projectId,
    ...(record.contentFingerprint === null ? {} : { contentFingerprint: record.contentFingerprint }),
    ...(record.authorClass === null ? {} : { authorClass: record.authorClass }),
  };
}

function conversationVariant(): Mapping {
  const authority = loadYamlMappingFile(glossaryEntryAuthorityPath()) as Mapping;
  const variants = mapping(authority.provenance_variants);
  return mapping(variants?.personal_inferred_conversation) ?? {};
}

function candidateEvidenceMax(): number {
  try {
    const authority = loadYamlMappingFile(glossaryEntryAuthorityPath()) as Mapping;
    const candidateContracts = mapping(authority.candidate_contracts);
    const bounds = mapping(candidateContracts?.bounds);
    const maximum = Number(bounds?.evidence_records_max);
    return Number.isInteger(maximum) && maximum > 0 ? maximum : 0;
  } catch {
    return 0;
  }
}

function expectationFor(term: string, identity: string, input: RecurringGlossaryMiningInput): GlossaryConversationEvidenceExpectation | undefined {
  return input.conversationEvidenceByTerm?.get(identity) ?? input.conversationEvidenceByTerm?.get(term) ?? input.conversationEvidence;
}

function conversationFailureReason(records: readonly ResolvedSignal[], agentRecords: readonly ResolvedSignal[], expectation: GlossaryConversationEvidenceExpectation | undefined, generation: string, evidenceMax: number): RecurringAbstentionReason | null {
  const expectedAnchors = expectation?.qualifyingEvidenceAnchors;
  if (evidenceMax === 0 || records.length > evidenceMax || (Array.isArray(expectedAnchors) && expectedAnchors.length > evidenceMax)) {
    return RECURRING_REASONS.conversationEvidenceBoundExceeded;
  }
  if (records.length === 0) {
    return agentRecords.length > 0 ? RECURRING_REASONS.agentOnlyEvidence : RECURRING_REASONS.insufficientIndependentOrigins;
  }
  if (agentRecords.length > 0 && records.length < 3) {
    return RECURRING_REASONS.userAuthorshipRequired;
  }
  const independent = independentEvidence(records);
  if (independent.provenanceMissing) return RECURRING_REASONS.provenanceMissing;
  if (independent.copied) return RECURRING_REASONS.copiedContent;
  if (new Set(records.map((record) => record.sessionId).filter(nonEmpty)).size < 2) {
    return RECURRING_REASONS.insufficientSessions;
  }
  if (new Set(records.map((record) => record.projectId).filter(nonEmpty)).size < 2) {
    return RECURRING_REASONS.insufficientProjects;
  }
  if (records.length < 3 || new Set(records.map((record) => record.signal.source_id)).size < 3) {
    return RECURRING_REASONS.insufficientIndependentOrigins;
  }
  if (!expectation || expectation.generation !== generation) {
    return RECURRING_REASONS.conversationEvidenceIncomplete;
  }
  return null;
}

function validateConversationEvidence(records: readonly ResolvedSignal[], expectation: GlossaryConversationEvidenceExpectation, generation: string): boolean {
  try {
    if (expectation.generation !== generation) return false;
    const evidence = records.map((record) => ({
      source_id: record.signal.source_id,
      evidence_anchor: record.signal.evidence_anchor,
      source_kind: record.signal.source_kind,
      signal_type: record.signal.signal_type,
      session_id: record.sessionId ?? "",
      project_id: record.projectId,
      content_fingerprint: record.contentFingerprint ?? "",
      author_class: record.authorClass ?? "",
    }));
    const retainedHistory = new Map<string, RetainedEvidence>(records.map((record) => [record.signal.evidence_anchor, retainedEvidence(record)]));
    const context: GlossaryAdmissionContext = {
      retainedHistory,
      conversationEvidence: expectation,
    };
    return validateConversationProvenance(evidence, { evidence_complete: true }, conversationVariant(), context).length === 0;
  } catch {
    return false;
  }
}

function evidenceForInstruction(records: readonly ResolvedSignal[]): Mapping[] {
  return orderedSignals(records).map((record) => ({
    source_id: record.signal.source_id,
    evidence_anchor: record.signal.evidence_anchor,
    source_kind: record.signal.source_kind,
  }));
}

function evidenceForConversation(records: readonly ResolvedSignal[]): Mapping[] {
  return orderedSignals(records).map((record) => ({
    source_id: record.signal.source_id,
    evidence_anchor: record.signal.evidence_anchor,
    source_kind: record.signal.source_kind,
    signal_type: record.signal.signal_type,
    session_id: record.sessionId ?? "",
    project_id: record.projectId,
    content_fingerprint: record.contentFingerprint ?? "",
    author_class: record.authorClass ?? "",
  }));
}

function reviewReason(occurrences: readonly TermOccurrence[]): RecurringReviewReason {
  const meanings = new Set(occurrences.flatMap((occurrence) => [...occurrence.meaningCues]));
  if (meanings.size > 1) return RECURRING_REASONS.conflictingMeaning;
  const project = occurrences.some((occurrence) => occurrence.projectScope);
  const personal = occurrences.some((occurrence) => occurrence.personalScope);
  if (project || personal) return RECURRING_REASONS.uncertainScope;
  return RECURRING_REASONS.inferredUsageRequiresReview;
}

function makeCandidate(term: string, provenanceKind: "personal_inferred_usage" | "personal_inferred_conversation", evidence: readonly Mapping[], records: readonly ResolvedSignal[], generation: string, reason: RecurringReviewReason): RecurringGlossaryCandidate {
  const capsule = createGlossaryEvidenceCapsule({
    term,
    meaning: RECURRING_MEANING_PENDING_REVIEW,
    scope: "ambiguous",
    provenance_kind: provenanceKind,
    evidence,
    policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
    generation,
  });
  return {
    capsule,
    outcome: "review_required",
    reason,
    project_ids: [...new Set(records.map((record) => record.projectId))].sort(compareText),
  };
}

function abstention(term: string, reason: RecurringAbstentionReason): RecurringGlossaryAbstention {
  return {
    term,
    candidate_id: stableGlossaryTermIdentity(term),
    reason,
  };
}

function addAbstention(output: Map<string, RecurringGlossaryAbstention>, term: string, reason: RecurringAbstentionReason): void {
  const candidateId = stableGlossaryTermIdentity(term);
  if (!output.has(candidateId)) output.set(candidateId, abstention(term, reason));
}

function rawTermPresent(term: string, resolved: readonly ResolvedSignal[]): boolean {
  return resolved.some((source) => source.values.some((value) => hasCaselessTerm(value, term)));
}

/**
 * Mine recurring usage from the current bounded signal tier only.
 *
 * This function emits review-bound capsules or stable abstentions. It does not
 * classify meaning, authorize admission, read project glossary state, persist a
 * review, or scan full evidence beyond direct anchor resolution.
 */
export function mineRecurringGlossaryCandidates(input: RecurringGlossaryMiningInput, resolveAnchor: (anchor: string, tiersDir: string) => JsonObject | null = resolveEvidenceAnchor): RecurringGlossaryMiningResult {
  const assessment = assessTiers(input.tiersDir, input.corpusPath);
  if (!assessment.analyzable) {
    return {
      state: assessment.state,
      generation: null,
      candidates: [],
      abstentions: [],
      recovery: recoveryForState(assessment.state),
    };
  }

  const tier = readSignalTier(input.tiersDir, { allowProvenanceGaps: true });
  if (!tier) {
    return {
      state: "corrupt",
      generation: null,
      candidates: [],
      abstentions: [],
      recovery: recoveryForState("corrupt"),
    };
  }
  const authority = personalGlossaryAdmissionContract();
  const selected = tier.records.filter((signal) => authority.inferredSignalTypes.includes(signal.signal_type) || authority.conversationSignalTypes.includes(signal.signal_type)).sort((left, right) => compareText(left.source_id, right.source_id));
  const resolved: ResolvedSignal[] = [];
  for (const signal of selected) {
    const record = resolveAnchor(signal.evidence_anchor, input.tiersDir);
    if (!record) continue;
    const value = resolvedSignal(signal, record);
    if (value) resolved.push(value);
  }

  const requested = requestedIdentitySet(input.requestedTerms);
  const instructionKinds = new Set(authority.inferredSourceKinds);
  const instructionTypes = new Set(authority.inferredSignalTypes);
  const conversationKinds = new Set(authority.conversationSourceKinds);
  const conversationTypes = new Set(authority.conversationSignalTypes);
  const instructionGroups = groupOccurrences(resolved, instructionKinds, instructionTypes, false);
  const conversationGroups = groupOccurrences(resolved, conversationKinds, conversationTypes, false);
  const agentConversationGroups = groupOccurrences(resolved, conversationKinds, conversationTypes, true);
  const evidenceMax = candidateEvidenceMax();
  const allGroups = new Map<string, TermGroup>();
  for (const group of [...instructionGroups.values(), ...conversationGroups.values()]) {
    const current = allGroups.get(group.identity) ?? {
      identity: group.identity,
      terms: new Set(),
      occurrences: [],
    };
    for (const term of group.terms) current.terms.add(term);
    current.occurrences.push(...group.occurrences);
    allGroups.set(group.identity, current);
  }
  const allResolved = resolved;
  const abstentions = new Map<string, RecurringGlossaryAbstention>();
  const candidates = new Map<string, RecurringGlossaryCandidate>();
  const identities = new Set([...allGroups.keys(), ...requested.keys()]);

  for (const identity of [...identities].sort(compareText)) {
    const requestedTerm = requested.get(identity);
    const instructionGroup = instructionGroups.get(identity);
    const conversationGroup = conversationGroups.get(identity);
    const agentGroup = agentConversationGroups.get(identity);
    const group = allGroups.get(identity);
    const term = canonicalTerm(group ?? { identity, terms: new Set(requestedTerm ? [requestedTerm] : []), occurrences: [] }, requestedTerm);
    if (!term) continue;
    let deferredReason: RecurringAbstentionReason | null = null;

    if (!group && requestedTerm && agentGroup && !instructionGroup) {
      addAbstention(abstentions, requestedTerm, RECURRING_REASONS.agentOnlyEvidence);
      continue;
    }
    if (!group && requestedTerm && rawTermPresent(requestedTerm, allResolved)) {
      addAbstention(abstentions, requestedTerm, RECURRING_REASONS.noiseTerm);
      continue;
    }

    if (conversationGroup) {
      const userRecords = conversationGroup.occurrences.map((occurrence) => occurrence.source);
      const agentRecords = agentGroup ? agentGroup.occurrences.map((occurrence) => occurrence.source).filter((record) => record.authorClass !== "user") : [];
      const expected = expectationFor(term, identity, input);
      if (isProjectOnly(userRecords, conversationGroup.occurrences, "conversation")) {
        addAbstention(abstentions, term, RECURRING_REASONS.projectOnlyScope);
        continue;
      }
      const failure = conversationFailureReason(userRecords, agentRecords, expected, tier.manifest.generation, evidenceMax);
      if (failure === null && expected && validateConversationEvidence(userRecords, expected, tier.manifest.generation)) {
        const reason = reviewReason(conversationGroup.occurrences);
        candidates.set(identity, makeCandidate(term, "personal_inferred_conversation", evidenceForConversation(userRecords), userRecords, tier.manifest.generation, reason));
        continue;
      }
      deferredReason = failure ?? RECURRING_REASONS.conversationEvidenceIncomplete;
    } else if (agentGroup && !instructionGroup) {
      addAbstention(abstentions, term, RECURRING_REASONS.agentOnlyEvidence);
      continue;
    }

    if (instructionGroup) {
      const records = instructionGroup.occurrences.map((occurrence) => occurrence.source);
      if (isProjectOnly(records, instructionGroup.occurrences, "instruction")) {
        addAbstention(abstentions, term, RECURRING_REASONS.projectOnlyScope);
        continue;
      }
      const independent = independentEvidence(records);
      if (independent.provenanceMissing) {
        deferredReason = RECURRING_REASONS.provenanceMissing;
      } else if (independent.copied) {
        deferredReason = RECURRING_REASONS.copiedContent;
      } else if (independent.records.length < 2) {
        deferredReason = RECURRING_REASONS.insufficientIndependentOrigins;
      } else if (independent.records.length > 2) {
        deferredReason = RECURRING_REASONS.tooManyQualifyingOrigins;
      } else {
        candidates.set(identity, makeCandidate(term, "personal_inferred_usage", evidenceForInstruction(independent.records), independent.records, tier.manifest.generation, reviewReason(instructionGroup.occurrences)));
        abstentions.delete(identity);
        deferredReason = null;
      }
    }
    if (!candidates.has(identity) && deferredReason !== null) {
      addAbstention(abstentions, term, deferredReason);
    }
  }

  return {
    state: assessment.state,
    generation: tier.manifest.generation,
    candidates: [...candidates.entries()].sort(([left], [right]) => compareText(left, right)).map(([, candidate]) => candidate),
    abstentions: [...abstentions.entries()].sort(([left], [right]) => compareText(left, right)).map(([, result]) => result),
    recovery: null,
  };
}

/** Short name used by later bounded mining callers. */
export const mineRecurringGlossaryEvidence = mineRecurringGlossaryCandidates;

export { PERSONAL_GLOSSARY_MINING_POLICY_VERSION };
