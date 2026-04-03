"""Tests for skills/realisera/scripts/analyze_progress.py.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained for parse_cycles (regex parsing with multiple field extraction).
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# parse_cycles
# ---------------------------------------------------------------------------

SAMPLE_PROGRESS = """\
# Progress

## Cycle 1 — 2026-03-28 10:00

**What**: Added feature X
**Commit**: `abc1234` feat: add feature X
**Inspiration**: None
**Discovered**: No new issues
**Next**: Continue with Y

## Cycle 2 — 2026-03-29 14:30

**What**: Fixed bug in parser
**Commit**: `def5678` fix: correct parser edge case
**Inspiration**: Saw a pattern in repo Z
**Discovered**: Found performance regression in module A
**Next**: Optimize module A

## Cycle 3 — 2026-03-30 09:15

**What**: Refactored module A
**Commit**: `aaa1111` refactor: simplify module A internals
**Inspiration**: None
**Discovered**: None
**Next**: Add tests
"""

EMPTY_PROGRESS = """\
# Progress

No cycles recorded yet.
"""


class TestParseCycles:
    """Complex: regex parsing with multiple field extraction. Keep 3 (multi, fields, empty)."""

    def test_parses_multiple_cycles(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(SAMPLE_PROGRESS)
        assert len(cycles) == 3
        assert cycles[0]["number"] == 1
        assert cycles[0]["date"] == "2026-03-28"
        assert cycles[0]["time"] == "10:00"
        assert cycles[0]["what"] == "Added feature X"
        assert cycles[0]["work_type"] == "feat"

    def test_extracts_all_fields(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(SAMPLE_PROGRESS)
        c2 = cycles[1]
        assert c2["number"] == 2
        assert c2["commit"] is not None
        assert "fix" in c2["commit"]
        assert c2["work_type"] == "fix"
        assert c2["has_inspiration"] is True
        assert c2["has_discoveries"] is True

    def test_empty_file(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(EMPTY_PROGRESS)
        assert cycles == []


# ---------------------------------------------------------------------------
# analyze
# ---------------------------------------------------------------------------

class TestAnalyze:
    """Simple: aggregation. One pass + one fail."""

    def test_happy_path(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(SAMPLE_PROGRESS)
        result = analyze_progress.analyze(cycles)

        assert result["total_cycles"] == 3
        assert result["date_range"] is not None
        assert result["date_range"]["first"] == "2026-03-28"
        assert result["date_range"]["last"] == "2026-03-30"
        assert result["velocity_cycles_per_day"] is not None
        assert result["velocity_cycles_per_day"] > 0
        assert "feat" in result["work_distribution"]
        assert "fix" in result["work_distribution"]
        assert result["inspiration_rate"] >= 0
        assert result["discovery_rate"] >= 0

    def test_empty_cycles(self, analyze_progress):
        result = analyze_progress.analyze([])
        assert result["total_cycles"] == 0
        assert "message" in result
