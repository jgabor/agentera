#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""PackageManifest registry loader and contract validator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

import yaml


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REGISTRY_PATH = ROOT / "references/adapters/package-registry.yaml"
EXPECTED_PACKAGE_ORDER = ("agentera",)
REQUIRED_GROUPS = (
    "identity",
    "version_authority",
    "version_surfaces",
    "runtime_package_manifests",
    "bundle_surfaces",
    "package_commands",
    "docs_targets",
    "release_policy",
)
REQUIRED_FIELDS = {
    "identity": ("id", "name", "skill_path", "expected_capabilities"),
    "version_authority": (
        "persisted_authority",
        "selector",
        "access_interface",
        "future_authority_change_requires",
    ),
    "version_surfaces": ("surfaces", "excluded_runtime_manifests"),
    "runtime_package_manifests": ("manifests", "shared_paths", "shared_paths_policy"),
    "bundle_surfaces": ("directories", "files", "skip_parts", "skip_suffixes"),
    "package_commands": ("commands", "safety"),
    "docs_targets": ("version_files_source", "version_files", "index_targets", "excluded_version_files"),
    "release_policy": (
        "semver_policy_source",
        "version_bump_required_for_interface_only_change",
        "release_publication_in_scope",
    ),
}
CONSUMER_GROUPS = {
    "validator": ("identity", "version_authority", "version_surfaces", "runtime_package_manifests"),
    "upgrade": ("identity", "version_authority", "bundle_surfaces", "package_commands"),
    "docs": ("identity", "version_authority", "docs_targets", "release_policy"),
    "tests": REQUIRED_GROUPS,
}
APPROVED_EXECUTABLES = {"npx"}
APPROVED_ACTIONS = {"remove-legacy-skills", "install-agentera-skill"}
APPROVED_RUNTIMES = {"all", "claude", "opencode"}
APPROVED_RUNTIME_AGENTS = {"claude-code", "opencode"}
CLEANUP_ACTIONS = {"remove-legacy-skills"}
RUNTIME_INSTALL_ACTIONS = {"install-agentera-skill"}
FORBIDDEN_INSTALL_ROOT_FIELDS = {
    "install_root",
    "install_root_classification",
    "AGENTERA_HOME_precedence",
    "default_durable_root",
    "managed_classification",
    "root_diagnostics",
}
FORBIDDEN_RUNTIME_ADAPTER_FIELDS = {
    "runtime_discovery",
    "host_detection",
    "lifecycle_events",
    "artifact_validation",
    "config_targets",
    "diagnostics",
    "documentation_claims",
}


class RegistryError(ValueError):
    """Raised when the PackageManifest registry contract is violated."""


