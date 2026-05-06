"""Isolated contract tests for the ArtifactRegistry interface model."""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = REPO_ROOT / "references/artifacts/artifact-registry-interface-model.yaml"
ARTIFACT_SCHEMA_DIR = REPO_ROOT / "skills/agentera/schemas/artifacts"
CAPABILITY_DIR = REPO_ROOT / "skills/agentera/capabilities"
DOCS_PATH = REPO_ROOT / ".agentera/docs.yaml"


def _load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def _model_fixture() -> dict[str, Any]:
    return _load_yaml(MODEL_PATH)


def _artifact_schema_metas() -> dict[str, dict[str, Any]]:
    metas: dict[str, dict[str, Any]] = {}
    for path in sorted(ARTIFACT_SCHEMA_DIR.glob("*.yaml")):
        meta = _load_yaml(path).get("meta")
        assert isinstance(meta, dict), f"{path} missing meta"
        artifact_id = meta.get("name")
        assert isinstance(artifact_id, str), f"{path} meta.name must be a string"
        metas[artifact_id] = meta
    return metas


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else [value]


def _known_display_names(model: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for records in model["required_artifact_identities"].values():
        names.update(record["display_name"] for record in records)
    names.update(record["display_name"] for record in model["explicit_special_cases"])
    return names


def _validate_registry_contract(model: dict[str, Any], metas: dict[str, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    enum_values = model.get("owned_enums", {})
    artifact_types = set(enum_values.get("artifact_type", []))
    scopes = set(enum_values.get("scope", []))
    seen_ids: set[str] = set()
    seen_display_names: set[str] = set()

    for group in model["record"]["required_groups"]:
        if group not in model["record"]["groups"]:
            errors.append(f"record.groups missing required group {group}")

    for scope, records in model.get("required_artifact_identities", {}).items():
        if scope not in scopes:
            errors.append(f"required_artifact_identities.{scope} unknown scope")
        for index, record in enumerate(records):
            prefix = f"required_artifact_identities.{scope}[{index}]"
            artifact_id = record.get("artifact_id")
            display_name = record.get("display_name")
            default_path = record.get("default_path")
            meta = metas.get(artifact_id)
            if not meta:
                errors.append(f"{prefix}.artifact_id unknown artifact schema: {artifact_id}")
                continue
            if artifact_id in seen_ids:
                errors.append(f"duplicate artifact_id: {artifact_id}")
            seen_ids.add(artifact_id)
            if display_name in seen_display_names:
                errors.append(f"duplicate display_name: {display_name}")
            seen_display_names.add(display_name)
            if meta.get("path") != default_path:
                errors.append(f"{prefix}.default_path differs from canonical schema meta.path")
            if meta.get("artifact_type") not in artifact_types:
                errors.append(f"{prefix}.artifact_type unknown: {meta.get('artifact_type')}")
            for relationship_field in ("producer", "consumers"):
                values = _as_list(meta.get(relationship_field))
                if not values or not all(isinstance(value, str) and value for value in values):
                    errors.append(f"{prefix}.{relationship_field} must be non-empty string or list[string]")
            if ("<" in default_path or "{" in default_path or "$" in default_path) and not record.get("path_template"):
                errors.append(f"{prefix}.path_template required for templated default_path")

    for index, record in enumerate(model.get("explicit_special_cases", [])):
        prefix = f"explicit_special_cases[{index}]"
        for field in ("artifact_id", "display_name", "artifact_type", "scope", "default_path", "docs_yaml_can_override_path"):
            if field not in record:
                errors.append(f"{prefix}.{field} missing")
        artifact_id = record.get("artifact_id")
        display_name = record.get("display_name")
        if artifact_id in seen_ids:
            errors.append(f"duplicate artifact_id: {artifact_id}")
        seen_ids.add(artifact_id)
        if display_name in seen_display_names:
            errors.append(f"duplicate display_name: {display_name}")
        seen_display_names.add(display_name)
        if record.get("artifact_type") not in artifact_types:
            errors.append(f"{prefix}.artifact_type unknown: {record.get('artifact_type')}")
        if record.get("scope") not in scopes:
            errors.append(f"{prefix}.scope unknown: {record.get('scope')}")
        template = record.get("path_template")
        if ("<" in str(record.get("default_path")) or "{" in str(record.get("default_path")) or "$" in str(record.get("default_path"))) and not template:
            errors.append(f"{prefix}.path_template required for special-case default_path")
        if isinstance(template, dict) and template.get("placeholder") in template.get("aliases_rejected_after_migration", []):
            errors.append(f"{prefix}.path_template.placeholder uses rejected alias: {template['placeholder']}")

    return errors


def _validate_capability_reference(reference: dict[str, Any], model: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    valid_ids = {
        record["artifact_id"]
        for records in model["required_artifact_identities"].values()
        for record in records
    } | {record["artifact_id"] for record in model["explicit_special_cases"]}
    valid_roles = set(model["owned_enums"]["local_usage_role"])

    artifact_id = reference.get("artifact_id")
    local_role = reference.get("local_role")
    if artifact_id not in valid_ids:
        errors.append(f"capability_reference.artifact_id unknown: {artifact_id}")
    if "local_role" not in reference:
        errors.append("capability_reference.local_role missing")
    elif local_role not in valid_roles:
        errors.append(f"capability_reference.local_role unsupported: {local_role}")
    for forbidden in model["capability_local_reference_shape"]["forbidden_repetition"]:
        field = forbidden.removeprefix("canonical ").replace(" ", "_")
        if field in reference:
            errors.append(f"capability_reference.{field} repeats canonical registry fact")
    return errors


def _capability_artifact_entries() -> dict[str, list[dict[str, Any]]]:
    entries_by_capability: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(CAPABILITY_DIR.glob("*/schemas/artifacts.yaml")):
        data = _load_yaml(path)
        capability = path.parents[1].name
        artifacts = data.get("ARTIFACTS")
        assert isinstance(artifacts, dict), f"{path} missing ARTIFACTS"
        entries_by_capability[capability] = list(artifacts.values())
    return entries_by_capability


def _validate_capability_artifact_entries(model: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    for capability, entries in _capability_artifact_entries().items():
        for entry in entries:
            entry_id = entry.get("id", "<missing id>")
            prefix = f"{capability}.{entry_id}"
            errors.extend(f"{prefix}: {error}" for error in _validate_capability_reference(entry, model))
            for legacy_field in ("name", "path", "produces", "consumes"):
                if legacy_field in entry:
                    errors.append(f"{prefix}: legacy artifact field remains: {legacy_field}")
    return errors


def _validate_docs_mapping_overrides(docs: dict[str, Any], model: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    known_names = _known_display_names(model)
    forbidden_canonical_fields = {
        "artifact_id",
        "display_name",
        "default_path",
        "consumers",
        "artifact_type",
        "scope",
        "path_template",
    }
    for index, mapping in enumerate(docs.get("mapping", [])):
        if not isinstance(mapping, dict):
            errors.append(f"mapping[{index}] must be an object")
            continue
        extra_canonical_fields = forbidden_canonical_fields & mapping.keys()
        if extra_canonical_fields:
            fields = ", ".join(sorted(extra_canonical_fields))
            errors.append(f"mapping[{index}] defines canonical registry fields: {fields}")
        if mapping.get("artifact") in known_names and not mapping.get("path"):
            errors.append(f"mapping[{index}] known artifact override missing path")
    return errors


def test_artifact_registry_contract_validates_current_model_and_canonical_schema_metadata():
    errors = _validate_registry_contract(_model_fixture(), _artifact_schema_metas())

    assert errors == []


def test_artifact_registry_contract_reports_invalid_ids_and_unsupported_special_cases_clearly():
    model = _model_fixture()
    malformed = copy.deepcopy(model)
    malformed["required_artifact_identities"]["project_root"][0]["artifact_id"] = "ghost"
    malformed["explicit_special_cases"][0]["artifact_type"] = "runtime_config"
    malformed["explicit_special_cases"][2]["path_template"]["placeholder"] = "<objective-name>"

    errors = _validate_registry_contract(malformed, _artifact_schema_metas())

    assert "required_artifact_identities.project_root[0].artifact_id unknown artifact schema: ghost" in errors
    assert "explicit_special_cases[0].artifact_type unknown: runtime_config" in errors
    assert "explicit_special_cases[2].path_template.placeholder uses rejected alias: <objective-name>" in errors


def test_capability_reference_contract_rejects_invalid_ids_missing_roles_and_repeated_registry_facts():
    model = _model_fixture()
    errors = _validate_capability_reference(
        {"artifact_id": "ghost", "display_name": "PLAN.md"},
        model,
    )

    assert errors == [
        "capability_reference.artifact_id unknown: ghost",
        "capability_reference.local_role missing",
        "capability_reference.display_name repeats canonical registry fact",
    ]

    valid_id = model["required_artifact_identities"]["project_agent_state"][0]["artifact_id"]
    assert _validate_capability_reference({"artifact_id": valid_id, "local_role": "consumes"}, model) == []
    assert _validate_capability_reference({"artifact_id": valid_id, "local_role": "observes"}, model) == [
        "capability_reference.local_role unsupported: observes"
    ]


def test_capability_artifact_schemas_use_registry_references_for_local_usage():
    errors = _validate_capability_artifact_entries(_model_fixture())

    assert errors == []


def test_docs_yaml_mapping_remains_runtime_override_data_not_canonical_registry_definition():
    model = _model_fixture()
    docs = _load_yaml(DOCS_PATH)

    assert _validate_docs_mapping_overrides(docs, model) == []

    unknown_runtime_mapping = copy.deepcopy(docs)
    unknown_runtime_mapping["mapping"].append({"artifact": "EXTRA.md", "path": "notes/EXTRA.md"})
    assert _validate_docs_mapping_overrides(unknown_runtime_mapping, model) == []

    canonical_definition = copy.deepcopy(docs)
    canonical_definition["mapping"][0]["artifact_id"] = "vision"
    canonical_definition["mapping"][0]["scope"] = "project_agent_state"

    errors = _validate_docs_mapping_overrides(canonical_definition, model)

    assert "mapping[0] defines canonical registry fields: artifact_id, scope" in errors
