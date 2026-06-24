# Agentera benchmarks

This document indexes benchmark surfaces, execution policy, retained outputs,
and interpretation rules. Use it when running Agentera benchmarks or adding new
ones.

Scope: maintainer-run benchmarks only. Normal verification still lives in tests,
contract validators, and runtime smoke checks.

## Authority order

| Authority | Owns |
| --- | --- |
| `references/analysis/startup-measurement-contract.yaml` | Startup state-access metric contract, benchmark privacy boundary, retained fields, and storage shape. |
| `scripts/startup_analysis_contract.py` | Startup analyzer implementation, report generation, aggregate row construction, and benchmark persistence. |
| `magefile.go` | Manual benchmark command surface and non-interactive approval gate. |
| `tests/test_startup_analysis_contract.py` | Fixture-backed consent, persistence, privacy, and no-repo-output checks. |
| `references/analysis/benchmark.md` | Human runbook, interpretation guide, and future benchmark documentation pattern. |

## Benchmark surfaces

| Surface | Command | Purpose | CI policy |
| --- | --- | --- | --- |
| Startup state benchmark | `mage bench:startupState` | Measures how often Agentera CLI state reads are followed by raw artifact access during startup/state gathering. | Manual only; forbidden in normal CI. |

The startup benchmark is an optimization signal for Decision 51 and Decision 52.
It does not implement a startup state envelope or change runtime behavior.

## Startup State Benchmark

Run the benchmark with no extra setup:

```bash
mage bench:startupState
```

The default run uses documented runtime-store defaults, writes retained results
under the default Agentera benchmark directory, and records unavailable stores as
bounded degradation evidence. No environment variables are required.

To use different runtime history sources, set each runtime label and concrete
store path explicitly:

```bash
AGENTERA_BENCH_RUNTIME_STORES="opencode=/absolute/path/to/opencode.db" mage bench:startupState
```

Customize a run when needed:

```bash
AGENTERA_BENCH_RUNTIME_STORES="opencode=/absolute/path/to/opencode.db" \
AGENTERA_BENCH_SALT="$(openssl rand -hex 32)" \
AGENTERA_BENCH_PROJECT_ROOTS="/absolute/project/root" \
AGENTERA_BENCH_OUTPUT_DIR="/absolute/benchmark/output" \
mage bench:startupState
```

Inputs:

| Input | Meaning |
| --- | --- |
| `AGENTERA_BENCH_RUNTIME_STORES` | Optional. Comma-separated `runtime=/absolute/path` overrides. Use this when the documented runtime-store defaults are not the stores you want measured. A runtime label without its path is not enough. |
| `AGENTERA_BENCH_SALT` | Optional. Local redaction salt for transient `latest-report.*` pseudonyms. If omitted, Mage generates one. `runs.jsonl` does not retain salts or generated salted hashes, so aggregate history does not require a stable or shared salt. |
| `AGENTERA_BENCH_PROJECT_ROOTS` | Optional. Absolute project roots for corpus extraction. Use this when the current directory is not the project root you want measured. |
| `AGENTERA_BENCH_OUTPUT_DIR` | Optional. Absolute override for the durable benchmark directory. Use only when the default user-local directory is not desired. |

Supported runtime labels are owned by the analyzer and Mage wrapper. Invalid
labels or relative paths fail before runtime history is read.

### Runtime Extraction Contract

The extraction matrix is defined in
`references/analysis/startup-measurement-contract.yaml` under
`runtime_extraction_contract`. It lists, for each supported runtime, the accepted
input schema classes, normalized record fields, status mapping, and redaction
rules.

Status interpretation is intentionally split:

| Outcome | Status / reason | Meaning |
| --- | --- | --- |
| Schema divergence | `degraded` / `schema_divergent` | Candidate runtime storage was found, but the adapter hit schema errors. Treat this as extraction failure evidence. |
| No matching records | `sparse` / `no_matching_records` | Candidate storage was readable and schema-compatible, but no supported records were extracted. Treat this as sparse coverage evidence. |
| Successful zero-record window | `ok` / `records_extracted` with `record_count: 0` and `error_count: 0` | Extraction succeeded, but the incremental benchmark window has no records after the previous watermark. Treat this as compatible successful behavior. |

Current known runtime caveats are extraction caveats, not CLI behavior evidence:
`claude-code` is degraded by `schema_divergent` with 4836 candidates, 0 records,
and 2 errors; `github-copilot` is degraded by `schema_divergent` with 1
candidate, 0 records, and 1 error; `opencode` currently contributes records;
`codex` can validly report `ok` with zero records and zero errors for an empty
incremental window.

