"""Focused tests for the schema-backed routing test Interface."""

from __future__ import annotations

from pathlib import Path

import yaml

from routing_test_interface import (
    evaluate_route,
    load_routing_policy,
    load_trigger_patterns,
)


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
