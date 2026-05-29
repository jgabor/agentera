import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { loadYamlMapping } from "../core/yaml.js";
import {
  DEFAULT_ARTIFACT_PATHS,
  MAX_FULL_ENTRIES,
  MAX_ONELINE_ENTRIES,
  MAX_TOTAL_ENTRIES,
  applyRetentionCaps,
  parseDocsYamlMapping,
} from "./common.js";

/**
 * Shared compaction engine for growing artifacts (uniform 10/40/50). Faithful TS
 * port of hooks/compaction.py.
 */

type Dict = Record<string, any>;

export interface CompactResult {
  full_before: number;
  oneline_before: number;
  full_after: number;
  oneline_after: number;
  dropped: number;
  changed: boolean;
}

export interface CompactionStatus {
  artifact: string;
  path: string;
  classification: string;
  active_count: number | null;
  archive_count: number | null;
  total_count: number | null;
  over_limit_count: number | null;
  reason: string;
  protected_overflow_count: number | null;
  exists: boolean;
}

export interface CompactionOperation {
  status: CompactionStatus;
  mode: string;
  action: string;
  changed: boolean;
  result: CompactResult | null;
  message: string;
}

export interface ArtifactSpec {
  name: string;
  entryHeadingRe: RegExp;
  archiveHeading: string | null;
  formatOneline: (entry: Dict) => string;
  onelineHeadingRe: RegExp | null;
  scopedSection: string | null;
}

// --- body field helpers ----------------------------------------------------

function extractField(body: string, label: string): string {
  const pattern = new RegExp(`^\\*\\*${escapeRe(label)}\\*\\*:\\s*(.+?)$`, "m");
  const m = pattern.exec(body);
  return m ? m[1].trim() : "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstNonEmpty(body: string): string {
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line.trim()) return line.trim();
  }
  return "";
}

function truncateWords(text: string, limit = 15): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  // Match Python str.split() token count but preserve original spacing on no-trunc.
  const tokenCount = (text.match(/\S+/g) ?? []).length;
  if (tokenCount <= limit) return text;
  return words.slice(0, limit).join(" ") + "...";
}

const HEADER_NUM_RE = /(?:Cycle|Decision|Audit|Experiment)\s+(\d+)/;
const HEADER_DATE_RE = /(\d{4}-\d{2}-\d{2})/;
const NUMBER_RE = /(?:Cycle|Decision|Audit|Experiment|EXP-)\s*(\d+)/;

