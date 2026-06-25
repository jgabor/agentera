import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { capabilityContext } from "./contract.js";
import { sourceProvenance, uniqueList } from "./shared.js";
import type { Dict, Env } from "./types.js";

export const BENCHMARK_CONTEXT_CMD = "agentera prime --context optimize --format json";
export const BENCHMARK_LATEST_REPORT_LABEL = "startup_benchmark_latest_report";
export const BENCHMARK_HISTORY_LABEL = "startup_benchmark_history";
export const BENCHMARK_CONTEXT_SOURCE_LABELS = [BENCHMARK_LATEST_REPORT_LABEL, BENCHMARK_HISTORY_LABEL];
export const BENCHMARK_TOKEN_NULL_REASONS = [
  "previous_row_missing", "previous_missing_token_estimates", "estimator_version_mismatch",
  "runtime_scope_mismatch", "benchmark_mode_mismatch", "contract_version_mismatch",
];
export const BENCHMARK_RECOMMENDATION_ACTIONS = new Set([
  "plan_cli_startup_envelope", "targeted_capability_guidance_fixes", "close_without_implementation",
]);
export const BENCHMARK_CAVEATED_RUNTIME_STATUSES = new Set(["degraded", "missing", "skipped", "locked", "unreadable"]);
export const BENCHMARK_FORBIDDEN_OUTPUTS = [
  "raw_transcripts", "raw_corpus_files", "raw_intermediates", "raw_runtime_store_paths", "raw_session_ids",
  "private_salts", "generated_salted_hashes", "raw_benchmark_report_bodies", "full_local_benchmark_paths",
];
export const BENCHMARK_SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .:_-]{0,79}$/;
export const BENCHMARK_SAFE_SCALAR_RE = /^[A-Za-z0-9][A-Za-z0-9 .:_+@-]{0,119}$/;
export const HEX16_RE = /^[0-9a-fA-F]{16,}$/;

export function agenteraDataHome(env: Env = process.env): string {
  const override = env.AGENTERA_HOME;
  if (override) return override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agentera");
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "agentera");
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "agentera");
}

export function startupBenchmarkDir(): string {
  return path.join(agenteraDataHome(), "benchmarks", "startup-state");
}

export function safeBenchmarkNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return value;
  return null;
}

export function safeBenchmarkLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || label.includes("/") || label.includes("\\")) return null;
  if (HEX16_RE.test(label)) return null;
  if (!BENCHMARK_SAFE_LABEL_RE.test(label)) return null;
  return label;
}

export function safeBenchmarkScalar(value: unknown, field: string, allowed: Set<string> | null = null): [string | null, string[]] {
  if (value === null || value === undefined) return [null, []];
  if (typeof value !== "string") return [null, [`${field} was omitted because it is not a bounded string value.`]];
  const text = value.trim();
  if (allowed !== null && !allowed.has(text)) return [null, [`${field} was omitted because it is not a supported bounded value.`]];
  if (!text || text.includes("/") || text.includes("\\") || HEX16_RE.test(text)) return [null, [`${field} was omitted at the benchmark privacy boundary.`]];
  if (!BENCHMARK_SAFE_SCALAR_RE.test(text)) return [null, [`${field} was omitted because it is outside the bounded scalar contract.`]];
  return [text, []];
}

export function safeBenchmarkLabelCounts(value: unknown, family: string): [Record<string, number>, string[]] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{}, []];
  const counts: Record<string, number> = {};
  let dropped = 0;
  for (const [key, rawCount] of Object.entries(value as Dict)) {
    const label = safeBenchmarkLabel(key);
    const count = safeBenchmarkNumber(rawCount);
    if (label === null || count === null) {
      dropped += 1;
      continue;
    }
    counts[label] = count;
  }
  const caveats: string[] = [];
  if (dropped) caveats.push(`${family} omitted ${dropped} unsafe label(s) at the benchmark privacy boundary.`);
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  return [sorted, caveats];
}

export function readBenchmarkJson(p: string, label: string): [string, Dict | null, string[]] {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return ["missing", null, [`${label} is missing from retained startup benchmark evidence.`]];
    return ["unreadable", null, [`${label} could not be read by the CLI.`]];
  }
  if (!text.trim()) return ["empty", null, [`${label} is empty.`]];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return ["malformed", null, [`${label} is malformed JSON.`]];
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data as Dict).length === 0) {
    return ["empty", null, [`${label} did not contain a non-empty JSON object.`]];
  }
  return ["available", data as Dict, []];
}

