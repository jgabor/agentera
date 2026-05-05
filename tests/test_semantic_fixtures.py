"""Tests for scripts/semantic_fixtures.py.

Proportionality: one pass and one fail per contract unit. Units are prompt,
seeded project state, captured output, expected facts, and artifact writes.
"""

from __future__ import annotations

import json
import textwrap


def _fixture(
    *,
    prompt: str = "Start a session and route the project.",
    seeded_state: dict | None = None,
    captured_output: str = "suggested -> /realisera for Task 1",
    tool_trace: dict | None = None,
    expected_facts: dict | None = None,
) -> str:
    if seeded_state is None:
        seeded_state = {"files": [{"path": ".agentera/plan.yaml", "content": "Task 1 pending"}]}
    if expected_facts is None:
        expected_facts = {
            "required_output": ["/realisera", "Task 1"],
            "forbidden_output": ["/optimera"],
            "artifact_expectations": {"writes": "none"},
        }
    tool_trace_section = ""
    if tool_trace is not None:
        tool_trace_section = f"\n        ## Tool Trace\n        ```json\n        {json.dumps(tool_trace)}\n        ```\n"
    return textwrap.dedent(f"""\
        # Semantic Fixture: hej-routing

        ## Prompt
        {prompt}

        ## Seeded Project State
        ```json
        {json.dumps(seeded_state)}
        ```

        ## Captured Output
        {captured_output}
        {tool_trace_section}

        ## Expected Facts
        ```json
        {json.dumps(expected_facts)}
        ```
    """)


class TestPromptSection:
    def test_pass_prompt_is_unambiguous(self, semantic_fixtures):
        fixture, errors = semantic_fixtures.validate_fixture_text(_fixture(prompt="Run /hej."))
        assert errors == []
        assert fixture.prompt == "Run /hej."

    def test_fail_missing_prompt_names_section(self, semantic_fixtures):
        text = _fixture().replace("## Prompt\nStart a session and route the project.\n\n", "")
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "missing section: Prompt" in errors


class TestSeededProjectStateSection:
    def test_pass_seeded_state_files_are_unambiguous(self, semantic_fixtures):
        fixture, errors = semantic_fixtures.validate_fixture_text(_fixture())
        assert errors == []
        assert fixture.seeded_state["files"][0]["path"] == ".agentera/plan.yaml"

    def test_fail_malformed_seeded_state_names_section(self, semantic_fixtures):
        text = _fixture(seeded_state={"files": [{"path": "TODO.md"}]})
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "malformed section: Seeded Project State: files[0].content must be a string" in errors


class TestCapturedOutputSection:
    def test_pass_captured_output_is_unambiguous(self, semantic_fixtures):
        fixture, errors = semantic_fixtures.validate_fixture_text(_fixture(captured_output="status: active"))
        assert errors == []
        assert fixture.captured_output == "status: active"

    def test_fail_blank_captured_output_names_section(self, semantic_fixtures):
        text = _fixture(captured_output="")
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "malformed section: Captured Output: must be non-empty" in errors


class TestExpectedFactsSection:
    def test_pass_expected_facts_are_unambiguous(self, semantic_fixtures):
        facts = {"required_output": ["Task 1"], "forbidden_output": ["Task 2"]}
        fixture, errors = semantic_fixtures.validate_fixture_text(_fixture(expected_facts=facts))
        assert errors == []
        assert fixture.expected_facts["required_output"] == ["Task 1"]

    def test_fail_missing_expected_fact_names_section(self, semantic_fixtures):
        text = _fixture(expected_facts={"required_output": [], "forbidden_output": []})
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "malformed section: Expected Facts: must declare at least one expected fact" in errors


class TestArtifactExpectations:
    def test_pass_read_only_fixture_can_declare_no_writes(self, semantic_fixtures):
        fixture, errors = semantic_fixtures.validate_fixture_text(_fixture())
        assert errors == []
        assert fixture.expected_facts["artifact_expectations"]["writes"] == "none"

    def test_fail_malformed_writes_names_section(self, semantic_fixtures):
        facts = {"artifact_expectations": {"writes": "TODO.md"}}
        text = _fixture(expected_facts=facts)
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "malformed section: Expected Facts: artifact_expectations.writes must be 'none' or a list" in errors


class TestToolTraceSection:
    def test_pass_tool_trace_calls_are_unambiguous(self, semantic_fixtures):
        fixture, errors = semantic_fixtures.validate_fixture_text(
            _fixture(tool_trace={"calls": ["uv run scripts/agentera hej"]})
        )
        assert errors == []
        assert fixture.tool_trace["calls"] == ["uv run scripts/agentera hej"]

    def test_fail_malformed_tool_trace_names_section(self, semantic_fixtures):
        text = _fixture(tool_trace={"calls": [""]})
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "malformed section: Tool Trace: calls must be non-empty strings" in errors


class TestToolExpectations:
    def test_pass_expected_tool_facts_are_unambiguous(self, semantic_fixtures):
        facts = {"required_tool_calls": ["agentera hej"], "forbidden_tool_calls": ["agentera plan"]}
        fixture, errors = semantic_fixtures.validate_fixture_text(_fixture(expected_facts=facts))
        assert errors == []
        assert fixture.expected_facts["required_tool_calls"] == ["agentera hej"]

    def test_fail_malformed_tool_facts_names_section(self, semantic_fixtures):
        text = _fixture(expected_facts={"required_tool_calls": [""]})
        fixture, errors = semantic_fixtures.validate_fixture_text(text)
        assert fixture is None
        assert "malformed section: Expected Facts: required_tool_calls must be non-empty strings" in errors
