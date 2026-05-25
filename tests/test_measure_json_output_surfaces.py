"""Tests for scripts/measure_json_output_surfaces.py."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_manifest_expands_capability_context_rows(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT)
    slim = [spec for spec in specs if spec.id.startswith("prime-capability-context:")]
    full = [spec for spec in specs if spec.id.startswith("hej-capability-context-full:")]

    assert len(specs) >= 60
    assert len(slim) == len(module.CAPABILITIES)
    assert len(full) == len(module.CAPABILITIES)
    assert {spec.capability for spec in slim} == set(module.CAPABILITIES)


def test_measure_outputs_records_required_report_fields(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary"})
    sample = specs[:3]
    outputs = {
        spec.id: json.dumps({"surface": spec.id, "payload": "x" * (index + 1)})
        for index, spec in enumerate(sample)
    }
    token_counts = {spec.id: index + 100 for index, spec in enumerate(sample)}

    def fake_counter(output: str) -> int:
        payload = json.loads(output)
        return token_counts[payload["surface"]]

    measurements = module.measure_outputs(sample, outputs, fake_counter)
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="exact",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["primary"],
        specs=sample,
        enforce_budgets=False,
    )

    assert report["status"] == "pass"
    assert report["surface_count"] == 3
    assert report["token_counter"]["local_benchmark_command"] == (
        "uv run scripts/measure_json_output_surfaces.py --json --token-mode exact --enforce-budgets"
    )
    for row in report["measurements"]:
        assert row["generation_status"] == "ok"
        assert row["command"]
        assert row["selector"]
        assert row["bytes"] > 0
        assert row["gpt5_tokens"] is not None
        assert row["token_status"] == "measured"
        assert row["budget_classification"]
        assert row["inventory_classification"]
        assert row["measurement_scope"] == "primary"


def test_skip_token_mode_keeps_tests_offline(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary"})
    outputs = {spec.id: '{"ok":true}\n' for spec in specs[:2]}
    measurements = module.measure_outputs(specs[:2], outputs, token_counter=None)
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="skip",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["primary"],
        specs=specs[:2],
        enforce_budgets=False,
    )

    assert report["status"] == "pass"
    assert all(row["gpt5_tokens"] is None for row in report["measurements"])
    assert all(row["token_status"] == "skipped" for row in report["measurements"])


@pytest.mark.slow
def test_primary_surfaces_generate_json_without_profile_mutation(
    measure_json_output_surfaces,
    primary_surface_measurements,
):
    module = measure_json_output_surfaces
    specs, measurements = primary_surface_measurements
    errors = [row for row in measurements if row.generation_status == "error"]

    assert len(measurements) == len(specs)
    assert not errors, [f"{row.id}: {row.error}" for row in errors]
    assert all(row.bytes > 0 for row in measurements if row.generation_status == "ok")
    assert all(row.generation_status in {"ok", "removed"} for row in measurements)
    assert len([row for row in measurements if row.generation_status == "removed"]) == len(module.CAPABILITIES)


def test_report_includes_scope_notes_from_manifest(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"diagnostic"})
    measurements = module.measure_outputs(
        specs[:1],
        {specs[0].id: '{"verify":true}'},
        token_counter=None,
    )
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="skip",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["diagnostic"],
        specs=specs[:1],
        enforce_budgets=False,
    )

    assert "in_scope" in report["scope_notes"]
    assert report["measurements"][0]["measurement_scope"] == "diagnostic"
    assert report["measurements"][0]["budget_classification"] == "diagnostic"


def test_manifest_surfaces_define_enforcement_tiers(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT)
    assert len(specs) == 67
    for spec in specs:
        assert spec.enforcement_tier in module.ENFORCEMENT_TIERS
        if spec.enforcement_tier == "enforce":
            assert spec.byte_budget is not None
            assert spec.token_budget is not None
        if spec.enforcement_tier == "exempt":
            assert spec.exemption_rationale
            assert "inventory" in spec.exemption_rationale.lower()
        if spec.enforcement_tier == "monitor":
            assert spec.monitor_byte_ceiling is not None


def test_budget_failure_names_command_counts_and_budgets(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary"})
    plan = next(spec for spec in specs if spec.id == "plan")
    outputs = {plan.id: "x" * 21_001}
    measurements = module.measure_outputs([plan], outputs, lambda output: 5_000)
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="exact",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["primary"],
        specs=[plan],
        enforce_budgets=True,
    )

    assert report["status"] == "fail"
    assert report["violations"] == [
        {
            "id": "plan",
            "command": plan.command,
            "selector": plan.selector,
            "capability": None,
            "profile": None,
            "byte_count": 21_001,
            "byte_budget": 20_000,
            "token_count": 5_000,
            "token_budget": 4_500,
            "enforcement_tier": "enforce",
            "reasons": ["bytes_exceeded", "tokens_exceeded"],
        }
    ]


def test_exempt_surfaces_skip_budget_enforcement(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary"})
    exempt = [spec for spec in specs if spec.enforcement_tier == "exempt"]
    assert {spec.id for spec in exempt} == {"query-design", "usage-stats-helper"}
    outputs = {spec.id: "x" * 200_000 for spec in exempt}
    measurements = module.measure_outputs(exempt, outputs, lambda output: 99_999)
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="exact",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["primary"],
        specs=exempt,
        enforce_budgets=True,
    )

    assert report["status"] == "pass"
    assert report["violations"] == []


def test_skip_token_mode_still_enforces_byte_budgets(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary"})
    todo = next(spec for spec in specs if spec.id == "todo")
    outputs = {todo.id: "x" * 3_000}
    measurements = module.measure_outputs([todo], outputs, token_counter=None)
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="skip",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["primary"],
        specs=[todo],
        enforce_budgets=True,
    )

    assert report["status"] == "fail"
    assert report["violations"] == [
        {
            "id": "todo",
            "command": todo.command,
            "selector": todo.selector,
            "capability": None,
            "profile": None,
            "byte_count": 3_000,
            "byte_budget": 2_000,
            "token_count": None,
            "token_budget": 500,
            "enforcement_tier": "enforce",
            "reasons": ["bytes_exceeded"],
        }
    ]


def test_monitor_surfaces_emit_warnings_without_failing(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"diagnostic"})
    target = next(spec for spec in specs if spec.id == "validate-app-home-contract")
    outputs = {target.id: "x" * 1_500}
    measurements = module.measure_outputs([target], outputs, token_counter=None)
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="skip",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["diagnostic"],
        specs=[target],
        enforce_budgets=True,
    )

    assert report["status"] == "pass"
    assert report["violations"] == []
    assert report["warnings"][0]["id"] == "validate-app-home-contract"
    assert report["warnings"][0]["reason"] == "monitor_ceiling_exceeded"


@pytest.mark.slow
def test_primary_surfaces_pass_byte_budget_enforcement(
    measure_json_output_surfaces,
    primary_surface_measurements,
):
    module = measure_json_output_surfaces
    specs, measurements = primary_surface_measurements
    report = module.report_payload(
        measurements,
        manifest_path=module.DEFAULT_MANIFEST,
        repo_root=REPO_ROOT,
        token_mode="skip",
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        scopes=["primary"],
        specs=specs,
        enforce_budgets=True,
    )

    errors = [row for row in measurements if row.generation_status == "error"]
    assert not errors, [f"{row.id}: {row.error}" for row in errors]
    removed = [row for row in measurements if row.generation_status == "removed"]
    assert len(removed) == len(module.CAPABILITIES)
    assert report["status"] == "pass"
    assert report["violation_count"] == 0
