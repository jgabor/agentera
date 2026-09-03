import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { PROFILE_SIGNAL_TYPES, profileSufficiency } from "../registries/evidenceTierContract.js";
import type { Env } from "./extractCorpus/core.js";
import { defaultTiersDir, readCurrentPointer, readSignalTier, resolveEvidenceAnchor, type SignalRecord } from "./extractCorpus/evidenceTiers.js";
import { assessTiers, recoveryForState, resolveTiersDir, type TierAssessment } from "./extractCorpus/tierReader.js";

/**
 * Bounded profile-synthesis input and sufficiency assessment (plan Task 4).
 *
 * Task 2 publishes bounded signals with evidence anchors; Task 3 migrated
 * analytics readers. This module is the profile-synthesis analogue: it reads
 * the bounded signal tier, filters to the signal types the profile_synthesis
 * consumer declares in the authority contract, assesses whether the retained
 * distribution is sufficient against the contract's threshold (resolving
 * planning Unknown 2), and resolves a synthesized claim's evidence anchor to
 * retained full evidence. It does not implement profile levels, a glossary,
 * or a new deep-analysis mode — it targets the existing single profile
 * synthesis path.
 *
 * The sufficiency comparison projects the contract's `profile_sufficiency`
 * section (profile_signal_types, minimum_family_retention) from the loader
 * rather than re-declaring them. Insufficient evidence is surfaced, never
 * silently absorbed into fabricated confidence.
 */

/** Per-family retention comparison between bounded and intended distributions. */
export interface ProfileFamilyRetention {
  family: string;
  intended: number;
  retained: number;
  retention: number;
  sufficient: boolean;
}

/** Result of comparing bounded signals against the sufficiency threshold. */
export interface ProfileSufficiencyAssessment {
  sufficient: boolean;
  reason: string;
  threshold: number;
  capped: boolean;
  per_family: ProfileFamilyRetention[];
}

/** Lightweight status surfaced to profile_context (no signal records in payload). */
export interface ProfileSignalsStatus {
  state: TierAssessment["state"];
  tiers_dir: string;
  signal_path: string | null;
  signal_count: number;
  profile_signal_count: number;
  sufficiency: ProfileSufficiencyAssessment | null;
  recovery: string | null;
}

/** Full bounded profile-synthesis input returned by readProfileSignals. */
export interface ProfileSignalsRead {
  state: TierAssessment["state"];
  tiers_dir: string;
  signal_path: string | null;
  signals: SignalRecord[];
  profile_signal_count: number;
  sufficiency: ProfileSufficiencyAssessment;
  recovery: string | null;
}

const PROFILE_TYPES_SET = new Set<string>(PROFILE_SIGNAL_TYPES);

/** Resolve the absolute signal tier file path from the current generation. */
function signalTierPath(tiersDir: string): string | null {
  const pointer = readCurrentPointer(tiersDir);
  if (!pointer) return null;
  return path.join(tiersDir, "generations", pointer.generation, "signal.json");
}

/** Resolve the co-located corpus path for legacy compatibility assessment. */
function corpusPathFromTiersDir(tiersDir: string): string | undefined {
  const idx = tiersDir.lastIndexOf(path.sep + "tiers");
  if (idx === -1) return undefined;
  return path.join(tiersDir.slice(0, idx), "corpus.json");
}

/**
 * Assess whether the retained profile-relevant signal distribution is
 * sufficient against the contract threshold. The prior intended distribution
 * is reconstructed from the signal tier's selection report (total per
 * family); the retained distribution from the published signal records.
 * No separate full-corpus read is needed — the selection report carries both.
 *
 * When the tier is uncapped, retained == total, so the bounded and intended
 * distributions are identical and sufficiency is trivially met. When capped,
 * the selection report's per-family total/retained is the authoritative prior
 * distribution; the profile-relevant intended count is scaled from the
 * retained profile-relevant count by the family's overall retention ratio.
 */
export function assessProfileSufficiency(
  selection: {
    total: number;
    retained: number;
    capped: boolean;
    per_family: Array<{ family: string; total: number; retained: number }>;
  },
  signals: SignalRecord[],
  contractPath?: string,
): ProfileSufficiencyAssessment {
  const suff = profileSufficiency(contractPath);
  const threshold = suff.minimumFamilyRetention;

  const profileRetainedPerFamily = new Map<string, number>();
  for (const sig of signals) {
    const family = sig.source_product || "unknown";
    profileRetainedPerFamily.set(family, (profileRetainedPerFamily.get(family) ?? 0) + 1);
  }

  const profileIntendedPerFamily = new Map<string, number>();
  if (!selection.capped) {
    // Uncapped: retained == intended, so the retained counts ARE the intended.
    for (const [family, retained] of profileRetainedPerFamily) {
      profileIntendedPerFamily.set(family, retained);
    }
  } else {
    // Capped: the selection report's per_family is the authoritative source
    // of which families had records. For families with profile-relevant
    // retained signals, scale the intended count by the family's overall
    // retention ratio. For families where all records were capped
    // (retained=0, total>0), flag them as insufficient — no data survived
    // to contribute to the profile.
    for (const sel of selection.per_family) {
      if (sel.total === 0) continue;
      const profileRetained = profileRetainedPerFamily.get(sel.family) ?? 0;
      if (sel.retained > 0 && profileRetained > 0) {
        profileIntendedPerFamily.set(sel.family, Math.round(profileRetained * (sel.total / sel.retained)));
      } else if (sel.retained === 0 && sel.total > 0) {
        // All records for this family were capped — insufficient by definition.
        profileIntendedPerFamily.set(sel.family, sel.total);
      }
      // If sel.retained > 0 but profileRetained == 0, the family's retained
      // records were simply non-profile-relevant; leave it as sufficient.
    }
    // Also include any family that appears in retained signals but not in the
    // selection report (should not normally happen, but handle gracefully).
    for (const [family, retained] of profileRetainedPerFamily) {
      if (!profileIntendedPerFamily.has(family)) {
        profileIntendedPerFamily.set(family, retained);
      }
    }
  }

  const perFamily: ProfileFamilyRetention[] = [];
  const allFamilies = new Set([...profileIntendedPerFamily.keys(), ...profileRetainedPerFamily.keys()]);
  for (const family of [...allFamilies].sort()) {
    const intended = profileIntendedPerFamily.get(family) ?? 0;
    const retained = profileRetainedPerFamily.get(family) ?? 0;
    const retention = intended > 0 ? retained / intended : 1;
    const sufficient = intended === 0 || retention >= threshold;
    perFamily.push({ family, intended, retained, retention, sufficient });
  }

  const insufficientFamilies = perFamily.filter((f) => !f.sufficient);
  const sufficient = !selection.capped || insufficientFamilies.length === 0;
  const reason = sufficient
    ? selection.capped
      ? "signal tier capped but per-family retention meets threshold"
      : "signal tier uncapped; bounded and intended distributions identical"
    : `insufficient retention for families: ${insufficientFamilies.map((f) => `${f.family} (${f.retained}/${f.intended}, ${(f.retention * 100).toFixed(0)}%)`).join(", ")}`;

  return { sufficient, reason, threshold, capped: selection.capped, per_family: perFamily };
}

