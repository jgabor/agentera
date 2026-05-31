/**
 * Tracked v2→v3 migration gaps. Flip `closed` to true when implementation lands;
 * corresponding tests must pass without skip.
 */
export const GAP_IDS = {
  OPENCODE_RUNTIME_REWIRE: "gap-opencode-runtime-rewire",
  STALE_SURFACE_CLEANUP: "gap-stale-surface-cleanup",
  CHANNEL_AWARE_NPX_DIST: "gap-channel-aware-npx-dist",
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
    closed: false,
    runtimeIds: ["opencode"],
  },
  {
    id: GAP_IDS.STALE_SURFACE_CLEANUP,
    description: "cleanup phase does not remove stale v1 surfaces via detect module",
    closed: false,
    runtimeIds: ["opencode", "claude", "copilot"],
  },
  {
    id: GAP_IDS.CHANNEL_AWARE_NPX_DIST,
    description: "rewire constants use npx -y agentera without @next on development channel",
    closed: false,
    runtimeIds: ["codex", "cursor", "cursor-agent"],
  },
] as const;

export function isGapClosed(id: GapId): boolean {
  return TRACKED_GAPS.find((gap) => gap.id === id)?.closed ?? false;
}

export function gapSkipReason(id: GapId): string {
  return `expected-fail until ${id} closes`;
}

/** Default runtime matrix for sandbox-report.json on current implementation. */
export const DEFAULT_RUNTIME_MATRIX: Record<string, RuntimeMatrixStatus> = {
  claude: "noop",
  opencode: "expected_fail",
  copilot: "noop",
  codex: "applied",
  cursor: "applied",
  "cursor-agent": "not_implemented",
};
