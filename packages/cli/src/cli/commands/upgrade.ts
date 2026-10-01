import { buildUpgradePlan, renderUpgradePlan, sortKeysDeep, upgradeExitCode, validateUpgradeApply, type UpgradeOrchestratorArgs, type UpgradeOnlyPhase } from "../../upgrade/upgradeOrchestrator.js";
import { renderVerifySummary, verifyOneWayUpgrade, verifyUpgrade, type OneWayUpgradeVerification, type VerifyContext } from "./upgradeVerify.js";
import { detectStateMode } from "../../state/stateMode.js";
import { readProjectFileSnapshot } from "../../state/safeProjectFile.js";
import { validateRealProjectRoot } from "../../state/projectRoot.js";
import { ENTITY_MODE_MARKER } from "../../state/entityCutover.js";
import { UpgradeLockError } from "../../upgrade/upgradeLock.js";
import { fullEntityUpgradeCommand } from "../../upgrade/upgradeCommands.js";
import { applyProductV1Reset, previewProductV1Reset, type ProductV1ResetPreview } from "../../upgrade/productV1Reset.js";
import os from "node:os";
import { expanduser, resolvePath } from "../../core/paths.js";
import { resolveDoctorInstallRoot, resolveSourceRootStrict } from "../../upgrade/appModel.js";
import { runHostSkillLifecycle } from "../../setup/hostSkillLifecycle.js";
import { emitInvalidInput } from "../errors.js";
import { diagnoseRetiredResources } from "../../upgrade/retiredResourceDiagnostics.js";
import { commandText } from "../../upgrade/upgradeCommands.js";
import { projectMigrationOffer, renderProjectMigrationOffer, hasProjectMigrationCheckpoint, ProjectMigrationApprovalError } from "../../upgrade/projectMigrationOffer.js";

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
  sharedSkill?: boolean;
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
    cleanupAuthorization: args.legacyCleanup ? (args.authorization ?? null) : null,
    migrationAuthorization: !args.legacyCleanup && !args.productV1Reset ? args.authorization : null,
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

