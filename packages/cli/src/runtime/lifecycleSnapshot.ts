import crypto from "node:crypto";

import {
  inspectRuntimeLifecycleAdapters,
  type RuntimeAdapterCategorySurfaceReport,
  type RuntimeAdapterEvidence,
  type RuntimeAdapterInspectionContext,
  type RuntimeAdapterMatrixReport,
  type RuntimeAdapterReport,
  type RuntimeAdapterRemediation,
} from "./lifecycleAdapters.js";
import {
  RUNTIME_ADAPTER_CATEGORIES,
  loadRuntimeLifecycleAdapterContract,
  type RuntimeAdapterCapability,
  type RuntimeAdapterCategory,
  type RuntimeAdapterEvidenceState,
  type RuntimeAdapterResourceDeclaration,
  type RuntimeLifecycleAdapterContract,
} from "./lifecycleAdapterContract.js";
import {
  type LifecycleAggregateStatus,
  type LifecycleActionClass,
  type LifecycleApplicability,
  type LifecycleCommandEligibility,
  type LifecycleEvidenceField,
  type LifecycleEvidenceValue,
  type LifecycleSupportFloorBlockerCode,
  type LifecycleSupportFloorViolation,
  type LifecycleSurfaceStatus,
} from "./lifecycleAuthority.js";
import type {
  LifecycleOwnership,
  LifecyclePlanAction,
  PlannedLifecycleOperation,
} from "./lifecycleOperations.js";
export const LIFECYCLE_SNAPSHOT_SCHEMA_VERSION = "agentera.runtimeLifecycleSnapshot.v1" as const;
export const LIFECYCLE_PROJECTION_SCHEMA_VERSION =
  "agentera.runtimeLifecycleProjection.v1" as const;
export const LIFECYCLE_STATUS_VOCABULARY_VERSION = "agentera.runtimeLifecycleStatus.v1" as const;
export const LIFECYCLE_SUMMARY_SCHEMA_VERSION = "agentera.runtimeLifecycleSummary.v1" as const;

export interface LifecycleSkillPrecedence {
  winner: {
    path: string;
    canonical: boolean;
    state: RuntimeAdapterEvidenceState;
  } | null;
  shadowing: Array<{
    path: string;
    canonical: boolean;
    state: RuntimeAdapterEvidenceState;
  }>;
}

export interface LifecycleSnapshotCategory {
  surfaceId: string;
  category: RuntimeAdapterCategory;
  state: RuntimeAdapterEvidenceState;
  capability: RuntimeAdapterCapability;
  source: string;
  required: boolean;
  diagnosisComplete: boolean;
  evidence: RuntimeAdapterEvidence[];
  remediation: RuntimeAdapterRemediation;
  precedence?: LifecycleSkillPrecedence;
}

export interface LifecycleSnapshotSurface {
  id: string;
  displayName: string;
  expected: boolean;
  applicability: LifecycleApplicability;
  status: LifecycleSurfaceStatus;
  evidence: Partial<Record<LifecycleEvidenceField, LifecycleEvidenceValue>>;
  diagnosisComplete: boolean;
  unmetMandatoryFields: string[];
  releaseBlocking: boolean;
  supportFloorViolations: LifecycleSupportFloorViolation[];
  categories: LifecycleSnapshotCategory[];
}

export interface LifecycleSnapshotBlocker {
  id: string;
  code: LifecycleSupportFloorBlockerCode | "unowned_collision";
  kind: "support_floor" | "unowned_collision";
  surfaceId?: string;
  category?: RuntimeAdapterCategory;
  detail: string;
  evidence?: {
    field: LifecycleEvidenceField;
    observed: LifecycleEvidenceValue | "missing";
  };
}

export interface LifecycleSnapshotRuntime {
  runtimeId: string;
  displayName: string;
  status: LifecycleAggregateStatus;
  readiness: LifecycleAggregateStatus;
  canonicalSkill: {
    path: string;
    detected: LifecycleEvidenceValue;
  };
  diagnosisComplete: boolean;
  supportFloor: {
    met: boolean;
    releaseBlocking: boolean;
    unmet: string[];
    violations: LifecycleSupportFloorViolation[];
  };
  surfaces: LifecycleSnapshotSurface[];
  blockers: LifecycleSnapshotBlocker[];
  counts: LifecycleProjectionCounts;
  actionCount: number;
}

