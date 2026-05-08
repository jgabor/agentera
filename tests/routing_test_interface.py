"""Schema-backed routing helper for Agentera capability tests.

This module is test infrastructure only. It models the SKILL.md natural-language
routing seam using capability trigger schemas plus the loaded capability schema
contract, so routing tests do not re-encode substring-length heuristics.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Literal

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
CONTRACT_PATH = REPO_ROOT / "skills" / "agentera" / "capability_schema_contract.yaml"
CONTRACT_MODULE = REPO_ROOT / "scripts" / "capability_contract.py"

RouteKind = Literal["route", "disambiguate", "fallback"]


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


capability_contract = _load_module("capability_contract_routing_tests", CONTRACT_MODULE)


@dataclass(frozen=True)
class RoutingPolicy:
    priority_weights: dict[str, int]
    minimum_threshold: str
    minimum_threshold_weight: int
    fallback_capability: str


@dataclass(frozen=True)
class DirectRoute:
    route: str
    capability: str
    source: Literal["canonical", "alias"]


@dataclass(frozen=True)
class TriggerPattern:
    pattern: str
    priority: str
    priority_weight: int
    capability: str
    trigger_id: str
    description: str
    fallback: bool
    disambiguation_key: tuple[int, str]
    minimum_threshold: str
    minimum_threshold_weight: int
    source: Path
    entry_key: str


@dataclass(frozen=True)
class CapabilityMatch:
    capability: str
    score: int
    highest_priority: str
    highest_priority_weight: int
    patterns: tuple[TriggerPattern, ...]


@dataclass(frozen=True)
class RoutingResult:
    kind: RouteKind
    capability: str | None
    score: int
    threshold: str
    threshold_weight: int
    fallback_capability: str
    matches: tuple[CapabilityMatch, ...]
    direct_route: DirectRoute | None = None


def load_routing_policy(contract_path: Path = CONTRACT_PATH) -> RoutingPolicy:
    """Derive routing weights from the schema contract priority ordering."""

    contract = capability_contract.load_capability_schema_contract(contract_path)
    priorities = contract.trigger_priority_rules.allowed_values
    weights = {priority: len(priorities) - index for index, priority in enumerate(priorities)}
    threshold = priorities[1]
    return RoutingPolicy(
        priority_weights=weights,
        minimum_threshold=threshold,
        minimum_threshold_weight=weights[threshold],
        fallback_capability="hej",
    )


def load_direct_routes(
    capabilities_dir: Path = CAPABILITIES_DIR,
    contract_path: Path = CONTRACT_PATH,
) -> tuple[DirectRoute, ...]:
    """Load exact direct route names from canonical capabilities and aliases."""

    contract = capability_contract.load_capability_schema_contract(contract_path)
    canonical = tuple(
        DirectRoute(route=cap_dir.name, capability=cap_dir.name, source="canonical")
        for cap_dir in sorted(path for path in capabilities_dir.iterdir() if path.is_dir())
    )
    aliases = tuple(
        DirectRoute(route=alias.alias, capability=alias.capability, source="alias")
        for alias in contract.route_aliases.primary_aliases
    )
    if contract.route_aliases.canonical_name_precedence:
        return canonical + aliases
    return aliases + canonical


def _exact_direct_route(message: str, routes: tuple[DirectRoute, ...]) -> DirectRoute | None:
    text = message.strip().casefold()
    if not text:
        return None

    if text.startswith("/agentera "):
        text = text.removeprefix("/agentera ").strip()
        if not text or " " in text:
            return None

    for route in routes:
        if text == route.route.casefold():
            return route
    return None


def _pattern_matches(pattern: str, text: str) -> bool:
    normalized = pattern.casefold()
    escaped = re.escape(normalized)
    if normalized[:1].isalnum():
        escaped = rf"\b{escaped}"
    if normalized[-1:].isalnum():
        escaped = rf"{escaped}\b"
    return re.search(escaped, text) is not None


def load_trigger_patterns(
    capabilities_dir: Path = CAPABILITIES_DIR,
    contract_path: Path = CONTRACT_PATH,
) -> tuple[TriggerPattern, ...]:
    """Load all trigger patterns with routing-relevant schema metadata intact."""

    policy = load_routing_policy(contract_path)
    records: list[TriggerPattern] = []
    for cap_dir in sorted(path for path in capabilities_dir.iterdir() if path.is_dir()):
        triggers_path = cap_dir / "schemas" / "triggers.yaml"
        if not triggers_path.is_file():
            continue
        data = yaml.safe_load(triggers_path.read_text()) or {}
        triggers = data.get("TRIGGERS")
        if not isinstance(triggers, dict):
            continue
        for entry_key, entry in triggers.items():
            if not isinstance(entry, dict):
                continue
            priority = entry.get("priority")
            patterns = entry.get("patterns")
            if priority not in policy.priority_weights or not isinstance(patterns, list):
                continue
            for pattern in patterns:
                if not isinstance(pattern, str):
                    continue
                priority_weight = policy.priority_weights[priority]
                records.append(
                    TriggerPattern(
                        pattern=pattern,
                        priority=priority,
                        priority_weight=priority_weight,
                        capability=cap_dir.name,
                        trigger_id=str(entry.get("id", "")),
                        description=str(entry.get("description", "")),
                        fallback=entry.get("fallback") is True,
                        disambiguation_key=(priority_weight, cap_dir.name),
                        minimum_threshold=policy.minimum_threshold,
                        minimum_threshold_weight=policy.minimum_threshold_weight,
                        source=triggers_path,
                        entry_key=str(entry_key),
                    )
                )
    return tuple(records)


def evaluate_route(
    message: str,
    triggers: tuple[TriggerPattern, ...],
    policy: RoutingPolicy | None = None,
    direct_routes: tuple[DirectRoute, ...] | None = None,
) -> RoutingResult:
    """Evaluate a message and report route, disambiguation, or hej fallback."""

    policy = policy or load_routing_policy()
    direct_route = _exact_direct_route(message, direct_routes or load_direct_routes())
    if direct_route is not None:
        return RoutingResult(
            kind="route",
            capability=direct_route.capability,
            score=policy.priority_weights["high"],
            threshold=policy.minimum_threshold,
            threshold_weight=policy.minimum_threshold_weight,
            fallback_capability=policy.fallback_capability,
            matches=(),
            direct_route=direct_route,
        )

    text = message.casefold()
    by_capability: dict[str, list[TriggerPattern]] = {}
    for trigger in triggers:
        if trigger.fallback or trigger.pattern == "*":
            continue
        if _pattern_matches(trigger.pattern, text):
            by_capability.setdefault(trigger.capability, []).append(trigger)

    matches = tuple(
        sorted(
            (
                CapabilityMatch(
                    capability=capability,
                    score=sum(trigger.priority_weight for trigger in patterns),
                    highest_priority=max(
                        patterns,
                        key=lambda trigger: trigger.priority_weight,
                    ).priority,
                    highest_priority_weight=max(
                        trigger.priority_weight for trigger in patterns
                    ),
                    patterns=tuple(patterns),
                )
                for capability, patterns in by_capability.items()
            ),
            key=lambda match: (-match.highest_priority_weight, -match.score, match.capability),
        )
    )
    eligible = tuple(
        match for match in matches if match.highest_priority_weight >= policy.minimum_threshold_weight
    )
    if not eligible:
        return RoutingResult(
            kind="fallback",
            capability=policy.fallback_capability,
            score=0,
            threshold=policy.minimum_threshold,
            threshold_weight=policy.minimum_threshold_weight,
            fallback_capability=policy.fallback_capability,
            matches=matches,
        )

    top_tier = eligible[0].highest_priority_weight
    same_tier = tuple(match for match in eligible if match.highest_priority_weight == top_tier)
    if len(same_tier) > 1:
        return RoutingResult(
            kind="disambiguate",
            capability=None,
            score=max(match.score for match in same_tier),
            threshold=policy.minimum_threshold,
            threshold_weight=policy.minimum_threshold_weight,
            fallback_capability=policy.fallback_capability,
            matches=same_tier,
        )

    selected = eligible[0]
    return RoutingResult(
        kind="route",
        capability=selected.capability,
        score=selected.score,
        threshold=policy.minimum_threshold,
        threshold_weight=policy.minimum_threshold_weight,
        fallback_capability=policy.fallback_capability,
        matches=(selected,),
    )
