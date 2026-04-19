"""Tests for hooks/session_stop.py.

Proportionality: 1 pass + 1 fail per testable function. Entry-point
smoke test with realistic stdin arguments. Edge cases for compaction
(boundary logic with multiple entry kinds).
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOK_SCRIPT = REPO_ROOT / "hooks" / "session_stop.py"


# ---------------------------------------------------------------------------
# get_artifact_paths
# ---------------------------------------------------------------------------


class TestGetArtifactPaths:
    """Simple: path mapping construction. 1 pass + 1 fail."""

    def test_builds_default_paths(self, session_stop):
        root = Path("/project")
        result = session_stop.get_artifact_paths(root, None)
        assert ".agentera/HEALTH.md" in result
        assert result[".agentera/HEALTH.md"] == "HEALTH.md"

    def test_uses_overrides_when_present(self, session_stop):
        root = Path("/project")
        overrides = {"HEALTH.md": "custom/HEALTH.md"}
        result = session_stop.get_artifact_paths(root, overrides)
        assert "custom/HEALTH.md" in result
        assert result["custom/HEALTH.md"] == "HEALTH.md"
        # Default path should not be present for overridden artifact.
        assert ".agentera/HEALTH.md" not in result


# ---------------------------------------------------------------------------
# detect_modified_artifacts
# ---------------------------------------------------------------------------


class TestDetectModifiedArtifacts:
    """Branching: git interaction. 1 pass + 1 fail."""

    def test_detects_modified_artifact(self, session_stop, tmp_path):
        """Modified .agentera/ file is detected as a modified artifact."""
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()

        # Mock get_modified_files to return a known artifact path.
        with patch.object(
            session_stop,
            "get_modified_files",
            return_value=[".agentera/HEALTH.md", ".agentera/PLAN.md"],
        ):
            result = session_stop.detect_modified_artifacts(tmp_path, None)
        assert "HEALTH.md" in result
        assert "PLAN.md" in result

    def test_ignores_non_artifact_files(self, session_stop, tmp_path):
        """Non-artifact files are not included in the result."""
        with patch.object(
            session_stop,
            "get_modified_files",
            return_value=["src/main.py", "README.md"],
        ):
            result = session_stop.detect_modified_artifacts(tmp_path, None)
        assert result == []


# ---------------------------------------------------------------------------
# parse_session_entries
# ---------------------------------------------------------------------------

SESSION_WITH_ENTRIES = """\
# Sessions

## 2026-04-03 15:00

Artifacts modified: HEALTH.md, PLAN.md
Summary: Ran audit and planned next steps

## 2026-04-03 10:00

Artifacts modified: PROGRESS.md
Summary: Completed cycle 80

