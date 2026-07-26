import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../../core/jsonValue.js";
import {
  compatibilityStates,
  evidenceTierBounds,
  type CompatibilityStateId,
} from "../../registries/evidenceTierContract.js";
import { type Env } from "./core.js";
import {
  defaultTiersDir,
  evidenceTierCompatibility,
  iterTierRecords,
  readSignalTier,
  readTierCorpusMetadata,
  type EvidenceTierCompatibilityState,
  type EvidenceTierManifest,
  type SignalRecord,
  type TierCorpusMetadata,
} from "./evidenceTiers.js";

/**
 * Bounded tier reader for analytics consumers (plan Task 3).
 *
 * Task 2 publishes bounded full-evidence shards and a bounded signal tier with
 * an atomic generation pointer. This module is the consumer-side surface that
 * projects the contract's compatibility states and recovery guidance, resolves
 * the tiers directory from a corpus path, and exposes bounded reads (full-evidence
 * records one shard at a time; metadata/signal reads without full records). It does
 * not duplicate the tier map, source families, bounds, or compatibility outcomes —
 * those are projected from `evidenceTierContract` and `evidenceTiers`.
 *
 * Consumers preserve their JSON output shape and exit codes. A non-current tier
 * degrades with actionable, contract-projected recovery rather than indefinitely
 * loading an oversized monolithic corpus envelope. `incomplete` is a degrade
 * outcome: consumers analyze available sources and surface the coverage gap, so a
 * host missing some runtimes still gets useful analysis instead of a hard failure.
 */

/** A corpus path's co-located tiers directory (`<intermediate>/tiers`). */
export function tiersDirForCorpusPath(corpusPath: string): string {
  return path.join(path.dirname(corpusPath), "tiers");
}

/** Canonical tiers directory for the stats profile. */
export function resolveTiersDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  return defaultTiersDir(env, platform);
}

/** Whether a compatibility state still permits analysis of available sources. */
export function isAnalyzable(state: EvidenceTierCompatibilityState["state"]): boolean {
  return state === "current" || state === "incomplete";
}

/**
 * Actionable recovery guidance projected from the authority contract for a
 * compatibility state. The contract owns the recovery text; this never
 * duplicates it. Returns `null` for states that proceed (current/incomplete).
 */
export function recoveryForState(state: EvidenceTierCompatibilityState["state"]): string | null {
  if (state === "current" || state === "incomplete") return null;
  const states = compatibilityStates();
  const def = states.find((s) => s.state_id === (state as CompatibilityStateId));
  return def?.recovery ?? null;
}

export interface TierAssessment {
  state: EvidenceTierCompatibilityState["state"];
  /** True for current/incomplete — consumers analyze available sources. */
  analyzable: boolean;
  /** Coverage gaps (runtime: reason) for the incomplete state. */
  coverageGaps?: string[];
  /** Artifact path that triggered oversized/corrupt. */
  artifact?: string;
  /** Contract-projected recovery guidance for degrade states. */
  recovery?: string;
  tiersDir: string;
  corpusPath?: string;
  generation?: string;
}

/**
 * Assess the tiers directory against the contract's compatibility states. When a
 * legacy corpus envelope is supplied, a missing tier with an existing envelope
 * surfaces as `legacy` (refresh guidance) rather than a bare missing state.
 */
export function assessTiers(tiersDir: string, corpusPath?: string): TierAssessment {
  const compat = evidenceTierCompatibility(tiersDir, corpusPath);
  const assessment: TierAssessment = {
    state: compat.state,
    analyzable: isAnalyzable(compat.state),
    tiersDir,
    corpusPath,
    recovery: recoveryForState(compat.state) ?? undefined,
  };
  if (compat.state === "incomplete") assessment.coverageGaps = compat.detail;
  if (compat.state === "oversized") assessment.artifact = compat.artifact;
  if (compat.state === "current") assessment.generation = compat.generation;
  return assessment;
}

export interface BoundedMetadata {
  corpusMetadata: TierCorpusMetadata | null;
  signal: { records: SignalRecord[]; bytes: number; manifest: EvidenceTierManifest } | null;
  manifest: EvidenceTierManifest | null;
}

/**
 * Read bounded metadata for signal-tier consumers (report status, prime
 * coverage). Reads the manifest and the bounded signal tier only — never the
 * full-evidence shards — so metadata consumers stay bounded at real scale. The
 * signal tier is bounded by construction; a defensively oversized signal tier is
 * reported as null so the caller degrades with the assessment's recovery.
 */
export function readBoundedMetadata(tiersDir: string): BoundedMetadata {
  const signal = readSignalTier(tiersDir);
  const corpusMetadata = readTierCorpusMetadata(tiersDir);
  const bounds = evidenceTierBounds();
  if (signal && (signal.bytes > bounds.signalByteCap || signal.manifest.signal.bytes > bounds.signalByteCap)) {
    return { corpusMetadata: null, signal: null, manifest: signal.manifest };
  }
  return { corpusMetadata, signal, manifest: signal?.manifest ?? null };
}

/**
 * Iterate full-evidence records for the current generation, one bounded shard at
 * a time. Full-record consumers (usage analytics, startup analysis) use this so
 * they never materialize the monolithic corpus envelope. Returns `null` when no
 * current generation exists; callers report the assessment instead.
 */
export function iterBoundedRecords(tiersDir: string): Generator<JsonObject> | null {
  return iterTierRecords(tiersDir);
}

/**
 * Legacy fallback: a small monolithic corpus envelope may still be read for
 * backward compatibility when no tiers were published. Oversized legacy state
 * is never loaded whole — it returns `false` so the caller emits refresh guidance.
 */
export function legacyCorpusReadable(corpusPath: string): boolean {
  if (!corpusPath || !fs.existsSync(corpusPath)) return false;
  const bounds = evidenceTierBounds();
  try {
    return fs.statSync(corpusPath).size <= bounds.readerByteCap;
  } catch {
    return false;
  }
}