class PackageRegistry:
    def __init__(self, records: tuple[dict[str, Any], ...], root: Path = ROOT) -> None:
        self.records = records
        self.root = root

    @property
    def package_ids(self) -> tuple[str, ...]:
        return tuple(record["identity"]["id"] for record in self.records)

    def get(self, package_id: str = "agentera") -> dict[str, Any]:
        for record in self.records:
            if record["identity"]["id"] == package_id:
                return record
        raise RegistryError(f"unknown package id: {package_id}")

    def suite_version(self, package_id: str = "agentera") -> str:
        record = self.get(package_id)
        authority = record["version_authority"]
        if authority["persisted_authority"] != "registry.json" or authority["selector"] != "skills[0].version":
            raise RegistryError("unsupported suite version authority selector")
        with (self.root / authority["persisted_authority"]).open(encoding="utf-8") as handle:
            data = json.load(handle)
        try:
            version = data["skills"][0]["version"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RegistryError("registry.json missing skills[0].version") from exc
        if not isinstance(version, str) or not version:
            raise RegistryError("registry.json skills[0].version must be a non-empty string")
        return version

    def consumer_view(self, consumer: str, package_id: str = "agentera") -> dict[str, Any]:
        groups = CONSUMER_GROUPS.get(consumer)
        if groups is None:
            raise RegistryError(f"unknown registry consumer: {consumer}")
        record = self.get(package_id)
        view = {group: record[group] for group in groups}
        view["suite_version"] = self.suite_version(package_id)
        return view

    def version_surface_ids(self, package_id: str = "agentera") -> tuple[str, ...]:
        return tuple(surface["id"] for surface in self.get(package_id)["version_surfaces"]["surfaces"])

    def runtime_manifest_ids(self, package_id: str = "agentera") -> tuple[str, ...]:
        return tuple(manifest["id"] for manifest in self.get(package_id)["runtime_package_manifests"]["manifests"])

    def runtime_manifest_paths(self, package_id: str = "agentera") -> dict[str, str]:
        paths: dict[str, str] = {}
        for manifest in self.get(package_id)["runtime_package_manifests"]["manifests"]:
            paths.setdefault(manifest["runtime"], manifest["path"])
        return paths

    def runtime_package_shapes(self, package_id: str = "agentera") -> dict[str, str]:
        return {
            manifest["runtime"]: manifest["package_shape"]
            for manifest in self.get(package_id)["runtime_package_manifests"]["manifests"]
        }

    def shared_path_requirements(self, package_id: str = "agentera") -> dict[str, str]:
        return {
            entry["path"]: entry["kind"]
            for entry in self.get(package_id)["runtime_package_manifests"]["shared_paths"]
        }

    def non_version_bearing_runtime_manifests(self, package_id: str = "agentera") -> tuple[dict[str, Any], ...]:
        return tuple(
            manifest
            for manifest in self.get(package_id)["runtime_package_manifests"]["manifests"]
            if manifest["version_bearing"] is False
        )


def load_registry(path: Path = DEFAULT_REGISTRY_PATH, root: Path = ROOT) -> PackageRegistry:
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    errors = validate_registry_data(data, root=root)
    if errors:
        raise RegistryError("PackageManifest registry validation failed: " + "; ".join(errors))
    assert isinstance(data, dict)
    return PackageRegistry(tuple(data["records"]), root=root)


def validate_registry_file(path: Path = DEFAULT_REGISTRY_PATH, root: Path = ROOT) -> list[str]:
    with path.open(encoding="utf-8") as handle:
        return validate_registry_data(yaml.safe_load(handle), root=root)


def validate_registry_data(data: Any, root: Path = ROOT) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["registry must be a YAML object"]
    if data.get("schema_version") != "agentera.packageRegistry.v1":
        errors.append("registry.schema_version must be agentera.packageRegistry.v1")
    if data.get("package_order") != list(EXPECTED_PACKAGE_ORDER):
        errors.append("registry.package_order must be agentera")

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
                errors.extend(_validate_group(f"{prefix}.{group}", group, group_value, root))
            elif group in record:
                errors.append(f"{prefix}.{group} must be an object")

        identity = record.get("identity")
        package_id = identity.get("id") if isinstance(identity, dict) else None
        if not isinstance(package_id, str):
            continue
        ids.append(package_id)
        if package_id not in EXPECTED_PACKAGE_ORDER:
            errors.append(f"{prefix}.identity.id unknown package id: {package_id}")
        if package_id in seen:
            errors.append(f"duplicate package id: {package_id}")
        seen.add(package_id)

    if ids != list(EXPECTED_PACKAGE_ORDER):
        errors.append("registry.records must be ordered as agentera")
    return errors


def _validate_group(prefix: str, group: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    errors.extend(_validate_forbidden_fields(prefix, value))
    for field in REQUIRED_FIELDS[group]:
        if field not in value:
            errors.append(f"{prefix}: missing required field {field}")
    for field in value:
        if field not in REQUIRED_FIELDS[group]:
            errors.append(f"{prefix}: unknown field {field}")

    if group == "identity":
        errors.extend(_validate_identity(prefix, value, root))
    elif group == "version_authority":
        errors.extend(_validate_version_authority(prefix, value, root))
    elif group == "version_surfaces":
        errors.extend(_validate_version_surfaces(prefix, value, root))
    elif group == "runtime_package_manifests":
        errors.extend(_validate_runtime_manifests(prefix, value, root))
    elif group == "bundle_surfaces":
        errors.extend(_validate_bundle_surfaces(prefix, value, root))
    elif group == "package_commands":
        errors.extend(_validate_package_commands(prefix, value))
    elif group == "docs_targets":
        errors.extend(_validate_docs_targets(prefix, value, root))
    elif group == "release_policy":
        errors.extend(_validate_release_policy(prefix, value))
    return errors


def _validate_identity(prefix: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    for field in ("id", "name"):
        if not isinstance(value.get(field), str) or not value[field]:
            errors.append(f"{prefix}.{field} must be a non-empty string")
    if not isinstance(value.get("expected_capabilities"), int):
        errors.append(f"{prefix}.expected_capabilities must be an integer")
    errors.extend(_validate_repo_path(f"{prefix}.skill_path", value.get("skill_path"), root))
    return errors


def _validate_version_authority(prefix: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    errors.extend(_validate_repo_path(f"{prefix}.persisted_authority", value.get("persisted_authority"), root))
    for field in ("selector", "access_interface", "future_authority_change_requires"):
        if not isinstance(value.get(field), str) or not value[field]:
            errors.append(f"{prefix}.{field} must be a non-empty string")
    if value.get("access_interface") != "PackageManifest":
        errors.append(f"{prefix}.access_interface must be PackageManifest")
    return errors


def _validate_version_surfaces(prefix: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    surfaces = value.get("surfaces")
    if not isinstance(surfaces, list):
        errors.append(f"{prefix}.surfaces must be a list")
    else:
        errors.extend(_validate_id_list(f"{prefix}.surfaces", surfaces))
        for index, surface in enumerate(surfaces):
            surface_prefix = f"{prefix}.surfaces[{index}]"
            if not isinstance(surface, dict):
                errors.append(f"{surface_prefix} must be an object")
                continue
            errors.extend(_validate_required_object_fields(surface_prefix, surface, ("id", "path", "selector")))
            errors.extend(_validate_repo_path(f"{surface_prefix}.path", surface.get("path"), root))
    errors.extend(_validate_path_list(f"{prefix}.excluded_runtime_manifests", value.get("excluded_runtime_manifests"), root))
    return errors


def _validate_runtime_manifests(prefix: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    manifests = value.get("manifests")
    if not isinstance(manifests, list):
        errors.append(f"{prefix}.manifests must be a list")
    else:
        errors.extend(_validate_id_list(f"{prefix}.manifests", manifests))
        non_version_bearing = 0
        for index, manifest in enumerate(manifests):
            manifest_prefix = f"{prefix}.manifests[{index}]"
            if not isinstance(manifest, dict):
                errors.append(f"{manifest_prefix} must be an object")
                continue
            errors.extend(_validate_required_object_fields(
                manifest_prefix,
                manifest,
                ("id", "runtime", "path", "version_bearing", "package_shape"),
            ))
            errors.extend(_validate_repo_path(f"{manifest_prefix}.path", manifest.get("path"), root))
            if not isinstance(manifest.get("version_bearing"), bool):
                errors.append(f"{manifest_prefix}.version_bearing must be a boolean")
            elif manifest["version_bearing"] is False:
                non_version_bearing += 1
        if non_version_bearing == 0:
            errors.append(f"{prefix}.manifests must include non-version-bearing runtime package manifests separately")
    shared_paths = value.get("shared_paths")
    if not isinstance(shared_paths, list):
        errors.append(f"{prefix}.shared_paths must be a list")
    else:
        errors.extend(_validate_id_list(f"{prefix}.shared_paths", shared_paths))
        for index, entry in enumerate(shared_paths):
            entry_prefix = f"{prefix}.shared_paths[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{entry_prefix} must be an object")
                continue
            errors.extend(_validate_required_object_fields(entry_prefix, entry, ("id", "path", "kind")))
            errors.extend(_validate_repo_path(f"{entry_prefix}.path", entry.get("path"), root))
            if entry.get("kind") not in {"dir", "file"}:
                errors.append(f"{entry_prefix}.kind must be dir or file")
    if not isinstance(value.get("shared_paths_policy"), str) or not value["shared_paths_policy"]:
        errors.append(f"{prefix}.shared_paths_policy must be a non-empty string")
    return errors


def _validate_bundle_surfaces(prefix: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    for field in ("directories", "files"):
        entries = value.get(field)
        if not isinstance(entries, list):
            errors.append(f"{prefix}.{field} must be a list")
            continue
        errors.extend(_validate_id_list(f"{prefix}.{field}", entries))
        for index, entry in enumerate(entries):
            entry_prefix = f"{prefix}.{field}[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{entry_prefix} must be an object")
                continue
            errors.extend(_validate_required_object_fields(entry_prefix, entry, ("id", "path")))
            errors.extend(_validate_repo_path(f"{entry_prefix}.path", entry.get("path"), root))
    for field in ("skip_parts", "skip_suffixes"):
        if not _is_string_list(value.get(field)):
            errors.append(f"{prefix}.{field} must be a list of strings")
    return errors


def _validate_package_commands(prefix: str, value: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    commands = value.get("commands")
    if not isinstance(commands, list):
        errors.append(f"{prefix}.commands must be a list")
    else:
        errors.extend(_validate_id_list(f"{prefix}.commands", commands))
        for index, command in enumerate(commands):
            command_prefix = f"{prefix}.commands[{index}]"
            if not isinstance(command, dict):
                errors.append(f"{command_prefix} must be an object")
                continue
            errors.extend(_validate_required_object_fields(
                command_prefix,
                command,
                ("id", "runtime", "action", "phase", "argv", "skipped_without_update_packages_message"),
            ))
            errors.extend(_validate_command_spec(command_prefix, command))
    safety = value.get("safety")
    if not isinstance(safety, dict):
        errors.append(f"{prefix}.safety must be an object")
    elif safety != {
        "argv_only": True,
        "update_packages_required_to_plan": True,
        "yes_required_to_execute": True,
        "preserve_existing_write_gates": True,
        "cleanup_phase": "cleanup",
        "runtime_install_phase": "runtime-install",
    }:
        errors.append(f"{prefix}.safety must preserve approved write gates and phase names")
    return errors


def _validate_docs_targets(prefix: str, value: Mapping[str, Any], root: Path) -> list[str]:
    errors: list[str] = []
    if not isinstance(value.get("version_files_source"), str) or not value["version_files_source"]:
        errors.append(f"{prefix}.version_files_source must be a non-empty string")
    for field in ("version_files", "index_targets", "excluded_version_files"):
        errors.extend(_validate_path_list(f"{prefix}.{field}", value.get(field), root))
    return errors


def _validate_release_policy(prefix: str, value: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(value.get("semver_policy_source"), str) or not value["semver_policy_source"]:
        errors.append(f"{prefix}.semver_policy_source must be a non-empty string")
    for field in ("version_bump_required_for_interface_only_change", "release_publication_in_scope"):
        if not isinstance(value.get(field), bool):
            errors.append(f"{prefix}.{field} must be a boolean")
    return errors


def _validate_command_spec(prefix: str, command: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    runtime = command.get("runtime")
    action = command.get("action")
    phase = command.get("phase")
    argv = command.get("argv")
    if runtime not in APPROVED_RUNTIMES:
        errors.append(f"{prefix}.runtime {runtime!r} is not approved")
    if action not in APPROVED_ACTIONS:
        errors.append(f"{prefix}.action {action!r} is not approved")
    if not isinstance(argv, list) or not argv or not all(isinstance(part, str) for part in argv):
        errors.append(f"{prefix}.argv must be a list of strings")
        return errors
    if argv[0] not in APPROVED_EXECUTABLES:
        errors.append(f"{prefix}.argv uses unapproved executable {argv[0]!r}")
    if len(argv) < 3 or argv[1] != "skills" or argv[2] not in {"remove", "add"}:
        errors.append(f"{prefix}.argv must use approved skills action")
    if action in CLEANUP_ACTIONS and (runtime != "all" or phase != "cleanup" or argv[2] != "remove"):
        errors.append(f"{prefix}: cleanup commands must stay separate from runtime installs")
    if action in RUNTIME_INSTALL_ACTIONS:
        if runtime == "all" or phase != "runtime-install" or argv[2] != "add":
            errors.append(f"{prefix}: runtime install commands must stay out of cleanup")
        if "-a" not in argv:
            errors.append(f"{prefix}: runtime install commands must declare runtime agent")
        else:
            agent_index = argv.index("-a") + 1
            agent = argv[agent_index] if agent_index < len(argv) else None
            if agent not in APPROVED_RUNTIME_AGENTS:
                errors.append(f"{prefix}: runtime install agent {agent!r} is not approved")
    if not isinstance(command.get("skipped_without_update_packages_message"), str):
        errors.append(f"{prefix}.skipped_without_update_packages_message must be a string")
    return errors


def _validate_required_object_fields(prefix: str, value: Mapping[str, Any], expected: tuple[str, ...]) -> list[str]:
    errors: list[str] = []
    for field in expected:
        if field not in value:
            errors.append(f"{prefix}: missing required field {field}")
    for field in value:
        if field not in expected:
            errors.append(f"{prefix}: unknown field {field}")
    for field in ("id", "runtime", "action", "phase", "selector", "package_shape"):
        if field in value and (not isinstance(value[field], str) or not value[field]):
            errors.append(f"{prefix}.{field} must be a non-empty string")
    return errors


def _validate_id_list(prefix: str, entries: list[Any]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        entry_id = entry.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            errors.append(f"{prefix}[{index}].id must be a non-empty string")
            continue
        if entry_id in seen:
            errors.append(f"{prefix}: duplicate id {entry_id}")
        seen.add(entry_id)
    return errors


def _validate_path_list(prefix: str, value: Any, root: Path) -> list[str]:
    if not _is_string_list(value):
        return [f"{prefix} must be a list of repo-relative paths"]
    errors: list[str] = []
    for index, path in enumerate(value):
        errors.extend(_validate_repo_path(f"{prefix}[{index}]", path, root))
    return errors


def _validate_repo_path(prefix: str, value: Any, root: Path) -> list[str]:
    if not isinstance(value, str) or not value:
        return [f"{prefix} must be a repo-relative path"]
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        return [f"{prefix} must stay inside repo root"]
    resolved = (root / path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        return [f"{prefix} must stay inside repo root"]
    if not resolved.exists():
        return [f"{prefix} unknown path: {value}"]
    return []


def _validate_forbidden_fields(prefix: str, value: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    for field in sorted(value):
        if field in FORBIDDEN_INSTALL_ROOT_FIELDS:
            errors.append(f"{prefix}: forbidden install-root field {field}")
        if field in FORBIDDEN_RUNTIME_ADAPTER_FIELDS:
            errors.append(f"{prefix}: forbidden RuntimeAdapter field {field}")
        nested = value[field]
        if isinstance(nested, dict):
            errors.extend(_validate_forbidden_fields(f"{prefix}.{field}", nested))
        elif isinstance(nested, list):
            for index, item in enumerate(nested):
                if isinstance(item, dict):
                    errors.extend(_validate_forbidden_fields(f"{prefix}.{field}[{index}]", item))
    return errors


def _is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)