Runtime-store runs are incremental by default. The first run for a runtime scope
measures all records after the v2.3.0 boundary. Later runs for the same
`runtime_scope` read the previous `benchmark_watermark_at` from `runs.jsonl` and
measure only records with timestamps strictly after that watermark. This keeps
new aggregate rows focused on work since the previous successful benchmark run.

To start a fresh series, use a different `AGENTERA_BENCH_OUTPUT_DIR` or archive
the existing `runs.jsonl`. Late-arriving records with timestamps at or before the
stored watermark are treated as already covered.

## How To Reduce Raw Startup Reads

Use the startup benchmark as a CLI completeness profiler. The benchmark does not
measure wall-clock startup speed. It answers whether agents fetch Agentera state
through the CLI and then still fall back to raw artifact reads, greps, or globs
during startup/state gathering.

Follow this loop:

1. Run `mage bench:startupState` and open the retained latest report from the
   `benchmark.directory` path printed on stdout.
2. Check evidence quality before planning product changes. `total_state_sequences`
   must be non-zero, important runtime rows should not be degraded, and
   `confidence_caveats` plus `degradation_reason_counts` must be understood. If
   the report has zero state-gathering sequences, treat it as no evidence rather
   than evidence that the CLI is complete.
3. Rank the post-CLI raw artifact reads. The best next CLI field is usually the
   highest repeated artifact in `redundant_raw_artifact_access_counts`, followed
   by `raw_artifact_access_after_cli_counts` when the read is not redundant yet
   but still happens after a successful CLI state call.
4. Map each repeated raw read to the CLI state owner. Prefer enriching existing
    routine commands or the `prime` composite startup result. Do not add Decision 43
   slash-route aliases as CLI commands.
5. Make CLI completeness explicit. A startup-capable response should say whether
   it is complete for the requested capability, whether raw artifact reads are
   required, what state families are included, what is missing, and which CLI
   fallback command should be tried before raw file access.
6. Update guidance and tests so agents trust complete CLI output and use raw
   reads only as a fallback. Rerun the benchmark on representative sessions and
   compare the new rates with prior `runs.jsonl` rows.

Use these fields to decide what to change:

| Field | How to use it |
| --- | --- |
| `runtime_coverage` | Verify which runtime stores contributed records, which were degraded, and why. Fix extraction or gather more evidence before product work when key stores are degraded. |
| `total_state_sequences` | Confirm the run actually observed startup/state-gathering sequences. A zero value blocks CLI-completeness conclusions. |
| `cli_state_command_counts` | Shows which Agentera state commands anchored the measured sequences. These commands are the first candidates for richer structured output. |
| `raw_artifact_access_after_cli_counts` | Shows which canonical artifacts agents still read after CLI state. These are candidate missing CLI fields or summaries. |
| `redundant_raw_artifact_access_counts` | Shows post-CLI raw reads that overlap state already covered by the CLI. These are the highest-priority avoidable reads. |
| `per_capability_state_counts` | Shows whether the gap is broad startup behavior or narrow capability-specific startup context. |
| `capability_prose_read_counts` | Shows capability prose reads during startup. Use this to decide whether routing/context guidance, not artifact state, is the repeated lookup. |
| `startup_recommendation` | Records whether the measured evidence supports closing, targeted guidance, or a broader startup state envelope. |

### Token Impact Estimates

Token-impact fields are approximate, privacy-safe aggregate estimates. The
contract-owned estimator version is `approx_bytes_div_4_v1`: the analyzer may
observe content byte counts transiently, group them by canonical artifact label,
and estimate tokens as bytes divided by 4. Retained outputs must not include raw
paths, transcript text, raw tool arguments, private salts, or generated salted
hashes.

Retained latest reports and new history rows may include:

| Field | Meaning |
| --- | --- |
| `token_estimator_version` | Estimator identity, currently `approx_bytes_div_4_v1`. |
| `estimated_raw_after_cli_tokens` | Aggregate estimated tokens for raw artifact reads after CLI state calls. |
| `estimated_redundant_raw_tokens` | Aggregate estimated tokens for raw artifact reads that overlap CLI-covered state. |
| `estimated_raw_after_cli_tokens_by_artifact` | Canonical-label breakdown such as `PLAN.md`; never raw paths. |
| `estimated_redundant_raw_tokens_by_artifact` | Canonical-label breakdown for redundant raw reads. |
| `estimated_tokens_saved_vs_previous` | Previous comparable row's redundant-token estimate minus the current row's estimate, or `null`. |
| `estimated_tokens_saved_vs_previous_null_reason` | Concrete reason when savings are `null`, such as `previous_missing_token_estimates`. |

