"""Tests for live-host smoke harness helpers."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_smoke_live_hosts():
    path = REPO_ROOT / "scripts" / "smoke_live_hosts.py"
    spec = importlib.util.spec_from_file_location("smoke_live_hosts", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["smoke_live_hosts"] = module
    spec.loader.exec_module(module)
    return module


def test_query_smoke_bundle_includes_upgrade_support_module(tmp_path: Path) -> None:
    smoke = _load_smoke_live_hosts()
    install_root = tmp_path / "install"

    smoke._install_query_cli_bundle(install_root)

    assert (install_root / "scripts" / "agentera").is_file()
    assert (install_root / "scripts" / "agentera_upgrade.py").is_file()
    assert (install_root / "skills" / "agentera" / "schemas").is_dir()

    workdir = tmp_path / "project"
    workdir.mkdir()
    env = os.environ.copy()
    env["AGENTERA_HOME"] = str(install_root)
    result = subprocess.run(
        [
            "uv",
            "run",
            str(install_root / "scripts" / "agentera"),
            "query",
            "--list-artifacts",
        ],
        cwd=workdir,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "decisions" in result.stdout
    assert "progress" in result.stdout
    assert "session" in result.stdout
    assert "ModuleNotFoundError" not in result.stdout + result.stderr
