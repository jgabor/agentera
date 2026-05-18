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
        "orchestrate skills",
        "multi-cycle",
        "autonomous plan execution",
        "keep going until done",
        "build everything",
    ]
    for msg in expected_matches:
        assert msg in ork_patterns, f"orkestrera triggers must include {msg!r}"


def test_orkestrera_prose_contains_orchestration_loop_workflow():
    prose_path = ORK_CAP_DIR / "prose.md"
    assert prose_path.is_file(), "prose.md must exist"

    content = prose_path.read_text()
    for required in [
        "The orchestration loop",
        "Step 0: Assess",
        "Step 1: Select task",
        "Step 2: Delegate",
        "Step 3: Evaluate",
        "Step 4: Resolve",
        "Step 5: Log and loop",
        "Safety rails",
        "Exit signals",
        "Cross-capability integration",
    ]:
        assert required in content, f"prose.md must contain section '{required}'"


def test_orkestrera_prose_closes_only_successfully_completed_plans():
    content = (ORK_CAP_DIR / "prose.md").read_text()

    for required in [
        "header.status: complete",
        "all tasks complete",
        "blocked or incomplete tasks remain",
        "do not archive it as a successful completed plan",
        "archive PLAN.md before removing active state",
        "agentera hej",
    ]:
        assert required in content


def test_orkestrera_prose_uses_orchestration_context_before_raw_artifacts():
    content = (ORK_CAP_DIR / "prose.md").read_text()
    normalized = " ".join(content.split())

    for required in [
        "agentera hej --format json --capability-context orkestrera",
        "Use the returned `orchestration_context` before raw plan, progress, health, TODO, or decisions artifacts",
        "If `source_contract.complete_for_orchestration_context` is true, do not read raw plan, progress, health, TODO, or decisions artifacts",
        "run the listed routine CLI fallback commands",
        "Read a raw artifact only as a last-resort diagnostic",
        "compacted decision caveats",
        "stale health/profile/app caveats",
        "retry-state provenance",
    ]:
        assert required in content

    for forbidden in [
        "Read PLAN.md. Find tasks",
        "Read DECISIONS.md if it exists",
        "Read the latest entry in PROGRESS.md",
        "Reading `.agentera/progress.yaml` is consistent",
        "Read `$PROFILERA_PROFILE_DIR/PROFILE.md`",
    ]:
        assert forbidden not in content
    assert "Do not run an unsupported capability-name command such as `agentera orkestrera`" in content
    assert "agentera orkestrera" not in normalized.replace(
        "Do not run an unsupported capability-name command such as `agentera orkestrera`.",
        "",
    )


def test_orkestrera_validation_schema_guards_context_first_contract():
    schema = yaml.safe_load((ORK_CAP_DIR / "schemas" / "validation.yaml").read_text())
    rules = {entry["id"]: entry for entry in schema["VALIDATION"].values()}

    assert rules["V6"]["rule"] == "orchestration_context_first"
    assert rules["V7"]["rule"] == "cli_fallback_before_raw_read"
    assert rules["V8"]["rule"] == "caveats_preserved_for_evaluation"
    assert rules["V6"]["severity"] == "critical"
    assert rules["V7"]["severity"] == "critical"
    assert rules["V8"]["severity"] == "critical"
