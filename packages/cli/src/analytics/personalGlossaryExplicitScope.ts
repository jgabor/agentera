import type { RawCue } from "./personalGlossaryExplicitTypes.js";

const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);

export function contextText(text: string, cue: RawCue): string {
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

export function adjacentScopeTexts(text: string, cue: RawCue): string[] {
  return [adjacentSentence(text, cue.sentenceStart, -1), contextText(text, cue), adjacentSentence(text, cue.sentenceEnd, 1)];
}
