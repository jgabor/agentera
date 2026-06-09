import fs from "node:fs";
import path from "node:path";

import { type Dict } from "./contract.js";
import { pyJsonIndentSorted } from "../../core/pyjson.js";
import { Flt, formatFloat, pyFmt, pyJsonDumps, pyJsonString } from "./helpers.js";

export const STARTUP_REPORT_MARKDOWN = "startup-overhead-report.md";
export const STARTUP_REPORT_JSON = "startup-overhead-report.json";

function startupJsonScalar(value: unknown): string | undefined {
  if (value instanceof Flt) return formatFloat(value.v);
  return undefined;
}

function pyJsonIndent(value: unknown, level = 0, indent = "  "): string {
  return pyJsonIndentSorted(value, indent.length || 2, level, startupJsonScalar);
}

function markdownTable(headers: string[], rows: Array<Array<unknown>>): string[] {
  const lines = [
    "| " + headers.join(" | ") + " |",
    "| " + headers.map(() => "---").join(" | ") + " |",
  ];
  if (rows.length === 0) {
    return [...lines, "| " + headers.map(() => "none").join(" | ") + " |"];
  }
  return [...lines, ...rows.map((row) => "| " + row.map((v) => pyFmt(v)).join(" | ") + " |")];
}

export function renderStartupReport(metrics: Dict): string {
  const threshold = (metrics.threshold_derivation ?? {}).action_thresholds ?? {};
  const envelopeThreshold = threshold.startup_envelope ?? {};
  const guidanceThreshold = threshold.targeted_guidance ?? {};
  const recommendation = metrics.startup_recommendation ?? {};
  const measuredDistribution = (metrics.threshold_derivation ?? {}).measured_distribution ?? {};
  const runtimeCoverage = Array.isArray(metrics.runtime_coverage) ? metrics.runtime_coverage : [];
  const capabilityCounts = metrics.per_capability_state_counts ?? {};

  const lines: string[] = [
    "# Agentera Startup State-Access Analysis",
    "",
    "This report is local-only and privacy-preserving. It measures raw Agentera artifact access after CLI state calls during capability startup/state gathering.",
    "",
    "## Boundary Source",
    "",
    `- Contract version: \`${pyFmt(metrics.contract_version)}\``,
    `- Boundary source: \`${pyFmt(metrics.boundary_source)}\``,
    `- Boundary commit: \`${pyFmt(metrics.boundary_commit)}\``,
    `- Boundary timestamp: \`${pyFmt(metrics.boundary_committed_at)}\``,
    `- Corpus adapter version: \`${pyFmt(metrics.corpus_adapter_version)}\``,
    "",
    "## Benchmark Window",
    "",
    `- Mode: \`${pyFmt(metrics.benchmark_mode)}\``,
    `- Previous watermark: \`${pyFmt(metrics.benchmark_previous_watermark_at)}\``,
    `- Window started after: \`${pyFmt(metrics.benchmark_window_started_after)}\``,
    `- Watermark: \`${pyFmt(metrics.benchmark_watermark_at)}\``,
    "",
    "## Runtime Coverage",
    "",
  ];
  const runtimeRows: Array<Array<unknown>> = [];
  for (const status of runtimeCoverage) {
    if (status && typeof status === "object" && !Array.isArray(status)) {
      runtimeRows.push([
        status.runtime ?? "unknown",
        status.status ?? "unknown",
        status.reason ?? "unknown",
        status.record_count ?? 0,
        status.candidate_count ?? 0,
        status.error_count ?? 0,
      ]);
    }
  }
  lines.push(...markdownTable(["Runtime", "Status", "Reason", "Records", "Candidates", "Errors"], runtimeRows));
  lines.push(
    "",
    "## Metrics",
    "",
    `- Total state-gathering sequences: \`${pyFmt(metrics.total_state_sequences)}\``,
    `- Sequences with raw artifact access after CLI: \`${pyFmt(metrics.state_sequences_with_raw_after_cli)}\``,
    `- Sequences with redundant raw artifact access: \`${pyFmt(metrics.state_sequences_with_redundant_raw_access)}\``,
    `- Raw-after-CLI sequence rate: \`${pyFmt(metrics.raw_after_cli_sequence_rate)}\``,
    `- Redundant raw sequence rate: \`${pyFmt(metrics.redundant_raw_sequence_rate)}\``,
    `- CLI state command counts: \`${pyJsonDumps(metrics.cli_state_command_counts ?? {})}\``,
    `- Raw artifact access after CLI counts: \`${pyJsonDumps(metrics.raw_artifact_access_after_cli_counts ?? {})}\``,
    `- Redundant raw artifact access counts: \`${pyJsonDumps(metrics.redundant_raw_artifact_access_counts ?? {})}\``,
    "",
    "## Estimated Token Impact",
    "",
    `- Token estimator version: \`${pyFmt(metrics.token_estimator_version)}\``,
    `- Estimated raw-after-CLI tokens: \`${pyFmt(metrics.estimated_raw_after_cli_tokens)}\``,
    `- Estimated redundant raw tokens: \`${pyFmt(metrics.estimated_redundant_raw_tokens)}\``,
    `- Estimated raw-after-CLI tokens by artifact: \`${pyJsonDumps(metrics.estimated_raw_after_cli_tokens_by_artifact ?? {})}\``,
    `- Estimated redundant raw tokens by artifact: \`${pyJsonDumps(metrics.estimated_redundant_raw_tokens_by_artifact ?? {})}\``,
    `- Estimated tokens saved vs previous: \`${pyFmt(metrics.estimated_tokens_saved_vs_previous)}\``,
    `- Estimated tokens saved null reason: \`${pyFmt(metrics.estimated_tokens_saved_vs_previous_null_reason)}\``,
    "",
  );
  const capabilityRows: Array<Array<unknown>> = [];
  for (const capability of Object.keys(capabilityCounts).sort()) {
    const counts = capabilityCounts[capability];
    if (counts && typeof counts === "object" && !Array.isArray(counts)) {
      capabilityRows.push([
        capability,
        counts.state_sequences ?? 0,
        counts.cli_state_call ?? 0,
        counts.raw_artifact_access_after_cli ?? 0,
        counts.redundant_raw_artifact_access ?? 0,
        counts.capability_prose_read ?? 0,
      ]);
    }
  }
  lines.push(
    ...markdownTable(
      ["Capability", "Sequences", "CLI Calls", "Raw After CLI", "Redundant Raw", "Prose Reads"],
      capabilityRows,
    ),
  );
  lines.push(
    "",
    "## Threshold Rationale",
    "",
    `- Startup envelope threshold credible: \`${pyFmt(envelopeThreshold.credible)}\``,
    `- Redundant-sequence threshold: \`${pyFmt(envelopeThreshold.redundant_sequence_threshold)}\``,
    `- Startup envelope selection reason: ${pyFmt(envelopeThreshold.selection_reason)}`,
    `- Targeted-guidance selection reason: ${pyFmt(guidanceThreshold.selection_reason)}`,
    `- Measured distribution: \`${pyJsonDumps(measuredDistribution)}\``,
    "",
    "## Recommendation",
    "",
    `- Action: \`${pyFmt(recommendation.action)}\``,
    `- Measured trigger: \`${pyFmt(recommendation.measured_trigger)}\``,
    `- Rationale: ${pyFmt(recommendation.rationale)}`,
    `- Implementation recommended: \`${pyFmt(metrics.implementation_recommended)}\``,
    "",
    "## Privacy Caveats",
    "",
    "- Raw transcript text is not emitted.",
    "- Full local paths and raw store paths are not emitted.",
    "- Session identifiers are salted or omitted.",
    "- Raw artifact accesses use canonical artifact_id labels such as `plan`, not filesystem paths.",
    "- Runtime coverage may be incomplete or degraded; inspect `confidence_caveats` before selecting follow-up work.",
    "",
  );
  return lines.join("\n");
}

export function writeStartupReports(metrics: Dict, outputDir: string): Record<string, string> {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, STARTUP_REPORT_JSON);
  const markdownPath = path.join(outputDir, STARTUP_REPORT_MARKDOWN);
  fs.writeFileSync(jsonPath, pyJsonIndent(metrics) + "\n");
  fs.writeFileSync(markdownPath, renderStartupReport(metrics));
  return { structured: jsonPath, human_readable: markdownPath };
}

// ===========================================================================
// Slice 6: benchmark persistence + intermediate building + corpus-file extraction
// (extract_*_from_runtime_stores depends on extract_corpus and lands in Phase 10)
// ===========================================================================
