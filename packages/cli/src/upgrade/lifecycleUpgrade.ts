import fs from "node:fs";
import path from "node:path";

import {
  RUNTIME_ADAPTER_CATEGORIES,
  loadRuntimeLifecycleAdapterContract,
  type RuntimeAdapterCategory,
  type RuntimeAdapterResourceDeclaration,
} from "../runtime/lifecycleAdapterContract.js";
import {
  applyLifecycleOperations,
  createLifecycleOwnershipManifest,
  planLifecycleOperations,
  type AppliedLifecycleOperation,
  type LifecycleApplyOptions,
  type LifecycleApplyResult,
  type LifecycleApplySummary,
  type LifecycleOperationPlan,
  type LifecycleOperationSpec,
  type LifecycleOwnershipRecord,
  type PlannedLifecycleOperation,
} from "../runtime/lifecycleOperations.js";
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
import {
  inspectRuntimeLifecycleAdapters,
  type RuntimeAdapterEvidence,
  type RuntimeAdapterInspectionContext,
  type RuntimeAdapterReport,
} from "../runtime/lifecycleAdapters.js";
import {
  projectRuntimeLifecycle,
  summarizeRuntimeLifecycle,
  type RuntimeLifecycleSummary,
} from "../runtime/lifecycleSnapshot.js";

export const LIFECYCLE_UPGRADE_SCHEMA = "agentera.lifecycleUpgrade.v1" as const;
export const ACTIVE_RUNTIME_SELECTORS = ["opencode", "codex", "cursor", "copilot"] as const;
export type ActiveRuntimeSelector = (typeof ACTIVE_RUNTIME_SELECTORS)[number];
export type LifecycleRuntimeSelector = "all" | ActiveRuntimeSelector;

export interface LifecycleUpgradeOwnershipEvidence {
  declaration: "matched";
  journalPath: string;
  journalState: LifecycleOwnershipJournalRead["state"];
  ledgerRecord: Pick<
    LifecycleOwnershipRecord,
    "status" | "scope" | "destination" | "kind" | "fingerprint" | "identity"
  > | null;
}

export interface LifecycleUpgradeOperation {
  id: string;
  runtime: string;
  surface: string;
  category: RuntimeAdapterCategory;
  resource: string;
  destination: string;
  desiredState: "exact" | "missing";
  currentState: PlannedLifecycleOperation["state"];
  ownership: PlannedLifecycleOperation["ownership"];
  ownershipEvidence: LifecycleUpgradeOwnershipEvidence;
  action: PlannedLifecycleOperation["action"];
  dependencies: string[];
  required: boolean;
  optional: boolean;
  blockedReason: string | null;
  remediation: string[];
  evidence: RuntimeAdapterEvidence[];
  outcome: AppliedLifecycleOperation["status"] | null;
  dependencyCauses: string[];
}

export interface LifecycleUpgradeUserAction {
  id: string;
  runtime: string;
  surface: string;
  category: RuntimeAdapterCategory;
  kind: "native" | "manual";
  status: "action_required";
  required: boolean;
  remediation: string;
  command: string | string[] | null;
  instruction: string;
}

export interface LifecycleUpgradeSummary extends LifecycleApplySummary {
  pending: number;
  nativeActionRequired: number;
  manualActionRequired: number;
}

export interface LifecycleRetiredSummary extends LifecycleApplySummary {
  pending: number;
}

