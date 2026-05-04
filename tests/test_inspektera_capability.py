"""Acceptance tests for the inspektera v2 capability port.

Covers: contract validation (pass + fail), trigger routing pickup, and
primitive reference resolution. Proportional: 3 tests covering the acceptance
criteria from PLAN.md Task 3.
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
INSPEKTERA_CAP_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities" / "inspektera"
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

def test_inspektera_capability_passes_contract_validation():
    errors = validate_capability.validate_capability(
        INSPEKTERA_CAP_DIR,
        REPO_ROOT / "skills/agentera/capability_schema_contract.yaml",
    )
    assert errors == [], f"Expected no validation errors, got:\n" + "\n".join(errors)


def test_inspektera_capability_passes_primitive_check():
    errors = validate_capability.check_primitive_references(INSPEKTERA_CAP_DIR, PROTOCOL_PATH)
    assert errors == [], f"Expected no primitive errors, got:\n" + "\n".join(errors)


# ---------------------------------------------------------------------------
# 2. Contract validation: FAIL (broken capability)
# ---------------------------------------------------------------------------

def test_inspektera_broken_capability_fails_contract_validation(tmp_path):
    cap_dir = tmp_path / "broken_inspektera"
    cap_dir.mkdir()
    schemas_dir = cap_dir / "schemas"
    schemas_dir.mkdir()

    (cap_dir / "prose.md").write_text("# Broken\n")
    (schemas_dir / "triggers.yaml").write_text(textwrap.dedent("""\
        TRIGGERS:
          bad_key:
            missing_id: true
    """))

    errors = validate_capability.validate_capability(
        cap_dir,
        REPO_ROOT / "skills/agentera/capability_schema_contract.yaml",
    )
    assert len(errors) > 0, "Expected validation errors for broken inspektera capability"


# ---------------------------------------------------------------------------
# 3. Routing pickup: inspektera trigger patterns match and route to inspektera
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


def test_inspektera_trigger_patterns_route_to_inspektera():
    triggers = _collect_all_triggers()
    assert "inspektera" in triggers, "inspektera capability must have trigger patterns"

    inspektera_patterns = triggers["inspektera"]

    expected_matches = [
        "inspektera",
        "audit the codebase",
        "check code health",
        "architecture review",
        "find technical debt",
        "assess code quality",
        "structural review",
        "pattern audit",
        "dependency check",
        "test coverage audit",
    ]
    for msg in expected_matches:
        assert msg in inspektera_patterns, f"inspektera triggers must include {msg!r}"


def test_inspektera_prose_exists_and_contains_workflow():
    prose_path = INSPEKTERA_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in [
        "Step 1: Orient",
        "Step 2: Select dimensions",
        "Step 3: Assess",
        "Step 4: Distill",
        "Step 5: Pre-write self-audit",
        "Step 6: Report",
        "Step 7: Connect",
        "Safety rails",
        "Exit signals",
    ]:
        assert required in content, f"prose.md must contain section '{required}'"
