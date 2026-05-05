"""Tests for the idempotent ``agentera upgrade`` command."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"

PROGRESS_V1 = """\
# Progress

## Cycle 1 · 2026-01-15 10:00 · feat(core): add initial structure

**Phase**: build
**What**: Built the initial project skeleton with core modules.
**Commit**: abc1234
**Inspiration**: Initial project setup from vision session.
**Discovered**: Python 3.10+ required for match statements.
**Verified**: `uv run --with pytest pytest -q` reported 12 passed.
**Next**: Implement the data pipeline module.
**Context**: intent (initial setup) · constraints (no external deps) · unknowns (none) · scope (core/)
"""


def _run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    effective_env = dict(os.environ)
    effective_env["AGENTERA_HOME"] = str(REPO_ROOT)
    effective_env.setdefault("SHELL", "/bin/bash")
    if env:
        effective_env.update(env)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=cwd or REPO_ROOT,
        env=effective_env,
        text=True,
        capture_output=True,
        check=False,
    )


def _write_v1_progress(project: Path) -> Path:
    artifact = project / ".agentera" / "PROGRESS.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(PROGRESS_V1, encoding="utf-8")
    return artifact


def test_upgrade_help_lists_subcommand() -> None:
    result = _run("--help")
    assert result.returncode == 0, result.stderr
    assert "upgrade" in result.stdout


def test_bundle_upgrade_installs_durable_bundle_from_packaged_source(tmp_path: Path) -> None:
    home = tmp_path / "home"
    install_root = home / ".agents" / "agentera"

    first = _run(
        "upgrade",
        "--only",
        "bundle",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(install_root),
        },
    )

    assert first.returncode == 0, first.stderr
    payload = json.loads(first.stdout)
    assert payload["status"] == "applied"
    assert payload["sourceRoot"] == str(REPO_ROOT)
    assert payload["installRoot"] == str(install_root)
    assert (install_root / ".agentera-bundle.json").is_file()
    assert (install_root / "scripts" / "agentera").is_file()
    assert (install_root / "skills" / "agentera" / "SKILL.md").is_file()
    assert (install_root / ".opencode" / "commands" / "agentera.md").is_file()

    second = _run(
        "upgrade",
        "--only",
        "bundle",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(install_root),
        },
    )

    assert second.returncode == 0, second.stderr
    payload = json.loads(second.stdout)
    assert payload["status"] == "noop"
    assert payload["phases"][0]["status"] == "noop"


def test_packaged_runtime_upgrade_wires_durable_bundle_not_uvx_cache(tmp_path: Path) -> None:
    home = tmp_path / "home"
    install_root = home / ".agents" / "agentera"

    result = _run(
        "upgrade",
        "--only",
        "bundle",
        "--only",
        "runtime",
        "--runtime",
        "codex",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(install_root),
        },
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["summary"]["applied"] == 3
    config = (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert f'AGENTERA_HOME = "{install_root}"' in config
    assert f'AGENTERA_HOME = "{REPO_ROOT}"' not in config
    assert (home / ".codex" / "hooks.json").is_file()


def test_packaged_runtime_upgrade_blocks_without_bundle_phase(tmp_path: Path) -> None:
    home = tmp_path / "home"
    install_root = home / ".agents" / "agentera"

    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "codex",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(install_root),
        },
    )

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["phases"][0]["status"] == "blocked"
    assert not (home / ".codex" / "config.toml").exists()


def test_package_upgrade_removes_legacy_skills_and_installs_agentera(tmp_path: Path) -> None:
    result = _run(
        "upgrade",
        "--only",
        "packages",
        "--runtime",
        "opencode",
        "--home",
        str(tmp_path / "home"),
        "--json",
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    items = payload["phases"][0]["items"]
    commands = [" ".join(item["command"]) for item in items]

    assert payload["phases"][0]["status"] == "skipped"
    assert any("--skill agentera" in command and "skills add jgabor/agentera" in command for command in commands)
    assert any("skills remove" in command and "hej" in command and "planera" in command for command in commands)
    for skill in (
        "hej",
        "visionera",
        "resonera",
        "inspirera",
        "planera",
        "realisera",
        "inspektera",
        "optimera",
        "orkestrera",
        "visualisera",
        "dokumentera",
        "profilera",
    ):
        assert not any(f"--skill {skill}" in command for command in commands)


def test_artifact_upgrade_dry_run_json_writes_nothing(tmp_path: Path) -> None:
    project = tmp_path / "project"
    source = _write_v1_progress(project)

    result = _run("upgrade", "--project", str(project), "--only", "artifacts", "--json")

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "pending"
    assert payload["phases"][0]["status"] == "pending"
    assert payload["phases"][0]["items"][0]["source"] == ".agentera/PROGRESS.md"
    assert "newText" not in payload["phases"][0]["items"][0]
    assert source.exists()
    assert not (project / ".agentera" / "progress.yaml").exists()
    assert not (project / ".agentera" / "backup-v1" / "PROGRESS.md").exists()


def test_artifact_upgrade_apply_is_idempotent(tmp_path: Path) -> None:
    project = tmp_path / "project"
    source = _write_v1_progress(project)

    first = _run(
        "upgrade",
        "--project",
        str(project),
        "--only",
        "artifacts",
        "--runtime",
        "codex",
        "--home",
        str(tmp_path / "home"),
        "--yes",
        "--json",
    )

    assert first.returncode == 0, first.stderr
    payload = json.loads(first.stdout)
    assert payload["status"] == "applied"
    assert payload["summary"]["applied"] == 1
    assert not source.exists()
    backup = project / ".agentera" / "backup-v1" / "PROGRESS.md"
    assert backup.read_text(encoding="utf-8") == PROGRESS_V1
    data = yaml.safe_load((project / ".agentera" / "progress.yaml").read_text(encoding="utf-8"))
    assert data["cycles"][0]["commit"] == "abc1234"

    second = _run(
        "upgrade",
        "--project",
        str(project),
        "--only",
        "artifacts",
        "--runtime",
        "codex",
        "--home",
        str(tmp_path / "home"),
        "--yes",
        "--json",
    )

    assert second.returncode == 0, second.stderr
    payload = json.loads(second.stdout)
    assert payload["status"] == "noop"
    assert payload["phases"][0]["status"] == "noop"


def test_runtime_upgrade_configures_codex_without_v1_agent_blocks(tmp_path: Path) -> None:
    home = tmp_path / "home"

    first = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "codex",
        "--home",
        str(home),
        "--yes",
        "--json",
    )

    assert first.returncode == 0, first.stderr
    config = (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert f'AGENTERA_HOME = "{REPO_ROOT}"' in config
    assert "[agents." not in config
    assert (home / ".codex" / "hooks.json").read_text(encoding="utf-8") == (
        REPO_ROOT / "hooks" / "codex-hooks.json"
    ).read_text(encoding="utf-8")

    second = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "codex",
        "--home",
        str(home),
        "--yes",
        "--json",
    )

    assert second.returncode == 0, second.stderr
    payload = json.loads(second.stdout)
    assert payload["status"] == "noop"
    assert payload["phases"][0]["summary"]["noop"] == 2


def test_runtime_upgrade_applies_safe_items_even_when_one_item_is_blocked(tmp_path: Path) -> None:
    home = tmp_path / "home"
    opencode_dir = home / ".config" / "opencode"
    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// user-owned plugin\n", encoding="utf-8")

    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "codex",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--yes",
        "--json",
    )

    assert result.returncode == 1, result.stdout
    payload = json.loads(result.stdout)
    assert payload["summary"]["applied"] == 2
    assert payload["summary"]["blocked"] == 1
    assert f'AGENTERA_HOME = "{REPO_ROOT}"' in (home / ".codex" / "config.toml").read_text(
        encoding="utf-8"
    )
    assert plugin.read_text(encoding="utf-8") == "// user-owned plugin\n"


def test_cleanup_upgrade_removes_fixable_v1_artifacts_and_reports_codex(tmp_path: Path) -> None:
    home = tmp_path / "home"
    skills = home / ".agents" / "skills"
    skills.mkdir(parents=True)
    (skills / "hej").symlink_to(home / "missing" / "skills" / "hej")

    opencode_dir = home / ".config" / "opencode"
    commands = opencode_dir / "commands"
    commands.mkdir(parents=True)
    command = commands / "hej.md"
    command.write_text("Load skill from skills/hej/SKILL.md\n", encoding="utf-8")

    codex_config = home / ".codex" / "config.toml"
    codex_config.parent.mkdir(parents=True)
    codex_config.write_text(
        "[agents.hej]\n"
        'description = "v1 hej"\n'
        f'config_file = "{home / "old" / "skills" / "hej" / "agents" / "hej.toml"}"\n',
        encoding="utf-8",
    )

    result = _run(
        "upgrade",
        "--only",
        "cleanup",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--yes",
        "--json",
    )

    assert result.returncode == 1, result.stdout
    payload = json.loads(result.stdout)
    assert payload["summary"]["applied"] == 2
    assert payload["summary"]["blocked"] == 1
    assert not (skills / "hej").exists()
    assert not command.exists()
    assert "[agents.hej]" in codex_config.read_text(encoding="utf-8")
