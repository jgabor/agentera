"""Decision 45 Agent-ready state CLI contract coverage."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "references/cli/agent-ready-state-contract.yaml"


def _contract() -> dict:
    return yaml.safe_load(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_decision_45_contract_preserves_routine_state_commands():
    contract = _contract()

    assert contract["routine_state_commands"]["status"] == "stable"
    assert contract["routine_state_commands"]["commands"] == [
        "hej",
        "plan",
        "progress",
        "health",
        "todo",
        "decisions",
        "docs",
        "objective",
        "experiments",
        "query",
    ]


def test_decision_45_contract_keeps_route_aliases_out_of_cli_commands():
    contract = _contract()
    aliases = contract["slash_route_aliases"]

    assert aliases["status"] == "excluded_from_cli_commands"
    assert aliases["aliases"]["status"] == "hej"
    assert aliases["aliases"]["build"] == "realisera"
    assert aliases["aliases"]["audit"] == "inspektera"
    assert aliases["aliases"]["document"] == "dokumentera"
    assert "not CLI state" in aliases["rationale"]


def test_decision_45_contract_separates_doctor_from_project_health():
    contract = _contract()
    doctor = contract["doctor"]

    assert doctor["status"] == "implemented_hard_rename"
    assert doctor["command"] == "doctor"
    assert doctor["removed_command"] == "bundle-status"
    assert doctor["compatibility_alias"] == "forbidden"
    assert "project artifact health" in doctor["excludes"]
    assert doctor["adjacent_surfaces"]["project_artifact_health"] == "agentera health"
    assert doctor["adjacent_surfaces"]["codebase_audit"] == "/agentera audit routes to inspektera"


def test_decision_45_contract_classifies_later_task_boundaries():
    contract = _contract()

    assert contract["describe"]["status"] == "implemented_runtime_introspection"
    assert contract["structured_output"]["status"] == "implemented_for_routine_state_commands"
    assert contract["structured_output"]["envelope"]["routine_state_commands"]["fields"] == [
        "command",
        "status",
        "entries",
        "counts",
        "source",
        "filters",
        "summary",
    ]
    field_selection = contract["field_selection"]
    assert field_selection["status"] == "implemented_sparse_response_layer"
    assert field_selection["syntax"] == "--fields FIELD[,FIELD...]"
    assert field_selection["retained_context"] == ["command", "status"]
    assert field_selection["fields_by_command"]["routine_state_commands"]["fields"] == contract["structured_output"]["envelope"]["routine_state_commands"]["fields"]
    assert field_selection["fields_by_command"]["hej"]["fields"] == contract["structured_output"]["envelope"]["hej"]["fields"]
    assert contract["input_hardening"]["status"] == "implemented_boundary_validation"
    assert "Do not add describe behavior." in contract["non_goals_for_task_1"]
    assert "Do not harden executable inputs." in contract["non_goals_for_task_1"]
