"""Regression tests for the v2→v3 handoff manifest writer.

Contract authority: references/cli/v3-handoff-manifest.schema.yaml
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import v3_handoff_manifest as handoff
SCHEMA_PATH = REPO_ROOT / "references" / "cli" / "v3-handoff-manifest.schema.yaml"


def _write_managed_bundle(app_root: Path, version: str = "2.7.10") -> None:
    (app_root / "scripts").mkdir(parents=True, exist_ok=True)
    (app_root / "scripts" / "agentera").write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    (app_root / "skills" / "agentera").mkdir(parents=True, exist_ok=True)
    (app_root / "skills" / "agentera" / "SKILL.md").write_text("---\nname: agentera\n---\n", encoding="utf-8")
    (app_root / "registry.json").write_text(
        json.dumps({"skills": [{"name": "agentera", "version": version}]}),
        encoding="utf-8",
    )
    (app_root / ".agentera-bundle.json").write_text(
        json.dumps({"schemaVersion": "agentera.bundle.v1", "version": version}),
        encoding="utf-8",
    )


def _write_populated_app_home(app_home: Path) -> None:
    app_home.mkdir(parents=True, exist_ok=True)
    _write_managed_bundle(app_home / "app")
    (app_home / "benchmarks").mkdir()
    (app_home / "intermediate").mkdir()
    (app_home / "sessions").mkdir()
    (app_home / ".agentera").mkdir()
    (app_home / ".agentera" / "progress.yaml").write_text("cycles: []\n", encoding="utf-8")


def test_schema_contract_file_is_present() -> None:
    text = SCHEMA_PATH.read_text(encoding="utf-8")
    assert handoff.SCHEMA_VERSION in text
    assert "user_data_inventory_catalog" in text


def test_build_user_data_inventory_reports_existing_paths(tmp_path: Path) -> None:
    app_home = tmp_path / "agentera"
    _write_populated_app_home(app_home)
    inventory = handoff.build_user_data_inventory(app_home)
    assert len(inventory) == 6
    by_id = {entry["id"]: entry for entry in inventory}
    assert by_id["benchmarks"]["exists"] is True
    assert by_id["intermediate"]["exists"] is True
    assert by_id["sessions"]["exists"] is True
    assert by_id["history"]["exists"] is False
    assert by_id["corpus"]["exists"] is False
    profile = by_id["profile_files"]
    assert profile["kind"] == "profile_files"
    assert {member["relative_path"] for member in profile["members"]} == {"PROFILE.md", "USAGE.md"}


def test_write_manifest_emits_contract_fields(tmp_path: Path) -> None:
    app_home = tmp_path / "agentera"
    _write_populated_app_home(app_home)
    target = handoff.write_manifest(
        app_home=app_home,
        source_root=REPO_ROOT,
        home=tmp_path,
        env={"AGENTERA_HOME": str(app_home)},
    )
    payload = json.loads(target.read_text(encoding="utf-8"))
    assert payload["schema_version"] == handoff.SCHEMA_VERSION
    assert payload["installed_v2_version"] == "2.7.10"
    assert payload["app_home_path"] == str(app_home.resolve())
    assert isinstance(payload["runtime_adapters"], list)
    assert len(payload["user_data_inventory"]) == 6


def test_ensure_fresh_manifest_refreshes_stale_manifest(tmp_path: Path) -> None:
    app_home = tmp_path / "agentera"
    _write_populated_app_home(app_home)
    target = handoff.write_manifest(
        app_home=app_home,
        source_root=REPO_ROOT,
        home=tmp_path,
        env={"AGENTERA_HOME": str(app_home)},
    )
    payload = json.loads(target.read_text(encoding="utf-8"))
    payload["installed_v2_version"] = "0.0.1"
    target.write_text(json.dumps(payload), encoding="utf-8")
    marker = app_home / "app" / ".agentera-bundle.json"
    time.sleep(0.01)
    marker.touch()

    warnings: list[str] = []
    handoff.ensure_fresh_manifest(
        app_home=app_home,
        source_root=REPO_ROOT,
        home=tmp_path,
        env={"AGENTERA_HOME": str(app_home)},
        warn=warnings.append,
    )
    assert warnings
    refreshed = json.loads(target.read_text(encoding="utf-8"))
    assert refreshed["installed_v2_version"] == "2.7.10"


def test_is_manifest_stale_detects_version_and_path_mismatch(tmp_path: Path) -> None:
    app_home = tmp_path / "agentera"
    _write_populated_app_home(app_home)
    ctx = handoff.freshness_context(app_home, REPO_ROOT)
    assert ctx is not None
    manifest = handoff.build_manifest(
        app_home=app_home,
        source_root=REPO_ROOT,
        home=tmp_path,
        env={"AGENTERA_HOME": str(app_home)},
    )
    assert handoff.is_manifest_stale(manifest, ctx) is False
    manifest["installed_v2_version"] = "0.0.0"
    assert handoff.is_manifest_stale(manifest, ctx) is True
