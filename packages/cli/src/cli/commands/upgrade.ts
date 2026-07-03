import os from "node:os";

import { expanduser, resolvePath } from "../../core/paths.js";
import { resolveDoctorInstallRoot, resolveSourceRootStrict } from "../../upgrade/appModel.js";
import {
  buildUpgradePlan,
  renderUpgradePlan,
  sortKeysDeep,
  upgradeExitCode,
  validateUpgradeApply,
  type UpgradeOrchestratorArgs,
  type UpgradeOnlyPhase,
} from "../../upgrade/upgradeOrchestrator.js";
import { restoreFromSnapshot } from "../../upgrade/upgradeSnapshot.js";
import {
  renderRestoreSummary,
  renderVerifySummary,
  verifyUpgrade,
  type VerifyContext,
} from "./upgradeVerify.js";

type Io = { out?: (t: string) => void; err?: (t: string) => void };

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
  verify?: boolean;
  restore?: boolean;
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

export function cmdUpgrade(args: UpgradeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const orchestratorArgs = toOrchestratorArgs(args);

  if (orchestratorArgs.yes && orchestratorArgs.dryRun) {
    err("upgrade error: --yes and --dry-run are mutually exclusive\n");
    return 2;
  }

  if (args.restore && (orchestratorArgs.yes || orchestratorArgs.dryRun || args.verify)) {
    err("upgrade error: --restore is mutually exclusive with --yes, --dry-run, and --verify\n");
    return 2;
  }

  if (args.verify && orchestratorArgs.dryRun) {
    err("upgrade error: --verify cannot be combined with --dry-run\n");
    return 2;
  }

  if (args.restore) {
    let installRoot: string;
    try {
      const sourceRoot = resolveSourceRootStrict();
      const home = resolvePath(expanduser(args.home ?? os.homedir()));
      [installRoot] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
    } catch (exc) {
      err(`upgrade error: ${(exc as Error).message}\n`);
      return 2;
    }
    const result = restoreFromSnapshot(installRoot);
    out(renderRestoreSummary(installRoot, result));
    return 0;
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
  try {
    if (orchestratorArgs.yes) {
      const preview = buildUpgradePlan({ ...orchestratorArgs, yes: false });
      const applyError = validateUpgradeApply(orchestratorArgs, preview);
      if (applyError) {
        err(`upgrade error: ${applyError}\n`);
        return 1;
      }
    }
    plan = buildUpgradePlan(orchestratorArgs);
  } catch (exc) {
    err(`upgrade error: ${(exc as Error).message}\n`);
    return 2;
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
