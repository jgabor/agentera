"""Tests for v2 doctor v3 coexistence detection."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = REPO_ROOT / "scripts"
CLI = SCRIPTS / "agentera"
sys.path.insert(0, str(SCRIPTS))


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_load_module("yaml_mapping", SCRIPTS / "yaml_mapping.py")
probe = _load_module("coexistence_probe", SCRIPTS / "coexistence_probe.py")


def _run_doctor(*, home: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    effective = {
        "AGENTERA_HOME": str(REPO_ROOT),
        "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
        "HOME": str(home),
        "SHELL": "/bin/bash",
    }
    if env:
        effective.update(env)
    return subprocess.run(
        [sys.executable, str(CLI), "doctor"],
        cwd=REPO_ROOT,
        env=effective,
        text=True,
        capture_output=True,
        check=False,
    )


def test_detect_v3_from_npx_cache(tmp_path: Path) -> None:
    home = tmp_path / "home"
    pkg_dir = home / ".npm" / "_npx" / "deadbeef" / "node_modules" / "agentera"
    pkg_dir.mkdir(parents=True)
    (pkg_dir / "package.json").write_text(
        json.dumps({"name": "agentera", "version": "3.0.0-dev.1"}),
        encoding="utf-8",
    )
    (pkg_dir / probe.NPX_BUNDLE_SENTINEL).write_text("{}", encoding="utf-8")

    evidence = probe.detect_v3_coexistence(home)
    assert evidence
    assert any("npx cache" in item for item in evidence)


def test_detect_v3_silent_without_fixture(tmp_path: Path) -> None:
    home = tmp_path / "empty-home"
    home.mkdir()
    assert probe.detect_v3_coexistence(home) == []


def test_warning_lines_match_contract(tmp_path: Path) -> None:
    contract = probe.load_coexistence_probe_authority(REPO_ROOT)
    lines = probe.format_coexistence_doctor_lines(contract, evidence=["npx cache: /tmp/agentera"])
    assert lines[0] == "Coexistence"
    assert lines[1] == "v3 detected alongside v2; pick one line"
    assert lines[2:] == [
        "  - complete v3 migration",
        "  - uninstall v3",
        "  - stay on v2 explicitly",
    ]


def test_doctor_emits_coexistence_warning_with_synthetic_v3(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    pkg_dir = home / ".npm" / "_npx" / "cafebabe" / "node_modules" / "agentera"
    pkg_dir.mkdir(parents=True)
    (pkg_dir / "package.json").write_text(
        json.dumps({"name": "agentera", "version": "3.0.0-dev.5"}),
        encoding="utf-8",
    )
    (pkg_dir / probe.NPX_BUNDLE_SENTINEL).write_text("{}", encoding="utf-8")

    monkeypatch.delenv("npm_config_prefix", raising=False)
    result = _run_doctor(home=home)
    assert result.returncode in {0, 1}
    assert "v3 detected alongside v2; pick one line" in result.stdout
    assert "  - complete v3 migration" in result.stdout
    assert "  - uninstall v3" in result.stdout
    assert "  - stay on v2 explicitly" in result.stdout


def test_doctor_silent_without_v3_fixture(tmp_path: Path) -> None:
    home = tmp_path / "clean-home"
    home.mkdir()
    result = _run_doctor(home=home)
    assert result.returncode in {0, 1}
    assert "v3 detected alongside v2; pick one line" not in result.stdout
