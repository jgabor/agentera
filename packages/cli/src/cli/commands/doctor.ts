import os from "node:os";

import { expanduser, resolvePath } from "../../core/paths.js";
import { pyJsonIndentSorted } from "../../core/pyjson.js";
import {
  resolveDoctorInstallRoot,
  resolveSourceRootStrict,
} from "../../upgrade/appModel.js";
import { runNpmSmokeChecks } from "../../setup/smokeChecks.js";
import type { JsonObject } from "../../core/jsonValue.js";
import type { BundleStatus } from "../contracts/bundleStatus.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  appLifecycleActionNoun,
  buildDoctorStatus,
  EXPECTED_STATE_COMMANDS,
  doctorParityJsonEnvelope,
} from "../../upgrade/doctor.js";
import { classifyInstall } from "../../upgrade/compatibility.js";
import type { UpdateChannelName } from "../../upgrade/channels.js";
import {
  prependNextMajorDoctorSection,
  resolveNextMajorDoctorLines,
} from "../../upgrade/nextMajorDoctor.js";
import { emitStructured } from "../structured.js";
import { diagnoseCanonicalSkill } from "../../setup/sharedSkill.js";
import { diagnoseRetiredResources, type RetiredResourceDiagnosis } from "../../upgrade/retiredResourceDiagnostics.js";
import { commandText } from "../../upgrade/upgradeCommands.js";
import { inspectTodoReconciliationState } from "../../state/todoReconciliationInspection.js";
import { classifyAutomaticRetirement } from "../../runtime/nativeResourceCleanup.js";
import { lifecycleOwnershipJournalPath } from "../../runtime/lifecycleOwnershipJournal.js";

/**
 * `agentera doctor` — app/runtime status. Port of agentera_upgrade.cmd_doctor +
 * render_doctor_status. build_doctor_status is reused (upgrade/doctor.ts). The
 * upgrade/retry command strings use the TS invocation form (npx/node), which
 * is the intended runtime form rather than Python's `uv run`.
 */

type Io = { out?: (t: string) => void; err?: (t: string) => void };

const PLAIN_STATUS: Record<string, string> = {
  pending: "ready to fix",
  applied: "fixed",
  noop: "already OK",
  blocked: "needs a decision",
  failed: "failed",
  skipped: "skipped",
  [APP_UP_TO_DATE]: "up to date",
  [APP_REPAIR_NEEDED]: "needs repair",
  [APP_OUTDATED]: "outdated",
  [APP_MIGRATION_NEEDED]: "needs migration",
  [APP_MANUAL_REVIEW_NEEDED]: "needs manual review",
};

function plainStatus(value: string): string {
  return PLAIN_STATUS[value] ?? value.replace(/_/g, " ").replace(/-/g, " ");
}

function previewCommand(
  resource: RetiredResourceDiagnosis["resources"][number],
  context: { home: string; project: string; installRoot: string },
): string {
  return commandText([
    "npx",
    "-y",
    "agentera@next",
    "doctor",
    "--home",
    context.home,
    "--project",
    context.project,
    "--install-root",
    context.installRoot,
    "--retired-resource",
    resource.id,
    "--format",
    "json",
  ]);
}

function doctorRetiredResources(
  diagnosis: RetiredResourceDiagnosis,
  context: { home: string; project: string; installRoot: string },
): Record<string, unknown> {
  return {
    ...diagnosis,
    resources: diagnosis.resources.map((resource) => {
      const qualification = classifyAutomaticRetirement(
        resource.id,
        resource.evidence.paths[0]!,
        lifecycleOwnershipJournalPath(context.installRoot),
      );
      if (qualification.qualification === "qualified") {
        return {
          id: resource.id,
          status: "pending_automatic_removal",
          evidence: resource.evidence,
          next_action: commandText([
            "npx", "-y", "agentera@next", "upgrade", "--channel", "development",
            "--project", context.project, "--install-root", context.installRoot, "--dry-run",
          ]),
        };
      }
      return {
        id: resource.id,
        status: "manual_review",
        evidence: resource.evidence,
        preview_command: previewCommand(resource, context),
      };
    }),
  };
}

