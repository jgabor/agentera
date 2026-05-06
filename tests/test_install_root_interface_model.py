"""Contract tests for the Task 3 install-root interface model."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL = REPO_ROOT / ".agentera" / "install_root_interface_model.yaml"
INVENTORY = REPO_ROOT / ".agentera" / "install_root_behavior_inventory.yaml"

REQUIRED_RESULT_FIELDS = {
    "source",
    "kind",
    "safe_action",
    "diagnostic",
    "managed_status",
    "stale_status",
    "missing_evidence",
}


def _read_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_result_contract_includes_required_read_only_fields() -> None:
    model = _read_yaml(MODEL)

    assert set(model["result_schema"]["required_fields"]) == REQUIRED_RESULT_FIELDS
    assert model["mutation_policy"] == {
        "classification_writes_files": False,
        "durable_bundle_writes_allowed": False,
        "dry_run_allowed": True,
        "apply_requires_separate_confirmation": True,
    }

    for kind, contract in model["root_kinds"].items():
        assert {"managed_status", "stale_status", "safe_action", "diagnostic", "missing_evidence"} <= set(contract)
        assert contract["safe_action"] in model["safe_actions"], kind
        assert model["safe_actions"][contract["safe_action"]]["writes_files"] is False
        assert {"code", "severity", "message"} <= set(contract["diagnostic"])
        assert isinstance(contract["missing_evidence"], list)


def test_valid_environment_managed_root_has_shared_identity_contract() -> None:
    model = _read_yaml(MODEL)
    identity = model["bundle_identity"]
    managed_fresh = model["root_kinds"]["managed_fresh"]

    assert identity["owner"] == "install_root_interface"
    assert identity["caller_local_identity_rules_allowed"] is False
    assert {"setup", "upgrade"} <= set(identity["valid_for_callers"])
    assert "scripts/agentera" in identity["managed_bundle_evidence"]
    assert ".agentera-bundle.json" in identity["managed_bundle_evidence"]
    assert managed_fresh["managed_status"] == "managed"
    assert managed_fresh["stale_status"] == "fresh"
    assert managed_fresh["safe_action"] == "use_root"


def test_unsafe_or_stale_states_have_one_unambiguous_action() -> None:
    model = _read_yaml(MODEL)
    expected_actions = {
        "missing_explicit_or_environment": "require_existing_managed_root",
        "missing_default": "preview_refresh",
        "file_valued_root": "reject_file_path",
        "unmanaged_directory": "reject_unmanaged_directory",
        "managed_stale": "preview_refresh",
        "invalid_bundle": "reject_invalid_bundle",
    }

    for kind, action in expected_actions.items():
        assert model["root_kinds"][kind]["safe_action"] == action

    rejecting_actions = {
        "require_existing_managed_root",
        "reject_file_path",
        "reject_unmanaged_directory",
        "reject_invalid_bundle",
    }
    for action in rejecting_actions:
        assert model["safe_actions"][action]["writes_files"] is False
        assert not action.startswith("preview")


def test_default_source_is_explicit_and_lower_precedence() -> None:
    model = _read_yaml(MODEL)
    precedence = {entry["source"]: entry["rank"] for entry in model["source_precedence"]}

    assert precedence == {"explicit": 1, "environment": 2, "default": 3}
    assert model["source_precedence"][-1]["source"] == "default"
    assert "only when explicit and environment roots are absent" in model["source_precedence"][-1]["rule"]


def test_model_is_tied_to_inventory_behavior_shapes() -> None:
    model = _read_yaml(MODEL)
    inventory = _read_yaml(INVENTORY)
    shape_map = model["inventory_links"]["behavior_shape_map"]
    inventory_shapes = {entry["shape"] for entry in inventory["behavior_matrix"]}

    assert model["inventory_links"]["canonical-suite-root-vs-managed-bundle-root"] == inventory["standardization"]["name"]
    assert inventory_shapes <= set(shape_map)
    assert set(shape_map.values()) <= set(model["root_kinds"])
