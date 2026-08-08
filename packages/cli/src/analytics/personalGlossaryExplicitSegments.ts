import {
  EXPLICIT_SEGMENT_REASONS,
  explicitSegmentTransition,
  type ExplicitSegmentGrammarContract,
  type ExplicitSegmentInput,
  type ExplicitSegmentState,
} from "../registries/explicitSegmentGrammarContract.js";
import { stableGlossaryTermIdentity } from "../registries/glossaryTermIdentity.js";
import {
  EXPLICIT_GLOSSARY_REASONS,
  type ExplicitGlossaryReason,
  type RawCue,
} from "./personalGlossaryExplicitTypes.js";

const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const EXAMPLE_RE = /\b(?:for\s+example|e\.g\.?|example|such\s+as)\b/iu;
const HYPOTHETICAL_RE =
  /\b(?:if|when|unless|whenever|suppose|assuming|hypothetically|imagine|would|could|might|may)\b/iu;
const QUESTION_RE = /\?|^\s*(?:does|do|did|can|could|would|should|what|why|how)\b/iu;
const INDIRECT_QUESTION_RE =
  /\b(?:i\s+(?:wonder|ask|want\s+to\s+know)|tell\s+me|whether|what|why|how)\b/iu;
const FUTURE_RE =
  /\b(?:will|shall|going\s+to|plan\s+to|intend\s+to|in\s+the\s+future|from\s+now\s+on|later)\b/iu;
const FOLLOWING_CUE_REFERENCE_RE = /\b(?:the\s+)?following\s+(?:definition|term|meaning)\b/iu;
const PREVIOUS_CUE_REFERENCE_RE = /\bthis\s+(?:definition|term|meaning)\b/iu;

type Line = { start: number; end: number };
type SegmentLineKind =
  | "blank"
  | "comment"
  | "indentation"
  | "list_boundary"
  | "structural_fragment"
  | "approved_cue"
  | "prose";

interface SegmentLinePlan extends Line {
  scanEnd: number;
  kind: SegmentLineKind;
  input: ExplicitSegmentInput;
  raws: RawCue[];
}

export interface ExplicitSegmentParserDependencies {
  lineRanges(text: string): Line[];
  commentStart(text: string, line: Line, ranges: readonly Line[]): number;
  colonOutsideRanges(text: string, start: number, end: number, ranges: readonly Line[]): number;
  sentenceBoundaries(text: string, ranges: readonly Line[]): number[];
  rawCueOrder(left: RawCue, right: RawCue, text: string): number;
  trimMeaning(text: string, start: number, end: number): [number, number];
  unwrapMeaning(text: string, start: number, end: number): [number, number];
  closeToOpen: ReadonlyMap<string, string>;
}

function lineIndexAt(lines: readonly Line[], position: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle]!;
    if (position < line.start) high = middle - 1;
    else if (position > line.end) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(lines.length - 1, low));
}

function hasListMarker(value: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(value) || /^\s*---\s*$/u.test(value);
}

