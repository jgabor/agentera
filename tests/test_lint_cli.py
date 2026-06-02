"""End-to-end CLI regression coverage for agentera lint budget lookup."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"

# Per-entry budgets from scripts/self_audit.py (_PER_ENTRY_BUDGETS).
_SCHEMA_BUDGET_CASES = [
    ("plan", "PLAN.md", 100),
    ("progress", "PROGRESS.md", 500),
    ("decisions", "DECISIONS.md", 200),
    ("todo", "TODO.md", 100),
]


def _run_lint(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), "lint", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env={**os.environ, "AGENTERA_HOME": str(REPO_ROOT)},
    )


def _anchored_over_budget_text(extra_words: int = 600) -> str:
    """Concrete anchor prefix so abstraction passes; body exceeds per-entry budgets."""
    return f"Updated `scripts/agentera` with retained artifact evidence. {'word ' * extra_words}"


def _verbosity_check(payload: dict) -> dict:
    return next(check for check in payload["checks"] if check["name"] == "verbosity")


class TestLintCliBudgetLookup:
    @pytest.mark.parametrize(
        "schema_name,canonical_label,per_entry_budget",
        _SCHEMA_BUDGET_CASES,
        ids=[case[0] for case in _SCHEMA_BUDGET_CASES],
    )
    def test_schema_name_text_hits_per_entry_budget(
        self,
        schema_name: str,
        canonical_label: str,
        per_entry_budget: int,
    ):
        text = _anchored_over_budget_text()
        r = _run_lint(
            "--artifact",
            schema_name,
            "--text",
            text,
            "--format",
            "json",
        )

        assert r.returncode == 1
        payload = json.loads(r.stdout)
        assert payload["command"] == "lint"
        assert payload["artifact"] == canonical_label
        verbosity = _verbosity_check(payload)
        assert verbosity["status"] == "fail"
        assert f"exceeds {per_entry_budget} budget" in verbosity["detail"]

    def test_canonical_label_preserves_display_and_budget(self):
        text = _anchored_over_budget_text()
        r = _run_lint(
            "--artifact",
            "PLAN.md",
            "--text",
            text,
            "--format",
            "json",
        )

        assert r.returncode == 1
        payload = json.loads(r.stdout)
        assert payload["artifact"] == "PLAN.md"
        verbosity = _verbosity_check(payload)
        assert verbosity["status"] == "fail"
        assert "exceeds 100 budget" in verbosity["detail"]

    def test_file_input_uses_full_file_budget_unchanged(self, tmp_path: Path):
        text = (
            "Updated `scripts/agentera` with retained artifact evidence. "
            + ("detail " * 130)
        )
        plan_path = tmp_path / "plan.yaml"
        plan_path.write_text(text, encoding="utf-8")

        file_result = _run_lint(
            "--artifact",
            "plan",
            "--file",
            str(plan_path),
            "--format",
            "json",
        )
        text_result = _run_lint(
            "--artifact",
            "plan",
            "--text",
            text,
            "--format",
            "json",
        )

        assert file_result.returncode == 0
        file_payload = json.loads(file_result.stdout)
        assert file_payload["status"] == "pass"
        assert file_payload["artifact"] == "PLAN.md"
        assert _verbosity_check(file_payload)["status"] == "pass"

        assert text_result.returncode == 1
        text_payload = json.loads(text_result.stdout)
        assert text_payload["status"] == "fail"
        verbosity = _verbosity_check(text_payload)
        assert verbosity["status"] == "fail"
        assert "exceeds 100 budget" in verbosity["detail"]
