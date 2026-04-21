"""Tests for hooks/compaction.py and scripts/compact_artifact.py.

Proportionality: 1 pass + 1 fail per ArtifactSpec parser, a few
boundary tests for compact_entries, end-to-end compact_file for
progress plus one other, and CLI smoke tests.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
COMPACT_SCRIPT = REPO_ROOT / "scripts" / "compact_artifact.py"


@pytest.fixture(scope="module")
def compaction():
    """Load hooks/compaction.py directly."""
    import importlib.util

    path = REPO_ROOT / "hooks" / "compaction.py"
    spec = importlib.util.spec_from_file_location("compaction", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["compaction"] = mod
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# Synthetic fixtures
# ---------------------------------------------------------------------------


def _make_progress(n_full: int, n_oneline: int = 0) -> str:
    """Build a synthetic PROGRESS.md with n_full full + n_oneline archived."""
    parts = ["# Progress", ""]
    # Newest-first: highest number first.
    for i in range(n_full, 0, -1):
        parts.append(f"■ ## Cycle {i} · 2026-04-{((i - 1) % 28) + 1:02d} · feat(x): item {i}")
        parts.append("")
        parts.append(f"**Phase**: build")
        parts.append(f"**What**: shipped feature {i} with some detail")
        parts.append(f"**Commit**: abc{i:04d} feat(x): item {i}")
        parts.append("")
    if n_oneline > 0:
        parts.append("## Archived Cycles")
        parts.append("")
        # Archived are older: numbered below the full ones, positive integers.
        for i in range(n_oneline):
            archive_num = n_oneline - i  # descending positive numbers
            parts.append(
                f"- Cycle {archive_num} (2026-03-{(i % 28) + 1:02d}): archived item"
            )
    return "\n".join(parts) + "\n"


def _make_decisions(n_full: int) -> str:
    parts = ["# Decisions", ""]
    for i in range(n_full, 0, -1):
        parts.append(f"## Decision {i}")
        parts.append("")
        parts.append(f"**Date**: 2026-04-{((i - 1) % 28) + 1:02d}")
        parts.append(f"**Chosen alternative**: Option A for decision {i}")
        parts.append(f"**Confidence**: high")
        parts.append("")
    return "\n".join(parts) + "\n"


def _make_health(n_full: int) -> str:
    parts = ["# Health", ""]
    for i in range(n_full, 0, -1):
        parts.append(f"## Audit {i} · 2026-04-{((i - 1) % 28) + 1:02d}")
        parts.append("")
        parts.append(f"**Dimensions**: arch")
        parts.append(f"**Findings**: 1 critical, 2 warnings, 0 info")
        parts.append(f"**Overall**: B")
        parts.append(f"**Overall trajectory**: stable")
        parts.append("")
    return "\n".join(parts) + "\n"


def _make_experiments(n_full: int) -> str:
    parts = ["# Experiments", ""]
    for i in range(n_full, 0, -1):
        parts.append(f"## Experiment {i}")
        parts.append("")
        parts.append(f"**Hypothesis**: h{i}")
        parts.append(f"**Metric**: 100ms -> 80ms better")
        parts.append(f"**Conclusion**: keep")
        parts.append("")
    return "\n".join(parts) + "\n"


def _make_todo(resolved_count: int) -> str:
    parts = [
        "# TODO",
        "",
        "## ⇶ Critical",
        "- [ ] ISS-100: [fix] active",
        "",
        "## ⇉ Degraded",
        "",
        "## → Normal",
        "",
        "## ⇢ Annoying",
        "",
        "## Resolved",
        "",
    ]
    for i in range(resolved_count, 0, -1):
        parts.append(f"- [x] ~~ISS-{i}: [fix] fixed thing {i}~~")
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# parse_entries: one pass + one fail per spec
# ---------------------------------------------------------------------------


class TestParseProgress:
    def test_parses_full_entries(self, compaction):
        text = _make_progress(3, 0)
        entries = compaction.parse_entries(text, "progress")
        assert len(entries) == 3
        assert all(e["kind"] == "full" for e in entries)
        assert "Cycle 3" in entries[0]["header"]

    def test_parses_archived_onelines(self, compaction):
        text = _make_progress(2, 3)
        entries = compaction.parse_entries(text, "progress")
        full = [e for e in entries if e["kind"] == "full"]
        oneline = [e for e in entries if e["kind"] == "oneline"]
        assert len(full) == 2
        assert len(oneline) == 3


class TestParseDecisions:
    def test_parses_decision_entries(self, compaction):
        text = _make_decisions(2)
        entries = compaction.parse_entries(text, "decisions")
        assert len(entries) == 2
        assert "Decision 2" in entries[0]["header"]
        assert "Chosen alternative" in entries[0]["body"]

    def test_empty_decisions(self, compaction):
        text = "# Decisions\n\nNo entries.\n"
        entries = compaction.parse_entries(text, "decisions")
        assert entries == []


class TestParseHealth:
    def test_parses_audit_entries(self, compaction):
        text = _make_health(2)
        entries = compaction.parse_entries(text, "health")
        assert len(entries) == 2
        assert "Audit 2" in entries[0]["header"]

    def test_empty_health(self, compaction):
        entries = compaction.parse_entries("# Health\n", "health")
        assert entries == []


class TestParseExperiments:
    def test_parses_experiment_entries(self, compaction):
        text = _make_experiments(3)
        entries = compaction.parse_entries(text, "experiments")
        assert len(entries) == 3
        assert "Experiment 3" in entries[0]["header"]

    def test_empty_experiments(self, compaction):
        entries = compaction.parse_entries("# Experiments\n", "experiments")
        assert entries == []


class TestParseTodoResolved:
    def test_parses_resolved_bullets(self, compaction):
        text = _make_todo(3)
        entries = compaction.parse_entries(text, "todo-resolved")
        assert len(entries) == 3
        assert all("ISS-" in e["header"] for e in entries)

    def test_no_resolved_section(self, compaction):
        text = "# TODO\n\n## ⇶ Critical\n- [ ] ISS-1\n"
        entries = compaction.parse_entries(text, "todo-resolved")
        assert entries == []


# ---------------------------------------------------------------------------
# compact_entries: boundary logic
# ---------------------------------------------------------------------------


class TestCompactEntries:
    def test_keeps_ten_full_and_collapses_rest(self, compaction):
        entries = [
            {"header": f"Cycle {i}", "body": "body", "kind": "full"}
            for i in range(15, 0, -1)
        ]
        result = compaction.compact_entries(
            entries,
            format_oneline=lambda e: f"- {e['header']}",
        )
        full = [e for e in result if e["kind"] == "full"]
        oneline = [e for e in result if e["kind"] == "oneline"]
        assert len(full) == 10
        assert len(oneline) == 5

    def test_drops_beyond_total_limit(self, compaction):
        entries = [
            {"header": f"Cycle {i}", "body": "b", "kind": "full"}
            for i in range(60, 0, -1)
        ]
        result = compaction.compact_entries(
            entries,
            format_oneline=lambda e: f"- {e['header']}",
        )
        assert len(result) == compaction.MAX_FULL_ENTRIES + compaction.MAX_ONELINE_ENTRIES

    def test_noop_under_threshold(self, compaction):
        entries = [
            {"header": f"C {i}", "body": "b", "kind": "full"}
            for i in range(5)
        ]
        result = compaction.compact_entries(
            entries,
            format_oneline=lambda e: f"- {e['header']}",
        )
        assert len(result) == 5
        assert all(e["kind"] == "full" for e in result)

    def test_onelines_pass_through(self, compaction):
        entries = [
            {"header": f"- Cycle {i}", "body": "", "kind": "oneline"}
            for i in range(20)
        ]
        result = compaction.compact_entries(
            entries,
            format_oneline=lambda e: "DONOTCALL",
        )
        # None of them should pass through the format_oneline transform.
        assert all("DONOTCALL" not in e["header"] for e in result)


# ---------------------------------------------------------------------------
# compact_file: end-to-end
# ---------------------------------------------------------------------------


class TestCompactFileProgress:
    def test_compacts_over_threshold(self, compaction, tmp_path):
        path = tmp_path / "PROGRESS.md"
        path.write_text(_make_progress(15), encoding="utf-8")
        result = compaction.compact_file(path, "progress")
        assert result.changed is True
        assert result.full_after == 10
        assert result.oneline_after == 5
        content = path.read_text(encoding="utf-8")
        assert "## Archived Cycles" in content
        # Newest cycles must remain as full entries.
        assert "## Cycle 15" in content
        # Oldest cycles must have collapsed.
        assert "- Cycle 1 " in content

    def test_no_change_under_threshold(self, compaction, tmp_path):
        path = tmp_path / "PROGRESS.md"
        original = _make_progress(5)
        path.write_text(original, encoding="utf-8")
        result = compaction.compact_file(path, "progress")
        assert result.changed is False
        assert path.read_text(encoding="utf-8") == original


class TestCompactFileHealth:
    def test_compacts_health(self, compaction, tmp_path):
        path = tmp_path / "HEALTH.md"
        path.write_text(_make_health(12), encoding="utf-8")
        result = compaction.compact_file(path, "health")
        assert result.changed is True
        assert result.full_after == 10
        assert result.oneline_after == 2
        content = path.read_text(encoding="utf-8")
        assert "## Archived Audits" in content
        assert "### Audit 2" in content or "### Audit 1" in content


class TestCompactFileTodoResolved:
    def test_compacts_resolved_section_only(self, compaction, tmp_path):
        path = tmp_path / "TODO.md"
        path.write_text(_make_todo(60), encoding="utf-8")
        result = compaction.compact_file(path, "todo-resolved")
        assert result.changed is True
        content = path.read_text(encoding="utf-8")
        # Active sections preserved.
        assert "## ⇶ Critical" in content
        assert "ISS-100" in content
        # Resolved beyond 50 dropped: count checkbox lines.
        resolved_body_marker = content.index("## Resolved")
        resolved_body = content[resolved_body_marker:]
        bullet_count = sum(
            1 for line in resolved_body.splitlines() if line.strip().startswith("- [x]")
        )
        assert bullet_count <= 50


# ---------------------------------------------------------------------------
# CLI script
# ---------------------------------------------------------------------------


class TestCompactArtifactCli:
    def test_valid_spec_over_threshold(self, tmp_path):
        path = tmp_path / "PROGRESS.md"
        path.write_text(_make_progress(15), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(COMPACT_SCRIPT), "progress", str(path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        assert "compacted" in result.stdout
        assert "15->10 full" in result.stdout

    def test_invalid_spec_exits_two(self, tmp_path):
        path = tmp_path / "x.md"
        path.write_text("# x\n", encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(COMPACT_SCRIPT), "nope", str(path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 2
        assert "unknown spec" in result.stderr.lower()

    def test_no_change_under_threshold(self, tmp_path):
        path = tmp_path / "PROGRESS.md"
        path.write_text(_make_progress(3), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(COMPACT_SCRIPT), "progress", str(path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        assert "no change" in result.stdout

    def test_missing_path_exits_two(self):
        result = subprocess.run(
            [sys.executable, str(COMPACT_SCRIPT), "progress", "/nope/xyz.md"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 2


# ---------------------------------------------------------------------------
# detect_overflow helper (used by validate_artifact nudge)
# ---------------------------------------------------------------------------


class TestDetectOverflow:
    def test_over_threshold_detected(self, compaction):
        text = _make_progress(15)
        full, oneline = compaction.detect_overflow(text, "progress")
        assert full == 15
        assert oneline == 0

    def test_under_threshold(self, compaction):
        text = _make_progress(5)
        full, oneline = compaction.detect_overflow(text, "progress")
        assert full == 5
