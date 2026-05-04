"""Acceptance tests for the realisera v2 capability port.

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
REALISERA_CAP_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities" / "realisera"
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


def test_realisera_capability_passes_contract_validation():
    errors = validate_capability.validate_capability(REALISERA_CAP_DIR, REPO_ROOT / "skills/agentera/capability_schema_contract.yaml")
    assert errors == [], f"Expected no validation errors, got:\n" + "\n".join(errors)


def test_realisera_capability_passes_primitive_check():
    errors = validate_capability.check_primitive_references(REALISERA_CAP_DIR, PROTOCOL_PATH)
    assert errors == [], f"Expected no primitive errors, got:\n" + "\n".join(errors)


def test_broken_realisera_fails_contract_validation(tmp_path):
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


def test_realisera_trigger_patterns_route_to_realisera():
    triggers = _collect_all_triggers()
    assert "realisera" in triggers, "realisera capability must have trigger patterns"

    realisera_patterns = triggers["realisera"]

    expected_matches = [
        "realisera",
        "run a dev cycle",
        "evolve the project",
        "develop autonomously",
        "build the next feature",
        "keep building",
        "start building",
        "work on the project",
        "refine the vision",
    ]
    for msg in expected_matches:
        assert msg in realisera_patterns, f"realisera triggers must include {msg!r}"


def test_realisera_prose_exists_and_contains_workflow():
    prose_path = REALISERA_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in ["Step 1: Orient", "Step 2: Pick work", "Step 5: Dispatch", "Step 6: Verify", "Step 7: Commit", "Step 9: Log", "Safety rails", "Exit signals"]:
        assert required in content, f"prose.md must contain section '{required}'"
