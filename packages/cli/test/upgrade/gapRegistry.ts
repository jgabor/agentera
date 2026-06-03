/**
 * Tracked v2→v3 migration gaps. Flip `closed` to true when implementation lands;
 * corresponding tests must pass without skip.
 *
 * The D56 plan adds six per-family gap entries that map to the six
 * v3-remaining CLI surface families in
 * `packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json`.
 * These entries start as `closed: false` (the surfaces are not yet ported
 * at T1) and flip to `closed: true` as T2-T7 land the surface ports. The
 * T1 npmParityMatrix registers each family as
 * `version_break: true` (intentional_version_break) until the corresponding
 * gap closes.
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
  RUNTIME_ADAPTER_HOOKS_FAMILY: "gap-runtime-adapter-hooks-family",
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
    runtimeIds: ["opencode", "claude", "copilot"],
  },
  {
    id: GAP_IDS.CHANNEL_AWARE_NPX_DIST,
    description: "rewire constants use npx -y agentera@next on development channel",
    closed: true,
    runtimeIds: ["codex", "cursor", "cursor-agent"],
  },
  // D56 T2: artifact-validation CLI surface (7 validate subcommands).
  // Ported incrementally; close when all 7 subcommands are parity-green.
  {
    id: GAP_IDS.ARTIFACT_VALIDATION_FAMILY,
    description:
      "D56 T2: port the 7 validate subcommands (capability, capability-contract, cross-capability, lifecycle-adapters, app-home-contract, vocabularyAuthority, selfAudit) to TS and prove byte-level parity with the Python oracle pinned at parity-remaining-families.json:python_commit.",
    closed: true,
    runtimeIds: ["opencode", "claude", "copilot", "codex", "cursor", "cursor-agent"],
  },
  // D56 T3: compaction CLI surface (apply + dry-run + retention caps).
  {
    id: GAP_IDS.COMPACTION_FAMILY,
    description:
      "D56 T3: port `check compact` apply + dry-run + retention caps (10/40/50) to TS with size-bounded corpus reads and archive preservation; parity row in parity-remaining-families.json:compaction closes when drift_direction === 'equal'.",
    closed: true,
    runtimeIds: ["opencode", "claude", "copilot", "codex", "cursor", "cursor-agent"],
  },
  // D56 T4: doctor/upgrade safety rails.
  {
    id: GAP_IDS.DOCTOR_UPGRADE_SAFETY_FAMILY,
    description:
      "D56 T4: port doctor/upgrade safety rails (outdated → ready_to_apply → applied; repair_needed; manual_review_needed) to TS with Decision 54 lifecycle vocabulary and plain-language repair wording; next-major doctor parity for the npm channel.",
    closed: true,
    runtimeIds: ["opencode", "claude", "copilot", "codex", "cursor", "cursor-agent"],
  },
  // D56 T5: verify gates (check verify eval).
  {
    id: GAP_IDS.VERIFY_EVAL_FAMILY,
    description:
      "D56 T5: port `check verify eval` safety wrappers (retired smoke family messaging for npm distribution; bounded offline smoke without live model calls by default) and pin the agent-ready-state-contract.yaml for the npm @next distribution boundary.",
    closed: true,
    runtimeIds: ["opencode", "claude", "copilot", "codex", "cursor", "cursor-agent"],
  },
  // D56 T6: usage/stats consent semantics (closed — npmParityMatrix usage_stats_consent = equal).
  {
    id: GAP_IDS.USAGE_STATS_CONSENT_FAMILY,
    description:
      "D56 T6: port `stats` + `stats refresh --dry-run` + `stats refresh --consent local-history` to TS with explicit consent enforcement and size-bounded corpus reads; v1 `agentera stats` namespace owns the surface; no top-level `agentera corpus` command.",
    closed: true,
    runtimeIds: ["opencode", "claude", "copilot", "codex", "cursor", "cursor-agent"],
  },
  // D56 T7: runtime adapter hooks (OpenCode/Codex/Cursor/Copilot).
  {
    id: GAP_IDS.RUNTIME_ADAPTER_HOOKS_FAMILY,
    description:
      "D56 T7: port runtime adapter hooks (OpenCode event/shell.env/chat.message/tool.execute.before-after/experimental.session.compacting; Codex hooks.state + PLUGIN_ROOT-safe apply_patch; Cursor preToolUse Write + session lifecycle; Copilot per-invocation AGENTERA_HOME) and per-runtime subagent_dispatch parity; descriptor bodies and trust hashes parity.",
    closed: true,
    runtimeIds: ["opencode", "claude", "copilot", "codex", "cursor", "cursor-agent"],
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
  runtime_adapter_hooks: GAP_IDS.RUNTIME_ADAPTER_HOOKS_FAMILY,
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
  claude: "noop",
  opencode: "applied",
  copilot: "noop",
  codex: "applied",
  cursor: "applied",
  "cursor-agent": "noop",
};
