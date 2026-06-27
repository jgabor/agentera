import fs from "node:fs";
import path from "node:path";
import { spawnSync as _spawnSync } from "node:child_process";

import { pyJsonIndent } from "../../core/pyjson.js";
import { loadTomlFile } from "../../core/toml.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { type Dict, loadContract, parseTimestamp, formatTimestamp } from "./contract.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { inc, counterDict, safeInt, pyJsonDumps } from "./helpers.js";
import { boundedRuntimeStatus } from "./threshold.js";
import { classifyStartupRecords } from "./records.js";
import { aggregateStartupMetrics } from "./metrics.js";
import { renderStartupReport } from "./report.js";

export const STARTUP_INTERMEDIATE_ENVELOPE = "startup_state_analysis_v1";
export const BENCHMARK_HISTORY_JSONL = "runs.jsonl";
export const BENCHMARK_LATEST_REPORT_JSON = "latest-report.json";
export const BENCHMARK_LATEST_REPORT_MARKDOWN = "latest-report.md";
const TOKEN_AGGREGATE_FIELDS = new Set([
  "token_estimator_version",
  "estimated_raw_after_cli_tokens",
  "estimated_redundant_raw_tokens",
  "estimated_raw_after_cli_tokens_by_artifact",
  "estimated_redundant_raw_tokens_by_artifact",
]);

function maxRecordTimestamp(records: unknown[], after: Date | null = null): Date | null {
  let latest: Date | null = null;
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const ts = parseTimestamp((record as Dict).timestamp);
    if (ts === null) continue;
    if (after !== null && ts.getTime() <= after.getTime()) continue;
    if (latest === null || ts.getTime() > latest.getTime()) latest = ts;
  }
  return latest;
}

function artifactLabelCounts(sequences: Dict[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sequence of sequences) {
    for (const event of Array.isArray(sequence.events) ? sequence.events : []) {
      if (event && typeof event === "object" && !Array.isArray(event) && typeof event.artifact_label === "string") {
        inc(counts, event.artifact_label);
      }
    }
  }
  return counterDict(counts);
}

function runtimeRecordCounts(records: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    if (record && typeof record === "object") {
      const runtime = (record as Dict).runtime;
      if (typeof runtime === "string") inc(counts, runtime);
    }
  }
  return counterDict(counts);
}

