#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Capability schema contract loader and bootstrap model.

``capability_schema_contract.yaml`` owns capability schema structure. This module
turns that YAML contract into the executable model consumed by capability
validation; protocol primitive values remain owned by ``protocol.yaml``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


BOOTSTRAP_RULE_SECTIONS = (
    "DIRECTORY_REQUIREMENTS",
    "ENTRY_REQUIREMENTS",
    "FIELD_RULES",
    "PRIMITIVE_REFERENCE_FIELDS",
)


class ContractBootstrapError(ValueError):
    """Raised when a contract cannot produce a safe model."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        super().__init__("; ".join(errors))


@dataclass(frozen=True)
class DirectoryRules:
    prose_path: str
    schemas_path: str
    schema_glob: str
    minimum_schema_files: int


@dataclass(frozen=True)
class EntrySchema:
    fields: dict[str, dict[str, Any]]


@dataclass(frozen=True)
class EntryRules:
    default_required_fields: tuple[str, ...]
    required_fields_by_group: dict[str, tuple[str, ...]]
    deprecation: dict[str, Any]


@dataclass(frozen=True)
class TriggerPriorityRules:
    required: bool
    allowed_values: tuple[str, ...]


@dataclass(frozen=True)
class PrimitiveReferenceRules:
    protocol_values_authority: str
    fields: dict[str, tuple[str, ...]]


@dataclass(frozen=True)
class CapabilitySchemaContract:
    path: Path
    required_groups: tuple[str, ...]
    directory_rules: DirectoryRules
    entry_schema: EntrySchema
    entry_rules: EntryRules
    trigger_priority_rules: TriggerPriorityRules
    deprecation_rules: dict[str, Any]
    group_prefixes: dict[str, str]
    primitive_references: PrimitiveReferenceRules


def load_capability_schema_contract(contract_path: Path) -> CapabilitySchemaContract:
    """Load, bootstrap-validate, and build a capability schema contract model."""

    with open(contract_path) as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ContractBootstrapError(
            [f"contract root in {contract_path} must be a mapping"]
        )
    errors = validate_contract_bootstrap(data, str(contract_path))
    if errors:
        raise ContractBootstrapError(errors)
    return build_capability_schema_contract(data, contract_path)


def validate_contract_bootstrap(data: dict[str, Any], source_label: str) -> list[str]:
    """Validate the minimal contract facts needed before building the model."""

    errors: list[str] = []
    required_groups = _required_groups(data, source_label, errors)
    _check_entry_schema(data, source_label, errors)
    _check_group_prefixes(data, source_label, required_groups, errors)
    _check_rule_sections(data, source_label, errors)
    _check_self_groups(data, source_label, required_groups, errors)
    return errors


def build_capability_schema_contract(
    data: dict[str, Any], contract_path: Path
) -> CapabilitySchemaContract:
    """Build a typed view over a bootstrap-valid contract mapping."""

    directory = data["DIRECTORY_REQUIREMENTS"]
    schema_files = directory["schema_files"]
    entry_requirements = data["ENTRY_REQUIREMENTS"]
    trigger_priority = data["FIELD_RULES"]["TRIGGERS"]["priority"]
    primitive_refs = data["PRIMITIVE_REFERENCE_FIELDS"]

    entry_rules = EntryRules(
        default_required_fields=tuple(entry_requirements["default_required_fields"]),
        required_fields_by_group={
            group_name: tuple(group_rule["required_fields"])
            for group_name, group_rule in entry_requirements["groups"].items()
        },
        deprecation=dict(entry_requirements["deprecation"]),
    )

    return CapabilitySchemaContract(
        path=contract_path,
        required_groups=tuple(data["REQUIRED_GROUPS"]),
        directory_rules=DirectoryRules(
            prose_path=directory["prose_file"]["path"],
            schemas_path=directory["schemas_directory"]["path"],
            schema_glob=schema_files["glob"],
            minimum_schema_files=schema_files["minimum_count"],
        ),
        entry_schema=EntrySchema(fields=dict(data["ENTRY_SCHEMA"]["fields"])),
        entry_rules=entry_rules,
        trigger_priority_rules=TriggerPriorityRules(
            required=bool(trigger_priority["required"]),
            allowed_values=tuple(trigger_priority["allowed_values"]),
        ),
        deprecation_rules=entry_rules.deprecation,
        group_prefixes=dict(data["GROUP_PREFIXES"]),
        primitive_references=PrimitiveReferenceRules(
            protocol_values_authority=primitive_refs["protocol_values_authority"],
            fields={
                field_name: tuple(field_rule["protocol_groups"])
                for field_name, field_rule in primitive_refs["fields"].items()
            },
        ),
    )


def _required_groups(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> tuple[str, ...]:
    groups = data.get("REQUIRED_GROUPS")
    if not isinstance(groups, list) or not groups or not all(
        isinstance(group, str) and group for group in groups
    ):
        errors.append(
            f"bootstrap [error]: REQUIRED_GROUPS in {source_label} must be a non-empty list of strings"
        )
        return ()
    return tuple(groups)


def _check_entry_schema(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> None:
    entry_schema = data.get("ENTRY_SCHEMA")
    if not isinstance(entry_schema, dict):
        errors.append(
            f"bootstrap [error]: ENTRY_SCHEMA in {source_label} must be a mapping"
        )
        return
    fields = entry_schema.get("fields")
    if not isinstance(fields, dict):
        errors.append(
            f"bootstrap [error]: ENTRY_SCHEMA.fields in {source_label} must be a mapping"
        )
        return
    for field_name in ("id", "description"):
        field_rule = fields.get(field_name)
        if not isinstance(field_rule, dict) or field_rule.get("required") is not True:
            errors.append(
                f"bootstrap [error]: ENTRY_SCHEMA.fields.{field_name} in {source_label} must exist with required=true"
            )


def _check_group_prefixes(
    data: dict[str, Any], source_label: str, required_groups: tuple[str, ...], errors: list[str]
) -> None:
    prefixes = data.get("GROUP_PREFIXES")
    if not isinstance(prefixes, dict):
        errors.append(
            f"bootstrap [error]: GROUP_PREFIXES in {source_label} must be a mapping"
        )
        return
    for group_name in required_groups:
        prefix = prefixes.get(group_name)
        if not isinstance(prefix, str) or not prefix:
            errors.append(
                f"bootstrap [error]: GROUP_PREFIXES.{group_name} in {source_label} must be a non-empty string"
            )


def _check_rule_sections(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> None:
    for section in BOOTSTRAP_RULE_SECTIONS:
        if not isinstance(data.get(section), dict):
            errors.append(
                f"bootstrap [error]: {section} in {source_label} must be present as a mapping"
            )
    _check_directory_rules(data, source_label, errors)
    _check_entry_rules(data, source_label, errors)
    _check_trigger_priority_rules(data, source_label, errors)
    _check_primitive_reference_rules(data, source_label, errors)


def _check_directory_rules(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> None:
    directory = data.get("DIRECTORY_REQUIREMENTS")
    if not isinstance(directory, dict):
        return
    for section in ("prose_file", "schemas_directory", "schema_files"):
        if not isinstance(directory.get(section), dict):
            errors.append(
                f"bootstrap [error]: DIRECTORY_REQUIREMENTS.{section} in {source_label} must be a mapping"
            )
    schema_files = directory.get("schema_files")
    if isinstance(schema_files, dict):
        if not isinstance(schema_files.get("glob"), str) or not schema_files.get("glob"):
            errors.append(
                f"bootstrap [error]: DIRECTORY_REQUIREMENTS.schema_files.glob in {source_label} must be a non-empty string"
            )
        if not isinstance(schema_files.get("minimum_count"), int) or schema_files["minimum_count"] < 1:
            errors.append(
                f"bootstrap [error]: DIRECTORY_REQUIREMENTS.schema_files.minimum_count in {source_label} must be a positive integer"
            )


def _check_entry_rules(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> None:
    rules = data.get("ENTRY_REQUIREMENTS")
    if not isinstance(rules, dict):
        return
    if not isinstance(rules.get("default_required_fields"), list):
        errors.append(
            f"bootstrap [error]: ENTRY_REQUIREMENTS.default_required_fields in {source_label} must be a list"
        )
    if not isinstance(rules.get("groups"), dict):
        errors.append(
            f"bootstrap [error]: ENTRY_REQUIREMENTS.groups in {source_label} must be a mapping"
        )
    if not isinstance(rules.get("deprecation"), dict):
        errors.append(
            f"bootstrap [error]: ENTRY_REQUIREMENTS.deprecation in {source_label} must be a mapping"
        )


def _check_trigger_priority_rules(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> None:
    field_rules = data.get("FIELD_RULES")
    if not isinstance(field_rules, dict):
        return
    priority = field_rules.get("TRIGGERS", {}).get("priority")
    if not isinstance(priority, dict):
        errors.append(
            f"bootstrap [error]: FIELD_RULES.TRIGGERS.priority in {source_label} must be a mapping"
        )
        return
    if priority.get("required") is not True:
        errors.append(
            f"bootstrap [error]: FIELD_RULES.TRIGGERS.priority.required in {source_label} must be true"
        )
    allowed = priority.get("allowed_values")
    if not isinstance(allowed, list) or not allowed or not all(isinstance(v, str) for v in allowed):
        errors.append(
            f"bootstrap [error]: FIELD_RULES.TRIGGERS.priority.allowed_values in {source_label} must be a non-empty list of strings"
        )


def _check_primitive_reference_rules(
    data: dict[str, Any], source_label: str, errors: list[str]
) -> None:
    primitive_refs = data.get("PRIMITIVE_REFERENCE_FIELDS")
    if not isinstance(primitive_refs, dict):
        return
    if primitive_refs.get("protocol_values_authority") != "protocol.yaml":
        errors.append(
            f"bootstrap [error]: PRIMITIVE_REFERENCE_FIELDS.protocol_values_authority in {source_label} must be protocol.yaml"
        )
    fields = primitive_refs.get("fields")
    if not isinstance(fields, dict):
        errors.append(
            f"bootstrap [error]: PRIMITIVE_REFERENCE_FIELDS.fields in {source_label} must be a mapping"
        )
        return
    for field_name, field_rule in fields.items():
        protocol_groups = field_rule.get("protocol_groups") if isinstance(field_rule, dict) else None
        if not isinstance(protocol_groups, list) or not protocol_groups or not all(
            isinstance(group, str) and group for group in protocol_groups
        ):
            errors.append(
                f"bootstrap [error]: PRIMITIVE_REFERENCE_FIELDS.fields.{field_name}.protocol_groups in {source_label} must be a non-empty list of strings"
            )


def _check_self_groups(
    data: dict[str, Any], source_label: str, required_groups: tuple[str, ...], errors: list[str]
) -> None:
    for group_name in required_groups:
        if group_name not in data:
            errors.append(
                f"bootstrap [error]: self group {group_name} missing in {source_label}"
            )
        elif not isinstance(data[group_name], dict):
            errors.append(
                f"bootstrap [error]: self group {group_name} in {source_label} must be a mapping"
            )
