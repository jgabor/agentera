"""Tests for scripts/self_audit.py — ISS-45.

6 base tests (1 pass + 1 fail per function: check_verbosity, check_abstraction,
check_filler) plus 3 edge case tests for check_filler (empty text, all-patterns
text, mixed valid+banned).
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"


def _run_lint(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), "lint", *args],
        input=input_text,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env={**os.environ, "AGENTERA_HOME": str(REPO_ROOT)},
    )


def _run_lint_with_home(app_home: Path, *args: str, input_text: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), "lint", *args],
        input=input_text,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env={**os.environ, "AGENTERA_HOME": str(app_home)},
    )


@pytest.fixture(scope="session")
def self_audit():
    """Load scripts/self_audit.py as a module."""
    mod_path = REPO_ROOT / "scripts" / "self_audit.py"
    spec = importlib.util.spec_from_file_location("self_audit", mod_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load {mod_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["self_audit"] = mod
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# check_verbosity: 1 pass + 1 fail
# ---------------------------------------------------------------------------


class TestCheckVerbosity:
    def test_within_budget(self, self_audit):
        """Entry word count within per-entry budget returns (True, "")."""
        text = "Cycle summary with a few words"
        passed, detail = self_audit.check_verbosity(text, "PROGRESS.md")
        assert passed is True
        assert detail == ""

    def test_exceeds_budget(self, self_audit):
        """Entry word count over per-entry budget returns (False, reason)."""
        text = "word " * 600  # 600 words > 500 PROGRESS.md per-cycle budget
        passed, detail = self_audit.check_verbosity(text, "PROGRESS.md")
        assert passed is False
        assert "verbosity mismatch" in detail
        assert "600" in detail
        assert "500" in detail

    def test_uses_fallback_for_unknown_artifact(self, self_audit):
        """Unknown artifact uses 500-word default budget."""
        text = "word " * 100  # 100 words < 500 default
        passed, detail = self_audit.check_verbosity(text, "UNKNOWN.md")
        assert passed is True
        assert detail == ""


# ---------------------------------------------------------------------------
# check_abstraction: 1 pass + 1 fail
# ---------------------------------------------------------------------------


class TestCheckAbstraction:
    def test_finds_file_path_anchor(self, self_audit):
        """Entry with a file path returns (True, file_path)."""
        text = "Fixed bug in src/auth.py where login failed."
        passed, detail = self_audit.check_abstraction(text)
        assert passed is True
        assert "src/auth.py" in detail

    def test_finds_line_number_anchor(self, self_audit):
        """Entry with a line number returns (True, line_number)."""
        text = "Null check added at :42 in the handler."
        passed, detail = self_audit.check_abstraction(text)
        assert passed is True
        assert ":42" in detail

    def test_finds_commit_hash_anchor(self, self_audit):
        """Entry with a commit hash returns (True, hash)."""
        text = "Introduced in commit abc1234def during refactor."
        passed, detail = self_audit.check_abstraction(text)
        assert passed is True
        assert "abc1234def" in detail

    def test_finds_metric_value_anchor(self, self_audit):
        """Entry with a metric value returns (True, metric)."""
        text = "Response time dropped from 120ms to 45ms."
        passed, detail = self_audit.check_abstraction(text)
        assert passed is True
        assert "120ms" in detail

    def test_finds_backtick_identifier_anchor(self, self_audit):
        """Entry with a backtick-enclosed identifier returns (True, identifier)."""
        text = "The `handle_login` function was refactored."
        passed, detail = self_audit.check_abstraction(text)
        assert passed is True
        assert "handle_login" in detail

    def test_finds_quoted_text_anchor(self, self_audit):
        """Entry with quoted text returns (True, quote)."""
        text = 'Error said "connection refused" repeatedly.'
        passed, detail = self_audit.check_abstraction(text)
        assert passed is True
        assert "connection refused" in detail

    def test_no_anchor_found(self, self_audit):
        """Entry without any concrete anchor returns (False, reason)."""
        text = "We made improvements to the system and it is better now."
        passed, detail = self_audit.check_abstraction(text)
        assert passed is False
        assert "abstraction creep" in detail


# ---------------------------------------------------------------------------
# check_filler: 1 pass + 1 fail + 3 edge cases
# ---------------------------------------------------------------------------


class TestCheckFiller:
    def test_no_banned_patterns(self, self_audit):
        """Clean text returns (True, "")."""
        text = "The test passed all benchmarks with a 15ms response time."
        passed, detail = self_audit.check_filler(text)
        assert passed is True
        assert detail == ""

    def test_detects_banned_pattern(self, self_audit):
        """Text with a banned pattern returns (False, pattern names)."""
        text = "Here is the updated plan with new tasks."
        passed, detail = self_audit.check_filler(text)
        assert passed is False
        assert "filler" in detail
        assert "meta-commentary about writing" in detail

    def test_detects_multiple_banned_patterns(self, self_audit):
        """Text with multiple banned patterns lists all categories."""
        text = (
            "Here is the updated plan. In summary, we fixed three bugs. "
            "Overall the system is better."
        )
        passed, detail = self_audit.check_filler(text)
        assert passed is False
        assert "filler" in detail
        assert "meta-commentary about writing" in detail
        assert "summary preambles" in detail

    def test_empty_text(self, self_audit):
        """Empty text has no banned patterns."""
        passed, detail = self_audit.check_filler("")
        assert passed is True
        assert detail == ""

    def test_all_patterns_text(self, self_audit):
        """Text containing all 7 banned pattern categories."""
        text = (
            "Here is the updated analysis. It seems like the system is slower. "
            "Moving on to the next section, now let's look at the data. "
            "I am now checking the results. Based on my analysis, this is significant. "
            "After careful consideration, we proceed. In summary, to recap, overall, "
            "I chose this approach because it seemed optimal."
        )
        passed, detail = self_audit.check_filler(text)
        assert passed is False
        assert "filler" in detail
        assert "meta-commentary about writing" in detail
        assert "hedging qualifiers" in detail
        assert "redundant transitions" in detail
        assert "self-referential process narration" in detail
        assert "filler introductions" in detail
        assert "summary preambles" in detail
        assert "excessive justification" in detail

    def test_mixed_valid_and_banned(self, self_audit):
        """Text with both clean content and banned patterns."""
        text = (
            "Fixed the null pointer in src/auth.py:42. "
            "In summary, this resolves the critical issue. "
            "Added unit tests for `handle_login` with 95% coverage."
        )
        passed, detail = self_audit.check_filler(text)
        assert passed is False
        assert "summary preambles" in detail
        # Clean content doesn't cancel the violation
        assert "meta-commentary about writing" not in detail


class TestLintCli:
    def test_describe_lists_lint_command(self):
        r = subprocess.run(
            [sys.executable, str(CLI), "describe", "--format", "json"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        assert r.returncode == 0
        payload = json.loads(r.stdout)
        commands = {entry["name"]: entry for entry in payload["commands"]}
        assert commands["lint"]["kind"] == "artifact_lint"
        assert commands["lint"]["output_formats"] == ["text", "json"]

    def test_lint_passes_from_stdin_without_helper_path(self):
        r = _run_lint(
            "--artifact",
            "PROGRESS.md",
            input_text="Updated `scripts/agentera` with a 1ms smoke check.",
        )
        assert r.returncode == 0
        assert "lint pass" in r.stdout
        assert "all self-audit checks passed" in r.stdout

    def test_lint_reports_bounded_actionable_diagnostics_by_default(self):
        text = "Here is the update. " + ("word " * 600)
        r = _run_lint("--artifact", "PROGRESS.md", "--text", text)
        assert r.returncode == 0
        assert r.stdout.count("- ") == 3
        assert "verbosity:" in r.stdout
        assert "abstraction creep" in r.stdout
        assert "filler:" in r.stdout
        assert "action:" in r.stdout

    def test_lint_strict_fails_with_json_summary(self):
        r = _run_lint(
            "--artifact",
            "TODO.md",
            "--text",
            "This improves the system broadly.",
            "--strict",
            "--format",
            "json",
        )
        assert r.returncode == 1
        payload = json.loads(r.stdout)
        assert payload["command"] == "lint"
        assert payload["status"] == "fail"
        assert payload["summary"] == {"failed": 1, "passed": 2, "advisory": False}
        assert payload["checks"][1]["name"] == "abstraction"

    def test_plan_lint_accepts_repo_style_anchor_regression(self):
        text = (
            "Deliver queue visibility through queued-message fixture, semantic snapshots, "
            "PTY smoke, mage check, source docs, and concrete internal/runtime "
            "internal/app internal/tui boundaries."
        )
        r = _run_lint("--artifact", "PLAN.md", "--text", text, "--format", "json")

        assert r.returncode == 0
        payload = json.loads(r.stdout)
        assert payload["status"] == "pass"
        assert payload["summary"] == {"failed": 0, "passed": 3, "advisory": True}
        abstraction = next(check for check in payload["checks"] if check["name"] == "abstraction")
        assert abstraction["status"] == "pass"
        assert abstraction["detail"] == "internal/runtime"

    def test_plan_lint_rejects_unanchored_generic_prose_regression(self):
        text = "This plan improves the system broadly and makes the implementation better for users."
        r = _run_lint("--artifact", "PLAN.md", "--text", text, "--format", "json")

        assert r.returncode == 0
        payload = json.loads(r.stdout)
        assert payload["status"] == "fail"
        assert payload["summary"] == {"failed": 1, "passed": 2, "advisory": True}
        abstraction = next(check for check in payload["checks"] if check["name"] == "abstraction")
        assert abstraction["status"] == "fail"
        assert abstraction["detail"] == "abstraction creep: no concrete anchor"

    def test_lint_missing_installed_helper_reports_app_model(self, tmp_path):
        app_home = tmp_path / "agentera-home"
        (app_home / "app" / "scripts").mkdir(parents=True)

        r = _run_lint_with_home(
            app_home,
            "--artifact",
            "PROGRESS.md",
            "--text",
            "Updated `scripts/agentera` with a 1ms smoke check.",
        )

        assert r.returncode == 2
        assert "lint helper is missing" in r.stderr
        assert f"appHome={app_home}" in r.stderr
        assert f"managedAppRoot={app_home / 'app'}" in r.stderr
        assert "run `agentera doctor --format json`" in r.stderr