function agenteraVersion(root: string = resolveSourceRoot()): string {
  try {
    const data = loadTomlFile(path.join(root, "pyproject.toml")) as Dict;
    const project = data.project;
    if (project && typeof project === "object" && typeof (project as Dict).version === "string") {
      return (project as Dict).version as string;
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function gitOutput(args: string[], root: string = resolveSourceRoot()): string | null {
  const result = _spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function gitMetadata(root: string = resolveSourceRoot()): Dict {
  const commit = gitOutput(["rev-parse", "HEAD"], root) || "unknown";
  const status = gitOutput(["status", "--porcelain"], root);
  return { git_commit: commit, git_dirty: status !== null ? Boolean(status) : false };
}

function runtimeScope(metrics: Dict, approvedScope: string[] | null = null): string[] {
  if (approvedScope && approvedScope.length > 0) {
    return [...new Set(approvedScope.filter((l) => l).map((l) => String(l)))].sort();
  }
  const labels = new Set<string>();
  for (const item of Array.isArray(metrics.runtime_coverage) ? metrics.runtime_coverage : []) {
    if (item && typeof item === "object" && !Array.isArray(item) && typeof item.runtime === "string") labels.add(item.runtime);
  }
  const runtimeCounts = metrics.runtime_record_counts;
  if (runtimeCounts && typeof runtimeCounts === "object") {
    for (const label of Object.keys(runtimeCounts)) if (label) labels.add(String(label));
  }
  const sorted = [...labels].sort();
  return sorted.length > 0 ? sorted : ["unknown"];
}

function runtimeScopeMatches(row: Dict, scope: string[]): boolean {
  const value = row.runtime_scope;
  if (!Array.isArray(value)) return false;
  const a = value.map((l) => String(l)).sort();
  const b = scope.map((l) => String(l)).sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function previousBenchmarkWatermark(benchmarkDir: string, scope: string[]): Date | null {
  const historyPath = path.join(benchmarkDir, BENCHMARK_HISTORY_JSONL);
  let lines: string[];
  try {
    lines = fs.readFileSync(historyPath, "utf8").split(/\r\n|\r|\n/);
  } catch {
    return null;
  }
  let watermark: Date | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Dict;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || !runtimeScopeMatches(row, scope)) continue;
    const candidate = parseTimestamp(row.benchmark_watermark_at);
    if (candidate !== null) watermark = candidate;
  }
  return watermark;
}

function previousBenchmarkRow(benchmarkDir: string, scope: string[]): Dict | null {
  const historyPath = path.join(benchmarkDir, BENCHMARK_HISTORY_JSONL);
  let lines: string[];
  try {
    lines = fs.readFileSync(historyPath, "utf8").split(/\r\n|\r|\n/);
  } catch {
    return null;
  }
  let previous: Dict | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Dict;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row && typeof row === "object" && runtimeScopeMatches(row, scope)) previous = row;
  }
  return previous;
}

function withEstimatedTokensSaved(metrics: Dict, benchmarkDir: string, scope: string[]): Dict {
  const enriched: Dict = { ...metrics };
  const previous = previousBenchmarkRow(benchmarkDir, scope);
  const currentVersion = enriched.token_estimator_version;
  const currentRedundant = enriched.estimated_redundant_raw_tokens;
  let reason: string | null = null;
  let saved: number | null = null;
  if (previous === null) {
    reason = "previous_row_missing";
  } else if (![...TOKEN_AGGREGATE_FIELDS].every((f) => f in previous)) {
    reason = "previous_missing_token_estimates";
  } else if (previous.contract_version !== enriched.contract_version) {
    reason = "contract_version_mismatch";
  } else if (previous.benchmark_mode !== (enriched.benchmark_mode || "full_boundary_snapshot")) {
    reason = "benchmark_mode_mismatch";
  } else if (!runtimeScopeMatches(previous, scope)) {
    reason = "runtime_scope_mismatch";
  } else if (previous.token_estimator_version !== currentVersion) {
    reason = "estimator_version_mismatch";
  } else if (
    !(typeof previous.estimated_redundant_raw_tokens === "number" && Number.isInteger(previous.estimated_redundant_raw_tokens)) ||
    !(typeof currentRedundant === "number" && Number.isInteger(currentRedundant))
  ) {
    reason = "previous_missing_token_estimates";
  } else {
    saved = previous.estimated_redundant_raw_tokens - currentRedundant;
  }
  enriched.estimated_tokens_saved_vs_previous = saved;
  enriched.estimated_tokens_saved_vs_previous_null_reason = reason;
  return enriched;
}

export function buildBenchmarkHistoryRow(metrics: Dict, scope: string[] | null = null): Dict {
  const recommendation =
    metrics && typeof metrics === "object" && metrics.startup_recommendation && typeof metrics.startup_recommendation === "object" && !Array.isArray(metrics.startup_recommendation)
      ? metrics.startup_recommendation
      : {};
  return {
    contract_version: metrics.contract_version ?? null,
    generated_at: metrics.generated_at ?? null,
    agentera_version: agenteraVersion(),
    ...gitMetadata(),
    runtime_scope: runtimeScope(metrics, scope),
    benchmark_mode: metrics.benchmark_mode || "full_boundary_snapshot",
    benchmark_previous_watermark_at: metrics.benchmark_previous_watermark_at ?? null,
    benchmark_window_started_after: metrics.benchmark_window_started_after ?? null,
    benchmark_watermark_at: metrics.benchmark_watermark_at ?? null,
    total_records: safeInt(metrics.total_records),
    total_state_sequences: safeInt(metrics.total_state_sequences),
    state_sequences_with_raw_after_cli: safeInt(metrics.state_sequences_with_raw_after_cli),
    state_sequences_with_redundant_raw_access: safeInt(metrics.state_sequences_with_redundant_raw_access),
    raw_after_cli_rate: metrics.raw_after_cli_sequence_rate ?? 0,
    redundant_raw_access_rate: metrics.redundant_raw_sequence_rate ?? 0,
    cli_state_command_counts: metrics.cli_state_command_counts ?? {},
    raw_artifact_access_after_cli_counts: metrics.raw_artifact_access_after_cli_counts ?? {},
    redundant_raw_artifact_access_counts: metrics.redundant_raw_artifact_access_counts ?? {},
    token_estimator_version: metrics.token_estimator_version ?? null,
    estimated_raw_after_cli_tokens: safeInt(metrics.estimated_raw_after_cli_tokens),
    estimated_redundant_raw_tokens: safeInt(metrics.estimated_redundant_raw_tokens),
    estimated_raw_after_cli_tokens_by_artifact: metrics.estimated_raw_after_cli_tokens_by_artifact ?? {},
    estimated_redundant_raw_tokens_by_artifact: metrics.estimated_redundant_raw_tokens_by_artifact ?? {},
    estimated_tokens_saved_vs_previous: metrics.estimated_tokens_saved_vs_previous ?? null,
    estimated_tokens_saved_vs_previous_null_reason: metrics.estimated_tokens_saved_vs_previous_null_reason ?? null,
    per_capability_state_counts: metrics.per_capability_state_counts ?? {},
    degradation_reason_counts: metrics.degradation_reason_counts ?? {},
    bounded_degradation_counts: {
      record_or_sequence: metrics.degradation_reason_counts ?? {},
      runtime_status: metrics.runtime_status_counts ?? {},
    },
    startup_recommendation_action: recommendation.action ?? null,
  };
}

function temporaryPeerPath(p: string): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const dir = path.dirname(p);
  const base = path.basename(p);
  return path.join(dir, `.${base}.${process.pid}.${ts}.tmp`);
}