function hasBlockScalarHeader(value: string): boolean {
  return /^\s*[^:#\n][^:\n]*:\s*[|>](?:[1-9])?(?:[+-])?\s*$/u.test(value);
}

function hasHeadingMarker(value: string): boolean {
  return /^\s*#{1,6}(?:\s|$)/u.test(value);
}

function safeMarkerPrefix(value: string): boolean {
  return /^\s*(?:[-*+]\s+)?(?:definition|term|correction|sarcasm)\s*:\s*$/iu.test(value);
}

function linePlans(
  text: string,
  raws: readonly RawCue[],
  ranges: readonly Line[],
  deps: ExplicitSegmentParserDependencies,
): SegmentLinePlan[] {
  const lines = deps.lineRanges(text);
  const byLine = lines.map(() => [] as RawCue[]);
  for (const raw of raws) {
    if (raw.termStart === raw.termEnd && raw.meaningStart === raw.meaningEnd) continue;
    byLine[lineIndexAt(lines, raw.termStart)]!.push(raw);
  }
  return lines.map((line, index) => {
    const comment = deps.commentStart(text, line, ranges);
    const scanEnd = comment < 0 ? line.end : comment;
    const value = text.slice(line.start, scanEnd);
    const trimmed = value.trim();
    const rawsOnLine = byLine[index]!.sort((left, right) => deps.rawCueOrder(left, right, text));
    const firstColon = deps.colonOutsideRanges(text, line.start, scanEnd, ranges);
    const firstRaw = rawsOnLine[0];
    const markerPrefix =
      firstColon >= 0 && firstRaw !== undefined
        ? safeMarkerPrefix(text.slice(line.start, firstColon + 1))
        : false;
    const unsafePrefix =
      firstColon >= 0 && firstRaw !== undefined && firstColon < firstRaw.termStart && !markerPrefix;
    const leadingWhitespace = /^\s+\S/u.test(value);
    const commentOnly = text.slice(line.start, line.end).trim().startsWith("#");
    const listMarker = hasListMarker(value);
    const heading = hasHeadingMarker(value);
    const blockScalar = hasBlockScalarHeader(value);
    const approved =
      rawsOnLine.length > 0 &&
      !leadingWhitespace &&
      !commentOnly &&
      !heading &&
      !blockScalar &&
      !unsafePrefix;
    let kind: SegmentLineKind;
    if (commentOnly) kind = "comment";
    else if (trimmed.length === 0) kind = "blank";
    else if (leadingWhitespace) kind = "indentation";
    else if (approved) kind = "approved_cue";
    else if (listMarker) kind = "list_boundary";
    else if (heading || blockScalar || firstColon >= 0) kind = "structural_fragment";
    else kind = "prose";
    const input: ExplicitSegmentInput =
      kind === "blank"
        ? "blank_line"
        : kind === "comment"
          ? "comment"
          : kind === "indentation"
            ? "indentation"
            : kind === "list_boundary"
              ? "list_boundary"
              : kind === "structural_fragment"
                ? blockScalar
                  ? "block_scalar"
                  : heading || trimmed.startsWith("#")
                    ? "comment"
                    : "structural_fragment"
                : kind === "approved_cue"
                  ? "approved_cue"
                  : "prose";
    return { ...line, scanEnd, kind, input, raws: rawsOnLine };
  });
}

function structuralRejection(line: Line, reason: ExplicitGlossaryReason): RawCue {
  return {
    kind: "structural_fragment",
    termStart: line.start,
    termEnd: line.start,
    meaningStart: line.start,
    meaningEnd: line.start,
    sentenceStart: line.start,
    sentenceEnd: line.end,
    rejectionReason: reason,
  };
}

function loadedStructuralReason(
  transition: ReturnType<typeof explicitSegmentTransition>,
): ExplicitGlossaryReason {
  return transition.reason === EXPLICIT_SEGMENT_REASONS.structuralFragment
    ? transition.reason
    : EXPLICIT_GLOSSARY_REASONS.structuralFragment;
}

function segmentRawCues(
  text: string,
  initial: readonly RawCue[],
  ranges: readonly Line[],
  grammar: ExplicitSegmentGrammarContract,
  deps: ExplicitSegmentParserDependencies,
): { raws: RawCue[]; plans: SegmentLinePlan[] } {
  const plans = linePlans(text, initial, ranges, deps);
  const accepted: RawCue[] = [];
  let state: ExplicitSegmentState = grammar.initialState;
  for (const plan of plans) {
    if (state === "structural_config") {
      const transition = explicitSegmentTransition(grammar, state, plan.input);
      if (plan.kind === "prose") {
        state = transition.to;
        continue;
      }
      if (plan.kind !== "blank" && plan.kind !== "comment") {
        accepted.push(structuralRejection(plan, loadedStructuralReason(transition)));
      }
      continue;
    }
    if (plan.kind === "approved_cue") {
      const transition = explicitSegmentTransition(grammar, state, "approved_cue");
      if (transition.to === "cue") accepted.push(...plan.raws);
      continue;
    }
    if (plan.kind === "structural_fragment" || plan.kind === "list_boundary") {
      const transition = explicitSegmentTransition(grammar, state, plan.input);
      if (transition.to === "structural_config") {
        state = transition.to;
        accepted.push(structuralRejection(plan, loadedStructuralReason(transition)));
      }
    } else if (plan.kind === "comment" && /:\s*/u.test(text.slice(plan.start, plan.end))) {
      const transition = explicitSegmentTransition(grammar, state, "structural_fragment");
      accepted.push(structuralRejection(plan, loadedStructuralReason(transition)));
    }
  }
  return { raws: accepted, plans };
}

function firstRawAfter(
  plan: SegmentLinePlan,
  position: number,
  text: string,
  deps: ExplicitSegmentParserDependencies,
): RawCue | undefined {
  return plan.raws
    .filter((raw) => raw.termStart > position)
    .sort((left, right) => deps.rawCueOrder(left, right, text))[0];
}

function cueBoundaryStart(
  text: string,
  cue: RawCue,
  closeToOpen: ReadonlyMap<string, string>,
): number {
  if (cue.kind === "definition_list") {
    const floor =
      Math.max(
        text.lastIndexOf("\n", cue.termStart - 1),
        text.lastIndexOf(";", cue.termStart - 1),
      ) + 1;
    const prefix = text.slice(floor, cue.termStart);
    if (/^\s*(?:[-*+]\s+)?(?:definition|term)\s*:\s*$/iu.test(prefix)) {
      const first = prefix.search(/\S/u);
      if (first >= 0) return floor + first;
    }
  }
  const opening = closeToOpen.get(text[cue.termEnd] ?? "");
  if (opening !== undefined) {
    const start = text.lastIndexOf(opening, cue.termStart);
    if (start >= 0) return start;
  }
  return cue.termStart;
}

function isBoundaryLine(plan: SegmentLinePlan): boolean {
  return ["blank", "comment", "indentation", "list_boundary", "structural_fragment"].includes(
    plan.kind,
  );
}

function sentenceRanges(
  text: string,
  ranges: readonly Line[],
  deps: ExplicitSegmentParserDependencies,
): Line[] {
  const boundaries = deps.sentenceBoundaries(text, ranges);
  return [0, ...boundaries].map((start, index, starts) => ({
    start,
    end: starts[index + 1] ?? text.length,
  }));
}

function directReferenceStart(
  text: string,
  line: Line,
  raws: readonly RawCue[],
  ranges: readonly Line[],
  deps: ExplicitSegmentParserDependencies,
): number | null {
  for (const sentence of sentenceRanges(text, ranges, deps)) {
    if (sentence.end <= line.start || sentence.start > line.end) continue;
    const value = text.slice(sentence.start, sentence.end);
    if (!referenceQualifier(value)) continue;
    const following = value.match(new RegExp(FOLLOWING_CUE_REFERENCE_RE.source, "iu"));
    if (following?.index !== undefined) return Math.max(sentence.start, line.start);
    const previous = value.match(new RegExp(PREVIOUS_CUE_REFERENCE_RE.source, "iu"));
    if (previous?.index !== undefined) return Math.max(sentence.start, line.start);
    if (
      raws.some(
        (raw) =>
          raw.rejectionReason === undefined &&
          raw.termStart >= sentence.start &&
          raw.termStart < sentence.end,
      )
    )
      continue;
    for (const raw of raws) {
      if (raw.rejectionReason !== undefined || raw.termEnd <= raw.termStart) continue;
      const term = text.slice(raw.termStart, raw.termEnd).trim();
      const occurrence = exactTermOccurrences(text, term, sentence.start, sentence.end)[0];
      if (occurrence !== undefined) return Math.max(sentence.start, line.start);
    }
  }
  return null;
}

function boundedSegmentCues(
  text: string,
  raws: readonly RawCue[],
  plans: readonly SegmentLinePlan[],
  ranges: readonly Line[],
  grammar: ExplicitSegmentGrammarContract,
  deps: ExplicitSegmentParserDependencies,
): RawCue[] {
  const lines = deps.lineRanges(text);
  const structural = raws.filter(
    (raw) => raw.termStart === raw.termEnd && raw.meaningStart === raw.meaningEnd,
  );
  const usable = raws.filter(
    (raw) => !(raw.termStart === raw.termEnd && raw.meaningStart === raw.meaningEnd),
  );
  const bounded = usable.map((raw) => {
    if (raw.kind === "acronym_parenthetical") return raw;
    if (raw.kind !== "definition_list") {
      const line = plans[lineIndexAt(lines, raw.termStart)]!;
      const next = firstRawAfter(line, raw.termStart, text, deps);
      const boundary =
        next === undefined ? raw.sentenceEnd : cueBoundaryStart(text, next, deps.closeToOpen);
      const end = boundary < raw.sentenceEnd ? boundary : raw.sentenceEnd;
      const [meaningStart, meaningEnd] = deps.unwrapMeaning(
        text,
        ...deps.trimMeaning(text, raw.meaningStart, end),
      );
      return { ...raw, meaningStart, meaningEnd };
    }
    const lineIndex = lineIndexAt(lines, raw.termStart);
    const line = plans[lineIndex]!;
    const nextOnLine = firstRawAfter(line, raw.termStart, text, deps);
    let end = nextOnLine ? cueBoundaryStart(text, nextOnLine, deps.closeToOpen) : line.scanEnd;
    let state: ExplicitSegmentState = "cue";
    const inline = deps.trimMeaning(text, raw.meaningStart, end);
    const inlineNonEmpty = LETTER_OR_NUMBER_RE.test(text.slice(...inline));
    const cueTransition = explicitSegmentTransition(
      grammar,
      state,
      inlineNonEmpty ? "non_empty_inline_meaning" : nextOnLine ? "next_cue" : "blank_line",
    );
    if (!inlineNonEmpty) {
      return {
        ...raw,
        meaningStart: inline[0],
        meaningEnd: inline[1],
        ...(raw.rejectionReason === undefined
          ? { rejectionReason: EXPLICIT_GLOSSARY_REASONS.emptyMeaning }
          : {}),
      };
    }
    state = cueTransition.to;
    let lastIncludedEnd = end;
    for (let index = lineIndex + 1; index < plans.length; index += 1) {
      const nextPlan = plans[index]!;
      const nextCue = nextPlan.raws.find((candidate) => candidate.termStart > raw.termStart);
      const transition = explicitSegmentTransition(grammar, state, nextPlan.input);
      if (isBoundaryLine(nextPlan)) {
        end = nextPlan.start;
        break;
      }
      if (nextCue !== undefined) {
        end = cueBoundaryStart(text, nextCue, deps.closeToOpen);
        break;
      }
      const referenceStart = directReferenceStart(text, nextPlan, raws, ranges, deps);
      if (referenceStart !== null) {
        end = referenceStart;
        break;
      }
      state = transition.to;
      if (state !== "continuation") {
        end = nextPlan.start;
        break;
      }
      lastIncludedEnd = nextPlan.end;
      end = lastIncludedEnd;
      if (nextPlan.kind === "approved_cue") {
        end = nextPlan.start;
        break;
      }
    }
    const [meaningStart, meaningEnd] = deps.unwrapMeaning(
      text,
      ...deps.trimMeaning(text, raw.meaningStart, end),
    );
    const overBound =
      Buffer.byteLength(text.slice(meaningStart, meaningEnd), "utf8") >
      grammar.continuation.maximumUtf8Bytes;
    return {
      ...raw,
      meaningStart,
      meaningEnd,
      ...(overBound && raw.rejectionReason === undefined
        ? { rejectionReason: EXPLICIT_GLOSSARY_REASONS.meaningBoundExceeded }
        : {}),
    };
  });
  return [...bounded, ...structural];
}

function escapedTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactTermOccurrences(text: string, term: string, start: number, end: number): number[] {
  const literal = escapedTerm(term);
  if (!literal) return [];
  const expression = new RegExp(
    `(?<![\\p{ID_Continue}$\\u200C\\u200D])${literal}(?![\\p{ID_Continue}$\\u200C\\u200D])`,
    "giu",
  );
  return [...text.slice(start, end).matchAll(expression)].map(
    (match) => start + (match.index ?? 0),
  );
}

function occurrenceInsideMeaning(position: number, raw: RawCue): boolean {
  return position >= raw.meaningStart && position < raw.meaningEnd;
}

function referenceQualifier(text: string): ExplicitGlossaryReason | null {
  if (EXAMPLE_RE.test(text)) return EXPLICIT_GLOSSARY_REASONS.exampleContext;
  if (HYPOTHETICAL_RE.test(text)) return EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition;
  if (INDIRECT_QUESTION_RE.test(text) || QUESTION_RE.test(text)) {
    return EXPLICIT_GLOSSARY_REASONS.indirectQuestion;
  }
  if (FUTURE_RE.test(text)) return EXPLICIT_GLOSSARY_REASONS.futureDefinition;
  return null;
}

function applyReferenceBindings(
  text: string,
  raws: readonly RawCue[],
  ranges: readonly Line[],
  deps: ExplicitSegmentParserDependencies,
): RawCue[] {
  const sentences = sentenceRanges(text, ranges, deps);
  const cues = raws
    .filter(
      (raw) =>
        raw.rejectionReason === undefined &&
        raw.termEnd > raw.termStart &&
        raw.meaningEnd > raw.meaningStart,
    )
    .sort((left, right) => deps.rawCueOrder(left, right, text));
  const rejected = new Map<RawCue, ExplicitGlossaryReason>();
  const missing: RawCue[] = [];
  const reject = (target: RawCue, reason: ExplicitGlossaryReason): void => {
    if (!rejected.has(target)) rejected.set(target, reason);
  };
  const cueSentence = (cue: RawCue): number =>
    Math.max(
      0,
      sentences.findIndex(
        (sentence) => cue.termStart >= sentence.start && cue.termStart < sentence.end,
      ),
    );
  const cuesBySentence = sentences.map((_, index) =>
    cues.filter((cue) => cueSentence(cue) === index),
  );
  for (const [sentenceIndex, sentence] of sentences.entries()) {
    const value = text.slice(sentence.start, sentence.end);
    const qualifier = referenceQualifier(value);
    if (!qualifier) continue;
    for (const match of value.matchAll(new RegExp(FOLLOWING_CUE_REFERENCE_RE.source, "giu"))) {
      const position = sentence.start + (match.index ?? 0) + match[0].length;
      const target = (cuesBySentence[sentenceIndex + 1] ?? []).find(
        (cue) => cue.termStart >= position,
      );
      if (target) reject(target, qualifier);
      else
        missing.push(
          structuralRejection(
            { start: sentence.start, end: sentence.end },
            EXPLICIT_GLOSSARY_REASONS.ambiguousReference,
          ),
        );
    }
    for (const match of value.matchAll(new RegExp(PREVIOUS_CUE_REFERENCE_RE.source, "giu"))) {
      const position = sentence.start + (match.index ?? 0);
      const target = [...(cuesBySentence[sentenceIndex - 1] ?? [])]
        .reverse()
        .find((cue) => cue.termStart < position);
      if (target) reject(target, qualifier);
      else
        missing.push(
          structuralRejection(
            { start: sentence.start, end: sentence.end },
            EXPLICIT_GLOSSARY_REASONS.ambiguousReference,
          ),
        );
    }
    if (cues.some((cue) => cue.termStart >= sentence.start && cue.termStart < sentence.end))
      continue;
    const directExactReference =
      QUESTION_RE.test(value) ||
      EXAMPLE_RE.test(value) ||
      HYPOTHETICAL_RE.test(value) ||
      FUTURE_RE.test(value);
    const nearbyCues = cues.filter((cue) => Math.abs(cueSentence(cue) - sentenceIndex) <= 1);
    const matches = new Map<string, RawCue[]>();
    for (const cue of nearbyCues) {
      const term = text.slice(cue.termStart, cue.termEnd).trim();
      const occurrences = exactTermOccurrences(text, term, sentence.start, sentence.end).filter(
        (position) =>
          !nearbyCues.some(
            (other) =>
              other !== cue &&
              other.rejectionReason === undefined &&
              occurrenceInsideMeaning(position, other) &&
              !directExactReference,
          ),
      );
      if (occurrences.length > 0) {
        const identity = stableGlossaryTermIdentity(term);
        matches.set(identity, [...(matches.get(identity) ?? []), cue]);
      }
    }
    for (const group of matches.values()) {
      const unique = [...new Map(group.map((cue) => [cue.termStart, cue])).values()];
      if (unique.length > 1) {
        for (const cue of unique) reject(cue, EXPLICIT_GLOSSARY_REASONS.ambiguousReference);
      } else if (unique[0]) reject(unique[0], qualifier);
    }
  }
  return [
    ...raws.map((raw) => {
      const reason = rejected.get(raw);
      return reason === undefined || raw.rejectionReason !== undefined
        ? raw
        : { ...raw, rejectionReason: reason };
    }),
    ...missing,
  ];
}

export function segmentAndBindExplicitCues(
  text: string,
  initial: readonly RawCue[],
  ranges: readonly Line[],
  grammar: ExplicitSegmentGrammarContract,
  deps: ExplicitSegmentParserDependencies,
): RawCue[] {
  const segmented = segmentRawCues(text, initial, ranges, grammar, deps);
  const bounded = boundedSegmentCues(text, segmented.raws, segmented.plans, ranges, grammar, deps);
  return applyReferenceBindings(text, bounded, ranges, deps).sort((left, right) =>
    deps.rawCueOrder(left, right, text),
  );
}
