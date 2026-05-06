"""Executable tests for the shared read-only install-root module."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL = REPO_ROOT / ".agentera" / "install_root_interface_model.yaml"
INVENTORY = REPO_ROOT / ".agentera" / "install_root_behavior_inventory.yaml"


def _load_install_root() -> ModuleType:
    spec = importlib.util.spec_from_file_location("agentera_install_root_module", REPO_ROOT / "scripts" / "install_root.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _read_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _write_setup_root(root: Path) -> None:
    for entry in ("scripts/validate_capability.py", "hooks", "skills", "skills/agentera/SKILL.md"):
        target = root / entry
        if "." in target.name:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture\n", encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
    helper = root / "hooks" / "validate_artifact.py"
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_text("fixture\n", encoding="utf-8")


def _write_upgrade_root(root: Path, *, marker_version: str | None = "current", commands: tuple[str, ...] = ("hej",)) -> None:
    script = root / "scripts" / "agentera"
    script.parent.mkdir(parents=True, exist_ok=True)
    command_lines = "".join(f"sub.add_parser({name!r})\n" for name in commands)
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import argparse\n"
        "parser = argparse.ArgumentParser(prog='agentera')\n"
        "sub = parser.add_subparsers(dest='command')\n"
        f"{command_lines}"
        "parser.parse_args()\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    (root / "hooks").mkdir(parents=True, exist_ok=True)
    skill = root / "skills" / "agentera" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text("---\nname: agentera\n---\n", encoding="utf-8")
    (root / "registry.json").write_text(
        json.dumps({"skills": [{"name": "agentera", "version": "current"}]}),
        encoding="utf-8",
    )
    if marker_version is not None:
        (root / ".agentera-bundle.json").write_text(
            json.dumps({"schemaVersion": "agentera.bundle.v1", "version": marker_version}),
            encoding="utf-8",
        )


def _snapshot(root: Path) -> dict[str, tuple[bool, str | None]]:
    paths = [root, *sorted(root.rglob("*"))] if root.exists() else []
    return {
        str(path.relative_to(root) if path != root else Path(".")): (
            path.is_file(),
            path.read_text(encoding="utf-8") if path.is_file() else None,
        )
        for path in paths
    }


def test_shared_module_matches_approved_behavior_matrix_for_characterized_shapes(tmp_path: Path) -> None:
    install_root = _load_install_root()
    model = _read_yaml(MODEL)
    inventory = _read_yaml(INVENTORY)
    shape_map = model["inventory_links"]["behavior_shape_map"]

    setup_valid = tmp_path / "setup-valid"
    env_valid = tmp_path / "env-valid"
    default_valid = tmp_path / "default-valid"
    fresh = tmp_path / "fresh"
    stale_missing_marker = tmp_path / "stale-missing-marker"
    stale_version = tmp_path / "stale-version"
    file_root = tmp_path / "file-root"
    unmanaged = tmp_path / "unmanaged"
    _write_setup_root(setup_valid)
    _write_setup_root(env_valid)
    _write_setup_root(default_valid)
    _write_upgrade_root(fresh)
    _write_upgrade_root(stale_missing_marker, marker_version=None)
    _write_upgrade_root(stale_version, marker_version="old")
    file_root.write_text("not a directory\n", encoding="utf-8")
    unmanaged.mkdir()

    cases = {
        "valid setup root": (setup_valid, "explicit"),
        "missing explicit setup root": (tmp_path / "missing-setup", "explicit"),
        "file explicit setup root": (file_root, "explicit"),
        "unmanaged explicit setup directory": (unmanaged, "explicit"),
        "env-derived valid setup root": (env_valid, "environment"),
        "auto-detect/default setup root": (default_valid, "default"),
        "fresh managed upgrade root": (fresh, "explicit"),
        "stale managed upgrade root": (stale_version, "explicit"),
        "missing explicit or AGENTERA_HOME upgrade root": (tmp_path / "missing-env", "environment"),
        "missing default upgrade root": (tmp_path / "missing-default", "default"),
        "file upgrade root": (file_root, "explicit"),
        "unmanaged upgrade directory": (unmanaged, "explicit"),
        "OpenCode runtime AGENTERA_HOME candidate": (fresh, "environment"),
    }

    for entry in inventory["behavior_matrix"]:
        shape = entry["shape"]
        result = install_root.classify_resolved_root(
            cases[shape][0],
            source=cases[shape][1],
            expected_version="current",
        )
        expected_kind = shape_map[shape]
        contract = model["root_kinds"][expected_kind]
        assert result.kind == expected_kind, shape
        assert result.managed_status == contract["managed_status"], shape
        assert result.stale_status == contract["stale_status"], shape
        assert result.safe_action == contract["safe_action"], shape
        assert result.diagnostic.code == contract["diagnostic"]["code"], shape

    missing_marker = install_root.classify_resolved_root(
        stale_missing_marker,
        source="explicit",
        expected_version="current",
    )
    assert missing_marker.kind == "managed_stale"
    assert missing_marker.diagnostic.evidence["reason"] == "missing_marker"


def test_classification_is_read_only_for_existing_and_missing_roots(tmp_path: Path) -> None:
    install_root = _load_install_root()
    existing = tmp_path / "existing"
    _write_upgrade_root(existing, marker_version="old")
    missing = tmp_path / "missing-default"
    before_existing = _snapshot(existing)

    stale = install_root.classify_resolved_root(existing, source="explicit", expected_version="current")
    missing_result = install_root.classify_resolved_root(missing, source="default", expected_version="current")

    assert stale.kind == "managed_stale"
    assert missing_result.kind == "missing_default"
    assert _snapshot(existing) == before_existing
    assert not missing.exists()


def test_stale_diagnostic_exposes_expected_and_current_versions_without_refresh(tmp_path: Path) -> None:
    install_root = _load_install_root()
    root = tmp_path / "stale"
    _write_upgrade_root(root, marker_version="old")

    result = install_root.classify_resolved_root(root, source="explicit", expected_version="current")

    assert result.safe_action == "preview_refresh"
    assert result.expected_version == "current"
    assert result.current_version == "old"
    assert result.diagnostic.evidence["expectedVersion"] == "current"
    assert result.diagnostic.evidence["currentVersion"] == "old"
    assert result.diagnostic.evidence["reason"] == "version_mismatch"
    assert not any(path.name.startswith(".refresh") for path in root.iterdir())


def test_display_text_does_not_replace_structured_diagnostic_data(tmp_path: Path) -> None:
    install_root = _load_install_root()
    root = tmp_path / "unmanaged"
    root.mkdir()

    result = install_root.classify_resolved_root(root, source="explicit", expected_version="current")
    text = install_root.format_diagnostic(result)
    data = result.to_dict()

    assert "selected directory is not a managed Agentera bundle" in text
    assert data["diagnostic"]["code"] == "install_root.unmanaged_directory"
    assert data["diagnostic"]["evidence"]["path"] == str(root.resolve())
    assert data["safe_action"] == "reject_unmanaged_directory"


def test_explicit_environment_default_source_precedence(tmp_path: Path) -> None:
    install_root = _load_install_root()
    explicit = tmp_path / "explicit"
    env_root = tmp_path / "env"
    default = tmp_path / "default"
    for root in (explicit, env_root, default):
        _write_setup_root(root)

    explicit_result = install_root.classify_install_root(
        explicit,
        env={"AGENTERA_HOME": str(env_root), "AGENTERA_DEFAULT_INSTALL_ROOT": str(default)},
        home=tmp_path / "home",
        expected_version="current",
    )
    env_result = install_root.classify_install_root(
        None,
        env={"AGENTERA_HOME": str(env_root), "AGENTERA_DEFAULT_INSTALL_ROOT": str(default)},
        home=tmp_path / "home",
        expected_version="current",
    )
    default_result = install_root.classify_install_root(
        None,
        env={"AGENTERA_DEFAULT_INSTALL_ROOT": str(default)},
        home=tmp_path / "home",
        expected_version="current",
    )

    assert (explicit_result.source, explicit_result.path) == ("explicit", str(explicit.resolve()))
    assert (env_result.source, env_result.path) == ("environment", str(env_root.resolve()))
    assert (default_result.source, default_result.path) == ("default", str(default.resolve()))
