"""Regression tests for hooks.common.load_yaml_mapping."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOKS_DIR = REPO_ROOT / "hooks"


@pytest.fixture(scope="module")
def hook():
    mod_path = HOOKS_DIR / "validate_artifact.py"
    spec = importlib.util.spec_from_file_location("validate_artifact", mod_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _load_yaml_mapping_module():
    spec = importlib.util.spec_from_file_location(
        "yaml_mapping",
        REPO_ROOT / "scripts" / "yaml_mapping.py",
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_load_yaml_mapping_empty_and_whitespace_return_empty_dict():
    mod = _load_yaml_mapping_module()
    assert mod.load_yaml_mapping("") == {}
    assert mod.load_yaml_mapping("   \n") == {}


def test_load_yaml_mapping_non_mapping_root_raises():
    mod = _load_yaml_mapping_module()
    with pytest.raises(yaml.YAMLError, match="mapping"):
        mod.load_yaml_mapping("- item\n")


def test_validate_artifact_empty_yaml_reports_mapping_violation(hook):
    schema = hook.load_schema("progress")
    violations = hook.validate_yaml("\n", schema, "progress")
    assert any("root must be a mapping" in v for v in violations)


def test_agentera_state_empty_progress_yaml(tmp_path):
    progress = tmp_path / ".agentera" / "progress.yaml"
    progress.parent.mkdir(parents=True)
    progress.write_text("", encoding="utf-8")
    result = subprocess.run(
        [
            "uv",
            "run",
            str(REPO_ROOT / "scripts" / "agentera"),
            "state",
            "progress",
            "--format",
            "json",
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert '"status": "ok"' in result.stdout or '"status":"ok"' in result.stdout.replace(" ", "")
