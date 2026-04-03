"""Tests for hooks/session_start.py.

Proportionality: 1 pass + 1 fail per testable function. Entry-point
smoke test with realistic stdin arguments. Edge cases only for
parse_artifact_mapping (table parsing with regex boundaries).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOK_SCRIPT = REPO_ROOT / "hooks" / "session_start.py"


# ---------------------------------------------------------------------------
# parse_artifact_mapping
# ---------------------------------------------------------------------------

DOCS_WITH_MAPPING = """\
# Documentation Contract

## Artifact Mapping

| Artifact | Path | Producers |
|----------|------|-----------|
| VISION.md | VISION.md | visionera |
| TODO.md | TODO.md | realisera |
| PROGRESS.md | custom/PROGRESS.md | realisera |
| HEALTH.md | custom/HEALTH.md | inspektera |

## Index

Other content.
"""

DOCS_NO_MAPPING = """\
# Documentation Contract

## Conventions

No artifact mapping table here.
"""

DOCS_EMPTY_TABLE = """\
# Documentation Contract

## Artifact Mapping

| Artifact | Path | Producers |
|----------|------|-----------|

## Index
"""


class TestParseArtifactMapping:
    """Complex: table parsing with boundaries. Keep 3 paths."""

    def test_extracts_mapping_from_table(self, session_start):
        result = session_start.parse_artifact_mapping(DOCS_WITH_MAPPING)
        assert result["PROGRESS.md"] == "custom/PROGRESS.md"
        assert result["HEALTH.md"] == "custom/HEALTH.md"
        assert result["VISION.md"] == "VISION.md"
        assert len(result) == 4

    def test_no_table_returns_empty(self, session_start):
        result = session_start.parse_artifact_mapping(DOCS_NO_MAPPING)
        assert result == {}

    def test_empty_table_returns_empty(self, session_start):
        result = session_start.parse_artifact_mapping(DOCS_EMPTY_TABLE)
        assert result == {}


# ---------------------------------------------------------------------------
# resolve_artifact_path
# ---------------------------------------------------------------------------


class TestResolveArtifactPath:
    """Simple: path lookup. 1 pass + 1 fail."""

    def test_uses_override_when_present(self, session_start):
        root = Path("/project")
        overrides = {"PROGRESS.md": "custom/PROGRESS.md"}
        result = session_start.resolve_artifact_path(root, "PROGRESS.md", overrides)
        assert result == root / "custom/PROGRESS.md"

    def test_uses_default_when_no_override(self, session_start):
        root = Path("/project")
        result = session_start.resolve_artifact_path(root, "PROGRESS.md", None)
        assert result == root / ".agentera/PROGRESS.md"


# ---------------------------------------------------------------------------
# extract_latest_progress
# ---------------------------------------------------------------------------

PROGRESS_MULTI = """\
# Progress

\u25a0 ## Cycle 80 \u00b7 2026-04-03

**What**: Built the session start hook infrastructure.
**Commits**: abc123
**Inspiration**: None
**Discovered**: Clean addition.
**Next**: Task 2.

\u25a0 ## Cycle 79 \u00b7 2026-04-02

**What**: Previous work.
"""

PROGRESS_EMPTY = """\
# Progress

No cycles yet.
"""


class TestExtractLatestProgress:
    """Simple: regex extraction. 1 pass + 1 fail."""

    def test_extracts_latest_cycle(self, session_start):
        result = session_start.extract_latest_progress(PROGRESS_MULTI)
        assert result is not None
        assert "Built the session start hook" in result

    def test_no_cycles_returns_none(self, session_start):
        result = session_start.extract_latest_progress(PROGRESS_EMPTY)
        assert result is None


# ---------------------------------------------------------------------------
# extract_health_grades
# ---------------------------------------------------------------------------

HEALTH_WITH_GRADES = """\
# Health

## Audit 6

**Grades**: Architecture [A] | Patterns [A] | Tests [B]
"""

HEALTH_NO_GRADES = """\
# Health

No audits yet.
"""


class TestExtractHealthGrades:
    """Simple: line scan. 1 pass + 1 fail."""

    def test_extracts_grades_line(self, session_start):
        result = session_start.extract_health_grades(HEALTH_WITH_GRADES)
        assert result is not None
        assert "[A]" in result
        assert "[B]" in result

    def test_no_grades_returns_none(self, session_start):
        result = session_start.extract_health_grades(HEALTH_NO_GRADES)
        assert result is None


# ---------------------------------------------------------------------------
# extract_next_plan_task
# ---------------------------------------------------------------------------

PLAN_WITH_PENDING = """\
# Plan

## Tasks

### Task 1: Write the generation script
**Status**: \u25a0 complete

### Task 2: Add frontmatter
**Status**: pending

### Task 3: Migrate files
**Status**: not started
"""

PLAN_ALL_COMPLETE = """\
# Plan

## Tasks

### Task 1: Write the script
**Status**: \u25a0 complete

### Task 2: Add tests
**Status**: \u25a0 complete
"""


class TestExtractNextPlanTask:
    """Simple: status scanning. 1 pass + 1 fail."""

    def test_finds_first_pending_task(self, session_start):
        result = session_start.extract_next_plan_task(PLAN_WITH_PENDING)
        assert result is not None
        assert "Task 2" in result

    def test_all_complete_returns_none(self, session_start):
        result = session_start.extract_next_plan_task(PLAN_ALL_COMPLETE)
        assert result is None


# ---------------------------------------------------------------------------
# extract_critical_todos
# ---------------------------------------------------------------------------

TODO_WITH_CRITICAL = """\
# TODO

