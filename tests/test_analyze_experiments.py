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

    def test_empty_file(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(EMPTY_EXPERIMENTS)
        assert exps == []


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

    def test_empty_experiments(self, analyze_experiments):
        result = analyze_experiments.analyze([])
        assert result["total_experiments"] == 0
        assert "message" in result

    def test_plateau_detection(self, analyze_experiments):
        exps = analyze_experiments.parse_experiments(SAMPLE_EXPERIMENTS_PLATEAU)
        result = analyze_experiments.analyze(exps)
        assert result["plateau_length"] >= 3
        assert result["plateau_detected"] is True
