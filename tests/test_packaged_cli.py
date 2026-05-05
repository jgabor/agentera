"""Tests for the uvx-oriented packaged Agentera CLI launcher."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_packaged_launcher_runs_upgrade_with_durable_default(tmp_path: Path) -> None:
    home = tmp_path / "home"
    install_root = home / ".agents" / "agentera"
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT / "src")
    env["HOME"] = str(home)
    env["AGENTERA_DEFAULT_INSTALL_ROOT"] = str(install_root)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "agentera_cli",
            "upgrade",
            "--only",
            "bundle",
            "--home",
            str(home),
            "--yes",
            "--json",
        ],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["installRoot"] == str(install_root)
    assert payload["sourceRoot"] == str(REPO_ROOT)
    assert (install_root / ".agentera-bundle.json").is_file()
