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
| `docs/benchmark.md` | Human runbook, interpretation guide, and future benchmark documentation pattern. |

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

Runtime-store runs are incremental by default. The first run for a runtime scope
measures all records after the v2.3.0 boundary. Later runs for the same
`runtime_scope` read the previous `benchmark_watermark_at` from `runs.jsonl` and
measure only records with timestamps strictly after that watermark. This keeps
new aggregate rows focused on work since the previous successful benchmark run.

To start a fresh series, use a different `AGENTERA_BENCH_OUTPUT_DIR` or archive
the existing `runs.jsonl`. Late-arriving records with timestamps at or before the
stored watermark are treated as already covered.

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
Review the latest result from that directory, or from the default location:

```bash
BENCH_DIR="${AGENTERA_HOME:-$HOME/.local/share/agentera}/benchmarks/startup-state"

less "$BENCH_DIR/latest-report.md"
python3 -m json.tool "$BENCH_DIR/latest-report.json"
tail -n 5 "$BENCH_DIR/runs.jsonl"
```

The `BENCH_DIR` example uses the Linux default when `AGENTERA_HOME` is unset.

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

| Rate | Meaning |
| --- | --- |
| `raw_after_cli_rate` | Share of startup state-gathering sequences where any raw Agentera artifact access follows CLI state. |
| `redundant_raw_access_rate` | Share of startup state-gathering sequences where raw access overlaps state already covered by the CLI. |

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
