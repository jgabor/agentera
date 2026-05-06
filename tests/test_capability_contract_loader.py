"""Contract loader/model tests for capability schema contracts."""

from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_MODULE = REPO_ROOT / "scripts" / "capability_contract.py"
CONTRACT_PATH = REPO_ROOT / "skills" / "agentera" / "capability_schema_contract.yaml"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"
VALIDATOR = REPO_ROOT / "scripts" / "validate_capability.py"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


capability_contract = _load_module("capability_contract_loader_tests", CONTRACT_MODULE)
validate_capability = _load_module("validate_capability_loader_tests", VALIDATOR)


def _valid_contract_data() -> dict:
    return yaml.safe_load(CONTRACT_PATH.read_text())


def _write_contract(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "contract.yaml"
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    return path


def _bootstrap_errors(data: dict) -> list[str]:
    return capability_contract.validate_contract_bootstrap(data, "fixture.yaml")


def _assert_has_error_containing(errors: list[str], message: str) -> None:
    assert any(message in error for error in errors), errors


def test_load_valid_contract_builds_single_model_for_capability_rules():
    model = capability_contract.load_capability_schema_contract(CONTRACT_PATH)

    assert model.required_groups == (
        "TRIGGERS",
        "ARTIFACTS",
        "VALIDATION",
        "EXIT_CONDITIONS",
    )
    assert model.directory_rules.prose_path == "prose.md"
    assert model.directory_rules.schemas_path == "schemas"
    assert model.directory_rules.schema_glob == "*.yaml"
    assert model.directory_rules.minimum_schema_files == 1
    assert model.entry_rules.default_required_fields == ("id", "description")
    assert model.entry_rules.required_fields_by_group["TRIGGERS"] == (
        "id",
        "description",
        "priority",
    )
    assert model.trigger_priority_rules.required is True
    assert model.trigger_priority_rules.allowed_values == ("high", "medium", "low")
    assert model.deprecation_rules["marker_field"] == "deprecated"
    assert model.deprecation_rules["replacement_field"] == "replaced_by"
    assert model.group_prefixes == {
        "TRIGGERS": "T",
        "ARTIFACTS": "A",
        "VALIDATION": "V",
        "EXIT_CONDITIONS": "E",
    }
    assert model.primitive_references.protocol_values_authority == "protocol.yaml"
    assert model.primitive_references.fields == {
        "severity": ("SEVERITY_FINDING", "SEVERITY_ISSUE"),
        "finding_severity": ("SEVERITY_FINDING",),
        "issue_severity": ("SEVERITY_ISSUE",),
        "decision_label": ("DECISION_LABELS",),
        "exit_signal": ("EXIT_SIGNALS",),
        "phase": ("PHASES",),
    }


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda data: data.pop("REQUIRED_GROUPS"),
            "REQUIRED_GROUPS in fixture.yaml must be a non-empty list of strings",
        ),
        (
            lambda data: data["ENTRY_SCHEMA"].pop("fields"),
            "ENTRY_SCHEMA.fields in fixture.yaml must be a mapping",
        ),
        (
            lambda data: data["GROUP_PREFIXES"].pop("VALIDATION"),
            "GROUP_PREFIXES.VALIDATION in fixture.yaml must be a non-empty string",
        ),
        (
            lambda data: data.pop("ENTRY_REQUIREMENTS"),
            "ENTRY_REQUIREMENTS in fixture.yaml must be present as a mapping",
        ),
        (
            lambda data: data.pop("EXIT_CONDITIONS"),
            "self group EXIT_CONDITIONS missing in fixture.yaml",
        ),
    ],
)
def test_bootstrap_validation_rejects_malformed_contract_fixtures(mutate, message):
    data = copy.deepcopy(_valid_contract_data())
    mutate(data)

    _assert_has_error_containing(_bootstrap_errors(data), message)


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda data: data["DIRECTORY_REQUIREMENTS"]["schema_files"].__setitem__("minimum_count", 0),
            "DIRECTORY_REQUIREMENTS.schema_files.minimum_count in fixture.yaml must be a positive integer",
        ),
        (
            lambda data: data["ENTRY_REQUIREMENTS"].__setitem__("deprecation", []),
            "ENTRY_REQUIREMENTS.deprecation in fixture.yaml must be a mapping",
        ),
        (
            lambda data: data["FIELD_RULES"]["TRIGGERS"]["priority"].__setitem__("allowed_values", []),
            "FIELD_RULES.TRIGGERS.priority.allowed_values in fixture.yaml must be a non-empty list of strings",
        ),
        (
            lambda data: data["PRIMITIVE_REFERENCE_FIELDS"]["fields"]["severity"].__setitem__("protocol_groups", []),
            "PRIMITIVE_REFERENCE_FIELDS.fields.severity.protocol_groups in fixture.yaml must be a non-empty list of strings",
        ),
    ],
)
def test_each_rule_family_has_focused_failing_fixture_and_message(mutate, message):
    data = copy.deepcopy(_valid_contract_data())
    mutate(data)

    _assert_has_error_containing(_bootstrap_errors(data), message)


def test_load_malformed_contract_raises_deterministic_error(tmp_path):
    data = copy.deepcopy(_valid_contract_data())
    data["GROUP_PREFIXES"]["TRIGGERS"] = ""
    path = _write_contract(tmp_path, data)

    with pytest.raises(capability_contract.ContractBootstrapError) as exc_info:
        capability_contract.load_capability_schema_contract(path)

    assert exc_info.value.errors == [
        f"bootstrap [error]: GROUP_PREFIXES.TRIGGERS in {path} must be a non-empty string"
    ]


def test_protocol_primitives_remain_outside_capability_contract_model():
    model = capability_contract.load_capability_schema_contract(CONTRACT_PATH)
    protocol = yaml.safe_load(PROTOCOL_PATH.read_text())
    protocol_lookup = validate_capability.build_protocol_value_lookup(protocol)

    assert "critical" in protocol_lookup["SEVERITY_FINDING"]
    assert "complete" in protocol_lookup["EXIT_SIGNALS"]
    assert not hasattr(model, "protocol_groups")
    assert not hasattr(model, "protocol_values")
    assert model.primitive_references.fields["severity"] == (
        "SEVERITY_FINDING",
        "SEVERITY_ISSUE",
    )
    assert all(
        not hasattr(field_rule, "allowed_values")
        for field_rule in model.primitive_references.fields.values()
    )
