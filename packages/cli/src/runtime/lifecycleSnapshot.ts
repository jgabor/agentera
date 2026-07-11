import {
  inspectRuntimeLifecycleAdapters,
  type RuntimeAdapterCategorySurfaceReport,
  type RuntimeAdapterEvidence,
  type RuntimeAdapterInspectionContext,
  type RuntimeAdapterReport,
  type RuntimeAdapterRemediation,
} from "./lifecycleAdapters.js";
import {
  RUNTIME_ADAPTER_CATEGORIES,
  type RuntimeAdapterCapability,
  type RuntimeAdapterCategory,
  type RuntimeAdapterEvidenceState,
} from "./lifecycleAdapterContract.js";
import type {
  LifecycleAggregateStatus,
  LifecycleEvidenceField,
  LifecycleEvidenceValue,
  LifecycleSurfaceStatus,
} from "./lifecycleAuthority.js";

export const LIFECYCLE_SNAPSHOT_SCHEMA_VERSION = "agentera.runtimeLifecycleSnapshot.v1" as const;
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
  status: LifecycleSurfaceStatus;
  evidence: Partial<Record<LifecycleEvidenceField, LifecycleEvidenceValue>>;
  diagnosisComplete: boolean;
  unmetMandatoryFields: string[];
  categories: LifecycleSnapshotCategory[];
}

export interface LifecycleSnapshotBlocker {
  id: string;
  kind: "support_floor" | "unowned_collision";
  surfaceId?: string;
  category?: RuntimeAdapterCategory;
  detail: string;
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
  };
  surfaces: LifecycleSnapshotSurface[];
  blockers: LifecycleSnapshotBlocker[];
  actionCount: number;
}

export interface RuntimeLifecycleSnapshot {
  schemaVersion: typeof LIFECYCLE_SNAPSHOT_SCHEMA_VERSION;
  statusVocabularyVersion: typeof LIFECYCLE_STATUS_VOCABULARY_VERSION;
  authority: string;
  activeRuntimeIds: string[];
  releaseBlocked: boolean;
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
    detected: LifecycleEvidenceValue;
    status: LifecycleSurfaceStatus;
  }>;
  blockerCount: number;
  actionCount: number;
}

export interface RuntimeLifecycleSummary {
  schemaVersion: typeof LIFECYCLE_SUMMARY_SCHEMA_VERSION;
  snapshotVersion: typeof LIFECYCLE_SNAPSHOT_SCHEMA_VERSION;
  statusVocabularyVersion: typeof LIFECYCLE_STATUS_VOCABULARY_VERSION;
  authority: string;
  activeRuntimeIds: string[];
  releaseBlocked: boolean;
  runtimes: LifecycleRuntimeSummary[];
}

function isCanonicalEvidence(evidence: RuntimeAdapterEvidence): boolean {
  return evidence.detail.includes("canonical shared location");
}