function parseHeader(header: string): [string, string, string] {
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

function formatTodoOneline(entry: Dict): string {
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
  "PROGRESS.md": ["cycles", "archive"],
  "DECISIONS.md": ["decisions", "archive"],
  "HEALTH.md": ["audits", "archive"],
};

const YAML_SPEC_BY_ARTIFACT: Record<string, string> = {
  "PROGRESS.md": "progress",
  "DECISIONS.md": "decisions",
  "HEALTH.md": "health",
};

const NON_COMPACTABLE_ARTIFACTS: Record<string, [string, string]> = {
  "CHANGELOG.md": ["exempt", "public release history is not compacted"],
  "PLAN.md": ["unsupported", "active plan is lifecycle state, not a uniform retained-entry log"],
  "DOCS.md": ["unsupported", "docs owns artifact mapping and schema metadata"],
  "VISION.md": ["protected", "vision state is protected during execution cycles"],
  "DESIGN.md": ["unsupported", "design is a human-facing identity artifact, not a uniform retained-entry log"],
};

function overLimitCount(activeCount: number, archiveCount: number): number {
  const totalCount = activeCount + archiveCount;
  return Math.max(
    Math.max(activeCount - MAX_FULL_ENTRIES, 0),
    Math.max(archiveCount - MAX_ONELINE_ENTRIES, 0),
    Math.max(totalCount - MAX_TOTAL_ENTRIES, 0),
  );
}

function artifactPaths(projectRoot: string): Record<string, string> {
  const paths: Record<string, string> = { ...DEFAULT_ARTIFACT_PATHS };
  const docsPath = path.join(projectRoot, ".agentera", "docs.yaml");
  if (fs.existsSync(docsPath)) {
    Object.assign(paths, parseDocsYamlMapping(fs.readFileSync(docsPath, "utf8")));
  }
  const resolved: Record<string, string> = {};
  for (const [artifact, rel] of Object.entries(paths)) {
    resolved[artifact] = path.join(projectRoot, rel);
  }
  return resolved;
}

function missingStatus(artifact: string, p: string, classification: string): CompactionStatus {
  return {
    artifact,
    path: p,
    classification,
    active_count: 0,
    archive_count: 0,
    total_count: 0,
    over_limit_count: 0,
    reason: "artifact path is not present",
    protected_overflow_count: 0,
    exists: false,
  };
}

function yamlErrorStatus(artifact: string, p: string, message: string): CompactionStatus {
  return {
    artifact,
    path: p,
    classification: "error",
    active_count: null,
    archive_count: null,
    total_count: null,
    over_limit_count: null,
    reason: message.trim() || "invalid YAML mapping root",
    protected_overflow_count: 0,
    exists: true,
  };
}

function yamlCounts(p: string, activeKey: string, archiveKey: string): [number, number] {
  const data = loadYamlMapping(fs.readFileSync(p, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) return [0, 0];
  const active = (data as Dict)[activeKey] || [];
  const archive = (data as Dict)[archiveKey] || [];
  return [Array.isArray(active) ? active.length : 0, Array.isArray(archive) ? archive.length : 0];
}

function yamlLists(p: string, activeKey: string, archiveKey: string): [any[], any[]] {
  const data = loadYamlMapping(fs.readFileSync(p, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) return [[], []];
  const active = (data as Dict)[activeKey] || [];
  const archive = (data as Dict)[archiveKey] || [];
  return [Array.isArray(active) ? active : [], Array.isArray(archive) ? archive : []];
}

function yamlEntryNumber(entry: unknown): number {
  let summary: string;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const number = (entry as Dict).number;
    if (typeof number === "number" && Number.isInteger(number)) return number;
    if (typeof number === "string" && /^\d+$/.test(number)) return parseInt(number, 10);
    summary = String((entry as Dict).summary ?? "");
  } else {
    summary = String(entry);
  }
  const match = NUMBER_RE.exec(summary);
  return match ? parseInt(match[1], 10) : 0;
}

function yamlEntryTimestamp(entry: unknown): string {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    return String((entry as Dict).timestamp || (entry as Dict).date || "");
  }
  return "";
}

function yamlSummaryText(entry: Dict, ...fields: string[]): string {
  for (const field of fields) {
    const value = entry[field];
    if (typeof value === "string" && value.trim()) {
      return truncateWords(value.trim(), 15);
    }
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
      return truncateWords(
        Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(", "),
        15,
      );
    }
  }
  return "no summary";
}

function isEmptyish(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
  );
}

function yamlArchiveEntry(specName: string, entry: unknown): Dict {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { summary: String(entry) };
  }
  const e = entry as Dict;
  if (specName === "progress") {
    const number = e.number ?? "?";
    const date = String(e.timestamp ?? "").split(/\s+/)[0] || "";
    const datePart = date ? ` (${date})` : "";
    const summary = yamlSummaryText(e, "what", "type");
    return { summary: `Cycle ${number}${datePart}: ${summary}` };
  }
  if (specName === "decisions") {
    const number = e.number ?? "?";
    const date = String(e.date ?? "");
    const datePart = date ? ` (${date})` : "";
    const choice = yamlSummaryText(e, "choice", "question");
    const archiveEntry: Dict = { summary: `Decision ${number}${datePart}: ${choice}` };
    for (const field of ["number", "date", "choice", "outcome", "feeds_into", "satisfaction"]) {
      const value = e[field];
      if (!isEmptyish(value)) archiveEntry[field] = value;
    }
    if (!("outcome" in archiveEntry) && !isEmptyish(archiveEntry.choice)) {
      archiveEntry.outcome = archiveEntry.choice;
    }
    return archiveEntry;
  }
  if (specName === "health") {
    const number = e.number ?? "?";
    const date = String(e.date ?? "");
    const datePart = date ? ` (${date})` : "";
    const summary = yamlSummaryText(e, "trajectory", "grades");
    return { summary: `Audit ${number}${datePart}: ${summary}` };
  }
  if (specName === "session") {
    return { timestamp: String(e.timestamp ?? ""), summary: yamlSummaryText(e, "summary") };
  }
  return { summary: yamlSummaryText(e, "summary") };
}

