import { APP_MANUAL_REVIEW_NEEDED, APP_UP_TO_DATE } from "./doctor.js";

export type IntegrationScenario = "stay" | "upgrade" | "blocked";

export type IntegrationExitMeaning =
  | "no_changes_needed"
  | "preview_required"
  | "manual_review_required"
  | "preview_and_blockers";

export interface IntegrationPhaseSummary {
  status: "stay" | "pending" | "blocked";
  counts: {
    total: number;
    pending: number;
    blocked: number;
  };
  blockers: string[];
}

export interface IntegrationExit {
  code: 0 | 1;
  meaning: IntegrationExitMeaning;
}

export interface IntegrationRetry {
  command: string | null;
  guidance: string;
}

export interface IntegrationScenarioFacts {
  bundleStatus: string;
  pendingArtifactCount: number;
  crossMajor: boolean;
  crossMajorMigration: boolean;
  crossMajorNeedsPreview: boolean;
  needsAppUpgrade: boolean;
}

export interface IntegrationPhaseFacts {
  pending: number;
  blocked: number;
  total: number;
  blockers: string[];
}

export function classifyIntegrationScenario(facts: IntegrationScenarioFacts): IntegrationScenario {
  if (
    facts.pendingArtifactCount === 0 &&
    !facts.crossMajor &&
    !facts.crossMajorMigration &&
    !facts.crossMajorNeedsPreview &&
    (facts.bundleStatus === APP_UP_TO_DATE || facts.bundleStatus === APP_MANUAL_REVIEW_NEEDED)
  ) {
    return "stay";
  }
  if (facts.crossMajorNeedsPreview) {
    return "blocked";
  }
  return "upgrade";
}

export function integrationScenarioMessage(
  scenario: IntegrationScenario,
  facts: IntegrationScenarioFacts,
): string {
  if (scenario === "stay") return "Your Agentera install is up to date.";
  if (scenario === "blocked") {
    return "Cross-major version boundary detected; v3 successor not yet announced. Stay on the current channel.";
  }
  const reasons: string[] = [];
  if (facts.pendingArtifactCount > 0) reasons.push("project state needs migration");
  if (facts.needsAppUpgrade) reasons.push("app bundle needs update");
  if (facts.crossMajorMigration) reasons.push("cross-major version migration needed");
  if (reasons.length === 0) reasons.push("project changes pending");
  return `This project needs an Agentera upgrade (${reasons.join(", ")}). Preview the upgrade command.`;
}

export function integrationPhase(
  facts: IntegrationPhaseFacts,
  statusOverride?: IntegrationPhaseSummary["status"],
): IntegrationPhaseSummary {
  const status = statusOverride ?? (facts.blocked > 0 ? "blocked" : facts.pending > 0 ? "pending" : "stay");
  return {
    status,
    counts: { total: facts.total, pending: facts.pending, blocked: facts.blocked },
    blockers: facts.blockers,
  };
}

export function integrationExit(
  hasPendingWork: boolean,
  appBlocked: boolean,
): IntegrationExit {
  if (!hasPendingWork && !appBlocked) {
    return { code: 0, meaning: "no_changes_needed" };
  }
  if (hasPendingWork && appBlocked) {
    return { code: 1, meaning: "preview_and_blockers" };
  }
  if (hasPendingWork) return { code: 1, meaning: "preview_required" };
  return { code: 1, meaning: "manual_review_required" };
}
