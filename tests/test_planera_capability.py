"""Acceptance tests for the planera v2 capability port.

Covers: contract validation (pass + fail) and trigger routing pickup.
Proportional: 3 tests covering acceptance criteria from PLAN.md Task 2.
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
PLANERA_CAP_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities" / "planera"
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


def test_planera_capability_passes_contract_validation():
    errors = validate_capability.validate_capability(PLANERA_CAP_DIR, REPO_ROOT / "skills/agentera/capability_schema_contract.yaml")
    assert errors == [], f"Expected no validation errors, got:\n" + "\n".join(errors)


def test_planera_capability_passes_primitive_check():
    errors = validate_capability.check_primitive_references(PLANERA_CAP_DIR, PROTOCOL_PATH)
    assert errors == [], f"Expected no primitive errors, got:\n" + "\n".join(errors)


def test_broken_planera_fails_contract_validation(tmp_path):
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


def test_planera_trigger_patterns_route_to_planera():
    triggers = _collect_all_triggers()
    assert "planera" in triggers, "planera capability must have trigger patterns"

    planera_patterns = triggers["planera"]

    expected_matches = [
        "planera",
        "plan this",
        "write a plan",
        "break this down",
        "decompose this",
        "how should we build this",
        "spec this out",
        "plan before building",
        "multi-step feature",
        "this is too big for one cycle",
    ]
    for msg in expected_matches:
        assert msg in planera_patterns, f"planera triggers must include {msg!r}"


def test_planera_prose_exists_and_contains_workflow():
    prose_path = PLANERA_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in ["Step 0: Detect level", "Step 1: Orient", "Step 2: Specify", "Step 5: Write PLAN.md", "Step 6: Handoff", "Safety rails", "Exit signals"]:
        assert required in content, f"prose.md must contain section '{required}'"