function stableSortBy<T>(arr: T[], key: (x: T) => number | string, reverse = false): T[] {
  return arr
    .map((x, i) => [x, i] as [T, number])
    .sort((a, b) => {
      const ka = key(a[0]);
      const kb = key(b[0]);
      let cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      if (reverse) cmp = -cmp;
      return cmp !== 0 ? cmp : a[1] - b[1];
    })
    .map(([x]) => x);
}

function yamlSortEntries(entries: any[], specName: string): any[] {
  if (specName === "decisions" || specName === "health") {
    return stableSortBy(entries, yamlEntryNumber);
  }
  if (specName === "session") {
    return stableSortBy(entries, yamlEntryTimestamp, true);
  }
  return stableSortBy(entries, yamlEntryNumber, true);
}

function yamlRecentFullAndOlder(entries: any[], specName: string): [any[], any[]] {
  const newestFirst =
    specName === "session"
      ? stableSortBy(entries, yamlEntryTimestamp, true)
      : stableSortBy(entries, yamlEntryNumber, true);
  const recent = newestFirst.slice(0, MAX_FULL_ENTRIES);
  const older = newestFirst.slice(MAX_FULL_ENTRIES);
  return [yamlSortEntries(recent, specName), older];
}

function yamlArchiveSortKey(entry: unknown): [string, number | string] {
  const timestamp = yamlEntryTimestamp(entry);
  if (timestamp) return ["timestamp", timestamp];
  return ["number", yamlEntryNumber(entry)];
}

function yamlArchiveEntries(entries: any[]): any[] {
  // Sort by (tag, value) descending, mirroring Python tuple comparison.
  return entries
    .map((x, i) => [x, i] as [any, number])
    .sort((a, b) => {
      const ka = yamlArchiveSortKey(a[0]);
      const kb = yamlArchiveSortKey(b[0]);
      let cmp = 0;
      if (ka[0] !== kb[0]) cmp = ka[0] < kb[0] ? -1 : 1;
      else cmp = ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
      cmp = -cmp;
      return cmp !== 0 ? cmp : a[1] - b[1];
    })
    .map(([x]) => x);
}

function decisionSatisfactionState(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const satisfaction = (entry as Dict).satisfaction;
  if (!satisfaction || typeof satisfaction !== "object") return null;
  const state = satisfaction.state;
  return typeof state === "string" ? state : null;
}

function decisionRequiresUserReview(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return true;
  const satisfaction = (entry as Dict).satisfaction;
  if (!satisfaction || typeof satisfaction !== "object") return true;
  const confirmation = satisfaction.user_confirmation;
  return (
    decisionSatisfactionState(entry) !== "user_confirmed_satisfied" ||
    !confirmation ||
    typeof confirmation !== "object" ||
    Object.keys(confirmation).length === 0
  );
}

function decisionProtectedOverflowCount(active: any[], archive: any[]): number {
  const protectedActive = active.filter((e) => decisionRequiresUserReview(e)).length;
  const protectedArchive = archive.filter((e) => decisionRequiresUserReview(e)).length;
  return Math.max(
    protectedActive - MAX_FULL_ENTRIES,
    protectedArchive - MAX_ONELINE_ENTRIES,
    protectedActive + protectedArchive - MAX_TOTAL_ENTRIES,
    0,
  );
}

function selectDecisionActiveEntries(active: any[]): [any[], any[]] {
  const protectedEntries = active.filter((e) => decisionRequiresUserReview(e));
  if (protectedEntries.length > MAX_FULL_ENTRIES) {
    throw new Error(
      "DECISIONS.md: protected-overflow review pressure; " +
        `${protectedEntries.length} protected active decision(s) exceed ${MAX_FULL_ENTRIES} full-detail slots`,
    );
  }
  const satisfied = active.filter((e) => !decisionRequiresUserReview(e));
  const newestSatisfied = stableSortBy(satisfied, yamlEntryNumber, true);
  const keepSatisfied = newestSatisfied.slice(0, MAX_FULL_ENTRIES - protectedEntries.length);
  const compactSatisfied = newestSatisfied.slice(MAX_FULL_ENTRIES - protectedEntries.length);
  return [yamlSortEntries([...protectedEntries, ...keepSatisfied], "decisions"), compactSatisfied];
}

