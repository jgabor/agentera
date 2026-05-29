"""Tests for the idempotent ``agentera upgrade`` command."""

from __future__ import annotations

import json
import importlib.util
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

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


def _load_upgrade_module() -> ModuleType:
    path = REPO_ROOT / "scripts" / "agentera_upgrade.py"
    spec = importlib.util.spec_from_file_location("agentera_upgrade", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_v1_progress(project: Path) -> Path:
    artifact = project / ".agentera" / "PROGRESS.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text(PROGRESS_V1, encoding="utf-8")
    return artifact


def _write_legacy_default_app_home(root: Path) -> None:
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "agentera").write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    (root / "skills" / "agentera").mkdir(parents=True)
    (root / "skills" / "agentera" / "SKILL.md").write_text(
        "---\nname: agentera\nversion: '2.2.3'\n---\n",
        encoding="utf-8",
    )
    (root / "registry.json").write_text(
        json.dumps({"skills": [{"name": "agentera", "version": "2.2.3"}]}),
        encoding="utf-8",
    )
    (root / ".agentera-bundle.json").write_text(
        json.dumps({"schemaVersion": "agentera.bundle.v1", "version": "2.2.3"}),
        encoding="utf-8",
    )


def _write_all_canonical_v1_markdown(project: Path) -> list[Path]:
    agentera = project / ".agentera"
    agentera.mkdir(parents=True)
    files = {
        agentera / "PROGRESS.md": PROGRESS_V1,
        agentera / "DECISIONS.md": "# Decisions\n\n",
        agentera / "HEALTH.md": "# Health\n\n",
        agentera / "PLAN.md": "# Plan: Legacy\n\n## What\nLegacy plan.\n\n## Why\nMigration coverage.\n",
        agentera / "DOCS.md": "# Docs\n\n",
        project / "VISION.md": "# Legacy Vision\n\n## North Star\nShip reliable upgrades.\n",
    }
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return list(files)


def test_upgrade_help_lists_subcommand() -> None:
    result = _run("--help")
    assert result.returncode == 0, result.stderr
    assert "upgrade" in result.stdout


def test_bundle_upgrade_installs_durable_bundle_from_packaged_source(tmp_path: Path) -> None:
    home = tmp_path / "home"
    deprecated_default = home / ".agents" / "agentera"
    app_home = home / ".local" / "share" / "agentera"

    first = _run(
        "upgrade",
        "--only",
        "bundle",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_HOME": "",
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
        },
    )

    assert first.returncode == 0, first.stderr
    payload = json.loads(first.stdout)
    assert payload["status"] == "applied"
    assert payload["sourceRoot"] == str(REPO_ROOT)
    assert payload["appHome"] == str(app_home)
    assert payload["managedAppRoot"] == str(app_home / "app")
    assert payload["userDataRoot"] == str(app_home)
    assert "installRoot" not in payload
    assert (app_home / "app" / ".agentera-bundle.json").is_file()
    assert (app_home / "app" / "scripts" / "agentera").is_file()
    assert (app_home / "app" / "skills" / "agentera" / "SKILL.md").is_file()
    assert (app_home / "app" / ".opencode" / "commands" / "agentera.md").is_file()
    assert (app_home / "app" / ".cursor" / "hooks.json").is_file()

    second = _run(
        "upgrade",
        "--only",
        "bundle",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_HOME": "",
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
        },
    )

    assert second.returncode == 0, second.stderr
    payload = json.loads(second.stdout)
    assert payload["status"] == "noop"
    assert payload["phases"][0]["status"] == "noop"


def test_runtime_upgrade_installs_cursor_hooks_from_bundled_source(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project = tmp_path / "project"
    app_home = home / ".local" / "share" / "agentera"
    deprecated_default = home / ".agents" / "agentera"
    bootstrap_env = {
        "AGENTERA_HOME": "",
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
        "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
    }

    bundle = _run(
        "upgrade",
        "--only",
        "bundle",
        "--home",
        str(home),
        "--yes",
        "--json",
        env=bootstrap_env,
    )
    assert bundle.returncode == 0, bundle.stderr
    assert (app_home / "app" / ".cursor" / "hooks.json").is_file()

    runtime_env = {
        **bootstrap_env,
        "AGENTERA_HOME": str(app_home),
    }
    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "cursor",
        "--home",
        str(home),
        "--project",
        str(project),
        "--yes",
        "--json",
        env=runtime_env,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    runtime_items = {(item["runtime"], item["action"]): item for item in payload["phases"][0]["items"]}
    copy_hooks = runtime_items[("cursor", "copy-hooks")]
    assert copy_hooks["status"] == "applied"
    assert copy_hooks["source"] == str(app_home / "app" / ".cursor" / "hooks.json")
    assert copy_hooks["target"] == str(project / ".cursor" / "hooks.json")
    installed = json.loads((project / ".cursor" / "hooks.json").read_text(encoding="utf-8"))
    assert "cursor_session_start.py" in json.dumps(installed)
    assert "cursor_pre_tool_use.py" in json.dumps(installed)


def test_default_upgrade_retires_legacy_agents_default_app_home(tmp_path: Path) -> None:
    home = tmp_path / "home"
    legacy_default = home / ".agents" / "agentera"
    platform_home = home / ".local" / "share" / "agentera"
    _write_legacy_default_app_home(legacy_default)
    (legacy_default / "PROFILE.md").write_text("# Profile\n", encoding="utf-8")

    env = {
        "AGENTERA_HOME": "",
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
    }
    preview = _run("upgrade", "--only", "bundle", "--home", str(home), "--dry-run", "--json", env=env)

    assert preview.returncode == 1, preview.stderr
    preview_payload = json.loads(preview.stdout)
    assert preview_payload["appHome"] == str(platform_home)
    bundle_items = {item["action"]: item for item in preview_payload["phases"][0]["items"]}
    assert bundle_items["install-bundle"]["target"] == str(platform_home / "app")
    assert bundle_items["retire-legacy-default-app-home"]["source"] == str(legacy_default)
    assert bundle_items["retire-legacy-default-app-home"]["target"] == str(platform_home)
    assert bundle_items["retire-legacy-default-app-home"]["changedPreview"] == ["PROFILE.md"]
    assert (legacy_default / "scripts" / "agentera").exists()
    assert not platform_home.exists()

    apply = _run("upgrade", "--only", "bundle", "--home", str(home), "--yes", "--json", env=env)

    assert apply.returncode == 0, apply.stderr
    payload = json.loads(apply.stdout)
    assert payload["status"] == "applied"
    assert (platform_home / "app" / "scripts" / "agentera").is_file()
    assert (platform_home / "PROFILE.md").read_text(encoding="utf-8") == "# Profile\n"
    assert not legacy_default.exists()

    second = _run("upgrade", "--only", "bundle", "--home", str(home), "--yes", "--json", env=env)

    assert second.returncode == 0, second.stderr
    second_payload = json.loads(second.stdout)
    assert second_payload["status"] == "noop"


def test_packaged_runtime_upgrade_wires_durable_bundle_not_uvx_cache(tmp_path: Path) -> None:
    home = tmp_path / "home"
    deprecated_default = home / ".agents" / "agentera"
    app_home = home / ".local" / "share" / "agentera"

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
            "AGENTERA_HOME": "",
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
        },
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["summary"]["applied"] == 15
    config = (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert f'AGENTERA_HOME = "{app_home}"' in config
    assert f'AGENTERA_HOME = "{REPO_ROOT}"' not in config
    assert (home / ".codex" / "hooks.json").is_file()
    assert (home / ".codex" / "agents" / "realisera.toml").is_file()


def test_packaged_runtime_upgrade_blocks_without_bundle_phase(tmp_path: Path) -> None:
    home = tmp_path / "home"
    deprecated_default = home / ".agents" / "agentera"

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
            "AGENTERA_HOME": "",
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
        },
    )

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["phases"][0]["status"] == "blocked"
    assert not (home / ".codex" / "config.toml").exists()


