declare module "*scripts/performance-evidence.mjs" {
  export interface LatencyAdvisoryEntry {
    targetMs: number;
    maxObservedMs: number;
    exceededRepetitions: number;
  }
  export type LatencyAdvisory = Record<string, LatencyAdvisoryEntry>;
  export interface PerformanceTarget {
    max_latency_ms: number;
    max_heap_delta_bytes: number;
    max_utf8_bytes?: number;
    serialized_limits?: string;
  }
  export interface PerformanceAuthority {
    entity_target: {
      measurement_contract: {
        enforcement: { latency: string; heap: string; bytes: string };
        fixtures: Record<string, string>;
        sampling: {
          repetitions: number;
          elapsed: string;
          heap: string;
          bytes: string;
          heap_baseline: {
            boundary: string;
            normalization: string;
            measured_operation_collection: string;
          };
        };
        targets: Record<string, PerformanceTarget>;
      };
    };
    budgets: { startup: { surfaces: { prime_dashboard: { max_utf8_bytes: number } } } };
  }
  export interface PerformanceDefinition {
    execution?: {
      workers: number;
      authoritative_runner?: {
        provider: string;
        runs_on: string;
        runner_class: string;
        runner_class_environment: string;
        runner_identity_environment: string;
        actions_environment: string;
        platform: string;
        architecture: string;
      };
    };
    evidence: {
      stdout_format: string;
      schema_version: string;
      authority: string;
      max_utf8_bytes: number;
    };
  }
  export interface NormalizedPerformanceEvidence {
    samples: number;
    maxima: Record<
      string,
      {
        repetitions: number;
        maxElapsedMs: number;
        maxHeapDeltaBytes: number;
        maxOutputBytes: number;
      }
    >;
    latencyAdvisory?: LatencyAdvisory;
  }
  export const EFFECTIVE_NODE_OPTIONS_UTF8_LIMIT: 512;
  export function performanceAuthority(root: string): PerformanceAuthority;
  export function deriveLatencyAdvisory(samples: ReadonlyArray<Record<string, number | string>>, targets: Record<string, PerformanceTarget>): LatencyAdvisory;
  export function normalizedLatencyAdvisory(evidence: NormalizedPerformanceEvidence, authority: PerformanceAuthority): LatencyAdvisory;
  export function validatePerformanceEvidence(stdout: string, definition: PerformanceDefinition, root: string): string[];
  export function performanceEvidenceRecords(stdout: string, schemaVersion: string): Array<Record<string, unknown>>;
  export function effectiveChildFlagsAreComplete(flags: unknown): boolean;
  export function performanceRunnerAuthority(
    environment: Record<string, string | undefined>,
    definition: Pick<PerformanceDefinition, "execution">,
    runtime: { platform: string; architecture: string },
  ): {
    authoritative: boolean;
    provider: string;
    class: string | null;
    identity: string | null;
    actions: boolean;
    workers: number;
  };
}