function selectDecisionArchiveEntries(archiveCandidates: any[]): any[] {
  const protectedEntries = archiveCandidates.filter((e) => decisionRequiresUserReview(e));
  if (protectedEntries.length > MAX_ONELINE_ENTRIES) {
    throw new Error(
      "DECISIONS.md: protected-overflow review pressure; " +
        `${protectedEntries.length} protected archived decision(s) exceed ${MAX_ONELINE_ENTRIES} archive slots`,
    );
  }
  const satisfied = archiveCandidates.filter((e) => !decisionRequiresUserReview(e));
  const keepSatisfied = yamlArchiveEntries(satisfied).slice(0, MAX_ONELINE_ENTRIES - protectedEntries.length);
  return yamlArchiveEntries([...protectedEntries, ...keepSatisfied]);
}

export function compactYamlFile(p: string, artifact: string): CompactResult {
  if (!(artifact in COMPACTABLE_YAML_ARTIFACTS)) {
    throw new Error(`unsupported YAML artifact: ${artifact}`);
  }
  if (!fs.existsSync(p)) {
    throw new Error(p);
  }
  const [activeKey, archiveKey] = COMPACTABLE_YAML_ARTIFACTS[artifact];
  const specName = YAML_SPEC_BY_ARTIFACT[artifact];
  const data = loadYamlMapping(fs.readFileSync(p, "utf8")) as Dict;

  let active = data[activeKey] || [];
  let archive = data[archiveKey] || [];
  if (!Array.isArray(active)) active = [];
  if (!Array.isArray(archive)) archive = [];

  const fullBefore = active.length;
  const onelineBefore = archive.length;
  if (overLimitCount(fullBefore, onelineBefore) === 0) {
    return { full_before: fullBefore, oneline_before: onelineBefore, full_after: fullBefore, oneline_after: onelineBefore, dropped: 0, changed: false };
  }

  let recentFull: any[];
  let olderActive: any[];
  if (specName === "decisions") {
    [recentFull, olderActive] = selectDecisionActiveEntries(active);
  } else {
    [recentFull, olderActive] = yamlRecentFullAndOlder(active, specName);
  }
  const compactedFromActive = olderActive.map((entry) => yamlArchiveEntry(specName, entry));
  const archiveCandidates = yamlArchiveEntries([...compactedFromActive, ...archive]);
  let archiveAfter: any[];
  if (specName === "decisions") {
    archiveAfter = selectDecisionArchiveEntries(archiveCandidates);
  } else {
    const merged = applyRetentionCaps(recentFull as Dict[], archiveCandidates as Dict[]);
    archiveAfter = merged.slice(recentFull.length);
  }

  data[activeKey] = recentFull;
  data[archiveKey] = archiveAfter;
  fs.writeFileSync(p, YAML.stringify(data));

  const fullAfter = recentFull.length;
  const onelineAfter = archiveAfter.length;
  const dropped = fullBefore + onelineBefore - fullAfter - onelineAfter;
  return { full_before: fullBefore, oneline_before: onelineBefore, full_after: fullAfter, oneline_after: onelineAfter, dropped, changed: true };
}

function countStatus(
  artifact: string,
  p: string,
  activeCount: number,
  archiveCount: number,
  protectedOverflowCount = 0,
): CompactionStatus {
  const totalCount = activeCount + archiveCount;
  return {
    artifact,
    path: p,
    classification: "compactable",
    active_count: activeCount,
    archive_count: archiveCount,
    total_count: totalCount,
    over_limit_count: overLimitCount(activeCount, archiveCount),
    reason: protectedOverflowCount ? "protected-overflow review pressure" : "uniform_10_40_50",
    protected_overflow_count: protectedOverflowCount,
    exists: true,
  };
}

