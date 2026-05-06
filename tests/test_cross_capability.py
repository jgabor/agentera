"""Cross-capability reference verification tests.

Validates three dimensions of cross-capability integrity:
1. Protocol ID resolution: every stable ID referenced in capability schemas
   resolves to a valid entry in protocol.yaml.
2. Trigger routing: every capability's trigger patterns route to that capability
   (not hej fallback) per the master SKILL.md routing logic.
3. Inter-capability prose references: every capability name mentioned in a
   prose.md file corresponds to an existing capability directory.

Test proportionality: 1 test per capability for routing, 1 test for protocol
reference resolution, plus collective checks for prose cross-references.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml
import pytest

from routing_test_interface import (
    TriggerPattern,
    evaluate_route,
    load_routing_policy,
    load_trigger_patterns,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"
SKILL_MD_PATH = REPO_ROOT / "skills" / "agentera" / "SKILL.md"

CAPABILITY_NAMES = sorted(
    d.name for d in CAPABILITIES_DIR.iterdir() if d.is_dir()
)

PROTOCOL_ID_RE = re.compile(r"\b([A-Z]{2}\d+)\b")

KNOWN_CAPABILITY_NAMES = frozenset(CAPABILITY_NAMES)


def _load_protocol_ids() -> set[str]:
    data = yaml.safe_load(PROTOCOL_PATH.read_text())
    ids: set[str] = set()
    for group_value in data.values():
        if isinstance(group_value, dict):
            for entry in group_value.values():
                if isinstance(entry, dict) and "id" in entry:
                    ids.add(entry["id"])
    return ids


def _extract_protocol_refs_from_schemas(cap_dir: Path) -> set[str]:
    refs: set[str] = set()
    schemas_dir = cap_dir / "schemas"
    if not schemas_dir.is_dir():
        return refs
    for yaml_file in schemas_dir.glob("*.yaml"):
        text = yaml_file.read_text()
        refs.update(PROTOCOL_ID_RE.findall(text))
    return refs


def _extract_capability_refs_from_prose(cap_dir: Path) -> set[str]:
    prose_path = cap_dir / "prose.md"
    if not prose_path.is_file():
        return set()
    text = prose_path.read_text()
    found: set[str] = set()
    for name in KNOWN_CAPABILITY_NAMES:
        if re.search(r"\b" + re.escape(name) + r"\b", text):
            found.add(name)
    return found


# ── Protocol ID resolution: 1 test per capability ──────────────────────

@pytest.fixture(scope="module")
def protocol_ids() -> set[str]:
    return _load_protocol_ids()


@pytest.mark.parametrize("cap_name", CAPABILITY_NAMES)
def test_protocol_refs_resolve(cap_name: str, protocol_ids: set[str]):
    cap_dir = CAPABILITIES_DIR / cap_name
    refs = _extract_protocol_refs_from_schemas(cap_dir)
    unresolved = refs - protocol_ids
    assert unresolved == set(), (
        f"{cap_name}: unresolved protocol IDs: {sorted(unresolved)}"
    )


# ── Trigger routing: 1 test per capability ─────────────────────────────

@pytest.fixture(scope="module")
def schema_triggers() -> tuple[TriggerPattern, ...]:
    return load_trigger_patterns()


@pytest.mark.parametrize("cap_name", CAPABILITY_NAMES)
def test_high_priority_trigger_routes_to_capability(
    cap_name: str,
    schema_triggers: tuple[TriggerPattern, ...],
):
    high_trigger = next(
        (
            trigger
            for trigger in schema_triggers
            if trigger.capability == cap_name
            and trigger.priority == "high"
            and not trigger.pattern.startswith("/")
        ),
        None,
    )
    assert high_trigger is not None, f"{cap_name} has no high-priority trigger"

    routed = evaluate_route(f"please use {high_trigger.pattern}", schema_triggers)

    assert routed.kind == "route"
    assert routed.capability == cap_name
    assert routed.score == high_trigger.priority_weight


def test_routing_loads_all_current_triggers_from_trigger_schemas(
    schema_triggers: tuple[TriggerPattern, ...],
):
    expected_patterns = []
    for cap_dir in sorted(path for path in CAPABILITIES_DIR.iterdir() if path.is_dir()):
        triggers_path = cap_dir / "schemas" / "triggers.yaml"
        data = yaml.safe_load(triggers_path.read_text()) or {}
        for entry_key, entry in data["TRIGGERS"].items():
            for pattern in entry["patterns"]:
                expected_patterns.append((cap_dir.name, str(entry_key), pattern))

    loaded_patterns = [
        (trigger.capability, trigger.entry_key, trigger.pattern)
        for trigger in schema_triggers
    ]

    assert loaded_patterns == expected_patterns
    assert {trigger.source.name for trigger in schema_triggers} == {"triggers.yaml"}


def test_priority_scoring_and_threshold_use_schema_metadata(
    schema_triggers: tuple[TriggerPattern, ...],
):
    policy = load_routing_policy()
    high = next(
        trigger
        for trigger in schema_triggers
        if trigger.capability == "realisera" and trigger.pattern == "realisera"
    )
    medium = next(
        trigger
        for trigger in schema_triggers
        if trigger.capability == "hej" and trigger.pattern == "hello"
    )
    low = next(trigger for trigger in schema_triggers if trigger.pattern == "*")

    assert high.priority_weight == policy.priority_weights["high"]
    assert medium.priority_weight == policy.priority_weights["medium"]
    assert low.priority_weight == policy.priority_weights["low"]
    assert medium.priority_weight == policy.minimum_threshold_weight
    assert low.priority_weight < policy.minimum_threshold_weight
    assert low.fallback is True

    high_result = evaluate_route(high.pattern, schema_triggers)
    medium_result = evaluate_route(medium.pattern, schema_triggers)
    low_result = evaluate_route("schema metadata fallback exercise", schema_triggers)

    assert high_result.kind == "route"
    assert high_result.capability == "realisera"
    assert high_result.score == policy.priority_weights["high"]
    assert medium_result.kind == "route"
    assert medium_result.capability == "hej"
    assert medium_result.score == policy.minimum_threshold_weight
    assert low_result.kind == "fallback"
    assert low_result.capability == "hej"


def test_same_tier_matches_disambiguate_explicitly(
    schema_triggers: tuple[TriggerPattern, ...],
):
    result = evaluate_route("refine the vision", schema_triggers)

    assert result.kind == "disambiguate"
    assert result.capability is None
    assert {match.capability for match in result.matches} == {"realisera", "visionera"}
    assert {match.highest_priority for match in result.matches} == {"medium"}


def test_unmatched_text_falls_back_to_hej(schema_triggers: tuple[TriggerPattern, ...]):
    result = evaluate_route("zqvx schema-backed route miss", schema_triggers)

    assert result.kind == "fallback"
    assert result.capability == "hej"
    assert result.fallback_capability == "hej"
    assert result.matches == ()


# ── Inter-capability prose references ──────────────────────────────────

@pytest.mark.parametrize("cap_name", CAPABILITY_NAMES)
def test_prose_capability_refs_exist(cap_name: str):
    cap_dir = CAPABILITIES_DIR / cap_name
    refs = _extract_capability_refs_from_prose(cap_dir)
    for ref_name in refs:
        assert (CAPABILITIES_DIR / ref_name).is_dir(), (
            f"{cap_name}/prose.md references '{ref_name}' "
            f"but capabilities/{ref_name}/ does not exist"
        )


def test_master_skill_requires_cli_first_state_access():
    text = SKILL_MD_PATH.read_text(encoding="utf-8")

    assert "Step -1: Top-level CLI-first state access" in text
    assert "agentera hej" in text
    assert "query --list-artifacts" in text
    assert "query <artifact-name> --format json|yaml" in text
    assert "Do not silently bypass the CLI" in text
    assert "reads only as a fallback" in text
    assert "Do not run individual `plan`, `progress`, `health`" in text


def test_routine_capability_guidance_uses_top_level_state_commands():
    realisera = (CAPABILITIES_DIR / "realisera" / "prose.md").read_text(encoding="utf-8")
    optimera = (CAPABILITIES_DIR / "optimera" / "prose.md").read_text(encoding="utf-8")
    hej = (CAPABILITIES_DIR / "hej" / "prose.md").read_text(encoding="utf-8")

    assert "scripts/agentera progress" in realisera
    assert "query progress" not in realisera
    assert "scripts/agentera experiments" in optimera
    assert "query experiments" not in optimera
    assert 'uv run "$RESOLVED_AGENTERA_HOME/scripts/agentera" hej' in hej
    assert "bundle freshness gap" in hej
    assert "advanced/custom inspection only" in hej


def test_master_upgrade_guard_requires_dry_run_preview():
    text = SKILL_MD_PATH.read_text(encoding="utf-8")

    assert "The dry-run preview is mandatory" in text
    assert 'agentera upgrade --project "$PWD" --dry-run' in text
    assert "Only the apply step requires confirmation" in text
