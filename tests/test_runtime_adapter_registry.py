"""Contract tests for the RuntimeAdapter registry Module."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = REPO_ROOT / "references/adapters/runtime-adapter-registry.yaml"


def _load_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "runtime_adapter_registry",
        REPO_ROOT / "scripts/runtime_adapter_registry.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _registry_fixture() -> dict[str, Any]:
    data = yaml.safe_load(REGISTRY_PATH.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def test_runtime_adapter_registry_returns_current_runtimes_in_deterministic_order():
    registry_module = _load_module()

    registry = registry_module.load_registry(REGISTRY_PATH)

    assert registry.runtime_ids == ("claude", "opencode", "copilot", "codex")
    assert len(registry.runtime_ids) == len(set(registry.runtime_ids))
    assert [registry.get(runtime_id)["identity"]["display_name"] for runtime_id in registry.runtime_ids] == [
        "Claude Code",
        "OpenCode",
        "Copilot CLI",
        "Codex CLI",
    ]


def test_runtime_adapter_registry_known_and_unknown_ids_have_clear_diagnostics():
    registry_module = _load_module()
    registry = registry_module.load_registry(REGISTRY_PATH)

    assert registry.get("codex")["identity"]["display_name"] == "Codex CLI"

    try:
        registry.get("ghost")
    except registry_module.RegistryError as exc:
        assert str(exc) == "unknown runtime id: ghost"
    else:  # pragma: no cover - assertion clarity for failed exception path
        raise AssertionError("unknown runtime id should fail")


def test_runtime_adapter_registry_contract_reports_malformed_fixtures_clearly():
    registry_module = _load_module()
    fixture = _registry_fixture()
    malformed = copy.deepcopy(fixture)

    malformed["records"][0].pop("diagnostics")
    malformed["records"][1]["identity"]["runtime_id"] = "ghost"
    malformed["records"][2]["identity"]["runtime_id"] = "codex"
    malformed["records"][3]["lifecycle_events"]["supported_events"].append("AfterEverything")
    malformed["records"][3]["install_root"] = {"default_durable_root": "~/.agents/agentera"}

    errors = registry_module.validate_registry_data(malformed)

    assert "records[0]: missing required group diagnostics" in errors
    assert "records[1].identity.runtime_id unknown runtime id: ghost" in errors
    assert "duplicate runtime id: codex" in errors
    assert "records[3].lifecycle_events.supported_events: unsupported event name AfterEverything" in errors
    assert "records[3]: forbidden ownership field install_root" in errors


def test_runtime_adapter_registry_consumer_views_share_changed_fixture_facts():
    registry_module = _load_module()
    fixture = _registry_fixture()
    changed = copy.deepcopy(fixture)
    changed["records"][2]["identity"]["display_name"] = "Copilot Canary"

    assert registry_module.validate_registry_data(changed) == []
    registry = registry_module.RuntimeAdapterRegistry(tuple(changed["records"]))

    observed = {
        consumer: registry.consumer_view(consumer, "copilot")["identity"]["display_name"]
        for consumer in ("lifecycle", "doctor", "upgrade", "docs", "tests")
    }

    assert observed == {
        "lifecycle": "Copilot Canary",
        "doctor": "Copilot Canary",
        "upgrade": "Copilot Canary",
        "docs": "Copilot Canary",
        "tests": "Copilot Canary",
    }


def test_runtime_adapter_registry_rejects_package_metadata_and_install_root_ownership_fields():
    registry_module = _load_module()

    for forbidden_field in ("version_authority", "package_manifest_schemas", "install_root_classification", "root_diagnostics"):
        fixture = _registry_fixture()
        fixture["records"][0]["identity"][forbidden_field] = "not-runtime-owned"

        errors = registry_module.validate_registry_data(fixture)

        assert f"records[0].identity: forbidden ownership field {forbidden_field}" in errors