def test_runtime_upgrade_accepts_coherent_app_home_without_bundle_phase(tmp_path: Path) -> None:
    home = tmp_path / "home"
    deprecated_default = home / ".agents" / "agentera"
    app_home = home / ".local" / "share" / "agentera"

    installed = _run(
        "upgrade",
        "--only",
        "bundle",
        "--home",
        str(home),
        "--yes",
        "--json",
        env={
            "AGENTERA_HOME": "",
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
        },
    )
    assert installed.returncode == 0, installed.stderr

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
            "AGENTERA_HOME": "",
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            "AGENTERA_DEFAULT_INSTALL_ROOT": str(deprecated_default),
        },
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["summary"]["blocked"] == 0
    assert f'AGENTERA_HOME = "{app_home}"' in (home / ".codex" / "config.toml").read_text(
        encoding="utf-8"
    )
    hooks_payload = json.loads((home / ".codex" / "hooks.json").read_text(encoding="utf-8"))
    hook_command = hooks_payload["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
    assert hook_command == f'uv run "{app_home / "app" / "hooks" / "validate_artifact.py"}"'
    assert (home / ".codex" / "agents" / "orkestrera.toml").read_text(encoding="utf-8") == (
        app_home / "app" / "skills" / "agentera" / "agents" / "orkestrera.toml"
    ).read_text(encoding="utf-8")


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


def test_artifact_upgrade_applies_all_supported_v1_markdown_sources(tmp_path: Path) -> None:
    project = tmp_path / "project"
    sources = _write_all_canonical_v1_markdown(project)

    result = _run("upgrade", "--project", str(project), "--only", "artifacts", "--yes", "--json")

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "applied"
    items = payload["phases"][0]["items"]
    assert {item["source"] for item in items} == {
        ".agentera/PROGRESS.md",
        ".agentera/DECISIONS.md",
        ".agentera/HEALTH.md",
        ".agentera/PLAN.md",
        ".agentera/DOCS.md",
        "VISION.md",
    }
    assert all(item["status"] == "applied" for item in items)
    for source in sources:
        assert not source.exists()
        assert (project / ".agentera" / "backup-v1" / source.name).is_file()
    for target in (
        "progress.yaml",
        "decisions.yaml",
        "health.yaml",
        "plan.yaml",
        "docs.yaml",
        "vision.yaml",
    ):
        assert (project / ".agentera" / target).is_file()


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
    setup_codex = _load_upgrade_module()._setup_codex_module()

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
    hooks_path = home / ".codex" / "hooks.json"
    assert f'AGENTERA_HOME = "{REPO_ROOT}"' in config
    assert "[features]" in config
    assert "hooks = true" in config
    assert "[hooks.state]" in config
    assert f"{hooks_path}:pre_tool_use:0:0" in config
    assert f"{hooks_path}:post_tool_use:0:0" in config
    hooks_text = hooks_path.read_text(encoding="utf-8")
    hook_command = setup_codex.codex_validator_command(REPO_ROOT)
    hooks_payload = json.loads(hooks_text)
    assert hooks_payload["hooks"]["PreToolUse"][0]["hooks"][0]["command"] == hook_command
    assert hooks_payload["hooks"]["PostToolUse"][0]["hooks"][0]["command"] == hook_command
    assert "${AGENTERA_HOME}" not in hooks_text
    assert setup_codex.codex_hook_trusted_hash(
        "pre_tool_use",
        setup_codex.CODEX_HOOK_MATCHER,
        command=hook_command,
    ) in config
    assert setup_codex.codex_hook_trusted_hash(
        "post_tool_use",
        setup_codex.CODEX_HOOK_MATCHER,
        command=hook_command,
    ) in config
    assert "enabled = true" in config
    assert "[agents]" in config
    assert "max_threads" not in config
    assert "max_depth = 1" in config
    assert "[features.multi_agent_v2]" in config
    assert "max_concurrent_threads_per_session = 6" in config
    assert "[agents." not in config
    assert hooks_text == setup_codex.render_codex_hooks_config(hook_command)
    assert (home / ".codex" / "agents" / "planera.toml").is_file()

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
    assert payload["phases"][0]["summary"]["noop"] == 14


def test_runtime_upgrade_refreshes_codex_managed_entries_preserving_user_config(tmp_path: Path) -> None:
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    setup_codex = _load_upgrade_module()._setup_codex_module()
    codex_config = home / ".codex" / "config.toml"
    stale_hooks = home / ".codex" / "hooks.json"
    codex_config.parent.mkdir(parents=True)
    codex_config.write_text(
        '[profiles.default]\nmodel = "gpt-5.5"\n\n'
        '[shell_environment_policy]\n'
        'set = { AGENTERA_HOME = "/stale/agentera" }\n',
        encoding="utf-8",
    )
    stale_hooks.write_text('{"note": "agentera v2 Codex hooks stale"}\n', encoding="utf-8")

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
        env={"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")},
    )

    assert result.returncode == 0, result.stderr
    config = codex_config.read_text(encoding="utf-8")
    assert '[profiles.default]\nmodel = "gpt-5.5"' in config
    assert f'AGENTERA_HOME = "{app_home}"' in config
    assert "/stale/agentera" not in config
    hooks_text = stale_hooks.read_text(encoding="utf-8")
    hook_command = setup_codex.codex_validator_command(app_home)
    assert hooks_text == setup_codex.render_codex_hooks_config(hook_command)
    assert str(app_home / "app" / "hooks" / "validate_artifact.py") in hooks_text
    assert "${AGENTERA_HOME}" not in hooks_text


