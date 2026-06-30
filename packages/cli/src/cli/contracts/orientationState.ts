import type { JsonObject, JsonValue } from "../../core/jsonValue.js";
import type { SchemaInfo } from "../appContext.js";
import type { BundleStatus } from "./bundleStatus.js";
import type { ProjectIntegrationSummary } from "../../upgrade/projectIntegration.js";

export interface ProfileSummary {
  status: string;
  path: string;
  suggested_action?: string;
  days_since_generated?: number;
  stale?: boolean;
  stale_threshold_days?: number;
  generated_date?: string;
  validated_date?: string;
}

export interface V1MigrationSummary {
  detected: boolean;
  affected_files: string[];
  dry_run_command: string | null;
  apply_command: string | null;
  requires_confirmation: boolean;
  update_channel: string;
  local_dry_run_command?: string | null;
  local_apply_command?: string | null;
}

export interface PlanSummary {
  exists: boolean;
  active?: boolean;
  tasks?: JsonObject[];
  status: string;
  title?: string;
  absence_reason?: string;
  constraints?: JsonValue;
  scope?: JsonValue;
  design?: JsonValue;
  complete?: number;
  total?: number;
  complete_plan?: boolean;
  first_pending?: JsonObject | null;
}

export interface DocsSummary {
  exists: boolean;
  status: string;
  absence_reason?: string;
  last_audit?: JsonValue;
  conventions?: JsonObject;
  mapping?: JsonValue[];
  mapping_entries?: number;
  coverage?: JsonObject;
  source_contract?: JsonObject;
  indexed_documents?: number;
}

export interface ProgressSummary {
  exists: boolean;
  status?: string;
  absence_reason?: string;
  latest?: JsonObject;
  latest_verification?: JsonValue;
  cycle_count?: number;
}

export interface HealthSummary {
  exists: boolean;
  number?: string | number;
  date?: string | null;
  timestamp?: string | null;
  trajectory?: string;
  grade?: string;
  worst?: [string, JsonValue, number] | null;
  degrading?: boolean;
  stale?: boolean;
  days_since_audit?: number;
  stale_threshold_days?: number;
  stale_threshold_cycles?: number;
  cycles_since_audit?: number | null;
  triggering_axis?: string;
  suggested_action?: string;
}

export interface ObjectiveSummary {
  exists: boolean;
  active?: boolean;
  closed_count?: number;
  name?: string;
  title?: string;
  status?: string;
  metric?: string;
  target?: string;
}

export interface StatePresenceSummary {
  active: Record<string, boolean>;
  available: Record<string, boolean>;
  any_active: boolean;
  absence_explained: boolean;
  absence: Record<string, string>;
}

export interface IssueCounts {
  critical: number;
  degraded: number;
  normal: number;
  annoying: number;
}

export interface NextAction {
  object: string;
  capability: string;
  reason: string;
  /** Protocol phase tag (PH1-PH5): envision, deliberate, plan, build, or audit. */
  phase: string;
}

/** Ranked state-readiness hint: position 1 (`recommended`) is the cascade winner;
 *  `alternatives` are the branches the early-return cascade would have skipped. */
export interface ReadinessHint {
  recommended: NextAction;
  alternatives: NextAction[];
}

export interface DecisionFollowUp {
  object: string;
  title: string;
}

export interface DecisionReviewEntry {
  number: string | number;
  title: string;
  state: string;
  source: JsonValue;
}

export interface DecisionReviewAttention {
  type: string;
  count: number;
  states: Record<string, number>;
  entries: DecisionReviewEntry[];
  max_entries: number;
  bounded: boolean;
  attention: string;
}

export interface CorpusCoverageGap {
  runtime: string;
  reason: string;
  store_path?: string;
}

export interface CorpusCoverageSummary {
  path: string;
  status: "missing" | "unreadable" | "too_large" | "loaded";
  available_runtimes: string[];
  selected_runtimes: string[];
  available_but_not_selected: CorpusCoverageGap[];
}

/** Internal orientation state assembled by collectOrientationState. */
export interface OrientationState {
  schemas_dir: string;
  schemas: Record<string, SchemaInfo>;
  app: BundleStatus;
  mode: "returning" | "fresh";
  profile_dict: ProfileSummary;
  profile_status: string;
  profile: string;
  v1_migration: V1MigrationSummary;
  project_integration: ProjectIntegrationSummary;
  plan: PlanSummary;
  docs: DocsSummary;
  progress: ProgressSummary;
  health: HealthSummary;
  objective: ObjectiveSummary;
  state_presence: StatePresenceSummary;
  corpus_coverage: CorpusCoverageSummary;
  todo_items: Array<Record<string, string>>;
  counts: IssueCounts;
  decision_attention: DecisionReviewAttention | null;
  next_action: ReadinessHint;
  attention: string[];
}
