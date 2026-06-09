import { APP_MANUAL_REVIEW_NEEDED, APP_MIGRATION_NEEDED, APP_OUTDATED, APP_REPAIR_NEEDED, APP_UP_TO_DATE } from "./doctor.js";
import type { UpgradeOnlyPhase } from "./upgradeCommands.js";

/** Upgrade-scenario kinds resolved before command and message assembly. */
export type IntegrationScenario =
  | "stay_manual_review"
  | "stay_up_to_date"
  | "upgrade_artifacts_only"
  | "upgrade_runtime_only"
  | "upgrade_cross_major"
  | "upgrade_cross_major_preview"
  | "upgrade_app_outdated"
  | "upgrade_app_repair"
  | "upgrade_app_migration"
  | "upgrade_runtime_mixed"
  | "upgrade_generic";

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
  const {
    bundleStatus,
    pendingRuntimeCount,
    pendingArtifactCount,
    crossMajor,
    crossMajorMigration,
    crossMajorNeedsPreview,
    needsAppUpgrade,
  } = facts;

  if (
    bundleStatus === APP_MANUAL_REVIEW_NEEDED &&
    pendingRuntimeCount === 0 &&
    pendingArtifactCount === 0 &&
    !crossMajor
  ) {
    return "stay_manual_review";
  }

  const artifactsOnly =
    pendingArtifactCount > 0 && !crossMajorMigration && !crossMajorNeedsPreview && !needsAppUpgrade;
  const runtimeOnly =
    pendingRuntimeCount > 0 &&
    !artifactsOnly &&
    !crossMajorMigration &&
    !crossMajorNeedsPreview &&
    !needsAppUpgrade;

  if (
    !artifactsOnly &&
    !runtimeOnly &&
    !crossMajorMigration &&
    !crossMajorNeedsPreview &&
    !needsAppUpgrade &&
    bundleStatus === APP_UP_TO_DATE &&
    pendingRuntimeCount === 0 &&
    pendingArtifactCount === 0
  ) {
    return "stay_up_to_date";
  }

  if (crossMajorMigration || crossMajorNeedsPreview) {
    return crossMajorMigration ? "upgrade_cross_major" : "upgrade_cross_major_preview";
  }
  if (needsAppUpgrade) {
    if (bundleStatus === APP_OUTDATED) {
      return "upgrade_app_outdated";
    }
    if (bundleStatus === APP_REPAIR_NEEDED) {
      return "upgrade_app_repair";
    }
    if (bundleStatus === APP_MIGRATION_NEEDED) {
      return "upgrade_app_migration";
    }
    return "upgrade_app_outdated";
  }
  if (artifactsOnly) {
    return "upgrade_artifacts_only";
  }
  if (runtimeOnly) {
    return "upgrade_runtime_only";
  }
  if (pendingRuntimeCount > 0) {
    return "upgrade_runtime_mixed";
  }
  return "upgrade_generic";
}

export function integrationScenarioRecommendation(
  scenario: IntegrationScenario,
): "stay" | "upgrade" {
  return scenario === "stay_manual_review" || scenario === "stay_up_to_date" ? "stay" : "upgrade";
}

export function integrationScenarioOnlyPhases(
  scenario: IntegrationScenario,
): readonly UpgradeOnlyPhase[] | undefined {
  if (scenario === "upgrade_artifacts_only") {
    return ["artifacts"];
  }
  if (scenario === "upgrade_runtime_only") {
    return ["runtime"];
  }
  return undefined;
}

export function integrationScenarioNeedsInstallRoot(scenario: IntegrationScenario): boolean {
  return (
    scenario === "upgrade_cross_major" ||
    scenario === "upgrade_cross_major_preview" ||
    scenario === "upgrade_app_outdated" ||
    scenario === "upgrade_app_repair" ||
    scenario === "upgrade_app_migration"
  );
}

const SCENARIO_MESSAGES: Record<IntegrationScenario, string> = {
  stay_manual_review:
    "Agentera needs manual review for your app directory before this project can be upgraded safely.",
  stay_up_to_date: "This project matches your current Agentera install; no upgrade is needed.",
  upgrade_artifacts_only:
    "This project still uses v1 Markdown artifacts; preview migrating them to v2 YAML before continuing.",
  upgrade_cross_major:
    "Your Agentera app copy is still on v2 while the CLI is on v3; preview the one-way v2→v3 migration before applying.",
  upgrade_cross_major_preview:
    "Your Agentera app copy is still on v2 while the CLI is on v3; preview the one-way v2→v3 migration before applying.",
  upgrade_app_outdated:
    "Your Agentera app copy is out of date; preview the update with agentera upgrade before applying.",
  upgrade_app_repair:
    "Your Agentera app copy needs repair; preview the repair with agentera upgrade before applying.",
  upgrade_app_migration:
    "Your Agentera app copy needs migration; preview the migration with agentera upgrade before applying.",
  upgrade_runtime_only: "",
  upgrade_runtime_mixed: "",
  upgrade_generic: "Preview Agentera upgrade changes for this project before applying.",
};

export function integrationScenarioMessage(
  scenario: IntegrationScenario,
  opts: {
    projectLevelRuntimeHooks: boolean;
    pendingRuntimes: string[];
  },
): string {
  if (scenario === "upgrade_runtime_only" || scenario === "upgrade_runtime_mixed") {
    const runtimes = opts.pendingRuntimes.length > 0 ? opts.pendingRuntimes.join(", ") : "runtime configs";
    return opts.projectLevelRuntimeHooks
      ? `This project still uses older Agentera runtime wiring (${runtimes}); preview rewiring hooks to the current npm entrypoint.`
      : `Your user-level Agentera runtime wiring (${runtimes}) is stale; preview rewiring hooks to the current npm entrypoint.`;
  }
  return SCENARIO_MESSAGES[scenario];
}