def test_runtime_upgrade_prefers_codex_plugin_hooks_when_plugin_enabled(tmp_path: Path) -> None:
    home = tmp_path / "home"
    setup_codex = _load_upgrade_module()._setup_codex_module()
    codex_config = home / ".codex" / "config.toml"
    copied_hooks = home / ".codex" / "hooks.json"
    codex_config.parent.mkdir(parents=True)
    codex_config.write_text(
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{REPO_ROOT}" }}\n',
        encoding="utf-8",
    )
    copied_hooks.write_text(
        setup_codex.render_codex_hooks_config(setup_codex.codex_validator_command(REPO_ROOT)),
        encoding="utf-8",
    )

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
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    runtime_items = {(item["runtime"], item["action"]): item for item in payload["phases"][0]["items"]}
    assert ("codex", "copy-hooks") not in runtime_items
    assert runtime_items[("codex", "retire-hooks")]["status"] == "applied"
    assert not copied_hooks.exists()
    config = codex_config.read_text(encoding="utf-8")
    assert "hooks = true" in config
    assert "plugin_hooks = true" in config
    assert "agentera@agentera:hooks/codex-plugin-hooks.json:pre_tool_use:0:0" in config
    assert "agentera@agentera:hooks/codex-plugin-hooks.json:post_tool_use:0:0" in config
    assert str(copied_hooks) not in config
    assert setup_codex.codex_hook_trusted_hash(
        "pre_tool_use",
        setup_codex.CODEX_HOOK_MATCHER,
        command=setup_codex.CODEX_PLUGIN_HOOK_COMMAND,
    ) in config


def test_runtime_upgrade_apply_recheck_retires_stale_hook_trust_with_custom_home(tmp_path: Path) -> None:
    home = tmp_path / "home"
    setup_codex = _load_upgrade_module()._setup_codex_module()
    codex_config = home / ".codex" / "config.toml"
    copied_hooks = home / ".codex" / "hooks.json"
    codex_config.parent.mkdir(parents=True)
    hook_command = setup_codex.codex_validator_command(REPO_ROOT)
    copied_hooks.write_text(setup_codex.render_codex_hooks_config(hook_command), encoding="utf-8")
    codex_config.write_text(
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{REPO_ROOT}" }}\n'
        '\n'
        '[hooks.state]\n'
        f'"{copied_hooks}:pre_tool_use:0:0" = {{ trusted_hash = "abc", enabled = true }}\n'
        f'"{copied_hooks}:post_tool_use:0:0" = {{ trusted_hash = "def", enabled = true }}\n',
        encoding="utf-8",
    )

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
    )

    assert result.returncode == 0, result.stderr
    config = codex_config.read_text(encoding="utf-8")
    assert str(copied_hooks) not in config
    assert "agentera@agentera:hooks/codex-plugin-hooks.json:pre_tool_use:0:0" in config
    assert not copied_hooks.exists()


def test_runtime_upgrade_blocks_mixed_copied_hooks_when_plugin_enabled(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project = tmp_path / "project"
    setup_codex = _load_upgrade_module()._setup_codex_module()
    codex_config = home / ".codex" / "config.toml"
    copied_hooks = home / ".codex" / "hooks.json"
    project_hooks = project / ".codex" / "hooks.json"
    codex_config.parent.mkdir(parents=True)
    project_hooks.parent.mkdir(parents=True)
    codex_config.write_text(
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{REPO_ROOT}" }}\n',
        encoding="utf-8",
    )
    mixed = json.loads(setup_codex.render_codex_hooks_config(setup_codex.codex_validator_command(REPO_ROOT)))
    mixed["hooks"]["UserPromptSubmit"] = [{"hooks": [{"type": "command", "command": "echo user"}]}]
    copied_hooks.write_text(json.dumps(mixed, indent=2) + "\n", encoding="utf-8")
    project_hooks.write_text('{"project": true}\n', encoding="utf-8")

    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "codex",
        "--home",
        str(home),
        "--project",
        str(project),
        "--json",
    )

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    runtime_items = {(item["runtime"], item["action"]): item for item in payload["phases"][0]["items"]}
    retire = runtime_items[("codex", "retire-hooks")]
    assert retire["status"] == "blocked"
    assert retire["ownership"]["status"] == "user-owned"
    assert "review manually" in retire["message"]
    assert json.loads(copied_hooks.read_text(encoding="utf-8"))["hooks"]["UserPromptSubmit"]
    assert project_hooks.read_text(encoding="utf-8") == '{"project": true}\n'


