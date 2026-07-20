import {
  appendLifecycleOwnershipJournal,
  lifecycleOwnershipJournalPath,
  readLifecycleOwnershipJournal,
  type LifecycleOwnershipJournalRead,
} from "../runtime/lifecycleOwnershipJournal.js";
import { secureLifecycleRemovalAvailable } from "../runtime/lifecyclePublication.js";
import {
  applyRetiredRuntimeCleanup,
  previewRetiredRuntimeCleanup,
  type RetiredRuntimeCleanupPreview,
  type RetiredRuntimeCleanupResult,
} from "../runtime/retiredRuntimeCleanup.js";
import type {
  LifecycleApplyOptions,
  LifecycleApplySummary,
  LifecycleOperationPlan,
} from "../runtime/lifecycleOperations.js";

export const LIFECYCLE_UPGRADE_SCHEMA = "agentera.lifecycleUpgrade.v1" as const;

export interface LifecycleRetiredSummary extends LifecycleApplySummary {
  pending: number;
}

export interface LifecycleUpgradeResult {
  schemaVersion: typeof LIFECYCLE_UPGRADE_SCHEMA;
  mode: "preview" | "apply";
  status: "noop" | "pending" | "success" | "non_success";
  approval: "not_requested" | "approved";
  platform: {
    securePublication: boolean;
    requirement: "linux_proc_self_fd";
  };
  ownershipJournal: LifecycleOwnershipJournalRead;
  retiredCleanup: RetiredRuntimeCleanupPreview | RetiredRuntimeCleanupResult;
  retiredSummary: LifecycleRetiredSummary;
  requiredUnmet: string[];
}

export interface LifecycleUpgradeArgs {
  home: string;
  appHome: string;
  apply: boolean;
  retiredCleanup: "claude";
}

export interface LifecycleUpgradeApplyOptions extends LifecycleApplyOptions {}

function emptySummary(): LifecycleRetiredSummary {
  return {
    applied: 0,
    noop: 0,
    failed: 0,
    blocked_unowned: 0,
    skipped_dependency: 0,
    action_required: 0,
    pending: 0,
  };
}

function previewSummary(preview: RetiredRuntimeCleanupPreview): LifecycleRetiredSummary {
  const summary = emptySummary();
  for (const operation of preview.plan.operations) {
    if (operation.action === "noop") summary.noop += 1;
    else if (operation.action === "blocked_unowned") summary.blocked_unowned += 1;
    else if (operation.action === "action_required") summary.action_required += 1;
    else summary.pending += 1;
  }
  return summary;
}

function resultSummary(result: RetiredRuntimeCleanupResult): LifecycleRetiredSummary {
  return { ...result.summary, pending: 0 };
}

function blockedPlan(plan: LifecycleOperationPlan, reason: string): LifecycleOperationPlan {
  return {
    ...plan,
    operations: plan.operations.map((operation) => operation.action === "noop"
      ? operation
      : { ...operation, action: "action_required", reason }),
  };
}

function journalBlocksMutation(journal: LifecycleOwnershipJournalRead): boolean {
  return !["absent", "clean"].includes(journal.state);
}

function journalBlocker(journal: LifecycleOwnershipJournalRead): string {
  const diagnostics = journal.diagnostics
    .map((diagnostic) => diagnostic.replace(/^\d{20}-[0-9a-f-]{36}\.json:\s*/i, ""));
  return `ownership journal is ${journal.state}: ${diagnostics.join("; ")}`;
}

function statusFor(
  mode: "preview" | "apply",
  summary: LifecycleRetiredSummary,
  requiredUnmet: string[],
): LifecycleUpgradeResult["status"] {
  if (
    summary.failed > 0
    || summary.blocked_unowned > 0
    || summary.skipped_dependency > 0
    || summary.action_required > 0
    || requiredUnmet.length > 0
  ) return "non_success";
  if (mode === "preview" && summary.pending > 0) return "pending";
  if (mode === "apply" && summary.applied > 0) return "success";
  return "noop";
}

/** Preview or apply the one explicit ownership-proven retired Claude cleanup. */
export function runLifecycleUpgrade(
  args: LifecycleUpgradeArgs,
  options: LifecycleUpgradeApplyOptions = {},
): LifecycleUpgradeResult {
  const journal = readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(args.appHome));
  let preview = previewRetiredRuntimeCleanup({
    runtimeId: args.retiredCleanup,
    home: args.home,
    ledger: journal.ledger,
  });
  if (journalBlocksMutation(journal)) {
    const reason = journalBlocker(journal);
    preview = {
      ...preview,
      ledgerAuthorization: "blocked",
      ledgerDiagnostics: [...preview.ledgerDiagnostics, reason],
      plan: blockedPlan(preview.plan, reason),
    };
  }

  let outputJournal = journal;
  let retiredCleanup: RetiredRuntimeCleanupPreview | RetiredRuntimeCleanupResult = preview;
  let retiredSummary = previewSummary(preview);
  if (args.apply && !journalBlocksMutation(journal)) {
    retiredCleanup = applyRetiredRuntimeCleanup(preview, {
      ...options,
      approved: true,
      persistLedger(ledger) {
        appendLifecycleOwnershipJournal(journal.path, ledger);
      },
    });
    retiredSummary = resultSummary(retiredCleanup);
    outputJournal = readLifecycleOwnershipJournal(journal.path);
  }

  const requiredUnmet = "plan" in retiredCleanup
    ? retiredCleanup.plan.operations
      .filter((operation) => operation.required && operation.action !== "noop")
      .map((operation) => operation.id)
    : retiredCleanup.requiredUnmet;
  const mode = args.apply ? "apply" : "preview";
  return {
    schemaVersion: LIFECYCLE_UPGRADE_SCHEMA,
    mode,
    status: statusFor(mode, retiredSummary, requiredUnmet),
    approval: args.apply ? "approved" : "not_requested",
    platform: {
      securePublication: secureLifecycleRemovalAvailable(),
      requirement: "linux_proc_self_fd",
    },
    ownershipJournal: outputJournal,
    retiredCleanup,
    retiredSummary,
    requiredUnmet,
  };
}
