"""Tests for the non-mutating setup doctor.

Task 3 cap: one pass, one warn/fail, and one skip per runtime family.
Task 4 cap: one success and one failure branch per smoke-check category.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType


REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_doctor() -> ModuleType:
    path = REPO_ROOT / "scripts" / "setup_doctor.py"
    spec = importlib.util.spec_from_file_location("setup_doctor", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_install_root(root: Path, doctor: ModuleType, *, omit: str | None = None) -> None:
    for entry in doctor.CANONICAL_ENTRIES:
        if entry == omit:
            continue
        target = root / entry
        if "." in Path(entry).name:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture\n", encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
    for entry in doctor.HELPER_ENTRIES:
        if entry == omit:
            continue
        target = root / entry
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("fixture\n", encoding="utf-8")


def _path_with_binary(tmp_path: Path, binary: str) -> str:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    executable = bin_dir / binary
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    os.chmod(executable, 0o755)
    return str(bin_dir)


def _base_env(path: str, **extra: str) -> dict[str, str]:
    env = {"PATH": path}
    env.update(extra)
    return env


def _prepare_pass(runtime: str, home: Path, root: Path, env: dict[str, str]) -> None:
    if runtime == "claude":
        env["CLAUDE_PLUGIN_ROOT"] = str(root)
    elif runtime == "opencode":
        plugin = home / ".config" / "opencode" / "plugins" / "agentera.js"
        plugin.parent.mkdir(parents=True)
        plugin.write_text("fixture\n", encoding="utf-8")
        env["AGENTERA_HOME"] = str(root)
    elif runtime == "copilot":
        env["AGENTERA_HOME"] = str(root)
    elif runtime == "codex":
        config = home / ".codex" / "config.toml"
        config.parent.mkdir(parents=True)
        config.write_text(
            '[shell_environment_policy]\nset = { AGENTERA_HOME = "' + str(root) + '" }\n',
            encoding="utf-8",
        )


def test_setup_doctor_passes_for_each_runtime_family(tmp_path: Path) -> None:
    doctor = _load_doctor()
    for runtime in doctor.RUNTIMES:
        root = tmp_path / runtime / "agentera"
        home = tmp_path / runtime / "home"
        _write_install_root(root, doctor)
        path = _path_with_binary(tmp_path / runtime, doctor.RUNTIME_BINARIES[runtime])
        env = _base_env(path)
        _prepare_pass(runtime, home, root, env)

        report = doctor.build_report(install_root=root, home=home, env=env, runtimes=(runtime,))

        assert report["schemaVersion"] == doctor.SCHEMA_VERSION
        assert report["ok"] is True
        assert report["installRoot"]["status"] == "pass"
        assert report["runtimes"][runtime]["status"] == "pass"


def test_setup_doctor_warns_or_fails_with_classified_helper_access_gaps(tmp_path: Path) -> None:
    doctor = _load_doctor()
    cases = {
        "claude": ("warn", "user_environment"),
        "opencode": ("warn", "runtime_config"),
        "copilot": ("fail", "bundle_packaging"),
        "codex": ("fail", "runtime_config"),
    }
    for runtime, (expected_status, expected_gap) in cases.items():
        root = tmp_path / runtime / "agentera"
        home = tmp_path / runtime / "home"
        _write_install_root(root, doctor)
        path = _path_with_binary(tmp_path / runtime, doctor.RUNTIME_BINARIES[runtime])
        env = _base_env(path)

        if runtime == "copilot":
            partial = tmp_path / runtime / "partial"
            _write_install_root(partial, doctor, omit="scripts/validate_spec.py")
            env["AGENTERA_HOME"] = str(partial)
        elif runtime == "codex":
            config = home / ".codex" / "config.toml"
            config.parent.mkdir(parents=True)
            config.write_text(
                '[shell_environment_policy]\nset = { AGENTERA_HOME = "' + str(home / "missing") + '" }\n',
                encoding="utf-8",
            )

        report = doctor.build_report(install_root=root, home=home, env=env, runtimes=(runtime,))
        runtime_report = report["runtimes"][runtime]
        gaps = {check["gap"] for check in runtime_report["checks"]}

        assert runtime_report["status"] == expected_status
        assert expected_gap in gaps


def test_setup_doctor_skips_each_unavailable_runtime_family(tmp_path: Path) -> None:
    doctor = _load_doctor()
    root = tmp_path / "agentera"
    home = tmp_path / "home"
    _write_install_root(root, doctor)

    for runtime in doctor.RUNTIMES:
        report = doctor.build_report(install_root=root, home=home, env={"PATH": ""}, runtimes=(runtime,))

        assert report["ok"] is True
        assert report["runtimes"][runtime]["status"] == "skip"
        assert report["runtimes"][runtime]["checks"][0]["gap"] == "user_environment"


def test_setup_doctor_cli_json_is_stable_and_non_mutating(tmp_path: Path) -> None:
    doctor = _load_doctor()
    root = tmp_path / "agentera"
    home = tmp_path / "home"
    home.mkdir()
    _write_install_root(root, doctor)

    before = sorted(path.relative_to(home) for path in home.rglob("*"))
    result = subprocess.run(
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "setup_doctor.py"),
            "--install-root",
            str(root),
            "--home",
            str(home),
            "--json",
        ],
        env={"PATH": ""},
        capture_output=True,
        text=True,
        check=False,
    )
    after = sorted(path.relative_to(home) for path in home.rglob("*"))
    payload = json.loads(result.stdout)

    assert result.returncode == 0
    assert before == after == []
    assert payload["schemaVersion"] == doctor.SCHEMA_VERSION
    assert payload["summary"] == {"fail": 0, "pass": 0, "skip": 4, "warn": 0}


def test_setup_doctor_smoke_proves_helpers_hooks_and_host_status_without_live_calls(
    tmp_path: Path,
    monkeypatch,
) -> None:
    doctor = _load_doctor()
    real_run = doctor.subprocess.run
    calls: list[list[str]] = []

    def record_run(command, *args, **kwargs):
        executable = Path(command[0]).name
        assert executable not in set(doctor.RUNTIME_BINARIES.values())
        calls.append(list(command))
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr(doctor.subprocess, "run", record_run)
    path = _path_with_binary(tmp_path, "codex")

    report = doctor.build_report(
        install_root=REPO_ROOT,
        env={"PATH": path},
        runtimes=("codex", "copilot"),
        run_smoke=True,
    )
    smoke = report["smoke"]
    smoke_by_name = {check["name"]: check for check in smoke["checks"]}

    assert report["ok"] is True
    assert smoke["modelCallsAttempted"] is False
    assert smoke_by_name["helper.validate_spec"]["status"] == "pass"
    assert smoke_by_name["hook.artifact_validation"]["status"] == "pass"
    assert smoke_by_name["host.codex"]["status"] == "pass"
    assert smoke_by_name["host.copilot"]["status"] == "skip"
    assert len(calls) == 2


def test_setup_doctor_smoke_helper_failure_is_visible_in_human_and_json(
    tmp_path: Path,
) -> None:
    doctor = _load_doctor()
    root = tmp_path / "agentera"
    _write_install_root(root, doctor)
    skill = root / "skills" / "realisera" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text("---\nname: realisera\n---\n", encoding="utf-8")
    (root / "scripts" / "validate_spec.py").write_text(
        "import sys\nprint('fixture helper failed')\nsys.exit(7)\n",
        encoding="utf-8",
    )
    (root / "hooks" / "validate_artifact.py").write_text(
        "import json\n"
        "print(json.dumps({"
        "'permissionDecision': 'deny', "
        "'permissionDecisionReason': 'fixture'"
        "}))\n",
        encoding="utf-8",
    )

    report = doctor.build_report(
        install_root=root,
        env={"PATH": ""},
        runtimes=(),
        run_smoke=True,
    )
    human = doctor.render_human(report)
    helper = next(
        check for check in report["smoke"]["checks"] if check["category"] == "helper"
    )

    assert report["ok"] is False
    assert helper["status"] == "fail"
    assert "validate_spec.py exited 7" in helper["message"]
    assert "helper.validate_spec: fail" in human


def test_setup_doctor_smoke_hook_failure_is_visible_in_human_and_json(
    tmp_path: Path,
) -> None:
    doctor = _load_doctor()
    root = tmp_path / "agentera"
    _write_install_root(root, doctor)
    skill = root / "skills" / "realisera" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text("---\nname: realisera\n---\n", encoding="utf-8")
    (root / "scripts" / "validate_spec.py").write_text(
        "import sys\nsys.exit(0)\n",
        encoding="utf-8",
    )
    (root / "hooks" / "validate_artifact.py").write_text(
        "import json\nprint(json.dumps({'permissionDecision': 'allow'}))\n",
        encoding="utf-8",
    )

    report = doctor.build_report(
        install_root=root,
        env={"PATH": ""},
        runtimes=(),
        run_smoke=True,
    )
    human = doctor.render_human(report)
    hook = next(
        check for check in report["smoke"]["checks"] if check["category"] == "hook"
    )

    assert report["ok"] is False
    assert hook["status"] == "fail"
    assert "allowed an invalid TODO.md candidate" in hook["message"]
    assert "hook.artifact_validation: fail" in human
