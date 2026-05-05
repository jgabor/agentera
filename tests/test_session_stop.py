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
        assert ".agentera/health.yaml" in result
        assert result[".agentera/health.yaml"] == "HEALTH.md"

    def test_uses_overrides_when_present(self, session_stop):
        root = Path("/project")
        overrides = {"HEALTH.md": "custom/HEALTH.md"}
        result = session_stop.get_artifact_paths(root, overrides)
        assert "custom/HEALTH.md" in result
        assert result["custom/HEALTH.md"] == "HEALTH.md"
        # Default path should not be present for overridden artifact.
        assert ".agentera/health.yaml" not in result


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
            return_value=[".agentera/health.yaml", ".agentera/plan.yaml"],
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
        assert "HEALTH.md" in entries[0]["artifacts"]
        assert entries[0]["summary"] == "Ran audit and planned next steps"
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
            "timestamp": "2026-04-03 15:00",
            "artifacts": ["HEALTH.md"],
            "summary": "Ran audit",
            "kind": "full",
        }
        result = session_stop.compact_entry_to_oneline(entry)
        assert result["kind"] == "oneline"
        assert result["timestamp"] == "2026-04-03 15:00"
        assert result["summary"] == "Ran audit"
        assert result["artifacts"] == []

    def test_handles_missing_summary(self, session_stop):
        entry = {
            "timestamp": "2026-04-03 15:00",
            "artifacts": ["HEALTH.md"],
            "summary": "",
            "kind": "full",
        }
        result = session_stop.compact_entry_to_oneline(entry)
        assert result["summary"] == ""


# ---------------------------------------------------------------------------
# compact_entries
# ---------------------------------------------------------------------------


class TestCompactEntries:
    """Boundary: compaction at MAX limits. 1 pass + 1 fail."""

    def test_keeps_ten_full_entries(self, session_stop):
        entries = [
            {"timestamp": f"2026-04-{i:02d} 10:00", "artifacts": ["PLAN.md"], "summary": f"Entry {i}", "kind": "full"}
            for i in range(1, 13)
        ]
        result = session_stop.compact_entries(entries)
        full_count = sum(1 for e in result if e["kind"] == "full")
        oneline_count = sum(1 for e in result if e["kind"] == "oneline")
        assert full_count == 10
        assert oneline_count == 2

    def test_drops_entries_beyond_total_limit(self, session_stop):
        entries = [
            {"timestamp": f"2026-04-{i:02d} 10:00", "artifacts": ["PLAN.md"], "summary": f"Entry {i}", "kind": "full"}
            for i in range(1, 60)
        ]
        result = session_stop.compact_entries(entries)
        assert len(result) == session_stop.MAX_TOTAL_ENTRIES


# ---------------------------------------------------------------------------
# format_session_yaml
# ---------------------------------------------------------------------------


class TestFormatSessionYaml:
    """Simple: string formatting. 1 pass + 1 fail."""

    def test_formats_full_entry(self, session_stop):
        entries = [
            {"timestamp": "2026-04-03 15:00", "artifacts": ["HEALTH.md"], "summary": "Ran audit", "kind": "full"},
        ]
        result = session_stop.format_session_yaml(entries)
        assert result.startswith("bookmarks:\n")
        assert "timestamp: 2026-04-03 15:00" in result
        assert "- HEALTH.md" in result

    def test_formats_oneline_entry(self, session_stop):
        entries = [
            {"timestamp": "2026-04-03 15:00", "summary": "Ran audit", "kind": "oneline"},
        ]
        result = session_stop.format_session_yaml(entries)
        assert "archive:" in result
        assert "summary: Ran audit" in result


# ---------------------------------------------------------------------------
# build_bookmark
# ---------------------------------------------------------------------------


class TestBuildBookmark:
    """Simple: entry construction. 1 pass + 1 fail."""

    def test_builds_bookmark_with_artifacts(self, session_stop):
        ts = datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc)
        result = session_stop.build_bookmark(["HEALTH.md", "PLAN.md"], timestamp=ts)
        assert result["timestamp"] == "2026-04-03 15:00"
        assert "HEALTH.md" in result["artifacts"]
        assert "PLAN.md" in result["artifacts"]
        assert result["kind"] == "full"

    def test_bookmark_includes_artifact_count(self, session_stop):
        result = session_stop.build_bookmark(["HEALTH.md"])
        assert "1 artifact(s)" in result["summary"]


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

        session_path = agentera_dir / "session.yaml"
        assert session_path.exists()
        content = session_path.read_text(encoding="utf-8")
        assert "bookmarks:" in content
        assert "timestamp: 2026-04-03 15:00" in content
        assert "HEALTH.md" in content

    def test_skips_write_when_no_artifacts(self, session_stop, tmp_path):
        written = session_stop.write_session_bookmark(
            tmp_path, None, [], timestamp=None,
        )
        assert written is False
        session_path = tmp_path / ".agentera" / "session.yaml"
        assert not session_path.exists()


class TestWriteSessionBookmarkWithCustomPaths:
    """Verifies docs.yaml artifact mapping is respected for session.yaml."""

    def test_respects_custom_session_path(self, session_stop, tmp_path):
        custom_dir = tmp_path / "custom"
        custom_dir.mkdir()

        overrides = {"SESSION.md": "custom/session.yaml"}
        ts = datetime(2026, 4, 3, 15, 0, tzinfo=timezone.utc)
        written = session_stop.write_session_bookmark(
            tmp_path, overrides, ["HEALTH.md"], timestamp=ts,
        )
        assert written is True
        assert (custom_dir / "session.yaml").exists()
        # Default path should NOT exist.
        assert not (tmp_path / ".agentera" / "session.yaml").exists()


class TestWriteSessionBookmarkCompaction:
    """Verifies compaction when appending to existing session.yaml."""

    def test_compacts_old_entries(self, session_stop, tmp_path):
        agentera_dir = tmp_path / ".agentera"
        agentera_dir.mkdir()

        # Pre-populate with 11 full entries (one more than MAX_FULL_ENTRIES).
        entries = [
            {
                "timestamp": f"2026-04-{i + 1:02d} 10:00",
                "artifacts": ["PLAN.md"],
                "summary": f"Entry {i + 1}",
                "kind": "full",
            }
            for i in range(11)
        ]
        (agentera_dir / "session.yaml").write_text(
            session_stop.format_session_yaml(entries),
            encoding="utf-8",
        )

        # Write a new bookmark (total becomes 12).
        ts = datetime(2026, 4, 15, 15, 0, tzinfo=timezone.utc)
        session_stop.write_session_bookmark(
            tmp_path, None, ["HEALTH.md"], timestamp=ts,
        )

        content = (agentera_dir / "session.yaml").read_text(encoding="utf-8")
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
        """Script with modified artifacts exits 0 and creates session.yaml."""
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
        (agentera_dir / "health.yaml").write_text("audits: []\n", encoding="utf-8")
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
        (agentera_dir / "health.yaml").write_text(
            "audits:\n  - number: 1\n    grades:\n      architecture: A\n",
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
        session_path = agentera_dir / "session.yaml"
        assert session_path.exists()
        content = session_path.read_text(encoding="utf-8")
        assert "HEALTH.md" in content

    def test_without_modified_artifacts_exits_cleanly(self, tmp_path):
        """Script with no modified artifacts exits 0, no session.yaml created."""
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
        # session.yaml should NOT be created.
        assert not (tmp_path / ".agentera" / "session.yaml").exists()
