const IDENTIFIER_CONTINUATION = "[\\p{ID_Continue}$\\u200C\\u200D]";
const identifierContinuation = new RegExp(`^${IDENTIFIER_CONTINUATION}$`, "u");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find one exact-case, non-normalizing glossary term occurrence on a source line.
 * Boundaries follow ECMAScript identifier continuation: Unicode ID_Continue,
 * `$`, ZWNJ (U+200C), and ZWJ (U+200D).
 */
export function containsGlossaryTerm(line: string, term: string): boolean {
  const characters = [...term];
  const prefix = identifierContinuation.test(characters[0] ?? "")
    ? `(?<!${IDENTIFIER_CONTINUATION})`
    : "";
  const suffix = identifierContinuation.test(characters.at(-1) ?? "")
    ? `(?!${IDENTIFIER_CONTINUATION})`
    : "";
  return new RegExp(`${prefix}${escapeRegExp(term)}${suffix}`, "u").test(line);
}
