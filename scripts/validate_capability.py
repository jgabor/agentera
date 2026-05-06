#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""
Validate a capability directory against the capability schema contract.

Usage:
    uv run scripts/validate_capability.py <capability_dir> [--contract <contract.yaml>]
    uv run scripts/validate_capability.py --self-validate [--contract <contract.yaml>]
    uv run scripts/validate_capability.py <capability_dir> --check-primitives [--protocol <protocol.yaml>]
    uv run scripts/validate_capability.py --validate-protocol [--protocol <protocol.yaml>]

Exit codes:
    0 - all checks pass
    1 - validation failed
"""

import argparse
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from capability_contract import CapabilitySchemaContract, load_capability_schema_contract

PROTOCOL_GROUPS = (
    "CONFIDENCE_SCALE",
    "SEVERITY_FINDING",
    "SEVERITY_ISSUE",
    "SEVERITY_MAPPING",
    "DECISION_LABELS",
    "EXIT_SIGNALS",
    "VISUAL_TOKENS",
    "SKILL_GLYPHS",
    "PHASES",
)

def load_contract(contract_path: Path) -> dict:
    with open(contract_path) as f:
        return yaml.safe_load(f)


def load_schema_file(path: Path) -> dict:
    with open(path) as f:
        return yaml.safe_load(f) or {}


def collect_schema_groups(
    schemas_dir: Path, required_groups: tuple[str, ...], schema_glob: str = "*.yaml"
) -> dict[str, dict]:
    """Load all YAML files in schemas/ and union their top-level groups."""
    combined: dict[str, dict] = {}
    for yaml_file in sorted(schemas_dir.glob(schema_glob)):
        data = load_schema_file(yaml_file)
        for group_name, group_data in data.items():
            if group_name in required_groups:
                if group_name not in combined:
                    combined[group_name] = {}
                if isinstance(group_data, dict):
                    combined[group_name].update(group_data)
    return combined


def check_directory_structure(cap_dir: Path, contract: CapabilitySchemaContract) -> list[str]:
    """V1: Check prose.md and schemas/ exist."""
    errors = []
    directory_rules = contract.directory_rules
    prose = cap_dir / directory_rules.prose_path
    schemas = cap_dir / directory_rules.schemas_path

    if not prose.is_file():
        errors.append(f"V1 [error]: {directory_rules.prose_path} not found in {cap_dir}")
    if not schemas.is_dir():
        errors.append(f"V1 [error]: {directory_rules.schemas_path}/ directory not found in {cap_dir}")
    elif len(list(schemas.glob(directory_rules.schema_glob))) < directory_rules.minimum_schema_files:
        errors.append(f"V1 [error]: {directory_rules.schemas_path}/ contains no .yaml files in {cap_dir}")
    return errors


def check_required_groups(
    groups: dict[str, dict], source_label: str, contract: CapabilitySchemaContract
) -> list[str]:
    """V2: Check all required groups are present."""
    errors = []
    for rg in contract.required_groups:
        if rg not in groups:
            errors.append(f"V2 [error]: required group {rg} missing in {source_label}")
    return errors


def check_numbered_entries(
    groups: dict[str, dict], source_label: str, contract: CapabilitySchemaContract
) -> list[str]:
    """V3: Check entries use numeric keys."""
    errors = []
    for group_name, entries in groups.items():
        if group_name not in contract.required_groups:
            continue
        if not isinstance(entries, dict):
            errors.append(f"V3 [error]: {group_name} in {source_label} is not a mapping")
            continue
        for key in entries:
            if not isinstance(key, int) or key < 1:
                errors.append(
                    f"V3 [error]: non-numeric key {key!r} in {group_name} in {source_label}"
                )
    return errors


def check_stable_ids(
    groups: dict[str, dict], source_label: str, contract: CapabilitySchemaContract
) -> list[str]:
    """V4: Check every entry has contract-required identity fields."""
    errors = []
    for group_name, entries in groups.items():
        if group_name not in contract.required_groups:
            continue
        if not isinstance(entries, dict):
            continue
        required_fields = contract.entry_rules.required_fields_by_group.get(
            group_name, contract.entry_rules.default_required_fields
        )
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                errors.append(
                    f"V4 [error]: entry {key} in {group_name} in {source_label} is not a mapping"
                )
                continue
            for field_name in required_fields:
                if group_name == "TRIGGERS" and field_name == "priority":
                    continue
                if field_name not in entry:
                    errors.append(
                        f"V4 [error]: entry {key} in {group_name} in {source_label} missing '{field_name}'"
                    )
    return errors


def check_trigger_priorities(
    groups: dict[str, dict], source_label: str, contract: CapabilitySchemaContract
) -> list[str]:
    """V5b: Check TRIGGERS entries have valid priority fields."""
    errors = []
    triggers = groups.get("TRIGGERS", {})
    if not isinstance(triggers, dict):
        return errors
    priority_rules = contract.trigger_priority_rules
    for key, entry in triggers.items():
        if not isinstance(entry, dict):
            continue
        priority = entry.get("priority")
        if priority is None and priority_rules.required:
            errors.append(
                f"V5b [error]: TRIGGERS entry {key} in {source_label} missing 'priority'"
            )
        elif priority is not None and priority not in priority_rules.allowed_values:
            errors.append(
                f"V5b [error]: TRIGGERS entry {key} in {source_label} has invalid priority={priority!r} "
                f"(must be one of: {', '.join(priority_rules.allowed_values)})"
            )
    return errors


def check_deprecation(
    groups: dict[str, dict], source_label: str, contract: CapabilitySchemaContract
) -> list[str]:
    """V5: Check deprecated entries have replaced_by referencing valid IDs."""
    warnings = []
    marker_field = contract.deprecation_rules["marker_field"]
    marker_value = contract.deprecation_rules["marker_value"]
    replacement_field = contract.deprecation_rules["replacement_field"]
    replacement_target = contract.deprecation_rules["replacement_target_field"]
    for group_name, entries in groups.items():
        if group_name not in contract.required_groups:
            continue
        if not isinstance(entries, dict):
            continue
        valid_ids = set()
        for entry in entries.values():
            if isinstance(entry, dict) and replacement_target in entry:
                valid_ids.add(entry[replacement_target])
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            if entry.get(marker_field) == marker_value:
                replaced = entry.get(replacement_field)
                if not replaced:
                    warnings.append(
                        f"V5 [warning]: entry {key} ({entry.get('id', '?')}) "
                        f"in {group_name} in {source_label} is deprecated but has no {replacement_field}"
                    )
                elif replaced not in valid_ids:
                    warnings.append(
                        f"V5 [warning]: entry {key} ({entry.get('id', '?')}) "
                        f"in {group_name} in {source_label} has {replacement_field}={replaced!r} "
                        f"which does not match any entry ID"
                    )
    return warnings


def validate_contract_self(contract_path: Path) -> list[str]:
    """V6: Validate the contract file against its own rules.

    The contract file IS a valid capability schema. We load it, extract the
    required groups, and run all checks on it.
    """
    contract = load_capability_schema_contract(contract_path)
    data = load_contract(contract_path)
    errors: list[str] = []

    groups: dict[str, dict] = {}
    for group_name in contract.required_groups:
        if group_name in data and isinstance(data[group_name], dict):
            groups[group_name] = data[group_name]

    errors.extend(check_required_groups(groups, str(contract_path), contract))
    errors.extend(check_numbered_entries(groups, str(contract_path), contract))
    errors.extend(check_stable_ids(groups, str(contract_path), contract))
    errors.extend(check_trigger_priorities(groups, str(contract_path), contract))

    warnings = check_deprecation(groups, str(contract_path), contract)
    for w in warnings:
        print(w, file=sys.stderr)

    return errors


def validate_capability(cap_dir: Path, contract_path: Path) -> list[str]:
    """Full validation of a capability directory."""
    contract = load_capability_schema_contract(contract_path)
    all_errors: list[str] = []

    all_errors.extend(check_directory_structure(cap_dir, contract))

    schemas_dir = cap_dir / contract.directory_rules.schemas_path
    if schemas_dir.is_dir():
        groups = collect_schema_groups(
            schemas_dir, contract.required_groups, contract.directory_rules.schema_glob
        )
        all_errors.extend(check_required_groups(groups, str(cap_dir), contract))
        all_errors.extend(check_numbered_entries(groups, str(cap_dir), contract))
        all_errors.extend(check_stable_ids(groups, str(cap_dir), contract))
        all_errors.extend(check_trigger_priorities(groups, str(cap_dir), contract))

        warnings = check_deprecation(groups, str(cap_dir), contract)
        for w in warnings:
            print(w, file=sys.stderr)

    return all_errors


def load_protocol(protocol_path: Path) -> dict:
    with open(protocol_path) as f:
        return yaml.safe_load(f)


def build_protocol_value_lookup(protocol_data: dict) -> dict[str, set[str]]:
    """Build group_name -> set of valid 'value' fields from protocol entries."""
    lookup: dict[str, set[str]] = {}
    for group_name in PROTOCOL_GROUPS:
        group = protocol_data.get(group_name)
        if not isinstance(group, dict):
            continue
        values: set[str] = set()
        for key, entry in group.items():
            if not isinstance(key, int) or not isinstance(entry, dict):
                continue
            if "value" in entry:
                values.add(entry["value"])
        if values:
            lookup[group_name] = values
    return lookup


def check_protocol_structure(protocol_data: dict, source_label: str) -> list[str]:
    """Validate protocol.yaml internal structure: numbered entries, stable IDs, group prefixes."""
    errors: list[str] = []
    prefixes = protocol_data.get("GROUP_PREFIXES", {})
    if not isinstance(prefixes, dict):
        errors.append(f"[error]: GROUP_PREFIXES missing or not a mapping in {source_label}")
        return errors

    for group_name in PROTOCOL_GROUPS:
        group = protocol_data.get(group_name)
        if not isinstance(group, dict):
            errors.append(f"[error]: group {group_name} missing in {source_label}")
            continue

        expected_prefix = prefixes.get(group_name, "")
        valid_ids: set[str] = set()
        for key, entry in group.items():
            if not isinstance(key, int):
                continue
            if not isinstance(entry, dict):
                errors.append(f"[error]: entry {key} in {group_name} is not a mapping")
                continue
            if "id" not in entry:
                errors.append(f"[error]: entry {key} in {group_name} missing 'id'")
            else:
                eid = entry["id"]
                if expected_prefix and not eid.startswith(expected_prefix):
                    errors.append(
                        f"[error]: entry {key} id={eid!r} in {group_name} "
                        f"does not match prefix {expected_prefix!r}"
                    )
                valid_ids.add(eid)

        for key, entry in group.items():
            if not isinstance(key, int) or not isinstance(entry, dict):
                continue
            if entry.get("deprecated"):
                replaced = entry.get("replaced_by")
                if not replaced:
                    errors.append(
                        f"[warning]: entry {key} ({entry.get('id', '?')}) "
                        f"in {group_name} is deprecated but has no replaced_by"
                    )
                elif replaced not in valid_ids:
                    errors.append(
                        f"[warning]: entry {key} ({entry.get('id', '?')}) "
                        f"in {group_name} has replaced_by={replaced!r} "
                        f"which does not match any entry ID"
                    )

    return errors


def check_phase_transitions(protocol_data: dict, source_label: str) -> list[str]:
    """Validate that PHASES valid_successors reference existing phase values."""
    errors: list[str] = []
    phases_group = protocol_data.get("PHASES")
    if not isinstance(phases_group, dict):
        return errors

    phase_values: set[str] = set()
    for key, entry in phases_group.items():
        if isinstance(key, int) and isinstance(entry, dict) and "value" in entry:
            phase_values.add(entry["value"])

    for key, entry in phases_group.items():
        if not isinstance(key, int) or not isinstance(entry, dict):
            continue
        successors = entry.get("valid_successors", [])
        entry_id = entry.get("id", f"entry {key}")
        for s in successors:
            if s not in phase_values:
                errors.append(
                    f"[error]: {entry_id} in PHASES has valid_successors entry "
                    f"{s!r} which is not a defined phase value"
                )
        if entry.get("self_transition") and entry.get("value") not in successors:
            errors.append(
                f"[error]: {entry_id} in PHASES has self_transition=true "
                f"but {entry['value']!r} not in valid_successors"
            )

    return errors


def validate_protocol_self(protocol_path: Path) -> list[str]:
    """Validate protocol.yaml internal consistency."""
    data = load_protocol(protocol_path)
    errors: list[str] = []
    errors.extend(check_protocol_structure(data, str(protocol_path)))
    errors.extend(check_phase_transitions(data, str(protocol_path)))
    return errors


def check_primitive_references(
    cap_dir: Path,
    protocol_path: Path,
    contract_path: Path = Path("skills/agentera/capability_schema_contract.yaml"),
) -> list[str]:
    """Check that capability schema primitive references resolve against protocol.yaml."""
    contract = load_capability_schema_contract(contract_path)
    protocol_data = load_protocol(protocol_path)
    lookup = build_protocol_value_lookup(protocol_data)
    errors: list[str] = []

    schemas_dir = cap_dir / "schemas"
    if not schemas_dir.is_dir():
        return errors

    for yaml_file in sorted(schemas_dir.glob("*.yaml")):
        data = load_schema_file(yaml_file)
        for group_name, group_data in data.items():
            if not isinstance(group_data, dict):
                continue
            for key, entry in group_data.items():
                if not isinstance(key, int) or not isinstance(entry, dict):
                    continue
                entry_id = entry.get("id", f"{group_name}.{key}")
                for field_name, protocol_groups in contract.primitive_references.fields.items():
                    if field_name not in entry:
                        continue
                    value = entry[field_name]
                    values_to_check = value if isinstance(value, list) else [value]
                    for v in values_to_check:
                        resolved = False
                        for pg in protocol_groups:
                            if pg in lookup and v in lookup[pg]:
                                resolved = True
                                break
                        if not resolved:
                            errors.append(
                                f"[error]: {entry_id} field {field_name}={v!r} "
                                f"does not resolve to any protocol primitive "
                                f"in groups {list(protocol_groups)}"
                            )

    return errors


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate a capability directory against the schema contract"
    )
    parser.add_argument(
        "capability_dir",
        nargs="?",
        type=Path,
        help="Path to the capability directory to validate",
    )
    parser.add_argument(
        "--contract",
        type=Path,
        default=Path("skills/agentera/capability_schema_contract.yaml"),
        help="Path to the capability schema contract YAML file",
    )
    parser.add_argument(
        "--protocol",
        type=Path,
        default=Path("skills/agentera/protocol.yaml"),
        help="Path to the shared protocol schema YAML file",
    )
    parser.add_argument(
        "--self-validate",
        action="store_true",
        help="Validate the contract file against itself (V6: self-referential check)",
    )
    parser.add_argument(
        "--validate-protocol",
        action="store_true",
        help="Validate protocol.yaml internal consistency",
    )
    parser.add_argument(
        "--check-primitives",
        action="store_true",
        help="Check that capability schema primitive references resolve against protocol.yaml",
    )
    args = parser.parse_args()

    if args.validate_protocol:
        print(f"Validating protocol: {args.protocol}")
        errors = validate_protocol_self(args.protocol)
        if errors:
            print("FAILED:", file=sys.stderr)
            for e in errors:
                print(f"  {e}", file=sys.stderr)
            sys.exit(1)
        print("PASS: protocol is internally consistent")
        sys.exit(0)

    if args.self_validate:
        print(f"Self-validating contract: {args.contract}")
        errors = validate_contract_self(args.contract)
        if errors:
            print("FAILED: contract does not pass its own rules:", file=sys.stderr)
            for e in errors:
                print(f"  {e}", file=sys.stderr)
            sys.exit(1)
        print("PASS: contract is self-referentially valid")
        sys.exit(0)

    if args.capability_dir is None:
        parser.error("capability_dir is required unless --self-validate or --validate-protocol is used")

    cap_dir = args.capability_dir.resolve()
    print(f"Validating capability: {cap_dir}")
    print(f"Using contract: {args.contract}")

    errors = validate_capability(cap_dir, args.contract)

    if args.check_primitives:
        print(f"Checking primitive references against: {args.protocol}")
        errors.extend(check_primitive_references(cap_dir, args.protocol, args.contract))

    if errors:
        print("FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)
    print("PASS: capability directory is valid")
    sys.exit(0)


if __name__ == "__main__":
    main()