export function readBenchmarkHistory(p: string): [string, Dict[], string[]] {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return ["missing", [], [`${BENCHMARK_HISTORY_LABEL} is missing from retained startup benchmark evidence.`]];
    return ["unreadable", [], [`${BENCHMARK_HISTORY_LABEL} could not be read by the CLI.`]];
  }
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim());
  if (lines.length === 0) return ["empty", [], ["Startup benchmark aggregate history exists but has no rows."]];
  const rows: Dict[] = [];
  let malformed = 0;
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (row && typeof row === "object" && !Array.isArray(row)) rows.push(row as Dict);
    else malformed += 1;
  }
  if (malformed) return ["malformed", rows, [`Startup benchmark aggregate history has ${malformed} malformed row(s).`]];
  if (rows.length === 0) return ["empty", [], ["Startup benchmark aggregate history has no usable rows."]];
  return ["available", rows, []];
}

export function latestBenchmarkSummary(status: string, report: Dict | null, caveats: string[]): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "latest_report");
  if (status !== "available" || report === null) {
    return {
      status, source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      non_empty_evidence_present: false, contract_version: null, generated_at: null, benchmark_mode: null,
      benchmark_window: {}, total_records: null, total_state_sequences: null, caveats,
    };
  }
  const sc = [...caveats];
  const scalar = (key: string) => {
    const [v, c] = safeBenchmarkScalar(report[key], `latest_report.${key}`);
    sc.push(...c);
    return v;
  };
  const contractVersion = scalar("contract_version");
  const generatedAt = scalar("generated_at");
  const benchmarkMode = scalar("benchmark_mode");
  const previousWatermark = scalar("benchmark_previous_watermark_at");
  const windowStarted = scalar("benchmark_window_started_after");
  const watermarkAt = scalar("benchmark_watermark_at");
  const totalStateSequences = safeBenchmarkNumber(report.total_state_sequences);
  if (totalStateSequences === null) sc.push("Latest startup benchmark report is missing total_state_sequences.");
  return {
    status: "available", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: true, contract_version: contractVersion, generated_at: generatedAt,
    benchmark_mode: benchmarkMode,
    benchmark_window: { previous_watermark_at: previousWatermark, window_started_after: windowStarted, watermark_at: watermarkAt },
    total_records: safeBenchmarkNumber(report.total_records), total_state_sequences: totalStateSequences, caveats: sc,
  };
}

export function historyBenchmarkSummary(status: string, rows: Dict[], caveats: string[]): Dict {
  const latest = rows.length > 0 ? rows[rows.length - 1] : null;
  let latestSummary: Dict | null = null;
  const sc = [...caveats];
  if (latest) {
    const runtimeScope = Array.isArray(latest.runtime_scope) ? latest.runtime_scope : [];
    const safeScope = runtimeScope.map((v: unknown) => safeBenchmarkLabel(v)).filter((l): l is string => l !== null);
    if (safeScope.length !== runtimeScope.length) sc.push("Startup benchmark history omitted unsafe runtime-scope label(s).");
    const scalar = (key: string, allowed: Set<string> | null = null) => {
      const [v, c] = safeBenchmarkScalar(latest[key], `history_summary.latest_row.${key}`, allowed);
      sc.push(...c);
      return v;
    };
    const generatedAt = scalar("generated_at");
    const agenteraVersion = scalar("agentera_version");
    const benchmarkMode = scalar("benchmark_mode");
    const recommendationAction = scalar("startup_recommendation_action", BENCHMARK_RECOMMENDATION_ACTIONS);
    latestSummary = {
      generated_at: generatedAt, agentera_version: agenteraVersion, runtime_scope: safeScope,
      benchmark_mode: benchmarkMode, total_state_sequences: safeBenchmarkNumber(latest.total_state_sequences),
      raw_after_cli_rate: safeBenchmarkNumber(latest.raw_after_cli_rate),
      redundant_raw_access_rate: safeBenchmarkNumber(latest.redundant_raw_access_rate),
      startup_recommendation_action: recommendationAction,
    };
  }
  return {
    status, source_label: BENCHMARK_HISTORY_LABEL,
    source_provenance: sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "history_summary"),
    non_empty_evidence_present: rows.length > 0, row_count: rows.length, latest_row: latestSummary, caveats: sc,
  };
}

