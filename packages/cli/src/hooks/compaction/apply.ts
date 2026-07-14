/**
 * Compaction writers (the "apply" surface).
 *
 * Reads the artifact, calls the retention/selection helpers, then
 * writes the compacted result back to disk. `compactYamlFile` is for
 * the three YAML artifacts (progress, decisions, health);
 * `compactFile` handles both YAML and markdown (TODO resolved).
 *
 * Note: `entry.header`/`entry.body` reads are typed `as string` because the
 * entries originate from parsed markdown artifact text (an IO boundary); at
 * runtime these fields are always strings.
 */

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { loadYamlMapping } from "../../core/yaml.js";
import { MAX_FULL_ENTRIES, MAX_ONELINE_ENTRIES, MAX_TOTAL_ENTRIES, applyRetentionCaps } from "../common.js";
import { COMPACTABLE_YAML_ARTIFACTS, SPECS, YAML_SPEC_BY_ARTIFACT, formatTodoOneline } from "./dryRun.js";
import { CompactResult } from "./types.js";
import {
  decisionRequiresUserReview,
  selectDecisionActiveEntries,
  selectDecisionArchiveEntries,
  stableSortBy,
  yamlArchiveEntry,
  yamlEntryNumber,
  yamlRecentFullAndOlder,
  yamlSortEntries,
} from "./retention.js";
import { normalizeTodoResolvedLayout, parseEntries, parseTodoResolved, extractResolvedSection, countTodoResolvedSectionHeadings, countTodoPendingSummarization, TODO_DROPPED_RECOVERY_GUIDANCE } from "./parse.js";

import type { JsonObject } from "../../core/jsonValue.js";
import { hydrateDecisionRecords } from "../../state/decisionOverlay.js";
import { gateProjectionEntries } from "../../state/archiveRecovery.js";
import {
  loadProjectionPolicy,
  projectionOmission,
} from "../../state/projectionPolicy.js";
import type { ProjectionOmissionProvenance } from "../../state/projectionPolicy.js";

export interface CompactYamlBytesResult {
  bytes: string;
  result: CompactResult;
}

function restoreRawSatisfaction(selected: any[], rawEntries: any[]): any[] {
  return selected.map((entry) => {
    const raw = rawEntries.find((candidate) => yamlEntryNumber(candidate) === yamlEntryNumber(entry));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return entry;
    const restored = { ...entry };
    if ("satisfaction" in raw) restored.satisfaction = raw.satisfaction;
    else delete restored.satisfaction;
    return restored;
  });
}

