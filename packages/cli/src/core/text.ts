export function truncateCodePoints(
  value: string,
  maxChars: number,
  suffix = "",
  trimTrailingWhitespace = false,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxChars) return value;

  const suffixCharacters = Array.from(suffix).slice(0, maxChars);
  const prefix = characters
    .slice(0, Math.max(0, maxChars - suffixCharacters.length))
    .join("");
  return `${trimTrailingWhitespace ? prefix.replace(/\s+$/, "") : prefix}${suffixCharacters.join("")}`;
}