export function runtimeBenchmarkCoverage(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "runtime_coverage");
  const miss = (caveat: string): Dict => ({
    status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: false, items: [], status_counts: {}, caveats: [caveat],
  });
  if (reportStatus !== "available" || report === null) return miss("Runtime coverage is unavailable without a valid latest startup benchmark report.");
  const rawItems = report.runtime_coverage;
  if (!Array.isArray(rawItems)) return miss("Latest startup benchmark report has no runtime_coverage list.");
  const items: Dict[] = [];
  let caveats: string[] = [];
  const statusCounts: Record<string, number> = {};
  for (const raw of rawItems.slice(0, 12)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      caveats.push("Runtime coverage omitted a non-object item.");
      continue;
    }
    const runtime = safeBenchmarkLabel(raw.runtime);
    let status = safeBenchmarkLabel(raw.status);
    const reason = safeBenchmarkLabel(raw.reason);
    if (runtime === null) {
      caveats.push("Runtime coverage omitted an unsafe runtime label.");
      continue;
    }
    status = status || "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const item: Dict = { runtime, status };
    if (reason) item.reason = reason;
    for (const key of ["record_count", "file_count", "error_count"]) {
      const number = safeBenchmarkNumber(raw[key]);
      if (number !== null) item[key] = number;
    }
    items.push(item);
  }
  if (rawItems.length > items.length) caveats.push("Runtime coverage summary is bounded and may omit invalid or excess rows.");
  const caveatedStatuses = [...new Set(items.map((i) => String(i.status)).filter((s) => BENCHMARK_CAVEATED_RUNTIME_STATUSES.has(s)))].sort();
  let statusValue: string;
  if (caveatedStatuses.length > 0) {
    statusValue = "degraded";
    caveats.push(
      "One or more runtime stores are missing, skipped, locked, unreadable, or degraded; " +
        "treat this as benchmark evidence caveat, not successful product behavior.",
    );
  } else if (items.some((i) => i.status === "sparse")) {
    statusValue = "sparse";
    caveats.push("One or more runtime stores are sparse; benchmark coverage is caveated.");
  } else if (items.length > 0) {
    statusValue = "available";
  } else {
    statusValue = "missing";
    caveats.push("Runtime coverage has no usable bounded rows.");
  }
  const sortedCounts: Record<string, number> = {};
  for (const k of Object.keys(statusCounts).sort()) sortedCounts[k] = statusCounts[k];
  return {
    status: statusValue, source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: items.length > 0, items, status_counts: sortedCounts, caveats: uniqueList(caveats),
  };
}

export function stateAccessBenchmarkMetrics(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "state_access_metrics");
  if (reportStatus !== "available" || report === null) {
    return {
      status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      non_empty_evidence_present: false,
      caveats: ["State-access metrics are unavailable without a valid latest startup benchmark report."],
    };
  }
  const caveats: string[] = [];
  const [cliCounts, c1] = safeBenchmarkLabelCounts(report.cli_state_command_counts, "cli_state_command_counts");
  const [rawCounts, c2] = safeBenchmarkLabelCounts(report.raw_artifact_access_after_cli_counts, "raw_artifact_access_after_cli_counts");
  const [redundantCounts, c3] = safeBenchmarkLabelCounts(report.redundant_raw_artifact_access_counts, "redundant_raw_artifact_access_counts");
  const [capabilityCounts, c4] = safeBenchmarkLabelCounts(report.per_capability_state_counts, "per_capability_state_counts");
  caveats.push(...c1, ...c2, ...c3, ...c4);
  const required: Record<string, number | null> = {
    total_state_sequences: safeBenchmarkNumber(report.total_state_sequences),
    state_sequences_with_raw_after_cli: safeBenchmarkNumber(report.state_sequences_with_raw_after_cli),
    state_sequences_with_redundant_raw_access: safeBenchmarkNumber(report.state_sequences_with_redundant_raw_access),
    raw_after_cli_sequence_rate: safeBenchmarkNumber(report.raw_after_cli_sequence_rate),
    redundant_raw_sequence_rate: safeBenchmarkNumber(report.redundant_raw_sequence_rate),
  };
  const missing = Object.entries(required).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length > 0) caveats.push(`Latest startup benchmark report is missing state-access metric fields: ${missing.join(", ")}.`);
  if (required.total_state_sequences === 0) caveats.push("Startup benchmark observed zero state-gathering sequences; optimization conclusions are weak.");
  return {
    status: missing.length > 0 ? "incomplete" : "available",
    source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: missing.length === 0,
    ...required,
    total_cli_state_calls: safeBenchmarkNumber(report.total_cli_state_calls),
    total_raw_artifact_access_after_cli: safeBenchmarkNumber(report.total_raw_artifact_access_after_cli),
    total_redundant_raw_artifact_accesses: safeBenchmarkNumber(report.total_redundant_raw_artifact_accesses),
    cli_state_command_counts: cliCounts,
    raw_artifact_access_after_cli_counts: rawCounts,
    redundant_raw_artifact_access_counts: redundantCounts,
    per_capability_state_counts: capabilityCounts,
    caveats: uniqueList(caveats),
  };
}

