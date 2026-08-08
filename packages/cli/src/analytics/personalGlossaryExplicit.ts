import type { JsonObject } from "../core/jsonValue.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import { glossaryEntryAuthorityPath } from "../registries/glossaryEntryContract.js";
import {
  compareGlossaryUnicodeStrings,
  stableGlossaryTermIdentity,
} from "../registries/glossaryTermIdentity.js";
import {
  EXPLICIT_GLOSSARY_REASONS,
  type CandidateBounds,
  type ExplicitGlossaryCue,
  type ExplicitGlossaryReason,
  type ExplicitGlossarySpan,
  type RawCue,
  type ValidCue,
} from "./personalGlossaryExplicitTypes.js";

export * from "./personalGlossaryExplicitTypes.js";

const OPEN_TO_CLOSE = new Map<string, string>([
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
  ["「", "」"],
  ["『", "』"],
]);
const CLOSE_TO_OPEN = new Map<string, string>(
  [...OPEN_TO_CLOSE.entries()].map(([open, close]) => [close, open]),
);
const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);
const TERM_EDGE_RE = /[\s,;:()[\]{}]/u;
const LETTER_OR_NUMBER_RE = /[\p{L}\p{N}]/u;
const ACRONYM_RE = /^[\p{Lu}\p{N}][\p{Lu}\p{N}._-]{1,31}$/u;
const DEFINITION_LIST_MARKER_RE = /^(?:definition|term)$/iu;
const DEFINITION_LIST_PREFIX_RE = /^\s*(?:[-*+]\s+)?/u;
const EMPTY_DEFINITION_LIST_MARKER_RE = /^\s*(?:[-*+]\s+)?(?:definition|term)\s*:\s*$/iu;
const EXAMPLE_RE = /\b(?:for\s+example|e\.g\.?|example|such\s+as)\b/iu;
const HYPOTHETICAL_RE =
  /\b(?:if|when|unless|whenever|suppose|assuming|hypothetically|imagine|would|could|might|may)\b/iu;
const QUESTION_RE = /\?|^\s*(?:does|do|did|can|could|would|should|what|why|how)\b/iu;
const INDIRECT_QUESTION_RE =
  /\b(?:i\s+(?:wonder|ask|want\s+to\s+know)|tell\s+me|whether|what|why|how)\b/iu;
const FUTURE_RE =
  /\b(?:will|shall|going\s+to|plan\s+to|intend\s+to|in\s+the\s+future|from\s+now\s+on|later)\b/iu;
