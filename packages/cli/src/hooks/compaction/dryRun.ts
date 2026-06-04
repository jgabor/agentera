/**
 * One-line formatters and artifact specifications.
 *
 * Each entry type (progress, decisions, health, experiments,
 * todo-resolved) has its own SPECS row, archive heading, and
 * formatOneline function. This module owns the body-field extraction
 * helpers shared by all the formatters.
 */

type Dict = Record<string, any>;

export interface ArtifactSpec {
  name: string;
  entryHeadingRe: RegExp;
  archiveHeading: string | null;
  formatOneline: (entry: Dict) => string;
  onelineHeadingRe: RegExp | null;
  scopedSection: string | null;
}

// --- body field helpers ----------------------------------------------------

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractField(body: string, label: string): string {
  const pattern = new RegExp(`^\\*\\*${escapeRe(label)}\\*\\*:\\s*(.+?)$`, "m");
  const m = pattern.exec(body);
  return m ? m[1].trim() : "";
}

function firstNonEmpty(body: string): string {
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim()) return line.trim();
  }
  return "";
}

export function truncateWords(text: string, limit = 15): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  // Match Python str.split() token count but preserve original spacing on no-trunc.
  const tokenCount = (text.match(/\S+/g) ?? []).length;
  if (tokenCount <= limit) return text;
  return words.slice(0, limit).join(" ") + "...";
}

const HEADER_NUM_RE = /(?:Cycle|Decision|Audit|Experiment)\s+(\d+)/;
const HEADER_DATE_RE = /(\d{4}-\d{2}-\d{2})/;
export const NUMBER_RE = /(?:Cycle|Decision|Audit|Experiment|EXP-)\s*(\d+)/;

export function parseHeader(header: string): [string, string, string] {
  const numMatch = HEADER_NUM_RE.exec(header);
  const dateMatch = HEADER_DATE_RE.exec(header);
  const number = numMatch ? numMatch[1] : "";
  const date = dateMatch ? dateMatch[1] : "";
  const parts = header.split(" · ");
  let title = parts.length >= 2 ? parts[parts.length - 1].trim() : "";
  if (title === date) {
    title = parts.length >= 3 ? parts[parts.length - 2].trim() : "";
  }
  return [number, date, title];
}

// --- one-line formatters ---------------------------------------------------

function formatProgressOneline(entry: Dict): string {
  let [number, date, title] = parseHeader(entry.header);
  if (!title) {
    title = extractField(entry.body, "What") || firstNonEmpty(entry.body);
  }
  title = truncateWords(title || "(no summary)", 20);
  const numberPart = number ? `Cycle ${number}` : "Cycle ?";
  const datePart = date ? ` (${date})` : "";
  return `- ${numberPart}${datePart}: ${title}`;
}

function formatDecisionOneline(entry: Dict): string {
  const [number, date] = parseHeader(entry.header);
  let chosen = extractField(entry.body, "Chosen alternative");
  if (!chosen) chosen = extractField(entry.body, "Chosen");
  if (!chosen) chosen = firstNonEmpty(entry.body);
  chosen = truncateWords(chosen || "(no rationale)", 20);
  const numberPart = number ? `Decision ${number}` : "Decision ?";
  const datePart = date ? ` (${date})` : "";
  return `- ${numberPart}${datePart}: ${chosen}`;
}

function formatHealthOneline(entry: Dict): string {
  const [number, date] = parseHeader(entry.header);
  let grade = extractField(entry.body, "Overall");
  if (!grade) grade = extractField(entry.body, "Grade");
  let trajectory = extractField(entry.body, "Overall trajectory");
  if (!trajectory) trajectory = "";
  const summaryBits: string[] = [];
  if (grade) summaryBits.push(truncateWords(grade, 10));
  if (trajectory && trajectory !== grade) summaryBits.push(truncateWords(trajectory, 10));
  const summary = summaryBits.length > 0 ? summaryBits.join(" | ") : "no summary";
  const numberPart = number ? `Audit ${number}` : "Audit ?";
  const datePart = date ? ` · ${date}` : "";
  return `### ${numberPart}${datePart} (${summary})`;
}