export function tokenBenchmarkImpact(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "token_impact");
  if (reportStatus !== "available" || report === null) {
    return {
      status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      non_empty_evidence_present: false,
      caveats: ["Token-impact estimates are unavailable without a valid latest startup benchmark report."],
    };
  }
  const [rawByArtifact, rawCaveats] = safeBenchmarkLabelCounts(report.estimated_raw_after_cli_tokens_by_artifact, "estimated_raw_after_cli_tokens_by_artifact");
  const [redundantByArtifact, redundantCaveats] = safeBenchmarkLabelCounts(report.estimated_redundant_raw_tokens_by_artifact, "estimated_redundant_raw_tokens_by_artifact");
  const [estimatorVersion, estimatorCaveats] = safeBenchmarkScalar(report.token_estimator_version, "token_impact.token_estimator_version");
  const required: Record<string, unknown> = {
    token_estimator_version: estimatorVersion,
    estimated_raw_after_cli_tokens: safeBenchmarkNumber(report.estimated_raw_after_cli_tokens),
    estimated_redundant_raw_tokens: safeBenchmarkNumber(report.estimated_redundant_raw_tokens),
  };
  const missing = Object.entries(required).filter(([, v]) => v === null || v === undefined || v === "").map(([k]) => k);
  const caveats = [...rawCaveats, ...redundantCaveats, ...estimatorCaveats];
  if (missing.length > 0) caveats.push(`Latest startup benchmark report is missing token-impact fields: ${missing.join(", ")}.`);
  return {
    status: missing.length > 0 ? "missing" : "available",
    source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    non_empty_evidence_present: missing.length === 0,
    ...required,
    estimated_raw_after_cli_tokens_by_artifact: rawByArtifact,
    estimated_redundant_raw_tokens_by_artifact: redundantByArtifact,
    caveats: uniqueList(caveats),
  };
}

export function benchmarkComparison(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "comparison");
  if (reportStatus !== "available" || report === null) {
    return {
      status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
      estimated_tokens_saved_vs_previous: null, null_reason: null, allowed_null_reasons: BENCHMARK_TOKEN_NULL_REASONS,
      caveats: ["Benchmark comparison is unavailable without a valid latest startup benchmark report."],
    };
  }
  const saved = report.estimated_tokens_saved_vs_previous;
  const reason = report.estimated_tokens_saved_vs_previous_null_reason;
  let status: string;
  let caveats: string[];
  if (safeBenchmarkNumber(saved) !== null) {
    status = "comparable";
    caveats = [];
  } else if (BENCHMARK_TOKEN_NULL_REASONS.includes(reason)) {
    status = "not_comparable";
    caveats = [`Benchmark comparison is not comparable: ${reason}.`];
  } else {
    status = "missing";
    caveats = ["Benchmark comparison status is missing from latest startup benchmark report."];
  }
  return {
    status, source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    estimated_tokens_saved_vs_previous: safeBenchmarkNumber(saved),
    null_reason: BENCHMARK_TOKEN_NULL_REASONS.includes(reason) ? reason : null,
    allowed_null_reasons: BENCHMARK_TOKEN_NULL_REASONS, caveats,
  };
}

