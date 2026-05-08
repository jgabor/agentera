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
VOCABULARY_MD = REPO_ROOT / "docs" / "vocabulary.md"
DIRECT_SLASH_CAPABILITIES = {
    "visionera",
    "resonera",
    "inspirera",
    "planera",
    "realisera",
    "optimera",
    "inspektera",
    "dokumentera",
    "profilera",
    "visualisera",
    "orkestrera",
}


def _command_choices(help_text: str) -> set[str]:
    match = re.search(r"\{([^}]+)\}", help_text, re.DOTALL)
    assert match is not None, help_text
    return {choice.strip() for choice in match.group(1).replace("\n", "").split(",")}


def test_direct_capability_routes_use_state_commands_not_capability_cli_names() -> None:
    content = SKILL_MD.read_text(encoding="utf-8")
    normalized = " ".join(content.split())
    plain = normalized.replace("`", "")

    assert "run the top-level command or commands named by that capability" not in content
    assert "do not assume the route word is a CLI command" in normalized
    assert "The CLI command surface is state-oriented, not capability-oriented" in normalized
    assert "resonera reads decisions through agentera decisions" in plain
    assert "Never run unsupported capability-name commands" in normalized


def test_master_skill_defines_capability_handoff_contract() -> None:
    content = SKILL_MD.read_text(encoding="utf-8")
    normalized = " ".join(content.split())

    assert "Capability handoffs use glyph plus canonical capability name" in normalized
    assert "Reserve `/agentera <alias>` wording" in normalized
    assert "AskUserQuestion" in content
    assert "ask_user" in content
    assert "request_user_input" in content
    assert "`question`" in content
    assert "first Agentera/hej response" in normalized
    assert "free-form continuation prompt" in normalized
    assert "at least two meaningful non-terminal next actions" in normalized
    assert "do not count `Done` or free-form/custom answer affordances" in normalized
    assert "recommended choice first" in normalized
    assert "Selecting a downstream capability option is confirmation" in normalized
    assert "selecting `Done` stops without routing" in normalized


def test_master_skill_routes_bare_hej_to_dashboard_path() -> None:
    content = SKILL_MD.read_text(encoding="utf-8")
    normalized = " ".join(content.split())

    assert "bare user message exactly `hej`" in normalized
    assert "run `agentera hej` first" in normalized
    assert "must not be handled as a generic greeting" in normalized


def test_vocabulary_documents_handoff_and_route_boundary() -> None:
    content = VOCABULARY_MD.read_text(encoding="utf-8")

    assert "Capability handoff label" in content
    assert "glyph plus canonical name" in content
    assert "Explicit route documentation" in content
    assert "Runtime question tool" in content
    assert "Question-tool gating" in content
    assert "Initial Agentera/hej briefs stay free-form" in content
    assert "Handoff confirmation" in content
    assert "not schema authority" in content


def test_capability_prose_uses_slashless_handoff_labels() -> None:
    pattern = re.compile(
        r"(?<![\w./-])/(" + "|".join(sorted(DIRECT_SLASH_CAPABILITIES)) + r")\b"
    )
    violations: list[str] = []

    for prose_path in sorted(CAPABILITIES_DIR.glob("*/prose.md")):
        relative_path = prose_path.relative_to(REPO_ROOT).as_posix()
        for line_number, line in enumerate(
            prose_path.read_text(encoding="utf-8").splitlines(), 1
        ):
            if match := pattern.search(line):
                violations.append(
                    f"{relative_path}:{line_number}: use glyph/name handoff or `/agentera <alias>` route docs for {match.group(0)!r}: {line.strip()}"
                )

    assert violations == []


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