function existingOmissionCount(data: JsonObject): number {
  const count = data.omitted_count;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function archiveProjectionCandidates(
  specName: string,
  rawArchive: any[],
  generatedArchive: any[],
  summaryCapacity: number,
): { archive: any[]; omitted: number; provenance: ProjectionOmissionProvenance[] } {
  // Inline summaries have no independently verified complete record. They
  // participate in the same bounded projection as verified summaries, but
  // their omission explicitly remains degraded legacy history.
  const candidates = [
    ...rawArchive.map((entry) => ({ entry, source: "legacy_summary" as const, index: 0 })),
    ...generatedArchive.map((entry) => ({ entry, source: "archive" as const, index: 1 })),
  ];
  const ordered = candidates.sort((left, right) => {
    const leftTimestamp = String(left.entry?.timestamp ?? left.entry?.date ?? "");
    const rightTimestamp = String(right.entry?.timestamp ?? right.entry?.date ?? "");
    if (leftTimestamp !== rightTimestamp) return leftTimestamp < rightTimestamp ? 1 : -1;
    const leftNumber = yamlEntryNumber(left.entry);
    const rightNumber = yamlEntryNumber(right.entry);
    if (leftNumber !== rightNumber) return rightNumber - leftNumber;
    return left.index - right.index;
  });
  const reviewFirst =
    specName === "decisions"
      ? [
          ...ordered.filter((candidate) => decisionRequiresUserReview(candidate.entry)),
          ...ordered.filter((candidate) => !decisionRequiresUserReview(candidate.entry)),
        ]
      : ordered;
  const retained = reviewFirst.slice(0, summaryCapacity);
  const omitted = reviewFirst.slice(summaryCapacity);
  const provenance: ProjectionOmissionProvenance[] = [];
  for (const source of ["legacy_summary", "archive"] as const) {
    const omittedCount = omitted.filter((candidate) => candidate.source === source).length;
    if (omittedCount === 0) continue;
    provenance.push({
      source,
      detail_availability: source === "legacy_summary" ? "unavailable" : "full",
      compatibility: source === "legacy_summary" ? "degraded" : "complete",
      archive_verified: source === "archive",
      omitted_count: omittedCount,
    });
  }
  return {
    archive: yamlSortEntries(retained.map((candidate) => candidate.entry), specName),
    omitted: omitted.length,
    provenance,
  };
}

function existingOmissionProvenance(data: JsonObject): ProjectionOmissionProvenance[] {
  const raw = data.omission_provenance;
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return values.filter(
    (entry): entry is ProjectionOmissionProvenance =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

export function compactYamlBytes(
  bytes: string,
  artifact: string,
  projectRoot?: string,
): CompactYamlBytesResult {
  if (!(artifact in COMPACTABLE_YAML_ARTIFACTS)) {
    throw new Error(`unsupported YAML artifact: ${artifact}`);
  }
  const [activeKey, archiveKey] = COMPACTABLE_YAML_ARTIFACTS[artifact];
  const specName = YAML_SPEC_BY_ARTIFACT[artifact];
  const data = loadYamlMapping(bytes) as JsonObject;

  let active = data[activeKey] || [];
  let archive = data[archiveKey] || [];
  if (!Array.isArray(active)) active = [];
  if (!Array.isArray(archive)) archive = [];
  const rawActive = active;
  const rawArchive = archive;
  const policy = loadProjectionPolicy();
  const selectionActive =
    specName === "decisions" && projectRoot
      ? hydrateDecisionRecords(rawActive as JsonObject[], projectRoot)
      : rawActive;

  const fullBefore = rawActive.length;
  const onelineBefore = rawArchive.length;
  if (fullBefore <= policy.activeEntries && onelineBefore <= policy.summaryEntries && fullBefore + onelineBefore <= policy.totalEntries) {
    return {
      bytes,
      result: {
        full_before: fullBefore,
        oneline_before: onelineBefore,
        full_after: fullBefore,
        oneline_after: onelineBefore,
        dropped: 0,
        omitted_count: 0,
        changed: false,
      },
    };
  }

  let recentFull: any[];
  let olderActive: any[];
  if (specName === "decisions") {
    const [selectedRecent, selectedOlder] = selectDecisionActiveEntries(selectionActive, policy.activeEntries);
    recentFull = restoreRawSatisfaction(selectedRecent, rawActive);
    olderActive = restoreRawSatisfaction(selectedOlder, rawActive);
  } else {
    [recentFull, olderActive] = yamlRecentFullAndOlder(rawActive, specName, policy.activeEntries);
  }
  const projectionRoot = projectRoot ?? process.cwd();
  const gated = gateProjectionEntries(projectionRoot, specName, olderActive as JsonObject[]);
  const compactedFromActive = gated.verified.map((entry) => yamlArchiveEntry(specName, entry));
  const retainedFull = gated.refused.map(({ entry }) => entry);
  recentFull = yamlSortEntries([...recentFull, ...retainedFull], specName);
  const archiveProjection = archiveProjectionCandidates(
    specName,
    rawArchive,
    compactedFromActive,
    policy.summaryEntries,
  );
  let archiveAfter: any[] = archiveProjection.archive;
  if (specName === "decisions") {
    const selectionArchiveCandidates = projectRoot
      ? hydrateDecisionRecords(archiveAfter as JsonObject[], projectRoot)
      : archiveAfter;
    archiveAfter = restoreRawSatisfaction(
      selectDecisionArchiveEntries(selectionArchiveCandidates),
      archiveAfter,
    );
  }

  const omittedCount = existingOmissionCount(data) + archiveProjection.omitted;
  if (omittedCount > 0) {
    Object.assign(
      data,
      projectionOmission(specName, omittedCount, "projection_capacity", {
        forceOmitted: true,
        provenance: [...existingOmissionProvenance(data), ...archiveProjection.provenance],
      }),
    );
  }

  data[activeKey] = recentFull;
  if (archiveAfter.length > 0 || archiveKey in data || compactedFromActive.length > 0) {
    data[archiveKey] = archiveAfter;
  } else {
    delete data[archiveKey];
  }
  const compactedBytes = YAML.stringify(data);

  const fullAfter = recentFull.length;
  const onelineAfter = archiveAfter.length;
  // A projection may omit detail only after its complete numbered archive is
  // verified. Omission is reported separately; logical entries are never
  // counted as dropped.
  const dropped = 0;
  return {
    bytes: compactedBytes,
    result: {
      full_before: fullBefore,
      oneline_before: onelineBefore,
      full_after: fullAfter,
      oneline_after: onelineAfter,
      dropped,
      omitted_count: omittedCount,
      ...(omittedCount > 0 ? { omission_reason: "projection_capacity" } : {}),
      changed: true,
      recovery: gated.recovery,
    },
  };
}

export function compactYamlFile(p: string, artifact: string, projectRoot?: string): CompactResult {
  if (!fs.existsSync(p)) throw new Error(p);
  const inferredProjectRoot =
    path.basename(path.dirname(p)) === ".agentera" ? path.dirname(path.dirname(p)) : path.dirname(p);
  const compacted = compactYamlBytes(fs.readFileSync(p, "utf8"), artifact, projectRoot ?? inferredProjectRoot);
  if (compacted.result.changed) fs.writeFileSync(p, compacted.bytes);
  return compacted.result;
}

function detectDirection(entries: JsonObject[]): string {
  let asc = 0;
  let desc = 0;
  for (let i = 0; i < entries.length - 1; i++) {
    const a = yamlEntryNumber(entries[i]);
    const b = yamlEntryNumber(entries[i + 1]);
    if (a === 0 || b === 0 || a === b) continue;
    if (a < b) asc += 1;
    else desc += 1;
  }
  if (asc === 0 && desc === 0) return "descending";
  return asc > desc ? "ascending" : "descending";
}

export function compactEntries(
  entries: JsonObject[],
  maxFull = MAX_FULL_ENTRIES,
  maxOneline = MAX_ONELINE_ENTRIES,
  formatOneline: ((entry: JsonObject) => string) | null = null,
): JsonObject[] {
  const maxTotal = maxFull + maxOneline;
  if (entries.length === 0) return [];
  const ascending = detectDirection(entries) === "ascending";
  const newestFirst = stableSortBy(entries, yamlEntryNumber, true);

  const full: JsonObject[] = [];
  const archive: JsonObject[] = [];
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

function compactTodoEntries(entries: JsonObject[]): JsonObject[] {
  // Positional tiering per TC9: the first ten resolved rows are the
  // recent/full-detail tier even when they have no indented body; rows
  // 11-50 are the summary tier; rows beyond 50 are dropped. Using
  // position (not body presence) ensures: (1) a TODO with 55 bodyless
  // one-liners retains 50 (10 promoted to full + 40 summary), not 40;
  // (2) a second compaction is idempotent because a compacted file
  // with 0 body + 50 headers still reports total=50 (not oneline=50>40).
  const result: JsonObject[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (i < MAX_FULL_ENTRIES) {
      // First 10: full-detail tier — preserve body if present, promote
      // kind to "full" so the writer keeps the header (not formatOneline).
      result.push(entries[i].kind === "oneline"
        ? { ...entries[i], kind: "full" }
        : entries[i]);
    } else if (i < MAX_TOTAL_ENTRIES) {
      // Items 11-50: summary tier — force ≤15-word summary formatting
      // by passing kind="full" to formatTodoOneline so it goes through
      // the truncation path (strip metadata + truncateWords). This must
      // NOT use kind="oneline" (passthrough), which preserves long
      // verbatim headers unchanged.
      const summary = formatTodoOneline({ ...entries[i], kind: "full" });
      result.push({ header: summary, body: "", kind: "oneline" });
    }
    // Items 51+: dropped entirely.
  }
  return result;
}

function formatProgressLike(headerPrefix: string, entries: JsonObject[], spec: any): string {
  // `entry.header`/`entry.body` below come from parsed markdown artifact text; the
  // `as string` casts sit at that markdown-parse IO boundary (runtime values are strings).
  const lines: string[] = [];
  if (headerPrefix.trim()) {
    lines.push(headerPrefix.replace(/\s+$/, ""));
    lines.push("");
  }
  const fullEntries = entries.filter((e) => e.kind === "full");
  const onelineEntries = entries.filter((e) => e.kind === "oneline");
  for (const entry of fullEntries) {
    const header = entry.header as string;
    const glyphMatch = /^(■)\s+(.*)$/.exec(header);
    if (glyphMatch) {
      lines.push(`${glyphMatch[1]} ## ${glyphMatch[2]}`);
    } else {
      lines.push(`## ${header}`);
    }
    if (entry.body as string) {
      lines.push("");
      lines.push(entry.body as string);
    }
    lines.push("");
  }
  if (onelineEntries.length > 0 && spec.archiveHeading) {
    lines.push(spec.archiveHeading);
    lines.push("");
    for (const entry of onelineEntries) {
      lines.push(entry.header as string);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

function extractHeaderPrefix(text: string, spec: any): string {
  const firstEntry = new RegExp(spec.entryHeadingRe.source, "m").exec(text);
  let firstArchiveIdx = -1;
  if (spec.archiveHeading) {
    const archiveMatch = new RegExp(`^${spec.archiveHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").exec(text);
    if (archiveMatch) firstArchiveIdx = archiveMatch.index;
  }
  const candidates = [firstEntry ? firstEntry.index : -1, firstArchiveIdx].filter((c) => c >= 0);
  if (candidates.length === 0) return text.replace(/\s+$/, "");
  return text.slice(0, Math.min(...candidates)).replace(/\s+$/, "");
}

function compactTodoResolved(p: string): CompactResult {
  const spec = SPECS["todo-resolved"];
  let text = fs.readFileSync(p, "utf8");
  // Enforce exactly one `## ✓ Resolved` heading. Multiple headings hide
  // trailing entries from parsing; zero headings leave placement ambiguous.
  // The check-mode status path emits the error before reaching here; this
  // guard protects direct callers (e.g. validate-artifact auto-compact).
  const headingCount = countTodoResolvedSectionHeadings(text);
  if (headingCount > 1) {
    throw new Error(
      `TODO.md has ${headingCount} '## ✓ Resolved' sections; merge into exactly one before compacting. ` +
        `Compaction drops oldest resolved entries and is destructive (no lossless archive); ` +
        TODO_DROPPED_RECOVERY_GUIDANCE,
    );
  }
  if (headingCount === 0) {
    throw new Error("TODO.md has no required '## ✓ Resolved' section; add exactly one before compacting.");
  }
  // headingCount === 1: normalize (migrate misplaced items into existing heading)
  const normalized = normalizeTodoResolvedLayout(text);
  if (normalized.changed) {
    fs.writeFileSync(p, normalized.text);
    text = normalized.text;
  }
  const [start, end, currentBody] = extractResolvedSection(text);
  if (start < 0) return { full_before: 0, oneline_before: 0, full_after: 0, oneline_after: 0, dropped: 0, changed: normalized.changed };

  const entries = parseTodoResolved(text, spec);
  const totalBefore = entries.length;
  // Positional tiering per TC9 (consistent with countTodoResolvedEntries and
  // compactTodoEntries): first min(N,10) = full tier, rest = oneline tier.
  const fullBefore = Math.min(totalBefore, MAX_FULL_ENTRIES);
  const onelineBefore = Math.max(0, totalBefore - MAX_FULL_ENTRIES);

  // Skip the rewrite when within budget AND no rows 11-50 need reformatting.
  // This preserves idempotency: a fully-compacted file (10 verbatim + 40
  // summaries) reports pendingSummarization=0 and returns changed=false.
  const pendingSummarization = countTodoPendingSummarization(text);
  if (totalBefore <= MAX_TOTAL_ENTRIES && pendingSummarization === 0) {
    return {
      full_before: fullBefore,
      oneline_before: onelineBefore,
      full_after: fullBefore,
      oneline_after: onelineBefore,
      dropped: 0,
      changed: normalized.changed,
    };
  }

  // Either total > 50 (entries to drop) or pendingSummarization > 0 (rows
  // 11-50 need ≤15-word summary formatting). Run compactTodoEntries and
  // rewrite the Resolved section body.
  const compacted = compactTodoEntries(entries);
  const fullAfter = compacted.filter((e) => e.kind === "full").length;
  const onelineAfter = compacted.filter((e) => e.kind === "oneline").length;
  const dropped = totalBefore - compacted.length;

  const newLines: string[] = [];
  for (const entry of compacted) {
    if (entry.kind === "full") {
      newLines.push(entry.header as string);
      if (entry.body as string) newLines.push(entry.body as string);
    } else {
      newLines.push(spec.formatOneline(entry));
    }
  }
  const newBody = newLines.join("\n") + "\n";
  const headingEnd = text.indexOf("\n", start) + 1;
  const newText = text.slice(0, headingEnd) + "\n" + newBody + text.slice(end);
  fs.writeFileSync(p, newText);
  return {
    full_before: fullBefore,
    oneline_before: onelineBefore,
    full_after: fullAfter,
    oneline_after: onelineAfter,
    dropped,
    // TODO has no lossless numbered archive: dropped resolved entries are
    // recoverable only via project history (Git), and only if previously
    // committed. Surface this honestly in the JSON result rather than
    // implying a lossless projection.
    ...(dropped > 0 ? { omission_reason: TODO_DROPPED_RECOVERY_GUIDANCE } : {}),
    changed: true,
  };
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

void yamlSortEntries;
