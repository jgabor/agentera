"""Acceptance tests for the orkestrera v2 capability port.

Covers: contract validation (1 pass + 1 fail), trigger routing pickup.
Proportional: 3 tests covering the acceptance criteria from PLAN.md Task 4.
"""

from __future__ import annotations

import importlib.util
import sys
import textwrap
from pathlib import Path
from types import ModuleType

import yaml

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
ORK_CAP_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities" / "orkestrera"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


validate_capability = _load_module("validate_capability", REPO_ROOT / "scripts" / "validate_capability.py")


# ---------------------------------------------------------------------------
# 1. Contract validation: PASS
# ---------------------------------------------------------------------------

def test_orkestrera_capability_passes_contract_validation():
    errors = validate_capability.validate_capability(ORK_CAP_DIR, REPO_ROOT / "skills/agentera/capability_schema_contract.yaml")
    assert errors == [], f"Expected no validation errors, got:\n" + "\n".join(errors)


def test_orkestrera_capability_passes_primitive_check():
    errors = validate_capability.check_primitive_references(ORK_CAP_DIR, PROTOCOL_PATH)
    assert errors == [], f"Expected no primitive errors, got:\n" + "\n".join(errors)


# ---------------------------------------------------------------------------
# 2. Contract validation: FAIL (broken capability)
# ---------------------------------------------------------------------------

def test_broken_orkestrera_fails_contract_validation(tmp_path):
    cap_dir = tmp_path / "broken"
    cap_dir.mkdir()
    schemas_dir = cap_dir / "schemas"
    schemas_dir.mkdir()

    (cap_dir / "prose.md").write_text("# Broken\n")
    (schemas_dir / "triggers.yaml").write_text(textwrap.dedent("""\
        TRIGGERS:
          bad_key:
            missing_id: true
    """))

    errors = validate_capability.validate_capability(cap_dir, REPO_ROOT / "skills/agentera/capability_schema_contract.yaml")
    assert len(errors) > 0, "Expected validation errors for broken capability"


# ---------------------------------------------------------------------------
# 3. Routing pickup: orkestrera trigger patterns match and route to orkestrera
# ---------------------------------------------------------------------------

def _collect_all_triggers() -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    if not CAPABILITIES_DIR.is_dir():
        return result
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
                    patterns.extend(entry["patterns"])
        if patterns:
            result[cap_dir.name] = patterns
    return result


def test_orkestrera_trigger_patterns_route_to_orkestrera():
    triggers = _collect_all_triggers()
    assert "orkestrera" in triggers, "orkestrera capability must have trigger patterns"

    ork_patterns = triggers["orkestrera"]

    expected_matches = [
        "orkestrera",
        "orchestrate",
        "run the plan",
        "execute the plan",
        "run all tasks",
        "dispatch skills",
        "multi-cycle",
        "autonomous plan execution",
        "keep going until done",
        "build everything",
    ]
    for msg in expected_matches:
        assert msg in ork_patterns, f"orkestrera triggers must include {msg!r}"


def test_orkestrera_prose_contains_conductor_workflow():
    prose_path = ORK_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in [
        "The conductor protocol",
        "Step 0: Assess",
        "Step 1: Select task",
        "Step 2: Dispatch",
        "Step 3: Evaluate",
        "Step 4: Resolve",
        "Step 5: Log and loop",
        "Safety rails",
        "Exit signals",
        "Cross-capability integration",
    ]:
        assert required in content, f"prose.md must contain section '{required}'"
