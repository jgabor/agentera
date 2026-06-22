"""Regression tests for TODO.md severity-section validation in validate_artifact."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOKS_DIR = REPO_ROOT / "hooks"


@pytest.fixture(scope="module")
def validate_artifact():
    spec = importlib.util.spec_from_file_location(
        "validate_artifact_md_items",
        HOOKS_DIR / "validate_artifact.py",
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["validate_artifact_md_items"] = module
    spec.loader.exec_module(module)
    return module


def _todo_violations(validate_artifact, content: str) -> list[str]:
    violations: list[str] = []
    validate_artifact._validate_md_items(content, "TODO.md", violations)
    return [v for v in violations if "severity section" in v]


def test_validate_md_items_accepts_multi_section_todo(validate_artifact):
    todo = "\n".join(
        [
            "# TODO",
            "",
            "## ⇶ Critical",
            "- [fix:3.0.0] First critical item",
            "",
            "## ⇉ Degraded",
            "- Placeholder",
            "",
            "## → Normal",
            "- [chore:3.0.0] Normal item",
            "",
            "## ⇢ Annoying",
            "- Placeholder",
            "",
        ]
    )
    assert _todo_violations(validate_artifact, todo) == []


def test_validate_md_items_accepts_empty_severity_section(validate_artifact):
    todo = "\n".join(
        [
            "# TODO",
            "",
            "## ⇶ Critical",
            "## ⇉ Degraded",
            "- Placeholder",
            "",
            "## → Normal",
            "- [chore:3.0.0] Normal item",
            "",
            "## ⇢ Annoying",
            "- Placeholder",
            "",
        ]
    )
    assert _todo_violations(validate_artifact, todo) == []
