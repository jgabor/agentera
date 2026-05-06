#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""RuntimeAdapter registry loader and contract validator."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

import yaml


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY_PATH = ROOT / "references/adapters/runtime-adapter-registry.yaml"
EXPECTED_RUNTIME_ORDER = ("claude", "opencode", "copilot", "codex")
REQUIRED_GROUPS = (
    "identity",
    "host_detection",
    "lifecycle_events",
    "artifact_validation",
    "config_targets",
    "diagnostics",
    "documentation_claims",
)
REQUIRED_FIELDS = {
    "identity": ("runtime_id", "display_name", "adapter_family", "support_status"),
    "host_detection": ("binary_names", "host_config_locations", "availability_probe_label"),
    "lifecycle_events": ("supported_events", "unsupported_events", "event_status", "limitations"),
    "artifact_validation": ("validation_events", "hard_gate_claims", "payload_reconstruction_limitations"),
    "config_targets": ("runtime_config_files", "hook_targets", "plugin_targets", "environment_exports", "write_safety_labels"),
    "diagnostics": ("check_names", "status_labels", "gap_labels", "primary_messages"),
    "documentation_claims": ("reference_paths", "parity_claims", "install_claims", "known_drifts"),
}
LIST_FIELDS = {
    "binary_names",
    "host_config_locations",
    "supported_events",
    "unsupported_events",
    "validation_events",
    "hard_gate_claims",
    "payload_reconstruction_limitations",
    "runtime_config_files",
    "hook_targets",
    "plugin_targets",
    "environment_exports",
    "write_safety_labels",
    "check_names",
    "status_labels",
    "gap_labels",
    "primary_messages",
    "reference_paths",
    "parity_claims",
    "install_claims",
    "known_drifts",
}
STRING_FIELDS = {"runtime_id", "display_name", "adapter_family", "support_status", "availability_probe_label"}
MAP_FIELDS = {"event_status"}
SUPPORTED_EVENT_NAMES = {
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
    "SubagentStop",
    "PermissionRequest",
    "PreCompact",
    "Notification",
    "preToolUse",
    "postToolUse",
    "sessionStart",
    "sessionEnd",
    "userPromptSubmitted",
    "errorOccurred",
    "shell.env",
    "tool.execute.before",
    "tool.execute.after",
    "session.created",
    "session.idle",
}
CONSUMER_GROUPS = {
    "lifecycle": ("identity", "lifecycle_events", "artifact_validation", "documentation_claims"),
    "doctor": ("identity", "host_detection", "config_targets", "diagnostics", "documentation_claims"),
    "upgrade": ("identity", "host_detection", "config_targets", "diagnostics"),
    "docs": REQUIRED_GROUPS,
    "tests": REQUIRED_GROUPS,
}
FORBIDDEN_OWNERSHIP_FIELDS = {
    "package_metadata",
    "package_manifest",
    "package_manifest_schemas",
    "release_metadata",
    "shared_package_paths",
    "version_authority",
    "install_root",
    "install_root_classification",
    "AGENTERA_HOME_precedence",
    "default_durable_root",
    "managed_classification",
    "root_diagnostics",
    "ownership",
}


class RegistryError(ValueError):
    """Raised when the RuntimeAdapter registry contract is violated."""


class RuntimeAdapterRegistry:
    def __init__(self, records: tuple[dict[str, Any], ...]) -> None:
        self.records = records

    @property
    def runtime_ids(self) -> tuple[str, ...]:
        return tuple(record["identity"]["runtime_id"] for record in self.records)

    def get(self, runtime_id: str) -> dict[str, Any]:
        for record in self.records:
            if record["identity"]["runtime_id"] == runtime_id:
                return record
        raise RegistryError(f"unknown runtime id: {runtime_id}")

    def consumer_view(self, consumer: str, runtime_id: str) -> dict[str, Any]:
        groups = CONSUMER_GROUPS.get(consumer)
        if groups is None:
            raise RegistryError(f"unknown registry consumer: {consumer}")
        record = self.get(runtime_id)
        return {group: record[group] for group in groups}