const NEGATION_RE =
  /\b(?:does\s+not|doesn['’]t|do\s+not|don['’]t|did\s+not|never|isn['’]t|is\s+not)\b/iu;
const SARCASM_RE = /(?:\b(?:sarcasm|sarcastically|just\s+kidding|jk)\b|\/s(?:\b|$))/iu;
const ATTRIBUTION_RE =
  /(?:\b(?:according\s+to|quoted\s+from|as\s+stated\s+by|the\s+(?:agent|assistant|docs?|documentation)\s+(?:says?|defines?)|[A-Z][\p{L}\p{M}'-]{1,31}\s+(?:says?|defines?|said|wrote|called))\b|^\s*(?!(?:correction|definition|example|note|term|meaning)\b)[\p{L}][\p{L}\p{M}'-]{1,31}\s*:\s*["'“‘`])/iu;
const RETRACTION_RE =
  /\b(?:i\s+retract|retract(?:ed|ion)?|withdraw(?:n|al)?|supersed(?:e|ed|es)|no\s+longer|disregard|take\s+back|replace(?:d|ment)?)\b/iu;
const CORRECTION_RE = /\b(?:actually|correction|not\s+quite|instead|rather)\b/iu;
const PROJECT_SCOPE_RE =
  /\b(?:in|within|for)\s+(?:this|the|our)\s+(?:repo(?:sitory)?|project|codebase)\b|\b(?:repo(?:sitory)?|project|codebase)[ -]only\b|\b(?:project|repo(?:sitory)?|codebase)\s+(?:term|meaning|definition)\b/iu;
const DIRECT_SCOPE_REFERENCE_RE =
  /\b(?:this|that|the\s+(?:following|above|below)|following|above|below)\s+(?:term|meaning|definition|usage|entry)\b/iu;
const FOLLOWING_CUE_REFERENCE_RE = /\b(?:the\s+)?following\s+(?:definition|term|meaning)\b/iu;
const PREVIOUS_CUE_REFERENCE_RE = /\bthis\s+(?:definition|term|meaning)\b/iu;
const PERSONAL_SCOPE_RE =
  /\b(?:i|we)\s+(?:use|mean|call|define)\b|\bmy\s+(?:term|meaning|definition)\b|\bfor\s+me\b|\bpersonally\b/iu;

export function dataObject(record: JsonObject): Record<string, unknown> {
  const data = record.data;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

export function compareText(left: string, right: string): number {
  return compareGlossaryUnicodeStrings(left, right);
}

export function utf8Span(text: string, start: number, end: number): ExplicitGlossarySpan {
  return {
    start: Buffer.byteLength(text.slice(0, start), "utf8"),
    end: Buffer.byteLength(text.slice(0, end), "utf8"),
  };
}

function scalarAt(text: string, index: number): string {
  const value = text.codePointAt(index);
  return value === undefined ? "" : String.fromCodePoint(value);
}

function isApostropheInWord(text: string, index: number): boolean {
  return (
    text[index] === "'" &&
    LETTER_OR_NUMBER_RE.test(scalarAt(text, index - 1)) &&
    LETTER_OR_NUMBER_RE.test(scalarAt(text, index + 1))
  );
}

function delimitedRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: Array<{ open: string; close: string; start: number }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (isApostropheInWord(text, index)) continue;
    const current = stack.at(-1);
    if (current) {
      if (
        character === current.close &&
        !(current.open === current.close && index === current.start)
      ) {
        stack.pop();
        ranges.push({ start: current.start, end: index });
      }
      continue;
    }
    const close = OPEN_TO_CLOSE.get(character);
    if (close) stack.push({ open: character, close, start: index });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function insideRange(index: number, ranges: readonly { start: number; end: number }[]): boolean {
  for (const range of ranges) {
    if (range.start >= index) break;
    if (index < range.end) return true;
  }
  return false;
}

function sentenceBoundaries(
  text: string,
  ranges: readonly { start: number; end: number }[],
): number[] {
  const boundaries: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (!SENTENCE_TERMINATORS.has(character) || insideRange(index, ranges)) continue;
    if (
      character === "." &&
      ((/[\p{N}]/u.test(text[index - 1] ?? "") && /[\p{N}]/u.test(text[index + 1] ?? "")) ||
        (text[index + 1] !== "" && !/[\s"'”’)]/u.test(text[index + 1] ?? "")))
    ) {
      continue;
    }
    boundaries.push(index + 1);
  }
  return boundaries;
}

function previousBoundary(boundaries: readonly number[], index: number): number {
  let result = 0;
  for (const boundary of boundaries) {
    if (boundary > index) break;
    result = boundary;
  }
  return result;
}

function nextBoundary(text: string, boundaries: readonly number[], index: number): number {
  for (const boundary of boundaries) {
    if (boundary > index) return boundary;
  }
  return text.length;
}

function trimWhitespace(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/u.test(text[start]!)) start += 1;
  while (end > start && /\s/u.test(text[end - 1]!)) end -= 1;
  return [start, end];
}

function trimTerm(text: string, start: number, end: number): [number, number] {
  [start, end] = trimWhitespace(text, start, end);
  while (start < end && TERM_EDGE_RE.test(text[start]!)) start += 1;
  while (end > start && TERM_EDGE_RE.test(text[end - 1]!)) end -= 1;
  return trimWhitespace(text, start, end);
}

function trimMeaning(text: string, start: number, end: number): [number, number] {
  [start, end] = trimWhitespace(text, start, end);
  while (end > start && SENTENCE_TERMINATORS.has(text[end - 1]!)) end -= 1;
  return trimWhitespace(text, start, end);
}

function lastIndexOutsideRanges(
  text: string,
  character: string,
  start: number,
  end: number,
  ranges: readonly { start: number; end: number }[],
): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (text[index] === character && !insideRange(index, ranges)) return index;
  }
  return -1;
}

function delimitedTermBefore(text: string, end: number, floor: number): [number, number] | null {
  while (end > floor && /[\s,;:]/u.test(text[end - 1]!)) end -= 1;
  const close = text[end - 1];
  if (!close || !CLOSE_TO_OPEN.has(close)) return null;
  const open = CLOSE_TO_OPEN.get(close)!;
  const openIndex = text.lastIndexOf(open, end - 2);
  if (openIndex < floor || openIndex >= end - 1) return null;
  const [start, finish] = trimWhitespace(text, openIndex + 1, end - 1);
  return finish > start ? [start, finish] : [start, finish];
}

function lastWordIndex(text: string, word: string, start: number, end: number): number {
  const expression = new RegExp(`(?:^|[^\\p{L}\\p{N}_])${word}(?=$|[^\\p{L}\\p{N}_])`, "giu");
  let result = -1;
  for (const match of text.slice(start, end).matchAll(expression)) {
    result = start + (match.index ?? 0) + (match[0].length - word.length);
  }
  return result;
}

function removeLeadingTermLabel(text: string, start: number, end: number): number {
  const value = text.slice(start, end);
  const match = /^(?:the\s+)?(?:term|word|phrase|concept)\s*[:=]?\s+/iu.exec(value);
  return match ? start + match[0].length : start;
}

function unquotedTermBefore(
  text: string,
  cueStart: number,
  segmentStart: number,
  kind: string,
  ranges: readonly { start: number; end: number }[],
): [number, number] {
  let start = segmentStart;
  const prefixEnd = cueStart;
  const prefix = text.slice(segmentStart, prefixEnd);
  if (kind === "by_i_mean") {
    const by = lastWordIndex(text, "by", segmentStart, prefixEnd);
    if (by >= 0) start = by + 2;
  } else if (kind === "use_for" || kind === "use_to_mean") {
    const use = lastWordIndex(text, "use", segmentStart, prefixEnd);
    if (use >= 0) start = use + 3;
  } else {
    const directives = [
      "to clarify",
      "prefer",
      "please use",
      "i use",
      "use",
      "actually",
      "correction",
      "not quite",
      "instead",
      "rather",
    ];
    let directiveEnd = -1;
    for (const directive of directives) {
      const expression = new RegExp(
        `(?:^|[^\\p{L}\\p{N}_])${directive}(?=$|[^\\p{L}\\p{N}_])`,
        "giu",
      );
      for (const match of prefix.matchAll(expression)) {
        const end = segmentStart + (match.index ?? 0) + match[0].length;
        if (end > directiveEnd) directiveEnd = end;
      }
    }
    if (directiveEnd >= 0) start = directiveEnd;
    const separator = Math.max(
      lastIndexOutsideRanges(text, ",", start, prefixEnd, ranges),
      lastIndexOutsideRanges(text, ";", start, prefixEnd, ranges),
      lastIndexOutsideRanges(text, ":", start, prefixEnd, ranges),
    );
    if (separator >= start) start = separator + 1;
  }
  start = removeLeadingTermLabel(text, start, prefixEnd);
  let result = trimTerm(text, start, cueStart);
  return result;
}

function matchingClose(text: string, openIndex: number): number {
  const open = text[openIndex];
  const close = open ? OPEN_TO_CLOSE.get(open) : undefined;
  if (!close) return -1;
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function meaningSpan(
  text: string,
  cueEnd: number,
  sentenceEnd: number,
  ranges: readonly { start: number; end: number }[],
): [number, number] {
  let start = cueEnd;
  while (start < sentenceEnd && /[\s:,-]/u.test(text[start]!)) start += 1;
  let end = sentenceEnd;
  for (let index = cueEnd; index < sentenceEnd; index += 1) {
    if (text[index] !== "\n" || insideRange(index, ranges)) continue;
    const nextLineStart = index + 1;
    const nextLineEnd =
      text.indexOf("\n", nextLineStart) < 0 ? sentenceEnd : text.indexOf("\n", nextLineStart);
    if (looksLikeDefinitionLine(text, nextLineStart, nextLineEnd, ranges)) {
      end = index;
      break;
    }
  }
  return trimMeaning(text, start, end);
}

function unwrapMeaning(text: string, start: number, end: number): [number, number] {
  [start, end] = trimMeaning(text, start, end);
  const open = text[start];
  if (!open || !OPEN_TO_CLOSE.has(open)) return [start, end];
  const close = matchingClose(text, start);
  if (close !== end - 1) return [start, end];
  return trimWhitespace(text, start + 1, close);
}

function parseWordCue(
  text: string,
  cueStart: number,
  cueEnd: number,
  kind: string,
  boundaries: readonly number[],
  ranges: readonly { start: number; end: number }[],
  termEndForParsing = cueStart,
): RawCue {
  const sentenceStart = previousBoundary(boundaries, cueStart);
  const sentenceBoundary = nextBoundary(text, boundaries, cueStart);
  const term = delimitedTermBefore(text, termEndForParsing, sentenceStart);
  const [termStart, termEnd] =
    term ?? unquotedTermBefore(text, termEndForParsing, sentenceStart, kind, ranges);
  const [meaningStart, meaningEnd] = unwrapMeaning(
    text,
    ...meaningSpan(text, cueEnd, sentenceBoundary, ranges),
  );
  return {
    kind,
    termStart,
    termEnd,
    meaningStart,
    meaningEnd,
    sentenceStart,
    sentenceEnd: sentenceBoundary,
  };
}

function wordCues(
  text: string,
  boundaries: readonly number[],
  ranges: readonly { start: number; end: number }[],
): RawCue[] {
  const patterns: Array<{ kind: string; expression: RegExp }> = [
    { kind: "means", expression: /\bmeans\b/giu },
    { kind: "refers_to", expression: /\brefers\s+to\b/giu },
    { kind: "stands_for", expression: /\bstands\s+for\b/giu },
    { kind: "use_to_mean", expression: /\bto\s+mean\b/giu },
    { kind: "by_i_mean", expression: /\bi\s+mean\b/giu },
  ];
  const cues: RawCue[] = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.expression)) {
      const start = match.index ?? 0;
      if (insideRange(start, ranges)) continue;
      if (pattern.kind === "by_i_mean") {
        const sentenceStart = previousBoundary(boundaries, start);
        if (lastWordIndex(text, "by", sentenceStart, start) < 0) continue;
      }
      cues.push(
        parseWordCue(text, start, start + match[0].length, pattern.kind, boundaries, ranges),
      );
    }
  }
  for (const match of text.matchAll(/\bfor\b/giu)) {
    const start = match.index ?? 0;
    if (insideRange(start, ranges)) continue;
    const sentenceStart = previousBoundary(boundaries, start);
    if (lastWordIndex(text, "use", sentenceStart, start) < 0) continue;
    cues.push(parseWordCue(text, start, start + match[0].length, "use_for", boundaries, ranges));
  }
  for (const match of text.matchAll(/\bmean\b/giu)) {
    const start = match.index ?? 0;
    if (insideRange(start, ranges)) continue;
    const sentenceStart = previousBoundary(boundaries, start);
    const sentenceEnd = nextBoundary(text, boundaries, start);
    const prefix = text.slice(sentenceStart, start);
    const sentence = text.slice(sentenceStart, sentenceEnd);
    if (
      lastWordIndex(text, "by", sentenceStart, start) >= 0 ||
      (!NEGATION_RE.test(prefix) &&
        !QUESTION_RE.test(sentence) &&
        !/^\s*(?:does|do|did|can|could|would|should|when|may)\b/iu.test(prefix))
    ) {
      continue;
    }
    const negation = /(?:does\s+not|doesn['’]t|do\s+not|don['’]t|did\s+not|never)\s*$/iu.exec(
      prefix,
    );
    cues.push(
      parseWordCue(
        text,
        start,
        start + match[0].length,
        "special_mean",
        boundaries,
        ranges,
        negation ? sentenceStart + negation.index : start,
      ),
    );
  }
  return cues;
}

function lineRanges(text: string): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text[index] !== "\n") continue;
    lines.push({ start, end: index });
    start = index + 1;
  }
  return lines;
}