/**
 * Read the bounded signal tier and return profile-relevant signals with a
 * sufficiency assessment. This is the bounded profile-synthesis input: it
 * loads only the signal tier (bounded by construction), never the full-
 * evidence shards. Each signal's `evidence_anchor` resolves to retained full
 * evidence via resolveProfileEvidence.
 */
export function readProfileSignals(tiersDir: string, corpusPath?: string, contractPath?: string): ProfileSignalsRead {
  const assessment = assessTiers(tiersDir, corpusPath);
  const recovery = recoveryForState(assessment.state);
  const threshold = profileSufficiency(contractPath).minimumFamilyRetention;

  if (!assessment.analyzable) {
    return {
      state: assessment.state,
      tiers_dir: tiersDir,
      signal_path: null,
      signals: [],
      profile_signal_count: 0,
      sufficiency: {
        sufficient: false,
        reason: assessment.state === "missing" ? "no evidence tiers published" : assessment.state === "legacy" ? "legacy monolithic state; refresh required" : `tier state ${assessment.state}; ${recovery ?? "recovery unavailable"}`,
        threshold,
        capped: false,
        per_family: [],
      },
      recovery,
    };
  }

  const tier = readSignalTier(tiersDir);
  if (!tier) {
    return {
      state: "corrupt",
      tiers_dir: tiersDir,
      signal_path: null,
      signals: [],
      profile_signal_count: 0,
      sufficiency: {
        sufficient: false,
        reason: "signal tier unreadable or not found",
        threshold,
        capped: false,
        per_family: [],
      },
      recovery,
    };
  }

  const profileSignals = tier.records.filter((s) => PROFILE_TYPES_SET.has(s.signal_type));
  const sufficiency = assessProfileSufficiency(tier.manifest.signal.selection, profileSignals, contractPath);

  return {
    state: assessment.state,
    tiers_dir: tiersDir,
    signal_path: signalTierPath(tiersDir),
    signals: profileSignals,
    profile_signal_count: profileSignals.length,
    sufficiency,
    recovery,
  };
}

/**
 * Resolve a synthesized claim's evidence anchor to its retained full-evidence
 * record. Loads only the owning shard, never the whole tier. Returns null
 * when the anchor does not resolve (the claim cannot be checked).
 */
export function resolveProfileEvidence(anchor: string, tiersDir: string): JsonObject | null {
  return resolveEvidenceAnchor(anchor, tiersDir);
}

/**
 * Lightweight status for profile_context — assesses the tiers, reads the
 * signal tier, and computes sufficiency. The signal records are counted but
 * not returned in the status payload (the synthesis step reads them via
 * readProfileSignals or the signal_path). This status tells the agent
 * whether synthesis can proceed and where to read.
 */
export function profileSignalsStatus(env: Env = process.env, platform: NodeJS.Platform = process.platform, contractPath?: string): ProfileSignalsStatus {
  const tiersDir = resolveTiersDir(env, platform);
  const corpusPath = corpusPathFromTiersDir(tiersDir);
  const assessment = assessTiers(tiersDir, corpusPath);
  const recovery = recoveryForState(assessment.state);

  if (!assessment.analyzable) {
    return {
      state: assessment.state,
      tiers_dir: tiersDir,
      signal_path: null,
      signal_count: 0,
      profile_signal_count: 0,
      sufficiency: null,
      recovery,
    };
  }

  const tier = readSignalTier(tiersDir);
  if (!tier) {
    return {
      state: "corrupt",
      tiers_dir: tiersDir,
      signal_path: null,
      signal_count: 0,
      profile_signal_count: 0,
      sufficiency: null,
      recovery,
    };
  }

  const profileSignals = tier.records.filter((s) => PROFILE_TYPES_SET.has(s.signal_type));
  const sufficiency = assessProfileSufficiency(tier.manifest.signal.selection, profileSignals, contractPath);

  return {
    state: assessment.state,
    tiers_dir: tiersDir,
    signal_path: signalTierPath(tiersDir),
    signal_count: tier.records.length,
    profile_signal_count: profileSignals.length,
    sufficiency,
    recovery,
  };
}
