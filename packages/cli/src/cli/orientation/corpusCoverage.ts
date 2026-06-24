import fs from "node:fs";

import { corpusTooLargeReason } from "../../analytics/usageStats.js";
import { statsCorpusPath } from "../commands/report.js";

type Env = Record<string, string | undefined>;

export interface CorpusCoverageGap {
  runtime: string;
  reason: string;
  store_path?: string;
}

export interface CorpusCoverageSummary {
  path: string;
  status: "missing" | "unreadable" | "too_large" | "loaded";
  available_runtimes: string[];
  selected_runtimes: string[];
  available_but_not_selected: CorpusCoverageGap[];
}

function emptyCoverageSummary(path: string, status: CorpusCoverageSummary["status"]): CorpusCoverageSummary {
  return {
    path,
    status,
    available_runtimes: [],
    selected_runtimes: [],
    available_but_not_selected: [],
  };
}

function parseCoverageGap(value: unknown): CorpusCoverageGap | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const runtime = item.runtime;
  const reason = item.reason;
  if (typeof runtime !== "string" || typeof reason !== "string") return null;
  const gap: CorpusCoverageGap = { runtime, reason };
  if (typeof item.store_path === "string") gap.store_path = item.store_path;
  return gap;
}

export function corpusCoverageSummary(env: Env = process.env, platform: NodeJS.Platform = process.platform): CorpusCoverageSummary {
  const corpusPath = statsCorpusPath(env, platform);
  if (!fs.existsSync(corpusPath)) return emptyCoverageSummary(corpusPath, "missing");
  const tooLarge = corpusTooLargeReason(corpusPath);
  if (tooLarge) return emptyCoverageSummary(corpusPath, "too_large");
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  } catch {
    return emptyCoverageSummary(corpusPath, "unreadable");
  }
  const metadata =
    data && typeof data === "object" && !Array.isArray(data) && "metadata" in data
      ? (data as { metadata?: unknown }).metadata
      : null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return emptyCoverageSummary(corpusPath, "unreadable");
  }
  const md = metadata as Record<string, unknown>;
  const availableRuntimes = Array.isArray(md.available_runtimes)
    ? md.available_runtimes.filter((item): item is string => typeof item === "string")
    : [];
  const selectedRuntimes = Array.isArray(md.selected_runtimes)
    ? md.selected_runtimes.filter((item): item is string => typeof item === "string")
    : [];
  const skipped = Array.isArray(md.available_but_not_selected)
    ? md.available_but_not_selected.map(parseCoverageGap).filter((item): item is CorpusCoverageGap => item !== null)
    : [];
  return {
    path: corpusPath,
    status: "loaded",
    available_runtimes: availableRuntimes,
    selected_runtimes: selectedRuntimes,
    available_but_not_selected: skipped,
  };
}

export function corpusCoverageAttention(summary: CorpusCoverageSummary): string | null {
  if (summary.available_but_not_selected.length === 0) return null;
  const skipped = summary.available_but_not_selected.map((item) => `${item.runtime} (${item.reason})`).join(", ");
  return (
    `flagged: corpus coverage loss (EX2): available runtimes skipped (${skipped}); ` +
    "suggest running profile stats refresh without --no-* flags"
  );
}
