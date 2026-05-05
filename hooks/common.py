#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Shared utilities for agentera hooks.

Provides artifact path resolution used by both session start and session stop
hooks. This is the single source of truth for
DEFAULT_PATHS, parse_artifact_mapping, resolve_artifact_path, and
load_artifact_overrides.
"""

from __future__ import annotations

import re
from pathlib import Path


# ---------------------------------------------------------------------------
# Artifact path resolution
# ---------------------------------------------------------------------------

DEFAULT_PATHS: dict[str, str] = {
    "VISION.md": ".agentera/vision.yaml",
    "TODO.md": "TODO.md",
    "CHANGELOG.md": "CHANGELOG.md",
    "DECISIONS.md": ".agentera/decisions.yaml",
    "PLAN.md": ".agentera/plan.yaml",
    "PROGRESS.md": ".agentera/progress.yaml",
    "HEALTH.md": ".agentera/health.yaml",
    "DOCS.md": ".agentera/docs.yaml",
    "DESIGN.md": "DESIGN.md",
    "SESSION.md": ".agentera/session.yaml",
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
    DEFAULT_PATHS.
    """
    if overrides and artifact in overrides:
        return project_root / overrides[artifact]
    return project_root / DEFAULT_PATHS.get(artifact, f".agentera/{artifact}")


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
