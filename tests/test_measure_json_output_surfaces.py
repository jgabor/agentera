"""Tests for scripts/measure_json_output_surfaces.py."""

from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_manifest_expands_capability_context_rows(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT)
    slim = [spec for spec in specs if spec.id.startswith("hej-capability-context-slim:")]
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
    )

    assert report["status"] == "pass"
    assert report["surface_count"] == 3
    assert report["token_counter"]["local_benchmark_command"] == (
        "uv run scripts/measure_json_output_surfaces.py --json --token-mode exact"
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
    )

    assert report["status"] == "pass"
    assert all(row["gpt5_tokens"] is None for row in report["measurements"])
    assert all(row["token_status"] == "skipped" for row in report["measurements"])


def test_primary_surfaces_generate_json_without_profile_mutation(measure_json_output_surfaces):
    module = measure_json_output_surfaces
    specs = module.load_surface_specs(module.DEFAULT_MANIFEST, REPO_ROOT, scopes={"primary"})
    measurements = module.measure_surfaces(
        specs,
        repo_root=REPO_ROOT,
        token_counter=None,
    )
    errors = [row for row in measurements if row.generation_status == "error"]

    assert len(measurements) == len(specs)
    assert not errors, [f"{row.id}: {row.error}" for row in errors]
    assert all(row.bytes > 0 for row in measurements)
    assert all(row.generation_status == "ok" for row in measurements)


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
    )

    assert "in_scope" in report["scope_notes"]
    assert report["measurements"][0]["measurement_scope"] == "diagnostic"
    assert report["measurements"][0]["budget_classification"] == "diagnostic"
