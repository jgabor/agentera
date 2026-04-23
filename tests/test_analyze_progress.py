"""Tests for skills/realisera/scripts/analyze_progress.py.

Proportionality: Decision 21. One pass + one fail per unit for simple helpers,
a few extra cases for the parser (regex across two format generations).
"""

from __future__ import annotations

from collections import Counter


# ---------------------------------------------------------------------------
# parse_cycles — covers both header format generations
# ---------------------------------------------------------------------------

MODERN_PROGRESS = """\
# Progress

■ ## Cycle 122 · 2026-04-23 · chore(opencode): declare ESM type, drop unused bindings in plugin

**What**: Follow-up cleanup.
**Commit**: 640aac6
**Inspiration**: none
**Discovered**: none
**Next**: More.

■ ## Cycle 121 · 2026-04-23 · feat(opencode): bootstrap slash commands

**What**: Executed light plan.
**Commit**: 307aa33
**Inspiration**: existing plugin idioms
**Discovered**: ESM reparse warning
**Next**: Cleanup.
"""

LEGACY_PROGRESS = """\
# Progress

## Cycle 1 — 2026-03-28 10:00

**What**: Added feature X
**Commit**: `abc1234` feat: add feature X
**Inspiration**: None
**Discovered**: No new issues
**Next**: Continue with Y

## Cycle 2 — 2026-03-29 14:30

**What**: Fixed bug
**Commit**: `def5678` fix: correct parser edge case
**Inspiration**: Saw a pattern in repo Z
**Discovered**: Found regression in module A
**Next**: Optimize A

## Cycle 3 — 2026-03-30 09:15

**What**: Refactored module A
**Commit**: `aaa1111` refactor: simplify A internals
**Inspiration**: None
**Discovered**: None
**Next**: Add tests
"""

EMPTY_PROGRESS = "# Progress\n\nNo cycles recorded yet.\n"


class TestParseCycles:
    def test_parses_modern_format(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(MODERN_PROGRESS)
        assert len(cycles) == 2
        assert cycles[0]["number"] == 122
        assert cycles[0]["date"] == "2026-04-23"
        assert cycles[0]["title"].startswith("chore(opencode)")
        assert cycles[0]["work_type"] == "chore"
        assert cycles[1]["work_type"] == "feat"
        assert cycles[1]["has_inspiration"] is True

    def test_parses_legacy_format(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(LEGACY_PROGRESS)
        assert len(cycles) == 3
        assert cycles[0]["number"] == 1
        assert cycles[0]["time"] == "10:00"
        assert cycles[1]["work_type"] == "fix"
        assert cycles[2]["work_type"] == "refactor"

    def test_empty_file(self, analyze_progress):
        assert analyze_progress.parse_cycles(EMPTY_PROGRESS) == []


# ---------------------------------------------------------------------------
# analyze — orchestrator
# ---------------------------------------------------------------------------


class TestAnalyze:
    def test_happy_path(self, analyze_progress):
        cycles = analyze_progress.parse_cycles(LEGACY_PROGRESS)
        result = analyze_progress.analyze(cycles)

        assert result["total_cycles"] == 3
        assert result["date_range"]["first"] == "2026-03-28"
        assert result["date_range"]["last"] == "2026-03-30"
        assert result["velocity_cycles_per_day"] > 0
        assert "feat" in result["work_distribution"]
        assert "fix" in result["work_distribution"]

    def test_empty_cycles(self, analyze_progress):
        result = analyze_progress.analyze([])
        assert result["total_cycles"] == 0
        assert "message" in result

    def test_recent_uses_first_entries_for_newest_first_progress(self, analyze_progress):
        cycles = [
            {"number": n, "date": "2026-04-23"}
            for n in [127, 126, 125, 124, 123, 122]
        ]
        result = analyze_progress.analyze(cycles)
        assert [c["number"] for c in result["recent"]] == [127, 126, 125, 124, 123]

    def test_recent_uses_last_entries_for_oldest_first_progress(self, analyze_progress):
        cycles = [
            {"number": n, "date": "2026-04-23"}
            for n in [122, 123, 124, 125, 126, 127]
        ]
        result = analyze_progress.analyze(cycles)
        assert [c["number"] for c in result["recent"]] == [123, 124, 125, 126, 127]


# ---------------------------------------------------------------------------
# Suggestion helpers — one trigger case each
# ---------------------------------------------------------------------------


class TestSuggestions:
    def test_fix_heavy(self, analyze_progress):
        assert analyze_progress._suggest_fix_heavy(total=10, fix_types=7, build_types=3)
        assert analyze_progress._suggest_fix_heavy(total=10, fix_types=2, build_types=5) is None

    def test_low_inspiration(self, analyze_progress):
        assert analyze_progress._suggest_low_inspiration(total=10, inspired=1, rate=0.1)
        assert analyze_progress._suggest_low_inspiration(total=10, inspired=5, rate=0.5) is None

    def test_high_inspiration(self, analyze_progress):
        assert analyze_progress._suggest_high_inspiration(total=10, rate=0.9)
        assert analyze_progress._suggest_high_inspiration(total=10, rate=0.5) is None

    def test_no_tests(self, analyze_progress):
        assert analyze_progress._suggest_no_tests(total=10, type_counts=Counter({"feat": 10}))
        assert analyze_progress._suggest_no_tests(total=10, type_counts=Counter({"test": 1, "feat": 9})) is None

    def test_no_docs(self, analyze_progress):
        assert analyze_progress._suggest_no_docs(total=10, type_counts=Counter({"feat": 10}))
        assert analyze_progress._suggest_no_docs(total=10, type_counts=Counter({"docs": 1, "feat": 9})) is None

    def test_below_threshold_produces_nothing(self, analyze_progress):
        # All helpers require total >= 5.
        assert analyze_progress._suggest_fix_heavy(total=3, fix_types=3, build_types=0) is None
        assert analyze_progress._suggest_no_tests(total=3, type_counts=Counter({"feat": 3})) is None
