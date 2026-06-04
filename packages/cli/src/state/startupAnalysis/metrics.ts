import { type Dict } from "./contract.js";
import {
  inc,
  counterDict,
  nowIsoSeconds,
  flt,
  pyRound,
  safeInt,
} from "./helpers.js";
import { boundedRuntimeStatus } from "./threshold.js";

export const STARTUP_METRICS_ENVELOPE = "startup_state_metrics_v1";
export const TOKEN_ESTIMATOR_VERSION = "approx_bytes_div_4_v1";


function mergeTokenEstimates(counter: Record<string, number>, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [label, estimate] of Object.entries(value)) {
    if (typeof label === "string" && typeof estimate === "number" && Number.isInteger(estimate)) {
      counter[label] = (counter[label] ?? 0) + estimate;
    }
  }
}

function sequenceCount(sequence: Dict, eventClass: string): number {
  const counts = sequence.counts;
  if (counts && typeof counts === "object" && typeof counts[eventClass] === "number") {
    return counts[eventClass];
  }
  return (sequence.events ?? []).filter(
    (event: Dict) => event && typeof event === "object" && event.event_class === eventClass,
  ).length;
}

function distribution(values: number[]): Dict {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p75: 0, histogram: {} };
  }
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number): number => {
    const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction - 1));
    return ordered[Math.max(index, 0)];
  };
  const histCounts: Record<string, number> = {};
  for (const v of ordered) histCounts[v] = (histCounts[v] ?? 0) + 1;
  const histogram: Record<string, number> = {};
  for (const key of Object.keys(histCounts).map(Number).sort((a, b) => a - b)) {
    histogram[String(key)] = histCounts[key];
  }
  return {
    count: ordered.length,
    min: ordered[0],
    max: ordered[ordered.length - 1],
    mean: flt(pyRound(ordered.reduce((a, b) => a + b, 0) / ordered.length, 2)),
    p50: percentile(0.5),
    p75: percentile(0.75),
    histogram,
  };
}

function unionAll(map: Record<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const s of Object.values(map)) for (const v of s) out.add(v);
  return out;
}

