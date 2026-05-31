import {
  buildUpgradePlan,
  renderUpgradePlan,
  sortKeysDeep,
  upgradeExitCode,
  validateUpgradeApply,
  type UpgradeOrchestratorArgs,
  type UpgradeOnlyPhase,
} from "../../upgrade/upgradeOrchestrator.js";

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

export function cmdUpgrade(args: UpgradeArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const orchestratorArgs = toOrchestratorArgs(args);

  if (orchestratorArgs.yes && orchestratorArgs.dryRun) {
    err("upgrade error: --yes and --dry-run are mutually exclusive\n");
    return 2;
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
  return upgradeExitCode(plan);
}

export type { UpgradeOnlyPhase };