def test_runtime_upgrade_keeps_copied_hooks_when_plugin_trust_config_is_blocked(tmp_path: Path) -> None:
    home = tmp_path / "home"
    setup_codex = _load_upgrade_module()._setup_codex_module()
    codex_config = home / ".codex" / "config.toml"
    copied_hooks = home / ".codex" / "hooks.json"
    codex_config.parent.mkdir(parents=True)
    codex_config.write_text(
        'features = { hooks = true }\n'
        '\n'
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{REPO_ROOT}" }}\n',
        encoding="utf-8",
    )
    original_hooks = setup_codex.render_codex_hooks_config(setup_codex.codex_validator_command(REPO_ROOT))
    copied_hooks.write_text(original_hooks, encoding="utf-8")

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
    )

    assert result.returncode == 1, result.stdout
    payload = json.loads(result.stdout)
    runtime_items = {(item["runtime"], item["action"]): item for item in payload["phases"][0]["items"]}
    assert runtime_items[("codex", "configure")]["status"] == "blocked"
    retire = runtime_items[("codex", "retire-hooks")]
    assert retire["status"] == "blocked"
    assert "Codex config trust was not applied" in retire["message"]
    assert copied_hooks.read_text(encoding="utf-8") == original_hooks


def test_runtime_upgrade_plan_characterizes_runtime_and_package_items(tmp_path: Path) -> None:
    home = tmp_path / "home"
    shell_rc = home / ".bashrc"
    shell_rc.parent.mkdir(parents=True)
    legacy_rc = (
        "# user setup\n"
        "# agentera: AGENTERA_HOME (managed)\n"
        "export AGENTERA_HOME=\"/old/agentera\"\n"
    )
    shell_rc.write_text(legacy_rc, encoding="utf-8")
    before_rc = shell_rc.read_bytes()
    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--only",
        "packages",
        "--runtime",
        "claude",
        "--runtime",
        "opencode",
        "--runtime",
        "copilot",
        "--runtime",
        "codex",
        "--home",
        str(home),
        "--json",
    )

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    runtime_phase = next(phase for phase in payload["phases"] if phase["name"] == "runtime")
    package_phase = next(phase for phase in payload["phases"] if phase["name"] == "packages")
    runtime_items = {(item["runtime"], item["action"]): item for item in runtime_phase["items"]}
    package_items = {(item["runtime"], item["action"]): item for item in package_phase["items"]}

    assert payload["mode"] == "plan"
    assert runtime_phase["status"] == "pending"
    assert runtime_items[("codex", "configure")]["target"] == str(home / ".codex/config.toml")
    assert runtime_items[("codex", "configure")]["status"] == "pending"
    assert runtime_items[("codex", "copy-hooks")]["target"] == str(home / ".codex/hooks.json")
    assert runtime_items[("codex", "copy-hooks")]["message"] == "will copy generated Agentera file"
    assert any(
        item["runtime"] == "codex" and item["action"] == "copy-agent" and item["target"].endswith("/realisera.toml")
        for item in runtime_phase["items"]
    )
    assert runtime_items[("copilot", "configure")] == {
        "status": "noop",
        "runtime": "copilot",
        "action": "configure",
        "target": None,
        "message": (
            "Copilot uses per-invocation AGENTERA_HOME; Agentera does not write "
            "shell startup files"
        ),
    }
    assert runtime_items[("opencode", "copy-plugin")]["target"] == str(home / ".config/opencode/plugins/agentera.js")
    assert any(
        item["runtime"] == "opencode" and item["action"] == "copy-agent" and item["target"].endswith("/realisera.md")
        for item in runtime_phase["items"]
    )
    assert runtime_items[("claude", "configure")] == {
        "status": "noop",
        "runtime": "claude",
        "action": "configure",
        "target": None,
        "message": "Claude Code plugin installs expose the app home without local config writes",
    }
    assert all("newText" not in item for item in runtime_phase["items"])
    assert shell_rc.read_bytes() == before_rc
    assert not (home / ".codex/config.toml").exists()
    assert not (home / ".codex/hooks.json").exists()
    assert package_phase["status"] == "skipped"
    assert package_items[("all", "remove-legacy-skills")]["status"] == "skipped"
    assert package_items[("claude", "install-agentera-skill")]["message"] == (
        "external package update skipped; pass --update-packages to run"
    )
    assert package_items[("opencode", "install-agentera-skill")]["status"] == "skipped"


def test_runtime_upgrade_apply_leaves_copilot_shell_startup_byte_identical(tmp_path: Path) -> None:
    home = tmp_path / "home"
    shell_rc = home / ".bashrc"
    shell_rc.parent.mkdir(parents=True)
    legacy_rc = (
        "# user setup\n"
        "export AGENTERA_HOME=\"/manual/agentera\"\n"
        "alias ll=\"ls -la\"\n"
    )
    shell_rc.write_text(legacy_rc, encoding="utf-8")
    before_rc = shell_rc.read_bytes()

    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "copilot",
        "--home",
        str(home),
        "--yes",
        "--json",
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    runtime_phase = next(phase for phase in payload["phases"] if phase["name"] == "runtime")
    copilot_item = runtime_phase["items"][0]
    assert copilot_item["status"] == "noop"
    assert "per-invocation AGENTERA_HOME" in copilot_item["message"]
    assert "newText" not in copilot_item
    assert shell_rc.read_bytes() == before_rc


def test_runtime_upgrade_planning_reads_runtime_targets_from_registry_fixture(tmp_path: Path, monkeypatch) -> None:
    upgrade = _load_upgrade_module()
    registry_module = upgrade._runtime_registry_module()
    registry_path = REPO_ROOT / "references" / "adapters" / "runtime-adapter-registry.yaml"
    fixture = yaml.safe_load(registry_path.read_text(encoding="utf-8"))
    fixture["records"][3]["config_targets"]["hook_targets"] = ["~/.codex/fixture-hooks.json"]
    registry = registry_module.RuntimeAdapterRegistry(tuple(fixture["records"]))
    monkeypatch.setattr(upgrade, "_runtime_registry", lambda: registry)

    phase = upgrade.plan_runtime_phase(
        REPO_ROOT,
        REPO_ROOT,
        tmp_path / "home",
        {"SHELL": "/bin/bash"},
        {"codex"},
        force=False,
    )

    copy_hooks = next(item for item in phase["items"] if item["action"] == "copy-hooks")
    assert copy_hooks["target"] == str(tmp_path / "home" / ".codex" / "fixture-hooks.json")