export interface LifecycleUpgradeResult {
  schemaVersion: typeof LIFECYCLE_UPGRADE_SCHEMA;
  mode: "preview" | "apply";
  selection: {
    requested: LifecycleRuntimeSelector | "none";
    runtimeIds: ActiveRuntimeSelector[];
  };
  status: "noop" | "pending" | "success" | "non_success";
  approval: "not_requested" | "approved";
  platform: {
    securePublication: boolean;
    requirement: "linux_proc_self_fd";
  };
  ownershipJournal: LifecycleOwnershipJournalRead;
  operations: LifecycleUpgradeOperation[];
  userActions: LifecycleUpgradeUserAction[];
  /** Bounded aggregate projection; operations owns per-resource lifecycle detail. */
  projection: RuntimeLifecycleSummary;
  retiredCleanup: RetiredRuntimeCleanupPreview | RetiredRuntimeCleanupResult | null;
  retiredSummary: LifecycleRetiredSummary | null;
  summary: LifecycleUpgradeSummary;
  requiredUnmet: string[];
}

export interface LifecycleUpgradeArgs {
  selector: LifecycleRuntimeSelector | null;
  home: string;
  project: string;
  sourceRoot: string;
  appHome: string;
  env?: Record<string, string | undefined>;
  canonicalSkillTarget?: string;
  apply: boolean;
  retiredCleanup?: "claude" | null;
}

export interface LifecycleUpgradeApplyOptions extends LifecycleApplyOptions {}

interface BuiltLifecycleUpgrade {
  reports: RuntimeAdapterReport[];
  plan: LifecycleOperationPlan;
  journal: LifecycleOwnershipJournalRead;
  operations: LifecycleUpgradeOperation[];
  userActions: LifecycleUpgradeUserAction[];
  projection: RuntimeLifecycleSummary;
  retiredPreview: RetiredRuntimeCleanupPreview | null;
}

function selectedRuntimeIds(selector: LifecycleRuntimeSelector | null): ActiveRuntimeSelector[] {
  if (selector === null) return [];
  return selector === "all" ? [...ACTIVE_RUNTIME_SELECTORS] : [selector];
}

function lifecycleProjection(
  args: LifecycleUpgradeArgs,
  ledger: LifecycleOwnershipJournalRead["ledger"],
): RuntimeLifecycleSummary {
  const matrix = inspectRuntimeLifecycleAdapters({
    home: args.home,
    project: args.project,
    sourceRoot: args.sourceRoot,
    env: args.env,
    canonicalSkillTarget: args.canonicalSkillTarget,
    ledger,
  } satisfies RuntimeAdapterInspectionContext);
  return summarizeRuntimeLifecycle(projectRuntimeLifecycle(matrix, selectedRuntimeIds(args.selector)));
}

function resourceForOperation(
  operationId: string,
  resources: RuntimeAdapterResourceDeclaration[],
): RuntimeAdapterResourceDeclaration {
  const matches = resources.filter((resource) =>
    operationId === resource.id || operationId.startsWith(`${resource.id}.`),
  ).sort((left, right) => right.id.length - left.id.length);
  if (!matches[0]) throw new Error(`${operationId}: lifecycle operation has no resource declaration`);
  return matches[0];
}

function sameSpec(left: LifecycleOperationSpec, right: LifecycleOperationSpec): boolean {
  const leftContent = Buffer.isBuffer(left.content) ? left.content.toString("base64") : left.content;
  const rightContent = Buffer.isBuffer(right.content) ? right.content.toString("base64") : right.content;
  return JSON.stringify({ ...left, content: leftContent }) === JSON.stringify({ ...right, content: rightContent });
}

function aggregatePlan(
  reports: RuntimeAdapterReport[],
  ledger: LifecycleOwnershipJournalRead["ledger"],
  appHome: string,
  selectedRuntimeIds: ReadonlySet<string>,
): LifecycleOperationPlan {
  const operations: LifecycleOperationSpec[] = [];
  const byId = new Map<string, LifecycleOperationSpec>();
  const allowedRoots = new Set<string>([path.resolve(appHome)]);
  const contract = loadRuntimeLifecycleAdapterContract();
  for (const report of reports) {
    for (const root of report.repairPlan.request.allowedRoots) allowedRoots.add(root);
    for (const spec of report.repairPlan.request.operations) {
      const resource = resourceForOperation(spec.id, contract.resources);
      if (resource.runtimeId !== undefined && !selectedRuntimeIds.has(resource.runtimeId)) {
        throw new Error(`${spec.id}: selected lifecycle plan includes an unselected runtime resource`);
      }
      const previous = byId.get(spec.id);
      if (previous) {
        if (!sameSpec(previous, spec)) throw new Error(`${spec.id}: selected adapters disagree on shared operation`);
        continue;
      }
      byId.set(spec.id, spec);
      operations.push(spec);
    }
  }
  return planLifecycleOperations({
    allowedRoots: [...allowedRoots],
    operations,
    manifest: createLifecycleOwnershipManifest(operations),
    ledger,
  });
}

