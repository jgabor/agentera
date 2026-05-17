"""Focused tests for the schema-backed routing test Interface."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from routing_test_interface import (
    DirectRoute,
    evaluate_route,
    load_direct_routes,
    load_routing_policy,
    load_trigger_patterns,
)


DECISION_43_ALIASES = {
    "status": "hej",
    "vision": "visionera",
    "discuss": "resonera",
    "research": "inspirera",
    "plan": "planera",
    "build": "realisera",
    "optimize": "optimera",
    "audit": "inspektera",
    "document": "dokumentera",
    "profile": "profilera",
    "design": "visualisera",
    "orchestrate": "orkestrera",
}
DECISION_43_CAPABILITIES = frozenset(DECISION_43_ALIASES.values())


def _write_capability(
    root: Path,
    name: str,
    *entries: dict,
) -> None:
    schemas_dir = root / name / "schemas"
    schemas_dir.mkdir(parents=True)
    triggers = {index: entry for index, entry in enumerate(entries, start=1)}
    (schemas_dir / "triggers.yaml").write_text(
        yaml.safe_dump({"TRIGGERS": triggers}, sort_keys=False)
    )


def _assert_decision_43_alias_routes(
    direct_routes: tuple[DirectRoute, ...] | None = None,
) -> None:
    triggers = load_trigger_patterns()

    for alias, capability in DECISION_43_ALIASES.items():
        result = evaluate_route(
            f"/agentera {alias}",
            triggers,
            direct_routes=direct_routes,
        )

        assert result.kind == "route"
        assert result.capability == capability
        assert result.direct_route is not None
        assert result.direct_route.source == "alias"
        assert result.direct_route.route == alias


def test_loads_schema_trigger_metadata_for_routing_interface():
    policy = load_routing_policy()
    triggers = load_trigger_patterns()

    fallback = next(trigger for trigger in triggers if trigger.pattern == "*")
    realisera = next(trigger for trigger in triggers if trigger.pattern == "run a dev cycle")

    assert realisera.capability == "realisera"
    assert realisera.priority == "medium"
    assert realisera.priority_weight == policy.priority_weights["medium"]
    assert realisera.trigger_id == "T2"
    assert realisera.description
    assert realisera.minimum_threshold == policy.minimum_threshold
    assert realisera.minimum_threshold_weight == policy.minimum_threshold_weight
    assert realisera.fallback is False
    assert realisera.disambiguation_key == (policy.priority_weights["medium"], "realisera")
    assert realisera.source.name == "triggers.yaml"

    assert fallback.capability == "hej"
    assert fallback.priority == "low"
    assert fallback.fallback is True


def test_priority_weights_are_derived_from_contract_priority_order():
    policy = load_routing_policy()

    assert list(policy.priority_weights) == ["high", "medium", "low"]
    assert policy.priority_weights == {"high": 3, "medium": 2, "low": 1}
    assert policy.minimum_threshold == "medium"
    assert policy.minimum_threshold_weight == policy.priority_weights["medium"]


def test_loads_decision_43_primary_aliases_for_direct_routing():
    aliases = {
        route.route: route.capability
        for route in load_direct_routes()
        if route.source == "alias"
    }

    assert aliases == DECISION_43_ALIASES


def test_canonical_capability_names_still_route_directly():
    triggers = load_trigger_patterns()
    canonical_routes = {
        route.route: route.capability
        for route in load_direct_routes()
        if route.source == "canonical"
    }

    assert canonical_routes == {
        capability: capability
        for capability in DECISION_43_CAPABILITIES
    }

    for capability in DECISION_43_CAPABILITIES:
        result = evaluate_route(f"/agentera {capability}", triggers)

        assert result.kind == "route"
        assert result.capability == capability
        assert result.direct_route is not None
        assert result.direct_route.source == "canonical"


def test_canonical_capability_prefix_with_topic_routes_directly():
    triggers = load_trigger_patterns()

    examples = {
        "resonera decide whether to keep this API": "resonera",
        "/agentera resonera decide whether to keep this API": "resonera",
        "planera break down the plugin hook work": "planera",
        "orkestrera execute the active plan": "orkestrera",
    }

    for message, capability in examples.items():
        result = evaluate_route(message, triggers)

        assert result.kind == "route"
        assert result.capability == capability
        assert result.direct_route is not None
        assert result.direct_route.source == "canonical"


def test_bare_hej_routes_directly_to_hej_capability():
    result = evaluate_route("hej", load_trigger_patterns())

    assert result.kind == "route"
    assert result.capability == "hej"
    assert result.direct_route is not None
    assert result.direct_route.source == "canonical"


def test_exact_agentera_alias_routes_without_trigger_disambiguation():
    _assert_decision_43_alias_routes()


def test_decision_43_alias_target_drift_fails_validation():
    drifted_routes = tuple(
        DirectRoute(route="build", capability="optimera", source="alias")
        if route.route == "build" and route.source == "alias"
        else route
        for route in load_direct_routes()
    )

    with pytest.raises(AssertionError):
        _assert_decision_43_alias_routes(drifted_routes)


def test_secondary_request_wording_routes_through_triggers_not_aliases():
    triggers = load_trigger_patterns()
    direct_aliases = {
        route.route
        for route in load_direct_routes()
        if route.source == "alias"
    }

    examples = {
        "/agentera deliberate": "resonera",
        "/agentera brainstorm": "resonera",
        "/agentera rubber duck": "resonera",
        "/agentera brief": "hej",
        "/agentera what's next": "hej",
    }

    secondary_phrases = {
        phrase.removeprefix("/agentera ")
        for phrase in examples
    }
    assert not (set(examples) | secondary_phrases) & direct_aliases
    for phrase, capability in examples.items():
        result = evaluate_route(phrase, triggers)
        assert result.kind == "route"
        assert result.capability == capability
        assert result.direct_route is None


def test_discussion_wording_with_concrete_work_intent_disambiguates():
    triggers = load_trigger_patterns()

    examples = {
        "brainstorm build the next feature": {"resonera", "realisera"},
        "brainstorm what can I take from this": {"resonera", "inspirera"},
        "rubber duck audit the codebase": {"resonera", "inspektera"},
        "deliberate document this": {"resonera", "dokumentera"},
    }

    for phrase, capabilities in examples.items():
        result = evaluate_route(phrase, triggers)
        assert result.kind == "disambiguate"
        assert result.direct_route is None
        assert {match.capability for match in result.matches} == capabilities


def test_non_exact_alias_words_preserve_concrete_trigger_intent():
    triggers = load_trigger_patterns()

    build_everything = evaluate_route("build everything", triggers)
    run_the_plan = evaluate_route("run the plan", triggers)

    assert build_everything.kind == "route"
    assert build_everything.capability == "orkestrera"
    assert build_everything.direct_route is None
    assert run_the_plan.kind == "route"
    assert run_the_plan.capability == "orkestrera"
    assert run_the_plan.direct_route is None


def test_same_priority_tier_reports_disambiguation(tmp_path: Path):
    _write_capability(
        tmp_path,
        "alpha",
        {
            "id": "T1",
            "description": "alpha medium trigger",
            "priority": "medium",
            "patterns": ["shared phrase"],
        },
    )
    _write_capability(
        tmp_path,
        "beta",
        {
            "id": "T1",
            "description": "beta medium trigger",
            "priority": "medium",
            "patterns": ["shared phrase"],
        },
    )

    result = evaluate_route("please handle shared phrase", load_trigger_patterns(tmp_path))

    assert result.kind == "disambiguate"
    assert result.capability is None
    assert {match.capability for match in result.matches} == {"alpha", "beta"}
    assert {match.highest_priority for match in result.matches} == {"medium"}


def test_no_match_at_minimum_threshold_reports_hej_fallback(tmp_path: Path):
    _write_capability(
        tmp_path,
        "alpha",
        {
            "id": "T1",
            "description": "low trigger below routing threshold",
            "priority": "low",
            "patterns": ["weak signal"],
        },
    )
    _write_capability(
        tmp_path,
        "hej",
        {
            "id": "T1",
            "description": "fallback trigger",
            "priority": "low",
            "patterns": ["*"],
            "fallback": True,
        },
    )

    result = evaluate_route("weak signal", load_trigger_patterns(tmp_path))


    assert result.kind == "fallback"
    assert result.capability == "hej"
    assert result.fallback_capability == "hej"
    assert result.threshold == "medium"
    assert result.matches[0].capability == "alpha"
    assert result.matches[0].highest_priority == "low"


def test_unmatched_agentera_route_still_reports_hej_fallback():
    result = evaluate_route("/agentera zqvx-route-miss", load_trigger_patterns())

    assert result.kind == "fallback"
    assert result.capability == "hej"
    assert result.fallback_capability == "hej"
    assert result.direct_route is None
