"""Contract tests for the PackageManifest registry Module."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = REPO_ROOT / "references/adapters/package-registry.yaml"


def _load_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "package_registry",
        REPO_ROOT / "scripts/package_registry.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _registry_fixture() -> dict[str, Any]:
    data = yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def test_package_registry_returns_package_facts_in_deterministic_order_without_duplicate_ids():
    registry_module = _load_module()

    registry = registry_module.load_registry(REGISTRY_PATH)

    assert registry.package_ids == ("agentera",)
    assert registry.suite_version() == "2.1.0"
    assert len(registry.package_ids) == len(set(registry.package_ids))
    assert registry.version_surface_ids() == (
        "registry",
        "python-project",
        "copilot-root",
        "copilot-repository",
        "codex-plugin",
        "claude-marketplace-metadata",
        "claude-marketplace-plugins",
        "opencode-plugin-marker",
    )
    assert len(registry.version_surface_ids()) == len(set(registry.version_surface_ids()))
    assert registry.runtime_manifest_ids() == (
        "copilot-root-manifest",
        "copilot-repository-manifest",
        "codex-plugin-manifest",
        "claude-marketplace-manifest",
        "opencode-package-manifest",
    )
    record = registry.get("agentera")
    assert [surface["id"] for surface in record["bundle_surfaces"]["directories"]][:3] == [
        "skills",
        "scripts",
        "hooks",
    ]
    assert [command["id"] for command in record["package_commands"]["commands"]] == [
        "remove-legacy-skills",
        "install-agentera-skill-claude",
        "install-agentera-skill-opencode",
    ]
    assert record["docs_targets"]["version_files"][-1] == "registry.json"


def test_package_registry_known_and_unknown_ids_have_clear_diagnostics():
    registry_module = _load_module()
    registry = registry_module.load_registry(REGISTRY_PATH)

    assert registry.get("agentera")["identity"]["skill_path"] == "skills/agentera"

    try:
        registry.get("ghost")
    except registry_module.RegistryError as exc:
        assert str(exc) == "unknown package id: ghost"
    else:  # pragma: no cover - assertion clarity for failed exception path
        raise AssertionError("unknown package id should fail")


def test_package_registry_contract_reports_malformed_fixtures_clearly():
    registry_module = _load_module()
    fixture = _registry_fixture()
    malformed = copy.deepcopy(fixture)

    malformed["records"][0].pop("docs_targets")
    malformed["records"].append(copy.deepcopy(fixture["records"][0]))
    malformed["records"][0]["version_surfaces"]["surfaces"][1]["id"] = "registry"
    malformed["records"][0]["version_surfaces"]["surfaces"][2]["path"] = "missing/plugin.json"
    malformed["records"][0]["package_commands"]["commands"][1]["argv"] = (
        "npx skills add jgabor/agentera -g -a claude-code --skill agentera -y"
    )
    malformed["records"][0]["version_authority"]["install_root"] = "~/.agents/agentera"
    malformed["records"][0]["identity"]["lifecycle_events"] = []

    errors = registry_module.validate_registry_data(malformed)

    assert "records[0]: missing required group docs_targets" in errors
    assert "duplicate package id: agentera" in errors
    assert "records[0].version_surfaces.surfaces: duplicate id registry" in errors
    assert "records[0].version_surfaces.surfaces[2].path unknown path: missing/plugin.json" in errors
    assert "records[0].package_commands.commands[1].argv must be a list of strings" in errors
    assert "records[0].version_authority: forbidden install-root field install_root" in errors
    assert "records[0].identity: forbidden RuntimeAdapter field lifecycle_events" in errors


def test_package_registry_consumer_views_share_changed_fixture_facts():
    registry_module = _load_module()
    fixture = _registry_fixture()
    changed = copy.deepcopy(fixture)
    changed["records"][0]["identity"]["name"] = "agentera-canary"

    assert registry_module.validate_registry_data(changed) == []
    registry = registry_module.PackageRegistry(tuple(changed["records"]))

    observed = {
        consumer: registry.consumer_view(consumer, "agentera")["identity"]["name"]
        for consumer in ("validator", "upgrade", "docs", "tests")
    }

    assert observed == {
        "validator": "agentera-canary",
        "upgrade": "agentera-canary",
        "docs": "agentera-canary",
        "tests": "agentera-canary",
    }


def test_package_registry_consumer_views_do_not_hide_changed_package_facts():
    registry_module = _load_module()
    fixture = _registry_fixture()
    changed = copy.deepcopy(fixture)
    changed["records"][0]["version_authority"]["future_authority_change_requires"] = "explicit ADR plus migration plan"

    assert registry_module.validate_registry_data(changed) == []
    registry = registry_module.PackageRegistry(tuple(changed["records"]))

    observed = {
        consumer: registry.consumer_view(consumer, "agentera")["version_authority"]["future_authority_change_requires"]
        for consumer in ("validator", "upgrade", "docs", "tests")
    }

    assert set(observed.values()) == {"explicit ADR plus migration plan"}


def test_package_registry_separates_non_version_bearing_runtime_manifests_from_version_surfaces():
    registry_module = _load_module()
    registry = registry_module.load_registry(REGISTRY_PATH)

    non_version_manifests = registry.non_version_bearing_runtime_manifests()

    assert [manifest["path"] for manifest in non_version_manifests] == [".opencode/package.json"]
    assert ".opencode/package.json" not in [
        surface["path"] for surface in registry.get("agentera")["version_surfaces"]["surfaces"]
    ]
    assert registry_module.validate_registry_data(_registry_fixture()) == []


def test_package_registry_rejects_missing_non_version_bearing_runtime_manifest():
    registry_module = _load_module()
    fixture = _registry_fixture()
    fixture["records"][0]["runtime_package_manifests"]["manifests"] = [
        manifest
        for manifest in fixture["records"][0]["runtime_package_manifests"]["manifests"]
        if manifest["version_bearing"] is True
    ]

    errors = registry_module.validate_registry_data(fixture)

    assert (
        "records[0].runtime_package_manifests.manifests must include non-version-bearing runtime package manifests separately"
        in errors
    )


def test_manifest_projections_align_with_registry_docs_targets():
    registry = _load_module().load_registry(REGISTRY_PATH)
    docs_path = REPO_ROOT / ".agentera/docs.yaml"
    docs = yaml.safe_load(docs_path.read_text(encoding="utf-8"))
    docs_view = registry.consumer_view("docs")

    registry_version_files = set(docs_view["docs_targets"]["version_files"])
    docs_yaml_version_files = set(docs["conventions"]["version_files"])
    assert registry_version_files == docs_yaml_version_files

    registry_excluded = set(docs_view["docs_targets"]["excluded_version_files"])
    non_version_paths = {
        manifest["path"] for manifest in registry.non_version_bearing_runtime_manifests()
    }
    assert registry_excluded == non_version_paths

    for target in docs_view["docs_targets"]["index_targets"]:
        assert (REPO_ROOT / target).exists(), f"registry docs_targets.index_targets missing: {target}"


def test_manifest_projection_versions_align_through_registry():
    import json
    import re
    import tomllib

    registry = _load_module().load_registry(REGISTRY_PATH)
    suite_version = registry.suite_version()
    record = registry.get("agentera")

    for surface in record["version_surfaces"]["surfaces"]:
        selector = surface["selector"]
        path = REPO_ROOT / surface["path"]
        if selector == "skills[0].version":
            assert suite_version == suite_version
            continue
        if selector == "project.version":
            actual = tomllib.loads(path.read_text(encoding="utf-8")).get("project", {}).get("version")
        elif selector == "AGENTERA_VERSION":
            match = re.search(r'AGENTERA_VERSION\s*=\s*"([^"]+)"', path.read_text(encoding="utf-8"))
            actual = match.group(1) if match else None
        elif selector == "version":
            actual = json.loads(path.read_text(encoding="utf-8")).get("version")
        elif selector == "metadata.version":
            actual = json.loads(path.read_text(encoding="utf-8")).get("metadata", {}).get("version")
        elif selector == "plugins[*].version":
            data = json.loads(path.read_text(encoding="utf-8"))
            for plugin in data.get("plugins", []):
                if isinstance(plugin, dict):
                    assert plugin.get("version") == suite_version, (
                        f"{surface['path']} plugin {plugin.get('name')} version drift"
                    )
            continue
        else:
            raise AssertionError(f"unsupported selector {selector!r}")
        assert actual == suite_version, f"{surface['path']} ({selector}) has version {actual!r}, expected {suite_version!r}"

    for manifest in record["runtime_package_manifests"]["manifests"]:
        path = REPO_ROOT / manifest["path"]
        assert path.exists(), f"runtime manifest {manifest['path']} missing"
        if manifest["version_bearing"]:
            data = json.loads(path.read_text(encoding="utf-8"))
            if "version" in data:
                assert data["version"] == suite_version, (
                    f"version-bearing manifest {manifest['path']} has version {data.get('version')!r}"
                )
            else:
                surface_paths = {s["path"] for s in record["version_surfaces"]["surfaces"]}
                assert manifest["path"] in surface_paths, (
                    f"version-bearing manifest {manifest['path']} without top-level version must be covered by version_surfaces"
                )
