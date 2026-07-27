function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locale-independent Unicode caseless-exact equality with no normalization.
 *
 * ECMAScript's `iu` matching supplies Unicode simple case folding. Escaping
 * makes the bounded term literal, while the anchors and terminal lookahead
 * prevent regex syntax and final-line-terminator behavior from widening exact
 * matching. NFC/NFD, accent, and compatibility normalization are intentionally
 * absent, so differently encoded strings remain distinct unless Unicode case
 * folding itself relates them.
 */
export function unicodeCaselessExact(left: string, right: string): boolean {
  const literal = escapeRegExp(left);
  return new RegExp(`^(?:${literal})$(?![\\s\\S])`, "iu").test(right);
}
