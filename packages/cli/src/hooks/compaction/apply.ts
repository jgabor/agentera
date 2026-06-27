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

import YAML from "yaml";

import { loadYamlMapping } from "../../core/yaml.js";
import { MAX_FULL_ENTRIES, MAX_ONELINE_ENTRIES, MAX_TOTAL_ENTRIES, applyRetentionCaps } from "../common.js";
import { COMPACTABLE_YAML_ARTIFACTS, SPECS, YAML_SPEC_BY_ARTIFACT, formatTodoOneline } from "./dryRun.js";
import { CompactResult } from "./types.js";
import {
  applyRetentionCaps as _applyRetentionCaps,
  overLimitCount,
  selectDecisionActiveEntries,
  selectDecisionArchiveEntries,
  stableSortBy,
  yamlArchiveEntries,
  yamlArchiveEntry,
  yamlEntryNumber,
  yamlRecentFullAndOlder,
  yamlSortEntries,
} from "./retention.js";
import { normalizeTodoResolvedLayout, parseEntries, parseTodoResolved, extractResolvedSection } from "./parse.js";

import type { JsonObject } from "../../core/jsonValue.js";

export function compactYamlFile(p: string, artifact: string): CompactResult {
  if (!(artifact in COMPACTABLE_YAML_ARTIFACTS)) {
    throw new Error(`unsupported YAML artifact: ${artifact}`);
  }
  if (!fs.existsSync(p)) {
    throw new Error(p);
  }
  const [activeKey, archiveKey] = COMPACTABLE_YAML_ARTIFACTS[artifact];
  const specName = YAML_SPEC_BY_ARTIFACT[artifact];
  const data = loadYamlMapping(fs.readFileSync(p, "utf8")) as JsonObject;

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
    const merged = applyRetentionCaps(recentFull as JsonObject[], archiveCandidates as JsonObject[]);
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
  const result: JsonObject[] = [];
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
  const normalized = normalizeTodoResolvedLayout(text);
  if (normalized.changed) {
    fs.writeFileSync(p, normalized.text);
    text = normalized.text;
  }
  const [start, end] = extractResolvedSection(text);
  if (start < 0) return { full_before: 0, oneline_before: 0, full_after: 0, oneline_after: 0, dropped: 0, changed: normalized.changed };

  const entries = parseTodoResolved(text, spec);
  const fullBefore = entries.filter((e) => e.kind === "full").length;
  const onelineBefore = entries.filter((e) => e.kind === "oneline").length;
  const totalBefore = entries.length;

  if (totalBefore <= MAX_TOTAL_ENTRIES && fullBefore <= MAX_FULL_ENTRIES && onelineBefore <= MAX_ONELINE_ENTRIES) {
    return {
      full_before: fullBefore,
      oneline_before: onelineBefore,
      full_after: fullBefore,
      oneline_after: onelineBefore,
      dropped: 0,
      changed: normalized.changed,
    };
  }

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
    changed: normalized.changed || true,
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

// Silence the re-export-only `_applyRetentionCaps` alias used by status.ts.
void _applyRetentionCaps;
void yamlSortEntries;
