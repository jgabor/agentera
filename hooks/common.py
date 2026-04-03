#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Shared utilities for agentera hooks.

Provides artifact path resolution (Decision 4) used by both session
start and session stop hooks. This is the single source of truth for
DEFAULT_PATHS, parse_artifact_mapping, resolve_artifact_path, and
load_artifact_overrides.
"""

from __future__ import annotations

import re
from pathlib import Path


# ---------------------------------------------------------------------------
# Artifact path resolution (Decision 4)
# ---------------------------------------------------------------------------

DEFAULT_PATHS: dict[str, str] = {
    "VISION.md": "VISION.md",
    "TODO.md": "TODO.md",
    "CHANGELOG.md": "CHANGELOG.md",
    "DECISIONS.md": ".agentera/DECISIONS.md",
    "PLAN.md": ".agentera/PLAN.md",
    "PROGRESS.md": ".agentera/PROGRESS.md",
    "HEALTH.md": ".agentera/HEALTH.md",
    "OBJECTIVE.md": ".agentera/OBJECTIVE.md",
    "EXPERIMENTS.md": ".agentera/EXPERIMENTS.md",
    "DOCS.md": ".agentera/DOCS.md",
    "DESIGN.md": ".agentera/DESIGN.md",
    "SESSION.md": ".agentera/SESSION.md",
}


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
    DEFAULT_PATHS.
    """
    if overrides and artifact in overrides:
        return project_root / overrides[artifact]
    return project_root / DEFAULT_PATHS.get(artifact, f".agentera/{artifact}")


def load_artifact_overrides(project_root: Path) -> dict[str, str] | None:
    """Load artifact path overrides from .agentera/DOCS.md if present."""
    docs_path = project_root / ".agentera" / "DOCS.md"
    if not docs_path.exists():
        return None
    text = docs_path.read_text(encoding="utf-8")
    mapping = parse_artifact_mapping(text)
    return mapping if mapping else None
