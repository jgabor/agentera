export type RecurringLexicalClass = "common_term" | "known_command" | "path_like";

const COMMON_GRAMMAR_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "do",
  "each",
  "for",
  "from",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "must",
  "no",
  "not",
  "of",
  "on",
  "one",
  "only",
  "or",
  "should",
  "that",
  "the",
  "then",
  "this",
  "to",
  "use",
  "version",
  "when",
  "which",
  "why",
  "with",
  "would",
  "yes",
  "two",
  "three",
]);

const ROUTINE_FREQUENCY_TERMS = new Set(["always", "frequently", "generally", "never", "normally", "occasionally", "often", "rarely", "regularly", "routinely", "seldom", "sometimes", "typically", "usually"]);

const GENERIC_WORKFLOW_TERMS = new Set(["change", "check", "choose", "command", "configuration", "continue", "correction", "decision", "file", "keep", "make", "name", "package", "personal", "project", "repository", "run", "script", "scripts"]);

const KNOWN_COMMAND_WORDS = new Set(["agentera", "bash", "build", "cargo", "cat", "cd", "check", "ci", "curl", "git", "install", "lint", "ls", "make", "node", "npm", "npx", "pnpm", "python", "sh", "tcsh", "test", "tsc", "tsx", "yarn"]);

const KNOWN_COMMAND_INVOCATIONS: Readonly<Record<string, readonly string[]>> = {
  agentera: ["build", "check"],
  cargo: ["build", "test"],
  git: ["add", "branch", "checkout", "commit", "diff", "fetch", "log", "push", "status", "tag"],
  npm: ["install", "test"],
  pnpm: ["build", "install", "lint", "test", "typecheck"],
  yarn: ["build", "install", "lint", "test"],
};

const KNOWN_COMMAND_SPELLINGS = new Set(Object.entries(KNOWN_COMMAND_INVOCATIONS).flatMap(([command, actions]) => actions.map((action) => `${command}${action}`)));

const KNOWN_COMMAND_COMPONENTS = new Set([...KNOWN_COMMAND_WORDS, ...Object.keys(KNOWN_COMMAND_INVOCATIONS), ...Object.values(KNOWN_COMMAND_INVOCATIONS).flat()]);

const PATH_COMPONENTS = new Set(["dist", "home", "lib", "modules", "node", "node_modules", "path", "repo", "src", "tmp"]);

function isKnownCommandSpelling(value: string): boolean {
  const lower = value.toLowerCase();
  if (KNOWN_COMMAND_COMPONENTS.has(lower)) return true;
  const compact = lower.replace(/[\s\-_/\\.:]+/gu, "");
  return KNOWN_COMMAND_SPELLINGS.has(compact);
}

function isDirectPathToken(value: string, text: string, start: number, end: number): boolean {
  if (/[\\/]/u.test(value)) return true;
  const previous = text[start - 1] ?? "";
  const next = text[end] ?? "";
  const dotIsPathPunctuation = previous === "." || (next === "." && /[\p{L}\p{N}]/u.test(text[end + 1] ?? ""));
  return ["/", "\\"].includes(previous) || ["/", "\\"].includes(next) || dotIsPathPunctuation;
}

function isApprovedDerivedPathSpelling(value: string): boolean {
  const segments = value
    .toLowerCase()
    .split(/[-_.:]+/u)
    .filter(Boolean);
  return segments.length >= 2 && segments.every((segment) => PATH_COMPONENTS.has(segment));
}

/** Classify one complete cue without rewriting it or matching arbitrary substrings. */
export function classifyRecurringLexicalToken(value: string, text: string, start: number, end: number): RecurringLexicalClass | null {
  const lower = value.toLowerCase();
  if (COMMON_GRAMMAR_TERMS.has(lower) || ROUTINE_FREQUENCY_TERMS.has(lower) || GENERIC_WORKFLOW_TERMS.has(lower)) {
    return "common_term";
  }
  if (isKnownCommandSpelling(value)) return "known_command";
  if (isDirectPathToken(value, text, start, end) || isApprovedDerivedPathSpelling(value)) {
    return "path_like";
  }
  return null;
}