function colonOutsideRanges(
  text: string,
  start: number,
  end: number,
  ranges: readonly { start: number; end: number }[],
): number {
  for (let index = start; index < end; index += 1) {
    if (text[index] === ":" && !insideRange(index, ranges)) return index;
  }
  return -1;
}

function acronymInitials(value: string): string {
  const initials: string[] = [];
  for (const word of value.trim().split(/\s+/u).filter(Boolean)) {
    const letters = [...word].filter((character) => LETTER_OR_NUMBER_RE.test(character));
    if (letters.length === 0) continue;
    const capitals = letters.filter(
      (character) => character.toUpperCase() === character && character.toLowerCase() !== character,
    );
    if (capitals.length > 1) initials.push(...capitals);
    else initials.push(letters[0]!);
  }
  return initials.join("");
}

function acronymExpansionMatches(term: string, meaning: string): boolean {
  if (!ACRONYM_RE.test(term) || Buffer.byteLength(term, "utf8") > 32) return false;
  const words = meaning.trim().split(/\s+/u).filter(Boolean);
  return (
    words.length > 0 &&
    words.length <= 32 &&
    acronymInitials(meaning).toLowerCase() === term.toLowerCase()
  );
}

function safeDefinitionListTerm(
  text: string,
  lineStart: number,
  termFloor: number,
  colon: number,
  termStart: number,
  termEnd: number,
  meaningStart: number,
  meaningEnd: number,
  marked: boolean,
): boolean {
  const term = text.slice(termStart, termEnd);
  const meaning = text.slice(meaningStart, meaningEnd);
  const delimited = delimitedTermBefore(text, colon, termFloor);
  const exactlyDelimited =
    delimited?.[0] === termStart &&
    delimited[1] === termEnd &&
    text.slice(termFloor, Math.max(termFloor, termStart - 1)).trim().length === 0 &&
    text.slice(termEnd + 1, colon).trim().length === 0;
  if (text.slice(lineStart, termStart).includes("#")) return false;
  if (
    /[/\\=@#[\]{}]/u.test(term) ||
    /:\/\//u.test(text.slice(lineStart, meaningEnd)) ||
    /^(?:https?|ftp):\/\//iu.test(meaning.trim())
  )
    return false;
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(`${term}:${meaning}`.split(/\s+/u)[0]!)) return false;
  if (marked) return LETTER_OR_NUMBER_RE.test(term);
  if (exactlyDelimited) return true;
  if (acronymExpansionMatches(term, meaning)) return true;
  return false;
}

