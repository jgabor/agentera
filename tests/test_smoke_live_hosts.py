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
    assert "session" not in result.stdout
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


def test_default_fixture_parity_smoke_reports_counts_without_transcripts(capsys) -> None:
    smoke = _load_smoke_live_hosts()

    smoke.run_fixture_corpus_parity_audit()

    output = capsys.readouterr().out
    assert "PASS: profilera fixture corpus parity audit" in output
    assert "runtime: claude-code status=ok" in output
    assert "runtime: codex status=ok" in output
    assert "runtime: opencode status=ok" in output
    assert "runtime: github-copilot status=ok" in output
    for private_text in smoke.PRIVATE_FIXTURE_TEXT:
        assert private_text not in output


def test_unavailable_store_smoke_reports_bounded_missing_statuses(capsys) -> None:
    smoke = _load_smoke_live_hosts()

    smoke.run_unavailable_store_degradation_audit()

    output = capsys.readouterr().out
    assert "PASS: profilera unavailable store degradation audit" in output
    assert "runtime: claude-code status=missing reason=store_absent" in output
    assert "runtime: codex status=missing reason=store_absent" in output
    assert "runtime: opencode status=missing reason=store_absent" in output
    assert "runtime: github-copilot status=missing reason=store_absent" in output


def test_default_smoke_does_not_recover_orphan_live_snapshots(
    tmp_path: Path, monkeypatch
) -> None:
    smoke = _load_smoke_live_hosts()
    original = tmp_path / "bashrc"
    backup = tmp_path / "agentera-smoke-live-bashrc.bak"
    original.write_text("user shell rc\n", encoding="utf-8")
    backup.write_text("prior live snapshot\n", encoding="utf-8")
    backup.with_suffix(backup.suffix + smoke.SNAPSHOT_META_SUFFIX).write_text(
        str(original) + "\n", encoding="utf-8"
    )
    monkeypatch.setattr(smoke, "SNAPSHOT_TMP_GLOB", str(tmp_path / "*.bak"))
    monkeypatch.setattr(smoke, "run_fixture_corpus_parity_audit", lambda: None)
    monkeypatch.setattr(smoke, "run_unavailable_store_degradation_audit", lambda: None)
    monkeypatch.setattr(smoke, "run_setup_helpers_smoke", lambda: None)
    monkeypatch.setattr(smoke, "run_upgrade_repair_smoke", lambda: None)

    assert smoke.main([]) == 0

    assert original.read_text(encoding="utf-8") == "user shell rc\n"
    assert backup.exists()


def test_live_smoke_recovers_orphan_live_snapshots_when_explicit(
    tmp_path: Path, monkeypatch
) -> None:
    smoke = _load_smoke_live_hosts()
    original = tmp_path / "bashrc"
    backup = tmp_path / "agentera-smoke-live-bashrc.bak"
    original.write_text("user shell rc\n", encoding="utf-8")
    backup.write_text("prior live snapshot\n", encoding="utf-8")
    meta = backup.with_suffix(backup.suffix + smoke.SNAPSHOT_META_SUFFIX)
    meta.write_text(str(original) + "\n", encoding="utf-8")
    monkeypatch.setattr(smoke, "SNAPSHOT_TMP_GLOB", str(tmp_path / "*.bak"))
    monkeypatch.setattr(smoke, "run_fixture_corpus_parity_audit", lambda: None)
    monkeypatch.setattr(smoke, "run_unavailable_store_degradation_audit", lambda: None)
    monkeypatch.setattr(smoke, "run_setup_helpers_smoke", lambda: None)
    monkeypatch.setattr(smoke, "run_upgrade_repair_smoke", lambda: None)
    monkeypatch.setattr(smoke, "run_claude_live_section", lambda snapshots, skips: None)
    monkeypatch.setattr(smoke, "run_codex_live_section", lambda snapshots, skips: None)
    monkeypatch.setattr(smoke, "run_codex_hook_section", lambda snapshots, skips: None)
    monkeypatch.setattr(smoke, "run_copilot_live_section", lambda snapshots, skips: None)
    monkeypatch.setattr(smoke, "run_opencode_live_section", lambda snapshots, skips: None)

    assert smoke.main(["--live", "--yes"]) == 0

    assert original.read_text(encoding="utf-8") == "prior live snapshot\n"
    assert not backup.exists()
    assert not meta.exists()