export function computeCompactionStatus(projectRoot: string): CompactionStatus[] {
  const paths = artifactPaths(projectRoot);
  const statuses: CompactionStatus[] = [];

  const todoPath = paths["TODO.md"];
  if (fs.existsSync(todoPath)) {
    const entries = parseEntries(fs.readFileSync(todoPath, "utf8"), "todo-resolved");
    const activeCount = entries.filter((e) => e.kind === "full").length;
    const archiveCount = entries.filter((e) => e.kind === "oneline").length;
    statuses.push(countStatus("TODO.md#Resolved", todoPath, activeCount, archiveCount));
  } else {
    statuses.push(missingStatus("TODO.md#Resolved", todoPath, "compactable"));
  }

  for (const [artifact, [activeKey, archiveKey]] of Object.entries(COMPACTABLE_YAML_ARTIFACTS)) {
    const p = paths[artifact];
    if (fs.existsSync(p)) {
      let active: any[];
      let archive: any[];
      try {
        [active, archive] = yamlLists(p, activeKey, archiveKey);
      } catch (exc) {
        statuses.push(yamlErrorStatus(artifact, p, (exc as Error).message));
        continue;
      }
      const protectedOverflowCount =
        artifact === "DECISIONS.md" ? decisionProtectedOverflowCount(active, archive) : 0;
      statuses.push(countStatus(artifact, p, active.length, archive.length, protectedOverflowCount));
    } else {
      statuses.push(missingStatus(artifact, p, "compactable"));
    }
  }

  for (const [artifact, [classification, reason]] of Object.entries(NON_COMPACTABLE_ARTIFACTS)) {
    const p = paths[artifact];
    statuses.push({
      artifact,
      path: p,
      classification,
      active_count: null,
      archive_count: null,
      total_count: null,
      over_limit_count: null,
      reason,
      protected_overflow_count: 0,
      exists: fs.existsSync(p),
    });
  }

  const optimeraDir = path.join(projectRoot, ".agentera", "optimera");
  if (fs.existsSync(optimeraDir) && fs.statSync(optimeraDir).isDirectory()) {
    const experimentPaths: string[] = [];
    for (const sub of fs.readdirSync(optimeraDir).sort()) {
      const expPath = path.join(optimeraDir, sub, "experiments.yaml");
      if (fs.existsSync(expPath)) experimentPaths.push(expPath);
    }
    for (const expPath of experimentPaths) {
      let activeCount: number;
      let archiveCount: number;
      try {
        [activeCount, archiveCount] = yamlCounts(expPath, "experiments", "archive");
      } catch (exc) {
        statuses.push(yamlErrorStatus("EXPERIMENTS.md", expPath, (exc as Error).message));
        continue;
      }
      statuses.push({
        artifact: "EXPERIMENTS.md",
        path: expPath,
        classification: "protected",
        active_count: activeCount,
        archive_count: archiveCount,
        total_count: activeCount + archiveCount,
        over_limit_count: overLimitCount(activeCount, archiveCount),
        reason: "objective-state experiment files are classified but skipped by default",
        protected_overflow_count: 0,
        exists: true,
      });
    }
  }

  return statuses;
}

function operationForStatus(status: CompactionStatus, mode: string): CompactionOperation {
  const base = (action: string, message: string): CompactionOperation => ({
    status,
    mode,
    action,
    changed: false,
    result: null,
    message,
  });
  if (!status.exists) return base("missing", status.reason);
  if (status.classification === "error") return base("error", status.reason);
  if (status.classification !== "compactable") return base("skipped", status.reason);
  if (status.protected_overflow_count) {
    return base("protected_overflow", `protected-overflow review pressure by ${status.protected_overflow_count}`);
  }
  if (!status.over_limit_count) return base("ok", "within uniform_10_40_50 limits");
  return base(
    mode === "check" ? "over_limit" : "pending_fix",
    `over uniform_10_40_50 limit by ${status.over_limit_count}`,
  );
}

export function checkCompaction(projectRoot: string): CompactionOperation[] {
  return computeCompactionStatus(projectRoot).map((status) => operationForStatus(status, "check"));
}

export function fixCompaction(projectRoot: string): CompactionOperation[] {
  const operations: CompactionOperation[] = [];
  for (const status of computeCompactionStatus(projectRoot)) {
    const baseline = operationForStatus(status, "fix");
    if (baseline.action !== "pending_fix") {
      operations.push(baseline);
      continue;
    }
    const p = status.path;
    let result: CompactResult;
    try {
      if (status.artifact === "TODO.md#Resolved") {
        result = compactFile(p, "todo-resolved");
      } else if (status.artifact in YAML_SPEC_BY_ARTIFACT) {
        result = compactYamlFile(p, status.artifact);
      } else {
        operations.push({ status, mode: "fix", action: "skipped", changed: false, result: null, message: `no fixer registered for ${status.artifact}` });
        continue;
      }
    } catch (exc) {
      operations.push({ status, mode: "fix", action: "error", changed: false, result: null, message: (exc as Error).message });
      continue;
    }
    operations.push({
      status,
      mode: "fix",
      action: result.changed ? "compacted" : "ok",
      changed: result.changed,
      result,
      message:
        `full ${result.full_before}->${result.full_after}; ` +
        `archive ${result.oneline_before}->${result.oneline_after}; ` +
        `dropped ${result.dropped}`,
    });
  }
  return operations;
}