export function benchmarkRecommendation(reportStatus: string, report: Dict | null): Dict {
  const source = sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "recommendation");
  const miss = (caveat: string): Dict => ({
    status: "missing", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    action: null, measured_trigger: null, rationale: null, rationale_present: false,
    rationale_boundary: "not_emitted_from_retained_report", implementation_recommended: false, caveats: [caveat],
  });
  if (reportStatus !== "available" || report === null) return miss("Startup benchmark recommendation is unavailable without a valid latest report.");
  const recommendation = report.startup_recommendation;
  if (!recommendation || typeof recommendation !== "object" || Array.isArray(recommendation)) {
    return miss("Latest startup benchmark report has no startup_recommendation object.");
  }
  const rec = recommendation as Dict;
  const caveats: string[] = [];
  let action = rec.action;
  if (!BENCHMARK_RECOMMENDATION_ACTIONS.has(action)) {
    action = "omitted_by_privacy_boundary";
    caveats.push("Startup benchmark recommendation action was omitted because it is not a supported bounded value.");
  }
  let trigger = rec.measured_trigger;
  if (typeof trigger === "string" && safeBenchmarkLabel(trigger) === null) {
    trigger = "omitted_by_privacy_boundary";
    caveats.push("Startup benchmark recommendation trigger was omitted at the privacy boundary.");
  } else if (typeof trigger !== "string") {
    trigger = null;
  }
  const rationalePresent = typeof rec.rationale === "string" && rec.rationale.trim().length > 0;
  if (rationalePresent) caveats.push("Startup benchmark recommendation rationale is present but not emitted from retained benchmark JSON.");
  return {
    status: "available", source_label: BENCHMARK_LATEST_REPORT_LABEL, source_provenance: source,
    action, measured_trigger: trigger, rationale: null, rationale_present: rationalePresent,
    rationale_boundary: "not_emitted_from_retained_report",
    implementation_recommended: Boolean(report.implementation_recommended), caveats,
  };
}

export function benchmarkManualRefresh(complete: boolean, latestReport: Dict, stateMetrics: Dict): Dict {
  const caveats = ["The CLI did not run `mage bench:startupState`; benchmark refresh is manual-only by design."];
  let status: string;
  if (["missing", "empty", "malformed", "unreadable"].includes(latestReport.status)) {
    status = "requires_manual_run";
    caveats.push("Retained startup benchmark evidence is absent or invalid; run the manual benchmark before using it for optimization decisions.");
  } else if (stateMetrics.total_state_sequences === 0) {
    status = "requires_manual_run";
    caveats.push("Retained startup benchmark evidence has zero state-gathering sequences; refresh or gather better evidence before optimizing from it.");
  } else if (complete) {
    status = "available";
  } else {
    status = "requires_manual_run";
  }
  return { status, command: "mage bench:startupState", execution_status: "not_run_by_design", auto_run: false, caveats: uniqueList(caveats) };
}

export function benchmarkPrivacyBoundary(): Dict {
  return {
    status: "enforced",
    source_provenance: sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "privacy_boundary"),
    user_local_benchmark_reads: "cli_internal_summary_only",
    normal_agent_file_reads: "last_resort_diagnostics_only",
    raw_paths_emitted: false, raw_report_bodies_emitted: false, forbidden_outputs: BENCHMARK_FORBIDDEN_OUTPUTS,
    allowed_outputs: [
      "canonical source labels", "canonical runtime labels", "canonical artifact labels",
      "bounded counts and rates", "token estimate aggregates", "comparison null reasons", "manual refresh command",
    ],
  };
}

