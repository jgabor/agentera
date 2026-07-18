import {
  buildUpgradePlan,
  renderUpgradePlan,
  sortKeysDeep,
  upgradeExitCode,
  validateUpgradeApply,
  type UpgradeOrchestratorArgs,
  type UpgradeOnlyPhase,
} from "../../upgrade/upgradeOrchestrator.js";
import {
  renderVerifySummary,
  verifyOneWayUpgrade,
  verifyUpgrade,
  type OneWayUpgradeVerification,
  type VerifyContext,
} from "./upgradeVerify.js";
import { detectStateMode } from "../../state/stateMode.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };
type UpgradeDependencies = {
  verifyOneWayUpgrade?: (ctx: VerifyContext) => OneWayUpgradeVerification;
};

export interface UpgradeArgs {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  expectedVersion?: string | null;
  channel?: string | null;
  yes?: boolean;
  dryRun?: boolean;
  only?: readonly UpgradeOnlyPhase[] | null;
  force?: boolean;
  runtime?: UpgradeOrchestratorArgs["runtime"];
  legacyCleanup?: UpgradeOrchestratorArgs["legacyCleanup"];
  verify?: boolean;
  format?: string;
}

/** Canonical stable-channel update entry point. */
export const UPGRADE_COMMAND = "npx -y agentera@latest";

function toOrchestratorArgs(args: UpgradeArgs): UpgradeOrchestratorArgs {
  return {
    installRoot: args.installRoot ?? null,
    home: args.home ?? null,
    project: args.project ?? null,
    channel: args.channel ?? null,
    yes: args.yes ?? false,
    dryRun: args.dryRun ?? false,
    only: args.only && args.only.length > 0 ? args.only : null,
    force: args.force ?? false,
    runtime: args.runtime ?? null,
    legacyCleanup: args.legacyCleanup ?? null,
  };
}

function toVerifyContext(args: UpgradeArgs): VerifyContext {
  return {
    installRoot: args.installRoot ?? null,
    home: args.home ?? null,
    project: args.project ?? null,
    expectedVersion: args.expectedVersion ?? null,
  };
}

function renderOneWayResult(
  verification: OneWayUpgradeVerification,
  applyPassed: boolean,
  json: boolean,
): string {
  const verificationPassed = verification.state_validation.status === "passed"
    && verification.startup_validation.status === "passed";
  const result = {
    phase: applyPassed ? (verificationPassed ? "complete" : "verification") : "apply",
    startup_validation: verification.startup_validation,
    state_validation: verification.state_validation,
    status: applyPassed && verificationPassed ? "success" : "failed",
  };
  if (json) return JSON.stringify(result, null, 2) + "\n";
  return result.status === "success"
    ? "Agentera upgraded this project from v2 to v3; state and startup validation passed.\n"
    : "Agentera could not verify the v2-to-v3 upgrade.\n";
}

function entityAuthorityConfirmedInactive(project: string): boolean {
  try {
    return detectStateMode(project) !== "entities";
  } catch {
    return false;
  }
}

export function cmdUpgrade(args: UpgradeArgs, io: Io = {}, dependencies: UpgradeDependencies = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const orchestratorArgs = toOrchestratorArgs(args);

  if (orchestratorArgs.yes && orchestratorArgs.dryRun) {
    err("upgrade error: --yes and --dry-run are mutually exclusive\n");
    return 2;
  }

  if (
    (orchestratorArgs.runtime || orchestratorArgs.legacyCleanup)
    && orchestratorArgs.only
    && orchestratorArgs.only.length > 0
  ) {
    err("upgrade error: --only cannot be combined with --runtime or --legacy-cleanup; lifecycle preview must include the complete app phase\n");
    return 2;
  }

  if (args.verify && orchestratorArgs.dryRun) {
    err("upgrade error: --verify cannot be combined with --dry-run\n");
    return 2;
  }

  if (args.verify && !orchestratorArgs.yes && (
    orchestratorArgs.runtime || orchestratorArgs.legacyCleanup
  )) {
    err("upgrade error: lifecycle selection with --verify requires --yes; preview lifecycle work with --dry-run instead\n");
    return 2;
  }

  if (args.verify && !orchestratorArgs.yes) {
    let result;
    try {
      result = verifyUpgrade(toVerifyContext(args));
    } catch (exc) {
      err(`upgrade error: ${(exc as Error).message}\n`);
      return 2;
    }
    out(renderVerifySummary(result, (args.format ?? "text") === "json"));
    return result.passed ? 0 : 1;
  }

  let plan;
  let fullEntityCutoverApply = false;
  try {
    if (orchestratorArgs.yes) {
      const preview = buildUpgradePlan({ ...orchestratorArgs, yes: false });
      fullEntityCutoverApply = !orchestratorArgs.only && (preview.crossMajorBoundary || preview.phases.some((phase) =>
        phase.name === "entities" && phase.items.some((item) => item.action === "entity-cutover" && item.status === "pending"),
      ));
      const applyError = validateUpgradeApply(orchestratorArgs, preview);
      if (applyError) {
        if (preview.crossMajorBoundary) {
          if (orchestratorArgs.only) {
            err("upgrade error: v2-to-v3 apply must run as one full upgrade --yes; --only is preview-only.\n");
          } else if (preview.channel.distributionMajor < 3) {
            err("upgrade error: v2-to-v3 apply requires the development channel; preview there, then retry with --yes.\n");
          } else if (entityAuthorityConfirmedInactive(preview.project)) {
            err("upgrade error: v2-to-v3 preflight failed. Recover the tracked v2 checkout with Git and retry.\n");
          } else {
            err("upgrade error: v2-to-v3 preflight failed. Rerun the same upgrade command to continue forward.\n");
          }
        } else {
          err(`upgrade error: ${applyError}\n`);
        }
        return 1;
      }
    }
    plan = buildUpgradePlan(orchestratorArgs);
  } catch (exc) {
    if (fullEntityCutoverApply) {
      err("upgrade error: the v2-to-v3 upgrade did not complete. Rerun the same upgrade command to continue forward.\n");
    } else {
      err(`upgrade error: ${(exc as Error).message}\n`);
    }
    return 2;
  }

  if (fullEntityCutoverApply) {
    const applyExit = upgradeExitCode(plan);
    const verification = (dependencies.verifyOneWayUpgrade ?? verifyOneWayUpgrade)(toVerifyContext(args));
    const verificationPassed = verification.state_validation.status === "passed"
      && verification.startup_validation.status === "passed";
    out(renderOneWayResult(verification, applyExit === 0, (args.format ?? "text") === "json"));
    if (applyExit !== 0 || !verificationPassed) {
      err(applyExit !== 0 && entityAuthorityConfirmedInactive(plan.project)
        ? "Recover the tracked v2 checkout with Git and retry; no v3 authority was activated.\n"
        : "Rerun the same upgrade command to continue forward; verification is read-only and no completed effect was reversed.\n");
      return 1;
    }
    return 0;
  }

  if ((args.format ?? "text") === "json") {
    out(JSON.stringify(sortKeysDeep(plan), null, 2) + "\n");
  } else {
    out(renderUpgradePlan(plan));
  }
  let exit = upgradeExitCode(plan);

  if (args.verify && orchestratorArgs.yes) {
    let result;
    try {
      result = verifyUpgrade(toVerifyContext(args));
    } catch (exc) {
      err(`upgrade error: ${(exc as Error).message}\n`);
      return 2;
    }
    err(renderVerifySummary(result, false));
    if (!result.passed) exit = 1;
  }

  return exit;
}

export type { UpgradeOnlyPhase };