function operationEvidence(
  operationId: string,
  reports: RuntimeAdapterReport[],
): { evidence: RuntimeAdapterEvidence[]; remediation: string[] } {
  const evidence: RuntimeAdapterEvidence[] = [];
  const remediation = new Set<string>();
  const seenEvidence = new Set<string>();
  for (const report of reports) {
    for (const category of RUNTIME_ADAPTER_CATEGORIES) {
      for (const surface of report.categories[category].surfaces) {
        if (!surface.remediation.operationIds.includes(operationId)) continue;
        remediation.add(surface.remediation.summary);
        for (const item of surface.evidence) {
          const key = JSON.stringify(item);
          if (!seenEvidence.has(key)) {
            seenEvidence.add(key);
            evidence.push(item);
          }
        }
      }
    }
  }
  return { evidence, remediation: [...remediation] };
}

function publicOperation(
  operation: PlannedLifecycleOperation,
  reports: RuntimeAdapterReport[],
  resources: RuntimeAdapterResourceDeclaration[],
  journal: LifecycleOwnershipJournalRead,
  outcome?: AppliedLifecycleOperation,
): LifecycleUpgradeOperation {
  const resource = resourceForOperation(operation.id, resources);
  const detail = operationEvidence(operation.id, reports);
  const record = journal.ledger.records.find((candidate) => candidate.resourceId === operation.id);
  const needsOutcomeRemediation = outcome?.status === "failed" || outcome?.status === "skipped_dependency";
  return {
    id: operation.id,
    runtime: resource.runtimeId ?? "shared",
    surface: resource.surfaceId ?? "shared",
    category: resource.category,
    resource: resource.id,
    destination: operation.destination,
    desiredState: reports.flatMap((report) => report.repairPlan.request.operations)
      .find((candidate) => candidate.id === operation.id)?.intent === "remove" ? "missing" : "exact",
    currentState: operation.state,
    ownership: operation.ownership,
    ownershipEvidence: {
      declaration: "matched",
      journalPath: journal.path,
      journalState: journal.state,
      ledgerRecord: record ? {
        status: record.status,
        scope: record.scope,
        destination: record.destination,
        kind: record.kind,
        fingerprint: record.fingerprint,
        identity: record.identity,
      } : null,
    },
    action: operation.action,
    dependencies: operation.dependsOn,
    required: operation.required,
    optional: !operation.required,
    blockedReason: ["blocked_unowned", "action_required"].includes(operation.action)
      || needsOutcomeRemediation
      ? operation.reason
      : null,
    remediation: needsOutcomeRemediation
      ? [operation.reason, ...detail.remediation]
      : detail.remediation.length > 0 ? detail.remediation : [operation.reason],
    evidence: detail.evidence,
    outcome: outcome?.status ?? null,
    dependencyCauses: outcome?.dependencyCauses ?? [],
  };
}