function looksLikeDefinitionLine(
  text: string,
  start: number,
  end: number,
  ranges: readonly { start: number; end: number }[],
): boolean {
  const colon = colonOutsideRanges(text, start, end, ranges);
  if (colon < 0) return false;
  const [termStart, termEnd] = trimTerm(text, start, colon);
  const term = text
    .slice(termStart, termEnd)
    .replace(/^[-*+]\s+/u, "")
    .trim();
  return term.length > 0;
}

function listCues(
  text: string,
  ranges: readonly { start: number; end: number }[],
  boundaries: readonly number[],
): RawCue[] {
  const cues: RawCue[] = [];
  const lines = lineRanges(text);
  for (const [lineIndex, line] of lines.entries()) {
    const firstColon = colonOutsideRanges(text, line.start, line.end, ranges);
    if (firstColon < 0) continue;
    const statementStart = Math.max(line.start, previousBoundary(boundaries, firstColon));
    const prefix = DEFINITION_LIST_PREFIX_RE.exec(text.slice(statementStart, line.end));
    const contentStart = statementStart + (prefix?.[0].length ?? 0);
    if (
      /\b(?:means|refers\s+to|stands\s+for|short\s+for|to\s+mean|i\s+mean)\b/iu.test(
        text.slice(line.start, firstColon),
      )
    ) {
      continue;
    }
    let colon = firstColon;
    let termFloor = contentStart;
    const [firstStart, firstEnd] = trimTerm(text, contentStart, colon);
    const marked = DEFINITION_LIST_MARKER_RE.test(text.slice(firstStart, firstEnd));
    if (marked) {
      colon = colonOutsideRanges(text, colon + 1, line.end, ranges);
      if (colon < 0) continue;
      termFloor = firstColon + 1;
    }
    let [termStart, termEnd] =
      delimitedTermBefore(text, colon, termFloor) ?? trimTerm(text, termFloor, colon);
    const [inlineMeaningStart, inlineMeaningEnd] = unwrapMeaning(
      text,
      ...trimMeaning(text, colon + 1, line.end),
    );
    const meaningBeginsInline = LETTER_OR_NUMBER_RE.test(
      text.slice(inlineMeaningStart, inlineMeaningEnd),
    );
    let meaningLineEnd = line.end;
    let nextLineStart = line.end + 1;
    while (meaningBeginsInline && nextLineStart <= text.length) {
      const nextLineEnd =
        text.indexOf("\n", nextLineStart) < 0 ? text.length : text.indexOf("\n", nextLineStart);
      if (
        nextLineStart >= nextLineEnd ||
        looksLikeDefinitionLine(text, nextLineStart, nextLineEnd, ranges)
      ) {
        break;
      }
      meaningLineEnd = nextLineEnd;
      if (nextLineEnd >= text.length) break;
      nextLineStart = nextLineEnd + 1;
    }
    const cueEnd = Math.min(meaningLineEnd, nextBoundary(text, boundaries, colon));
    const [meaningStart, meaningEnd] = unwrapMeaning(text, ...trimMeaning(text, colon + 1, cueEnd));
    const safe =
      meaningBeginsInline &&
      !EMPTY_DEFINITION_LIST_MARKER_RE.test(
        text.slice(lines[lineIndex - 1]?.start ?? 0, lines[lineIndex - 1]?.end ?? 0),
      ) &&
      safeDefinitionListTerm(
        text,
        line.start,
        termFloor,
        colon,
        termStart,
        termEnd,
        meaningStart,
        meaningEnd,
        marked,
      );
    cues.push({
      kind: "definition_list",
      termStart,
      termEnd,
      meaningStart,
      meaningEnd,
      sentenceStart: previousBoundary(boundaries, termStart),
      sentenceEnd: cueEnd,
      ...(safe ? {} : { rejectionReason: EXPLICIT_GLOSSARY_REASONS.unsafeSyntax }),
    });
  }
  return cues;
}

