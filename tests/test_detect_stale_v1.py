"""Tests for scripts/detect_stale_v1.

Proportionality: 1 pass + 1 fail per runtime surface (Claude skills,
OpenCode commands, Codex config), plus cross-cutting gates for
--dry-run and --fix behavior.
"""

from __future__ import annotations

import os
import sys
import tomllib
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "detect_stale_v1"


def _load_detect_stale_v1() -> ModuleType:
    src = SCRIPT_PATH.read_text(encoding="utf-8")
    lines = src.splitlines(keepends=True)
    start = 0
    for i, line in enumerate(lines):
        if line.startswith("from __future__"):
            start = i
            break
    code = "".join(lines[start:])
    code = code.split("if __name__")[0]
    mod = ModuleType("detect_stale_v1")
    sys.modules["detect_stale_v1"] = mod
    exec(compile(code, str(SCRIPT_PATH), "exec"), mod.__dict__)
    return mod


@pytest.fixture(scope="module")
def detect():
    return _load_detect_stale_v1()


@pytest.fixture()
def fake_home(tmp_path):
    return tmp_path


def _make_env(fake_home: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["HOME"] = str(fake_home)
    env["OPENCODE_CONFIG_DIR"] = str(fake_home / ".config" / "opencode")
    return env


def _create_dead_symlink(fake_home: Path, skill_name: str) -> Path:
    skills_dir = fake_home / ".agents" / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    link = skills_dir / skill_name
    target = fake_home / "nonexistent" / "skills" / skill_name
    link.symlink_to(target)
    return link


def _create_stale_command(fake_home: Path, name: str, content: str | None = None) -> Path:
    env = _make_env(fake_home)
    commands_dir = Path(env["OPENCODE_CONFIG_DIR"]) / "commands"
    commands_dir.mkdir(parents=True, exist_ok=True)
    cmd_file = commands_dir / f"{name}.md"
    if content is None:
        content = (
            "---\n"
            "description: \"Load and execute the hej skill\"\n"
            "---\n"
            "Load skill from skills/hej/SKILL.md for this project.\n"
        )
    cmd_file.write_text(content, encoding="utf-8")
    return cmd_file


def _create_codex_agent_entry(
    fake_home: Path,
    skill_name: str,
    config_file_path: str | None = None,
) -> Path:
    config_path = fake_home / ".codex" / "config.toml"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    if config_file_path is None:
        config_file_path = str(
            fake_home / "old-agentera" / "skills" / skill_name / "agents" / f"{skill_name}.toml"
        )

    lines: list[str] = []
    if config_path.exists():
        lines.append(config_path.read_text(encoding="utf-8").rstrip())
    else:
        lines.append("[shell_environment_policy]")
        lines.append('set = { AGENTERA_HOME = "/some/path" }')

    lines.append("")
    lines.append(f"[agents.{skill_name}]")
    lines.append(f'description = "v1 skill {skill_name}"')
    lines.append(f'config_file = "{config_file_path}"')
    lines.append("")

    config_path.write_text("\n".join(lines), encoding="utf-8")
    return config_path


# ── Claude skills: dead symlinks ───────────────────────────────────────


class TestClaudeSkills:
    def test_pass_no_dead_symlinks(self, detect, fake_home):
        skills_dir = fake_home / ".agents" / "skills"
        skills_dir.mkdir(parents=True)
        (skills_dir / "hej").mkdir()
        (skills_dir / "hej" / "SKILL.md").write_text("# hej", encoding="utf-8")

        findings = detect.detect_claude_dead_symlinks(
            fake_home, _make_env(fake_home)
        )
        assert findings == []

    def test_fail_dead_symlink_detected(self, detect, fake_home):
        _create_dead_symlink(fake_home, "hej")
        _create_dead_symlink(fake_home, "realisera")

        findings = detect.detect_claude_dead_symlinks(
            fake_home, _make_env(fake_home)
        )
        assert len(findings) == 2
        assert all(f.surface == "claude" for f in findings)
        assert all(f.kind == "dead_symlink" for f in findings)
        names = {Path(f.path).name for f in findings}
        assert names == {"hej", "realisera"}

    def test_non_symlink_directory_ignored(self, detect, fake_home):
        skills_dir = fake_home / ".agents" / "skills"
        skills_dir.mkdir(parents=True)
        (skills_dir / "hej").mkdir()

        findings = detect.detect_claude_dead_symlinks(
            fake_home, _make_env(fake_home)
        )
        assert findings == []

    def test_valid_symlink_not_reported(self, detect, fake_home):
        skills_dir = fake_home / ".agents" / "skills"
        skills_dir.mkdir(parents=True)
        target = fake_home / "valid-target" / "hej"
        target.mkdir(parents=True)
        (target / "SKILL.md").write_text("# hej", encoding="utf-8")
        link = skills_dir / "hej"
        link.symlink_to(target)

        findings = detect.detect_claude_dead_symlinks(
            fake_home, _make_env(fake_home)
        )
        assert findings == []


# ── OpenCode commands: stale command files ─────────────────────────────


class TestOpenCodeCommands:
    def test_pass_no_stale_commands(self, detect, fake_home):
        env = _make_env(fake_home)
        commands_dir = Path(env["OPENCODE_CONFIG_DIR"]) / "commands"
        commands_dir.mkdir(parents=True)
        (commands_dir / "hej.md").write_text(
            "---\ndescription: \"A user command\"\n---\nNo v1 references.\n",
            encoding="utf-8",
        )

        findings = detect.detect_opencode_stale_commands(
            fake_home, env
        )
        assert findings == []

    def test_fail_stale_command_detected(self, detect, fake_home):
        _create_stale_command(fake_home, "hej")

        findings = detect.detect_opencode_stale_commands(
            fake_home, _make_env(fake_home)
        )
        assert len(findings) == 1
        assert findings[0].surface == "opencode"
        assert findings[0].kind == "stale_command"
        assert "hej.md" in findings[0].path

    def test_fail_managed_v1_command_detected_without_path_reference(self, detect, fake_home):
        env = _make_env(fake_home)
        commands_dir = Path(env["OPENCODE_CONFIG_DIR"]) / "commands"
        commands_dir.mkdir(parents=True)
        (commands_dir / "planera.md").write_text(
            "---\n"
            "description: \"Scale-adaptive planning with acceptance criteria\"\n"
            "agentera_managed: true\n"
            "---\n"
            "Load and execute the planera skill for this project.\n",
            encoding="utf-8",
        )

        findings = detect.detect_opencode_stale_commands(fake_home, env)

        assert len(findings) == 1
        assert findings[0].kind == "stale_command"
        assert "managed command targets removed v1 skill 'planera'" in findings[0].detail

    def test_multiple_stale_commands(self, detect, fake_home):
        _create_stale_command(fake_home, "hej")
        _create_stale_command(
            fake_home,
            "planera",
            "---\ndescription: \"Plan\"\n---\nLoad from .agents/skills/planera/SKILL.md\n",
        )

        findings = detect.detect_opencode_stale_commands(
            fake_home, _make_env(fake_home)
        )
        assert len(findings) == 2
        names = {Path(f.path).name for f in findings}
        assert names == {"hej.md", "planera.md"}

    def test_non_md_files_ignored(self, detect, fake_home):
        env = _make_env(fake_home)
        commands_dir = Path(env["OPENCODE_CONFIG_DIR"]) / "commands"
        commands_dir.mkdir(parents=True)
        (commands_dir / "hej.json").write_text(
            '{"skill": "skills/hej/SKILL.md"}', encoding="utf-8"
        )

        findings = detect.detect_opencode_stale_commands(
            fake_home, env
        )
        assert findings == []

    def test_commands_dir_absent_no_error(self, detect, fake_home):
        findings = detect.detect_opencode_stale_commands(
            fake_home, _make_env(fake_home)
        )
        assert findings == []


# ── Codex config: stale agent entries ──────────────────────────────────


class TestCodexConfig:
    def test_pass_no_stale_agents(self, detect, fake_home):
        config_path = fake_home / ".codex" / "config.toml"
        config_path.parent.mkdir(parents=True)
        config_path.write_text(
            "[shell_environment_policy]\nset = { AGENTERA_HOME = \"/valid\" }\n",
            encoding="utf-8",
        )

        findings = detect.detect_codex_stale_agents(
            fake_home, _make_env(fake_home)
        )
        assert findings == []

    def test_fail_stale_agent_detected(self, detect, fake_home):
        _create_codex_agent_entry(fake_home, "hej")

        findings = detect.detect_codex_stale_agents(
            fake_home, _make_env(fake_home)
        )
        assert len(findings) == 1
        assert findings[0].surface == "codex"
        assert findings[0].kind == "stale_agent"
        assert "agents.hej" in findings[0].detail

    def test_multiple_stale_agents(self, detect, fake_home):
        _create_codex_agent_entry(fake_home, "hej")
        _create_codex_agent_entry(fake_home, "realisera")

        findings = detect.detect_codex_stale_agents(
            fake_home, _make_env(fake_home)
        )
        assert len(findings) == 2
        details = " ".join(f.detail for f in findings)
        assert "agents.hej" in details
        assert "agents.realisera" in details

    def test_valid_agent_not_reported(self, detect, fake_home):
        valid_path = fake_home / "valid-agentera" / "skills" / "hej" / "agents" / "hej.toml"
        valid_path.parent.mkdir(parents=True)
        valid_path.write_text("description = 'hej'", encoding="utf-8")
        _create_codex_agent_entry(
            fake_home, "hej", config_file_path=str(valid_path)
        )

        findings = detect.detect_codex_stale_agents(
            fake_home, _make_env(fake_home)
        )
        assert findings == []

    def test_config_absent_no_error(self, detect, fake_home):
        findings = detect.detect_codex_stale_agents(
            fake_home, _make_env(fake_home)
        )
        assert findings == []

    def test_invalid_toml_no_error(self, detect, fake_home):
        config_path = fake_home / ".codex" / "config.toml"
        config_path.parent.mkdir(parents=True)
        config_path.write_text("this is not [valid toml {{{{", encoding="utf-8")

        findings = detect.detect_codex_stale_agents(
            fake_home, _make_env(fake_home)
        )
        assert findings == []


# ── Cross-cutting: run_detection ───────────────────────────────────────


class TestRunDetection:
    def test_clean_home_no_findings(self, detect, fake_home):
        env = _make_env(fake_home)
        findings = detect.run_detection(home=fake_home, env=env)
        assert findings == []

    def test_all_surfaces_reported(self, detect, fake_home):
        env = _make_env(fake_home)
        _create_dead_symlink(fake_home, "hej")
        _create_stale_command(fake_home, "planera")
        _create_codex_agent_entry(fake_home, "realisera")

        findings = detect.run_detection(home=fake_home, env=env)
        surfaces = {f.surface for f in findings}
        assert surfaces == {"claude", "opencode", "codex"}
        assert len(findings) == 3


# ── Cross-cutting: --dry-run and --fix ─────────────────────────────────


class TestDryRun:
    def test_dry_run_reports_but_does_not_remove(self, detect, fake_home, capsys):
        link = _create_dead_symlink(fake_home, "hej")
        cmd = _create_stale_command(fake_home, "hej")

        env = _make_env(fake_home)
        rc = detect.main(["--home", str(fake_home)])

        assert rc == 1
        assert link.exists() or link.is_symlink()
        assert cmd.exists()
        output = capsys.readouterr().out
        assert "stale v1 artifact" in output

    def test_dry_run_clean_exits_zero(self, detect, fake_home, capsys):
        rc = detect.main(["--home", str(fake_home)])
        assert rc == 0
        output = capsys.readouterr().out
        assert "no stale v1 artifacts found" in output


class TestFix:
    def test_fix_removes_dead_symlinks(self, detect, fake_home, capsys):
        link = _create_dead_symlink(fake_home, "hej")
        assert link.is_symlink()

        rc = detect.main(["--fix", "--home", str(fake_home)])
        assert rc == 0
        assert not link.is_symlink()
        output = capsys.readouterr().out
        assert "removed" in output

    def test_fix_removes_stale_commands(self, detect, fake_home, capsys):
        cmd = _create_stale_command(fake_home, "hej")
        assert cmd.exists()

        rc = detect.main(["--fix", "--home", str(fake_home)])
        assert rc == 0
        assert not cmd.exists()

    def test_fix_does_not_remove_codex_entries(self, detect, fake_home, capsys):
        config_path = _create_codex_agent_entry(fake_home, "hej")

        rc = detect.main(["--fix", "--home", str(fake_home)])
        assert rc == 0

        after = config_path.read_text(encoding="utf-8")
        assert "[agents.hej]" in after
        output = capsys.readouterr().out
        assert "skipped" in output or "manual" in output

    def test_fix_all_surfaces(self, detect, fake_home, capsys):
        link = _create_dead_symlink(fake_home, "hej")
        cmd = _create_stale_command(fake_home, "planera")
        _create_codex_agent_entry(fake_home, "realisera")

        rc = detect.main(["--fix", "--home", str(fake_home)])
        assert rc == 0

        assert not link.is_symlink()
        assert not cmd.exists()
        output = capsys.readouterr().out
        assert "manual" in output


# ── Rendering ──────────────────────────────────────────────────────────


class TestRenderFindings:
    def test_empty_findings_message(self, detect):
        result = detect.render_findings([])
        assert "no stale v1 artifacts found" in result

    def test_findings_grouped_by_surface(self, detect):
        findings = [
            detect.Finding("claude", "dead_symlink", "/path/hej", "broken"),
            detect.Finding("opencode", "stale_command", "/path/hej.md", "stale"),
            detect.Finding("codex", "stale_agent", "/path/config.toml", "old"),
        ]
        result = detect.render_findings(findings)
        assert "claude:" in result
        assert "opencode:" in result
        assert "codex:" in result
        assert "found 3 stale v1 artifact(s)" in result