export function persistStartupBenchmark(
  metrics: Dict,
  benchmarkDir: string,
  scope: string[] | null = null,
): Record<string, string> {
  const resolvedDir = path.resolve(benchmarkDir);
  if (!path.isAbsolute(resolvedDir)) {
    throw new Error("benchmark directory must be an absolute path");
  }
  const resolvedScope = runtimeScope(metrics, scope);
  const enriched = withEstimatedTokensSaved(metrics, resolvedDir, resolvedScope);
  const structuredText = pyJsonIndent(enriched) + "\n";
  const humanText = renderStartupReport(enriched);
  const rowText = pyJsonDumps(buildBenchmarkHistoryRow(enriched, resolvedScope)) + "\n";

  fs.mkdirSync(resolvedDir, { recursive: true });
  const historyPath = path.join(resolvedDir, BENCHMARK_HISTORY_JSONL);
  const jsonPath = path.join(resolvedDir, BENCHMARK_LATEST_REPORT_JSON);
  const markdownPath = path.join(resolvedDir, BENCHMARK_LATEST_REPORT_MARKDOWN);
  const jsonTmp = temporaryPeerPath(jsonPath);
  const markdownTmp = temporaryPeerPath(markdownPath);
  try {
    fs.writeFileSync(jsonTmp, structuredText);
    fs.writeFileSync(markdownTmp, humanText);
    fs.appendFileSync(historyPath, rowText);
    fs.renameSync(jsonTmp, jsonPath);
    fs.renameSync(markdownTmp, markdownPath);
  } catch (err) {
    for (const tmp of [jsonTmp, markdownTmp]) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
  return { history: historyPath, structured: jsonPath, human_readable: markdownPath };
}

export interface BuildIntermediateOptions {
  salt: string;
  contract?: Dict | null;
  benchmarkMode?: string | null;
  benchmarkPreviousWatermarkAt?: Date | null;
  benchmarkWindowStartedAfter?: Date | null;
  benchmarkWatermarkAt?: Date | null;
}

export function buildStartupIntermediate(corpus: Dict, opts: BuildIntermediateOptions): Dict {
  const salt = opts.salt;
  const loaded = opts.contract ?? loadContract();
  let records = corpus && typeof corpus === "object" && !Array.isArray(corpus) ? (corpus.records ?? []) : [];
  if (!Array.isArray(records)) records = [];
  let metadata = corpus && typeof corpus === "object" && !Array.isArray(corpus) ? (corpus.metadata ?? {}) : {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
  let runtimeStatuses = metadata.runtime_statuses;
  if (!Array.isArray(runtimeStatuses)) runtimeStatuses = [];
  const boundaryInfo =
    loaded.boundary && typeof loaded.boundary === "object" && !Array.isArray(loaded.boundary) ? loaded.boundary : {};
  const boundary = parseTimestamp(boundaryInfo.committed_at);
  const windowStartedAfter = opts.benchmarkWindowStartedAfter ?? boundary;
  const watermarkAt = opts.benchmarkWatermarkAt ?? maxRecordTimestamp(records, windowStartedAfter);

  const classified = classifyStartupRecords(corpus, { salt, contract: loaded });
  const sequences = (Array.isArray(classified.state_gathering_sequences) ? classified.state_gathering_sequences : []) as Dict[];
  const degradations = classified.degradations;
  const runtimeCoverage = runtimeStatuses
    .filter((s): s is JsonObject => Boolean(s && typeof s === "object" && !Array.isArray(s)))
    .map((s) => boundedRuntimeStatus(s));
  return {
    output_envelope: STARTUP_INTERMEDIATE_ENVELOPE,
    contract_version: loaded.version ?? null,
    boundary_source: boundaryInfo.source ?? null,
    boundary_commit: boundaryInfo.commit ?? null,
    boundary_committed_at: boundaryInfo.committed_at ?? null,
    benchmark_mode: opts.benchmarkMode || "full_boundary_snapshot",
    benchmark_previous_watermark_at: formatTimestamp(opts.benchmarkPreviousWatermarkAt ?? null),
    benchmark_window_started_after: formatTimestamp(windowStartedAfter),
    benchmark_watermark_at: formatTimestamp(watermarkAt),
    corpus_adapter_version: metadata.adapter_version ?? null,
    runtime_coverage: runtimeCoverage,
    runtime_record_counts: runtimeRecordCounts(records),
    total_records_read: records.length,
    total_state_sequences: sequences.length,
    artifact_label_counts: artifactLabelCounts(sequences),
    state_gathering_sequences: sequences,
    degradations,
    compatibility_note:
      "Section 22 corpus records are read-only; startup state data is emitted only in startup_state_analysis_v1.",
  };
}

export function buildNoRuntimeStartupIntermediate(
  opts: { contract?: Dict | null; benchmarkMode?: string; benchmarkPreviousWatermarkAt?: Date | null } = {},
): Dict {
  const loaded = opts.contract ?? loadContract();
  const boundaryInfo =
    loaded.boundary && typeof loaded.boundary === "object" && !Array.isArray(loaded.boundary) ? loaded.boundary : {};
  const boundary = parseTimestamp(boundaryInfo.committed_at);
  const windowStartedAfter = opts.benchmarkPreviousWatermarkAt ?? boundary;
  return {
    output_envelope: STARTUP_INTERMEDIATE_ENVELOPE,
    contract_version: loaded.version ?? null,
    boundary_source: boundaryInfo.source ?? null,
    boundary_commit: boundaryInfo.commit ?? null,
    boundary_committed_at: boundaryInfo.committed_at ?? null,
    benchmark_mode: opts.benchmarkMode ?? "since_previous_benchmark",
    benchmark_previous_watermark_at: formatTimestamp(opts.benchmarkPreviousWatermarkAt ?? null),
    benchmark_window_started_after: formatTimestamp(windowStartedAfter),
    benchmark_watermark_at: formatTimestamp(opts.benchmarkPreviousWatermarkAt ?? null),
    corpus_adapter_version: null,
    runtime_coverage: [{ runtime: "none", status: "skipped", reason: "no_runtime_stores_approved", record_count: 0 }],
    runtime_record_counts: {},
    total_records_read: 0,
    total_state_sequences: 0,
    artifact_label_counts: {},
    state_gathering_sequences: [],
    degradations: [],
    compatibility_note: "No runtime stores were approved, so no local runtime history was read.",
  };
}

export function extractStartupIntermediateFromCorpusFile(
  corpusPath: string,
  opts: { salt: string; outputPath?: string | null; contract?: Dict | null },
): Dict {
  let corpus: Dict;
  try {
    corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  } catch {
    corpus = {
      metadata: {
        runtime_statuses: [
          { runtime: "local-corpus", status: "degraded", reason: "schema_divergent", error_count: 1 },
        ],
      },
      records: [],
    };
  }
  const intermediate = buildStartupIntermediate(corpus, { salt: opts.salt, contract: opts.contract ?? null });
  if (opts.outputPath) {
    fs.mkdirSync(path.dirname(opts.outputPath), { recursive: true });
    fs.writeFileSync(opts.outputPath, pyJsonIndent(intermediate) + "\n");
  }
  return intermediate;
}
