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
import { UpgradeLockError } from "../../upgrade/upgradeLock.js";
import { fullEntityUpgradeCommand } from "../../upgrade/upgradeCommands.js";
import { authorizeProductV1Reset, previewProductV1Reset } from "../../upgrade/productV1Reset.js";

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
  productV1Reset?: boolean;
  authorization?: string | null;
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

function entityAuthorityConfirmedActive(project: string): boolean {
  try {
    return detectStateMode(project) === "entities";
  } catch {
    return false;
  }
}

export function cmdUpgrade(args: UpgradeArgs, io: Io = {}, dependencies: UpgradeDependencies = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const orchestratorArgs = toOrchestratorArgs(args);

  if (args.productV1Reset) {
    const options = { project: args.project, installRoot: args.installRoot, home: args.home };
    const result = args.yes
      ? authorizeProductV1Reset(options, args.authorization ?? "")
      : previewProductV1Reset(options);
    if (args.format === "json") out(JSON.stringify(result, null, 2) + "\n");
    else if ("deletions" in result) {
      const lines = ["Product-v1 reset preview (no mutation)", `Authorization: ${result.authorization}`, "Roots:"];
      for (const [name, root] of Object.entries(result.roots)) lines.push(`  ${name}: ${root}`);
      lines.push("Deletions:");
      for (const item of result.deletions) for (const target of item.targets) {
        lines.push(`  ${item.id}: ${target.path ?? target.declared}${target.selector ? ` (${target.selector.kind}:${target.selector.value})` : ""}`);
        for (const entry of target.entries ?? []) lines.push(`    ${entry.type}: ${entry.path}`);
      }
      lines.push("Recreations:");
      for (const item of result.recreations) for (const target of item.targets) lines.push(`  ${item.id}: ${target.declared} under ${item.root}`);
      lines.push("Irreversible loss:", ...result.irreversible_loss.map((loss) => `  ${loss}`));
      out(lines.join("\n") + "\n");
    } else out(`Product-v1 reset scope authorized: ${result.authorization}\nNo effects were performed.\n`);
    return 0;
  }

  if (orchestratorArgs.runtime) {
    err(
      `upgrade error: --runtime ${orchestratorArgs.runtime} is retired; Agentera now uses the shared skill at ` +
      "~/.agents/skills/agentera plus the CLI. Remove --runtime and rerun. " +
      "For explicit Agentera-owned native resource cleanup, use --legacy-cleanup RESOURCE_ID.\n",
    );
    return 2;
  }

  if (orchestratorArgs.yes && orchestratorArgs.dryRun) {
    err("upgrade error: --yes and --dry-run are mutually exclusive\n");
    return 2;
  }

  if (orchestratorArgs.yes && orchestratorArgs.only?.length) {
    err(`upgrade error: --only is preview-only; apply must run as one full upgrade --yes\nRecovery: ${fullEntityUpgradeCommand(path.resolve(args.project ?? process.cwd()))}\n`);
    return 2;
  }

  if (
    orchestratorArgs.legacyCleanup
    && orchestratorArgs.only
    && orchestratorArgs.only.length > 0
  ) {
    err("upgrade error: --only cannot be combined with --legacy-cleanup; cleanup preview must include the complete app phase\n");
    return 2;
  }

  if (args.verify && orchestratorArgs.dryRun) {
    err("upgrade error: --verify cannot be combined with --dry-run\n");
    return 2;
  }

  if (args.verify && !orchestratorArgs.yes && (
    orchestratorArgs.legacyCleanup
  )) {
    err("upgrade error: legacy cleanup with --verify requires --yes; preview cleanup with --dry-run instead\n");
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
          } else if (!entityAuthorityConfirmedActive(preview.project)) {
            err(`upgrade error: v2-to-v3 preflight failed: ${applyError}. Recover the tracked v2 checkout with Git and retry.\n`);
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
    if (exc instanceof UpgradeLockError) {
      err(`upgrade error: ${exc.message}\n`);
    } else if (fullEntityCutoverApply) {
      err(`upgrade error: ${(exc as Error).message}. Rerun the same upgrade command to continue forward.\n`);
    } else {
      err(`upgrade error: ${(exc as Error).message}\n`);
    }
    return 2;
  }

  if (fullEntityCutoverApply) {
    const applyExit = upgradeExitCode(plan);
    const verification = (dependencies.verifyOneWayUpgrade ?? verifyOneWayUpgrade)(toVerifyContext(args));
    const authorityActive = entityAuthorityConfirmedActive(plan.project);
    const verificationPassed = verification.state_validation.status === "passed"
      && verification.startup_validation.status === "passed";
    out(renderOneWayResult(verification, applyExit === 0 && authorityActive, (args.format ?? "text") === "json"));
    if (applyExit !== 0 || !authorityActive || !verificationPassed) {
      if (!authorityActive) {
        err("Recover the tracked v2 checkout with Git and retry; no v3 authority was activated.\n");
      } else {
        const unresolved = plan.phases
          .filter((phase) => ["runtime", "cleanup", "lifecycle"].includes(phase.name))
          .flatMap((phase) => phase.items)
          .find((item) => item.status === "blocked" || item.status === "failed");
        if (unresolved) {
          const unresolvedPath = unresolved.source ?? unresolved.target ?? unresolved.action;
          err(`action-required after entity activation: ${unresolvedPath}: ${unresolved.message}. Rerun the same upgrade command to continue forward.\n`);
        } else {
          err("Rerun the same upgrade command to continue forward; verification is read-only and no completed effect was reversed.\n");
        }
      }
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
import path from "node:path";