function formatExperimentOneline(entry: Dict): string {
  const [number] = parseHeader(entry.header);
  let summary = extractField(entry.body, "Metric");
  if (!summary) summary = extractField(entry.body, "Conclusion");
  if (!summary) summary = extractField(entry.body, "Result");
  if (!summary) summary = firstNonEmpty(entry.body);
  summary = truncateWords(summary || "(no result)", 15);
  const numberPart = number ? `EXP-${number}` : "EXP-?";
  return `- ${numberPart}: ${summary}`;
}

const TODO_CHECKBOX_RE = /^-\s*\[x\]\s*/;
const TODO_ISS_LABEL_RE = /ISS-\d+:?\s*/;

function isTodoOnelinePassthrough(entry: Dict): boolean {
  return entry.kind === "oneline" && String(entry.header).includes("~~");
}

function stripTodoMetadata(header: string): string {
  let stripped = header.replace(TODO_CHECKBOX_RE, "");
  stripped = stripped.replace(/~~/g, "").trim();
  stripped = stripped.split(" · ")[0].trim();
  stripped = stripped.replace(TODO_ISS_LABEL_RE, "").trim();
  return stripped;
}

export function formatTodoOneline(entry: Dict): string {
  const header = String(entry.header).trim();
  if (isTodoOnelinePassthrough(entry)) {
    return header.startsWith("- ") ? header : `- ${header}`;
  }
  const summary = truncateWords(stripTodoMetadata(header) || "(resolved)", 15);
  return `- [x] ~~${summary}~~`;
}

export const SPECS: Record<string, ArtifactSpec> = {
  progress: {
    name: "progress",
    entryHeadingRe: /^■?\s*##\s+Cycle\s+\d+/m,
    onelineHeadingRe: /^-\s+Cycle\s+\d+/m,
    archiveHeading: "## Archived Cycles",
    formatOneline: formatProgressOneline,
    scopedSection: null,
  },
  decisions: {
    name: "decisions",
    entryHeadingRe: /^##\s+Decision\s+\d+/m,
    onelineHeadingRe: /^-\s+Decision\s+\d+/m,
    archiveHeading: "## Archived Decisions",
    formatOneline: formatDecisionOneline,
    scopedSection: null,
  },
  health: {
    name: "health",
    entryHeadingRe: /^##\s+Audit\s+\d+/m,
    onelineHeadingRe: /^###\s+Audit\s+\d+/m,
    archiveHeading: "## Archived Audits",
    formatOneline: formatHealthOneline,
    scopedSection: null,
  },
  experiments: {
    name: "experiments",
    entryHeadingRe: /^##\s+Experiment\s+\d+/m,
    onelineHeadingRe: /^-\s+EXP-\d+/m,
    archiveHeading: "## Archived Experiments",
    formatOneline: formatExperimentOneline,
    scopedSection: null,
  },
  "todo-resolved": {
    name: "todo-resolved",
    entryHeadingRe: /^-\s+\[x\]\s+/m,
    onelineHeadingRe: null,
    archiveHeading: null,
    formatOneline: formatTodoOneline,
    scopedSection: "## Resolved",
  },
};

export const COMPACTABLE_YAML_ARTIFACTS: Record<string, [string, string]> = {
  progress: ["cycles", "archive"],
  decisions: ["decisions", "archive"],
  health: ["audits", "archive"],
};

export const YAML_SPEC_BY_ARTIFACT: Record<string, string> = {
  progress: "progress",
  decisions: "decisions",
  health: "health",
};

export const NON_COMPACTABLE_ARTIFACTS: Record<string, [string, string]> = {
  changelog: ["exempt", "public release history is not compacted"],
  plan: ["unsupported", "active plan is lifecycle state, not a uniform retained-entry log"],
  docs: ["unsupported", "docs owns artifact mapping and schema metadata"],
  vision: ["protected", "vision state is protected during execution cycles"],
  design: ["unsupported", "design is a human-facing identity artifact, not a uniform retained-entry log"],
};