export function optimeraBenchmarkContext(capability: string | null): Dict | null {
  if (capability !== "optimize") return null;
  const benchmarkDir = startupBenchmarkDir();
  const [latestStatus, latestData, latestCaveats] = readBenchmarkJson(path.join(benchmarkDir, "latest-report.json"), BENCHMARK_LATEST_REPORT_LABEL);
  const [historyStatus, historyRows, historyCaveats] = readBenchmarkHistory(path.join(benchmarkDir, "runs.jsonl"));
  const latestReport = latestBenchmarkSummary(latestStatus, latestData, latestCaveats);
  const historySummary = historyBenchmarkSummary(historyStatus, historyRows, historyCaveats);
  const runtimeCoverage = runtimeBenchmarkCoverage(latestStatus, latestData);
  const stateMetrics = stateAccessBenchmarkMetrics(latestStatus, latestData);
  const tokenImpact = tokenBenchmarkImpact(latestStatus, latestData);
  const comparison = benchmarkComparison(latestStatus, latestData);
  const recommendation = benchmarkRecommendation(latestStatus, latestData);
  const privacyBoundary = benchmarkPrivacyBoundary();
  const requiredState: Record<string, boolean> = {
    latest_report: latestReport.status === "available" && Boolean(latestReport.non_empty_evidence_present),
    history_summary: ["available", "empty"].includes(historySummary.status),
    runtime_coverage: runtimeCoverage.status !== "missing",
    state_access_metrics: stateMetrics.status === "available",
    token_impact_status: ["available", "missing"].includes(tokenImpact.status),
    recommendation_status: ["available", "missing"].includes(recommendation.status),
    source_contract: true,
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([k]) => k);
  const complete = missingRequired.length === 0;
  const manualRefresh = benchmarkManualRefresh(complete, latestReport, stateMetrics);
  const benchmarkSourceCaveats = [...latestCaveats, ...historyCaveats];
  const retainedOutputs = [
    { source_label: BENCHMARK_LATEST_REPORT_LABEL, filename: "latest-report.json", status: latestStatus },
    { source_label: BENCHMARK_HISTORY_LABEL, filename: "runs.jsonl", status: historyStatus },
    { source_label: "startup_benchmark_latest_markdown", filename: "latest-report.md", status: "not_read_by_context" },
  ];
  const caveats = uniqueList([
    ...benchmarkSourceCaveats,
    ...((latestReport.caveats ?? []) as string[]),
    ...((historySummary.caveats ?? []) as string[]),
    ...((runtimeCoverage.caveats ?? []) as string[]),
    ...((stateMetrics.caveats ?? []) as string[]),
    ...((tokenImpact.caveats ?? []) as string[]),
    ...((comparison.caveats ?? []) as string[]),
    ...((recommendation.caveats ?? []) as string[]),
    ...((manualRefresh.caveats ?? []) as string[]),
  ]);
  const fallbackCommands = ["agentera state docs --format json", "agentera state query --list-artifacts --format json"];
  return {
    capability: "optimize",
    benchmark_source: {
      status: latestStatus === "available" && ["available", "empty"].includes(historyStatus) ? "available" : "incomplete",
      source_provenance: sourceProvenance("benchmark_context", BENCHMARK_CONTEXT_CMD, "benchmark_source"),
      retained_outputs: retainedOutputs,
      non_empty_evidence_present: Boolean(latestReport.non_empty_evidence_present) || Boolean(historySummary.non_empty_evidence_present),
      normal_read_policy: "Agents consume this CLI summary first; direct retained benchmark file reads are last-resort diagnostics.",
      caveats: benchmarkSourceCaveats,
    },
    latest_report: latestReport,
    history_summary: historySummary,
    runtime_coverage: runtimeCoverage,
    state_access_metrics: stateMetrics,
    token_impact: tokenImpact,
    comparison,
    recommendation,
    manual_refresh: manualRefresh,
    privacy_boundary: privacyBoundary,
    state_family_caveats: caveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_benchmark_context: complete,
      caveated: caveats.length > 0,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this benchmark_context from `agentera prime --context optimize --format json` first. " +
        "If incomplete, follow fallback_commands and manual_refresh before any last-resort direct latest-report.json, " +
        "latest-report.md, or runs.jsonl diagnostic read.",
      benchmark_state_families: [
        "latest_report", "history_summary", "runtime_coverage", "state_access_metrics", "token_impact",
        "comparison", "recommendation", "manual_refresh", "privacy_boundary",
      ],
      required_benchmark_state: requiredState,
      missing_required_benchmark_state: missingRequired,
      source_labels: BENCHMARK_CONTEXT_SOURCE_LABELS,
      fallback_commands: fallbackCommands,
      manual_refresh_status: manualRefresh.status,
      privacy_boundary: { raw_paths_emitted: false, raw_report_bodies_emitted: false, forbidden_outputs: BENCHMARK_FORBIDDEN_OUTPUTS },
      caveats,
      owns: [
        "retained startup benchmark source status",
        "latest report summary",
        "aggregate history summary",
        "runtime coverage caveats",
        "state-access rates and counts",
        "token-impact estimates",
        "comparison null reasons",
        "startup recommendation action",
        "manual refresh guidance",
        "privacy boundary",
        "raw-read-last-resort policy",
        "truthful completeness metadata",
      ],
      deferred: ["2.3.12 Build execution-context state"],
    },
  };
}