function phraseBefore(
  text: string,
  start: number,
  ranges: readonly { start: number; end: number }[],
): [number, number] {
  let floor = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (
      text[index] === "\n" ||
      text[index] === "." ||
      text[index] === "!" ||
      text[index] === "?" ||
      text[index] === ","
    ) {
      if (!insideRange(index, ranges)) {
        floor = index + 1;
        break;
      }
    }
  }
  return trimTerm(text, floor, start);
}

function acronymCues(
  text: string,
  ranges: readonly { start: number; end: number }[],
  boundaries: readonly number[],
): RawCue[] {
  const cues: RawCue[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "(" || insideRange(index, ranges)) continue;
    const close = text.indexOf(")", index + 1);
    if (close < 0 || insideRange(close, ranges)) continue;
    const [innerStart, innerEnd] = trimWhitespace(text, index + 1, close);
    const inner = text.slice(innerStart, innerEnd);
    const [leftStart, leftEnd] = phraseBefore(text, index, ranges);
    const left = text.slice(leftStart, leftEnd);
    const sentenceStart = previousBoundary(boundaries, index);
    const sentenceEnd = nextBoundary(text, boundaries, index);
    if (ACRONYM_RE.test(left) && acronymExpansionMatches(left, inner)) {
      cues.push({
        kind: "acronym_parenthetical",
        termStart: leftStart,
        termEnd: leftEnd,
        meaningStart: innerStart,
        meaningEnd: innerEnd,
        sentenceStart,
        sentenceEnd,
      });
    } else if (ACRONYM_RE.test(inner) && acronymExpansionMatches(inner, left)) {
      cues.push({
        kind: "acronym_parenthetical",
        termStart: innerStart,
        termEnd: innerEnd,
        meaningStart: leftStart,
        meaningEnd: leftEnd,
        sentenceStart,
        sentenceEnd,
      });
    }
    index = close;
  }
  return cues;
}

