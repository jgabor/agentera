"""Tests for scripts/eval_skills.py pure functions."""

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

    def test_unclosed_frontmatter(self, eval_skills):
        text = "---\nname: broken\n"
        assert eval_skills._parse_frontmatter_name(text) is None

    def test_no_name_field(self, eval_skills):
        text = "---\ndescription: no name here\n---\n"
        assert eval_skills._parse_frontmatter_name(text) is None

    def test_name_with_extra_whitespace(self, eval_skills):
        text = "---\nname:   spaced  \n---\n"
        assert eval_skills._parse_frontmatter_name(text) == "spaced"


# ---------------------------------------------------------------------------
# discover_skills
# ---------------------------------------------------------------------------

class TestDiscoverSkills:
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

    def test_uses_trigger_prompt_when_available(self, eval_skills, tmp_path, monkeypatch):
        """If the skill name is in TRIGGER_PROMPTS, use that prompt."""
        skills_dir = tmp_path / "skills"
        d = skills_dir / "hej"
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text("---\nname: hej\n---\n", encoding="utf-8")

        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        result = eval_skills.discover_skills()

        assert len(result) == 1
        assert result[0]["prompt"] == eval_skills.TRIGGER_PROMPTS["hej"]

    def test_generates_fallback_prompt(self, eval_skills, tmp_path, monkeypatch):
        """Skills not in TRIGGER_PROMPTS get a generic fallback prompt."""
        skills_dir = tmp_path / "skills"
        d = skills_dir / "unknown_skill"
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(
            "---\nname: unknown_skill\n---\n", encoding="utf-8"
        )

        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        result = eval_skills.discover_skills()

        assert result[0]["prompt"] == "Invoke the unknown_skill skill."

    def test_returns_sorted_order(self, eval_skills, tmp_path, monkeypatch):
        """Skills are returned sorted by directory name."""
        skills_dir = tmp_path / "skills"
        for name in ["zeta", "alpha", "mid"]:
            d = skills_dir / name
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(
                f"---\nname: {name}\n---\n", encoding="utf-8"
            )

        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        result = eval_skills.discover_skills()

        names = [s["name"] for s in result]
        assert names == ["alpha", "mid", "zeta"]

    def test_empty_skills_dir(self, eval_skills, tmp_path, monkeypatch):
        """Empty skills directory returns empty list."""
        (tmp_path / "skills").mkdir()
        monkeypatch.setattr(eval_skills, "REPO_ROOT", tmp_path)
        assert eval_skills.discover_skills() == []


# ---------------------------------------------------------------------------
# build_report
# ---------------------------------------------------------------------------

class TestBuildReport:
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

    def test_timestamp_format(self, eval_skills):
        report = eval_skills.build_report([])
        ts = report["timestamp"]
        assert ts.endswith("Z")
        assert "T" in ts

    def test_all_pass(self, eval_skills):
        results = [
            {"skill": "x", "status": "pass", "duration_s": 0.5, "error": None},
        ]
        report = eval_skills.build_report(results)
        assert report["passed"] == 1
        assert report["failed"] == 0

    def test_all_fail(self, eval_skills):
        results = [
            {"skill": "x", "status": "fail", "duration_s": 0.5, "error": "err"},
            {"skill": "y", "status": "fail", "duration_s": 0.3, "error": "err"},
        ]
        report = eval_skills.build_report(results)
        assert report["passed"] == 0
        assert report["failed"] == 2

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
    def test_defaults(self, eval_skills):
        args = eval_skills.parse_args([])
        assert args.skill is None
        assert args.dry_run is False
        assert args.parallel == eval_skills.DEFAULT_PARALLEL
        assert args.timeout == eval_skills.DEFAULT_TIMEOUT

    def test_skill_flag(self, eval_skills):
        args = eval_skills.parse_args(["--skill", "realisera"])
        assert args.skill == "realisera"

    def test_dry_run_flag(self, eval_skills):
        args = eval_skills.parse_args(["--dry-run"])
        assert args.dry_run is True

    def test_parallel_flag(self, eval_skills):
        args = eval_skills.parse_args(["--parallel", "4"])
        assert args.parallel == 4

    def test_timeout_flag(self, eval_skills):
        args = eval_skills.parse_args(["--timeout", "60"])
        assert args.timeout == 60

    def test_all_flags_combined(self, eval_skills):
        args = eval_skills.parse_args([
            "--skill", "hej",
            "--dry-run",
            "--parallel", "3",
            "--timeout", "30",
        ])
        assert args.skill == "hej"
        assert args.dry_run is True
        assert args.parallel == 3
        assert args.timeout == 30
