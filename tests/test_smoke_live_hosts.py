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


def test_claude_live_env_isolates_runtime_state(tmp_path: Path) -> None:
    smoke = _load_smoke_live_hosts()
    tmp_home = tmp_path / "home"
    tmp_xdg = tmp_path / "xdg"
    tmp_config = tmp_home / ".claude"
    tmp_install = tmp_path / "install"

    env = smoke._claude_isolated_env(tmp_home, tmp_xdg, tmp_config, tmp_install)

    assert env["HOME"] == str(tmp_home)
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_config)
    assert env["XDG_CONFIG_HOME"] == str(tmp_xdg / "config")
    assert env["XDG_DATA_HOME"] == str(tmp_xdg / "data")
    assert env["XDG_CACHE_HOME"] == str(tmp_xdg / "cache")
    assert env["AGENTERA_HOME"] == str(tmp_install)
    assert env["CLAUDE_PLUGIN_ROOT"] == str(tmp_install)
    assert tmp_config.is_dir()


def test_codex_hook_trusted_hash_omits_absent_optional_fields() -> None:
    smoke = _load_smoke_live_hosts()

    digest = smoke._codex_hook_trusted_hash(
        "post_tool_use",
        "*",
        "python3 /tmp/hook.py",
        10,
        None,
    )

    assert digest == (
        "sha256:a403b1f3c69f15fa13d676682d439ef2fd523cea1c352e97f0f35def38982934"
    )


def test_codex_hook_trust_config_enables_temp_user_hooks(tmp_path: Path) -> None:
    smoke = _load_smoke_live_hosts()
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    hooks_config = codex_home / "hooks.json"
    hooks_config.write_text("{}", encoding="utf-8")

    config = smoke._write_codex_hook_trust_config(
        codex_home,
        hooks_config,
        "python3 /tmp/hook.py",
        "^apply_patch$",
        10,
        "validating artifact (smoke)",
    )

    text = config.read_text(encoding="utf-8")
    assert "[features]" in text
    assert "hooks = true" in text
    assert "[hooks.state]" in text
    assert f"{hooks_config}:pre_tool_use:0:0" in text
    assert f"{hooks_config}:post_tool_use:0:0" in text
    assert "trusted_hash = \"sha256:" in text
    assert "enabled = true" in text
