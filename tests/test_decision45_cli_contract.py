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
        "source_contract",
    ]
    field_selection = contract["field_selection"]
    assert field_selection["status"] == "implemented_sparse_response_layer"
    assert field_selection["syntax"] == "--fields FIELD[,FIELD...]"
    assert field_selection["retained_context"] == ["command", "status"]
    assert field_selection["fields_by_command"]["routine_state_commands"]["fields"] == contract["structured_output"]["envelope"]["routine_state_commands"]["fields"]
    assert field_selection["fields_by_command"]["hej"]["fields"] == contract["structured_output"]["envelope"]["hej"]["fields"]
    assert "evidence_context" in field_selection["fields_by_command"]["hej"]["fields"]
    assert "raw_yaml" not in field_selection["fields_by_command"]["hej"]["fields"]
    assert contract["input_hardening"]["status"] == "implemented_boundary_validation"
    assert "Do not add describe behavior." in contract["non_goals_for_task_1"]
    assert "Do not harden executable inputs." in contract["non_goals_for_task_1"]


def test_startup_completeness_contract_preserves_cli_vocabulary():
    contract = _contract()
    startup = contract["startup_completeness"]
    hej_contract = contract["structured_output"]["envelope"]["hej"]["source_contract"]["capability_startup"]

    assert startup["status"] == "implemented_complete_startup_envelope"
    assert startup["owning_command"] == "hej"
    assert startup["preserves_routine_state_commands"] is True
    assert startup["slash_route_alias_cli_commands_added"] is False
    assert startup["complete_output_requires"] == {
        "complete_for_capability_startup": True,
        "raw_artifact_reads_required": False,
    }
    assert startup["incomplete_output_requires"] == ["missing_state", "confidence_caveats", "cli_fallback"]
    assert startup["current_cli_fallback"] == [
        "agentera plan --format json",
        "agentera docs --format json",
        "agentera progress --format json",
    ]
    assert "capability_context" in hej_contract["fields"]
    assert "--capability-context <capability>" in hej_contract["capability_context_semantics"]
    assert "orchestration_context" in contract["structured_output"]["envelope"]["hej"]["fields"]
    assert "must not introduce `agentera orkestrera`" in hej_contract["orchestration_context_semantics"]
    assert "closeout_context" in contract["structured_output"]["envelope"]["hej"]["fields"]
    assert "evidence_context" in contract["structured_output"]["envelope"]["hej"]["fields"]
    assert "--capability-context dokumentera" in hej_contract["closeout_context_semantics"]
    assert "local metadata/tag versus publication boundary state" in hej_contract["closeout_context_semantics"]
    assert "must not introduce `agentera dokumentera`" in hej_contract["closeout_context_semantics"]
    assert "--capability-context inspektera" in hej_contract["evidence_context_semantics"]
    assert "provenance pointers" in hej_contract["evidence_context_semantics"]
    assert "non-empty evidence flags" in hej_contract["evidence_context_semantics"]
    assert "must not introduce `agentera inspektera`" in hej_contract["evidence_context_semantics"]
    assert hej_contract["evidence_context_target_contract"] == "evidence_context_target_contract"
    assert hej_contract["current_status"] == "complete"
    assert hej_contract["current_missing_state"] == []
    assert startup["state_families_added"] == [
        "plan task details, dependencies, acceptance criteria, and evidence summaries",
        "docs artifact mapping and source-contract completeness metadata",
        "latest progress verification metadata needed for Orkestrera evaluation",
    ]
    assert "absence metadata" in startup["empty_state_behavior"]
    assert "v1_migration" in startup["repair_guidance_behavior"]
    assert "Do not add Decision 43 slash-route aliases" in startup["non_goals"][0]


def test_evidence_context_target_contract_records_task_1_inventory_and_selection_rules():
    contract = _contract()
    evidence = contract["evidence_context_target_contract"]

    assert evidence["status"] == "task_1_design_contract"
    assert evidence["planned_invocation"] == "agentera hej --format json --capability-context inspektera"
    assert evidence["implementation_status"] == "implemented_provenance_and_boundary_contract"
    assert evidence["status_vocabulary"]["protected_and_version_boundaries"] == [
        "verified_local",
        "not_checked_by_design",
        "requires_manual_check",
        "unavailable",
    ]
    assert evidence["inventory"]["archive_boundary"]["verified_header_status"] == "complete"
    assert "profile-derived state is stale; record as caveat and do not refresh profile" in evidence["inventory"]["stale_state_caveats"]

    selection = evidence["target_selection"]
    assert selection["no_raw_plan_or_progress_reads_required"] is True
    assert [item["selection_reason"] for item in selection["selection_order"]] == [
        "in_progress_task",
        "first_dependency_ready_pending_task",
        "latest_completed_task_with_evidence",
        "no_plan_task_target",
    ]
    assert selection["no_target_behavior"]["raw_artifact_reads_required"] is False

    required = evidence["evidence_matrix"]["required_for_normal_task_evaluation"]
    optional = evidence["evidence_matrix"]["optional_or_caveated_for_normal_task_evaluation"]
    assert {item["family"] for item in required} >= {
        "evaluation_target",
        "plan_criteria",
        "progress_verification",
        "docs_state",
        "health_state",
        "todo_state",
        "source_contract",
    }
    assert {item["family"] for item in optional} >= {
        "decisions_context",
        "vision_context",
        "profile_context",
        "protected_state_checks",
        "version_checks",
    }
    assert "agentera inspektera" in evidence["prohibited_actions"]
    fallback_reasons = [item["reason"] for item in evidence["inventory"]["last_resort_raw_fallbacks"]]
    assert not any("until Task 4 updates it" in reason for reason in fallback_reasons)
    assert any(
        item.get("raw_artifact_reads_required_for_startup") is False
        and "complete evidence_context covers normal evaluation startup" in item["reason"]
        for item in evidence["inventory"]["last_resort_raw_fallbacks"]
    )


def test_plan_source_contract_closes_plan_artifact_fallback():
    contract = _contract()
    plan_contract = contract["structured_output"]["envelope"]["routine_state_commands"]["source_contract"]["plan"]

    assert plan_contract["status"] == "implemented_complete_plan_artifact_envelope"
    assert "complete_for_plan_artifact" in plan_contract["fields"]
    assert "raw_artifact_reads_required" in plan_contract["fields"]
    assert "agents should not read `.agentera/plan.yaml` defensively" in plan_contract["complete_semantics"]
