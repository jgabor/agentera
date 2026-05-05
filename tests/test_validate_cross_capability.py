"""Tests for scripts/validate_cross_capability.py."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "validate_cross_capability.py"


def _load_validator():
    spec = importlib.util.spec_from_file_location("validate_cross_capability", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_cross_capability"] = mod
    spec.loader.exec_module(mod)
    return mod


def _write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def test_repo_cross_capability_graph_is_valid():
    validator = _load_validator()
    assert validator.validate_graph() == []


def test_path_mismatch_is_reported(tmp_path: Path):
    validator = _load_validator()
    schemas = tmp_path / "schemas"
    caps = tmp_path / "capabilities"
    _write_yaml(schemas / "plan.yaml", {
        "meta": {
            "name": "plan",
            "path": ".agentera/plan.yaml",
            "producer": "planera",
            "consumers": ["realisera"],
        },
    })
    _write_yaml(caps / "planera" / "schemas" / "artifacts.yaml", {
        "ARTIFACTS": {
            1: {
                "name": "PLAN.md",
                "path": ".agentera/PLAN.md",
                "produces": True,
                "consumes": False,
            },
        },
    })
    errors = validator.validate_graph(schemas, caps)
    assert any("does not match canonical" in error for error in errors)


def test_producer_mismatch_is_reported(tmp_path: Path):
    validator = _load_validator()
    schemas = tmp_path / "schemas"
    caps = tmp_path / "capabilities"
    _write_yaml(schemas / "health.yaml", {
        "meta": {
            "name": "health",
            "path": ".agentera/health.yaml",
            "producer": "inspektera",
            "consumers": ["realisera"],
        },
    })
    _write_yaml(caps / "realisera" / "schemas" / "artifacts.yaml", {
        "ARTIFACTS": {
            1: {
                "name": "HEALTH.md",
                "path": ".agentera/health.yaml",
                "produces": True,
                "consumes": True,
            },
        },
    })
    errors = validator.validate_graph(schemas, caps)
    assert any("producers" in error for error in errors)
