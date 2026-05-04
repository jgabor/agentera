"""Acceptance tests for the hej v2 capability port.

Covers: contract validation (pass + fail), trigger routing pickup, and
fallback-to-hej behavior.  Proportional: 4 tests covering the 4 acceptance
criteria from PLAN.md Task 1.
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
HEJ_CAP_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities" / "hej"
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

def test_hej_capability_passes_contract_validation():
    errors = validate_capability.validate_capability(HEJ_CAP_DIR, REPO_ROOT / "skills/agentera/capability_schema_contract.yaml")
    assert errors == [], f"Expected no validation errors, got:\n" + "\n".join(errors)


def test_hej_capability_passes_primitive_check():
    errors = validate_capability.check_primitive_references(HEJ_CAP_DIR, PROTOCOL_PATH)
    assert errors == [], f"Expected no primitive errors, got:\n" + "\n".join(errors)


# ---------------------------------------------------------------------------
# 2. Contract validation: FAIL (broken capability)
# ---------------------------------------------------------------------------

def test_broken_capability_fails_contract_validation(tmp_path):
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
# 3. Routing pickup: hej trigger patterns match and route to hej
# ---------------------------------------------------------------------------

def _collect_all_triggers() -> dict[str, list[str]]:
    """Build capability_name -> [patterns] from all capability schemas."""
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


def test_hej_trigger_patterns_route_to_hej():
    triggers = _collect_all_triggers()
    assert "hej" in triggers, "hej capability must have trigger patterns"

    hej_patterns = triggers["hej"]

    expected_matches = [
        "hej",
        "hello",
        "hi",
        "catch me up",
        "what should I work on",
        "what's next",
        "status",
        "brief me",
        "where were we",
    ]
    for msg in expected_matches:
        assert msg in hej_patterns, f"hej triggers must include {msg!r}"


def test_hej_prose_exists_and_contains_workflow():
    prose_path = HEJ_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in ["Step 0: Detect mode", "Step 1a: Welcome", "Step 1b: Briefing", "Step 2: Route", "Safety rails", "Exit signals"]:
        assert required in content, f"prose.md must contain section '{required}'"


# ---------------------------------------------------------------------------
# 4. Fallback: hej is the default when no capability matches
# ---------------------------------------------------------------------------

def test_hej_is_fallback_capability():
    triggers = _collect_all_triggers()
    hej_patterns = triggers.get("hej", [])
    assert "*" in hej_patterns, "hej must have the wildcard fallback pattern '*'"


# ---------------------------------------------------------------------------
# 5. Upgrade guard: v1 artifacts detected → upgrade notice in briefing
# ---------------------------------------------------------------------------

def test_upgrade_guard_includes_v1_detection_logic():
    prose_path = HEJ_CAP_DIR / "prose.md"
    content = prose_path.read_text()

    assert "Step 0.5: Upgrade guard" in content, "prose.md must contain upgrade guard step"

    for v1_artifact in ["PROGRESS.md", "PLAN.md", "DECISIONS.md", "HEALTH.md"]:
        assert v1_artifact in content, f"upgrade guard must reference v1 artifact {v1_artifact}"

    assert "migrate_artifacts_v1_to_v2" in content, "upgrade guard must reference the migration command"


def test_upgrade_guard_specifies_no_notice_when_no_v1():
    prose_path = HEJ_CAP_DIR / "prose.md"
    content = prose_path.read_text()

    assert "no upgrade notice" in content.lower() or "emit no upgrade notice" in content.lower(), \
        "upgrade guard must specify that no notice is emitted when v1 artifacts are absent"


# ---------------------------------------------------------------------------
# 6. Upgrade guard: PROFILE.md present → no warning
# ---------------------------------------------------------------------------

def test_upgrade_guard_no_warning_when_profile_present():
    prose_path = HEJ_CAP_DIR / "prose.md"
    content = prose_path.read_text()

    profile_section = content[content.index("PROFILE.md detection"):]
    assert "profile   loaded" in profile_section, "guard must specify 'loaded' when PROFILE.md exists"
    assert "No warning" in profile_section or "no warning" in profile_section.lower(), \
        "guard must specify no warning when PROFILE.md exists"


# ---------------------------------------------------------------------------
# 7. Upgrade guard: PROFILE.md absent → degraded attention item
# ---------------------------------------------------------------------------

def test_upgrade_guard_flags_missing_profile_as_degraded():
    prose_path = HEJ_CAP_DIR / "prose.md"
    content = prose_path.read_text()

    profile_section = content[content.index("PROFILE.md detection"):]
    assert "profile   not found" in profile_section, "guard must specify 'not found' when PROFILE.md is absent"
    assert "⇉" in profile_section, "guard must use degraded severity arrow for missing PROFILE.md"
    assert "/profilera" in profile_section, "guard must reference /profilera as the remediation"
