"""Tests for the uvx-oriented packaged Agentera CLI launcher."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_packaged_launcher_recovers_deprecated_default_env_to_platform_home(tmp_path: Path) -> None:
    home = tmp_path / "home"
    deprecated_default = home / ".agents" / "agentera"
    platform_home = home / ".local" / "share" / "agentera"
    env = dict(os.environ)
    env["PYTHONPATH"] = str(REPO_ROOT / "src")
    env["HOME"] = str(home)
    env["XDG_DATA_HOME"] = str(home / ".local" / "share")
    env["AGENTERA_HOME"] = ""
    env["AGENTERA_DEFAULT_INSTALL_ROOT"] = str(deprecated_default)

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "agentera",
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
    assert payload["appHome"] == str(platform_home)
    assert payload["appHomeResolution"]["kind"] == "legacy_default_residue"
    assert payload["appHomeResolution"]["source"] == "AGENTERA_DEFAULT_INSTALL_ROOT"
    assert "installRoot" not in payload
    assert payload["sourceRoot"] == str(REPO_ROOT)
    assert (platform_home / "app" / ".agentera-bundle.json").is_file()
    assert not deprecated_default.exists()
