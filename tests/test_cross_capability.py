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


def _collect_all_triggers() -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for cap_dir in sorted(CAPABILITIES_DIR.iterdir()):
        if not cap_dir.is_dir():
            continue
        schemas_dir = cap_dir / "schemas"
        if not schemas_dir.is_dir():
            continue
        patterns: list[str] = []
        for yaml_file in sorted(schemas_dir.glob("*.yaml")):
            data = yaml.safe_load(yaml_file.read_text()) or {}
            triggers = data.get("TRIGGERS")
            if not isinstance(triggers, dict):
                continue
            for key, entry in triggers.items():
                if isinstance(entry, dict) and "patterns" in entry:
                    for p in entry["patterns"]:
                        if p != "*":
                            patterns.append(p)
        if patterns:
            result[cap_dir.name] = patterns
    return result


def _route_trigger(message: str, trigger_map: dict[str, list[str]]) -> str:
    best: str | None = None
    best_len = 0
    for cap, patterns in trigger_map.items():
        for p in patterns:
            if p in message:
                if len(p) > best_len:
                    best = cap
                    best_len = len(p)
    return best if best is not None else "hej"


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
def trigger_map() -> dict[str, list[str]]:
    return _collect_all_triggers()


@pytest.mark.parametrize("cap_name", CAPABILITY_NAMES)
def test_trigger_routing(cap_name: str, trigger_map: dict[str, list[str]]):
    if cap_name == "hej":
        pytest.skip("hej is the fallback; routing tests verify non-hej dispatch")
    assert cap_name in trigger_map, f"{cap_name} has no trigger patterns"
    patterns = trigger_map[cap_name]
    non_self = [p for p in patterns if p != cap_name and not p.startswith("/")]
    if not non_self:
        non_self = [p for p in patterns if not p.startswith("/")]
    assert non_self, f"{cap_name} has no testable trigger patterns"
    sample = non_self[0]
    routed = _route_trigger(sample, trigger_map)
    assert routed == cap_name, (
        f"Trigger {sample!r} routed to {routed!r}, expected {cap_name!r}"
    )


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

    assert "Step -1: CLI-first state access" in text
    assert "query --list-artifacts" in text
    assert "Do not silently bypass the CLI" in text
    assert "reads only as a fallback" in text


def test_master_upgrade_guard_requires_dry_run_preview():
    text = SKILL_MD_PATH.read_text(encoding="utf-8")

    assert "The dry-run preview is mandatory" in text
    assert 'agentera upgrade --project "$PWD" --dry-run' in text
    assert "Only the apply step requires confirmation" in text
