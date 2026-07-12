import { APP_MANUAL_REVIEW_NEEDED, APP_UP_TO_DATE } from "./doctor.js";

export type IntegrationScenario = "stay" | "upgrade" | "blocked";

export type IntegrationGuidanceRoute =
  | "upgrade_preview"
  | "manual_review"
  | "host_action"
  | "doctor";

export type IntegrationExitMeaning =
  | "no_changes_needed"
  | "preview_required"
  | "manual_review_required"
  | "host_action_required"
  | "doctor_diagnostics_required"
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

export interface IntegrationGuidance {
  route: IntegrationGuidanceRoute;
  runtimes: string[];
  manual_review_runtimes: string[];
  host_action_runtimes: string[];
  doctor_runtimes: string[];
  message: string;
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
  pendingRuntimeCount: number;
  pendingArtifactCount: number;
  crossMajor: boolean;
  crossMajorMigration: boolean;
  crossMajorNeedsPreview: boolean;
  needsAppUpgrade: boolean;
}

export interface LifecycleIntegrationFacts {
  pendingOwnedCount: number;
  pendingOwnedRuntimes: string[];
  manualReviewCount: number;
  manualReviewRuntimes: string[];
  hostActionCount: number;
  hostActionRuntimes: string[];
  doctorCount: number;
  doctorRuntimes: string[];
  blockers: string[];
}

export interface IntegrationPhaseFacts {
  pending: number;
  blocked: number;
  total: number;
  blockers: string[];
}

export function classifyIntegrationScenario(facts: IntegrationScenarioFacts): IntegrationScenario {
  if (
    facts.pendingRuntimeCount === 0 &&
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

export function integrationScenarioRecommendation(scenario: IntegrationScenario): "stay" | "upgrade" {
  if (scenario === "stay") return "stay";
  if (scenario === "blocked") return "stay";
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
  if (facts.pendingRuntimeCount > 0) reasons.push("runtime wiring needs sync");
  if (facts.pendingArtifactCount > 0) reasons.push("v1 artifacts need migration");
  if (facts.needsAppUpgrade) reasons.push("app bundle needs update");
  if (facts.crossMajorMigration) reasons.push("cross-major version migration needed");
  if (reasons.length === 0) reasons.push("project changes pending");
  return `This project needs an Agentera upgrade (${reasons.join(", ")}). Preview the upgrade command.`;
}

export function lifecycleIntegrationPhase(
  facts: LifecycleIntegrationFacts,
): IntegrationPhaseSummary {
  const pending = facts.pendingOwnedCount;
  const blocked = facts.manualReviewCount + facts.hostActionCount + facts.doctorCount;
  return {
    status: blocked > 0 ? "blocked" : pending > 0 ? "pending" : "stay",
    counts: { total: pending + blocked, pending, blocked },
    blockers: facts.blockers,
  };
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

export function integrationGuidance(
  lifecycle: LifecycleIntegrationFacts,
  hasUpgradeWork: boolean,
): IntegrationGuidance {
  const manualReviewRuntimes = [...new Set(lifecycle.manualReviewRuntimes)].sort();
  const hostActionRuntimes = [...new Set(lifecycle.hostActionRuntimes)].sort();
  const doctorRuntimes = [...new Set(lifecycle.doctorRuntimes)].sort();
  const runtimes = [
    ...new Set([
      ...lifecycle.pendingOwnedRuntimes,
      ...manualReviewRuntimes,
      ...hostActionRuntimes,
      ...doctorRuntimes,
    ]),
  ].sort();
  if (hasUpgradeWork) {
    const previewMessage = runtimes.length > 0
      ? `Preview the Agentera upgrade for affected runtimes: ${runtimes.join(", ")}.`
      : "Preview the Agentera app upgrade.";
    return {
      route: "upgrade_preview",
      runtimes,
      manual_review_runtimes: manualReviewRuntimes,
      host_action_runtimes: hostActionRuntimes,
      doctor_runtimes: doctorRuntimes,
      message: previewMessage,
    };
  }
  if (manualReviewRuntimes.length > 0) {
    return {
      route: "manual_review",
      runtimes,
      manual_review_runtimes: manualReviewRuntimes,
      host_action_runtimes: hostActionRuntimes,
      doctor_runtimes: doctorRuntimes,
      message: `Manual review is required for unowned lifecycle collisions in: ${manualReviewRuntimes.join(", ")}.`,
    };
  }
  if (hostActionRuntimes.length > 0) {
    return {
      route: "host_action",
      runtimes,
      manual_review_runtimes: manualReviewRuntimes,
      host_action_runtimes: hostActionRuntimes,
      doctor_runtimes: doctorRuntimes,
      message: `Run the user-owned native host action for: ${hostActionRuntimes.join(", ")}.`,
    };
  }
  if (doctorRuntimes.length > 0) {
    return {
      route: "doctor",
      runtimes,
      manual_review_runtimes: manualReviewRuntimes,
      host_action_runtimes: hostActionRuntimes,
      doctor_runtimes: doctorRuntimes,
      message: `Run Agentera doctor diagnostics for unobservable lifecycle gaps in: ${doctorRuntimes.join(", ")}.`,
    };
  }
  return {
    route: "upgrade_preview",
    runtimes,
    manual_review_runtimes: manualReviewRuntimes,
    host_action_runtimes: hostActionRuntimes,
    doctor_runtimes: doctorRuntimes,
    message: "No lifecycle action is required.",
  };
}

export function integrationExit(
  hasPendingWork: boolean,
  lifecycle: LifecycleIntegrationFacts,
  appBlocked: boolean,
): IntegrationExit {
  const hasManualReview = lifecycle.manualReviewCount > 0;
  const hasHostAction = lifecycle.hostActionCount > 0;
  const hasDoctor = lifecycle.doctorCount > 0;
  if (!hasPendingWork && !appBlocked && !hasManualReview && !hasHostAction && !hasDoctor) {
    return { code: 0, meaning: "no_changes_needed" };
  }
  if (hasPendingWork && (appBlocked || hasManualReview || hasHostAction || hasDoctor)) {
    return { code: 1, meaning: "preview_and_blockers" };
  }
  if (hasPendingWork) return { code: 1, meaning: "preview_required" };
  if (hasManualReview || appBlocked) return { code: 1, meaning: "manual_review_required" };
  if (hasHostAction) return { code: 1, meaning: "host_action_required" };
  return { code: 1, meaning: "doctor_diagnostics_required" };
}
