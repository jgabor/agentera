/**
 * Layer 3-4 routing engine — pure function.
 *
 * Takes `(input, TriggerModel)` and returns a `RouteResult`: a selected
 * capability, a set of disambiguation candidates when capabilities are
 * too close to call, or a fallback to `status` when nothing cleared its
 * threshold. No session state, no project state, no I/O.
 *
 * Spec: references/cli/trigger-schema-enrichment.md (§3 scoring, §4
 * disambiguation, §5 fallback).
 */

import type {
  CompiledTriggerEntry,
  TriggerModel,
} from "../registries/triggerLoader.js";

/** Weight constants owned by the engine (spec §3.1). */
export const WEIGHTS = {
  W_REGEX: 1.0,
  W_SUBSTRING: 0.6,
  PRIORITY: {
    high: 1.0,
    medium: 0.7,
    low: 0.4,
  } as const,
} as const;

/** Canonical fallback capability ID when no trigger clears its threshold. */
export const ROUTE_FALLBACK_CAPABILITY = "status";

/**
 * A scored candidate capability surfaced on disambiguation. `hint` is set
 * when this candidate's lead trigger declared a `disambiguates_against`
 * entry whose referenced capability is also in the candidate set; otherwise
 * the field is omitted (spec §4.2).
 */
export interface RouteCandidate {
  readonly capability: string;
  readonly confidence: number;
  readonly hint?: string;
}

/**
 * Result of routing an input through the trigger model. `fallback` is
 * `true` and `capability === "status"` only when no capability cleared
 * its own threshold; otherwise fallback is `false` even on disambiguation,
 * where `capability` is the lead candidate and `candidates` lists the
 * contenders within the borderline band (spec §4, §5).
 */
export interface RouteResult {
  readonly capability: string;
  readonly confidence: number;
  readonly fallback: boolean;
  readonly candidates: readonly RouteCandidate[];
}

interface ScoredTrigger {
  readonly entry: CompiledTriggerEntry;
  readonly contribution: number;
  readonly substringHits: number;
  readonly regexHits: number;
}

interface CapabilityScore {
  readonly capability: string;
  readonly confidence: number;
  readonly lead: ScoredTrigger | null;
}

function clamp01(x: number): number {
  return Math.max(0.0, Math.min(1.0, x));
}

function priorityWeight(priority: CompiledTriggerEntry["priority"]): number {
  return WEIGHTS.PRIORITY[priority];
}

/**
 * Count case-insensitive substring occurrences of each pattern in the input.
 * Each pattern is counted at most once (spec §3.2).
 */
function countSubstringHits(patterns: readonly string[], lowerInput: string): number {
  let hits = 0;
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!.toLowerCase();
    if (p.length > 0 && lowerInput.includes(p)) hits += 1;
  }
  return hits;
}

/**
 * Count case-insensitive matches of each compiled regex against the input.
 * Each pattern is counted at most once (spec §3.2). The regexes are
 * pre-compiled with the `i` flag in the trigger loader.
 */
function countRegexHits(regexes: readonly RegExp[], input: string): number {
  let hits = 0;
  for (let i = 0; i < regexes.length; i++) {
    if (regexes[i]!.test(input)) hits += 1;
  }
  return hits;
}

/**
 * Compute the per-entry contribution per spec §3.2:
 *
 *   contribution_T = clamp01(
 *       (substring_hits * W_SUBSTRING + regex_hits * W_REGEX) /
 *       max(substring_hits + regex_hits, 1)
 *   ) * W_PRIORITY[T.priority] * 100
 *
 * Returns null when the entry produced zero hits (so contribution is 0),
 * which lets the caller skip it cleanly.
 */
function scoreTriggerEntry(
  entry: CompiledTriggerEntry,
  input: string,
  lowerInput: string,
): ScoredTrigger | null {
  const substringHits = countSubstringHits(entry.patterns, lowerInput);
  const regexHits = countRegexHits(entry.patternsRegex, input);
  const totalHits = substringHits + regexHits;
  if (totalHits === 0) return null;

  const ratio = (substringHits * WEIGHTS.W_SUBSTRING + regexHits * WEIGHTS.W_REGEX) /
    Math.max(totalHits, 1);
  const contribution = clamp01(ratio) * priorityWeight(entry.priority) * 100;

  return { entry, contribution, substringHits, regexHits };
}