export function runCompaction(projectRoot: string, mode = "check"): CompactionOperation[] {
  if (mode === "check") return checkCompaction(projectRoot);
  if (mode === "fix") return fixCompaction(projectRoot);
  throw new Error(`unknown compaction mode: ${mode}`);
}

// --- markdown parse + compaction -------------------------------------------

function splitArchive(text: string, archiveHeading: string): [string, string] {
  if (!archiveHeading) return [text, ""];
  const pattern = new RegExp(`^${escapeRe(archiveHeading)}\\s*$`, "m");
  const match = pattern.exec(text);
  if (!match) return [text, ""];
  const pre = text.slice(0, match.index).replace(/\s+$/, "");
  const after = text.slice(match.index + match[0].length);
  const nextSection = /^##\s/m.exec(after);
  if (nextSection) {
    const archiveBody = after.slice(0, nextSection.index);
    const trailing = after.slice(nextSection.index);
    return [pre, archiveBody.trim() + (trailing ? "\n\n" + trailing : "")];
  }
  return [pre, after.trim()];
}

function parseFullEntries(text: string, spec: ArtifactSpec): Dict[] {
  const entries: Dict[] = [];
  const re = new RegExp(spec.entryHeadingRe.source, "gm");
  const matches = [...text.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const lineStart = text.lastIndexOf("\n", m.index! - 1) + 1;
    let lineEnd = text.indexOf("\n", m.index!);
    if (lineEnd === -1) lineEnd = text.length;
    const headerLine = text.slice(lineStart, lineEnd).trim();
    const glyphMatch = /^(■)\s*/.exec(headerLine);
    const glyph = glyphMatch ? glyphMatch[1] + " " : "";
    const remainder = glyphMatch ? headerLine.slice(glyphMatch[0].length) : headerLine;
    const header = glyph + remainder.replace(/^#+/, "").trim();
    const bodyStart = lineEnd + 1;
    let bodyEnd: number;
    if (i + 1 < matches.length) {
      bodyEnd = text.lastIndexOf("\n", matches[i + 1].index! - 1) + 1;
    } else {
      bodyEnd = text.length;
    }
    const body = text.slice(bodyStart, bodyEnd).trim();
    entries.push({ header, body, kind: "full" });
  }
  return entries;
}

function parseOnelineEntries(text: string, spec: ArtifactSpec): Dict[] {
  if (spec.onelineHeadingRe === null) return [];
  const entries: Dict[] = [];
  const re = new RegExp(spec.onelineHeadingRe.source);
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (re.test(line)) {
      entries.push({ header: line.replace(/\s+$/, ""), body: "", kind: "oneline" });
    }
  }
  return entries;
}

export function parseEntries(text: string, specName: string): Dict[] {
  const spec = SPECS[specName];
  if (spec.name === "todo-resolved") {
    return parseTodoResolved(text, spec);
  }
  const [pre, archiveBody] = splitArchive(text, spec.archiveHeading || "");
  const fullEntries = parseFullEntries(pre, spec);
  const onelineEntries = parseOnelineEntries(archiveBody, spec);
  return [...fullEntries, ...onelineEntries];
}

function extractResolvedSection(text: string): [number, number, string] {
  const m = /^##\s+(?:✓\s+)?Resolved\s*$/m.exec(text);
  if (!m) return [-1, -1, ""];
  const bodyStart = m.index + m[0].length + 1;
  const nextSection = /^##\s/m.exec(text.slice(bodyStart));
  const bodyEnd = nextSection ? bodyStart + nextSection.index : text.length;
  return [m.index, bodyEnd, text.slice(bodyStart, bodyEnd)];
}

