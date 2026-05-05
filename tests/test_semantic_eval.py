"""Tests for scripts/semantic_eval.py.

Proportionality: one pass and one fail for each semantic assertion unit. The
only edge cases covered here are documented parser branches: required output,
forbidden output, seeded-artifact selection, read-only writes, and summary shape.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def _fixture_text(
    *,
    output: str = "route /realisera to Task 2",
    tool_trace: list[str] | None = None,
    required: str = "Task 2",
    forbidden: str = "/optimera",
    artifact_path: str = ".agentera/plan.yaml",
    artifact_contains: str = "Task 2",
) -> str:
    tool_trace_section = ""
    if tool_trace is not None:
        tool_trace_section = f'\n        ## Tool Trace\n        ```json\n        {{"calls": {json.dumps(tool_trace)}}}\n        ```\n'
    return textwrap.dedent(f"""\
        # Semantic Fixture: task-two

        ## Prompt
        Start a session.

        ## Seeded Project State
        ```json
        {{"files": [{{"path": ".agentera/plan.yaml", "content": "### Task 2: Build Offline Semantic Eval Command"}}]}}
        ```

        ## Captured Output
        {output}
        {tool_trace_section}

        ## Expected Facts
        ```json
        {{
          "required_output": ["/realisera", "{required}"],
          "forbidden_output": ["{forbidden}"],
          "required_artifacts": [{{"path": "{artifact_path}", "contains": ["{artifact_contains}"]}}],
          "artifact_expectations": {{"writes": "none"}}
        }}
        ```
    """)


def _fact_map(semantic_eval, semantic_fixtures, text: str) -> dict[str, dict[str, str]]:
    fixture, errors = semantic_fixtures.validate_fixture_text(text)
    assert errors == []
    result = semantic_eval.evaluate_fixture(fixture, "fixture.md")
    return {fact["fact"]: fact for fact in result["checked_facts"]}


class TestRequiredOutputAssertion:
    def test_pass_required_output_matches_captured_text(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(semantic_eval, semantic_fixtures, _fixture_text())

        assert facts["required_output[1]"] == {
            "fact": "required_output[1]",
            "status": "pass",
            "detail": "captured output contains 'Task 2'",
        }

    def test_fail_required_output_reports_missing_text(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(
            semantic_eval,
            semantic_fixtures,
            _fixture_text(output="route /realisera", required="Task 999"),
        )

        assert facts["required_output[1]"] == {
            "fact": "required_output[1]",
            "status": "fail",
            "detail": "captured output does not contain 'Task 999'",
        }


class TestForbiddenOutputAssertion:
    def test_pass_forbidden_output_is_absent(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(semantic_eval, semantic_fixtures, _fixture_text())

        assert facts["forbidden_output[0]"] == {
            "fact": "forbidden_output[0]",
            "status": "pass",
            "detail": "captured output omits forbidden '/optimera'",
        }

    def test_fail_forbidden_output_reports_present_text(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(
            semantic_eval,
            semantic_fixtures,
            _fixture_text(output="route /realisera, not /optimera"),
        )

        assert facts["forbidden_output[0]"] == {
            "fact": "forbidden_output[0]",
            "status": "fail",
            "detail": "captured output contains forbidden '/optimera'",
        }


class TestSeededArtifactAssertion:
    def test_pass_artifact_oracle_selects_seeded_path(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(semantic_eval, semantic_fixtures, _fixture_text())

        assert facts["required_artifacts[0]"] == {
            "fact": "required_artifacts[0]",
            "status": "pass",
            "detail": "seeded artifact '.agentera/plan.yaml' matched",
        }

    def test_fail_artifact_oracle_reports_wrong_seeded_path(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(
            semantic_eval,
            semantic_fixtures,
            _fixture_text(artifact_path=".agentera/progress.yaml"),
        )

        assert facts["required_artifacts[0]"] == {
            "fact": "required_artifacts[0]",
            "status": "fail",
            "detail": "seeded artifact '.agentera/progress.yaml' is missing",
        }


class TestReadOnlyWritesAssertion:
    def test_pass_read_only_writes_assertion(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(semantic_eval, semantic_fixtures, _fixture_text())

        assert facts["artifact_expectations.writes"] == {
            "fact": "artifact_expectations.writes",
            "status": "pass",
            "detail": "fixture expects no artifact writes; offline eval performed none",
        }


class TestToolTraceAssertion:
    def test_pass_required_tool_call_matches_trace(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(
            semantic_eval,
            semantic_fixtures,
            _fixture_text(
                tool_trace=["uv run scripts/agentera hej"],
                required="Task 2",
            ).replace(
                '"artifact_expectations": {"writes": "none"}',
                '"required_tool_calls": ["agentera hej"], "artifact_expectations": {"writes": "none"}',
            ),
        )

        assert facts["required_tool_calls[0]"] == {
            "fact": "required_tool_calls[0]",
            "status": "pass",
            "detail": "tool trace contains 'agentera hej'",
        }

    def test_fail_forbidden_tool_call_reports_present_trace(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(
            semantic_eval,
            semantic_fixtures,
            _fixture_text(
                tool_trace=["uv run scripts/agentera hej", "uv run scripts/agentera plan"],
            ).replace(
                '"artifact_expectations": {"writes": "none"}',
                '"forbidden_tool_calls": ["agentera plan"], "artifact_expectations": {"writes": "none"}',
            ),
        )

        assert facts["forbidden_tool_calls[0]"] == {
            "fact": "forbidden_tool_calls[0]",
            "status": "fail",
            "detail": "tool trace contains forbidden 'agentera plan'",
        }

    def test_fail_tool_call_count_reports_duplicate_trace(self, semantic_eval, semantic_fixtures):
        facts = _fact_map(
            semantic_eval,
            semantic_fixtures,
            _fixture_text(
                tool_trace=["uv run scripts/agentera hej", "uv run scripts/agentera hej"],
            ).replace(
                '"artifact_expectations": {"writes": "none"}',
                '"tool_call_counts": {"agentera hej": 1}, "artifact_expectations": {"writes": "none"}',
            ),
        )

        assert facts["tool_call_counts[agentera hej]"] == {
            "fact": "tool_call_counts[agentera hej]",
            "status": "fail",
            "detail": "tool trace contains 2 call(s) matching 'agentera hej'; expected 1",
        }


def test_pass_summary_reports_checked_facts(semantic_eval, semantic_fixtures):
    fixture, errors = semantic_fixtures.validate_fixture_text(_fixture_text())
    assert errors == []

    result = semantic_eval.evaluate_fixture(fixture, "fixture.md")
    report = semantic_eval.build_report([result])

    assert report["status"] == "pass"
    assert report["passed"] == 1
    assert {fact["fact"] for fact in result["checked_facts"]} == {
        "required_output[0]",
        "required_output[1]",
        "forbidden_output[0]",
        "required_artifacts[0]",
        "artifact_expectations.writes",
    }


def test_fail_summary_reports_first_failing_fact(semantic_eval, semantic_fixtures):
    fixture, errors = semantic_fixtures.validate_fixture_text(
        _fixture_text(
            output="route /realisera",
            required="Task 999",
            artifact_path=".agentera/MISSING.md",
        )
    )
    assert errors == []

    result = semantic_eval.evaluate_fixture(fixture, "fixture.md")
    report = semantic_eval.build_report([result])

    assert report["status"] == "fail"
    assert result["failing_fact"] == {
        "fact": "required_output[1]",
        "status": "fail",
        "detail": "captured output does not contain 'Task 999'",
    }


def test_main_emits_json_and_exit_status(semantic_eval, tmp_path, capsys):
    path = tmp_path / "fixture.md"
    path.write_text(_fixture_text(), encoding="utf-8")

    exit_code = semantic_eval.main([str(path)])
    report = json.loads(capsys.readouterr().out)

    assert exit_code == 0
    assert report["status"] == "pass"
    assert report["fixtures_tested"] == 1


class TestSemanticEvalCliCompatibility:
    def test_repo_root_cli_success_summary_shape_is_stable(self):
        result = subprocess.run(
            [
                sys.executable,
                "scripts/semantic_eval.py",
                "fixtures/semantic/hej-routing-task3.md",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        report = json.loads(result.stdout)
        assert result.returncode == 0
        assert list(report) == [
            "timestamp",
            "status",
            "fixtures_tested",
            "passed",
            "failed",
            "results",
        ]
        assert report["status"] == "pass"
        assert report["fixtures_tested"] == 1
        assert report["passed"] == 1
        assert report["failed"] == 0
        assert list(report["results"][0]) == [
            "fixture",
            "status",
            "checked_facts",
            "failing_fact",
        ]

    def test_repo_root_cli_failure_signals_nonzero_exit_status(self, tmp_path):
        path = tmp_path / "failing.md"
        path.write_text(_fixture_text(required="Task 999"), encoding="utf-8")

        result = subprocess.run(
            [sys.executable, "scripts/semantic_eval.py", str(path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        report = json.loads(result.stdout)
        assert result.returncode == 1
        assert report["status"] == "fail"
        assert report["failed"] == 1
        assert report["results"][0]["failing_fact"]["fact"] == "required_output[1]"
