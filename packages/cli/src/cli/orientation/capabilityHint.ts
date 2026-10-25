import type { OrientationState } from "../contracts/orientationState.js";

export interface CapabilityHint {
  capability: string;
  reason: string;
}

function decisionCount(state: OrientationState): number | null {
  const counts = (state.history.decisions as Record<string, unknown> | undefined)?.counts as Record<string, unknown> | undefined;
  return typeof counts?.total === "number" ? counts.total : null;
}

/**
 * At most one capability the project has not used yet, derived from existing
 * state with no tracking store. Status shows it only when attention is empty,
 * and never names the capability next_action already recommends. It is
 * informational, never consent.
 */
export function selectCapabilityHint(state: OrientationState, attention: readonly unknown[]): CapabilityHint | null {
  if (attention.length > 0) return null;
  const candidates: Array<CapabilityHint & { unused: boolean }> = [
    { capability: "audit", reason: "No health audit has been recorded.", unused: !state.health.exists },
    { capability: "document", reason: "No documentation index exists.", unused: !state.docs.exists },
    { capability: "optimize", reason: "No objective has been set.", unused: !state.objective.exists },
    { capability: "discuss", reason: "No decision has been recorded.", unused: decisionCount(state) === 0 },
  ];
  const recommended = state.next_action.recommended.capability;
  const hint = candidates.find((candidate) => candidate.unused && candidate.capability !== recommended);
  return hint ? { capability: hint.capability, reason: hint.reason } : null;
}
