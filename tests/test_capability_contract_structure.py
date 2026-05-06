"""Assert capability schema contract rules are machine-readable."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "skills" / "agentera" / "capability_schema_contract.yaml"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"


def _load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def test_contract_structures_trigger_priority_rules_without_prose_parsing():
    contract = _load_yaml(CONTRACT_PATH)

    priority_rule = contract["FIELD_RULES"]["TRIGGERS"]["priority"]

    assert priority_rule["required"] is True
    assert priority_rule["allowed_values"] == ["high", "medium", "low"]


def test_contract_structures_directory_requirements():
    contract = _load_yaml(CONTRACT_PATH)
    directory = contract["DIRECTORY_REQUIREMENTS"]

    assert directory["prose_file"] == {
        "path": "prose.md",
        "type": "file",
        "required": True,
        "description": "Behavioral instructions the agent reads.",
    }
    assert directory["schemas_directory"] == {
        "path": "schemas",
        "type": "directory",
        "required": True,
        "description": "Directory containing YAML schema files.",
    }
    assert directory["schema_files"]["directory"] == "schemas"
    assert directory["schema_files"]["glob"] == "*.yaml"
    assert directory["schema_files"]["minimum_count"] == 1


def test_contract_structures_per_group_entry_and_deprecation_rules():
    contract = _load_yaml(CONTRACT_PATH)
    entries = contract["ENTRY_REQUIREMENTS"]

    assert entries["default_required_fields"] == ["id", "description"]
    assert entries["groups"] == {
        "TRIGGERS": {"required_fields": ["id", "description", "priority"]},
        "ARTIFACTS": {"required_fields": ["id", "description"]},
        "VALIDATION": {"required_fields": ["id", "description"]},
        "EXIT_CONDITIONS": {"required_fields": ["id", "description"]},
    }
    assert entries["deprecation"] == {
        "marker_field": "deprecated",
        "marker_value": True,
        "replacement_field": "replaced_by",
        "replacement_required_when_deprecated": True,
        "replacement_scope": "same_group",
        "replacement_target_field": "id",
        "unresolved_replacement_severity": "warning",
        "preserve_deprecated_entries": True,
    }


def test_contract_owns_primitive_reference_field_mapping_not_protocol_values():
    contract = _load_yaml(CONTRACT_PATH)
    protocol = _load_yaml(PROTOCOL_PATH)

    primitive_refs = contract["PRIMITIVE_REFERENCE_FIELDS"]
    mapping = {
        field_name: field_rule["protocol_groups"]
        for field_name, field_rule in primitive_refs["fields"].items()
    }

    assert primitive_refs["protocol_values_authority"] == "protocol.yaml"
    assert mapping == {
        "severity": ["SEVERITY_FINDING", "SEVERITY_ISSUE"],
        "finding_severity": ["SEVERITY_FINDING"],
        "issue_severity": ["SEVERITY_ISSUE"],
        "decision_label": ["DECISION_LABELS"],
        "exit_signal": ["EXIT_SIGNALS"],
        "phase": ["PHASES"],
    }
    for protocol_groups in mapping.values():
        for group in protocol_groups:
            assert group in protocol
    for field_rule in primitive_refs["fields"].values():
        assert "allowed_values" not in field_rule
        assert "values" not in field_rule