function deriveStateThresholds(args: {
  totalSequences: number;
  perCapability: Record<string, Dict>;
  rawAfterCliPerSequence: number[];
  redundantRawPerSequence: number[];
  redundantCounts: Record<string, number>;
  redundantCapabilities: Record<string, Set<string>>;
  confidenceCaveats: string[];
}): Dict {
  const capabilityCount = Object.keys(args.perCapability).length;
  const credibleDistribution = args.totalSequences >= 3;
  const rawDistribution = distribution(args.rawAfterCliPerSequence);
  const redundantDistribution = distribution(args.redundantRawPerSequence);
  const redundantArtifacts: Record<string, Dict> = {};
  for (const label of Object.keys(args.redundantCounts).sort()) {
    const count = args.redundantCounts[label];
    if (count > 0) {
      redundantArtifacts[label] = {
        count,
        capability_count: (args.redundantCapabilities[label] ?? new Set()).size,
      };
    }
  }
  const redundantSequenceCount = args.redundantRawPerSequence.filter((v) => v > 0).length;
  const aggregateRedundantCapabilities =
    Object.keys(args.redundantCapabilities).length > 0 ? unionAll(args.redundantCapabilities) : new Set<string>();

  let redundantSequenceThreshold: number | null;
  let thresholdReason: string;
  if (credibleDistribution) {
    redundantSequenceThreshold = Math.max(2, Math.ceil(args.totalSequences * 0.2));
    thresholdReason =
      "Selected from post-boundary state-gathering distribution: raw artifact " +
      "access after CLI state must recur in at least 20% of measured sequences, " +
      "with a floor of two sequences.";
  } else {
    redundantSequenceThreshold = null;
    thresholdReason = "No broad-envelope threshold: fewer than three state-gathering sequences were measured.";
  }

  let broadTrigger: Dict | null = null;
  if (credibleDistribution) {
    for (const [label, item] of Object.entries(redundantArtifacts)) {
      if (item.count >= (redundantSequenceThreshold as number) && item.capability_count >= 2) {
        broadTrigger = {
          event_class: "raw_artifact_access",
          artifact_label: label,
          count: item.count,
          capability_count: item.capability_count,
          threshold: redundantSequenceThreshold,
        };
        break;
      }
    }
    if (broadTrigger === null && redundantSequenceCount >= (redundantSequenceThreshold as number)) {
      broadTrigger = {
        event_class: "raw_artifact_access",
        artifact_label: "multiple",
        count: redundantSequenceCount,
        capability_count: aggregateRedundantCapabilities.size,
        threshold: redundantSequenceThreshold,
        aggregate: true,
      };
    }
  }

  let recommendation: Dict;
  if (broadTrigger !== null) {
    const trigger = broadTrigger.aggregate
      ? `redundant_raw_artifact_access in ${broadTrigger.count} of ${args.totalSequences} state sequences`
      : `raw_artifact_access_after_cli:${broadTrigger.artifact_label} repeated ` +
        `${broadTrigger.count} times across ${broadTrigger.capability_count} capabilities`;
    recommendation = {
      action: "plan_cli_startup_envelope",
      measured_trigger: trigger,
      rationale: "Raw artifact access after CLI state exceeded the broad startup-envelope threshold.",
    };
  } else if (Object.keys(redundantArtifacts).length > 0) {
    recommendation = {
      action: "targeted_capability_guidance_fixes",
      measured_trigger: "raw_artifact_access_after_cli_hotspot",
      rationale: "Raw artifact access follows CLI state, but evidence is narrow or below the broad-envelope gate.",
    };
  } else {
    recommendation = {
      action: "close_without_implementation",
      measured_trigger: "none",
      rationale: "No raw artifact access after overlapping CLI state was measured.",
    };
  }
  if (args.confidenceCaveats.includes("insufficient_post_2_3_state_sequences")) {
    recommendation = {
      action: "close_without_implementation",
      measured_trigger: "weak_evidence",
      rationale: "No post-boundary Agentera state-gathering sequences were available.",
    };
  }

  return {
    measured_distribution: {
      raw_after_cli_per_sequence: rawDistribution,
      redundant_raw_after_cli_per_sequence: redundantDistribution,
      redundant_sequence_count: redundantSequenceCount,
      redundant_artifacts: redundantArtifacts,
      capability_count: capabilityCount,
    },
    action_thresholds: {
      startup_envelope: {
        credible: credibleDistribution,
        redundant_sequence_threshold: redundantSequenceThreshold,
        selection_reason: thresholdReason,
      },
      targeted_guidance: {
        credible: Object.keys(redundantArtifacts).length > 0,
        selection_reason:
          "Selected when raw artifact access after CLI state is narrow or below the broad-envelope threshold.",
      },
    },
    recommendation,
  };
}

