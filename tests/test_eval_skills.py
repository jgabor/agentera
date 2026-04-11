"""Tests for scripts/eval_skills.py pure functions.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained only for functions with regex or branching logic.
"""

from __future__ import annotations

import textwrap
from pathlib import Path


# ---------------------------------------------------------------------------
# Expected skills (all 12)
# ---------------------------------------------------------------------------

ALL_SKILL_NAMES = sorted([
    "dokumentera",
    "hej",
    "inspektera",
    "inspirera",
    "optimera",
    "orkestrera",
    "planera",
    "profilera",
    "realisera",
    "resonera",
    "visionera",
    "visualisera",
])


# ---------------------------------------------------------------------------
# TRIGGER_PROMPTS completeness
# ---------------------------------------------------------------------------

class TestTriggerPrompts:
    def test_all_twelve_skills_present(self, eval_skills):
        assert sorted(eval_skills.TRIGGER_PROMPTS.keys()) == ALL_SKILL_NAMES

    def test_prompts_are_nonempty_strings(self, eval_skills):
        for name, prompt in eval_skills.TRIGGER_PROMPTS.items():
            assert isinstance(prompt, str), f"{name} prompt is not a string"
            assert len(prompt) > 0, f"{name} prompt is empty"


# ---------------------------------------------------------------------------
# _parse_frontmatter_name
# ---------------------------------------------------------------------------

class TestParseFrontmatterName:
    """Complex: regex parsing. Keep 3 (valid, no FM, no name field)."""

    def test_valid_frontmatter(self, eval_skills):
        text = textwrap.dedent("""\
            ---
            name: realisera
            description: Autonomous loops
            ---
            # Content
        """)
        assert eval_skills._parse_frontmatter_name(text) == "realisera"

    def test_no_frontmatter(self, eval_skills):
        assert eval_skills._parse_frontmatter_name("# Just markdown") is None

    def test_no_name_field(self, eval_skills):
        text = "---\ndescription: no name here\n---\n"
        assert eval_skills._parse_frontmatter_name(text) is None


# ---------------------------------------------------------------------------
# discover_skills
# ---------------------------------------------------------------------------

class TestDiscoverSkills:
    """Complex: file system discovery with branching. Keep 3 (discovers, fallback, empty)."""

    def test_discovers_skills_from_temp_dir(self, eval_skills, tmp_path, monkeypatch):
        """Create fake skill dirs with SKILL.md frontmatter and verify discovery."""
        skills_dir = tmp_path / "skills"
        for name in ["alpha", "beta"]:
            d = skills_dir / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(
                f"---\nname: {name}\n---\n# {name}\n", encoding="utf-8"
            )

        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        result = eval_skills.discover_skills()

        assert len(result) == 2
        assert result[0]["name"] == "alpha"
        assert result[1]["name"] == "beta"

    def test_falls_back_to_directory_name(self, eval_skills, tmp_path, monkeypatch):
        """When frontmatter has no name field, use the directory name."""
        skills_dir = tmp_path / "skills"
        d = skills_dir / "gamma"
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text("# No frontmatter\n", encoding="utf-8")

        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        result = eval_skills.discover_skills()

        assert len(result) == 1
        assert result[0]["name"] == "gamma"

    def test_empty_skills_dir(self, eval_skills, tmp_path, monkeypatch):
        """Empty skills directory returns empty list."""
        (tmp_path / "skills").mkdir()
        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        assert eval_skills.discover_skills() == []


# ---------------------------------------------------------------------------
# build_report
# ---------------------------------------------------------------------------

class TestBuildReport:
    """Simple: dict construction. One pass + one fail."""

    def test_basic_report_structure(self, eval_skills):
        results = [
            {"skill": "a", "status": "pass", "duration_s": 1.0, "error": None},
            {"skill": "b", "status": "fail", "duration_s": 2.0, "error": "boom"},
        ]
        report = eval_skills.build_report(results)

        assert "timestamp" in report
        assert report["skills_tested"] == 2
        assert report["passed"] == 1
        assert report["failed"] == 1
        assert report["results"] is results

    def test_empty_results(self, eval_skills):
        report = eval_skills.build_report([])
        assert report["skills_tested"] == 0
        assert report["passed"] == 0
        assert report["failed"] == 0
        assert report["results"] == []