function rawCueKey(cue: RawCue): string {
  return [cue.termStart, cue.termEnd, cue.meaningStart, cue.meaningEnd, cue.kind].join(":");
}

function rawCueOrder(left: RawCue, right: RawCue, text: string): number {
  return (
    left.termStart - right.termStart ||
    left.meaningStart - right.meaningStart ||
    compareText(
      text.slice(left.termStart, left.termEnd),
      text.slice(right.termStart, right.termEnd),
    ) ||
    compareText(
      text.slice(left.meaningStart, left.meaningEnd),
      text.slice(right.meaningStart, right.meaningEnd),
    ) ||
    compareText(left.kind, right.kind)
  );
}

export function rawCues(text: string): RawCue[] {
  const ranges = delimitedRanges(text);
  const boundaries = sentenceBoundaries(text, ranges);
  const all = [
    ...wordCues(text, boundaries, ranges),
    ...listCues(text, ranges, boundaries),
    ...acronymCues(text, ranges, boundaries),
  ];
  const unique = new Map<string, RawCue>();
  for (const cue of all) unique.set(rawCueKey(cue), cue);
  return [...unique.values()].sort((left, right) => rawCueOrder(left, right, text));
}

function cueValue(text: string, cue: RawCue): { term: string; meaning: string } {
  return {
    term: text.slice(cue.termStart, cue.termEnd),
    meaning: text.slice(cue.meaningStart, cue.meaningEnd),
  };
}

function contextText(text: string, cue: RawCue): string {
  return text.slice(cue.sentenceStart, cue.sentenceEnd);
}

function adjacentSentence(text: string, start: number, direction: -1 | 1): string {
  if (direction === -1) {
    const end = Math.max(0, start);
    let boundary = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (SENTENCE_TERMINATORS.has(text[index]!)) {
        boundary = index;
        break;
      }
    }
    const previousEnd = boundary + 1;
    let previousBoundary = -1;
    for (let index = previousEnd - 2; index >= 0; index -= 1) {
      if (SENTENCE_TERMINATORS.has(text[index]!)) {
        previousBoundary = index;
        break;
      }
    }
    return text.slice(previousBoundary + 1, previousEnd).trim();
  }
  const startAt = Math.min(text.length, start);
  let end = text.length;
  for (let index = startAt; index < text.length; index += 1) {
    if (SENTENCE_TERMINATORS.has(text[index]!)) {
      end = index + 1;
      break;
    }
  }
  return text.slice(startAt, end).trim();
}

function termOccurs(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(
    `(?<![\\p{ID_Continue}$\\u200C\\u200D])${escaped}(?![\\p{ID_Continue}$\\u200C\\u200D])`,
    "iu",
  ).test(text);
}

function adjacentScopeTexts(text: string, cue: RawCue): string[] {
  return [
    adjacentSentence(text, cue.sentenceStart, -1),
    contextText(text, cue),
    adjacentSentence(text, cue.sentenceEnd, 1),
  ];
}

