#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Shared YAML mapping loaders for Agentera hooks and scripts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


def load_yaml_mapping(text: str) -> dict[str, Any]:
    """Parse YAML text as a mapping.

    Empty or whitespace-only documents return ``{}``. Non-mapping roots raise
    :class:`yaml.YAMLError`.
    """
    parsed = yaml.safe_load(text)
    if parsed is None:
        return {}
    if not isinstance(parsed, dict):
        raise yaml.YAMLError("YAML root must be a mapping")
    return parsed


def load_yaml_mapping_file(path: Path) -> dict[str, Any]:
    """Read ``path`` and parse it with :func:`load_yaml_mapping`."""
    return load_yaml_mapping(path.read_text(encoding="utf-8"))
