"""Tests for scripts/validate_cross_capability.py."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "validate_cross_capability.py"
REGISTRY_MODEL = REPO_ROOT / "references" / "artifacts" / "artifact-registry-interface-model.yaml"


def _load_validator():
    spec = importlib.util.spec_from_file_location("validate_cross_capability", SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_cross_capability"] = mod
    spec.loader.exec_module(mod)
    return mod


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


def _schema_meta(artifact_id: str, path: str, producer: str, consumers: list[str]) -> dict[str, Any]:
    return {
        "meta": {
            "name": artifact_id,
            "path": path,
            "producer": producer,
            "consumers": consumers,
            "artifact_type": "agent_facing",
        },
    }


def _capability_artifact(artifact_id: str, local_role: str) -> dict[str, Any]:
    return {
        "ARTIFACTS": {
            1: {
                "id": f"{artifact_id}-{local_role}",
                "artifact_id": artifact_id,
                "local_role": local_role,
            },
        },
    }


def test_repo_cross_capability_graph_is_valid():
    validator = _load_validator()
    assert validator.validate_graph() == []


def test_capability_relationships_are_validated_from_registry_records(tmp_path: Path):
    validator = _load_validator()
    schemas = tmp_path / "schemas"
    caps = tmp_path / "capabilities"

    _write_yaml(schemas / "plan.yaml", _schema_meta("plan", ".agentera/plan.yaml", "planera", ["realisera"]))
    _write_yaml(caps / "planera" / "schemas" / "artifacts.yaml", _capability_artifact("plan", "produces"))
    _write_yaml(caps / "realisera" / "schemas" / "artifacts.yaml", _capability_artifact("plan", "consumes"))

    errors = validator.validate_graph(schemas, caps)

    assert errors == []


def test_producer_mismatch_is_reported(tmp_path: Path):
    validator = _load_validator()
    schemas = tmp_path / "schemas"
    caps = tmp_path / "capabilities"

    _write_yaml(schemas / "health.yaml", _schema_meta("health", ".agentera/health.yaml", "inspektera", ["realisera"]))
    _write_yaml(caps / "inspektera" / "schemas" / "artifacts.yaml", _capability_artifact("health", "consumes"))
    _write_yaml(caps / "realisera" / "schemas" / "artifacts.yaml", _capability_artifact("health", "produces_and_consumes"))

    errors = validator.validate_graph(schemas, caps)

    assert any("producers" in error for error in errors)


def test_unknown_artifact_id_is_reported_without_display_name_translation_map(tmp_path: Path):
    validator = _load_validator()
    schemas = tmp_path / "schemas"
    caps = tmp_path / "capabilities"

    _write_yaml(schemas / "plan.yaml", _schema_meta("plan", ".agentera/plan.yaml", "planera", ["realisera"]))
    _write_yaml(caps / "planera" / "schemas" / "artifacts.yaml", _capability_artifact("ghost", "produces"))

    errors = validator.validate_graph(schemas, caps)

    assert "planera: unknown artifact_id 'ghost'" in errors


def test_special_cases_are_loaded_from_registry_not_validator_local_exceptions():
    validator = _load_validator()
    model = yaml.safe_load(REGISTRY_MODEL.read_text(encoding="utf-8"))
    special_case_ids = {
        record["artifact_id"]
        for record in model["explicit_special_cases"]
        if record["artifact_type"] in {"global_user_state", "archive", "local_harness"}
    }

    canonical = validator.load_canonical_artifacts()
    validator_source = SCRIPT.read_text(encoding="utf-8")

    assert special_case_ids <= canonical.keys()
    assert "EXTERNAL_OR_LOCAL_ARTIFACTS" not in validator_source
    assert "DISPLAY_NAME_BY_SCHEMA" not in validator_source
    assert "CANONICAL_BY_SCHEMA" not in validator_source
    for record in model["explicit_special_cases"]:
        assert record["display_name"] not in validator_source