function userActions(reports: RuntimeAdapterReport[]): LifecycleUpgradeUserAction[] {
  const actions: LifecycleUpgradeUserAction[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    for (const category of RUNTIME_ADAPTER_CATEGORIES) {
      for (const surface of report.categories[category].surfaces) {
        if (!surface.expected || surface.remediation.kind !== "action_required") continue;
        if (surface.remediation.nativeActions.length > 0) {
          for (const action of surface.remediation.nativeActions) {
            const id = `${report.runtimeId}.${surface.surfaceId}.${category}.${action.id}`;
            if (seen.has(id)) continue;
            seen.add(id);
            actions.push({
              id,
              runtime: report.runtimeId,
              surface: surface.surfaceId,
              category,
              kind: "native",
              status: "action_required",
              required: surface.required,
              remediation: surface.remediation.summary,
              command: action.command,
              instruction: action.instruction,
            });
          }
        } else if (surface.remediation.operationIds.length === 0) {
          const id = `${report.runtimeId}.${surface.surfaceId}.${category}`;
          if (seen.has(id)) continue;
          seen.add(id);
          actions.push({
            id,
            runtime: report.runtimeId,
            surface: surface.surfaceId,
            category,
            kind: "manual",
            status: "action_required",
            required: surface.required,
            remediation: surface.remediation.summary,
            command: null,
            instruction: surface.remediation.summary,
          });
        }
      }
    }
  }
  return actions;
}

