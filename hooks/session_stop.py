#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Stop hook: writes session bookmarks to .agentera/session.yaml.

Detects which operational artifacts were modified during the session
(via git diff and git ls-files), and writes a timestamped bookmark to
session.yaml. Compacts older bookmarks to one-line summaries (keep 10
full entries, 40 one-line summaries, drop oldest beyond 50 total).

Respects docs.yaml artifact path overrides.

Receives JSON on stdin with fields: session_id, transcript_path, cwd,
hook_event_name. Exit code 0 = success, exit code 1 = error.

Run standalone for testing:
    echo '{"cwd": "/path/to/project"}' | uv run hooks/session_stop.py
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from common import (
    DEFAULT_PATHS,
    load_artifact_overrides,
    resolve_artifact_path,
)
from compaction import (
    MAX_FULL_ENTRIES,
    MAX_ONELINE_ENTRIES,
    MAX_TOTAL_ENTRIES,
)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Canonical artifact names tracked for modification detection.
TRACKED_ARTIFACTS = [
    "PROGRESS.md",
    "DECISIONS.md",
    "PLAN.md",
    "HEALTH.md",
    "DESIGN.md",
    "DOCS.md",
    "SESSION.md",
    "VISION.md",
    "TODO.md",
    "CHANGELOG.md",
]


# ---------------------------------------------------------------------------
# Modified artifact detection
# ---------------------------------------------------------------------------

def get_artifact_paths(
    project_root: Path,
    overrides: dict[str, str] | None,
) -> dict[str, str]:
    """Build a mapping from relative path to canonical artifact name.

    Returns {relative_path: artifact_name} for all tracked artifacts,
    using DOCS.md overrides where available.
    """
    path_to_name: dict[str, str] = {}
    for artifact in TRACKED_ARTIFACTS:
        resolved = resolve_artifact_path(project_root, artifact, overrides)
        try:
            rel = resolved.relative_to(project_root)
        except ValueError:
            continue
        path_to_name[str(rel)] = artifact
    return path_to_name


def _run_git(project_root: Path, args: list[str]) -> list[str]:
    """Run a git command and return non-empty output lines.

    Returns an empty list if the command fails or times out.
    """
    try:
        result = subprocess.run(
            ["git"] + args,
            capture_output=True,
            text=True,
            cwd=str(project_root),
            timeout=10,
        )
        if result.returncode == 0:
            return [
                line.strip()
                for line in result.stdout.strip().splitlines()
                if line.strip()
            ]
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return []


def get_modified_files(project_root: Path) -> list[str]:
    """Get files modified or added since the last commit.

    Combines staged changes, unstaged working-tree changes, and
    untracked files. Falls back gracefully when HEAD does not exist
    (empty repo or commit failure). Returns relative paths from the
    project root.
    """
    modified: set[str] = set()

    # Try diff against HEAD first (staged + unstaged vs last commit).
    head_diff = _run_git(project_root, ["diff", "--name-only", "HEAD"])
    if head_diff:
        modified.update(head_diff)
    else:
        # HEAD may not exist: fall back to staged and working-tree diffs.
        modified.update(_run_git(project_root, ["diff", "--cached", "--name-only"]))
        modified.update(_run_git(project_root, ["diff", "--name-only"]))

    # Untracked files.
    modified.update(
        _run_git(project_root, ["ls-files", "--others", "--exclude-standard"]),
    )

    return sorted(modified)


def detect_modified_artifacts(
    project_root: Path,
    overrides: dict[str, str] | None,
) -> list[str]:
    """Detect which tracked artifacts were modified during this session.

    Returns a sorted list of canonical artifact names (e.g., ["HEALTH.md",
    "PLAN.md"]) that were modified or newly created.
    """
    path_to_name = get_artifact_paths(project_root, overrides)
    modified_files = get_modified_files(project_root)

    modified_artifacts: set[str] = set()
    for filepath in modified_files:
        # Normalize path separators for comparison.
        normalized = filepath.replace("\\", "/")
        if normalized in path_to_name:
            modified_artifacts.add(path_to_name[normalized])

    return sorted(modified_artifacts)


# ---------------------------------------------------------------------------
# SESSION.md parsing and writing
# ---------------------------------------------------------------------------