def test_runtime_upgrade_apply_characterizes_write_and_package_apply_messages(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "claude",
        "--runtime",
        "codex",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--yes",
        "--json",
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    runtime_items = {(item["runtime"], item["action"]): item for item in payload["phases"][0]["items"]}
    assert payload["mode"] == "apply"
    assert runtime_items[("codex", "configure")]["status"] == "applied"
    assert runtime_items[("codex", "configure")]["message"] == "runtime update applied"
    assert runtime_items[("codex", "copy-hooks")]["status"] == "applied"
    assert runtime_items[("codex", "copy-agent")]["status"] == "applied"
    assert runtime_items[("opencode", "copy-plugin")]["status"] == "applied"
    assert runtime_items[("opencode", "copy-agent")]["status"] == "applied"
    assert runtime_items[("claude", "configure")]["status"] == "noop"
    assert (home / ".codex/config.toml").is_file()
    assert (home / ".codex/hooks.json").is_file()
    assert (home / ".codex/agents/realisera.toml").is_file()
    assert (home / ".config/opencode/plugins/agentera.js").is_file()
    assert (home / ".config/opencode/agents/realisera.md").is_file()

    upgrade = _load_upgrade_module()

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(command, 0, stdout="package ok\n", stderr="")

    monkeypatch.setattr(upgrade.subprocess, "run", fake_run)
    package_phase = upgrade.plan_package_phase({"claude", "opencode"}, enabled=True)
    upgrade.apply_package_phase(package_phase)

    assert package_phase["status"] == "applied"
    assert {item["message"] for item in package_phase["items"]} == {"package update completed"}
    assert {item["status"] for item in package_phase["items"]} == {"applied"}


def test_whole_repair_preview_lists_managed_actions_skips_and_blocks(tmp_path: Path) -> None:
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    opencode_dir = home / ".config" / "opencode"
    shell_rc = home / ".bashrc"
    shell_rc.parent.mkdir(parents=True)
    shell_rc.write_text('export AGENTERA_HOME="/old/agentera"\n', encoding="utf-8")
    before_rc = shell_rc.read_bytes()
    _write_legacy_default_app_home(app_home / "app")

    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// Agentera plugin for OpenCode\nconst AGENTERA_VERSION = '0.0.1';\n", encoding="utf-8")
    commands = opencode_dir / "commands"
    commands.mkdir(parents=True)
    (commands / "hej.md").write_text(
        "---\nagentera_managed: true\n---\nLoad skill from skills/hej/SKILL.md\n",
        encoding="utf-8",
    )
    user_command = commands / "planera.md"
    user_command.write_text("Load skill from skills/planera/SKILL.md\n", encoding="utf-8")

    result = _run(
        "upgrade",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--json",
        env={"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")},
    )

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    phases = {phase["name"]: phase for phase in payload["phases"]}
    assert set(phases) == {"bundle", "artifacts", "runtime", "cleanup", "packages"}
    assert phases["bundle"]["items"][0]["action"] == "install-bundle"
    assert phases["bundle"]["items"][0]["status"] == "pending"
    runtime_items = {(item["runtime"], item["action"]): item for item in phases["runtime"]["items"]}
    assert runtime_items[("codex", "configure")]["status"] == "pending"
    assert runtime_items[("codex", "copy-hooks")]["status"] == "pending"
    assert runtime_items[("codex", "copy-agent")]["status"] == "pending"
    assert runtime_items[("opencode", "copy-plugin")]["status"] == "pending"
    assert runtime_items[("opencode", "copy-agent")]["status"] == "pending"
    assert runtime_items[("copilot", "configure")]["status"] == "noop"
    assert "per-invocation AGENTERA_HOME" in runtime_items[("copilot", "configure")]["message"]
    cleanup_by_path = {Path(item["path"]).name: item for item in phases["cleanup"]["items"]}
    assert cleanup_by_path["hej.md"]["status"] == "pending"
    assert cleanup_by_path["planera.md"]["status"] == "blocked"
    assert cleanup_by_path["planera.md"]["ownership"]["status"] == "user-owned"
    assert phases["packages"]["status"] == "skipped"
    assert all(item["status"] == "skipped" for item in phases["packages"]["items"])
    assert shell_rc.read_bytes() == before_rc
    assert user_command.read_text(encoding="utf-8") == "Load skill from skills/planera/SKILL.md\n"


