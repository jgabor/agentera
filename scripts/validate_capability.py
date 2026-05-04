# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""
Validate a capability directory against the capability schema contract.

Usage:
    uv run scripts/validate_capability.py <capability_dir> [--contract <contract.yaml>]
    uv run scripts/validate_capability.py --self-validate [--contract <contract.yaml>]

Exit codes:
    0 - all checks pass
    1 - validation failed
"""

import argparse
import sys
from pathlib import Path

import yaml

REQUIRED_GROUPS = ("TRIGGERS", "ARTIFACTS", "VALIDATION", "EXIT_CONDITIONS")
GROUP_PREFIXES = {
    "TRIGGERS": "T",
    "ARTIFACTS": "A",
    "VALIDATION": "V",
    "EXIT_CONDITIONS": "E",
}


def load_contract(contract_path: Path) -> dict:
    with open(contract_path) as f:
        return yaml.safe_load(f)


def load_schema_file(path: Path) -> dict:
    with open(path) as f:
        return yaml.safe_load(f) or {}


def collect_schema_groups(schemas_dir: Path) -> dict[str, dict]:
    """Load all YAML files in schemas/ and union their top-level groups."""
    combined: dict[str, dict] = {}
    for yaml_file in sorted(schemas_dir.glob("*.yaml")):
        data = load_schema_file(yaml_file)
        for group_name, group_data in data.items():
            if group_name in REQUIRED_GROUPS:
                if group_name not in combined:
                    combined[group_name] = {}
                if isinstance(group_data, dict):
                    combined[group_name].update(group_data)
    return combined


def check_directory_structure(cap_dir: Path) -> list[str]:
    """V1: Check prose.md and schemas/ exist."""
    errors = []
    prose = cap_dir / "prose.md"
    schemas = cap_dir / "schemas"

    if not prose.is_file():
        errors.append(f"V1 [error]: prose.md not found in {cap_dir}")
    if not schemas.is_dir():
        errors.append(f"V1 [error]: schemas/ directory not found in {cap_dir}")
    elif not list(schemas.glob("*.yaml")):
        errors.append(f"V1 [error]: schemas/ contains no .yaml files in {cap_dir}")
    return errors


def check_required_groups(groups: dict[str, dict], source_label: str) -> list[str]:
    """V2: Check all required groups are present."""
    errors = []
    for rg in REQUIRED_GROUPS:
        if rg not in groups:
            errors.append(f"V2 [error]: required group {rg} missing in {source_label}")
    return errors


def check_numbered_entries(groups: dict[str, dict], source_label: str) -> list[str]:
    """V3: Check entries use numeric keys."""
    errors = []
    for group_name, entries in groups.items():
        if group_name not in REQUIRED_GROUPS:
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


def check_stable_ids(groups: dict[str, dict], source_label: str) -> list[str]:
    """V4: Check every entry has id and description fields."""
    errors = []
    for group_name, entries in groups.items():
        if group_name not in REQUIRED_GROUPS:
            continue
        if not isinstance(entries, dict):
            continue
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                errors.append(
                    f"V4 [error]: entry {key} in {group_name} in {source_label} is not a mapping"
                )
                continue
            if "id" not in entry:
                errors.append(
                    f"V4 [error]: entry {key} in {group_name} in {source_label} missing 'id'"
                )
            if "description" not in entry:
                errors.append(
                    f"V4 [error]: entry {key} in {group_name} in {source_label} missing 'description'"
                )
    return errors


def check_deprecation(groups: dict[str, dict], source_label: str) -> list[str]:
    """V5: Check deprecated entries have replaced_by referencing valid IDs."""
    warnings = []
    for group_name, entries in groups.items():
        if group_name not in REQUIRED_GROUPS:
            continue
        if not isinstance(entries, dict):
            continue
        valid_ids = set()
        for entry in entries.values():
            if isinstance(entry, dict) and "id" in entry:
                valid_ids.add(entry["id"])
        for key, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            if entry.get("deprecated"):
                replaced = entry.get("replaced_by")
                if not replaced:
                    warnings.append(
                        f"V5 [warning]: entry {key} ({entry.get('id', '?')}) "
                        f"in {group_name} in {source_label} is deprecated but has no replaced_by"
                    )
                elif replaced not in valid_ids:
                    warnings.append(
                        f"V5 [warning]: entry {key} ({entry.get('id', '?')}) "
                        f"in {group_name} in {source_label} has replaced_by={replaced!r} "
                        f"which does not match any entry ID"
                    )
    return warnings


def validate_contract_self(contract_path: Path) -> list[str]:
    """V6: Validate the contract file against its own rules.

    The contract file IS a valid capability schema. We load it, extract the
    required groups, and run all checks on it.
    """
    data = load_contract(contract_path)
    errors: list[str] = []

    groups: dict[str, dict] = {}
    for group_name in REQUIRED_GROUPS:
        if group_name in data and isinstance(data[group_name], dict):
            groups[group_name] = data[group_name]

    errors.extend(check_required_groups(groups, str(contract_path)))
    errors.extend(check_numbered_entries(groups, str(contract_path)))
    errors.extend(check_stable_ids(groups, str(contract_path)))

    warnings = check_deprecation(groups, str(contract_path))
    for w in warnings:
        print(w, file=sys.stderr)

    return errors


def validate_capability(cap_dir: Path, contract_path: Path) -> list[str]:
    """Full validation of a capability directory."""
    all_errors: list[str] = []

    all_errors.extend(check_directory_structure(cap_dir))

    schemas_dir = cap_dir / "schemas"
    if schemas_dir.is_dir():
        groups = collect_schema_groups(schemas_dir)
        all_errors.extend(check_required_groups(groups, str(cap_dir)))
        all_errors.extend(check_numbered_entries(groups, str(cap_dir)))
        all_errors.extend(check_stable_ids(groups, str(cap_dir)))

        warnings = check_deprecation(groups, str(cap_dir))
        for w in warnings:
            print(w, file=sys.stderr)

    return all_errors


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
        "--self-validate",
        action="store_true",
        help="Validate the contract file against itself (V6: self-referential check)",
    )
    args = parser.parse_args()

    if not args.self_validate and args.capability_dir is None:
        parser.error("capability_dir is required unless --self-validate is used")

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

    cap_dir = args.capability_dir.resolve()
    print(f"Validating capability: {cap_dir}")
    print(f"Using contract: {args.contract}")

    errors = validate_capability(cap_dir, args.contract)
    if errors:
        print("FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit(1)
    print("PASS: capability directory is valid")
    sys.exit(0)


if __name__ == "__main__":
    main()
