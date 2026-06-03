#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Shared utilities for agentera hooks.

Provides artifact path resolution used by both session start and session stop
hooks. This is the single source of truth for
DEFAULT_ARTIFACT_PATHS, parse_artifact_mapping, resolve_artifact_path, and
load_artifact_overrides.

**Scripts bridge:** This module is the single sanctioned import seam from hooks
into ``scripts/`` (inserts ``scripts/`` on ``sys.path`` once). Hook code should
import shared modules such as ``yaml_mapping`` here
rather than adding per-file ``sys.path`` inserts. A neutral shared package is
deferred to the 3.0 packaging initiative.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path
from typing import Callable, TypeVar

_EntryT = TypeVar("_EntryT", bound=dict[str, object])

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
from yaml_mapping import load_yaml_mapping, load_yaml_mapping_file  # noqa: E402,F401
import install_root as install_root_module  # noqa: E402


# ---------------------------------------------------------------------------
# Compaction policy (uniform 10/40/50)
# ---------------------------------------------------------------------------

MAX_FULL_ENTRIES = 10
MAX_ONELINE_ENTRIES = 40
MAX_TOTAL_ENTRIES = MAX_FULL_ENTRIES + MAX_ONELINE_ENTRIES


def apply_retention_caps(
    full_entries: list[_EntryT],
    archive_entries: list[_EntryT],
    *,
    max_full: int = MAX_FULL_ENTRIES,
    max_oneline: int = MAX_ONELINE_ENTRIES,
    max_total: int = MAX_TOTAL_ENTRIES,
) -> list[_EntryT]:
    """Merge full-detail and one-line lists under uniform retention caps."""
    capped_archive = archive_entries[:max_oneline]
    return (full_entries[:max_full] + capped_archive)[:max_total]


# ---------------------------------------------------------------------------
# Runtime-local session bookmarks
# ---------------------------------------------------------------------------


def resolve_agentera_data_home() -> Path:
    """Return the Agentera app home using the shared install-root contract."""
    configured = os.environ.get("AGENTERA_HOME")
    if configured:
        return Path(configured).expanduser()
    root, _source = install_root_module.resolve_candidate(None, env=os.environ, home=Path.home())
    return root


def resolve_session_path(project_root: Path) -> Path:
    """Return the runtime-local session bookmark path for this project."""
    data_home = resolve_agentera_data_home()
    resolved = str(project_root.resolve())
    digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()[:16]
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "-", project_root.name).strip(".-") or "project"
    return data_home / "sessions" / f"{slug}-{digest}" / "session.yaml"


def session_bookmark_to_oneline(entry: dict[str, object]) -> dict[str, object]:
    """Compact a full session bookmark to a one-line archive entry."""
    return {
        "timestamp": str(entry.get("timestamp", "")),
        "artifacts": [],
        "summary": str(entry.get("summary", "")),
        "kind": "oneline",
    }


def compact_session_bookmark_entries(
    entries: list[dict[str, object]],
    *,
    max_full: int = MAX_FULL_ENTRIES,
    max_oneline: int = MAX_ONELINE_ENTRIES,
    max_total: int = MAX_TOTAL_ENTRIES,
    to_oneline: Callable[[dict[str, object]], dict[str, object]] | None = None,
) -> list[dict[str, object]]:
    """Compact timestamp-ordered session bookmarks under 10/40/50 rules.

    Newest bookmarks are determined by ``timestamp`` string sort descending.
    This differs from :func:`compaction.compact_entries`, which orders numeric
    artifact entry IDs for PROGRESS/DECISIONS/HEALTH compaction.
    """
    convert = to_oneline or session_bookmark_to_oneline
    ordered = sorted(entries, key=lambda entry: str(entry.get("timestamp", "")), reverse=True)
    full: list[dict[str, object]] = []
    archive: list[dict[str, object]] = []
    for entry in ordered:
        if entry.get("kind") == "full" and len(full) < max_full:
            full.append(entry)
        else:
            archive.append(convert(entry))
    return apply_retention_caps(full, archive, max_full=max_full, max_oneline=max_oneline, max_total=max_total)