function parseTodoResolved(text: string, spec: ArtifactSpec): Dict[] {
  const [, , body] = extractResolvedSection(text);
  if (!body) return [];
  const entries: Dict[] = [];
  const lines = body.split(/\r\n|\r|\n/);
  const headRe = new RegExp(spec.entryHeadingRe.source);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (headRe.test(line)) {
      const detailLines: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (nxt.startsWith(" ") || nxt.startsWith("\t")) {
          detailLines.push(nxt);
          j += 1;
        } else if (nxt.trim() === "") {
          if (j + 1 < lines.length && (lines[j + 1].startsWith(" ") || lines[j + 1].startsWith("\t"))) {
            detailLines.push(nxt);
            j += 1;
          } else {
            break;
          }
        } else {
          break;
        }
      }
      const bodyText = detailLines.join("\n").trim();
      entries.push({ header: line.replace(/\s+$/, ""), body: bodyText, kind: bodyText ? "full" : "oneline" });
      i = j;
    } else {
      i += 1;
    }
  }
  return entries;
}

function entryNumber(entry: Dict): number {
  const m = NUMBER_RE.exec(entry.header);
  return m ? parseInt(m[1], 10) : 0;
}

function detectDirection(entries: Dict[]): string {
  let asc = 0;
  let desc = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const a = entryNumber(entries[i]);
    const b = entryNumber(entries[i + 1]);
    if (a === 0 || b === 0 || a === b) continue;
    if (a < b) asc += 1;
    else desc += 1;
  }
  if (asc === 0 && desc === 0) return "descending";
  return asc > desc ? "ascending" : "descending";
}

export function compactEntries(
  entries: Dict[],
  maxFull = MAX_FULL_ENTRIES,
  maxOneline = MAX_ONELINE_ENTRIES,
  formatOneline: ((entry: Dict) => string) | null = null,
): Dict[] {
  const maxTotal = maxFull + maxOneline;
  if (entries.length === 0) return [];
  const ascending = detectDirection(entries) === "ascending";
  const newestFirst = stableSortBy(entries, entryNumber, true);

  const full: Dict[] = [];
  const archive: Dict[] = [];
  newestFirst.forEach((entry, i) => {
    if (i < maxFull) {
      full.push(entry);
    } else if (i < maxTotal) {
      if (entry.kind === "full" && formatOneline !== null) {
        archive.push({ header: formatOneline(entry), body: "", kind: "oneline" });
      } else {
        archive.push(entry);
      }
    }
  });

  const result = applyRetentionCaps(full, archive, { maxFull, maxOneline, maxTotal });
  if (ascending) result.reverse();
  return result;
}

function compactTodoEntries(entries: Dict[]): Dict[] {
  const result: Dict[] = [];
  let fullCount = 0;
  let onelineCount = 0;
  for (const entry of entries) {
    if (entry.kind === "full" && fullCount < MAX_FULL_ENTRIES) {
      result.push(entry);
      fullCount += 1;
      continue;
    }
    if (onelineCount < MAX_ONELINE_ENTRIES) {
      if (entry.kind === "full") {
        result.push({ header: formatTodoOneline(entry), body: "", kind: "oneline" });
      } else {
        result.push(entry);
      }
      onelineCount += 1;
    }
  }
  return result;
}

