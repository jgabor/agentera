"""Characterize current capability validator behavior before contract migration."""

from __future__ import annotations

import importlib.util
import copy
import subprocess
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
VALIDATOR = REPO_ROOT / "scripts" / "validate_capability.py"
CONTRACT_PATH = REPO_ROOT / "skills" / "agentera" / "capability_schema_contract.yaml"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"


@dataclass(frozen=True)
class CliResult:
    exit_code: int
    stdout: list[str]
    stderr: list[str]


def _load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("validate_capability_characterization", VALIDATOR)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


validate_capability = _load_validator()


def _run_validator(cap_dir: Path, *extra_args: str | Path) -> CliResult:
    result = subprocess.run(
        ["uv", "run", str(VALIDATOR), str(cap_dir), "--contract", str(CONTRACT_PATH), *map(str, extra_args)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    return CliResult(
        result.returncode,
        result.stdout.splitlines(),
        result.stderr.splitlines(),
    )


def _write_capability(cap_dir: Path, schema_text: str | None, *, prose: bool = True) -> Path:
    cap_dir.mkdir(parents=True, exist_ok=True)
    if prose:
        (cap_dir / "prose.md").write_text("# Fixture\n")
    schemas = cap_dir / "schemas"
    schemas.mkdir()
    if schema_text is not None:
        (schemas / "fixture.yaml").write_text(textwrap.dedent(schema_text))
    return cap_dir


def _valid_schema(*, trigger_priority: str = "high", trigger_id: str = "T1") -> str:
    return f"""\
        TRIGGERS:
          1:
            id: {trigger_id}
            description: Trigger entry.
            priority: {trigger_priority}
        ARTIFACTS:
          1:
            id: A1
            description: Artifact entry.
        VALIDATION:
          1:
            id: V1
            description: Validation entry.
        EXIT_CONDITIONS:
          1:
            id: E1
            description: Exit entry.
    """


def _write_contract(tmp_path: Path, mutate) -> Path:
    data = copy.deepcopy(yaml.safe_load(CONTRACT_PATH.read_text()))
    mutate(data)
    path = tmp_path / "contract.yaml"
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    return path


def _expected_stdout(cap_dir: Path, *, primitives: bool = False) -> list[str]:
    lines = [
        f"Validating capability: {cap_dir.resolve()}",
        f"Using contract: {CONTRACT_PATH}",
    ]
    if primitives:
        lines.append(f"Checking primitive references against: {PROTOCOL_PATH}")
    lines.append("PASS: capability directory is valid")
    return lines


def _expected_failure_stdout(cap_dir: Path) -> list[str]:
    return [
        f"Validating capability: {cap_dir.resolve()}",
        f"Using contract: {CONTRACT_PATH}",
    ]


def test_validator_cli_characterizes_valid_fixture(tmp_path):
    cap_dir = _write_capability(tmp_path / "valid", _valid_schema())

    result = _run_validator(cap_dir)

    assert result.exit_code == 0
    assert result.stdout == _expected_stdout(cap_dir)
    assert result.stderr == []


def test_validator_cli_characterizes_missing_directory_fixture(tmp_path):
    cap_dir = tmp_path / "missing-directory"


    result = _run_validator(cap_dir)

    source = str(cap_dir.resolve())


    assert result.exit_code == 1
    assert result.stdout == _expected_failure_stdout(cap_dir)
    assert result.stderr == [
        "FAILED:",
        f"  V1 [error]: prose.md not found in {source}",
        f"  V1 [error]: schemas/ directory not found in {source}",
    ]


def test_validator_cli_characterizes_empty_schemas_fixture(tmp_path):
    cap_dir = _write_capability(tmp_path / "empty-schemas", None)
    source = str(cap_dir.resolve())

    result = _run_validator(cap_dir)

    assert result.exit_code == 1
    assert result.stdout == _expected_failure_stdout(cap_dir)
    assert result.stderr == [
        "FAILED:",
        f"  V1 [error]: schemas/ contains no .yaml files in {source}",
        f"  V2 [error]: required group TRIGGERS missing in {source}",
        f"  V2 [error]: required group ARTIFACTS missing in {source}",
        f"  V2 [error]: required group VALIDATION missing in {source}",
        f"  V2 [error]: required group EXIT_CONDITIONS missing in {source}",
    ]


def test_validator_cli_characterizes_missing_group_fixture(tmp_path):
    cap_dir = _write_capability(
        tmp_path / "missing-group",
        """\
        TRIGGERS:
          1:
            id: T1
            description: Trigger entry.
            priority: high
        ARTIFACTS:
          1:
            id: A1
            description: Artifact entry.
        VALIDATION:
          1:
            id: V1
            description: Validation entry.
        """,
    )
    source = str(cap_dir.resolve())

    result = _run_validator(cap_dir)

    assert result.exit_code == 1
    assert result.stdout == _expected_failure_stdout(cap_dir)
    assert result.stderr == [
        "FAILED:",
        f"  V2 [error]: required group EXIT_CONDITIONS missing in {source}",
    ]


def test_validator_cli_characterizes_malformed_group_fixture(tmp_path):
    cap_dir = _write_capability(
        tmp_path / "malformed-group",
        """\
        TRIGGERS:
          - not a mapping
        ARTIFACTS:
          1:
            id: A1
            description: Artifact entry.
        VALIDATION:
          1:
            id: V1
            description: Validation entry.
        EXIT_CONDITIONS:
          1:
            id: E1
            description: Exit entry.
        """,
    )
    result = _run_validator(cap_dir)

    assert result.exit_code == 0
    assert result.stdout == _expected_stdout(cap_dir)
    assert result.stderr == []


def test_validator_cli_characterizes_invalid_priority_fixture(tmp_path):
    cap_dir = _write_capability(tmp_path / "invalid-priority", _valid_schema(trigger_priority="urgent"))
    source = str(cap_dir.resolve())

    result = _run_validator(cap_dir)

    assert result.exit_code == 1
    assert result.stdout == _expected_failure_stdout(cap_dir)
    assert result.stderr == [
        "FAILED:",
        f"  V5b [error]: TRIGGERS entry 1 in {source} has invalid priority='urgent' (must be one of: high, medium, low)",
    ]


def test_validator_cli_characterizes_deprecation_warning_fixture(tmp_path):
    cap_dir = _write_capability(
        tmp_path / "deprecation-warning",
        _valid_schema().replace(
            "description: Artifact entry.",
            "description: Artifact entry.\n            deprecated: true\n            replaced_by: A99",
        ),
    )
    source = str(cap_dir.resolve())

    result = _run_validator(cap_dir)
    assert result.exit_code == 0
    assert result.stdout == _expected_stdout(cap_dir)
    assert result.stderr == [
        f"V5 [warning]: entry 1 (A1) in ARTIFACTS in {source} has replaced_by='A99' which does not match any entry ID",
    ]


def test_validate_capability_observes_contract_required_groups(tmp_path):
    cap_dir = _write_capability(tmp_path / "valid", _valid_schema())
    alternate_contract = _write_contract(
        tmp_path,
        lambda data: (
            data["REQUIRED_GROUPS"].append("EXTRA_GROUP"),
            data["GROUP_PREFIXES"].__setitem__("EXTRA_GROUP", "X"),
            data["ENTRY_REQUIREMENTS"]["groups"].__setitem__(
                "EXTRA_GROUP", {"required_fields": ["id", "description"]}
            ),
            data.__setitem__("EXTRA_GROUP", {}),
        ),
    )

    errors = validate_capability.validate_capability(cap_dir, alternate_contract)

    assert errors == [f"V2 [error]: required group EXTRA_GROUP missing in {cap_dir}"]


def test_validate_capability_observes_contract_required_fields(tmp_path):
    cap_dir = _write_capability(tmp_path / "valid", _valid_schema())
    alternate_contract = _write_contract(
        tmp_path,
        lambda data: data["ENTRY_REQUIREMENTS"]["groups"]["ARTIFACTS"]["required_fields"].append("name"),
    )

    errors = validate_capability.validate_capability(cap_dir, alternate_contract)

    assert errors == [f"V4 [error]: entry 1 in ARTIFACTS in {cap_dir} missing 'name'"]


def test_validate_capability_observes_contract_priority_enum(tmp_path):
    cap_dir = _write_capability(tmp_path / "valid", _valid_schema(trigger_priority="urgent"))
    alternate_contract = _write_contract(
        tmp_path,
        lambda data: data["FIELD_RULES"]["TRIGGERS"]["priority"].__setitem__(
            "allowed_values", ["urgent"]
        ),
    )

    errors = validate_capability.validate_capability(cap_dir, alternate_contract)

    assert errors == []


def test_validate_capability_observes_contract_directory_yaml_minimum(tmp_path):
    cap_dir = _write_capability(tmp_path / "valid", _valid_schema())
    alternate_contract = _write_contract(
        tmp_path,
        lambda data: data["DIRECTORY_REQUIREMENTS"]["schema_files"].__setitem__(
            "minimum_count", 2
        ),
    )

    errors = validate_capability.validate_capability(cap_dir, alternate_contract)

    assert errors == [f"V1 [error]: schemas/ contains no .yaml files in {cap_dir}"]


def test_group_prefixes_remain_declared_but_not_enforced(tmp_path):
    cap_dir = _write_capability(tmp_path / "wrong-prefix", _valid_schema(trigger_id="WRONG1"))

    errors = validate_capability.validate_capability(cap_dir, CONTRACT_PATH)

    assert errors == []


def test_declared_contract_rules_are_recorded_as_preserve_standardize_or_defer():
    contract = yaml.safe_load(CONTRACT_PATH.read_text())
    drift_inventory = {
        "GROUP_PREFIXES": {
            "declared": contract["GROUP_PREFIXES"],
            "current_validator_owner": "CapabilitySchemaContract.group_prefixes",
            "current_behavior": "declared in contract and loaded into the model, but capability entry ids are not checked against prefixes",
            "decision": "preserve",
        },
        "priority_allowed_values": {
            "declared": contract["FIELD_RULES"]["TRIGGERS"]["priority"]["allowed_values"],
            "current_validator_owner": "CapabilitySchemaContract.trigger_priority_rules",
            "current_behavior": "enforced for TRIGGERS entries from the loaded contract model",
            "decision": "standardize",
        },
        "priority_required_for_triggers": {
            "declared": contract["FIELD_RULES"]["TRIGGERS"]["priority"]["required"],
            "current_validator_owner": "CapabilitySchemaContract.trigger_priority_rules",
            "current_behavior": "missing TRIGGERS priority is enforced from the loaded contract model",
            "decision": "standardize",
        },
        "directory_requirements": {
            "declared": contract["DIRECTORY_REQUIREMENTS"],
            "current_validator_owner": "CapabilitySchemaContract.directory_rules",
            "current_behavior": "prose.md, schemas/, and at least one schemas/*.yaml are enforced from the loaded contract model",
            "decision": "standardize",
        },
        "routing_and_exit_vocabulary": {
            "declared": "referenced by SKILL.md and separate TODO scope, not capability_schema_contract.yaml structure rules",
            "current_validator_owner": "none in scripts/validate_capability.py",
            "current_behavior": "not enforced by current capability schema validator",
            "decision": "defer",
        },
    }

    assert drift_inventory["GROUP_PREFIXES"]["decision"] == "preserve"
    assert drift_inventory["priority_allowed_values"]["decision"] == "standardize"
    assert drift_inventory["priority_required_for_triggers"]["decision"] == "standardize"
    assert drift_inventory["directory_requirements"]["decision"] == "standardize"
    assert drift_inventory["routing_and_exit_vocabulary"]["decision"] == "defer"


def test_primitive_reference_ownership_split_between_field_mapping_and_protocol_values(tmp_path):
    cap_dir = _write_capability(
        tmp_path / "primitive-reference",
        _valid_schema().replace(
            "description: Validation entry.",
            "description: Validation entry.\n            severity: experimental",
        ),
    )
    protocol_path = tmp_path / "protocol.yaml"
    protocol = yaml.safe_load(PROTOCOL_PATH.read_text())
    protocol["SEVERITY_FINDING"][99] = {
        "id": "SF99",
        "value": "experimental",
        "meaning": "Fixture-only value proving protocol.yaml owns primitive values.",
    }
    protocol_path.write_text(yaml.safe_dump(protocol))

    errors = validate_capability.check_primitive_references(cap_dir, protocol_path)

    assert errors == []
    contract = validate_capability.load_capability_schema_contract(CONTRACT_PATH)
    assert contract.primitive_references.fields["severity"] == (
        "SEVERITY_FINDING",
        "SEVERITY_ISSUE",
    )
    assert "experimental" in validate_capability.build_protocol_value_lookup(protocol)["SEVERITY_FINDING"]


def test_primitive_reference_field_mapping_comes_from_contract_fixture(tmp_path):
    cap_dir = _write_capability(
        tmp_path / "primitive-contract-mapping",
        _valid_schema().replace(
            "description: Validation entry.",
            "description: Validation entry.\n            severity: complete",
        ),
    )
    contract_path = _write_contract(
        tmp_path,
        lambda data: data["PRIMITIVE_REFERENCE_FIELDS"]["fields"]["severity"].__setitem__(
            "protocol_groups", ["EXIT_SIGNALS"]
        ),
    )

    errors = validate_capability.check_primitive_references(
        cap_dir, PROTOCOL_PATH, contract_path
    )

    assert errors == []