function adjacentContextReason(
  text: string,
  cue: RawCue,
  term: string,
): ExplicitGlossaryReason | null {
  const [previous, _current, next] = adjacentScopeTexts(text, cue);
  for (const [sentence, directReference] of [
    [previous, FOLLOWING_CUE_REFERENCE_RE],
    [next, PREVIOUS_CUE_REFERENCE_RE],
  ] as const) {
    if (!sentence || (!termOccurs(sentence, term) && !directReference.test(sentence))) continue;
    if (EXAMPLE_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.exampleContext;
    if (HYPOTHETICAL_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition;
    if (INDIRECT_QUESTION_RE.test(sentence) || QUESTION_RE.test(sentence)) {
      return EXPLICIT_GLOSSARY_REASONS.indirectQuestion;
    }
    if (FUTURE_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.futureDefinition;
  }
  return null;
}

function scopeReason(
  text: string,
  cue: RawCue,
  record?: JsonObject,
): ExplicitGlossaryReason | null {
  const dataScope = String(dataObject(record ?? {}).scope ?? "").toLowerCase();
  const sentences = adjacentScopeTexts(text, cue);
  const term = text.slice(cue.termStart, cue.termEnd).trim();
  const project =
    dataScope === "project" ||
    dataScope === "project_only" ||
    sentences.some(
      (sentence, index) =>
        PROJECT_SCOPE_RE.test(sentence) &&
        (index === 1 ||
          termOccurs(sentence, term) ||
          DIRECT_SCOPE_REFERENCE_RE.test(sentence) ||
          /:\s*$/u.test(sentence)),
    );
  const personal = sentences.some(
    (sentence) => PERSONAL_SCOPE_RE.test(sentence) && termOccurs(sentence, term),
  );
  if (project && personal) return EXPLICIT_GLOSSARY_REASONS.uncertainScope;
  if (project) return EXPLICIT_GLOSSARY_REASONS.projectOnlyScope;
  return null;
}

function pureCueReason(
  text: string,
  cue: RawCue,
  record?: JsonObject,
): ExplicitGlossaryReason | null {
  const value = cueValue(text, cue);
  if (!value.term.trim()) return EXPLICIT_GLOSSARY_REASONS.emptyTerm;
  if (!value.meaning.trim()) return EXPLICIT_GLOSSARY_REASONS.emptyMeaning;
  if (
    (value.term.startsWith('"') ||
      value.term.startsWith("'") ||
      value.term.startsWith("`") ||
      value.term.startsWith("“") ||
      value.term.startsWith("‘")) &&
    !value.term.endsWith('"') &&
    !value.term.endsWith("'") &&
    !value.term.endsWith("`") &&
    !value.term.endsWith("”") &&
    !value.term.endsWith("’")
  ) {
    return EXPLICIT_GLOSSARY_REASONS.malformedSpan;
  }
  const sentence = contextText(text, cue);
  const beforeCue = text.slice(cue.sentenceStart, cue.termStart);
  if (EXAMPLE_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.exampleContext;
  if (NEGATION_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.negatedDefinition;
  if (HYPOTHETICAL_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.hypotheticalDefinition;
  if (QUESTION_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.questionDefinition;
  if (INDIRECT_QUESTION_RE.test(beforeCue)) return EXPLICIT_GLOSSARY_REASONS.indirectQuestion;
  if (FUTURE_RE.test(beforeCue)) return EXPLICIT_GLOSSARY_REASONS.futureDefinition;
  if (SARCASM_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.sarcasmMarker;
  if (ATTRIBUTION_RE.test(sentence)) return EXPLICIT_GLOSSARY_REASONS.attributedQuotation;
  if (RETRACTION_RE.test(beforeCue) && !CORRECTION_RE.test(beforeCue)) {
    return EXPLICIT_GLOSSARY_REASONS.retractedDefinition;
  }
  const adjacent = adjacentContextReason(text, cue, value.term.trim());
  if (adjacent) return adjacent;
  const scope = scopeReason(text, cue, record);
  if (scope) return scope;
  return null;
}

export function candidateBounds(): CandidateBounds {
  const authority = loadYamlMappingFile(glossaryEntryAuthorityPath()) as {
    candidate_contracts?: { bounds?: Record<string, unknown> };
  };
  const bounds = authority.candidate_contracts?.bounds;
  const value = (field: string): number => {
    const number = Number(bounds?.[field]);
    if (!Number.isInteger(number) || number <= 0) {
      throw new TypeError(`candidate contract bound ${field} is invalid`);
    }
    return number;
  };
  return {
    term: value("term_max_utf8_bytes"),
    meaning: value("meaning_max_utf8_bytes"),
    binding: value("binding_max_utf8_bytes"),
  };
}

export function validCue(
  text: string,
  cue: RawCue,
  bounds: CandidateBounds,
  record?: JsonObject,
): { cue: ValidCue | null; reason: ExplicitGlossaryReason | null } {
  if (cue.rejectionReason) return { cue: null, reason: cue.rejectionReason };
  const reason = pureCueReason(text, cue, record);
  if (reason) return { cue: null, reason };
  const [termStart, termEnd] = trimTerm(text, cue.termStart, cue.termEnd);
  const [meaningStart, meaningEnd] = trimMeaning(text, cue.meaningStart, cue.meaningEnd);
  const term = text.slice(termStart, termEnd);
  const meaning = text.slice(meaningStart, meaningEnd);
  if (!term) return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.emptyTerm };
  if (!meaning) return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.emptyMeaning };
  if (!LETTER_OR_NUMBER_RE.test(term))
    return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.malformedSpan };
  if (!LETTER_OR_NUMBER_RE.test(meaning))
    return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.malformedSpan };
  if (cue.kind === "stands_for" && !acronymExpansionMatches(term, meaning)) {
    return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.unsafeSyntax };
  }
  if (Buffer.byteLength(term, "utf8") > bounds.term) {
    return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.termBoundExceeded };
  }
  if (Buffer.byteLength(meaning, "utf8") > bounds.meaning) {
    return { cue: null, reason: EXPLICIT_GLOSSARY_REASONS.meaningBoundExceeded };
  }
  return {
    cue: { ...cue, termStart, termEnd, meaningStart, meaningEnd, term, meaning },
    reason: null,
  };
}

export function retractionInvalidatesCue(
  text: string,
  cue: ValidCue,
  otherCues: readonly RawCue[],
): boolean {
  const nextSameTerm = otherCues.find(
    (other) =>
      other.termStart > cue.termStart &&
      stableGlossaryTermIdentity(text.slice(other.termStart, other.termEnd).trim()) ===
        stableGlossaryTermIdentity(cue.term),
  );
  const limit = nextSameTerm
    ? nextSameTerm.termStart
    : Math.min(text.length, cue.sentenceEnd + 512);
  const suffix = text.slice(cue.meaningEnd, limit);
  const marker = RETRACTION_RE.exec(suffix);
  if (marker) {
    const after = suffix.slice(marker.index);
    const sameSentence = marker.index < Math.max(0, cue.sentenceEnd - cue.meaningEnd);
    if (
      termOccurs(after, cue.term) ||
      /\b(?:that|the\s+(?:previous|earlier|above))\s+(?:definition|meaning|term)\b/iu.test(after) ||
      (sameSentence && /\b(?:it|that)\b\s*(?:$|[.!?,;:])/iu.test(after))
    ) {
      return true;
    }
  }
  if (!nextSameTerm) return false;
  return CORRECTION_RE.test(contextText(text, nextSameTerm));
}

/**
 * Recognize explicit definitions in one source string without provenance or
 * downstream admission. The returned text is copied exactly, while spans use
 * UTF-8 byte offsets like the other deterministic source-span contracts.
 */
export function discoverExplicitGlossaryCues(text: string): ExplicitGlossaryCue[] {
  const bounds = candidateBounds();
  const raws = rawCues(text);
  const valid: Array<{ raw: RawCue; cue: ValidCue }> = [];
  for (const raw of raws) {
    const result = validCue(text, raw, bounds);
    if (!result.cue) continue;
    if (retractionInvalidatesCue(text, result.cue, raws)) continue;
    valid.push({ raw, cue: result.cue });
  }
  const grouped = new Map<string, Array<{ raw: RawCue; cue: ValidCue }>>();
  for (const item of valid) {
    const identity = stableGlossaryTermIdentity(item.cue.term);
    const group = grouped.get(identity) ?? [];
    group.push(item);
    grouped.set(identity, group);
  }
  const output: ExplicitGlossaryCue[] = [];
  for (const group of grouped.values()) {
    if (new Set(group.map((item) => item.cue.meaning)).size > 1) continue;
    const item = [...group].sort((left, right) => rawCueOrder(left.raw, right.raw, text))[0]!;
    const cue = item.cue;
    output.push({
      term: cue.term,
      meaning: cue.meaning,
      term_span: utf8Span(text, cue.termStart, cue.termEnd),
      meaning_span: utf8Span(text, cue.meaningStart, cue.meaningEnd),
    });
  }
  const unique = new Map<string, ExplicitGlossaryCue>();
  for (const cue of output) {
    unique.set(
      `${stableGlossaryTermIdentity(cue.term)}:${cue.meaning}:${cue.term_span.start}:${cue.meaning_span.start}`,
      cue,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.term, right.term) ||
      compareText(left.meaning, right.meaning) ||
      left.term_span.start - right.term_span.start,
  );
}

/** Backwards-compatible narrow classifier, now backed by the deterministic cue parser. */
export function classifyExplicitGlossaryLanguage(
  text: string,
): { term: string; meaning: string } | null {
  const cues = discoverExplicitGlossaryCues(text);
  if (cues.length === 0) return null;
  const identities = new Map<string, Set<string>>();
  for (const cue of cues) {
    const identity = stableGlossaryTermIdentity(cue.term);
    const meanings = identities.get(identity) ?? new Set<string>();
    meanings.add(cue.meaning);
    identities.set(identity, meanings);
  }
  if ([...identities.values()].some((meanings) => meanings.size > 1)) return null;
  const first = cues[0]!;
  return { term: first.term, meaning: first.meaning };
}

export {
  mineExplicitGlossaryCandidates,
  mineExplicitGlossaryEvidence,
  minePersonalExplicitGlossaryCandidates,
} from "./personalGlossaryExplicitMining.js";