# ---------------------------------------------------------------------------
# build_dry_run
# ---------------------------------------------------------------------------

class TestBuildDryRun:
    """Simple: trivial dict. One pass + one fail."""

    def test_dry_run_structure(self, eval_skills):
        skills = [
            {"name": "a", "prompt": "Do A."},
            {"name": "b", "prompt": "Do B."},
        ]
        result = eval_skills.build_dry_run(skills)

        assert result["mode"] == "dry-run"
        assert len(result["skills"]) == 2
        assert result["skills"][0] == {"name": "a", "prompt": "Do A."}
        assert result["skills"][1] == {"name": "b", "prompt": "Do B."}

    def test_dry_run_empty(self, eval_skills):
        result = eval_skills.build_dry_run([])
        assert result["mode"] == "dry-run"
        assert result["skills"] == []


# ---------------------------------------------------------------------------
# parse_args
# ---------------------------------------------------------------------------

class TestParseArgs:
    """Simple: argparse wrapper. One pass (defaults) + one fail (flag override)."""

    def test_defaults(self, eval_skills):
        args = eval_skills.parse_args([])
        assert args.skill is None
        assert args.dry_run is False
        assert args.parallel == eval_skills.DEFAULT_PARALLEL
        assert args.timeout == eval_skills.DEFAULT_TIMEOUT

    def test_skill_flag(self, eval_skills):
        args = eval_skills.parse_args(["--skill", "realisera"])
        assert args.skill == "realisera"

    def test_parse_args_runtime_flag(self, eval_skills):
        """--runtime accepts auto, claude, opencode and defaults to auto."""
        assert eval_skills.parse_args([]).runtime == "auto"
        assert eval_skills.parse_args(["--runtime", "claude"]).runtime == "claude"
        assert eval_skills.parse_args(["--runtime", "opencode"]).runtime == "opencode"


# ---------------------------------------------------------------------------
# detect_runtime
# ---------------------------------------------------------------------------

class TestDetectRuntime:
    """Runtime detection logic. One pass + one fail per unit (4 units = 4 tests)."""

    def test_detect_runtime_prefers_claude(self, eval_skills, monkeypatch):
        """When both claude and opencode are on PATH, return 'claude'."""
        monkeypatch.setattr(eval_skills.shutil, "which", lambda name: f"/usr/bin/{name}")
        assert eval_skills.detect_runtime(None) == "claude"

    def test_detect_runtime_fallback_opencode(self, eval_skills, monkeypatch):
        """When only opencode is on PATH, return 'opencode'."""
        monkeypatch.setattr(
            eval_skills.shutil, "which",
            lambda name: None if name == "claude" else "/usr/bin/opencode",
        )
        assert eval_skills.detect_runtime(None) == "opencode"

    def test_detect_runtime_explicit_override(self, eval_skills, monkeypatch):
        """Explicit runtime bypasses PATH detection entirely."""
        monkeypatch.setattr(eval_skills.shutil, "which", lambda name: None)
        assert eval_skills.detect_runtime("opencode") == "opencode"

    def test_detect_runtime_nothing_available(self, eval_skills, monkeypatch):
        """When neither binary is on PATH and no explicit runtime, sys.exit(1)."""
        monkeypatch.setattr(eval_skills.shutil, "which", lambda name: None)
        import pytest
        with pytest.raises(SystemExit) as exc_info:
            eval_skills.detect_runtime(None)
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# _invoke_skill opencode command
# ---------------------------------------------------------------------------

class TestInvokeSkillOpencodeCommand:
    """Verify the command list selected for opencode runtime."""

    def test_invoke_skill_opencode_command(self, eval_skills, monkeypatch):
        """opencode runtime uses ['opencode', 'run', '--prompt'] as the command."""
        captured = {}

        def fake_run(cmd, **kwargs):
            captured["cmd"] = cmd
            import subprocess
            # Simulate a clean zero-exit result.
            return subprocess.CompletedProcess(cmd, returncode=0, stdout="", stderr="")

        monkeypatch.setattr(eval_skills.subprocess, "run", fake_run)
        eval_skills._invoke_skill("realisera", "test prompt", timeout=5, runtime="opencode")
        assert captured["cmd"] == ["opencode", "run", "--prompt"]