def test_whole_repair_apply_after_clean_preview_applies_safe_actions_only(tmp_path: Path) -> None:
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    opencode_dir = home / ".config" / "opencode"
    shell_rc = home / ".bashrc"
    shell_rc.parent.mkdir(parents=True)
    shell_rc.write_text("# user shell startup\n", encoding="utf-8")
    before_rc = shell_rc.read_bytes()
    _write_legacy_default_app_home(app_home / "app")

    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// Agentera plugin for OpenCode\nconst AGENTERA_VERSION = '0.0.1';\n", encoding="utf-8")
    command = opencode_dir / "commands" / "hej.md"
    command.parent.mkdir(parents=True)
    command.write_text(
        "---\nagentera_managed: true\n---\nLoad skill from skills/hej/SKILL.md\n",
        encoding="utf-8",
    )
    args = [
        "upgrade",
        "--runtime",
        "codex",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--json",
    ]
    env = {"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")}
    preview = _run(*args, env=env)

    assert preview.returncode == 1, preview.stderr
    preview_payload = json.loads(preview.stdout)
    assert preview_payload["summary"]["blocked"] == 0
    assert preview_payload["summary"]["pending"] > 0
    assert shell_rc.read_bytes() == before_rc
    assert command.exists()

    apply = _run(*args, "--yes", env=env)

    assert apply.returncode == 0, apply.stderr
    payload = json.loads(apply.stdout)
    phases = {phase["name"]: phase for phase in payload["phases"]}
    assert payload["summary"]["blocked"] == 0
    assert phases["packages"]["status"] == "skipped"
    assert (app_home / "app" / "scripts" / "agentera").is_file()
    assert f'AGENTERA_HOME = "{app_home}"' in (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert (home / ".codex" / "hooks.json").is_file()
    assert (home / ".codex" / "agents" / "realisera.toml").is_file()
    assert plugin.read_text(encoding="utf-8") == (REPO_ROOT / ".opencode" / "plugins" / "agentera.js").read_text(
        encoding="utf-8"
    )
    assert (opencode_dir / "agents" / "realisera.md").is_file()
    assert not command.exists()
    assert shell_rc.read_bytes() == before_rc
    assert payload["postflight"]["ok"] is True
    assert payload["postflight"]["status"] == "up_to_date"
    text_apply = _run(*args[:-1], "--yes", env=env)
    assert text_apply.returncode == 0, text_apply.stderr
    assert "After-check: passed" in text_apply.stdout


def test_whole_repair_apply_succeeds_without_copilot_blocked(tmp_path: Path) -> None:
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    opencode_dir = home / ".config" / "opencode"
    shell_rc = home / ".bashrc"
    shell_rc.parent.mkdir(parents=True)
    shell_rc.write_text("# user shell startup\n", encoding="utf-8")
    before_rc = shell_rc.read_bytes()
    _write_legacy_default_app_home(app_home / "app")

    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// Agentera plugin for OpenCode\nconst AGENTERA_VERSION = '0.0.1';\n", encoding="utf-8")
    command = opencode_dir / "commands" / "hej.md"
    command.parent.mkdir(parents=True)
    command.write_text(
        "---\nagentera_managed: true\n---\nLoad skill from skills/hej/SKILL.md\n",
        encoding="utf-8",
    )
    env = {"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")}
    apply = _run(
        "upgrade",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--yes",
        env=env,
    )

    assert apply.returncode == 0, apply.stderr
    assert "After-check: passed" in apply.stdout
    assert "choose a safer Agentera directory" not in apply.stdout
    payload = json.loads(_run(
        "upgrade",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--json",
        env=env,
    ).stdout)
    runtime_items = {
        (item["runtime"], item["action"]): item
        for phase in payload["phases"]
        if phase["name"] == "runtime"
        for item in phase["items"]
    }
    assert runtime_items[("copilot", "configure")]["status"] == "noop"
    assert shell_rc.read_bytes() == before_rc


def test_upgrade_postflight_passes_on_platform_app_home(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    _write_legacy_default_app_home(app_home / "app")
    env = {"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")}

    outdated = upgrade._build_upgrade_postflight(
        install_root=app_home,
        home=home,
        project=REPO_ROOT,
        source_root=REPO_ROOT,
        env=env,
    )
    assert outdated["ok"] is False
    assert outdated["status"] in {"outdated", "repair_needed"}

    bundle_phase = upgrade.plan_bundle_phase(REPO_ROOT, app_home, home, force=False)
    upgrade.apply_bundle_phase(bundle_phase, REPO_ROOT, app_home, force=False)

    current = upgrade._build_upgrade_postflight(
        install_root=app_home,
        home=home,
        project=REPO_ROOT,
        source_root=REPO_ROOT,
        env=env,
    )
    assert current["ok"] is True
    assert current["status"] == "up_to_date"
    assert current["summary"] == "Agentera app files are up to date."


def test_upgrade_postflight_reports_outdated_signal(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    _write_legacy_default_app_home(app_home / "app")
    env = {"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")}

    postflight = upgrade._build_upgrade_postflight(
        install_root=app_home,
        home=home,
        project=REPO_ROOT,
        source_root=REPO_ROOT,
        env=env,
    )

    assert postflight["ok"] is False
    assert "After-check: needs attention" in upgrade._render_postflight_line(postflight)
    assert "update" in postflight["summary"].lower() or "version" in postflight["summary"].lower()


