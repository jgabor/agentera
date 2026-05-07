"""Regression tests for Agentera skill dispatch guidance."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_MD = REPO_ROOT / "skills" / "agentera" / "SKILL.md"
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
CLI = REPO_ROOT / "scripts" / "agentera"


def _command_choices(help_text: str) -> set[str]:
    match = re.search(r"\{([^}]+)\}", help_text, re.DOTALL)
    assert match is not None, help_text
    return {choice.strip() for choice in match.group(1).replace("\n", "").split(",")}


def test_direct_capability_routes_use_state_commands_not_capability_cli_names() -> None:
    content = SKILL_MD.read_text(encoding="utf-8")
    normalized = " ".join(content.split())
    plain = normalized.replace("`", "")

    assert "run the top-level command or commands named by that capability" not in content
    assert "do not assume the capability name is a CLI command" in normalized
    assert "The CLI command surface is state-oriented, not capability-oriented" in normalized
    assert "resonera reads decisions through agentera decisions" in plain
    assert "Never run unsupported capability-name commands" in normalized


def test_non_hej_capabilities_are_not_cli_state_commands() -> None:
    result = subprocess.run(
        [sys.executable, str(CLI), "--help"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    choices = _command_choices(result.stdout)

    assert {
        "hej",
        "decisions",
        "health",
        "todo",
        "plan",
        "progress",
        "docs",
        "objective",
        "experiments",
    } <= choices

    non_hej_capabilities = {
        path.name for path in CAPABILITIES_DIR.iterdir() if path.is_dir()
    } - {"hej"}
    assert non_hej_capabilities.isdisjoint(choices)