/**
 * Find the lead trigger for a capability — the qualifying entry (contribution
 * ≥ its own confidence_threshold) with the maximum contribution. Returns
 * null when no entry qualifies (spec §3.3).
 */
function scoreCapability(
  capability: string,
  triggers: readonly CompiledTriggerEntry[],
  input: string,
  lowerInput: string,
): CapabilityScore {
  let lead: ScoredTrigger | null = null;
  for (let i = 0; i < triggers.length; i++) {
    const entry = triggers[i]!;
    // The fallback marker entry (status T5) documents engine-level fallback
    // behavior; it never produces a route match itself.
    if (entry.fallback) continue;
    const scored = scoreTriggerEntry(entry, input, lowerInput);
    if (!scored) continue;
    if (scored.contribution < entry.confidenceThreshold) continue;
    if (lead === null || scored.contribution > lead.contribution) {
      lead = scored;
    }
  }
  return {
    capability,
    confidence: lead?.contribution ?? 0,
    lead,
  };
}

/**
 * Resolve the disambiguation hint for a candidate. Per spec §4.2 the hint
 * comes from the lead trigger's `disambiguates_against` list whose
 * `capability` matches another candidate's capability. Returns undefined
 * when no such hint exists.
 */
function resolveHint(lead: ScoredTrigger | null, candidateCapabilities: ReadonlySet<string>): string | undefined {
  if (!lead) return undefined;
  for (const ref of lead.entry.disambiguatesAgainst) {
    if (candidateCapabilities.has(ref.capability)) return ref.hint;
  }
  return undefined;
}

/**
 * Route an input against the trigger model. Implements scoring (§3),
 * disambiguation (§4), and fallback (§5) of the enrichment spec. The
 * function is pure: identical `(input, model)` calls return structurally
 * identical `RouteResult`s.
 */
export function routeInput(input: string, model: TriggerModel): RouteResult {
  const lowerInput = input.toLowerCase();

  const scores: CapabilityScore[] = [];
  for (const { capability, triggers } of model.capabilities.values()) {
    scores.push(scoreCapability(capability, triggers, input, lowerInput));
  }
  // Sort descending by confidence (ties broken by capability id for stable output).
  scores.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.capability < b.capability ? -1 : 1;
  });

  const top = scores[0]!;
  const second = scores[1];

  // Fallback: no capability cleared its threshold (spec §5).
  if (top.lead === null || top.confidence <= 0) {
    return {
      capability: ROUTE_FALLBACK_CAPABILITY,
      confidence: 0,
      fallback: true,
      candidates: [],
    };
  }

  // Disambiguation fires when the lead cleared its threshold AND the gap to
  // the runner-up is within the lead trigger's borderline_band (spec §4.1).
  const band = top.lead.entry.borderlineBand;
  const withinBand = second !== undefined && top.confidence - second.confidence <= band;

  if (!withinBand) {
    // Clean match.
    return {
      capability: top.capability,
      confidence: top.confidence,
      fallback: false,
      candidates: [],
    };
  }

  // Gather all candidates within the band of the lead (spec §4.2 — "the top
  // two or more, up to those within the band"). Only capabilities with a
  // non-zero confidence (an actual qualifying lead) are eligible.
  const candidateScores: CapabilityScore[] = [];
  for (const s of scores) {
    if (s.lead === null || s.confidence <= 0) continue;
    if (top.confidence - s.confidence > band) continue;
    candidateScores.push(s);
  }
  // candidateScores is already in descending order from the sort above.
  const candidateCapabilitySet = new Set(candidateScores.map((c) => c.capability));

  const candidates: RouteCandidate[] = candidateScores.map((s) => {
    const hint = resolveHint(s.lead, candidateCapabilitySet);
    return hint === undefined
      ? { capability: s.capability, confidence: s.confidence }
      : { capability: s.capability, confidence: s.confidence, hint };
  });

  return {
    capability: top.capability,
    confidence: top.confidence,
    fallback: false,
    candidates,
  };
}