function formatProgressLike(headerPrefix: string, entries: Dict[], spec: ArtifactSpec): string {
  const lines: string[] = [];
  if (headerPrefix.trim()) {
    lines.push(headerPrefix.replace(/\s+$/, ""));
    lines.push("");
  }
  const fullEntries = entries.filter((e) => e.kind === "full");
  const onelineEntries = entries.filter((e) => e.kind === "oneline");
  for (const entry of fullEntries) {
    const header = entry.header;
    const glyphMatch = /^(■)\s+(.*)$/.exec(header);
    if (glyphMatch) {
      lines.push(`${glyphMatch[1]} ## ${glyphMatch[2]}`);
    } else {
      lines.push(`## ${header}`);
    }
    if (entry.body) {
      lines.push("");
      lines.push(entry.body);
    }
    lines.push("");
  }
  if (onelineEntries.length > 0 && spec.archiveHeading) {
    lines.push(spec.archiveHeading);
    lines.push("");
    for (const entry of onelineEntries) {
      lines.push(entry.header);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

function extractHeaderPrefix(text: string, spec: ArtifactSpec): string {
  const firstEntry = new RegExp(spec.entryHeadingRe.source, "m").exec(text);
  let firstArchiveIdx = -1;
  if (spec.archiveHeading) {
    const archiveMatch = new RegExp(`^${escapeRe(spec.archiveHeading)}\\s*$`, "m").exec(text);
    if (archiveMatch) firstArchiveIdx = archiveMatch.index;
  }
  const candidates = [firstEntry ? firstEntry.index : -1, firstArchiveIdx].filter((c) => c >= 0);
  if (candidates.length === 0) return text.replace(/\s+$/, "");
  return text.slice(0, Math.min(...candidates)).replace(/\s+$/, "");
}

function compactTodoResolved(p: string): CompactResult {
  const spec = SPECS["todo-resolved"];
  const text = fs.readFileSync(p, "utf8");
  const [start, end, body] = extractResolvedSection(text);
  if (start < 0) return { full_before: 0, oneline_before: 0, full_after: 0, oneline_after: 0, dropped: 0, changed: false };

  const entries = parseTodoResolved(text, spec);
  const fullBefore = entries.filter((e) => e.kind === "full").length;
  const onelineBefore = entries.filter((e) => e.kind === "oneline").length;
  const totalBefore = entries.length;

  if (totalBefore <= MAX_TOTAL_ENTRIES && fullBefore <= MAX_FULL_ENTRIES && onelineBefore <= MAX_ONELINE_ENTRIES) {
    return { full_before: fullBefore, oneline_before: onelineBefore, full_after: fullBefore, oneline_after: onelineBefore, dropped: 0, changed: false };
  }

  const compacted = compactTodoEntries(entries);
  const fullAfter = compacted.filter((e) => e.kind === "full").length;
  const onelineAfter = compacted.filter((e) => e.kind === "oneline").length;
  const dropped = totalBefore - compacted.length;

  const newLines: string[] = [];
  for (const entry of compacted) {
    if (entry.kind === "full") {
      newLines.push(entry.header);
      if (entry.body) newLines.push(entry.body);
    } else {
      newLines.push(spec.formatOneline(entry));
    }
  }
  const newBody = newLines.join("\n") + "\n";
  const headingEnd = text.indexOf("\n", start) + 1;
  const newText = text.slice(0, headingEnd) + "\n" + newBody + text.slice(end);
  fs.writeFileSync(p, newText);
  return { full_before: fullBefore, oneline_before: onelineBefore, full_after: fullAfter, oneline_after: onelineAfter, dropped, changed: true };
}

export function compactFile(p: string, specName: string): CompactResult {
  if (!(specName in SPECS)) throw new Error(`unknown spec: ${specName}`);
  if (!fs.existsSync(p)) throw new Error(p);
  const spec = SPECS[specName];
  if (spec.name === "todo-resolved") {
    return compactTodoResolved(p);
  }
  const text = fs.readFileSync(p, "utf8");
  const entries = parseEntries(text, specName);
  const fullBefore = entries.filter((e) => e.kind === "full").length;
  const onelineBefore = entries.filter((e) => e.kind === "oneline").length;
  const totalBefore = fullBefore + onelineBefore;
  const needsCompact =
    fullBefore > MAX_FULL_ENTRIES || onelineBefore > MAX_ONELINE_ENTRIES || totalBefore > MAX_FULL_ENTRIES + MAX_ONELINE_ENTRIES;
  if (!needsCompact) {
    return { full_before: fullBefore, oneline_before: onelineBefore, full_after: fullBefore, oneline_after: onelineBefore, dropped: 0, changed: false };
  }
  const compacted = compactEntries(entries, MAX_FULL_ENTRIES, MAX_ONELINE_ENTRIES, spec.formatOneline);
  const fullAfter = compacted.filter((e) => e.kind === "full").length;
  const onelineAfter = compacted.filter((e) => e.kind === "oneline").length;
  const dropped = totalBefore - compacted.length;
  const headerPrefix = extractHeaderPrefix(text, spec);
  const newText = formatProgressLike(headerPrefix, compacted, spec);
  fs.writeFileSync(p, newText);
  return { full_before: fullBefore, oneline_before: onelineBefore, full_after: fullAfter, oneline_after: onelineAfter, dropped, changed: true };
}

export function detectOverflow(text: string, specName: string): [number, number] {
  const entries = parseEntries(text, specName);
  const fullCount = entries.filter((e) => e.kind === "full").length;
  const onelineCount = entries.filter((e) => e.kind === "oneline").length;
  return [fullCount, onelineCount];
}
