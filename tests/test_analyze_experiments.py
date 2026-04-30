"""Tests for skills/optimera/scripts/analyze_experiments.py.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained for parse_experiments (regex parsing) and plateau detection (branching).
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# parse_experiments
# ---------------------------------------------------------------------------

SAMPLE_EXPERIMENTS = """\
# Experiments

## Experiment 1

**Hypothesis**: Caching reduces latency
**Change**: Add LRU cache to parser
**Metric**: 120 → 85 (lower is better)
**Regression**: None
**Status**: kept
**Commit**: `aaa1111` feat: add LRU cache
**Inspiration**: None
**Next**: Try bigger cache

## Experiment 2

**Hypothesis**: Bigger cache helps more
**Change**: Increase cache size from 128 to 512
**Metric**: 85 → 83 (lower is better)
**Regression**: Memory usage up 10%
**Status**: discarded
**Commit**: `bbb2222` feat: increase cache size
**Inspiration**: None
**Next**: Try different algorithm

## Experiment 3

**Hypothesis**: Switch to hash-based lookup
**Change**: Replace linear scan with hash map
**Metric**: 85 → 60 (lower is better)
**Regression**: None
**Status**: kept
**Commit**: `ccc3333` refactor: hash-based lookup
**Inspiration**: Saw pattern in project Y
**Next**: Measure cold start
"""

SAMPLE_EXPERIMENTS_PLATEAU = """\
# Experiments

## Experiment 1

**Hypothesis**: Initial improvement
**Change**: First change
**Metric**: 100 → 80 (lower is better)
**Status**: kept

## Experiment 2

**Hypothesis**: No improvement A
**Change**: Second change
**Metric**: 80 → 82 (lower is better)
**Status**: discarded

## Experiment 3

**Hypothesis**: No improvement B
**Change**: Third change
**Metric**: 82 → 81 (lower is better)
**Status**: discarded

## Experiment 4

**Hypothesis**: No improvement C
**Change**: Fourth change
**Metric**: 81 → 83 (lower is better)
**Status**: discarded
"""

EMPTY_EXPERIMENTS = """\
# Experiments

No experiments recorded yet.
"""

RICH_EXPERIMENTS = """\
# Experiments

## Experiment 0 · 2026-04-12 05:51 · baseline

**Hypothesis**: Baseline measurement.
**Metric** (with realisera, full-cycle composite `peak_context + output_total`): **72,645 tokens**
**Baseline** (without realisera, same composite): 97,915 tokens.
**Delta (realisera vs native)**: -25,270 tokens (-26%).
**Status**: ▨ baseline recorded. Not kept or discarded: reference point.

## Experiment 1 · 2026-04-12 06:22 · contract.md lazy-reference

**Hypothesis**: Try lazy-reference contract loading.
**Metric** (with realisera, full-cycle composite `peak_context + output_total`): **82,052 tokens**

| | Exp 0 baseline | Exp 1 | delta |
|---|---|---|---|
| primary (with) | 72,645 | 82,052 | +9,407 (+13.0%) |

**Status**: □ discarded. Metric worsened (+13%).

## Experiment 2 · 2026-04-12 · getting started removal

**Hypothesis**: Remove onboarding prose.
**Metric**: **12,055 tokens** (-20.0% cumulative).

| | Baseline | Exp 4 | Exp 5 | Cumulative delta |
|---|---|---|---|---|
| **Tier 1 total** | **15,065** | **12,310** | **12,055** | **-3,010 (-20.0%)** |

**Status**: ■ kept. Tier 1 improved.

## Experiment 3 · 2026-04-12 · failed run

**Hypothesis**: Broken harness run.
**Metric**: 12,055 → 12,500 tokens
**Status**: run_error: harness failed.
"""

MALFORMED_EXPERIMENTS = """\
# Experiments

## Experiment 1

**Hypothesis**: Missing status and unparsable metric.
**Metric**: not measured yet

## Experiment 2