## \u21f6 Critical
- [ ] ISS-99: [fix] Database connection leak
- [ ] ISS-100: [fix] Auth bypass vulnerability

## \u21c9 Degraded
- [ ] ISS-31: [test] Missing CI gating
"""

TODO_NO_CRITICAL = """\
# TODO

## \u21f6 Critical

## \u21c9 Degraded
- [ ] ISS-31: [test] Missing CI gating
"""


class TestExtractCriticalTodos:
    """Simple: section scanning. 1 pass + 1 fail."""

    def test_extracts_critical_items(self, session_start):
        result = session_start.extract_critical_todos(TODO_WITH_CRITICAL)
        assert len(result) == 2
        assert "ISS-99" in result[0]

    def test_empty_critical_section(self, session_start):
        result = session_start.extract_critical_todos(TODO_NO_CRITICAL)
        assert result == []


# ---------------------------------------------------------------------------
# extract_session_summary
# ---------------------------------------------------------------------------

SESSION_WITH_ENTRY = """\
# Session History

## Session 2026-04-03T10:00

Worked on hooks infrastructure.
Completed session_start.py.
Tests passing.

## Session 2026-04-02T14:00

Previous session.
"""

SESSION_EMPTY = """\
# Session History

No sessions recorded.
"""


class TestExtractSessionSummary:
    """Simple: section extraction. 1 pass + 1 fail."""

    def test_extracts_latest_entry(self, session_start):
        result = session_start.extract_session_summary(SESSION_WITH_ENTRY)
        assert result is not None
        assert "hooks infrastructure" in result

    def test_no_entries_returns_none(self, session_start):
        result = session_start.extract_session_summary(SESSION_EMPTY)
        assert result is None


# ---------------------------------------------------------------------------
# build_digest
# ---------------------------------------------------------------------------


class TestBuildDigest:
    """Branching: multiple artifact presence combinations. 1 pass + 1 fail."""

    def test_builds_digest_with_artifacts(self, session_start, tmp_path):
        """Project with operational artifacts produces a digest."""
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()

        # Create PROGRESS.md.
        (agentera_dir / "PROGRESS.md").write_text(
            PROGRESS_MULTI, encoding="utf-8",
        )

        # Create HEALTH.md.
        (agentera_dir / "HEALTH.md").write_text(
            HEALTH_WITH_GRADES, encoding="utf-8",
        )

        # Create TODO.md at root (default path).
        (tmp_path / "TODO.md").write_text(
            TODO_WITH_CRITICAL, encoding="utf-8",
        )

        result = session_start.build_digest(tmp_path)
        assert result is not None
        assert "# Session context" in result
        assert "Latest progress" in result
        assert "Health" in result
        assert "Critical issues" in result

    def test_no_artifacts_returns_none(self, session_start, tmp_path):
        """Empty project with no artifacts produces no digest."""
        result = session_start.build_digest(tmp_path)
        assert result is None


class TestBuildDigestWithCustomPaths:
    """Verifies DOCS.md artifact mapping is respected."""

    def test_respects_custom_paths(self, session_start, tmp_path):
        """Custom artifact paths in DOCS.md are followed."""
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()
        custom_dir = tmp_path / "custom"
        custom_dir.mkdir()

        # Write DOCS.md with custom PROGRESS.md path.
        (agentera_dir / "DOCS.md").write_text(
            "# Docs\n\n## Artifact Mapping\n\n"
            "| Artifact | Path | Producers |\n"
            "|----------|------|----------|\n"
            "| PROGRESS.md | custom/PROGRESS.md | realisera |\n"
            "\n## Index\n",
            encoding="utf-8",
        )

        # Put PROGRESS.md at custom path (not default).
        (custom_dir / "PROGRESS.md").write_text(
            PROGRESS_MULTI, encoding="utf-8",
        )

        result = session_start.build_digest(tmp_path)
        assert result is not None
        assert "Latest progress" in result


# ---------------------------------------------------------------------------
# Entry point smoke test
# ---------------------------------------------------------------------------


class TestEntryPoint:
    """Smoke test: invoke the script as a subprocess with realistic stdin."""

    def test_with_artifacts_produces_output(self, tmp_path):
        """Script with realistic hook input and artifacts exits 0 with output."""
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()
        (agentera_dir / "PROGRESS.md").write_text(
            PROGRESS_MULTI, encoding="utf-8",
        )

        hook_input = json.dumps({
            "session_id": "test-session-001",
            "transcript_path": str(tmp_path / "transcript.jsonl"),
            "cwd": str(tmp_path),
            "hook_event_name": "SessionStart",
        })

        result = subprocess.run(
            [sys.executable, str(HOOK_SCRIPT)],
            input=hook_input,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        assert "Session context" in result.stdout

    def test_without_artifacts_exits_cleanly(self, tmp_path):
        """Script with no artifacts exits 0 with empty output."""
        hook_input = json.dumps({
            "session_id": "test-session-002",
            "transcript_path": str(tmp_path / "transcript.jsonl"),
            "cwd": str(tmp_path),
            "hook_event_name": "SessionStart",
        })

        result = subprocess.run(
            [sys.executable, str(HOOK_SCRIPT)],
            input=hook_input,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        assert result.stdout.strip() == ""
