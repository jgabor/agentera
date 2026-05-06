"""Characterization tests for install-root caller behavior during migration."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
INVENTORY = REPO_ROOT / ".agentera" / "install_root_behavior_inventory.yaml"


def _load_module(name: str, rel_path: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / rel_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def setup_codex() -> ModuleType:
    return _load_module("setup_codex_characterization", "scripts/setup_codex.py")


@pytest.fixture(scope="module")
def setup_copilot() -> ModuleType:
    return _load_module("setup_copilot_characterization", "scripts/setup_copilot.py")


@pytest.fixture(scope="module")
def setup_doctor() -> ModuleType:
    return _load_module("setup_doctor_characterization", "scripts/setup_doctor.py")


@pytest.fixture(scope="module")
def upgrade() -> ModuleType:
    return _load_module("agentera_upgrade_characterization", "scripts/agentera_upgrade.py")


def _write_setup_root(root: Path, module: ModuleType) -> None:
    for entry in module.install_root_module.SETUP_EVIDENCE:
        target = root / entry
        if "." in Path(entry).name:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture\n", encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
    hooks = root / "hooks" / "validate_artifact.py"
    hooks.parent.mkdir(parents=True, exist_ok=True)
    hooks.write_text("fixture\n", encoding="utf-8")


def _write_upgrade_root(
    root: Path,
    *,
    marker_version: str | None = "current",
    commands: tuple[str, ...] = ("hej",),
) -> None:
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


@pytest.mark.parametrize("module_name", ["setup_codex", "setup_copilot"])
def test_setup_helpers_characterize_explicit_root_shapes(
    request: pytest.FixtureRequest,
    module_name: str,
    tmp_path: Path,
) -> None:
    module = request.getfixturevalue(module_name)
    valid = tmp_path / "valid"
    missing = tmp_path / "missing"
    file_root = tmp_path / "file-root"
    unmanaged = tmp_path / "unmanaged"
    _write_setup_root(valid, module)
    file_root.write_text("not a directory\n", encoding="utf-8")
    unmanaged.mkdir()

    assert module.resolve_install_root(str(valid)) == valid.resolve()

    cases = [
        (missing, module.install_root_module.SETUP_EVIDENCE),
        (file_root, module.install_root_module.SETUP_EVIDENCE),
        (unmanaged, module.install_root_module.SETUP_EVIDENCE),
    ]
    for root, expected_missing in cases:
        with pytest.raises(module.InstallRootError) as exc:
            module.resolve_install_root(str(root))
        message = str(exc.value)
        assert f"--install-root {root.resolve()} is not a valid agentera install" in message
        assert ", ".join(expected_missing) in message


def test_setup_auto_detection_characterizes_env_and_walkup_precedence(
    setup_codex: ModuleType,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    env_root = tmp_path / "env-root"
    walkup_root = tmp_path / "walkup-root"
    nested = walkup_root / "scripts" / "child"
    _write_setup_root(env_root, setup_codex)
    _write_setup_root(walkup_root, setup_codex)
    nested.mkdir(parents=True)

    monkeypatch.setenv("AGENTERA_HOME", str(env_root))
    assert setup_codex.auto_detect_install_root(start=nested) == env_root.resolve()

    monkeypatch.delenv("AGENTERA_HOME")
    monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
    assert setup_codex.auto_detect_install_root(start=nested) == walkup_root.resolve()


def test_doctor_characterizes_machine_readable_install_root_diagnostics(
    setup_doctor: ModuleType,
    tmp_path: Path,
) -> None:
    valid = tmp_path / "valid"
    file_root = tmp_path / "file-root"
    unmanaged = tmp_path / "unmanaged"
    _write_setup_root(valid, setup_doctor)
    file_root.write_text("not a directory\n", encoding="utf-8")
    unmanaged.mkdir()

    valid_result = setup_doctor.classify_install_root(valid, {})
    assert valid_result["status"] == "pass"
    assert valid_result["kind"] == "installed-bundle"
    assert valid_result["message"] == "install root is valid"

    for root in (tmp_path / "missing", file_root, unmanaged):
        result = setup_doctor.classify_install_root(root, {})
        assert result["status"] == "fail"
        assert result["gap"] == "bundle_packaging"
        assert result["message"] == "install root is missing canonical Agentera entries"
        assert result["missing"] == list(setup_doctor.install_root_module.SETUP_EVIDENCE)


def test_upgrade_characterizes_bundle_status_root_shapes(
    upgrade: ModuleType,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source"
    home = tmp_path / "home"
    project = tmp_path / "project"
    file_root = tmp_path / "file-root"
    unmanaged = tmp_path / "unmanaged"
    fresh = tmp_path / "fresh"
    stale_missing_marker = tmp_path / "stale-missing-marker"
    stale_version = tmp_path / "stale-version"
    file_root.write_text("not a directory\n", encoding="utf-8")
    unmanaged.mkdir()
    _write_upgrade_root(fresh)
    _write_upgrade_root(stale_missing_marker, marker_version=None)
    _write_upgrade_root(stale_version, marker_version="old")

    monkeypatch.setattr(
        upgrade,
        "_probe_bundle_cli",
        lambda *args, **kwargs: {
            "ok": True,
            "command": ["uv", "run", "scripts/agentera", "--help"],
            "returnCode": 0,
            "stdoutTail": [],
            "stderrTail": [],
            "missingCommands": [],
            "message": "CLI help lists expected state commands",
        },
    )

    cases = [
        (fresh, "explicit --install-root", "fresh", "managed", []),
        (stale_missing_marker, "explicit --install-root", "stale", "managed", ["missing_marker"]),
        (stale_version, "explicit --install-root", "stale", "managed", ["version_mismatch"]),
        (tmp_path / "missing-explicit", "explicit --install-root", "blocked", "missing", ["invalid_install_root"]),
        (tmp_path / "missing-env", "AGENTERA_HOME", "blocked", "missing", ["invalid_install_root"]),
        (tmp_path / "missing-default", "default durable root", "stale", "missing", ["missing_bundle"]),
        (file_root, "explicit --install-root", "blocked", "invalid", ["invalid_install_root"]),
        (unmanaged, "explicit --install-root", "blocked", "unmanaged", ["unmanaged_install_root"]),
    ]

    for root, source_name, expected_status, expected_root_status, expected_kinds in cases:
        status = upgrade.build_bundle_status(
            root,
            root_source=source_name,
            source_root=source,
            home=home,
            project=project,
            expected_version="current",
        )
        assert status["status"] == expected_status
        assert status["rootStatus"] == expected_root_status
        assert [signal["kind"] for signal in status["signals"]][: len(expected_kinds)] == expected_kinds
        if expected_status == "blocked":
            assert status["dryRunCommand"] is None
            assert status["applyCommand"] is None
        elif expected_status == "stale":
            assert status["dryRunCommand"] is not None
            assert status["applyCommand"] is not None


def test_upgrade_caller_uses_shared_standardized_install_root_classification(
    setup_codex: ModuleType,
    upgrade: ModuleType,
    tmp_path: Path,
) -> None:
    setup_only = tmp_path / "setup-only"
    upgrade_only = tmp_path / "upgrade-only"
    _write_setup_root(setup_only, setup_codex)
    _write_upgrade_root(upgrade_only)

    assert setup_codex.install_root_module.classify_resolved_root(
        setup_only,
        source="explicit",
    ).kind == "managed_fresh"
    assert setup_codex.verify_install_root(setup_only) == []
    assert upgrade._valid_install_root(setup_only) is True

    assert setup_codex.install_root_module.classify_resolved_root(
        upgrade_only,
        source="explicit",
        expected_version="current",
    ).kind == "managed_fresh"
    assert upgrade._valid_install_root(upgrade_only) is True
    assert setup_codex.verify_install_root(upgrade_only) == []

    inventory = yaml.safe_load(INVENTORY.read_text(encoding="utf-8"))
    assert inventory["standardization"]["name"] == "canonical-suite-root-vs-managed-bundle-root"
    assert any(entry["decision"].startswith("change") for entry in inventory["behavior_matrix"])