**Hypothesis**: Unknown status prose.
**Metric**: 10 → 9
**Status**: inconclusive pending review
"""


class TestParseExperiments:
    """Complex: regex parsing of experiment blocks. Keep 3 (multi, metrics, empty)."""

    def test_parses_multiple_experiments(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(SAMPLE_EXPERIMENTS)
        assert len(exps) == 3
        assert exps[0]["number"] == 1
        assert exps[0]["hypothesis"] == "Caching reduces latency"
        assert exps[0]["status"] == "kept"

    def test_extracts_metric_values(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(SAMPLE_EXPERIMENTS)
        assert exps[0]["metric_before"] == 120.0
        assert exps[0]["metric_after"] == 85.0
        assert exps[0]["metric_delta"] == 85.0 - 120.0

    def test_normalizes_rich_statuses_and_metrics(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(RICH_EXPERIMENTS)
        assert [exp["status"] for exp in exps] == [
            "baseline",
            "discarded",
            "kept",
            "error",
        ]
        assert exps[0]["metric_before"] == 97915.0
        assert exps[0]["metric_after"] == 72645.0
        assert exps[0]["metric_delta"] == -25270.0
        assert exps[0]["metric_unit"] == "tokens"
        assert exps[1]["metric_before"] == 72645.0
        assert exps[1]["metric_after"] == 82052.0
        assert exps[1]["metric_delta"] == 9407.0
        assert exps[2]["metric_before"] == 15065.0
        assert exps[2]["metric_after"] == 12055.0
        assert exps[2]["metric_delta"] == -3010.0

    def test_empty_file(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(EMPTY_EXPERIMENTS)
        assert exps == []

    def test_malformed_records_add_diagnostics(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(MALFORMED_EXPERIMENTS)
        assert exps[0]["status"] is None
        assert "missing status" in exps[0]["diagnostics"]
        assert "metric value not found" in exps[0]["diagnostics"]
        assert exps[1]["status"] == "unknown"
        assert exps[1]["diagnostics"] == ["unknown status: inconclusive pending review"]


# ---------------------------------------------------------------------------
# analyze
# ---------------------------------------------------------------------------

class TestAnalyze:
    """Branching: aggregation with plateau detection. Keep 3 (happy path, empty, plateau)."""

    def test_happy_path(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(SAMPLE_EXPERIMENTS)
        result = analyze_experiments.analyze(exps)

        assert result["total_experiments"] == 3
        assert result["kept"] == 2
        assert result["discarded"] == 1
        assert result["win_rate"] > 0
        assert result["current_metric"] == 60.0
        assert len(result["trajectory"]) == 3

    def test_rich_records_aggregate_counts_and_trajectory(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(RICH_EXPERIMENTS)
        result = analyze_experiments.analyze(exps)

        assert result["total_experiments"] == 4
        assert result["kept"] == 1
        assert result["discarded"] == 1
        assert result["errors"] == 1
        assert result["current_metric"] == 12500.0
        assert result["trajectory"] == [
            {"experiment": 0, "value": 72645.0, "status": "baseline"},
            {"experiment": 1, "value": 82052.0, "status": "discarded"},
            {"experiment": 2, "value": 12055.0, "status": "kept"},
            {"experiment": 3, "value": 12500.0, "status": "error"},
        ]

    def test_empty_experiments(self, analyze_experiments):
        result = analyze_experiments.analyze([])
        assert result["total_experiments"] == 0
        assert "message" in result

    def test_diagnostics_are_additive(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(MALFORMED_EXPERIMENTS)
        result = analyze_experiments.analyze(exps)
        assert result["total_experiments"] == 2
        assert result["diagnostics"] == [
            {"experiment": 1, "message": "missing status"},
            {"experiment": 1, "message": "metric value not found"},
            {"experiment": 2, "message": "unknown status: inconclusive pending review"},
        ]

    def test_plateau_detection(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(SAMPLE_EXPERIMENTS_PLATEAU)
        result = analyze_experiments.analyze(exps)
        assert result["plateau_length"] >= 3
        assert result["plateau_detected"] is True