def test_runtime_apply_rechecks_stale_managed_surface_before_mutating(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    home = tmp_path / "home"
    opencode_dir = home / ".config" / "opencode"
    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// Agentera plugin for OpenCode\nconst AGENTERA_VERSION = '0.0.1';\n", encoding="utf-8")

    phase = upgrade.plan_runtime_phase(
        REPO_ROOT,
        REPO_ROOT,
        home,
        {"SHELL": "/bin/bash", "OPENCODE_CONFIG_DIR": str(opencode_dir)},
        {"opencode"},
        force=False,
    )
    assert phase["items"][0]["status"] == "pending"

    plugin.write_text("// custom user plugin\n", encoding="utf-8")
    upgrade.apply_runtime_phase(phase, REPO_ROOT, force=False)

    item = phase["items"][0]
    assert item["status"] == "blocked"
    assert item["ownership"] == {
        "status": "user-owned",
        "reason": "no Agentera ownership marker or runtime identity was found",
    }
    assert plugin.read_text(encoding="utf-8") == "// custom user plugin\n"


def test_package_phase_characterizes_skip_dry_run_and_mocked_apply(monkeypatch) -> None:
    upgrade = _load_upgrade_module()

    skipped = upgrade.plan_package_phase({"claude", "opencode", "codex", "copilot"}, enabled=False)
    skipped_items = {(item["runtime"], item["action"]): item for item in skipped["items"]}
    assert skipped["status"] == "skipped"
    assert skipped_items[("all", "remove-legacy-skills")]["status"] == "skipped"
    assert skipped_items[("all", "remove-legacy-skills")]["message"] == (
        "legacy skill removal skipped; pass --update-packages to run"
    )
    assert skipped_items[("claude", "install-agentera-skill")]["command"] == [
        "npx",
        "skills",
        "add",
        "jgabor/agentera",
        "-g",
        "-a",
        "claude-code",
        "--skill",
        "agentera",
        "-y",
    ]
    assert skipped_items[("opencode", "install-agentera-skill")]["command"] == [
        "npx",
        "skills",
        "add",
        "jgabor/agentera",
        "-g",
        "-a",
        "opencode",
        "--skill",
        "agentera",
        "-y",
    ]
    assert not any(item["runtime"] in {"codex", "copilot"} for item in skipped["items"])

    executed: list[list[str]] = []

    def fake_run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        executed.append(command)
        return subprocess.CompletedProcess(command, 0, stdout="line1\npackage ok\n", stderr="")

    monkeypatch.setattr(upgrade.subprocess, "run", fake_run)
    dry_run = upgrade.plan_package_phase({"claude", "opencode"}, enabled=True)
    assert dry_run["status"] == "pending"
    assert {item["message"] for item in dry_run["items"]} == {
        "will remove legacy v1 package-managed skill entries",
        "will run external package update",
    }
    assert executed == []

    upgrade.apply_package_phase(dry_run)
    assert len(executed) == 3
    assert dry_run["status"] == "applied"
    assert {item["status"] for item in dry_run["items"]} == {"applied"}
    assert {item["message"] for item in dry_run["items"]} == {"package update completed"}
    assert all(item["stdoutTail"] == ["line1", "package ok"] for item in dry_run["items"])


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
    assert payload["summary"]["applied"] == 29
    assert payload["summary"]["blocked"] == 1
    assert f'AGENTERA_HOME = "{REPO_ROOT}"' in (home / ".codex" / "config.toml").read_text(
        encoding="utf-8"
    )
    assert plugin.read_text(encoding="utf-8") == "// user-owned plugin\n"
    assert (opencode_dir / "commands" / "agentera.md").is_file()
    assert (opencode_dir / "skills" / "agentera" / "SKILL.md").is_file()


def test_runtime_preview_refreshes_stale_surface_with_agentera_ownership_reason(tmp_path: Path) -> None:
    home = tmp_path / "home"
    opencode_dir = home / ".config" / "opencode"
    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// Agentera plugin for OpenCode\nconst AGENTERA_VERSION = '0.0.1';\n", encoding="utf-8")

    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--json",
    )

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    item = payload["phases"][0]["items"][0]
    assert item["status"] == "pending"
    assert item["action"] == "copy-plugin"
    assert item["message"] == "will update stale Agentera-managed runtime surface"
    assert item["ownership"] == {
        "status": "agentera-owned",
        "reason": "OpenCode plugin contains the Agentera plugin identity",
    }
    assert plugin.read_text(encoding="utf-8") == "// Agentera plugin for OpenCode\nconst AGENTERA_VERSION = '0.0.1';\n"


def test_runtime_preview_blocks_stale_surface_without_agentera_ownership_proof(tmp_path: Path) -> None:
    home = tmp_path / "home"
    opencode_dir = home / ".config" / "opencode"
    plugin = opencode_dir / "plugins" / "agentera.js"
    plugin.parent.mkdir(parents=True)
    plugin.write_text("// custom user plugin\n", encoding="utf-8")

    result = _run(
        "upgrade",
        "--only",
        "runtime",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--json",
    )

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    item = payload["phases"][0]["items"][0]
    assert item["status"] == "blocked"
    assert item["message"] == "target exists without Agentera ownership proof; treating it as user-owned"
    assert item["ownership"] == {
        "status": "user-owned",
        "reason": "no Agentera ownership marker or runtime identity was found",
    }
    assert plugin.read_text(encoding="utf-8") == "// custom user plugin\n"


def test_runtime_apply_refreshes_opencode_managed_commands_and_skill_links(tmp_path: Path) -> None:
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    opencode_dir = home / ".config" / "opencode"
    commands = opencode_dir / "commands"
    skills = opencode_dir / "skills"
    commands.mkdir(parents=True)
    skills.mkdir(parents=True)

    stale_command = commands / "agentera.md"
    stale_command.write_text(
        "---\nagentera_managed: true\n---\nLoad skill from old agentera path\n",
        encoding="utf-8",
    )
    user_command = commands / "hej.md"
    user_command.write_text("custom /hej command\n", encoding="utf-8")
    broken_target = home / "old" / "agentera" / "skills" / "agentera"
    (skills / "agentera").symlink_to(broken_target, target_is_directory=True)
    user_skill = skills / "hej"
    user_skill.mkdir()
    (user_skill / "SKILL.md").write_text("# custom hej\n", encoding="utf-8")

    result = _run(
        "upgrade",
        "--only",
        "bundle",
        "--only",
        "runtime",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--yes",
        "--json",
        env={"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")},
    )

    assert result.returncode == 0, result.stdout
    payload = json.loads(result.stdout)
    runtime_items = {(item["action"], item.get("target")): item for item in payload["phases"][1]["items"]}
    assert runtime_items[("copy-command", str(stale_command))]["status"] == "applied"
    assert not any(
        item.get("action") == "copy-command" and item.get("target") == str(user_command)
        for item in payload["phases"][1]["items"]
    )
    assert runtime_items[("link-skill", str(skills / "agentera"))]["status"] == "applied"
    assert runtime_items[("link-skill", str(user_skill))]["status"] == "noop"
    assert stale_command.read_text(encoding="utf-8") == (app_home / "app" / ".opencode" / "commands" / "agentera.md").read_text(
        encoding="utf-8"
    )
    assert user_command.read_text(encoding="utf-8") == "custom /hej command\n"
    assert (skills / "agentera").resolve() == app_home / "app" / "skills" / "agentera"
    assert (user_skill / "SKILL.md").read_text(encoding="utf-8") == "# custom hej\n"