export type LifecycleProjectedOwnership = LifecycleOwnership | "user_owned";

export type LifecycleCommandEligibilityProjection = Record<LifecycleCommandEligibility, boolean>;

export interface LifecycleProjectedAction {
  id: string;
  runtimeIds: string[];
  surfaceId: string;
  category: RuntimeAdapterCategory | "surface";
  resourceId: string | null;
  destination: string | null;
  applicability: Exclude<LifecycleApplicability, "not_applicable">;
  ownership: LifecycleProjectedOwnership;
  actionClass: LifecycleActionClass;
  required: boolean;
  reason: string;
  operation: LifecyclePlanAction | null;
  commandEligibility: LifecycleCommandEligibilityProjection;
  manual: {
    command: string | string[] | null;
    instruction: string;
  } | null;
}

export interface LifecycleProjectedSharedResource {
  id: string;
  category: RuntimeAdapterCategory;
  destination: string;
  applicability: "required";
  selectedByRuntimeIds: string[];
  requiredByRuntimeIds: string[];
}

export interface LifecycleProjectionCounts {
  total: number;
  repairableOwned: number;
  manualVerification: number;
  unobservableGap: number;
  commandEligible: number;
}

export interface RuntimeLifecycleSnapshot {
  schemaVersion: typeof LIFECYCLE_SNAPSHOT_SCHEMA_VERSION;
  projectionVersion: typeof LIFECYCLE_PROJECTION_SCHEMA_VERSION;
  snapshotId: string;
  statusVocabularyVersion: typeof LIFECYCLE_STATUS_VOCABULARY_VERSION;
  authority: string;
  activeRuntimeIds: string[];
  selection: {
    runtimeIds: string[];
  };
  releaseBlocked: boolean;
  sharedResources: LifecycleProjectedSharedResource[];
  actions: LifecycleProjectedAction[];
  counts: LifecycleProjectionCounts;
  runtimes: LifecycleSnapshotRuntime[];
}

export interface LifecycleRuntimeSummary {
  runtimeId: string;
  displayName: string;
  status: LifecycleAggregateStatus;
  readiness: LifecycleAggregateStatus;
  canonicalSkill: {
    detected: LifecycleEvidenceValue;
  };
  supportFloor: {
    met: boolean;
    releaseBlocking: boolean;
    unmet: string[];
  };
  surfaces: Array<{
    id: string;
    expected: boolean;
    applicability: LifecycleApplicability;
    detected: LifecycleEvidenceValue;
    status: LifecycleSurfaceStatus;
    releaseBlocking: boolean;
  }>;
  blockerCount: number;
  counts: LifecycleProjectionCounts;
  actionCount: number;
}

export interface RuntimeLifecycleSummary {
  schemaVersion: typeof LIFECYCLE_SUMMARY_SCHEMA_VERSION;
  snapshotVersion: typeof LIFECYCLE_SNAPSHOT_SCHEMA_VERSION;
  projectionVersion: typeof LIFECYCLE_PROJECTION_SCHEMA_VERSION;
  snapshotId: string;
  statusVocabularyVersion: typeof LIFECYCLE_STATUS_VOCABULARY_VERSION;
  authority: string;
  activeRuntimeIds: string[];
  counts: LifecycleProjectionCounts;
  releaseBlocked: boolean;
  runtimes: LifecycleRuntimeSummary[];
}

function isCanonicalEvidence(evidence: RuntimeAdapterEvidence): boolean {
  return evidence.detail.includes("canonical shared location");
}

function skillPrecedence(surface: RuntimeAdapterCategorySurfaceReport): LifecycleSkillPrecedence {
  const discovered = surface.evidence
    .filter((evidence) => evidence.kind === "filesystem" && evidence.path !== undefined)
    .map((evidence) => ({
      path: evidence.path as string,
      canonical: isCanonicalEvidence(evidence),
      state: evidence.state,
    }));
  const confirmed = discovered.filter((evidence) => evidence.state === "confirmed");
  return {
    winner: confirmed[0] ?? null,
    shadowing: confirmed.slice(1),
  };
}