export function renderDoctorStatus(status: BundleStatus, retiredResources?: Record<string, unknown>): string {
  const actionNoun = appLifecycleActionNoun(String(status.status));
  const lines = [
    "Agentera doctor",
    `status: ${plainStatus(status.status)}`,
    `expected version: ${status.expectedVersion}`,
    `Agentera directory: ${status.appHome}`,
    `App files directory: ${status.managedAppRoot}`,
    `Your Agentera data directory: ${status.userDataRoot}`,
  ];
  if (status.signals && status.signals.length > 0) {
    lines.push("");
    lines.push("What needs attention:");
    for (const signal of status.signals) {
      lines.push(`  - ${plainStatus(signal.status)}: ${signal.message}`);
      if (signal.missingCommands && signal.missingCommands.length > 0) {
        lines.push(`    Missing command: ${signal.missingCommands.join(", ")}`);
      }
      if (signal.kind === "todo_reconciliation") {
        if (signal.reconciliationState) lines.push(`    Reconciliation state: ${signal.reconciliationState}`);
        if (signal.reconciliationCounts) {
          const counts = ["matched", "converted", "retained", "duplicate", "stale", "conflicting"]
            .filter((name) => name in signal.reconciliationCounts!)
            .map((name) => `${name}=${signal.reconciliationCounts![name]}`)
            .join(" | ");
          lines.push(`    Counts: ${counts} | omitted=${String(signal.reconciliationOmittedCount ?? 0)}`);
        }
        if (signal.previewCommand) lines.push(`    Preview: ${signal.previewCommand}`);
        if (signal.applyCommand) lines.push(`    Apply: ${signal.applyCommand}`);
        if (signal.reconciliationState === "unsafe_inactive" && signal.recoveryCommand) lines.push(`    Recovery: ${signal.recoveryCommand}`);
      }
    }
  }
  const resources = Array.isArray(retiredResources?.resources) ? retiredResources.resources as Array<Record<string, unknown>> : [];
  const todoReconciliation = status.signals?.some((signal) => signal.kind === "todo_reconciliation") ?? false;
  const unsafeInactiveTodo = status.signals?.some((signal) => signal.kind === "todo_reconciliation" && signal.reconciliationState === "unsafe_inactive") ?? false;
  if (resources.length > 0) {
    lines.push("");
    lines.push("Retired native resources:");
    for (const resource of resources) {
      lines.push(`  - action required: ${String(resource.id)}`);
      lines.push(`    Preview: ${String(resource.preview_command)}`);
    }
  }
  if (status.status === APP_UP_TO_DATE) {
    lines.push("");
    lines.push("No action needed: Agentera app files are up to date.");
  } else if (status.dryRunCommand) {
    lines.push("");
    lines.push("Next:");
    lines.push(`  1. Preview the ${actionNoun}: ${status.dryRunCommand}`);
    lines.push(`  2. If the preview looks right, apply the ${actionNoun}: ${status.applyCommand}`);
    if (status.retryCommand) {
      lines.push(`  3. Then retry Agentera: ${status.retryCommand}`);
    } else {
      lines.push(
        "  3. Then retry Agentera once a retry command is available.",
      );
    }
  } else if (unsafeInactiveTodo) {
    lines.push("");
    lines.push("Next: supply the complete owner mapping, preview the reported correction, then use its exact apply_command.");
  } else if (todoReconciliation) {
    lines.push("");
    lines.push("Next: run the reported TODO reconciliation preview, review its bounded effect, then use its exact apply_command.");
  } else if (resources.length > 0) {
    lines.push("");
    lines.push("Next: review each read-only retirement preview before any explicit cleanup.");
  } else {
    lines.push("");
    lines.push(
      "Next: choose a safer Agentera directory, or use `--force` only after checking the directory is safe to replace.",
    );
  }
  return lines.join("\n");
}

export interface DoctorArgs {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  expectedVersion?: string | null;
  expectCommand?: string[] | null;
  retiredResource?: string | null;
  smoke?: boolean;
  allowLiveModel?: boolean;
  format?: string;
}

function renderDoctorSmoke(smoke: JsonObject): string {
  const lines = [
    "",
    "Smoke checks:",
    `  enabled: ${smoke.enabled ? "yes" : "no"}`,
    `  model calls attempted: ${smoke.modelCallsAttempted ? "yes" : "no"}`,
  ];
  for (const check of (smoke.checks ?? []) as JsonObject[]) {
    lines.push(`  - ${check.name}: ${check.status} - ${check.message}`);
  }
  return lines.join("\n");
}