export function aggregateStartupMetrics(intermediateInput: Dict): Dict {
  const intermediate = intermediateInput && typeof intermediateInput === "object" && !Array.isArray(intermediateInput) ? intermediateInput : {};
  const sequences = Array.isArray(intermediate.state_gathering_sequences) ? intermediate.state_gathering_sequences : [];
  const degradations = Array.isArray(intermediate.degradations) ? intermediate.degradations : [];

  const perCapability: Record<string, Dict> = {};
  const cliCommandCounts: Record<string, number> = {};
  const rawAfterCliCounts: Record<string, number> = {};
  const redundantRawCounts: Record<string, number> = {};
  const rawAfterCliTokenEstimates: Record<string, number> = {};
  const redundantRawTokenEstimates: Record<string, number> = {};
  const proseCounts: Record<string, number> = {};
  const implementationCounts: Record<string, number> = {};
  const degradationCounts: Record<string, number> = {};
  const redundantCapabilities: Record<string, Set<string>> = {};
  const rawAfterCliPerSequence: number[] = [];
  const redundantRawPerSequence: number[] = [];

  for (const item of degradations) {
    if (item && typeof item === "object" && typeof item.reason === "string") {
      inc(degradationCounts, item.reason);
    }
  }

  for (const sequence of sequences) {
    if (!sequence || typeof sequence !== "object" || Array.isArray(sequence)) continue;
    let capability = sequence.capability;
    if (typeof capability !== "string" || !capability) capability = "unknown";
    if (!(capability in perCapability)) {
      perCapability[capability] = {
        state_sequences: 0,
        cli_state_call: 0,
        raw_artifact_access_after_cli: 0,
        redundant_raw_artifact_access: 0,
        capability_prose_read: 0,
        implementation_boundary: 0,
      };
    }
    const cc = perCapability[capability];
    cc.state_sequences += 1;
    const cliCount = sequenceCount(sequence, "cli_state_call");
    const rawCount = (sequence.raw_artifact_labels_after_cli ?? []).length;
    const redundantCount = (sequence.redundant_raw_artifact_labels ?? []).length;
    const proseCount = sequenceCount(sequence, "capability_prose_read");
    const implCount = sequenceCount(sequence, "implementation_boundary");
    cc.cli_state_call += cliCount;
    cc.raw_artifact_access_after_cli += rawCount;
    cc.redundant_raw_artifact_access += redundantCount;
    cc.capability_prose_read += proseCount;
    cc.implementation_boundary += implCount;
    proseCounts[capability] = (proseCounts[capability] ?? 0) + proseCount;
    implementationCounts[capability] = (implementationCounts[capability] ?? 0) + implCount;
    rawAfterCliPerSequence.push(rawCount);
    redundantRawPerSequence.push(redundantCount);
    mergeTokenEstimates(rawAfterCliTokenEstimates, sequence.estimated_raw_after_cli_tokens_by_artifact);
    mergeTokenEstimates(redundantRawTokenEstimates, sequence.estimated_redundant_raw_tokens_by_artifact);

    for (const event of sequence.events ?? []) {
      if (!event || typeof event !== "object") continue;
      const stateCommand = event.state_command;
      if (event.event_class === "cli_state_call" && typeof stateCommand === "string") {
        inc(cliCommandCounts, stateCommand);
      }
      const label = event.artifact_label;
      if (event.event_class === "raw_artifact_access" && typeof label === "string") {
        inc(rawAfterCliCounts, label);
        if (event.redundant_with_cli === true) {
          inc(redundantRawCounts, label);
          if (!(label in redundantCapabilities)) redundantCapabilities[label] = new Set();
          redundantCapabilities[label].add(capability);
        }
      }
    }
    for (const reason of sequence.degradation_reasons ?? []) {
      if (typeof reason === "string") inc(degradationCounts, reason);
    }
  }

  const totalSequences = sequences.filter((s: Dict) => s && typeof s === "object" && !Array.isArray(s)).length;
  let runtimeCoverage = Array.isArray(intermediate.runtime_coverage) ? intermediate.runtime_coverage : [];
  runtimeCoverage = runtimeCoverage
    .filter((s: unknown) => s && typeof s === "object" && !Array.isArray(s))
    .map((s: Dict) => boundedRuntimeStatus(s));
  const runtimeStatusCounts: Record<string, number> = {};
  for (const status of runtimeCoverage) {
    if (status && typeof status === "object" && typeof status.status === "string") inc(runtimeStatusCounts, status.status);
  }

  const confidenceCaveats: string[] = [];
  if (totalSequences === 0) confidenceCaveats.push("insufficient_post_2_3_state_sequences");
  if (runtimeCoverage.some((s: Dict) => s && typeof s === "object" && ["missing", "sparse", "degraded", "skipped"].includes(s.status))) {
    confidenceCaveats.push("runtime_coverage_incomplete_or_degraded");
  }
  if (Object.keys(degradationCounts).length > 0) confidenceCaveats.push("some_records_or_sequences_degraded");

  const thresholdDerivation = deriveStateThresholds({
    totalSequences,
    perCapability,
    rawAfterCliPerSequence,
    redundantRawPerSequence,
    redundantCounts: redundantRawCounts,
    redundantCapabilities,
    confidenceCaveats,
  });
  const sequencesWithRaw = rawAfterCliPerSequence.filter((v) => v > 0).length;
  const sequencesWithRedundant = redundantRawPerSequence.filter((v) => v > 0).length;
  const recommendation = thresholdDerivation.recommendation;

  const sortedPerCapability: Record<string, Dict> = {};
  for (const key of Object.keys(perCapability).sort()) sortedPerCapability[key] = perCapability[key];

  const sumValues = (o: Record<string, number>): number => Object.values(o).reduce((a, b) => a + b, 0);

  const result: Dict = {
    output_envelope: STARTUP_METRICS_ENVELOPE,
    input_envelope: intermediate.output_envelope ?? null,
    contract_version: intermediate.contract_version ?? null,
    generated_at: nowIsoSeconds(),
    boundary_source: intermediate.boundary_source ?? null,
    boundary_commit: intermediate.boundary_commit ?? null,
    boundary_committed_at: intermediate.boundary_committed_at ?? null,
    benchmark_mode: intermediate.benchmark_mode || "full_boundary_snapshot",
    benchmark_previous_watermark_at: intermediate.benchmark_previous_watermark_at ?? null,
    benchmark_window_started_after: intermediate.benchmark_window_started_after ?? null,
    benchmark_watermark_at: intermediate.benchmark_watermark_at ?? null,
    corpus_adapter_version: intermediate.corpus_adapter_version ?? null,
    runtime_coverage: runtimeCoverage,
    runtime_status_counts: counterDict(runtimeStatusCounts),
    runtime_record_counts: intermediate.runtime_record_counts || {},
    total_records: safeInt(intermediate.total_records_read),
    total_state_sequences: totalSequences,
    state_sequences_with_raw_after_cli: sequencesWithRaw,
    state_sequences_with_redundant_raw_access: sequencesWithRedundant,
    total_cli_state_calls: sumValues(cliCommandCounts),
    total_raw_artifact_access_after_cli: sumValues(rawAfterCliCounts),
    total_redundant_raw_artifact_accesses: sumValues(redundantRawCounts),
    raw_after_cli_sequence_rate: totalSequences ? flt(pyRound(sequencesWithRaw / totalSequences, 4)) : 0,
    redundant_raw_sequence_rate: totalSequences ? flt(pyRound(sequencesWithRedundant / totalSequences, 4)) : 0,
    per_capability_state_counts: sortedPerCapability,
    cli_state_command_counts: counterDict(cliCommandCounts),
    raw_artifact_access_after_cli_counts: counterDict(rawAfterCliCounts),
    redundant_raw_artifact_access_counts: counterDict(redundantRawCounts),
    token_estimator_version: TOKEN_ESTIMATOR_VERSION,
    estimated_raw_after_cli_tokens: sumValues(rawAfterCliTokenEstimates),
    estimated_redundant_raw_tokens: sumValues(redundantRawTokenEstimates),
    estimated_raw_after_cli_tokens_by_artifact: counterDict(rawAfterCliTokenEstimates),
    estimated_redundant_raw_tokens_by_artifact: counterDict(redundantRawTokenEstimates),
    estimated_tokens_saved_vs_previous: null,
    estimated_tokens_saved_vs_previous_null_reason: "previous_row_missing",
    capability_prose_read_counts: counterDict(proseCounts),
    implementation_boundary_counts: counterDict(implementationCounts),
    degradation_reason_counts: counterDict(degradationCounts),
    privacy_redaction_summary: {
      raw_transcript_text: "not_emitted",
      full_local_paths: "not_emitted",
      raw_store_paths: "not_emitted",
      session_ids: "salted_or_not_emitted",
      artifact_labels: "canonical_only",
    },
    confidence_caveats: confidenceCaveats,
    insufficient_evidence_reason: totalSequences === 0 ? "no_post_2_3_state_sequences" : null,
    threshold_derivation: thresholdDerivation,
    startup_recommendation: recommendation,
    implementation_recommended: recommendation.action === "plan_cli_startup_envelope",
    compatibility_note: "Section 22 corpus records are read-only; aggregation consumes only startup_state_analysis_v1.",
  };
  if (totalSequences) {
    result.recommendation_gate_input = thresholdDerivation.measured_distribution;
  }
  return result;
}