function skillPrecedence(
  surface: RuntimeAdapterCategorySurfaceReport,
): LifecycleSkillPrecedence {
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

function actionCount(categories: LifecycleSnapshotCategory[]): number {
  const actions = new Set<string>();
  for (const category of categories) {
    for (const operationId of category.remediation.operationIds) {
      actions.add(`operation:${operationId}`);
    }
    for (const nativeAction of category.remediation.nativeActions) {
      actions.add(`native:${nativeAction.id}`);
    }
    if (
      category.remediation.kind === "action_required"
      && category.remediation.operationIds.length === 0
      && category.remediation.nativeActions.length === 0
    ) {
      actions.add(`manual:${category.surfaceId}:${category.category}`);
    }
  }
  return actions.size;
}

function snapshotCategories(
  surfaceId: string,
  reportCategories: RuntimeAdapterReport["categories"],
): LifecycleSnapshotCategory[] {
  return RUNTIME_ADAPTER_CATEGORIES.map((category) => {
    const surface = reportCategories[category].surfaces.find((candidate) => candidate.surfaceId === surfaceId);
    if (!surface) throw new Error(`${category}: missing lifecycle diagnosis for surface ${surfaceId}`);
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
  supportFloorUnmet: string[],
  surfaces: LifecycleSnapshotSurface[],
): LifecycleSnapshotBlocker[] {
  const blockers: LifecycleSnapshotBlocker[] = supportFloorUnmet.map((detail) => ({
    id: `support_floor:${detail}`,
    kind: "support_floor",
    detail,
  }));
  const seen = new Set(blockers.map((blocker) => blocker.id));
  for (const surface of surfaces) {
    for (const category of surface.categories) {
      if (category.state !== "blocked_unowned") continue;
      const operationIds = category.remediation.operationIds.length > 0
        ? category.remediation.operationIds
        : [`${surface.id}:${category.category}`];
      for (const operationId of operationIds) {
        const id = `unowned_collision:${operationId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        blockers.push({
          id,
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

/**
 * Observe every active runtime once and expose the immutable status object used
 * by both prime and doctor. The adapter probes are bounded and read-only; this
 * function never publishes a repair plan or executes host-native actions.
 */
export function observeRuntimeLifecycle(
  context: RuntimeAdapterInspectionContext,
): RuntimeLifecycleSnapshot {
  const matrix = inspectRuntimeLifecycleAdapters(context);
  const runtimes = matrix.lifecycleState.runtimes.map((state) => {
    const report = matrix.reports.find((candidate) => candidate.runtimeId === state.runtimeId);
    if (!report) throw new Error(`${state.runtimeId}: lifecycle adapter report is missing`);
    const surfaces = state.surfaces.map((surface): LifecycleSnapshotSurface => ({
      id: surface.id,
      displayName: surface.displayName,
      expected: surface.expected,
      status: surface.status,
      evidence: surface.evidence,
      diagnosisComplete: surface.diagnosisComplete,
      unmetMandatoryFields: surface.unmetMandatoryFields,
      categories: snapshotCategories(surface.id, report.categories),
    }));
    const categories = surfaces.flatMap((surface) => surface.categories);
    const blockers = blockersFor(state.supportFloor.unmet, surfaces);
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
      actionCount: actionCount(categories),
    };
  });
  return {
    schemaVersion: LIFECYCLE_SNAPSHOT_SCHEMA_VERSION,
    statusVocabularyVersion: LIFECYCLE_STATUS_VOCABULARY_VERSION,
    authority: matrix.lifecycleState.authority,
    activeRuntimeIds: matrix.lifecycleState.activeRuntimeIds,
    releaseBlocked: matrix.lifecycleState.releaseBlocked,
    runtimes,
  };
}

export function summarizeRuntimeLifecycle(
  snapshot: RuntimeLifecycleSnapshot,
): RuntimeLifecycleSummary {
  return {
    schemaVersion: LIFECYCLE_SUMMARY_SCHEMA_VERSION,
    snapshotVersion: snapshot.schemaVersion,
    statusVocabularyVersion: snapshot.statusVocabularyVersion,
    authority: snapshot.authority,
    activeRuntimeIds: snapshot.activeRuntimeIds,
    releaseBlocked: snapshot.releaseBlocked,
    runtimes: snapshot.runtimes.map((runtime) => ({
      runtimeId: runtime.runtimeId,
      displayName: runtime.displayName,
      status: runtime.status,
      readiness: runtime.readiness,
      canonicalSkill: { detected: runtime.canonicalSkill.detected },
      supportFloor: runtime.supportFloor,
      surfaces: runtime.surfaces.map((surface) => ({
        id: surface.id,
        expected: surface.expected,
        detected: surface.evidence.host_present ?? "unknown",
        status: surface.status,
      })),
      blockerCount: runtime.blockers.length,
      actionCount: runtime.actionCount,
    })),
  };
}
