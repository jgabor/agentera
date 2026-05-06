"""Tests that capability validation consumes the contract Interface."""

from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
CONTRACT_PATH = REPO_ROOT / "skills" / "agentera" / "capability_schema_contract.yaml"
CONTRACT_MODULE = REPO_ROOT / "scripts" / "capability_contract.py"
VALIDATOR = REPO_ROOT / "scripts" / "validate_capability.py"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


capability_contract = _load_module("capability_contract_interface_tests", CONTRACT_MODULE)
validate_capability = _load_module("validate_capability_interface_tests", VALIDATOR)


def _write_contract(tmp_path: Path, data: dict) -> Path:
    path = tmp_path / "contract.yaml"
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    return path


def _capability_dirs() -> list[Path]:
    return sorted(path for path in CAPABILITIES_DIR.iterdir() if path.is_dir())


@pytest.mark.parametrize("cap_dir", _capability_dirs(), ids=lambda path: path.name)
def test_each_capability_validates_through_loaded_contract_model(cap_dir: Path):
    contract = capability_contract.load_capability_schema_contract(CONTRACT_PATH)
    groups = validate_capability.collect_schema_groups(
        cap_dir / contract.directory_rules.schemas_path,
        contract.required_groups,
        contract.directory_rules.schema_glob,
    )

    errors: list[str] = []
    errors.extend(validate_capability.check_directory_structure(cap_dir, contract))
    errors.extend(validate_capability.check_required_groups(groups, str(cap_dir), contract))
    errors.extend(validate_capability.check_numbered_entries(groups, str(cap_dir), contract))
    errors.extend(validate_capability.check_stable_ids(groups, str(cap_dir), contract))
    errors.extend(validate_capability.check_trigger_priorities(groups, str(cap_dir), contract))

    assert errors == [], f"Expected {cap_dir.name} to satisfy loaded contract model:\n" + "\n".join(errors)


def test_capability_validation_observes_fixture_contract_without_validator_constants(tmp_path: Path):
    contract_data = yaml.safe_load(CONTRACT_PATH.read_text())
    modified = copy.deepcopy(contract_data)
    modified["REQUIRED_GROUPS"] = ["TRIGGERS"]
    modified["GROUP_PREFIXES"] = {"TRIGGERS": modified["GROUP_PREFIXES"]["TRIGGERS"]}
    modified["ENTRY_REQUIREMENTS"]["groups"] = {
        "TRIGGERS": modified["ENTRY_REQUIREMENTS"]["groups"]["TRIGGERS"]
    }
    for self_group in ("ARTIFACTS", "VALIDATION", "EXIT_CONDITIONS"):
        modified.pop(self_group)
    contract_path = _write_contract(tmp_path, modified)

    cap_dir = tmp_path / "trigger_only"
    schemas_dir = cap_dir / "schemas"
    schemas_dir.mkdir(parents=True)
    (cap_dir / "prose.md").write_text("# Trigger Only\n")
    (schemas_dir / "triggers.yaml").write_text(
        yaml.safe_dump(
            {
                "TRIGGERS": {
                    1: {
                        "id": "T1",
                        "description": "fixture trigger",
                        "priority": "high",
                    }
                }
            },
            sort_keys=False,
        )
    )

    assert validate_capability.validate_capability(cap_dir, CONTRACT_PATH) != []
    assert validate_capability.validate_capability(cap_dir, contract_path) == []


def test_contract_model_is_the_schema_rule_surface_not_validator_constants():
    contract = capability_contract.load_capability_schema_contract(CONTRACT_PATH)
    validator_names = set(vars(validate_capability))

    assert contract.required_groups
    assert contract.trigger_priority_rules.allowed_values
    assert contract.primitive_references.fields
    assert "REQUIRED_GROUPS" not in validator_names
    assert "GROUP_PREFIXES" not in validator_names
    assert "VALID_PRIORITIES" not in validator_names
    assert "PROTOCOL_REFERENCEABLE_FIELDS" not in validator_names
