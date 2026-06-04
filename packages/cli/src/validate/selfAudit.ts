/**
 * Self-audit checks for artifact writing conventions. Faithful TS port of
 * `scripts/self_audit.py`. Advisory only — report but do not block writes.
 */

import { normalizeArtifactProtocolId } from "../registries/artifactProtocolIds.js";

const FULL_FILE_BUDGETS: Record<string, number> = {
  progress: 3000,
  experiments: 2500,
  health: 2000,
  decisions: 5000,
  todo: 5000,
  changelog: 5000,
  plan: 2500,
  vision: 1500,
  design: 2000,
  docs: 2000,
};

const PER_ENTRY_BUDGETS: Record<string, number> = {
  progress: 500,
  experiments: 300,
  health: 150,
  decisions: 200,
  todo: 100,
  changelog: 300,
  plan: 100,
};

function resolveBudgetArtifact(artifact: string): string {
  return normalizeArtifactProtocolId(artifact) ?? artifact.toLowerCase();
}

const FILE_PATH_RE = /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z]{1,10}\b/;
const REPO_PATH_RE =
  /\b(?:internal|src|lib|pkg|cmd|app|test|tests|doc|docs|script|scripts|skill|skills|hook|hooks|fixture|fixtures|reference|references)(?:\/[A-Za-z0-9_.-]+)+\b/;
const LINE_NUMBER_RE = /:\d{2,}\b/;
const COMMIT_HASH_RE = /\b[0-9a-fA-F]{7,}\b/;
const METRIC_VALUE_RE =
  /\b\d+(?:\.\d+)?\s*(?:ms|s|MB|GB|KB|%|rps|rpm|ops|words|lines|files|items|cycles)\b/;
const BACKTICK_IDENTIFIER_RE = /`[^`]+`/;
const QUOTED_TEXT_RE = /[^"]*"[^"]+"[^"]*/;

const BANNED_PATTERNS: Array<[string, RegExp]> = [
  ["meta-commentary about writing", /Here\s+is\s+the\b/i],
  ["meta-commentary about writing", /I\s+have\s+updated\b/i],
  ["meta-commentary about writing", /I[’']ve\s+written\b/i],
  ["hedging qualifiers", /It\s+seems\s+like\b/i],
  ["hedging qualifiers", /It\s+appears\s+that\b/i],
  ["hedging qualifiers", /\bPossibly\b/i],
  ["redundant transitions", /Moving\s+on\s+to\b/i],
  ["redundant transitions", /Now\s+let[’']s\s+look\s+at\b/i],
  ["self-referential process narration", /I\s+am\s+now\b/i],
  ["self-referential process narration", /The\s+agent\s+is\s+checking\b/i],
  ["filler introductions", /Based\s+on\s+my\s+analysis\b/i],
  ["filler introductions", /After\s+careful\s+consideration\b/i],
  ["summary preambles", /\bIn\s+summary\b/i],
  ["summary preambles", /\bTo\s+recap\b/i],
  ["summary preambles", /\bOverall\b/i],
  ["excessive justification", /I\s+chose\s+this\s+approach\s+because\b/i],
];

/** Count non-whitespace tokens, matching Python's str.split(). */
function wordCount(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

export function checkVerbosity(
  text: string,
  artifact: string,
  budgets: Record<string, number> | null = null,
): [boolean, string] {
  const count = wordCount(text);
  const table = budgets ?? PER_ENTRY_BUDGETS;
  const resolved = resolveBudgetArtifact(artifact);
  let perEntryBudget = table[resolved];
  if (perEntryBudget === undefined) {
    const fullBudget = FULL_FILE_BUDGETS[resolved];
    perEntryBudget = fullBudget !== undefined ? Math.floor(fullBudget / 5) : 500;
  }
  if (count <= perEntryBudget) {
    return [true, ""];
  }
  return [false, `verbosity mismatch: ${count} words exceeds ${perEntryBudget} budget`];
}

export function checkFullFileVerbosity(text: string, artifact: string): [boolean, string] {
  const count = wordCount(text);
  const budget = FULL_FILE_BUDGETS[resolveBudgetArtifact(artifact)] ?? 2500;
  if (count <= budget) {
    return [true, ""];
  }
  return [false, `verbosity mismatch: ${count} words exceeds ${budget} full-file budget`];
}

export function checkAbstraction(text: string): [boolean, string] {
  for (const re of [
    FILE_PATH_RE,
    REPO_PATH_RE,
    LINE_NUMBER_RE,
    COMMIT_HASH_RE,
    METRIC_VALUE_RE,
    BACKTICK_IDENTIFIER_RE,
    QUOTED_TEXT_RE,
  ]) {
    const match = re.exec(text);
    if (match) {
      return [true, match[0]];
    }
  }
  return [false, "abstraction creep: no concrete anchor"];
}

export function checkFiller(text: string): [boolean, string] {
  const matched: string[] = [];
  for (const [name, pattern] of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      if (!matched.includes(name)) {
        matched.push(name);
      }
    }
  }
  if (matched.length === 0) {
    return [true, ""];
  }
  return [false, "filler: " + matched.join(", ")];
}

/** Smoke-validate that self-audit conventions and budgets are wired. */
export function validateSelfAuditConventions(): string[] {
  const errors: string[] = [];
  if (Object.keys(FULL_FILE_BUDGETS).length === 0 || Object.keys(PER_ENTRY_BUDGETS).length === 0) {
    errors.push("self-audit: budget tables must be non-empty");
  }
  const sample = "concrete anchor `scripts/agentera` at line 42 with 12 words total here";
  const [verbosityOk] = checkVerbosity(sample, "progress");
  if (!verbosityOk) {
    errors.push("self-audit: verbosity check failed on smoke sample");
  }
  const [abstractionOk] = checkAbstraction(sample);
  if (!abstractionOk) {
    errors.push("self-audit: abstraction check failed to detect concrete anchor in smoke sample");
  }
  const [fillerOk] = checkFiller("Shipped the plan task with a concrete file path.");
  if (!fillerOk) {
    errors.push("self-audit: filler check false-positive on clean smoke sample");
  }
  const [fillerFailOk, fillerDetail] = checkFiller("In summary, the work is done.");
  if (fillerFailOk || !fillerDetail.includes("filler")) {
    errors.push("self-audit: filler check must flag banned summary preambles");
  }
  return errors;
}

export interface SelfAuditMainOptions {
  out?: (line: string) => void;
}

export function selfAuditMain(opts: SelfAuditMainOptions = {}): number {
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const errors = validateSelfAuditConventions();
  if (errors.length > 0) {
    out("self-audit validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  out("self-audit conventions ok");
  return 0;
}
