/**
 * Tracked v2→v3 migration gaps. Flip `closed` to true when implementation lands;
 * corresponding tests must pass without skip.
 *
 * The retained per-family gap entries map to the current CLI parity rows in
 * `packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json`.
 * All listed rows are closed, so npmParityMatrix requires equal drift.
 */
export const GAP_IDS = {
  OPENCODE_RUNTIME_REWIRE: "gap-opencode-runtime-rewire",
  V2_PYTHON_SURFACE_RETIREMENT: "gap-v2-python-surface-retirement",
  CHANNEL_AWARE_NPX_DIST: "gap-channel-aware-npx-dist",
  ARTIFACT_VALIDATION_FAMILY: "gap-artifact-validation-family",
  COMPACTION_FAMILY: "gap-compaction-family",
  DOCTOR_UPGRADE_SAFETY_FAMILY: "gap-doctor-upgrade-safety-family",
  VERIFY_EVAL_FAMILY: "gap-verify-eval-family",
  USAGE_STATS_CONSENT_FAMILY: "gap-usage-stats-consent-family",
} as const;

export type GapId = (typeof GAP_IDS)[keyof typeof GAP_IDS];

export type RuntimeMatrixStatus =
  | "applied"
  | "blocked"
  | "not_implemented"
  | "expected_fail"
  | "noop";

export interface TrackedGap {
  id: GapId;
  description: string;
  closed: boolean;
  runtimeIds: readonly string[];
}

export const TRACKED_GAPS: readonly TrackedGap[] = [
  {
    id: GAP_IDS.OPENCODE_RUNTIME_REWIRE,
    description: "runtimeTargets() does not rewire OpenCode plugin/commands/agents/skills",
    closed: true,
    runtimeIds: ["opencode"],
  },
  {
    id: GAP_IDS.V2_PYTHON_SURFACE_RETIREMENT,
    description: "runtime migration retires v2 Python-managed surfaces (Codex copied hooks, OpenCode plugin, project hooks)",
    closed: true,
    runtimeIds: ["opencode", "copilot"],
  },
  {
    id: GAP_IDS.CHANNEL_AWARE_NPX_DIST,
    description: "rewire constants use npx -y agentera@next on development channel",
    closed: true,
    runtimeIds: ["codex", "cursor"],
  },
  // Artifact-validation CLI surface.
  {
    id: GAP_IDS.ARTIFACT_VALIDATION_FAMILY,
    description:
      "Validate command parity with the Python oracle pinned at parity-remaining-families.json:python_commit.",
    closed: true,
    runtimeIds: ["opencode", "copilot", "codex", "cursor"],
  },
  // Compaction CLI surface.
  {
    id: GAP_IDS.COMPACTION_FAMILY,
    description:
      "`check compact` apply, dry-run, and retention parity with size-bounded corpus reads and archive preservation.",
    closed: true,
    runtimeIds: ["opencode", "copilot", "codex", "cursor"],
  },
  // Doctor and upgrade safety rails.
  {
    id: GAP_IDS.DOCTOR_UPGRADE_SAFETY_FAMILY,
    description:
      "Doctor and upgrade safety rails cover lifecycle status vocabulary and plain-language repair wording on the npm channel.",
    closed: true,
    runtimeIds: ["opencode", "copilot", "codex", "cursor"],
  },
  // Verify gates.
  {
    id: GAP_IDS.VERIFY_EVAL_FAMILY,
    description:
      "`check verify eval` preserves bounded offline evaluation and retired-smoke guidance for the npm distribution.",
    closed: true,
    runtimeIds: ["opencode", "copilot", "codex", "cursor"],
  },
  // Usage and stats consent semantics.
  {
    id: GAP_IDS.USAGE_STATS_CONSENT_FAMILY,
    description:
      "`stats` and `stats refresh` enforce explicit consent with size-bounded corpus reads; no top-level `agentera corpus` command.",
    closed: true,
    runtimeIds: ["opencode", "copilot", "codex", "cursor"],
  },
] as const;

export function isGapClosed(id: GapId): boolean {
  return TRACKED_GAPS.find((gap) => gap.id === id)?.closed ?? false;
}

/** Maps D56 parity-remaining-families.json family ids to tracked gap entries. */
export const D56_PARITY_FAMILY_GAPS: Record<string, GapId> = {
  artifact_validation: GAP_IDS.ARTIFACT_VALIDATION_FAMILY,
  compaction: GAP_IDS.COMPACTION_FAMILY,
  doctor_upgrade_safety: GAP_IDS.DOCTOR_UPGRADE_SAFETY_FAMILY,
  verify_eval: GAP_IDS.VERIFY_EVAL_FAMILY,
  usage_stats_consent: GAP_IDS.USAGE_STATS_CONSENT_FAMILY,
};

export function isParityFamilyClosed(family: string): boolean {
  const gapId = D56_PARITY_FAMILY_GAPS[family];
  return gapId !== undefined && isGapClosed(gapId);
}

export function gapSkipReason(id: GapId): string {
  return `expected-fail until ${id} closes`;
}

/** Default runtime matrix for sandbox-report.json on current implementation. */
export const DEFAULT_RUNTIME_MATRIX: Record<string, RuntimeMatrixStatus> = {
  opencode: "applied",
  copilot: "noop",
  codex: "applied",
  cursor: "applied",
};
