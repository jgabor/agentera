import { APP_MANUAL_REVIEW_NEEDED, APP_UP_TO_DATE } from "./doctor.js";

export type IntegrationScenario = "stay" | "upgrade" | "blocked";

export interface IntegrationScenarioFacts {
  bundleStatus: string;
  pendingRuntimeCount: number;
  pendingArtifactCount: number;
  crossMajor: boolean;
  crossMajorMigration: boolean;
  crossMajorNeedsPreview: boolean;
  needsAppUpgrade: boolean;
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
