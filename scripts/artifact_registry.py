#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Registry-backed artifact identity projection for Agentera scripts."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
ARTIFACT_SCHEMAS_DIR = REPO_ROOT / "skills" / "agentera" / "schemas" / "artifacts"
REGISTRY_MODEL_PATH = REPO_ROOT / "references" / "artifacts" / "artifact-registry-interface-model.yaml"


@dataclass(frozen=True)
class ArtifactRecord:
    artifact_id: str
    display_name: str
    default_path: str
    producers: set[str]
    consumers: set[str]
    artifact_type: str
    scope: str
    path_template: dict[str, Any] | None
    docs_yaml_can_override_path: bool


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    return data if isinstance(data, dict) else {}


def as_set(value: Any) -> set[str]:
    if value is None:
        return set()
    if isinstance(value, str):
        return {value}
    if isinstance(value, list):
        return {str(v) for v in value}
    return {str(value)}


def normalize_path(path: str) -> str:
    """Normalize persisted prose-era variants before comparison/resolution."""
    p = str(path).strip()
    p = re.sub(r"\s*\([^)]*\)\s*$", "", p)
    p = re.sub(r"\s+or\s+mapped\s+path\s+per\s+(?:docs\.yaml|DOCS\.md)$", "", p)
    p = p.replace("<objective-name>", "<name>")
    return p.strip()


def _schema_metas(artifact_schemas_dir: Path) -> dict[str, dict[str, Any]]:
    metas: dict[str, dict[str, Any]] = {}
    if not artifact_schemas_dir.is_dir():
        return metas
    for schema_path in sorted(artifact_schemas_dir.glob("*.yaml")):
        meta = load_yaml(schema_path).get("meta")
        if not isinstance(meta, dict):
            continue
        artifact_id = str(meta.get("name", "")).strip()
        if artifact_id:
            metas[artifact_id] = meta
    return metas


def load_artifact_registry(
    artifact_schemas_dir: Path = ARTIFACT_SCHEMAS_DIR,
    registry_model_path: Path = REGISTRY_MODEL_PATH,
) -> dict[str, ArtifactRecord]:
    model = load_yaml(registry_model_path)
    metas = _schema_metas(artifact_schemas_dir)
    records: dict[str, ArtifactRecord] = {}

    for scope, identities in model.get("required_artifact_identities", {}).items():
        if not isinstance(identities, list):
            continue
        for identity in identities:
            if not isinstance(identity, dict):
                continue
            artifact_id = str(identity.get("artifact_id", "")).strip()
            meta = metas.get(artifact_id)
            if not artifact_id or not meta:
                continue
            records[artifact_id] = ArtifactRecord(
                artifact_id=artifact_id,
                display_name=str(identity.get("display_name", "")).strip(),
                default_path=normalize_path(str(identity.get("default_path", meta.get("path", "")))),
                producers=as_set(meta.get("producer")),
                consumers=as_set(meta.get("consumers")),
                artifact_type=str(meta.get("artifact_type", "")).strip(),
                scope=str(scope),
                path_template=identity.get("path_template") if isinstance(identity.get("path_template"), dict) else None,
                docs_yaml_can_override_path=True,
            )

    for special in model.get("explicit_special_cases", []):
        if not isinstance(special, dict):
            continue
        artifact_id = str(special.get("artifact_id", "")).strip()
        if not artifact_id:
            continue
        records[artifact_id] = ArtifactRecord(
            artifact_id=artifact_id,
            display_name=str(special.get("display_name", "")).strip(),
            default_path=normalize_path(str(special.get("default_path", ""))),
            producers=as_set(special.get("producers")),
            consumers=as_set(special.get("consumers")),
            artifact_type=str(special.get("artifact_type", "")).strip(),
            scope=str(special.get("scope", "")).strip(),
            path_template=special.get("path_template") if isinstance(special.get("path_template"), dict) else None,
            docs_yaml_can_override_path=bool(special.get("docs_yaml_can_override_path")),
        )

    return records


def load_docs_path_overrides(project_root: Path) -> dict[str, str]:
    docs_path = project_root / ".agentera" / "docs.yaml"
    if not docs_path.exists():
        return {}
    try:
        data = yaml.safe_load(docs_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    mapping = data.get("mapping") if isinstance(data, dict) else None
    if not isinstance(mapping, list):
        return {}
    overrides: dict[str, str] = {}
    for entry in mapping:
        if not isinstance(entry, dict):
            continue
        artifact = entry.get("artifact")
        path = entry.get("path")
        if isinstance(artifact, str) and isinstance(path, str):
            overrides[artifact] = path
    return overrides


def resolve_artifact_path(
    record: ArtifactRecord,
    project_root: Path,
    active_objective_name: str | None = None,
) -> Path:
    artifact_path = record.default_path
    overrides = load_docs_path_overrides(project_root)
    if record.docs_yaml_can_override_path and record.display_name in overrides:
        artifact_path = overrides[record.display_name]
    if "<name>" in artifact_path and active_objective_name:
        artifact_path = artifact_path.replace("<name>", active_objective_name)
    if artifact_path.startswith("$PROFILERA_PROFILE_DIR/"):
        explicit = os.environ.get("PROFILERA_PROFILE_DIR")
        suffix = artifact_path.removeprefix("$PROFILERA_PROFILE_DIR/")
        if explicit:
            return Path(explicit) / suffix
        xdg = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg) if xdg else Path.home() / ".local" / "share"
        return base / "agentera" / suffix
    path = Path(artifact_path)
    if path.is_absolute():
        return path
    return project_root / path