function blockedPlan(
  plan: LifecycleOperationPlan,
  reason: string,
): LifecycleOperationPlan {
  return {
    ...plan,
    operations: plan.operations.map((operation) =>
      operation.action !== "noop"
        ? { ...operation, action: "action_required", reason }
        : operation,
    ),
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

function blockOperation(plan: LifecycleOperationPlan, operationId: string, reason: string): LifecycleOperationPlan {
  return {
    ...plan,
    operations: plan.operations.map((operation) => operation.id === operationId && operation.action !== "noop"
      ? { ...operation, action: "action_required", reason }
      : operation),
  };
}

function buildLifecycleUpgrade(args: LifecycleUpgradeArgs): BuiltLifecycleUpgrade {
  const journal = readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(args.appHome));
  const matrix = inspectRuntimeLifecycleAdapters({
    home: args.home,
    project: args.project,
    sourceRoot: args.sourceRoot,
    env: args.env,
    canonicalSkillTarget: args.canonicalSkillTarget,
    ledger: journal.ledger,
  } satisfies RuntimeAdapterInspectionContext);
  const runtimeIds = new Set(selectedRuntimeIds(args.selector));
  const reports = matrix.reports.filter((report) => runtimeIds.has(report.runtimeId as ActiveRuntimeSelector));
  let plan = aggregatePlan(reports, journal.ledger, args.appHome, runtimeIds);
  if (
    args.apply
    && args.canonicalSkillTarget
    && !fs.existsSync(path.join(args.canonicalSkillTarget, "SKILL.md"))
  ) {
    plan = blockOperation(
      plan,
      "canonical_skill",
      `stable canonical skill source is unavailable at ${args.canonicalSkillTarget}; app refresh must succeed before lifecycle publication`,
    );
  }
  if (journalBlocksMutation(journal)) {
    plan = blockedPlan(plan, journalBlocker(journal));
  } else if (!secureLifecycleRemovalAvailable()) {
    plan = blockedPlan(plan, "safe lifecycle apply requires Linux /proc/self/fd directory-relative access");
  }
  const contract = loadRuntimeLifecycleAdapterContract();
  const operations = plan.operations.map((operation) =>
    publicOperation(operation, reports, contract.resources, journal),
  );
  let retiredPreview = args.retiredCleanup === "claude"
    ? previewRetiredRuntimeCleanup({ runtimeId: "claude", home: args.home, ledger: journal.ledger })
    : null;
  if (retiredPreview && journalBlocksMutation(journal)) {
    retiredPreview = {
      ...retiredPreview,
      ledgerAuthorization: "blocked",
      ledgerDiagnostics: [...retiredPreview.ledgerDiagnostics, journalBlocker(journal)],
      plan: blockedPlan(retiredPreview.plan, journalBlocker(journal)),
    };
  }
  return {
    reports,
    plan,
    journal,
    operations,
    userActions: userActions(reports),
    projection: summarizeRuntimeLifecycle(
      projectRuntimeLifecycle(matrix, selectedRuntimeIds(args.selector)),
    ),
    retiredPreview,
  };
}

function emptyApplySummary(): LifecycleApplySummary {
  return { applied: 0, noop: 0, failed: 0, blocked_unowned: 0, skipped_dependency: 0, action_required: 0 };
}

function resultForBlockedPlan(plan: LifecycleOperationPlan): LifecycleApplyResult {
  const operations: AppliedLifecycleOperation[] = plan.operations.map((operation) => ({
    ...operation,
    status: operation.action === "noop"
      ? "noop"
      : operation.action === "blocked_unowned"
        ? "blocked_unowned"
        : "action_required",
    dependencyCauses: [],
  }));
  const summary = emptyApplySummary();
  for (const operation of operations) summary[operation.status] += 1;
  const requiredUnmet = operations
    .filter((operation) => operation.required && !["applied", "noop"].includes(operation.status))
    .map((operation) => operation.id);
  return {
    schemaVersion: "agentera.lifecycleApplyResult.v1",
    status: requiredUnmet.length === 0 ? "success" : "non_success",
    operations,
    summary,
    requiredUnmet,
    ownershipLedger: plan.request.ledger!,
  };
}

function previewSummary(
  operations: LifecycleUpgradeOperation[],
  actions: LifecycleUpgradeUserAction[],
): LifecycleUpgradeSummary {
  const summary: LifecycleUpgradeSummary = {
    ...emptyApplySummary(),
    pending: 0,
    nativeActionRequired: actions.filter((action) => action.kind === "native").length,
    manualActionRequired: actions.filter((action) => action.kind === "manual").length,
  };
  for (const operation of operations) {
    if (operation.action === "noop") summary.noop += 1;
    else if (operation.action === "blocked_unowned") summary.blocked_unowned += 1;
    else if (operation.action === "action_required") summary.action_required += 1;
    else summary.pending += 1;
  }
  return summary;
}

function emptyRetiredSummary(): LifecycleRetiredSummary {
  return { ...emptyApplySummary(), pending: 0 };
}

function retiredPreviewSummary(
  preview: RetiredRuntimeCleanupPreview | null,
): LifecycleRetiredSummary | null {
  if (!preview) return null;
  const summary = emptyRetiredSummary();
  for (const operation of preview.plan.operations) {
    if (operation.action === "noop") summary.noop += 1;
    else if (operation.action === "blocked_unowned") summary.blocked_unowned += 1;
    else if (operation.action === "action_required") summary.action_required += 1;
    else summary.pending += 1;
  }
  return summary;
}

function retiredResultSummary(
  result: RetiredRuntimeCleanupResult | null,
): LifecycleRetiredSummary | null {
  if (!result) return null;
  return { ...result.summary, pending: 0 };
}

function resultStatus(
  mode: "preview" | "apply",
  summary: LifecycleUpgradeSummary,
  retiredSummary: LifecycleRetiredSummary | null,
  requiredUnmet: string[],
): LifecycleUpgradeResult["status"] {
  const retiredHasFailure = retiredSummary !== null && (
    retiredSummary.failed > 0
    || retiredSummary.blocked_unowned > 0
    || retiredSummary.skipped_dependency > 0
    || retiredSummary.action_required > 0
  );
  if (
    summary.failed > 0
    || summary.blocked_unowned > 0
    || summary.skipped_dependency > 0
    || summary.action_required > 0
    || summary.nativeActionRequired > 0
    || summary.manualActionRequired > 0
  ) return "non_success";
  if (retiredHasFailure) return "non_success";
  if (requiredUnmet.length > 0) return "non_success";
  if (mode === "preview" && (summary.pending > 0 || (retiredSummary?.pending ?? 0) > 0)) return "pending";
  if (mode === "apply" && (summary.applied > 0 || (retiredSummary?.applied ?? 0) > 0)) return "success";
  return "noop";
}

export function runLifecycleUpgrade(
  args: LifecycleUpgradeArgs,
  options: LifecycleUpgradeApplyOptions = {},
): LifecycleUpgradeResult {
  const built = buildLifecycleUpgrade(args);
  let operations = built.operations;
  let retiredCleanup: RetiredRuntimeCleanupPreview | RetiredRuntimeCleanupResult | null = built.retiredPreview;
  let retiredSummary = retiredPreviewSummary(built.retiredPreview);
  let outputJournal = built.journal;
  let projection = built.projection;
  let summary = previewSummary(operations, built.userActions);
  let requiredUnmet = [
    ...operations.filter((operation) =>
      operation.required && ["blocked_unowned", "action_required"].includes(operation.action),
    ).map((operation) => operation.id),
    ...built.userActions.filter((action) => action.required).map((action) => action.id),
  ];

  if (args.apply) {
    const blocked = journalBlocksMutation(built.journal) || !secureLifecycleRemovalAvailable();
    const persistLedger = (ledger: LifecycleOwnershipJournalRead["ledger"]): void => {
      appendLifecycleOwnershipJournal(built.journal.path, ledger);
    };
    const applied = blocked
      ? resultForBlockedPlan(built.plan)
      : applyLifecycleOperations(built.plan, { ...options, persistLedger });
    outputJournal = readLifecycleOwnershipJournal(built.journal.path);
    const contract = loadRuntimeLifecycleAdapterContract();
    operations = applied.operations.map((operation) =>
      publicOperation(operation, built.reports, contract.resources, outputJournal, operation),
    );
    if (built.retiredPreview && !blocked) {
      const currentRetiredPreview = previewRetiredRuntimeCleanup({
        runtimeId: "claude",
        home: args.home,
        ledger: applied.ownershipLedger,
      });
      retiredCleanup = applyRetiredRuntimeCleanup(currentRetiredPreview, {
        ...options,
        approved: true,
        persistLedger,
      });
      retiredSummary = retiredResultSummary(retiredCleanup);
      outputJournal = readLifecycleOwnershipJournal(built.journal.path);
    }
    summary = {
      ...applied.summary,
      pending: 0,
      nativeActionRequired: built.userActions.filter((action) => action.kind === "native").length,
      manualActionRequired: built.userActions.filter((action) => action.kind === "manual").length,
    };
    requiredUnmet = [
      ...applied.requiredUnmet,
      ...built.userActions.filter((action) => action.required).map((action) => action.id),
      ...(retiredCleanup && "requiredUnmet" in retiredCleanup ? retiredCleanup.requiredUnmet : []),
    ];
    projection = lifecycleProjection(args, outputJournal.ledger);
  } else if (built.retiredPreview) {
    requiredUnmet.push(...built.retiredPreview.plan.operations
      .filter((operation) => operation.required && operation.action !== "noop")
      .map((operation) => operation.id));
  }

  requiredUnmet = [...new Set(requiredUnmet)];
  return {
    schemaVersion: LIFECYCLE_UPGRADE_SCHEMA,
    mode: args.apply ? "apply" : "preview",
    selection: { requested: args.selector ?? "none", runtimeIds: selectedRuntimeIds(args.selector) },
    status: resultStatus(args.apply ? "apply" : "preview", summary, retiredSummary, requiredUnmet),
    approval: args.apply ? "approved" : "not_requested",
    platform: {
      securePublication: secureLifecycleRemovalAvailable(),
      requirement: "linux_proc_self_fd",
    },
    ownershipJournal: outputJournal,
    operations,
    userActions: built.userActions,
    projection,
    retiredCleanup,
    retiredSummary,
    summary,
    requiredUnmet,
  };
}
