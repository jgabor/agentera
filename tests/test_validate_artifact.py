"""Tests for hooks/validate_artifact.py PostToolUse validation hook.

Proportionality: Decision 21. One pass + one fail per validation check.
Artifact type routing (4 branches) warrants edge case expansion.
"""

from __future__ import annotations

import json
import os
import textwrap
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="session")
def validate_artifact():
    """Load hooks/validate_artifact.py as a module."""
    import importlib.util
    import sys

    mod_path = REPO_ROOT / "hooks" / "validate_artifact.py"
    spec = importlib.util.spec_from_file_location("validate_artifact", mod_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {mod_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["validate_artifact"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def project_dir(tmp_path):
    """Create a minimal project directory with default artifact layout."""
    op_dir = tmp_path / ".agentera"
    op_dir.mkdir()
    return tmp_path


# ---------------------------------------------------------------------------
# classify_file: 4-branch routing (edge case expansion)
# ---------------------------------------------------------------------------


class TestClassifyFile:
    """Routing has 4 branches: artifact, skill, spec-spec, other."""

    def test_operational_artifact_in_agentera(self, validate_artifact, project_dir):
        """File in .agentera/ recognized as artifact."""
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text("# Health\n", encoding="utf-8")
        result = validate_artifact.classify_file(str(health), str(project_dir))
        assert result == "artifact"

    def test_root_artifact(self, validate_artifact, project_dir):
        """File at project root recognized as artifact (TODO.md)."""
        todo = project_dir / "TODO.md"
        todo.write_text("# TODO\n", encoding="utf-8")
        result = validate_artifact.classify_file(str(todo), str(project_dir))
        assert result == "artifact"

    def test_skill_definition(self, validate_artifact, project_dir):
        """skills/*/SKILL.md recognized as skill."""
        skill_dir = project_dir / "skills" / "realisera"
        skill_dir.mkdir(parents=True)
        skill_md = skill_dir / "SKILL.md"
        skill_md.write_text("---\nname: realisera\n---\n", encoding="utf-8")
        result = validate_artifact.classify_file(str(skill_md), str(project_dir))
        assert result == "skill"

    def test_spec(self, validate_artifact, project_dir):
        """SPEC.md at root recognized as the spec."""
        spec = project_dir / "SPEC.md"
        spec.write_text("# Spec\n", encoding="utf-8")
        result = validate_artifact.classify_file(str(spec), str(project_dir))
        assert result == "the spec"

    def test_unrelated_file(self, validate_artifact, project_dir):
        """Random file classified as other."""
        readme = project_dir / "README.md"
        readme.write_text("# Hello\n", encoding="utf-8")
        result = validate_artifact.classify_file(str(readme), str(project_dir))
        assert result == "other"

    def test_non_skill_md_in_skills_dir(self, validate_artifact, project_dir):
        """A non-SKILL.md file under skills/ classified as other."""
        skill_dir = project_dir / "skills" / "realisera" / "references"
        skill_dir.mkdir(parents=True)
        ctx = skill_dir / "contract.md"
        ctx.write_text("<!-- context -->\n", encoding="utf-8")
        result = validate_artifact.classify_file(str(ctx), str(project_dir))
        assert result == "other"


# ---------------------------------------------------------------------------
# identify_artifact
# ---------------------------------------------------------------------------


class TestIdentifyArtifact:
    """1 pass + 1 fail."""

    def test_known_artifact(self, validate_artifact, project_dir):
        plan = project_dir / ".agentera" / "PLAN.md"
        plan.write_text("# Plan\n", encoding="utf-8")
        result = validate_artifact.identify_artifact(str(plan), str(project_dir))
        assert result == "PLAN.md"

    def test_unknown_file(self, validate_artifact, project_dir):
        random_file = project_dir / "random.md"
        random_file.write_text("hello\n", encoding="utf-8")
        result = validate_artifact.identify_artifact(str(random_file), str(project_dir))
        assert result is None


# ---------------------------------------------------------------------------
# resolve_artifact_paths: DOCS.md path resolution
# ---------------------------------------------------------------------------


class TestResolveArtifactPaths:
    """1 pass (with overrides) + 1 fail (no DOCS.md, defaults used)."""

    def test_defaults_without_docs(self, validate_artifact, project_dir):
        """Without DOCS.md, uses default layout."""
        paths = validate_artifact.resolve_artifact_paths(str(project_dir))
        assert paths["VISION.md"] == str(project_dir / "VISION.md")
        assert paths["HEALTH.md"] == str(project_dir / ".agentera" / "HEALTH.md")

    def test_overrides_from_docs(self, validate_artifact, project_dir):
        """DOCS.md Artifact Mapping overrides paths."""
        docs = project_dir / ".agentera" / "DOCS.md"
        docs.write_text(
            textwrap.dedent("""\
            # Documentation Contract

            ## Artifact Mapping

            | Artifact | Path | Producers |
            |----------|------|-----------|
            | VISION.md | docs/VISION.md | visionera |

            ## Index
        """),
            encoding="utf-8",
        )
        paths = validate_artifact.resolve_artifact_paths(str(project_dir))
        assert paths["VISION.md"] == str(project_dir / "docs" / "VISION.md")
        # Non-overridden artifacts keep defaults
        assert paths["HEALTH.md"] == str(project_dir / ".agentera" / "HEALTH.md")


# ---------------------------------------------------------------------------
# count_words
# ---------------------------------------------------------------------------


class TestCountWords:
    """1 pass + 1 fail."""

    def test_normal_text(self, validate_artifact):
        assert validate_artifact.count_words("one two three four") == 4

    def test_empty_text(self, validate_artifact):
        assert validate_artifact.count_words("") == 0


# ---------------------------------------------------------------------------
# validate_artifact_structure: HEALTH.md
# ---------------------------------------------------------------------------


class TestValidateHealth:
    """1 pass + 1 fail."""

    def test_valid_health(self, validate_artifact, project_dir):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text(
            textwrap.dedent("""\
            # Health

            ## Audit 1

            Some findings here.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(health),
            "HEALTH.md",
        )
        assert violations == []

    def test_health_missing_audit_heading(self, validate_artifact, project_dir):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text(
            textwrap.dedent("""\
            # Health

            Some content but no audit entries.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(health),
            "HEALTH.md",
        )
        assert any("Audit" in v for v in violations)


# ---------------------------------------------------------------------------
# validate_artifact_structure: PLAN.md
# ---------------------------------------------------------------------------


class TestValidatePlan:
    """1 pass + 1 fail."""

    def test_valid_plan(self, validate_artifact, project_dir):
        plan = project_dir / ".agentera" / "PLAN.md"
        plan.write_text(
            textwrap.dedent("""\
            # Plan: Do something

            ## Tasks

            ### Task 1: First task
            **Status**: open
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(plan),
            "PLAN.md",
        )
        assert violations == []

    def test_plan_missing_tasks(self, validate_artifact, project_dir):
        plan = project_dir / ".agentera" / "PLAN.md"
        plan.write_text(
            textwrap.dedent("""\
            # Plan: Something

            Just a description, no tasks section.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(plan),
            "PLAN.md",
        )
        assert any("Task" in v or "Tasks" in v for v in violations)


# ---------------------------------------------------------------------------
# validate_artifact_structure: DECISIONS.md
# ---------------------------------------------------------------------------


class TestValidateDecisions:
    """1 pass + 1 fail."""

    def test_valid_decisions(self, validate_artifact, project_dir):
        decisions = project_dir / ".agentera" / "DECISIONS.md"
        decisions.write_text(
            textwrap.dedent("""\
            # Decisions

            ## Decision 1

            Some reasoning.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(decisions),
            "DECISIONS.md",
        )
        assert violations == []

    def test_decisions_missing_heading(self, validate_artifact, project_dir):
        decisions = project_dir / ".agentera" / "DECISIONS.md"
        decisions.write_text(
            textwrap.dedent("""\
            # Some Notes

            Just notes, not decisions.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(decisions),
            "DECISIONS.md",
        )
        assert any("Decisions" in v for v in violations)


# ---------------------------------------------------------------------------
# validate_artifact_structure: PROGRESS.md
# ---------------------------------------------------------------------------


class TestValidateProgress:
    """1 pass + 1 fail + glyph-prefixed SPEC format."""

    def test_valid_progress(self, validate_artifact, project_dir):
        progress = project_dir / ".agentera" / "PROGRESS.md"
        progress.write_text(
            textwrap.dedent("""\
            # Progress

            ## Cycle 1

            Did some work.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(progress),
            "PROGRESS.md",
        )
        assert violations == []

    def test_valid_progress_glyph_prefixed(self, validate_artifact, project_dir):
        progress = project_dir / ".agentera" / "PROGRESS.md"
        progress.write_text(
            textwrap.dedent("""\
            # Progress

            ■ ## Cycle 1 · 2026-04-23 · feat: ship a thing

            Did some work.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(progress),
            "PROGRESS.md",
        )
        assert violations == []

    def test_progress_missing_cycle(self, validate_artifact, project_dir):
        progress = project_dir / ".agentera" / "PROGRESS.md"
        progress.write_text(
            textwrap.dedent("""\
            # Progress

            Some notes but no cycles.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(progress),
            "PROGRESS.md",
        )
        assert any("Cycle" in v for v in violations)


# ---------------------------------------------------------------------------
# validate_artifact_structure: TODO.md
# ---------------------------------------------------------------------------


class TestValidateTodo:
    """1 pass + 1 fail."""

    def test_valid_todo(self, validate_artifact, project_dir):
        todo = project_dir / "TODO.md"
        todo.write_text(
            textwrap.dedent("""\
            # TODO

            ## \u21f6 Critical
            - [ ] ISS-1: [fix] Something broken

            ## \u21c9 Degraded
            - [ ] ISS-2: [refactor] Something slow

            ## \u2192 Normal
            - [ ] ISS-3: [feat] Something new

            ## \u21e2 Annoying
            - [ ] ISS-4: [chore] Something cosmetic

            ## Resolved
            - [x] ~~ISS-0: [fix] Fixed thing~~
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(todo),
            "TODO.md",
        )
        assert violations == []

    def test_todo_missing_severity_section(self, validate_artifact, project_dir):
        todo = project_dir / "TODO.md"
        todo.write_text(
            textwrap.dedent("""\
            # TODO

            ## \u21f6 Critical
            - [ ] ISS-1: something

            ## Resolved
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(todo),
            "TODO.md",
        )
        # Should flag missing Degraded, Normal, Annoying
        assert len([v for v in violations if "severity section" in v]) >= 1


# ---------------------------------------------------------------------------
# validate_artifact_structure: VISION.md
# ---------------------------------------------------------------------------


class TestValidateVision:
    """1 pass + 1 fail."""

    def test_valid_vision(self, validate_artifact, project_dir):
        vision = project_dir / "VISION.md"
        vision.write_text(
            textwrap.dedent("""\
            # My Project Vision

            Some aspirational content.
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(vision),
            "VISION.md",
        )
        assert violations == []

    def test_vision_no_heading(self, validate_artifact, project_dir):
        vision = project_dir / "VISION.md"
        vision.write_text("Just text, no headings at all.\n", encoding="utf-8")
        violations = validate_artifact.validate_artifact_structure(
            str(vision),
            "VISION.md",
        )
        assert len(violations) >= 1


# ---------------------------------------------------------------------------
# validate_artifact_structure: token budget
# ---------------------------------------------------------------------------


class TestTokenBudget:
    """1 pass + 1 fail."""

    def test_within_budget(self, validate_artifact, project_dir):
        vision = project_dir / "VISION.md"
        vision.write_text("# Vision\n\n" + "word " * 100 + "\n", encoding="utf-8")
        violations = validate_artifact.validate_artifact_structure(
            str(vision),
            "VISION.md",
        )
        assert not any("budget" in v for v in violations)

    def test_exceeds_budget(self, validate_artifact, project_dir):
        vision = project_dir / "VISION.md"
        # VISION.md budget is 1500 words
        vision.write_text("# Vision\n\n" + "word " * 2000 + "\n", encoding="utf-8")
        violations = validate_artifact.validate_artifact_structure(
            str(vision),
            "VISION.md",
        )
        assert any("budget" in v for v in violations)


# ---------------------------------------------------------------------------
# validate_artifact_structure: markdown well-formedness
# ---------------------------------------------------------------------------


class TestMarkdownWellFormedness:
    """1 pass + 1 fail."""

    def test_balanced_code_fences(self, validate_artifact, project_dir):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text(
            textwrap.dedent("""\
            # Health

            ## Audit 1

            ```
            some code
            ```
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(health),
            "HEALTH.md",
        )
        assert not any("code fence" in v for v in violations)

    def test_unclosed_code_fence(self, validate_artifact, project_dir):
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text(
            textwrap.dedent("""\
            # Health

            ## Audit 1

            ```
            some code without closing fence
        """),
            encoding="utf-8",
        )
        violations = validate_artifact.validate_artifact_structure(
            str(health),
            "HEALTH.md",
        )
        assert any("code fence" in v for v in violations)


# ---------------------------------------------------------------------------
# validate_artifact_structure: unreadable file
# ---------------------------------------------------------------------------


class TestUnreadableFile:
    """1 fail case for file read error."""

    def test_nonexistent_file(self, validate_artifact):
        violations = validate_artifact.validate_artifact_structure(
            "/nonexistent/path/HEALTH.md",
            "HEALTH.md",
        )
        assert any("Cannot read" in v for v in violations)


# ---------------------------------------------------------------------------
# main: integration test via stdin
# ---------------------------------------------------------------------------


class TestCompactionOverflowNudge:
    """Non-blocking nudge when an artifact exceeds 10/40/50 thresholds."""

    def test_over_threshold_emits_nudge(self, validate_artifact, project_dir):
        progress = project_dir / ".agentera" / "PROGRESS.md"
        lines = ["# Progress", ""]
        # 15 full cycles (over 10 threshold).
        for i in range(15, 0, -1):
            lines.append(f"## Cycle {i} · 2026-04-{((i - 1) % 28) + 1:02d}")
            lines.append("")
            lines.append(f"**What**: item {i}")
            lines.append("")
        progress.write_text("\n".join(lines) + "\n", encoding="utf-8")

        warnings = validate_artifact.detect_compaction_overflow(
            str(progress),
            "PROGRESS.md",
        )
        assert len(warnings) == 1
        assert "compact_artifact.py" in warnings[0]
        assert "progress" in warnings[0]

    def test_under_threshold_no_nudge(self, validate_artifact, project_dir):
        progress = project_dir / ".agentera" / "PROGRESS.md"
        progress.write_text(
            textwrap.dedent("""\
            # Progress

            ## Cycle 1

            Did work.
        """),
            encoding="utf-8",
        )
        warnings = validate_artifact.detect_compaction_overflow(
            str(progress),
            "PROGRESS.md",
        )
        assert warnings == []


class TestMainIntegration:
    """Tests main() with mocked stdin. 1 pass (no output) + 1 fail (violations)."""

    def test_no_validation_for_unrelated_file(
        self, validate_artifact, project_dir, monkeypatch
    ):
        """Unrelated file produces no output, exit 0."""
        readme = project_dir / "README.md"
        readme.write_text("# Hello\n", encoding="utf-8")
        hook_input = json.dumps(
            {
                "session_id": "test",
                "cwd": str(project_dir),
                "hook_event_name": "PostToolUse",
                "tool_name": "Edit",
                "tool_input": {"file_path": str(readme)},
            }
        )
        import io

        monkeypatch.setattr("sys.stdin", io.StringIO(hook_input))
        captured_output = io.StringIO()
        monkeypatch.setattr("sys.stdout", captured_output)
        result = validate_artifact.main()
        assert result == 0
        assert captured_output.getvalue() == ""

    def test_validation_runs_for_artifact(
        self, validate_artifact, project_dir, monkeypatch
    ):
        """Artifact with missing headings produces validation warnings."""
        health = project_dir / ".agentera" / "HEALTH.md"
        health.write_text("# Health\n\nNo audit entries.\n", encoding="utf-8")
        hook_input = json.dumps(
            {
                "session_id": "test",
                "cwd": str(project_dir),
                "hook_event_name": "PostToolUse",
                "tool_name": "Write",
                "tool_input": {"file_path": str(health)},
            }
        )
        import io

        monkeypatch.setattr("sys.stdin", io.StringIO(hook_input))
        captured_output = io.StringIO()
        monkeypatch.setattr("sys.stdout", captured_output)
        result = validate_artifact.main()
        assert result == 0
        assert "validation warnings" in captured_output.getvalue().lower()

    def test_empty_stdin_graceful(self, validate_artifact, monkeypatch):
        """Empty stdin exits cleanly."""
        import io

        monkeypatch.setattr("sys.stdin", io.StringIO(""))
        result = validate_artifact.main()
        assert result == 0

    def test_valid_artifact_no_output(
        self, validate_artifact, project_dir, monkeypatch
    ):
        """Valid artifact produces no output."""
        progress = project_dir / ".agentera" / "PROGRESS.md"
        progress.write_text(
            textwrap.dedent("""\
            # Progress

            ## Cycle 1

            Did some work.
        """),
            encoding="utf-8",
        )
        hook_input = json.dumps(
            {
                "session_id": "test",
                "cwd": str(project_dir),
                "hook_event_name": "PostToolUse",
                "tool_name": "Edit",
                "tool_input": {"file_path": str(progress)},
            }
        )
        import io

        monkeypatch.setattr("sys.stdin", io.StringIO(hook_input))
        captured_output = io.StringIO()
        monkeypatch.setattr("sys.stdout", captured_output)
        result = validate_artifact.main()
        assert result == 0
        assert captured_output.getvalue() == ""
