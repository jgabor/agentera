#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""SessionStart hook: preloads a compact digest of operational artifacts.

Reads PROGRESS.md, HEALTH.md, PLAN.md, TODO.md, and SESSION.md from
the target project, respecting DOCS.md artifact path overrides. Outputs
a raw-state digest (artifact summaries, not interpreted routing) to
stdout so Claude has immediate context at session start.

Receives JSON on stdin with fields: session_id, transcript_path, cwd,
hook_event_name. Exit code 0 = success (stdout shown to Claude).

Run standalone for testing:
    echo '{"cwd": "/path/to/project"}' | uv run hooks/session_start.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

from common import (
    DEFAULT_PATHS,
    load_artifact_overrides,
    parse_artifact_mapping,
    resolve_artifact_path,
)


# ---------------------------------------------------------------------------
# Artifact parsers (extract the digest-relevant portion)
# ---------------------------------------------------------------------------

def extract_latest_progress(text: str) -> str | None:
    """Extract the latest cycle entry from PROGRESS.md.

    The format uses status-prefixed headers like:
        [status] ## Cycle N ...
    We capture everything from the first ## to the next ##.
    """
    # Match cycle headers in multiple known formats.
    # Format 1: "## Cycle N ..." (plain)
    # Format 2: "[symbol] ## Cycle N ..." (status-prefixed)
    pattern = re.compile(
        r"^(?:[^\n]*?)##\s+Cycle\s+\d+.*?\n(.*?)(?=^(?:[^\n]*?)##\s+Cycle\s+\d+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return None
    body = m.group(1).strip()
    # Truncate to keep digest compact: first 5 non-empty lines.
    lines = [ln for ln in body.splitlines() if ln.strip()]
    return "\n".join(lines[:5])


def extract_health_grades(text: str) -> str | None:
    """Extract the grades line from HEALTH.md.

    Looks for a line starting with **Grades**: containing letter grades
    in bracket notation like [A], [B], etc.
    """
    for line in text.splitlines():
        if re.match(r"\*\*Grades\*\*:", line):
            return line.strip()
    return None


def extract_next_plan_task(text: str) -> str | None:
    """Extract the next pending task from PLAN.md.

    Scans for task blocks with status markers. Returns the first task
    whose status is not complete.
    """
    # Look for ### Task N: ... lines followed by **Status**: ...
    task_pattern = re.compile(
        r"^###\s+(Task\s+\d+:.*?)\n(.*?)(?=^### |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    for m in task_pattern.finditer(text):
        title = m.group(1).strip()
        body = m.group(2)
        # Check status line.
        status_match = re.search(r"\*\*Status\*\*:\s*(.+)", body)
        if status_match:
            status = status_match.group(1).strip()
            # Skip complete tasks (marked with a filled square).
            if "complete" in status.lower():
                continue
        return title
    return None


def extract_critical_todos(text: str) -> list[str]:
    """Extract critical severity items from TODO.md.

    Critical items appear under the ## Critical heading (with optional
    severity glyph prefix).
    """
    items: list[str] = []
    in_critical = False
    for line in text.splitlines():
        stripped = line.strip()
        # Detect critical section header (with or without glyph).
        if re.match(r"^##\s*(?:\S+\s+)?Critical", stripped, re.IGNORECASE):
            in_critical = True
            continue
        # Any other ## heading ends the critical section.
        if in_critical and re.match(r"^##\s", stripped):
            break
        # Collect list items in critical section.
        if in_critical and re.match(r"^-\s", stripped):
            items.append(stripped)
    return items


def extract_session_summary(text: str) -> str | None:
    """Extract the latest entry from SESSION.md (future: Task 2).

    SESSION.md will contain session summaries written by the Stop hook.
    For now, we attempt to read the latest entry if the file exists.
    """
    # SESSION.md format TBD (Task 2). Best-effort: grab first ## section.
    pattern = re.compile(
        r"^##\s+.+?\n(.*?)(?=^## |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    if not m:
        return None
    body = m.group(1).strip()
    lines = [ln for ln in body.splitlines() if ln.strip()]
    return "\n".join(lines[:3])


def _load_yaml(path: Path) -> object | None:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, yaml.YAMLError):
        return None


def extract_latest_progress_yaml(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    cycles = data.get("cycles")
    if not isinstance(cycles, list) or not cycles:
        return None
    latest = cycles[0] if isinstance(cycles[0], dict) else None
    if not latest:
        return None
    parts = []
    for key in ("number", "phase", "what", "verified", "next"):
        value = latest.get(key)
        if value not in (None, ""):
            parts.append(f"{key}: {value}")
    return "\n".join(parts[:5]) if parts else None


def extract_health_grades_yaml(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    audits = data.get("audits")
    if not isinstance(audits, list) or not audits or not isinstance(audits[0], dict):
        return None
    grades = audits[0].get("grades")
    if not isinstance(grades, dict) or not grades:
        return None
    return "Grades: " + " | ".join(f"{k} {v}" for k, v in grades.items())


def extract_next_plan_task_yaml(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return None
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if str(task.get("status", "")).lower() == "complete":
            continue
        number = task.get("number")
        name = task.get("name", "unnamed task")
        return f"Task {number}: {name}" if number is not None else str(name)
    return None


def extract_session_summary_yaml(data: object) -> str | None:
    if not isinstance(data, dict):
        return None
    bookmarks = data.get("bookmarks")
    if not isinstance(bookmarks, list) or not bookmarks or not isinstance(bookmarks[0], dict):
        return None
    latest = bookmarks[0]
    timestamp = latest.get("timestamp", "")
    summary = latest.get("summary", "")
    artifacts = latest.get("artifacts", [])
    lines = []
    if timestamp:
        lines.append(str(timestamp))
    if summary:
        lines.append(str(summary))
    if artifacts:
        lines.append("Artifacts modified: " + ", ".join(str(a) for a in artifacts))
    return "\n".join(lines[:3]) if lines else None


# ---------------------------------------------------------------------------
# Digest assembly
# ---------------------------------------------------------------------------

def build_digest(project_root: Path) -> str | None:
    """Build the session start digest from operational artifacts.

    Returns the formatted digest string, or None if no artifacts exist
    (fresh project with no operational state).
    """
    overrides = load_artifact_overrides(project_root)
    sections: list[str] = []

    # PROGRESS.md: latest cycle.
    progress_path = resolve_artifact_path(project_root, "PROGRESS.md", overrides)
    if progress_path.exists():
        if progress_path.suffix == ".yaml":
            entry = extract_latest_progress_yaml(_load_yaml(progress_path))
        else:
            text = progress_path.read_text(encoding="utf-8")
            entry = extract_latest_progress(text)
        if entry:
            sections.append(f"## Latest progress\n{entry}")

    # HEALTH.md: grades.
    health_path = resolve_artifact_path(project_root, "HEALTH.md", overrides)
    if health_path.exists():
        if health_path.suffix == ".yaml":
            grades = extract_health_grades_yaml(_load_yaml(health_path))
        else:
            text = health_path.read_text(encoding="utf-8")
            grades = extract_health_grades(text)
        if grades:
            sections.append(f"## Health\n{grades}")

    # PLAN.md: next pending task.
    plan_path = resolve_artifact_path(project_root, "PLAN.md", overrides)
    if plan_path.exists():
        if plan_path.suffix == ".yaml":
            task = extract_next_plan_task_yaml(_load_yaml(plan_path))
        else:
            text = plan_path.read_text(encoding="utf-8")
            task = extract_next_plan_task(text)
        if task:
            sections.append(f"## Next task\n{task}")

    # TODO.md: critical items.
    todo_path = resolve_artifact_path(project_root, "TODO.md", overrides)
    if todo_path.exists():
        text = todo_path.read_text(encoding="utf-8")
        critical = extract_critical_todos(text)
        if critical:
            sections.append(f"## Critical issues\n" + "\n".join(critical))

    # SESSION.md: last session summary (future: Task 2).
    session_path = resolve_artifact_path(project_root, "SESSION.md", overrides)
    if session_path.exists():
        if session_path.suffix == ".yaml":
            summary = extract_session_summary_yaml(_load_yaml(session_path))
        else:
            text = session_path.read_text(encoding="utf-8")
            summary = extract_session_summary(text)
        if summary:
            sections.append(f"## Last session\n{summary}")

    if not sections:
        return None

    return "# Session context\n\n" + "\n\n".join(sections) + "\n"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    """Read hook input from stdin and output the digest to stdout."""
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
    digest = build_digest(project_root)

    if digest:
        print(digest, end="")
    # Exit 0 whether or not there is output (clean exit for fresh projects).
    return 0


if __name__ == "__main__":
    sys.exit(main())