function renderOneWayResult(verification: OneWayUpgradeVerification, applyPassed: boolean, json: boolean, authorityActive = true): string {
  const verificationPassed = authorityActive && verification.state_validation.status === "passed" && verification.startup_validation.status === "passed";
  const result = {
    phase: applyPassed ? (verificationPassed ? "complete" : "verification") : "apply",
    startup_validation: verification.startup_validation,
    state_validation: verification.state_validation,
    status: applyPassed && verificationPassed ? "success" : "failed",
  };
  if (json) return JSON.stringify(result, null, 2) + "\n";
  return result.status === "success" ? "Agentera upgraded this project from v2 to v3; state and startup validation passed.\n" : "Agentera could not verify the v2-to-v3 upgrade.\n";
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
  if (args.authorization?.startsWith("project-migration:") && (args.sharedSkill || args.productV1Reset || args.legacyCleanup || args.installRoot || args.only?.length || args.force || args.runtime || args.channel !== "development")) {
    const failure = new ProjectMigrationApprovalError();
    if (args.format === "text") err(`upgrade error: ${failure.message}\n`);
    else
      out(
        JSON.stringify({
          status: "non_success",
          phase: "preflight",
          error: { class: "stale_operation", message: failure.message },
          migration_effects_performed: false,
        }) + "\n",
      );
    return 1;
  }
  if (args.sharedSkill) {
    if (args.project || args.channel || args.expectedVersion || args.only?.length || args.force || args.runtime || args.legacyCleanup || args.verify || args.productV1Reset || (args.yes && args.dryRun)) {
      return emitInvalidInput(io, {
        format: args.format === "text" ? "text" : "json",
        body: {
          class: "invalid_request",
          message:
            "--shared-skill is isolated from app/project migration, reset and cleanup. Use --dry-run (or omit apply flags) for preview, or --yes with explicit user approval. Legacy conversion also requires the preview's --authorization token; only --home, --install-root, --authorization and --format may be combined.",
        },
      });
    }
    const home = resolvePath(expanduser(args.home ?? os.homedir()));
    const sourceRoot = resolveSourceRootStrict();
    const [appHome] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
    const result = runHostSkillLifecycle({
      home,
      appHome,
      sourceRoot,
      apply: args.yes === true,
      authorization: args.authorization,
    });
    out(args.format === "text" ? `${result.status}: ${result.reason}\nPath: ${result.path}\n${"authorization" in result ? JSON.stringify(result, null, 2) + "\n" : ""}Recovery: ${result.recovery}\n` : JSON.stringify(result, null, 2) + "\n");
    return result.status === "non_success" ? 1 : 0;
  }
  if (args.authorization && !args.productV1Reset && !args.legacyCleanup && !args.authorization.startsWith("project-migration:"))
    return emitInvalidInput(io, {
      format: args.format === "text" ? "text" : "json",
      body: {
        class: "invalid_request",
        message: "--authorization must come from the matching shared-skill, reset, cleanup or project-migration offer.",
      },
    });
  const orchestratorArgs = toOrchestratorArgs(args);
  if (args.yes && !args.authorization && !args.productV1Reset && !args.legacyCleanup && hasProjectMigrationCheckpoint(args.project ?? process.cwd())) {
    err("upgrade error: this project has a bound migration checkpoint. Resume the unchanged approved command only under known approval; do not infer permission from the checkpoint or --yes alone.\n");
    return 1;
  }

  if (args.productV1Reset) {
    const options = { project: args.project, installRoot: args.installRoot, home: args.home };
    const result = args.yes ? applyProductV1Reset(options, args.authorization ?? "") : previewProductV1Reset(options);
    const preview = !args.yes ? (result as ProductV1ResetPreview) : null;
    const applyCommand = preview ? commandText(["npx", "-y", "agentera@next", "upgrade", "--reset-product-v1", "--project", preview.roots.project!, "--home", preview.roots.runtime_home!, "--install-root", preview.roots.install_root!, "--yes", "--authorization", preview.authorization, "--format", "json"]) : null;
    const question = "This permanently deletes every listed reset target, including any current data within those scopes, then recreates fresh v3 state. There is no backup or undo. Apply exactly this reset?";
    if (args.format === "json") out(JSON.stringify(preview ? { ...preview, approval: "explicit_yes_only", question, apply_command: applyCommand } : result, null, 2) + "\n");
    else if ("deletions" in result) {
      const lines = ["Product-v1 reset preview (no mutation)", `Authorization: ${result.authorization}`, "Roots:"];
      for (const [name, root] of Object.entries(result.roots)) lines.push(`  ${name}: ${root}`);
      lines.push("Deletions:");
      for (const item of result.deletions)
        for (const target of item.targets) {
          lines.push(`  ${item.id}: ${target.path ?? target.declared}${target.selector ? ` (${target.selector.kind}:${target.selector.value})` : ""}`);
          for (const entry of target.entries ?? []) lines.push(`    ${entry.type}: ${entry.path}`);
        }
      lines.push("Recreations:");
      for (const item of result.recreations) for (const target of item.targets) lines.push(`  ${item.id}: ${target.declared} under ${item.root}`);
      lines.push("Irreversible loss:", ...result.irreversible_loss.map((loss) => `  ${loss}`));
      lines.push("", `Question: ${question}`, `Apply only after explicit Yes: ${applyCommand}`);
      out(lines.join("\n") + "\n");
    } else out(`Product-v1 reset complete: ${result.authorization}\nFresh v3 state initialized.\n`);
    return 0;
  }

  if (orchestratorArgs.runtime) {
    err(`upgrade error: --runtime ${orchestratorArgs.runtime} is retired; Agentera now uses the shared skill at ` + "~/.agents/skills/agentera plus the CLI. Remove --runtime and rerun. " + "For explicit Agentera-owned native resource cleanup, use --legacy-cleanup RESOURCE_ID.\n");
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

  if (orchestratorArgs.legacyCleanup && orchestratorArgs.only && orchestratorArgs.only.length > 0) {
    err("upgrade error: --only cannot be combined with --legacy-cleanup; cleanup preview must include the complete app phase\n");
    return 2;
  }

  if (args.verify && orchestratorArgs.dryRun) {
    err("upgrade error: --verify cannot be combined with --dry-run\n");
    return 2;
  }

  if (args.verify && !orchestratorArgs.yes && orchestratorArgs.legacyCleanup) {
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
  let fullEntityCutoverApply = Boolean(orchestratorArgs.yes && orchestratorArgs.migrationAuthorization);
  try {
    if (orchestratorArgs.yes && !orchestratorArgs.migrationAuthorization) {
      const preview = buildUpgradePlan({ ...orchestratorArgs, yes: false });
      fullEntityCutoverApply = !orchestratorArgs.only && (preview.crossMajorBoundary || preview.phases.some((phase) => phase.name === "entities" && phase.items.some((item) => item.action === "entity-cutover" && item.status === "pending")));
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
    if (orchestratorArgs.yes && orchestratorArgs.migrationAuthorization) fullEntityCutoverApply = true;
  } catch (exc) {
    if (exc instanceof ProjectMigrationApprovalError) {
      if (args.format === "json")
        out(
          JSON.stringify({
            status: "non_success",
            phase: "preflight_or_forward_recovery",
            error: { class: "stale_operation", message: exc.message },
            effects_after_refusal: false,
          }) + "\n",
        );
      else err(`upgrade error: ${exc.message}\n`);
      return 1;
    }
    if (exc instanceof UpgradeLockError) {
      err(`upgrade error: ${exc.message}\n`);
    } else if (fullEntityCutoverApply) {
      err(`upgrade error: ${(exc as Error).message}. Rerun the same upgrade command to continue forward.\n`);
    } else {
      err(`upgrade error: ${(exc as Error).message}\n`);
    }
    if (orchestratorArgs.migrationAuthorization && args.format === "json")
      out(
        JSON.stringify({
          status: "non_success",
          phase: "apply_or_forward_recovery",
          error: {
            class: "operation_incomplete",
            message: "The approved migration stopped at a publication or validation boundary.",
          },
          recovery: "Preserve the actual project and checkpoint. Correct only the reported conflict, then resume the original unchanged command under known approval; unexpected changes require fresh preview and approval.",
        }) + "\n",
      );
    return 2;
  }

  if (fullEntityCutoverApply) {
    const applyExit = upgradeExitCode(plan);
    const verification = (dependencies.verifyOneWayUpgrade ?? verifyOneWayUpgrade)(toVerifyContext(args));
    const authorityActive = entityAuthorityConfirmedActive(plan.project);
    const markerPresent = authorityActive || readProjectFileSnapshot(validateRealProjectRoot(plan.project), ENTITY_MODE_MARKER).kind === "file";
    const verificationPassed = verification.state_validation.status === "passed" && verification.startup_validation.status === "passed";
    out(renderOneWayResult(verification, applyExit === 0 && markerPresent, (args.format ?? "text") === "json", authorityActive));
    if (applyExit !== 0 || !authorityActive || !verificationPassed) {
      if (!authorityActive) {
        const unresolved = plan.phases.flatMap((phase) => phase.items).find((item) => item.status === "blocked" || item.status === "failed");
        if (unresolved) err(`Action required: ${unresolved.action}: ${unresolved.message.slice(0, 512)}\n`);
        const marker = readProjectFileSnapshot(validateRealProjectRoot(plan.project), ENTITY_MODE_MARKER);
        err(marker.kind === "file" ? "An authority marker exists but project verification failed. Preserve the project and checkpoint; diagnose the reported state and continue forward only under the matching known approval.\n" : "Recover the tracked v2 checkout with Git and retry; no v3 authority was activated.\n");
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
    let remainingCleanup: Record<string, unknown> | undefined;
    if (orchestratorArgs.legacyCleanup && orchestratorArgs.cleanupAuthorization && orchestratorArgs.yes) {
      const recoveryCommand = commandText(["npx", "-y", "agentera@next", "doctor", "--home", plan.home, "--project", plan.project, "--install-root", plan.appHome, "--format", "json"]);
      try {
        const diagnosis = diagnoseRetiredResources({
          home: plan.home,
          project: plan.project,
          installRoot: plan.appHome,
          sourceRoot: resolveSourceRootStrict(),
        });
        remainingCleanup = {
          status: diagnosis.status,
          resources: diagnosis.resources.map((resource) => ({
            id: resource.id,
            evidence: resource.evidence,
          })),
          omitted_resource_count: diagnosis.omittedResourceCount,
          recovery_command: recoveryCommand,
        };
      } catch (error) {
        remainingCleanup = {
          status: "unavailable",
          reason: (error as Error).message,
          recovery_command: recoveryCommand,
        };
      }
    }
    const offer = !orchestratorArgs.yes ? projectMigrationOffer(orchestratorArgs, plan) : null;
    out(
      JSON.stringify(
        sortKeysDeep({
          ...plan,
          ...(offer ? { migration_offer: offer } : {}),
          ...(remainingCleanup ? { remaining_cleanup: remainingCleanup } : {}),
        }),
        null,
        2,
      ) + "\n",
    );
  } else {
    out(renderUpgradePlan(plan));
    if (!orchestratorArgs.yes) out(renderProjectMigrationOffer(projectMigrationOffer(orchestratorArgs, plan)));
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
