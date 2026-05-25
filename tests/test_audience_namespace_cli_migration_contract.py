"""Audience namespace CLI migration contract coverage."""

from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "references/cli/agent-ready-state-contract.yaml"
MIGRATION_PATH = REPO_ROOT / "references/cli/audience-namespace-cli-migration.yaml"


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_migration_contract_is_linked_from_parent_contract():
    contract = _load(CONTRACT_PATH)
    addendum = contract["linked_addenda"]["audience_namespace_cli_migration"]

    assert addendum["path"] == "references/cli/audience-namespace-cli-migration.yaml"
    assert addendum["status"] == "target_design_contract"
    assert "prime/hej" in addendum["purpose"]
    assert "state plan" in addendum["purpose"]


def test_migration_contract_documents_target_command_tree_and_audience_tags():
    migration = _load(MIGRATION_PATH)

    assert migration["implementation_status"] == "design_only"
    assert migration["top_level_commands"]["control_plane"]["prime"]["replaces"] == "hej"
    assert migration["top_level_commands"]["control_plane"]["schema"]["replaces"] == "describe"
    assert migration["top_level_commands"]["capabilities"]["excludes"] == "hej"
    assert migration["top_level_commands"]["capabilities"]["count"] == 11
    assert migration["audience_namespaces"]["state"]["audience"] == ["agent"]
    assert migration["audience_namespaces"]["report"]["audience"] == ["user"]
    assert migration["audience_namespaces"]["check"]["audience"] == ["maintainer"]
    assert "query" in migration["audience_namespaces"]["state"]["subcommands"]
    assert migration["help_grouping"]["maintainer"] == ["check"]


def test_migration_contract_reconciles_decision_59_and_decision_45():
    migration = _load(MIGRATION_PATH)
    boundary = migration["prime_hej_schema_migration_boundary"]
    d59 = migration["decision_reconciliation"]["decision_59"]
    d45 = migration["decision_reconciliation"]["decision_45"]

    assert "prime --context" in boundary["prime_absorbs_hej"]["prime_context_unchanged"]
    assert boundary["schema_replaces_describe"]["canonical"] == "agentera schema [--format json|yaml]"
    assert "prime --context" in d59["prime_context_seam"]
    assert "state <name>" in d45["routine_state_aliases"]
    assert "unchanged" in d45["routine_state_aliases"]


def test_migration_contract_distinguishes_plan_routing_surfaces():
    migration = _load(MIGRATION_PATH)
    plan = migration["plan_routing_distinction"]

    assert plan["slash_route"]["invocation"] == "/agentera plan"
    assert plan["slash_route"]["routes_to"] == "planera"
    assert plan["state_read"]["invocation"] == "agentera state plan"
    assert plan["state_read"]["legacy_alias"] == "agentera plan"
    assert plan["capability_top"]["invocation"] == "agentera planera"
    assert "prime --context planera" in plan["agent_guidance"]