Rows are comparable only when contract version, benchmark mode, runtime scope,
estimator version, and token-field availability match. Otherwise savings stay
`null` with a contract-listed reason.

Stop conditions are as important as action triggers. If a run has zero
state-gathering sequences, sparse records, or degraded schema extraction, improve
benchmark coverage first. If only one capability repeatedly reads one artifact,
prefer targeted CLI output or guidance over a broad startup envelope. If multiple
capabilities repeatedly read several redundant artifacts after CLI state, plan a
capability-ready startup state envelope or equivalent composite output.

## Retention Policy

Default durable storage is `${AGENTERA_HOME}/benchmarks/startup-state/`.

Retained outputs are limited to:

| File | Retention role |
| --- | --- |
| `runs.jsonl` | Append-only aggregate benchmark history and previous-run watermark source. |
| `latest-report.json` | Latest redacted structured report. |
| `latest-report.md` | Latest redacted human-readable report. |

Temporary corpus files, intermediates, and per-run detailed reports are not
durable benchmark history. Failed report generation must not append `runs.jsonl`
or replace previous latest reports.

Aggregate history must not retain raw transcripts, raw corpus files, raw
intermediates, raw store paths, raw session ids, private salts, or generated
salted hashes. Benchmark metrics are user-local, uncommitted, unshipped, and not
part of normal CI.

The command prints the retained benchmark directory in `benchmark.directory`.
Review the latest result from that directory, or from the default location under
your resolved `AGENTERA_HOME` (see `agentera doctor --json` when unset):

```bash
BENCH_DIR="${AGENTERA_HOME}/benchmarks/startup-state"

less "$BENCH_DIR/latest-report.md"
python3 -m json.tool "$BENCH_DIR/latest-report.json"
tail -n 5 "$BENCH_DIR/runs.jsonl"
```

Set `AGENTERA_HOME` first, or resolve the platform app home from
`agentera doctor --json` / `agentera upgrade --dry-run` when unset.
The stdout `reports` filenames are analyzer report names from Mage's temporary
work directory. The durable operator-facing files are the `benchmark` paths:
`runs.jsonl`, `latest-report.json`, and `latest-report.md`.

## Interpretation

Interpret the benchmark as a startup state-access optimization signal, not as a
general runtime performance benchmark.

Default runs demonstrate whether new local Agentera startup/state-gathering
behavior since the previous successful run repeatedly falls back from CLI state
reads to raw artifact access. Stores that do not exist or cannot be read are
bounded degradation evidence, not successful behavior evidence.

Watermark fields:

| Field | Meaning |
| --- | --- |
| `benchmark_mode` | `since_previous_benchmark` for Mage runs that use retained history as the previous-run boundary. |
| `benchmark_previous_watermark_at` | The previous successful watermark for the same `runtime_scope`, or `null` on the first run. |
| `benchmark_window_started_after` | The exclusive lower timestamp bound used for this run. |
| `benchmark_watermark_at` | The latest record timestamp covered by this run. The next run for the same `runtime_scope` starts after this value. |

Primary rates:

| Latest report field | History row field | Meaning |
| --- | --- | --- |
| `raw_after_cli_sequence_rate` | `raw_after_cli_rate` | Share of startup state-gathering sequences where any raw Agentera artifact access follows CLI state. |
| `redundant_raw_sequence_rate` | `redundant_raw_access_rate` | Share of startup state-gathering sequences where raw access overlaps state already covered by the CLI. |

High rates support follow-up work such as a CLI startup state envelope. Low or
zero rates can close the measurement loop without implementation if the corpus is
representative and degradation counts are bounded.

Always review runtime coverage and degradation counts before treating a trend as
actionable. Missing, locked, sparse, or unreadable stores are bounded degradation
evidence, not product behavior evidence.

## Adding Benchmarks

New Agentera benchmarks should follow the same shape:

| Requirement | Rule |
| --- | --- |
| Contract first | Define metric, privacy boundary, storage, retained fields, and failure behavior before implementation. |
| No-prerequisite target | Every `mage bench:*` target must run with no environment variables. The default mode should use documented local defaults and report unavailable inputs as bounded degradation evidence. |
| Manual unless proven safe | Do not add runtime-history or environment-sensitive benchmarks to normal CI. |
| Explicit local approval | Require concrete paths or resources, not broad consent flags. |
| User-local outputs | Keep generated benchmark history outside the repository by default. |
| Bounded retention | Retain aggregate history and latest redacted reports only. |
| Fixture verification | Test consent refusal, successful synthetic runs, degradation cases, privacy exclusions, and no repository-local outputs. |

If a future benchmark needs different retention or CI behavior, document the
reason in its contract and update this file in the same change.
