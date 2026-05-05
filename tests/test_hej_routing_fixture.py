"""Acceptance tests for the first hej semantic routing fixture."""

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "fixtures" / "semantic" / "hej-routing-task3.md"
CLI_BUDGET_FIXTURE_PATH = REPO_ROOT / "fixtures" / "semantic" / "hej-cli-budget.md"


def _load_fixture_with_output(semantic_fixtures, output: str):
    text = FIXTURE_PATH.read_text(encoding="utf-8")
    before, rest = text.split("## Captured Output\n", 1)
    _, after = rest.split("\n## Expected Facts\n", 1)
    fixture, errors = semantic_fixtures.validate_fixture_text(
        f"{before}## Captured Output\n{output.strip()}\n\n## Expected Facts\n{after}"
    )
    assert errors == []
    assert fixture is not None
    return fixture


def _load_cli_budget_fixture_with_output(semantic_fixtures, output: str):
    text = CLI_BUDGET_FIXTURE_PATH.read_text(encoding="utf-8")
    before, rest = text.split("## Captured Output\n", 1)
    _, after = rest.split("\n## Tool Trace\n", 1)
    fixture, errors = semantic_fixtures.validate_fixture_text(
        f"{before}## Captured Output\n{output.strip()}\n\n## Tool Trace\n{after}"
    )
    assert errors == []
    assert fixture is not None
    return fixture


def test_passes_when_output_names_status_attention_and_exit_condition(semantic_eval, semantic_fixtures):
    fixture, errors = semantic_fixtures.load_fixture(FIXTURE_PATH)
    assert errors == []

    result = semantic_eval.evaluate_fixture(fixture, str(FIXTURE_PATH))

    assert result["status"] == "pass"
    assert result["failing_fact"] is None


def test_requires_expected_concrete_next_action_from_seeded_artifacts(semantic_eval, semantic_fixtures):
    fixture = _load_fixture_with_output(
        semantic_fixtures,
        """
        ─── status ─────────────────────────────
        ≡ plan active · Tasks 1-2 complete · Task 3 pending

        ─── attention ──────────────────────────
        → highest-priority action: Task 3: Add Hej Routing Fixture

        ─── next ───────────────────────────────
        suggested -> /realisera (Execute the active plan)
        exit condition: fixture passes only when status, attention item, and concrete Task 3 next action are present.
        """,
    )

    result = semantic_eval.evaluate_fixture(fixture, str(FIXTURE_PATH))

    assert result["status"] == "fail"
    assert result["failing_fact"]["fact"] == "required_output[2]"


def test_fails_when_output_routes_to_generic_skill_without_artifact_item(semantic_eval, semantic_fixtures):
    fixture = _load_fixture_with_output(
        semantic_fixtures,
        """
        ─── status ─────────────────────────────
        ≡ plan active · Tasks 1-2 complete · Task 3 pending

        ─── attention ──────────────────────────
        active plan needs work

        ─── next ───────────────────────────────
        suggested -> /realisera
        exit condition: fixture passes only when status, attention item, and concrete Task 3 next action are present.
        """,
    )

    result = semantic_eval.evaluate_fixture(fixture, str(FIXTURE_PATH))

    assert result["status"] == "fail"
    assert result["failing_fact"]["fact"] == "required_output[1]"


def test_fails_when_output_chooses_lower_priority_item(semantic_eval, semantic_fixtures):
    fixture = _load_fixture_with_output(
        semantic_fixtures,
        """
        ─── status ─────────────────────────────
        ≡ plan active · Tasks 1-2 complete · Task 3 pending

        ─── attention ──────────────────────────
        → highest-priority action: Task 4: Add Unit-Level Assertion Tests

        ─── next ───────────────────────────────
        suggested -> /realisera (Execute Task 4: Add Unit-Level Assertion Tests)
        exit condition: fixture passes only when status, attention item, and concrete Task 3 next action are present.
        """,
    )

    result = semantic_eval.evaluate_fixture(fixture, str(FIXTURE_PATH))

    assert result["status"] == "fail"
    assert result["failing_fact"]["fact"] == "required_output[1]"


def test_cli_budget_fixture_requires_composite_hej_tool_call(semantic_eval, semantic_fixtures):
    fixture, errors = semantic_fixtures.load_fixture(CLI_BUDGET_FIXTURE_PATH)
    assert errors == []

    result = semantic_eval.evaluate_fixture(fixture, str(CLI_BUDGET_FIXTURE_PATH))

    assert result["status"] == "pass"
    facts = {fact["fact"]: fact for fact in result["checked_facts"]}
    assert facts["required_tool_calls[0]"]["status"] == "pass"
    for index in range(10):
        assert facts[f"forbidden_tool_calls[{index}]"]["status"] == "pass"
    assert facts["tool_call_counts[agentera hej]"]["status"] == "pass"


def test_cli_budget_fixture_rejects_raw_cli_output(semantic_eval, semantic_fixtures):
    fixture = _load_cli_budget_fixture_with_output(
        semantic_fixtures,
        """
        agentera hej
        mode: returning
        plan: status=active | progress=4/6
        next_action:
        - object=PLAN Task 5: Add Tool-Budget And Regression Tests | capability=orkestrera | reason=first pending plan task

        ⌂ hej · waiting
        """,
    )

    result = semantic_eval.evaluate_fixture(fixture, str(CLI_BUDGET_FIXTURE_PATH))

    assert result["status"] == "fail"
    assert result["failing_fact"]["fact"] == "required_output[0]"


def test_cli_budget_fixture_rejects_individual_state_command(semantic_eval, semantic_fixtures):
    text = CLI_BUDGET_FIXTURE_PATH.read_text(encoding="utf-8")
    text = text.replace(
        '"uv run scripts/agentera hej"',
        '"uv run scripts/agentera hej",\n    "uv run scripts/agentera plan"',
    )
    fixture, errors = semantic_fixtures.validate_fixture_text(text)
    assert errors == []

    result = semantic_eval.evaluate_fixture(fixture, str(CLI_BUDGET_FIXTURE_PATH))

    assert result["status"] == "fail"
    assert result["failing_fact"]["fact"] == "forbidden_tool_calls[0]"


def test_cli_budget_fixture_rejects_duplicate_hej_state_call(semantic_eval, semantic_fixtures):
    text = CLI_BUDGET_FIXTURE_PATH.read_text(encoding="utf-8")
    text = text.replace(
        '"uv run scripts/agentera hej"',
        '"uv run scripts/agentera hej",\n    "uv run scripts/agentera hej"',
    )
    fixture, errors = semantic_fixtures.validate_fixture_text(text)
    assert errors == []

    result = semantic_eval.evaluate_fixture(fixture, str(CLI_BUDGET_FIXTURE_PATH))

    assert result["status"] == "fail"
    assert result["failing_fact"]["fact"] == "tool_call_counts[agentera hej]"