## 2026-04-02 14:00 (Previous session summary)
"""

SESSION_EMPTY = """\
# Sessions
"""


class TestParseSessionEntries:
    """Complex: regex parsing with multiple entry kinds. 1 pass + 1 fail."""

    def test_parses_full_and_oneline_entries(self, session_stop):
        entries = session_stop.parse_session_entries(SESSION_WITH_ENTRIES)
        assert len(entries) == 3
        assert entries[0]["kind"] == "full"
        assert "HEALTH.md" in entries[0]["body"]
        assert entries[2]["kind"] == "oneline"

    def test_empty_session_returns_no_entries(self, session_stop):
        entries = session_stop.parse_session_entries(SESSION_EMPTY)
        assert entries == []


# ---------------------------------------------------------------------------
# compact_entry_to_oneline
# ---------------------------------------------------------------------------


class TestCompactEntryToOneline:
    """Simple: text extraction. 1 pass + 1 fail."""

    def test_extracts_summary_line(self, session_stop):
        entry = {
            "header": "2026-04-03 15:00",
            "body": "Artifacts modified: HEALTH.md\nSummary: Ran audit",
            "kind": "full",
        }
        result = session_stop.compact_entry_to_oneline(entry)
        assert result["kind"] == "oneline"
        assert "Ran audit" in result["header"]
        assert result["body"] == ""

    def test_falls_back_to_first_line_without_summary(self, session_stop):
        entry = {
            "header": "2026-04-03 15:00",
            "body": "Some other content\nMore lines",
            "kind": "full",
        }
        result = session_stop.compact_entry_to_oneline(entry)
        assert "Some other content" in result["header"]


# ---------------------------------------------------------------------------
# compact_entries
# ---------------------------------------------------------------------------


class TestCompactEntries:
    """Boundary: compaction at MAX limits. 1 pass + 1 fail."""

    def test_keeps_ten_full_entries(self, session_stop):
        entries = [
            {"header": f"2026-04-{i:02d} 10:00", "body": f"Summary: Entry {i}", "kind": "full"}
            for i in range(1, 13)
        ]
        result = session_stop.compact_entries(entries)
        full_count = sum(1 for e in result if e["kind"] == "full")
        oneline_count = sum(1 for e in result if e["kind"] == "oneline")
        assert full_count == 10
        assert oneline_count == 2

    def test_drops_entries_beyond_total_limit(self, session_stop):
        entries = [
            {"header": f"2026-04-{i:02d} 10:00", "body": f"Summary: Entry {i}", "kind": "full"}
            for i in range(1, 60)
        ]
        result = session_stop.compact_entries(entries)
        assert len(result) == session_stop.MAX_TOTAL_ENTRIES


# ---------------------------------------------------------------------------
# format_session_md
# ---------------------------------------------------------------------------


class TestFormatSessionMd:
    """Simple: string formatting. 1 pass + 1 fail."""

    def test_formats_full_entry(self, session_stop):
        entries = [
            {"header": "2026-04-03 15:00", "body": "Artifacts modified: HEALTH.md\nSummary: Ran audit", "kind": "full"},
        ]
        result = session_stop.format_session_md(entries)
        assert result.startswith("# Sessions\n")
        assert "## 2026-04-03 15:00" in result
        assert "Artifacts modified: HEALTH.md" in result

    def test_formats_oneline_entry(self, session_stop):
        entries = [
            {"header": "2026-04-03 15:00 (Ran audit)", "body": "", "kind": "oneline"},
        ]
        result = session_stop.format_session_md(entries)
        assert "## 2026-04-03 15:00 (Ran audit)" in result
        # No body content between this entry and end.
        lines = result.strip().splitlines()
        heading_idx = next(i for i, l in enumerate(lines) if "2026-04-03" in l)
        # Next line after heading should be empty (entry separator).
        assert heading_idx == len(lines) - 1 or lines[heading_idx + 1].strip() == ""


# ---------------------------------------------------------------------------
# build_bookmark
# ---------------------------------------------------------------------------


class TestBuildBookmark:
    """Simple: entry construction. 1 pass + 1 fail."""

    def test_builds_bookmark_with_artifacts(self, session_stop):
        ts = datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc)
        result = session_stop.build_bookmark(["HEALTH.md", "PLAN.md"], timestamp=ts)
        assert result["header"] == "2026-04-03 15:00"
        assert "HEALTH.md" in result["body"]
        assert "PLAN.md" in result["body"]
        assert result["kind"] == "full"

    def test_bookmark_includes_artifact_count(self, session_stop):
        result = session_stop.build_bookmark(["HEALTH.md"])
        assert "1 artifact(s)" in result["body"]


# ---------------------------------------------------------------------------
# write_session_bookmark
# ---------------------------------------------------------------------------


class TestWriteSessionBookmark:
    """Branching: write with and without existing file. 1 pass + 1 fail."""

    def test_writes_new_session_file(self, session_stop, tmp_path):
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()

        ts = datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc)
        written = session_stop.write_session_bookmark(
            tmp_path, None, ["HEALTH.md", "PLAN.md"], timestamp=ts,
        )
        assert written is True

        session_path = agentera_dir / "SESSION.md"
        assert session_path.exists()
        content = session_path.read_text(encoding="utf-8")
        assert "# Sessions" in content
        assert "## 2026-04-03 15:00" in content
        assert "HEALTH.md" in content

    def test_skips_write_when_no_artifacts(self, session_stop, tmp_path):
        written = session_stop.write_session_bookmark(
            tmp_path, None, [], timestamp=None,
        )
        assert written is False
        session_path = tmp_path / ".agentera" / "SESSION.md"
        assert not session_path.exists()


class TestWriteSessionBookmarkWithCustomPaths:
    """Verifies DOCS.md artifact mapping is respected for SESSION.md."""

    def test_respects_custom_session_path(self, session_stop, tmp_path):
        custom_dir = tmp_path / "custom"
        custom_dir.mkdir()

        overrides = {"SESSION.md": "custom/SESSION.md"}
        ts = datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc)
        written = session_stop.write_session_bookmark(
            tmp_path, overrides, ["HEALTH.md"], timestamp=ts,
        )
        assert written is True
        assert (custom_dir / "SESSION.md").exists()
        # Default path should NOT exist.
        assert not (tmp_path / ".agentera" / "SESSION.md").exists()


class TestWriteSessionBookmarkCompaction:
    """Verifies compaction when appending to existing SESSION.md."""

    def test_compacts_old_entries(self, session_stop, tmp_path):
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()

        # Pre-populate with 11 full entries (one more than MAX_FULL_ENTRIES).
        lines = ["# Sessions", ""]
        for i in range(11):
            lines.append(f"## 2026-04-{i + 1:02d} 10:00")
            lines.append("")
            lines.append(f"Artifacts modified: PLAN.md\nSummary: Entry {i + 1}")
            lines.append("")
        (agentera_dir / "SESSION.md").write_text("\n".join(lines), encoding="utf-8")

        # Write a new bookmark (total becomes 12).
        ts = datetime(2026, 4, 15, 15, 0, tzinfo=timezone.utc)
        session_stop.write_session_bookmark(
            tmp_path, None, ["HEALTH.md"], timestamp=ts,
        )

        content = (agentera_dir / "SESSION.md").read_text(encoding="utf-8")
        entries = session_stop.parse_session_entries(content)

        full_count = sum(1 for e in entries if e["kind"] == "full")
        oneline_count = sum(1 for e in entries if e["kind"] == "oneline")
        # 10 full (including the new one) + 2 compacted to one-line.
        assert full_count == 10
        assert oneline_count == 2


# ---------------------------------------------------------------------------
# Entry point smoke test
# ---------------------------------------------------------------------------


class TestEntryPoint:
    """Smoke test: invoke the script as a subprocess with realistic stdin."""

    def test_with_modified_artifacts_writes_session(self, tmp_path):
        """Script with modified artifacts exits 0 and creates SESSION.md."""
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()

        # Initialize a git repo and create a tracked artifact.
        subprocess.run(
            ["git", "init"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "commit.gpgSign", "false"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )

        # Create and commit a baseline.
        (agentera_dir / "HEALTH.md").write_text("# Health\n", encoding="utf-8")
        subprocess.run(
            ["git", "add", "."],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "commit", "-m", "initial"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )

        # Modify the artifact (uncommitted change).
        (agentera_dir / "HEALTH.md").write_text(
            "# Health\n\n**Grades**: [A]\n",
            encoding="utf-8",
        )

        hook_input = json.dumps({
            "session_id": "test-stop-001",
            "transcript_path": str(tmp_path / "transcript.jsonl"),
            "cwd": str(tmp_path),
            "hook_event_name": "Stop",
        })

        result = subprocess.run(
            [sys.executable, str(HOOK_SCRIPT)],
            input=hook_input,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        session_path = agentera_dir / "SESSION.md"
        assert session_path.exists()
        content = session_path.read_text(encoding="utf-8")
        assert "HEALTH.md" in content

    def test_without_modified_artifacts_exits_cleanly(self, tmp_path):
        """Script with no modified artifacts exits 0, no SESSION.md created."""
        # Initialize a git repo with no changes.
        subprocess.run(
            ["git", "init"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "user.email", "test@test.com"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "config", "commit.gpgSign", "false"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        # Create a dummy file and commit it so HEAD exists.
        (tmp_path / "dummy.txt").write_text("hello", encoding="utf-8")
        subprocess.run(
            ["git", "add", "."],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )
        subprocess.run(
            ["git", "commit", "-m", "initial"],
            cwd=str(tmp_path),
            capture_output=True,
            timeout=10,
        )

        hook_input = json.dumps({
            "session_id": "test-stop-002",
            "transcript_path": str(tmp_path / "transcript.jsonl"),
            "cwd": str(tmp_path),
            "hook_event_name": "Stop",
        })

        result = subprocess.run(
            [sys.executable, str(HOOK_SCRIPT)],
            input=hook_input,
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert result.returncode == 0
        # SESSION.md should NOT be created.
        assert not (tmp_path / ".agentera" / "SESSION.md").exists()