export function cmdDoctor(args: DoctorArgs, io: Io = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let sourceRoot: string;
  try {
    sourceRoot = resolveSourceRootStrict();
  } catch (exc) {
    err(`doctor error: ${(exc as Error).message}\n`);
    return 2;
  }
  const home = resolvePath(expanduser(args.home ?? os.homedir()));
  const project = resolvePath(expanduser(args.project ?? process.cwd()));
  const [installRoot, rootSource] = resolveDoctorInstallRoot(args.installRoot ?? null, { home, sourceRoot });
  const expectedCommands = args.expectCommand && args.expectCommand.length > 0 ? args.expectCommand : [...EXPECTED_STATE_COMMANDS];
  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project,
    expectedVersion: args.expectedVersion ?? null,
    expectedCommands,
  });
  const todoReconciliation = inspectTodoReconciliationState(project, sourceRoot);
  if (todoReconciliation?.status === "action_required") {
    status.signals.push({
      status: APP_MANUAL_REVIEW_NEEDED,
      kind: "todo_reconciliation",
      message: `action-required: TODO reconciliation is ${todoReconciliation.state === "inactive" ? "inactive" : todoReconciliation.state === "unsafe_inactive" ? "unsafe inactive" : todoReconciliation.state === "unsafe_active" ? "unsafe active" : "in an invalid lifecycle state"}`,
      reconciliationState: todoReconciliation.state,
      reconciliationCounts: todoReconciliation.counts,
      reconciliationOmittedCount: todoReconciliation.omitted_count,
      ...(todoReconciliation.risks ? { reconciliationRisks: todoReconciliation.risks } : {}),
      previewCommand: todoReconciliation.preview_command,
      applyCommand: todoReconciliation.apply_command,
      recoveryCommand: todoReconciliation.recovery_command,
    });
    if (status.status === APP_UP_TO_DATE) status.status = APP_MANUAL_REVIEW_NEEDED;
  }
  const retiredDiagnosis = diagnoseRetiredResources({
    home,
    project,
    installRoot,
    resourceId: args.retiredResource ?? null,
  });
  const retiredResources = doctorRetiredResources(retiredDiagnosis, { home, project, installRoot });
  const retiredResourceEntries = retiredResources.resources as Array<{ id: string; status: string }>;
  const manualReviewResources = retiredResourceEntries.filter((resource) => resource.status === "manual_review");
  const pendingAutomaticResources = retiredResourceEntries.filter((resource) => resource.status === "pending_automatic_removal");
  if (manualReviewResources.length > 0) {
    status.signals.push({
      status: APP_MANUAL_REVIEW_NEEDED,
      kind: "retired_native_resources",
      message: "retired native resource candidates need ownership review before cleanup",
      resourceIds: manualReviewResources.map((resource) => resource.id),
      omittedResourceCount: retiredDiagnosis.omittedResourceCount,
    });
    if (status.status === APP_UP_TO_DATE) status.status = APP_MANUAL_REVIEW_NEEDED;
  }
  if (pendingAutomaticResources.length > 0) {
    status.signals.push({
      status: APP_REPAIR_NEEDED,
      kind: "retired_native_resources_pending_automatic_removal",
      message: "proven retired OpenCode plugin is pending automatic removal by normal upgrade",
      resourceIds: pendingAutomaticResources.map((resource) => resource.id),
    });
    if (status.status === APP_UP_TO_DATE) status.status = APP_REPAIR_NEEDED;
  }
  const sharedSkill = diagnoseCanonicalSkill(home);
  let smokeReport: JsonObject | null = null;
  if (args.smoke) {
    smokeReport = runNpmSmokeChecks(sourceRoot, process.env, {
      liveModelAllowed: Boolean(args.allowLiveModel),
    }) as JsonObject;
  }
  if ((args.format ?? "text") === "json") {
    const payload = doctorParityJsonEnvelope(status);
    payload.shared_skill = sharedSkill;
    payload.retired_resources = retiredResources;
    if (smokeReport) payload.smoke = smokeReport;
    out(pyJsonIndentSorted(payload) + "\n");
  } else {
    const install = classifyInstall({ appHome: installRoot, sourceRoot });
    const nextMajorLines = resolveNextMajorDoctorLines({
      sourceRoot,
      home,
      channel: (status.updateChannel as UpdateChannelName | undefined) ?? null,
      install,
      env: process.env,
    });
    const body =
      prependNextMajorDoctorSection(renderDoctorStatus(status, retiredResources), nextMajorLines) +
      `\nShared skill\n  ${String(sharedSkill.status)}: ${String(sharedSkill.message)}\n  path: ${String(sharedSkill.path)}\n` +
      (smokeReport ? renderDoctorSmoke(smokeReport) : "");
    out(body + "\n");
  }
  if (args.smoke) {
    const failCount = Number((smokeReport?.summary as JsonObject | undefined)?.fail ?? 0);
    if (failCount > 0) return 1;
  }
  return status.status === APP_UP_TO_DATE && sharedSkill.status === "pass" ? 0 : 1;
}