function snapshotCategories(
  surfaceId: string,
  reportCategories: RuntimeAdapterReport["categories"],
): LifecycleSnapshotCategory[] {
  return RUNTIME_ADAPTER_CATEGORIES.map((category) => {
    const surface = reportCategories[category].surfaces.find(
      (candidate) => candidate.surfaceId === surfaceId,
    );
    if (!surface)
      throw new Error(`${category}: missing lifecycle diagnosis for surface ${surfaceId}`);
    return {
      surfaceId,
      category,
      state: surface.state,
      capability: surface.capability,
      source: surface.source,
      required: surface.required,
      diagnosisComplete: surface.diagnosisComplete,
      evidence: surface.evidence,
      remediation: surface.remediation,
      ...(category === "skills" ? { precedence: skillPrecedence(surface) } : {}),
    };
  });
}

function blockersFor(
  supportFloorViolations: LifecycleSupportFloorViolation[],
  surfaces: LifecycleSnapshotSurface[],
): LifecycleSnapshotBlocker[] {
  const blockers: LifecycleSnapshotBlocker[] = supportFloorViolations.map((violation) => ({
    id: ["support_floor", violation.code, violation.surfaceId, violation.field]
      .filter(Boolean)
      .join(":"),
    code: violation.code,
    kind: "support_floor",
    ...(violation.surfaceId ? { surfaceId: violation.surfaceId } : {}),
    detail: violation.detail,
    ...(violation.field && violation.observed !== undefined
      ? { evidence: { field: violation.field, observed: violation.observed } }
      : {}),
  }));
  const seen = new Set(blockers.map((blocker) => blocker.id));
  for (const surface of surfaces) {
    for (const category of surface.categories) {
      if (category.state !== "blocked_unowned") continue;
      const operationIds =
        category.remediation.operationIds.length > 0
          ? category.remediation.operationIds
          : [`${surface.id}:${category.category}`];
      for (const operationId of operationIds) {
        const id = `unowned_collision:${operationId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        blockers.push({
          id,
          code: "unowned_collision",
          kind: "unowned_collision",
          surfaceId: surface.id,
          category: category.category,
          detail: category.remediation.summary,
        });
      }
    }
  }
  return blockers;
}

function commandEligibility(
  actionClass: LifecycleActionClass,
): LifecycleCommandEligibilityProjection {
  return {
    preview: actionClass === "repairable_owned",
    apply: actionClass === "repairable_owned",
    manual: actionClass === "manual_verification",
    diagnostic: actionClass === "unobservable_gap",
  };
}

function projectionCounts(actions: LifecycleProjectedAction[]): LifecycleProjectionCounts {
  return {
    total: actions.length,
    repairableOwned: actions.filter((action) => action.actionClass === "repairable_owned").length,
    manualVerification: actions.filter((action) => action.actionClass === "manual_verification")
      .length,
    unobservableGap: actions.filter((action) => action.actionClass === "unobservable_gap").length,
    commandEligible: actions.filter((action) =>
      Object.values(action.commandEligibility).some(Boolean),
    ).length,
  };
}

function resourceForOperation(
  operationId: string,
  resources: RuntimeAdapterResourceDeclaration[],
): RuntimeAdapterResourceDeclaration {
  const resource = resources
    .filter(
      (candidate) => operationId === candidate.id || operationId.startsWith(`${candidate.id}.`),
    )
    .sort((left, right) => right.id.length - left.id.length)[0];
  if (!resource) throw new Error(`${operationId}: lifecycle operation has no resource declaration`);
  return resource;
}

function selectedRuntimeIds(
  matrix: RuntimeAdapterMatrixReport,
  requested: readonly string[] | undefined,
): string[] {
  const active = matrix.lifecycleState.activeRuntimeIds;
  const selected = requested === undefined ? new Set(active) : new Set(requested);
  const invalid = [...selected].filter((runtimeId) => !active.includes(runtimeId));
  if (invalid.length > 0) {
    throw new Error(`unknown lifecycle projection runtime: ${invalid.join(", ")}`);
  }
  return active.filter((runtimeId) => selected.has(runtimeId));
}

function selectedSharedResources(
  reports: RuntimeAdapterReport[],
  contract: RuntimeLifecycleAdapterContract,
): LifecycleProjectedSharedResource[] {
  const selectedIds = new Set(reports.map((report) => report.runtimeId));
  return contract.resources.flatMap((resource): LifecycleProjectedSharedResource[] => {
    if (resource.runtimeId !== undefined || !resource.required) return [];
    const selectedByRuntimeIds = contract.adapters
      .filter(
        (adapter) =>
          selectedIds.has(adapter.runtimeId) && adapter.resourceRefs.includes(resource.id),
      )
      .map((adapter) => adapter.runtimeId);
    const requiredByRuntimeIds = [...selectedByRuntimeIds];
    if (requiredByRuntimeIds.length === 0) return [];
    const operation = reports
      .flatMap((report) => report.repairPlan.operations)
      .find(
        (candidate) => candidate.id === resource.id || candidate.id.startsWith(`${resource.id}.`),
      );
    if (!operation)
      throw new Error(`${resource.id}: selected shared resource has no lifecycle operation`);
    return [
      {
        id: resource.id,
        category: resource.category,
        destination: operation.destination,
        applicability: "required",
        selectedByRuntimeIds,
        requiredByRuntimeIds,
      },
    ];
  });
}

function operationActionClass(operation: PlannedLifecycleOperation): LifecycleActionClass {
  if (
    ["create", "update", "remove", "finalize_ownership"].includes(operation.action) &&
    ["managed", "claimable", "legacy"].includes(operation.ownership)
  )
    return "repairable_owned";
  return "manual_verification";
}

function operationActions(
  reports: RuntimeAdapterReport[],
  runtimes: LifecycleSnapshotRuntime[],
  contract: RuntimeLifecycleAdapterContract,
  sharedResources: LifecycleProjectedSharedResource[],
): LifecycleProjectedAction[] {
  const shared = new Map(sharedResources.map((resource) => [resource.id, resource]));
  const actions = new Map<string, LifecycleProjectedAction>();
  for (const report of reports) {
    for (const operation of report.repairPlan.operations) {
      if (operation.action === "noop") continue;
      const resource = resourceForOperation(operation.id, contract.resources);
      const sharedResource = shared.get(resource.id);
      let runtimeIds: string[];
      let surfaceId: string;
      let applicability: Exclude<LifecycleApplicability, "not_applicable">;
      if (sharedResource) {
        runtimeIds = sharedResource.requiredByRuntimeIds;
        surfaceId = "shared";
        applicability = "required";
      } else {
        if (resource.runtimeId !== report.runtimeId) continue;
        const runtime = runtimes.find((candidate) => candidate.runtimeId === report.runtimeId);
        const surface = runtime?.surfaces.find((candidate) => candidate.id === resource.surfaceId);
        if (!surface?.expected || surface.applicability === "not_applicable") continue;
        runtimeIds = [report.runtimeId];
        surfaceId = surface.id;
        applicability = surface.applicability;
      }
      const actionClass = operationActionClass(operation);
      const projected: LifecycleProjectedAction = {
        id: `operation:${operation.id}`,
        runtimeIds,
        surfaceId,
        category: resource.category,
        resourceId: resource.id,
        destination: operation.destination,
        applicability,
        ownership: operation.ownership,
        actionClass,
        required: operation.required,
        reason: operation.reason,
        operation: operation.action,
        commandEligibility: commandEligibility(actionClass),
        manual:
          actionClass === "manual_verification"
            ? { command: null, instruction: operation.reason }
            : null,
      };
      const previous = actions.get(projected.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(projected)) {
        throw new Error(
          `${operation.id}: selected runtimes disagree on shared lifecycle projection`,
        );
      }
      actions.set(projected.id, projected);
    }
  }
  return [...actions.values()];
}

function evidenceFieldCategory(
  field: LifecycleEvidenceField | undefined,
): RuntimeAdapterCategory | "surface" {
  if (field === "installed") return "skills";
  if (field === "enabled") return "enablement";
  if (field === "trusted") return "trust";
  return "surface";
}

function diagnosticAndManualActions(
  reports: RuntimeAdapterReport[],
  runtimes: LifecycleSnapshotRuntime[],
): LifecycleProjectedAction[] {
  const actions = new Map<string, LifecycleProjectedAction>();
  const add = (action: LifecycleProjectedAction): void => {
    if (!actions.has(action.id)) actions.set(action.id, action);
  };
  for (const report of reports) {
    const runtime = runtimes.find((candidate) => candidate.runtimeId === report.runtimeId);
    if (!runtime) continue;
    for (const surface of runtime.surfaces.filter((candidate) => candidate.expected)) {
      for (const category of surface.categories) {
        if (category.remediation.operationIds.length > 0) continue;
        for (const nativeAction of category.remediation.nativeActions) {
          const actionClass = "manual_verification" as const;
          add({
            id: `manual:${runtime.runtimeId}:${surface.id}:${category.category}:${nativeAction.id}`,
            runtimeIds: [runtime.runtimeId],
            surfaceId: surface.id,
            category: category.category,
            resourceId: null,
            destination: null,
            applicability: surface.applicability as Exclude<
              LifecycleApplicability,
              "not_applicable"
            >,
            ownership: "user_owned",
            actionClass,
            required: category.required,
            reason: category.remediation.summary,
            operation: null,
            commandEligibility: commandEligibility(actionClass),
            manual: { command: nativeAction.command, instruction: nativeAction.instruction },
          });
        }
        if (
          category.remediation.kind === "action_required" &&
          category.remediation.nativeActions.length === 0 &&
          !["confirmed", "not_applicable"].includes(category.state)
        ) {
          const actionClass = "manual_verification" as const;
          add({
            id: `manual:${runtime.runtimeId}:${surface.id}:${category.category}`,
            runtimeIds: [runtime.runtimeId],
            surfaceId: surface.id,
            category: category.category,
            resourceId: null,
            destination: null,
            applicability: surface.applicability as Exclude<
              LifecycleApplicability,
              "not_applicable"
            >,
            ownership: "user_owned",
            actionClass,
            required: category.required,
            reason: category.remediation.summary,
            operation: null,
            commandEligibility: commandEligibility(actionClass),
            manual: { command: null, instruction: category.remediation.summary },
          });
        }
        if (
          category.required &&
          category.state === "unknown" &&
          category.remediation.kind === "unavailable"
        ) {
          const actionClass = "unobservable_gap" as const;
          add({
            id: `diagnostic:${runtime.runtimeId}:${surface.id}:${category.category}`,
            runtimeIds: [runtime.runtimeId],
            surfaceId: surface.id,
            category: category.category,
            resourceId: null,
            destination: null,
            applicability: surface.applicability as Exclude<
              LifecycleApplicability,
              "not_applicable"
            >,
            ownership: "undeclared",
            actionClass,
            required: true,
            reason: category.remediation.summary,
            operation: null,
            commandEligibility: commandEligibility(actionClass),
            manual: null,
          });
        }
      }
      for (const violation of surface.supportFloorViolations) {
        const categoryName = evidenceFieldCategory(violation.field);
        const category =
          categoryName === "surface"
            ? undefined
            : surface.categories.find((candidate) => candidate.category === categoryName);
        if (category?.remediation.operationIds.length) continue;
        const manual = category?.remediation.kind === "action_required";
        const actionClass: LifecycleActionClass = manual
          ? "manual_verification"
          : "unobservable_gap";
        add({
          id: `${manual ? "manual" : "diagnostic"}:${runtime.runtimeId}:${surface.id}:${categoryName}`,
          runtimeIds: [runtime.runtimeId],
          surfaceId: surface.id,
          category: categoryName,
          resourceId: null,
          destination: null,
          applicability: surface.applicability as Exclude<LifecycleApplicability, "not_applicable">,
          ownership: manual ? "user_owned" : "undeclared",
          actionClass,
          required: true,
          reason: category?.remediation.summary ?? violation.detail,
          operation: null,
          commandEligibility: commandEligibility(actionClass),
          manual: manual
            ? { command: null, instruction: category?.remediation.summary ?? violation.detail }
            : null,
        });
      }
    }
  }
  return [...actions.values()];
}

function snapshotId(payload: Omit<RuntimeLifecycleSnapshot, "snapshotId">): string {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

/**
 * Observe every active runtime once and expose the immutable status object used
 * by both prime and doctor. The adapter probes are bounded and read-only; this
 * function never publishes a repair plan or executes host-native actions.
 */
export function observeRuntimeLifecycle(
  context: RuntimeAdapterInspectionContext,
  runtimeIds?: readonly string[],
): RuntimeLifecycleSnapshot {
  const matrix = inspectRuntimeLifecycleAdapters(context);
  return projectRuntimeLifecycle(matrix, runtimeIds);
}

export function projectRuntimeLifecycle(
  matrix: RuntimeAdapterMatrixReport,
  runtimeIds?: readonly string[],
  contract = loadRuntimeLifecycleAdapterContract(),
): RuntimeLifecycleSnapshot {
  const selection = selectedRuntimeIds(matrix, runtimeIds);
  const selected = new Set(selection);
  const reports = selection
    .map((runtimeId) => matrix.reports.find((report) => report.runtimeId === runtimeId))
    .filter((report): report is RuntimeAdapterReport => report !== undefined);
  const runtimes = matrix.lifecycleState.runtimes
    .filter((state) => selected.has(state.runtimeId))
    .map((state): LifecycleSnapshotRuntime => {
      const report = matrix.reports.find((candidate) => candidate.runtimeId === state.runtimeId);
      if (!report) throw new Error(`${state.runtimeId}: lifecycle adapter report is missing`);
      const surfaces = state.surfaces.map(
        (surface): LifecycleSnapshotSurface => ({
          id: surface.id,
          displayName: surface.displayName,
          expected: surface.expected,
          applicability: surface.applicability,
          status: surface.status,
          evidence: surface.evidence,
          diagnosisComplete: surface.diagnosisComplete,
          unmetMandatoryFields: surface.unmetMandatoryFields,
          releaseBlocking: surface.releaseBlocking,
          supportFloorViolations: surface.supportFloorViolations,
          categories: snapshotCategories(surface.id, report.categories),
        }),
      );
      const blockers = blockersFor(state.supportFloor.violations, surfaces);
      return {
        runtimeId: state.runtimeId,
        displayName: state.displayName,
        status: state.status,
        readiness: state.status,
        canonicalSkill: state.canonicalSkill,
        diagnosisComplete: state.diagnosisComplete,
        supportFloor: state.supportFloor,
        surfaces,
        blockers,
        counts: projectionCounts([]),
        actionCount: 0,
      };
    });
  const sharedResources = selectedSharedResources(reports, contract);
  const actions = [
    ...operationActions(reports, runtimes, contract, sharedResources),
    ...diagnosticAndManualActions(reports, runtimes),
  ];
  for (const runtime of runtimes) {
    runtime.counts = projectionCounts(
      actions.filter((action) => action.runtimeIds.includes(runtime.runtimeId)),
    );
    runtime.actionCount = runtime.counts.total;
  }
  const payload: Omit<RuntimeLifecycleSnapshot, "snapshotId"> = {
    schemaVersion: LIFECYCLE_SNAPSHOT_SCHEMA_VERSION,
    projectionVersion: LIFECYCLE_PROJECTION_SCHEMA_VERSION,
    statusVocabularyVersion: LIFECYCLE_STATUS_VOCABULARY_VERSION,
    authority: matrix.lifecycleState.authority,
    activeRuntimeIds: matrix.lifecycleState.activeRuntimeIds,
    selection: { runtimeIds: selection },
    releaseBlocked: runtimes.some((runtime) => runtime.supportFloor.releaseBlocking),
    sharedResources,
    actions,
    counts: projectionCounts(actions),
    runtimes,
  };
  return { ...payload, snapshotId: snapshotId(payload) };
}

export function summarizeRuntimeLifecycle(
  snapshot: RuntimeLifecycleSnapshot,
): RuntimeLifecycleSummary {
  return {
    schemaVersion: LIFECYCLE_SUMMARY_SCHEMA_VERSION,
    snapshotVersion: snapshot.schemaVersion,
    projectionVersion: snapshot.projectionVersion,
    snapshotId: snapshot.snapshotId,
    statusVocabularyVersion: snapshot.statusVocabularyVersion,
    authority: snapshot.authority,
    activeRuntimeIds: snapshot.activeRuntimeIds,
    counts: snapshot.counts,
    releaseBlocked: snapshot.releaseBlocked,
    runtimes: snapshot.runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      displayName: runtime.displayName,
      status: runtime.status,
      readiness: runtime.readiness,
      canonicalSkill: { detected: runtime.canonicalSkill.detected },
      supportFloor: {
        met: runtime.supportFloor.met,
        releaseBlocking: runtime.supportFloor.releaseBlocking,
        unmet: runtime.supportFloor.unmet,
      },
      surfaces: runtime.surfaces.map((surface) => ({
        id: surface.id,
        expected: surface.expected,
        applicability: surface.applicability,
        detected: surface.evidence.host_present ?? "unknown",
        status: surface.status,
        releaseBlocking: surface.releaseBlocking,
      })),
      blockerCount: runtime.blockers.length,
      counts: runtime.counts,
      actionCount: runtime.actionCount,
    })),
  };
}
