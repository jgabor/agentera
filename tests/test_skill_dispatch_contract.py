"""Regression tests for Agentera skill routing guidance."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_MD = REPO_ROOT / "skills" / "agentera" / "SKILL.md"
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
HEJ_PROSE = CAPABILITIES_DIR / "hej" / "instructions.md"
ORK_PROSE = CAPABILITIES_DIR / "orkestrera" / "instructions.md"
PLANERA_PROSE = CAPABILITIES_DIR / "planera" / "instructions.md"
REALISERA_PROSE = CAPABILITIES_DIR / "realisera" / "instructions.md"
CLI = REPO_ROOT / "scripts" / "agentera"
VOCABULARY_MD = REPO_ROOT / "references" / "cli" / "vocabulary.md"
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
    assert "state-changing Proceed/Cancel handoff" in normalized
    assert "State-changing means the proposed next step may write artifacts" in normalized
    assert "state-changing capability handoffs are consequential Proceed/Cancel decisions" in normalized
    assert "Do not count `Done` or free-form/custom answer affordances" in normalized
    assert "recommended choice first" in normalized
    assert "Selecting a downstream capability option is confirmation" in normalized
    assert "selecting `Done` stops without routing" in normalized
    assert "This generic question-tool gating applies to hej and capability handoff prompts" in normalized
    assert "capability's own interaction rules control" in normalized
    assert "SG priority codes such as `SG2` are internal protocol references" in normalized
    assert "`route`: the user directly invoked a capability" in normalized
    assert "This is consent to invoke that capability" in normalized
    assert "`suggest`: recommend a downstream capability and wait for user confirmation" in normalized
    assert "A single non-mutating suggestion may use a free-form prompt" in normalized
    assert "clear replies such as `yes`, `start`, `do it`, or `run <capability>` confirm" in normalized
    assert "Ambiguous replies get one clarifying question" in normalized
    assert "`dispatch`: invoke another capability autonomously only when" in normalized
    assert "`chain`: dispatch multiple capabilities autonomously only inside" in normalized
    assert "`route`: the user directly invoked a capability" in normalized


def test_master_skill_routes_bare_hej_to_dashboard_path() -> None:
    content = SKILL_MD.read_text(encoding="utf-8")
    normalized = " ".join(content.split())

    assert "complete user message exactly `hej`" in normalized
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
    assert "a single state-changing handoff uses native Proceed/Cancel confirmation" in content
    assert "A single non-mutating suggested handoff may use a free-form prompt" in content
    assert "invoked capability prose can impose stricter question-tool requirements" in content
    assert "Handoff confirmation" in content
    assert "Direct user invocation by canonical capability name" in content
    assert "Recommend a downstream capability and wait for confirmation" in content
    assert "Delegate" in content
    assert "Orkestrera assigns approved plan work" in content
    assert "Spawn" in content
    assert "launches an isolated runtime worker" in content
    assert "Subagent mechanism" in content
    assert "Runtime support for worker execution" in content
    assert "not schema authority" in content


def test_hej_handoff_guidance_hides_internal_sg_codes() -> None:
    content = HEJ_PROSE.read_text(encoding="utf-8")
    normalized = " ".join(content.split())

    assert "SG codes are internal protocol references; never render them" in normalized
    assert "suggest ⎈ orkestrera" in content
    assert "suggest ⧉ realisera" in content
    assert "suggest ❈ resonera" in content
    assert "suggest ≡ planera" in content
    assert "suggest ⎈ (SG" not in content
    assert "suggest ⧉ (SG" not in content
    assert "State-changing handoffs are consequential Proceed/Cancel decisions" in normalized
    assert "For one non-mutating suggested action, clear free-form acceptance" in normalized
    assert "Ambiguous replies get one clarifying question" in normalized


def test_capability_prose_distinguishes_handoff_verbs() -> None:
    planera = " ".join(PLANERA_PROSE.read_text(encoding="utf-8").split())
    realisera = " ".join(REALISERA_PROSE.read_text(encoding="utf-8").split())
    orkestrera = " ".join(ORK_PROSE.read_text(encoding="utf-8").split())

    assert "Suggest ⧉ realisera and wait for confirmation" in planera
    assert "suggest ⧉ realisera to execute and wait for confirmation" in planera
    assert "suggest ⎈ orkestrera to execute the entire plan and wait for confirmation" in planera
    assert "suggest ⎘ optimera for measurable metrics and wait for confirmation" in realisera
    assert "wait for confirmation before invoking it" in realisera
    assert "instead of silently delegating to resonera" in realisera
    assert "In orkestrera only, `dispatch` and `chain` are autonomous" in orkestrera
    assert "if the loop says `suggest`, wait for user confirmation" in orkestrera


def test_capability_prose_uses_slashless_handoff_labels() -> None:
    pattern = re.compile(
        r"(?<![\w./-])/(" + "|".join(sorted(DIRECT_SLASH_CAPABILITIES)) + r")\b"
    )
    violations: list[str] = []

    for prose_path in sorted(CAPABILITIES_DIR.glob("*/instructions.md")):
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
    assert non_hej_capabilities <= choices
    assert {"plan", "progress", "todo"}.issubset(choices)
