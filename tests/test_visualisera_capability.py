"""Acceptance tests for the visualisera v2 capability port.

Covers: contract validation (pass + fail), trigger routing pickup,
primitive reference check, and prose content validation.
Proportional: 4 tests covering the acceptance criteria from PLAN.md Task 5.
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
VISUALISERA_CAP_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities" / "visualisera"
PROTOCOL_PATH = REPO_ROOT / "skills" / "agentera" / "protocol.yaml"
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"


def _load_module(name: str, path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


validate_capability = _load_module("validate_capability_visualisera", REPO_ROOT / "scripts" / "validate_capability.py")


# ---------------------------------------------------------------------------
# 1. Contract validation: PASS
# ---------------------------------------------------------------------------

def test_visualisera_capability_passes_contract_validation():
    errors = validate_capability.validate_capability(VISUALISERA_CAP_DIR, REPO_ROOT / "skills/agentera/capability_schema_contract.yaml")
    assert errors == [], f"Expected no validation errors, got:\n" + "\n".join(errors)


def test_visualisera_capability_passes_primitive_check():
    errors = validate_capability.check_primitive_references(VISUALISERA_CAP_DIR, PROTOCOL_PATH)
    assert errors == [], f"Expected no primitive errors, got:\n" + "\n".join(errors)


# ---------------------------------------------------------------------------
# 2. Contract validation: FAIL (broken capability)
# ---------------------------------------------------------------------------

def test_broken_visualisera_fails_contract_validation(tmp_path):
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
# 3. Routing pickup: visualisera trigger patterns route to visualisera
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


def test_visualisera_trigger_patterns_route_correctly():
    triggers = _collect_all_triggers()
    assert "visualisera" in triggers, "visualisera capability must have trigger patterns"

    visualisera_patterns = triggers["visualisera"]

    expected_matches = [
        "visualisera",
        "create design system",
        "write DESIGN.md",
        "design tokens",
        "visual identity",
        "audit design",
        "refine design system",
    ]
    for msg in expected_matches:
        assert msg in visualisera_patterns, f"visualisera triggers must include {msg!r}"


def test_visualisera_prose_exists_and_contains_workflow():
    prose_path = VISUALISERA_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in [
        "Step 0: Detect mode",
        "Create mode",
        "Refine mode",
        "Audit mode",
        "Safety rails",
        "Exit signals",
        "Cross-capability integration",
    ]:
        assert required in content, f"prose.md must contain section '{required}'"