def test_runtime_apply_refreshes_resolving_stale_opencode_managed_skill_link(tmp_path: Path) -> None:
    home = tmp_path / "home"
    app_home = home / ".local" / "share" / "agentera"
    opencode_dir = home / ".config" / "opencode"
    skills = opencode_dir / "skills"
    skills.mkdir(parents=True)

    old_skill = home / "old" / "agentera" / "skills" / "agentera"
    old_skill.mkdir(parents=True)
    (old_skill / "SKILL.md").write_text("# old agentera\n", encoding="utf-8")
    skill_link = skills / "agentera"
    skill_link.symlink_to(old_skill, target_is_directory=True)

    result = _run(
        "upgrade",
        "--only",
        "bundle",
        "--only",
        "runtime",
        "--runtime",
        "opencode",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--yes",
        "--json",
        env={"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")},
    )

    assert result.returncode == 0, result.stdout
    payload = json.loads(result.stdout)
    runtime_items = {(item["action"], item.get("target")): item for item in payload["phases"][1]["items"]}
    assert runtime_items[("link-skill", str(skill_link))]["status"] == "applied"
    assert runtime_items[("link-skill", str(skill_link))]["ownership"] == {
        "status": "agentera-owned",
        "reason": "OpenCode skill symlink target contains Agentera identity",
    }
    assert skill_link.resolve() == app_home / "app" / "skills" / "agentera"


def test_bundle_rel_paths_reads_directories_from_package_registry(monkeypatch) -> None:
    upgrade = _load_upgrade_module()
    pkg_module = upgrade._package_registry_module()
    fixture = yaml.safe_load(
        (REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8")
    )
    fixture["records"][0]["bundle_surfaces"]["directories"] = [
        {"id": "skills", "path": "skills"},
    ]
    fixture["records"][0]["bundle_surfaces"]["files"] = [
        {"id": "registry", "path": "registry.json"},
    ]
    registry = pkg_module.PackageRegistry(tuple(fixture["records"]))
    monkeypatch.setattr(upgrade, "_package_registry", lambda: registry)

    paths = upgrade._bundle_rel_paths(REPO_ROOT)

    assert all(str(p).startswith("skills/") or str(p) == "registry.json" for p in paths)
    assert not any(str(p).startswith("scripts/") for p in paths)
    assert not any(str(p).startswith("hooks/") for p in paths)


def test_package_phase_reads_commands_from_package_registry(monkeypatch) -> None:
    upgrade = _load_upgrade_module()
    pkg_module = upgrade._package_registry_module()
    fixture = yaml.safe_load(
        (REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8")
    )
    fixture["records"][0]["package_commands"]["commands"][0]["argv"] = [
        "npx", "skills", "remove", "custom-legacy-skill", "-g", "-y",
    ]
    fixture["records"][0]["package_commands"]["commands"][1]["argv"] = [
        "npx", "skills", "add", "jgabor/agentera", "-g", "-a",
        "claude-code", "--skill", "agentera", "-y",
    ]
    fixture["records"][0]["package_commands"]["commands"][2]["argv"] = [
        "npx", "skills", "add", "jgabor/agentera", "-g", "-a",
        "opencode", "--skill", "agentera-canary", "-y",
    ]
    registry = pkg_module.PackageRegistry(tuple(fixture["records"]))
    monkeypatch.setattr(upgrade, "_package_registry", lambda: registry)

    phase = upgrade.plan_package_phase({"claude", "opencode"}, enabled=False)
    items = {(item["runtime"], item["action"]): item for item in phase["items"]}

    assert items[("all", "remove-legacy-skills")]["command"] == [
        "npx", "skills", "remove", "custom-legacy-skill", "-g", "-y",
    ]
    assert items[("opencode", "install-agentera-skill")]["command"] == [
        "npx", "skills", "add", "jgabor/agentera", "-g", "-a",
        "opencode", "--skill", "agentera-canary", "-y",
    ]


def test_load_suite_version_reads_authority_from_package_registry(tmp_path: Path, monkeypatch) -> None:
    upgrade = _load_upgrade_module()
    pkg_module = upgrade._package_registry_module()

    (tmp_path / "custom-version.json").write_text(
        json.dumps({"skills": [{"version": "9.9.9"}]}),
        encoding="utf-8",
    )

    fixture = yaml.safe_load(
        (REPO_ROOT / "references/adapters/package-registry.yaml").read_text(encoding="utf-8")
    )
    fixture["records"][0]["version_authority"]["persisted_authority"] = "custom-version.json"

    registry = pkg_module.PackageRegistry(tuple(fixture["records"]), root=tmp_path)
    monkeypatch.setattr(upgrade, "_package_registry", lambda: registry)

    version = upgrade._load_suite_version(tmp_path)
    assert version == "9.9.9"


def test_cleanup_upgrade_removes_fixable_v1_artifacts_and_reports_codex(tmp_path: Path) -> None:
    home = tmp_path / "home"
    skills = home / ".agents" / "skills"
    skills.mkdir(parents=True)
    (skills / "hej").symlink_to(home / "missing" / "skills" / "hej")

    opencode_dir = home / ".config" / "opencode"
    commands = opencode_dir / "commands"
    commands.mkdir(parents=True)
    command = commands / "hej.md"
    command.write_text("---\nagentera_managed: true\n---\nLoad skill from skills/hej/SKILL.md\n", encoding="utf-8")

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


def test_cleanup_preview_reports_unproven_stale_command_as_user_owned(tmp_path: Path) -> None:
    home = tmp_path / "home"
    opencode_dir = home / ".config" / "opencode"
    commands = opencode_dir / "commands"
    commands.mkdir(parents=True)
    command = commands / "hej.md"
    command.write_text("Load skill from skills/hej/SKILL.md\n", encoding="utf-8")

    result = _run(
        "upgrade",
        "--only",
        "cleanup",
        "--home",
        str(home),
        "--opencode-config-dir",
        str(opencode_dir),
        "--json",
    )

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    item = payload["phases"][0]["items"][0]
    assert item["status"] == "blocked"
    assert item["ownership"] == {
        "status": "user-owned",
        "reason": "OpenCode command lacks agentera_managed: true frontmatter",
    }
    assert "user-owned" in item["message"]
    assert command.read_text(encoding="utf-8") == "Load skill from skills/hej/SKILL.md\n"
