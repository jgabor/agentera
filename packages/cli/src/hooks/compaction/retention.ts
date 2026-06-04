/**
 * Retention primitives for compaction: stable sort, recent-vs-older
 * partitioning, archive sorting, and decision-specific entry
 * selection (satisfaction-aware). The pure helpers here are reused
 * by `apply.ts` (which writes the compacted result back to disk)
 * and by `status.ts` (which counts overflow without writing).
 */

import { MAX_FULL_ENTRIES, MAX_ONELINE_ENTRIES, applyRetentionCaps } from "../common.js";
import { truncateWords } from "./dryRun.js";

type Dict = Record<string, any>;

export function overLimitCount(activeCount: number, archiveCount: number): number {
  const totalCount = activeCount + archiveCount;
  return Math.max(
    Math.max(activeCount - MAX_FULL_ENTRIES, 0),
    Math.max(archiveCount - MAX_ONELINE_ENTRIES, 0),
    Math.max(totalCount - 50, 0),
  );
}

export function stableSortBy<T>(arr: T[], key: (x: T) => number | string, reverse = false): T[] {
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

export function yamlEntryNumber(entry: unknown): number {
  let summary: string;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const number = (entry as Dict).number;
    if (typeof number === "number" && Number.isInteger(number)) return number;
    if (typeof number === "string" && /^\d+$/.test(number)) return parseInt(number, 10);
    summary = String((entry as Dict).summary ?? "");
  } else {
    summary = String(entry);
  }
  const match = /(?:Cycle|Decision|Audit|Experiment|EXP-)\s*(\d+)/.exec(summary);
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

export function yamlArchiveEntry(specName: string, entry: unknown): Dict {
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

export function yamlSortEntries(entries: any[], specName: string): any[] {
  if (specName === "decisions" || specName === "health") {
    return stableSortBy(entries, yamlEntryNumber);
  }
  if (specName === "session") {
    return stableSortBy(entries, yamlEntryTimestamp, true);
  }
  return stableSortBy(entries, yamlEntryNumber, true);
}

export function yamlRecentFullAndOlder(entries: any[], specName: string): [any[], any[]] {
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

export function yamlArchiveEntries(entries: any[]): any[] {
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

export function decisionProtectedOverflowCount(active: any[], archive: any[]): number {
  const protectedActive = active.filter((e) => decisionRequiresUserReview(e)).length;
  const protectedArchive = archive.filter((e) => decisionRequiresUserReview(e)).length;
  return Math.max(
    protectedActive - MAX_FULL_ENTRIES,
    protectedArchive - MAX_ONELINE_ENTRIES,
    protectedActive + protectedArchive - 50,
    0,
  );
}

export function selectDecisionActiveEntries(active: any[]): [any[], any[]] {
  const protectedEntries = active.filter((e) => decisionRequiresUserReview(e));
  if (protectedEntries.length > MAX_FULL_ENTRIES) {
    throw new Error(
      "decisions: protected-overflow review pressure; " +
        `${protectedEntries.length} protected active decision(s) exceed ${MAX_FULL_ENTRIES} full-detail slots`,
    );
  }
  const satisfied = active.filter((e) => !decisionRequiresUserReview(e));
  const newestSatisfied = stableSortBy(satisfied, yamlEntryNumber, true);
  const keepSatisfied = newestSatisfied.slice(0, MAX_FULL_ENTRIES - protectedEntries.length);
  const compactSatisfied = newestSatisfied.slice(MAX_FULL_ENTRIES - protectedEntries.length);
  return [yamlSortEntries([...protectedEntries, ...keepSatisfied], "decisions"), compactSatisfied];
}

export function selectDecisionArchiveEntries(archiveCandidates: any[]): any[] {
  const protectedEntries = archiveCandidates.filter((e) => decisionRequiresUserReview(e));
  if (protectedEntries.length > MAX_ONELINE_ENTRIES) {
    throw new Error(
      "decisions: protected-overflow review pressure; " +
        `${protectedEntries.length} protected archived decision(s) exceed ${MAX_ONELINE_ENTRIES} archive slots`,
    );
  }
  const satisfied = archiveCandidates.filter((e) => !decisionRequiresUserReview(e));
  const keepSatisfied = yamlArchiveEntries(satisfied).slice(0, MAX_ONELINE_ENTRIES - protectedEntries.length);
  return yamlArchiveEntries([...protectedEntries, ...keepSatisfied]);
}

export { applyRetentionCaps };
