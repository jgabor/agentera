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
        assert f"--install-root {root.resolve()} is not a valid Agentera directory" in message
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


def test_upgrade_characterizes_doctor_root_shapes(
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
    update_home = tmp_path / "update-home"
    file_root.write_text("not a directory\n", encoding="utf-8")
    unmanaged.mkdir()
    _write_upgrade_root(fresh)
    _write_upgrade_root(stale_missing_marker, marker_version=None)
    _write_upgrade_root(stale_version, marker_version="old")
    _write_upgrade_root(update_home / "app", marker_version="old")

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
        (fresh, "explicit --install-root", "migration_needed", "managed", ["migration_needed"]),
        (stale_missing_marker, "explicit --install-root", "migration_needed", "managed", ["migration_needed", "missing_marker"]),
        (stale_version, "explicit --install-root", "migration_needed", "managed", ["migration_needed", "version_mismatch"]),
        (update_home, "explicit --install-root", "outdated", "managed", ["version_mismatch"]),
        (tmp_path / "missing-explicit", "explicit --install-root", "manual_review_needed", "missing", ["invalid_install_root"]),
        (tmp_path / "missing-env", "AGENTERA_HOME", "manual_review_needed", "missing", ["invalid_install_root"]),
        (tmp_path / "missing-default", "default app home", "repair_needed", "missing", ["missing_bundle"]),
        (file_root, "explicit --install-root", "manual_review_needed", "invalid", ["invalid_install_root"]),
        (unmanaged, "explicit --install-root", "manual_review_needed", "unmanaged", ["unmanaged_install_root"]),
    ]

    for root, source_name, expected_status, expected_root_status, expected_kinds in cases:
        status = upgrade.build_doctor_status(
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
        if expected_status == "manual_review_needed":
            assert status["dryRunCommand"] is None
            assert status["applyCommand"] is None
        elif expected_status in {"repair_needed", "outdated", "migration_needed"}:
            assert status["dryRunCommand"] is not None
            assert status["applyCommand"] is not None
        if expected_status == "outdated":
            rendered = upgrade.render_doctor_status(status)
            assert "status: outdated" in rendered
            assert "Preview the update" in rendered
            assert "Preview the repair" not in rendered


def test_doctor_up_to_date_text_has_no_required_next_block(
    upgrade: ModuleType,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    home = tmp_path / "home"
    project = tmp_path / "project"
    app_home = tmp_path / "app-home"
    project.mkdir()
    _write_upgrade_root(app_home / "app", marker_version="current")

    status = upgrade.build_doctor_status(
        app_home,
        root_source="explicit --install-root",
        source_root=source,
        home=home,
        project=project,
        expected_version="current",
        probe_cli=False,
    )

    assert status["status"] == "up_to_date"
    assert status["dryRunCommand"] is None
    assert status["applyCommand"] is None
    assert status["signals"] == []

    rendered = upgrade.render_doctor_status(status)
    assert "status: up to date" in rendered
    assert "No action needed: Agentera app files are up to date." in rendered
    assert "Next:" not in rendered
    assert "Preview the" not in rendered
    assert "repair" not in rendered.lower()


def test_doctor_actionable_text_and_json_keep_canonical_guidance(
    upgrade: ModuleType,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    home = tmp_path / "home"
    project = tmp_path / "project"
    project.mkdir()
    update_home = tmp_path / "update-home"
    repair_home = tmp_path / "repair-home"
    _write_upgrade_root(update_home / "app", marker_version="old")
    _write_upgrade_root(repair_home / "app", marker_version="old", commands=("doctor",))

    cases = [
        (update_home, ("hej",), "outdated", "Preview the update", "Preview the repair"),
        (repair_home, ("hej",), "repair_needed", "Preview the repair", "Preview the update"),
    ]
    legacy_statuses = {"fresh", "stale", "update_needed", "migration_required", "blocked"}

    for app_home, expected_commands, expected_status, expected_label, rejected_label in cases:
        status = upgrade.build_doctor_status(
            app_home,
            root_source="explicit --install-root",
            source_root=source,
            home=home,
            project=project,
            expected_version="current",
            expected_commands=expected_commands,
            probe_cli=True,
        )

        public = upgrade.public_doctor_status(status)
        assert public["status"] == expected_status
        assert public["status"] not in legacy_statuses
        assert {signal["status"] for signal in public["signals"]}.isdisjoint(legacy_statuses)
        assert public["dryRunCommand"] is not None
        assert public["applyCommand"] is not None
        assert public["retryCommand"] is not None
        assert " --dry-run" in public["dryRunCommand"]

        rendered = upgrade.render_doctor_status(status)
        assert f"status: {upgrade._plain_status(expected_status)}" in rendered
        assert "Next:" in rendered
        assert expected_label in rendered
        assert rejected_label not in rendered
        assert "Then retry Agentera" in rendered


def test_doctor_manual_review_text_and_json_block_automatic_repair(
    upgrade: ModuleType,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    home = tmp_path / "home"
    project = tmp_path / "project"
    unmanaged = tmp_path / "unmanaged"
    project.mkdir()
    unmanaged.mkdir()
    (unmanaged / "README.txt").write_text("user-owned directory\n", encoding="utf-8")

    status = upgrade.build_doctor_status(
        unmanaged,
        root_source="explicit --install-root",
        source_root=source,
        home=home,
        project=project,
        expected_version="current",
        probe_cli=False,
    )

    public = upgrade.public_doctor_status(status)
    assert public["status"] == "manual_review_needed"
    assert public["signals"][0]["status"] == "manual_review_needed"
    assert public["dryRunCommand"] is None
    assert public["applyCommand"] is None
    assert "installRoot" not in public
    assert "installRootSource" not in public

    rendered = upgrade.render_doctor_status(status)
    assert "status: needs manual review" in rendered
    assert "Preview the repair" not in rendered
    assert "apply the repair" not in rendered
    assert "Next: choose a safer Agentera directory" in rendered
    assert "use `--force` only after checking" in rendered


def test_version_mismatch_plus_missing_required_command_remains_repair(
    upgrade: ModuleType,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    home = tmp_path / "home"
    project = tmp_path / "project"
    app_home = tmp_path / "app-home"
    project.mkdir()
    _write_upgrade_root(app_home / "app", marker_version="1.0.0", commands=("doctor",))

    status = upgrade.build_doctor_status(
        app_home,
        root_source="explicit --install-root",
        source_root=source,
        home=home,
        project=project,
        expected_version="2.0.0",
        expected_commands=("hej",),
    )

    assert status["status"] == "repair_needed"
    assert [signal["kind"] for signal in status["signals"]] == ["version_mismatch", "missing_command"]
    assert status["dryRunCommand"] is not None
    assert status["applyCommand"] is not None
    rendered = upgrade.render_doctor_status(status)
    assert "status: needs repair" in rendered
    assert "Preview the repair" in rendered
    assert "Preview the update" not in rendered


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
    assert inventory["standardization"]["name"] == "canonical-suite-root-vs-managed-app-root"
    assert any(entry["decision"].startswith("change") for entry in inventory["behavior_matrix"])
