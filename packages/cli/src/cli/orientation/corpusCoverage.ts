import fs from "node:fs";

import { corpusTooLargeReason } from "../../analytics/usageStats.js";
import { statsCorpusPath } from "../commands/report.js";
import {
  tiersDirForCorpusPath,
  assessTiers,
  readBoundedMetadata,
} from "../../analytics/extractCorpus/index.js";

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
  /** Tiers directory when coverage was read from bounded tiers (documented). */
  tier_path?: string;
  /** Compatibility state of the evidence tier (documented tier status). */
  tier_state?: string;
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
  const tiersDir = tiersDirForCorpusPath(corpusPath);
  const assessment = assessTiers(tiersDir, corpusPath);

  // Bounded tier coverage: when tiers are published, the manifest's coverage
  // envelope truthfully reports the audit's available/selected/skipped runtimes
  // without reading full evidence. The signal tier (bounded) remains usable even
  // when a full-evidence shard is oversized, per the authority contract.
  if (assessment.state !== "legacy" && assessment.state !== "missing") {
    const meta = readBoundedMetadata(tiersDir);
    const envelope = meta.corpusMetadata?.coverage_envelope;
    if (meta.signal && envelope) {
      return {
        path: corpusPath,
        tier_path: tiersDir,
        status: "loaded",
        tier_state: assessment.state,
        available_runtimes: [...envelope.available_runtimes],
        selected_runtimes: [...envelope.selected_runtimes],
        available_but_not_selected: envelope.available_but_not_selected.map((g) => ({
          runtime: g.runtime,
          reason: g.reason,
          ...(typeof g.store_path === "string" ? { store_path: g.store_path } : {}),
        })),
      };
    }
    if (assessment.state === "oversized") return emptyCoverageSummary(corpusPath, "too_large");
    if (assessment.state === "corrupt") return emptyCoverageSummary(corpusPath, "unreadable");
  }

  // Legacy monolithic envelope: small state preserved for compatibility.
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
    tier_state: "legacy",
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
