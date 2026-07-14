/**
 * Compaction shared types: the public envelope shapes used by the
 * status reporting, the apply writers, and the CLI consumers.
 */

import type { ProjectionRecoveryReport } from "../../state/archiveRecovery.js";

export interface CompactResult {
  full_before: number;
  oneline_before: number;
  full_after: number;
  oneline_after: number;
  dropped: number;
  omitted_count?: number;
  omission_reason?: string;
  changed: boolean;
  protected_overflow_count?: number;
  recovery?: ProjectionRecoveryReport;
}

export interface CompactionStatus {
  artifact: string;
  path: string;
  classification: string;
  active_count: number | null;
  archive_count: number | null;
  total_count: number | null;
  over_limit_count: number | null;
  pending_summarization_count?: number | null;
  reason: string;
  protected_overflow_count: number | null;
  exists: boolean;
  projection_state?: "within_defaults" | "over_defaults";
  projection_recovery?: ProjectionRecoveryReport;
}

export interface CompactionOperation {
  status: CompactionStatus;
  mode: string;
  action: string;
  changed: boolean;
  result: CompactResult | null;
  message: string;
}

export interface ArtifactSpec {
  name: string;
  entryHeadingRe: RegExp;
  archiveHeading: string | null;
  formatOneline: (entry: any) => string;
  onelineHeadingRe: RegExp | null;
  scopedSection: string | null;
}