def load_registry(path: Path = DEFAULT_REGISTRY_PATH) -> RuntimeAdapterRegistry:
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    errors = validate_registry_data(data)
    if errors:
        raise RegistryError("RuntimeAdapter registry validation failed: " + "; ".join(errors))
    assert isinstance(data, dict)
    records = data["records"]
    return RuntimeAdapterRegistry(tuple(records))


def validate_registry_file(path: Path = DEFAULT_REGISTRY_PATH) -> list[str]:
    with path.open(encoding="utf-8") as handle:
        return validate_registry_data(yaml.safe_load(handle))


def validate_registry_data(data: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["registry must be a YAML object"]
    if data.get("schema_version") != "agentera.runtimeAdapterRegistry.v1":
        errors.append("registry.schema_version must be agentera.runtimeAdapterRegistry.v1")

    runtime_order = data.get("runtime_order")
    if runtime_order != list(EXPECTED_RUNTIME_ORDER):
        errors.append("registry.runtime_order must be claude, opencode, copilot, codex")

    records = data.get("records")
    if not isinstance(records, list):
        return errors + ["registry.records must be a list"]

    seen: set[str] = set()
    ids: list[str] = []
    for index, record in enumerate(records):
        prefix = f"records[{index}]"
        if not isinstance(record, dict):
            errors.append(f"{prefix} must be an object")
            continue
        errors.extend(_validate_forbidden_fields(prefix, record))
        missing_groups = [group for group in REQUIRED_GROUPS if group not in record]
        for group in missing_groups:
            errors.append(f"{prefix}: missing required group {group}")
        for group in record:
            if group not in REQUIRED_GROUPS:
                errors.append(f"{prefix}: unknown group {group}")
        for group in REQUIRED_GROUPS:
            group_value = record.get(group)
            if isinstance(group_value, dict):
                errors.extend(_validate_group(f"{prefix}.{group}", group, group_value))
            elif group in record:
                errors.append(f"{prefix}.{group} must be an object")

        identity = record.get("identity")
        runtime_id = identity.get("runtime_id") if isinstance(identity, dict) else None
        if not isinstance(runtime_id, str):
            continue
        ids.append(runtime_id)
        if runtime_id not in EXPECTED_RUNTIME_ORDER:
            errors.append(f"{prefix}.identity.runtime_id unknown runtime id: {runtime_id}")
        if runtime_id in seen:
            errors.append(f"duplicate runtime id: {runtime_id}")
        seen.add(runtime_id)

    if ids != list(EXPECTED_RUNTIME_ORDER):
        errors.append("registry.records must be ordered as claude, opencode, copilot, codex")
    return errors


def _validate_group(prefix: str, group: str, value: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    errors.extend(_validate_forbidden_fields(prefix, value))
    for field in REQUIRED_FIELDS[group]:
        if field not in value:
            errors.append(f"{prefix}: missing required field {field}")
    for field, field_value in value.items():
        if field not in REQUIRED_FIELDS[group]:
            errors.append(f"{prefix}: unknown field {field}")
            continue
        if field in STRING_FIELDS and not isinstance(field_value, str):
            errors.append(f"{prefix}.{field} must be a string")
        elif field in LIST_FIELDS and not _is_string_list(field_value):
            errors.append(f"{prefix}.{field} must be a list of strings")
        elif field in MAP_FIELDS and not _is_string_map(field_value):
            errors.append(f"{prefix}.{field} must be a string map")

    errors.extend(_validate_event_names(prefix, value))
    return errors


def _validate_event_names(prefix: str, value: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in ("supported_events", "unsupported_events", "validation_events"):
        events = value.get(field)
        if not isinstance(events, list):
            continue
        for event in events:
            if event not in SUPPORTED_EVENT_NAMES:
                errors.append(f"{prefix}.{field}: unsupported event name {event}")
    event_status = value.get("event_status")
    if isinstance(event_status, dict):
        for event in event_status:
            if event not in SUPPORTED_EVENT_NAMES:
                errors.append(f"{prefix}.event_status: unsupported event name {event}")
    return errors


def _validate_forbidden_fields(prefix: str, value: Mapping[str, Any]) -> list[str]:
    return [
        f"{prefix}: forbidden ownership field {field}"
        for field in sorted(value)
        if field in FORBIDDEN_OWNERSHIP_FIELDS
    ]


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_string_map(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(key, str) and isinstance(item, str) for key, item in value.items())