# ---------------------------------------------------------------------------
# Artifact path resolution
# ---------------------------------------------------------------------------

DEFAULT_ARTIFACT_PATHS: dict[str, str] = {
    "VISION.md": ".agentera/vision.yaml",
    "TODO.md": "TODO.md",
    "CHANGELOG.md": "CHANGELOG.md",
    "DECISIONS.md": ".agentera/decisions.yaml",
    "PLAN.md": ".agentera/plan.yaml",
    "PROGRESS.md": ".agentera/progress.yaml",
    "HEALTH.md": ".agentera/health.yaml",
    "DOCS.md": ".agentera/docs.yaml",
    "DESIGN.md": "DESIGN.md",
}


def parse_docs_yaml_mapping(docs_text: str) -> dict[str, str]:
    """Extract artifact path overrides from v2 .agentera/docs.yaml.

    The hook layer stays stdlib-only, so this intentionally parses just the
    simple list shape used by the `mapping:` section:
    `- artifact: NAME` followed by `path: PATH`.
    """
    mapping: dict[str, str] = {}
    in_mapping = False
    current: str | None = None
    for line in docs_text.splitlines():
        if line.startswith("mapping:"):
            in_mapping = True
            continue
        if in_mapping and line and not line.startswith((" ", "-")):
            break
        if not in_mapping:
            continue
        artifact_match = re.match(r"-\s+artifact:\s*(.+?)\s*$", line)
        if artifact_match:
            current = artifact_match.group(1).strip().strip("'\"")
            continue
        path_match = re.match(r"\s+path:\s*(.+?)\s*$", line)
        if path_match and current:
            mapping[current] = path_match.group(1).strip().strip("'\"")
            current = None
    return mapping


def parse_artifact_mapping(docs_text: str) -> dict[str, str]:
    """Extract artifact-to-path mapping from DOCS.md Artifact Mapping table.

    Returns a dict mapping canonical artifact name to its path relative to
    the project root. Only rows that match the expected table format are
    included.
    """
    mapping: dict[str, str] = {}
    in_table = False
    for line in docs_text.splitlines():
        stripped = line.strip()
        # Detect table header row containing "Artifact" and "Path".
        if re.match(r"\|\s*Artifact\s*\|.*Path", stripped, re.IGNORECASE):
            in_table = True
            continue
        # Skip separator row.
        if in_table and re.match(r"\|[-| :]+\|", stripped):
            continue
        # Parse data rows.
        if in_table and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.split("|")]
            # cells[0] is empty (before first |), cells[1] = artifact, cells[2] = path
            if len(cells) >= 3 and cells[1] and cells[2]:
                mapping[cells[1]] = cells[2]
        elif in_table and not stripped.startswith("|"):
            # End of table.
            break
    return mapping


def resolve_artifact_path(
    project_root: Path,
    artifact: str,
    overrides: dict[str, str] | None = None,
) -> Path:
    """Resolve the path for a canonical artifact name.

    Uses overrides from DOCS.md if provided, otherwise falls back to
    DEFAULT_ARTIFACT_PATHS.
    """
    if overrides and artifact in overrides:
        return project_root / overrides[artifact]
    return project_root / DEFAULT_ARTIFACT_PATHS.get(artifact, f".agentera/{artifact}")


def load_artifact_overrides(project_root: Path) -> dict[str, str] | None:
    """Load artifact path overrides from v2 docs.yaml or legacy DOCS.md."""
    yaml_path = project_root / ".agentera" / "docs.yaml"
    if yaml_path.exists():
        text = yaml_path.read_text(encoding="utf-8")
        mapping = parse_docs_yaml_mapping(text)
        if mapping:
            return mapping

    docs_path = project_root / ".agentera" / "DOCS.md"
    if docs_path.exists():
        text = docs_path.read_text(encoding="utf-8")
        mapping = parse_artifact_mapping(text)
        if mapping:
            return mapping
    return None