def parse_session_entries(text: str) -> list[dict[str, object]]:
    """Parse session.yaml or legacy SESSION.md into entry dicts.

    Each entry has:
      - "timestamp": session timestamp
      - "artifacts": modified artifacts for full entries
      - "summary": compact summary
      - "kind": "full" or "oneline"

    Entries are returned in document order (newest first).
    """
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        data = None
    if isinstance(data, dict):
        entries: list[dict[str, object]] = []
        for bookmark in data.get("bookmarks", []) or []:
            if isinstance(bookmark, dict):
                entries.append({
                    "timestamp": str(bookmark.get("timestamp", "")),
                    "artifacts": list(bookmark.get("artifacts", []) or []),
                    "summary": str(bookmark.get("summary", "")),
                    "kind": "full",
                })
        for archived in data.get("archive", []) or []:
            if isinstance(archived, dict):
                entries.append({
                    "timestamp": str(archived.get("timestamp", "")),
                    "artifacts": [],
                    "summary": str(archived.get("summary", "")),
                    "kind": "oneline",
                })
        if entries:
            return entries

    entries = []
    # Split on ## headings. Each heading starts a new entry.
    pattern = re.compile(r"^##\s+(.+)$", re.MULTILINE)
    matches = list(pattern.finditer(text))

    for i, m in enumerate(matches):
        header = m.group(1).strip()
        # Body is everything between this heading and the next (or end).
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()

        if body:
            summary = ""
            artifacts: list[str] = []
            for line in body.splitlines():
                stripped = line.strip()
                if stripped.lower().startswith("summary:"):
                    summary = stripped.split(":", 1)[1].strip()
                if stripped.lower().startswith("artifacts modified:"):
                    raw = stripped.split(":", 1)[1]
                    artifacts = [a.strip() for a in raw.split(",") if a.strip()]
            entries.append({
                "timestamp": header,
                "artifacts": artifacts,
                "summary": summary,
                "kind": "full",
            })
        else:
            entries.append({
                "timestamp": header,
                "artifacts": [],
                "summary": header,
                "kind": "oneline",
            })

    return entries


def compact_entry_to_oneline(entry: dict[str, object]) -> dict[str, object]:
    """Compact a full entry to a one-line summary.

    Preserves timestamp and summary for the archive section.
    """
    return {
        "timestamp": str(entry.get("timestamp", "")),
        "artifacts": [],
        "summary": str(entry.get("summary", "")),
        "kind": "oneline",
    }


def compact_entries(entries: list[dict[str, object]]) -> list[dict[str, object]]:
    """Apply compaction rules to an entry list.

    Keeps the 10 newest full bookmarks, preserves up to 40 older one-line
    archive entries, and drops anything beyond the 50-entry total cap.
    """
    ordered = sorted(
        entries,
        key=lambda entry: str(entry.get("timestamp", "")),
        reverse=True,
    )
    full: list[dict[str, object]] = []
    archive: list[dict[str, object]] = []
    for entry in ordered:
        if entry.get("kind") == "full" and len(full) < MAX_FULL_ENTRIES:
            full.append(entry)
        else:
            archive.append(compact_entry_to_oneline(entry))
    return (full + archive[:MAX_ONELINE_ENTRIES])[:MAX_TOTAL_ENTRIES]


def format_session_yaml(entries: list[dict[str, object]]) -> str:
    """Format entries as v2 session.yaml content."""
    bookmarks = []
    archive = []
    for entry in entries:
        if entry.get("kind") == "full":
            bookmarks.append({
                "timestamp": entry.get("timestamp", ""),
                "artifacts": list(entry.get("artifacts", []) or []),
                "summary": entry.get("summary", ""),
            })
        else:
            archive.append({
                "timestamp": entry.get("timestamp", ""),
                "summary": entry.get("summary", ""),
            })
    data: dict[str, object] = {"bookmarks": bookmarks}
    if archive:
        data["archive"] = archive
    return yaml.safe_dump(data, sort_keys=False)


def build_bookmark(
    modified_artifacts: list[str],
    timestamp: datetime | None = None,
) -> dict[str, object]:
    """Build a new full bookmark entry.

    Returns an entry dict with timestamp, modified artifacts, and summary.
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc)

    return {
        "timestamp": timestamp.strftime("%Y-%m-%d %H:%M"),
        "artifacts": modified_artifacts,
        "summary": f"Modified {len(modified_artifacts)} artifact(s)",
        "kind": "full",
    }


def write_session_bookmark(
    project_root: Path,
    overrides: dict[str, str] | None,
    modified_artifacts: list[str],
    timestamp: datetime | None = None,
) -> bool:
    """Write a session bookmark to session.yaml.

    Reads existing session.yaml (if any), prepends the new bookmark,
    applies compaction, and writes the result. Returns True if the
    bookmark was written, False otherwise.
    """
    if not modified_artifacts:
        return False

    session_path = resolve_artifact_path(project_root, "SESSION.md", overrides)

    # Read existing entries.
    existing_text = ""
    if session_path.exists():
        existing_text = session_path.read_text(encoding="utf-8")

    existing_entries = parse_session_entries(existing_text)

    # Build new bookmark and prepend.
    new_entry = build_bookmark(modified_artifacts, timestamp)
    all_entries = [new_entry] + existing_entries

    # Apply compaction.
    compacted = compact_entries(all_entries)

    # Write result.
    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text(format_session_yaml(compacted), encoding="utf-8")

    return True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    """Read hook input from stdin and write session bookmark."""
    try:
        raw = sys.stdin.read()
        if raw.strip():
            hook_input = json.loads(raw)
            cwd = hook_input.get("cwd", ".")
        else:
            cwd = "."
    except (json.JSONDecodeError, KeyError):
        cwd = "."

    project_root = Path(cwd).resolve()
    overrides = load_artifact_overrides(project_root)
    modified = detect_modified_artifacts(project_root, overrides)

    if not modified:
        # No artifacts modified: skip writing.
        return 0

    written = write_session_bookmark(project_root, overrides, modified)
    return 0 if written else 1


if __name__ == "__main__":
    sys.exit(main())
