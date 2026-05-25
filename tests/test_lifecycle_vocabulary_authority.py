"""Regression coverage for the Decision 54 app lifecycle vocabulary authority."""

from __future__ import annotations

import importlib.util
from functools import lru_cache
from pathlib import Path
from types import ModuleType, SimpleNamespace

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
AUTHORITY = REPO_ROOT / "references" / "cli" / "app-lifecycle-vocabulary.yaml"

EXPECTED_STATUSES = [
    "up_to_date",
    "outdated",
    "repair_needed",
    "migration_needed",
    "manual_review_needed",
    "ready_to_apply",
    "applied",
    "no_changes_needed",
]
EXPECTED_VERBS = ["install", "repair", "update", "migrate", "upgrade", "refresh"]
EXPECTED_CONSUMERS = ["doctor", "hej", "upgrade", "docs", "tests"]


@lru_cache
def _authority() -> dict:
    return yaml.safe_load(AUTHORITY.read_text(encoding="utf-8"))


def _load_upgrade_module() -> ModuleType:
    path = REPO_ROOT / "scripts" / "agentera_upgrade.py"
    spec = importlib.util.spec_from_file_location("agentera_upgrade", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _consumer_statuses(consumer: str) -> set[str]:
    return set(_authority()["consumers"][consumer]["may_emit_statuses"])


def _canonical_statuses() -> set[str]:
    return set(_authority()["canonical_statuses"])


def _rejected_lifecycle_status_values() -> set[str]:
    authority = _authority()
    deprecated_aliases = {
        alias
        for status in authority["canonical_statuses"].values()
        for alias in status["deprecated_aliases"]
    }
    non_lifecycle_verbs = {
        verb
        for verb, entry in authority["operation_verbs"].items()
        if entry["lifecycle_allowed"] is False
    }
    return deprecated_aliases | non_lifecycle_verbs


def _write_current_app_home(app_home: Path, *, version: str = "current") -> None:
    app_root = app_home / "app"
    (app_root / "scripts").mkdir(parents=True)
    (app_root / "scripts" / "agentera").write_text("#!/usr/bin/env python3\n# commands: hej\n", encoding="utf-8")
    (app_root / "skills" / "agentera").mkdir(parents=True)
    (app_root / "skills" / "agentera" / "SKILL.md").write_text("---\nname: agentera\n---\n", encoding="utf-8")
    (app_root / "registry.json").write_text('{"skills": []}\n', encoding="utf-8")
    (app_root / ".agentera-bundle.json").write_text(
        '{"schemaVersion":"agentera.bundle.v1","version":"' + version + '"}\n',
        encoding="utf-8",
    )


def _upgrade_args(tmp_path: Path, *, install_root: Path | None = None, yes: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        project=tmp_path / "project",
        home=tmp_path / "home",
        opencode_config_dir=None,
        install_root=install_root,
        runtime=(),
        only=("bundle",),
        force=False,
        yes=yes,
        update_packages=False,
    )


def test_canonical_statuses_are_ordered_and_defined() -> None:
    authority = _authority()

    assert authority["canonical_status_order"] == EXPECTED_STATUSES
    assert list(authority["canonical_statuses"]) == EXPECTED_STATUSES
    for status in EXPECTED_STATUSES:
        entry = authority["canonical_statuses"][status]
        assert entry["concept"].strip()
        assert entry["definition"].strip()
        assert entry["deprecated_aliases"]


def test_deprecated_app_status_aliases_map_to_canonical_statuses() -> None:
    authority = _authority()
    alias_to_status = {
        alias: status
        for status, entry in authority["canonical_statuses"].items()
        for alias in entry["deprecated_aliases"]
    }

    assert alias_to_status["fresh"] == "up_to_date"
    assert alias_to_status["stale"] == "outdated"
    assert alias_to_status["refresh_required"] == "repair_needed"
    assert alias_to_status["app_refresh_required"] == "repair_needed"
    assert alias_to_status["fixed"] == "applied"
    assert alias_to_status["noop"] == "no_changes_needed"
    assert not set(alias_to_status).intersection(EXPECTED_STATUSES)


def test_operation_verbs_have_scoped_meanings() -> None:
    authority = _authority()

    assert authority["operation_verb_order"] == EXPECTED_VERBS
    assert list(authority["operation_verbs"]) == EXPECTED_VERBS
    assert authority["operation_verbs"]["refresh"]["lifecycle_allowed"] is False
    assert "Data regeneration only" in authority["operation_verbs"]["refresh"]["scope"]
    for verb in ["install", "repair", "update", "migrate", "upgrade"]:
        assert authority["operation_verbs"][verb]["lifecycle_allowed"] is True
        assert authority["operation_verbs"][verb]["scope"].strip()


def test_consumer_ownership_boundaries_are_explicit_and_closed() -> None:
    authority = _authority()

    assert authority["consumer_order"] == EXPECTED_CONSUMERS
    assert list(authority["consumers"]) == EXPECTED_CONSUMERS
    allowed_statuses = set(EXPECTED_STATUSES)
    allowed_verbs = set(EXPECTED_VERBS)
    for consumer in EXPECTED_CONSUMERS:
        entry = authority["consumers"][consumer]
        assert entry["owns"]
        assert entry["may_define_new_statuses"] is False
        assert set(entry["may_emit_statuses"]).issubset(allowed_statuses)
        assert set(entry["may_use_verbs"]).issubset(allowed_verbs)


def test_doctor_and_hej_app_status_metadata_use_consumer_allowed_statuses(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    project = tmp_path / "project"
    home = tmp_path / "home"
    current = tmp_path / "current"
    outdated = tmp_path / "outdated"
    project.mkdir()
    _write_current_app_home(current)
    _write_current_app_home(outdated, version="old")

    observed = {
        upgrade.build_doctor_status(
            current,
            root_source="explicit --install-root",
            source_root=REPO_ROOT,
            home=home,
            project=project,
            expected_version="current",
            probe_cli=False,
        )["status"],
        upgrade.build_doctor_status(
            outdated,
            root_source="explicit --install-root",
            source_root=REPO_ROOT,
            home=home,
            project=project,
            expected_version="current",
            probe_cli=False,
        )["status"],
        upgrade.build_doctor_status(
            tmp_path / "missing",
            root_source="default app home",
            source_root=REPO_ROOT,
            home=home,
            project=project,
            expected_version="current",
            probe_cli=False,
        )["status"],
    }

    assert observed == {"up_to_date", "outdated", "repair_needed"}
    assert observed <= _consumer_statuses("doctor")
    assert observed <= _consumer_statuses("hej")


def test_upgrade_lifecycle_metadata_uses_authority_while_preserving_workflow_status(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    pending_plan = upgrade.build_upgrade_plan(_upgrade_args(tmp_path, install_root=tmp_path / "app-home"))
    noop_plan = upgrade.build_upgrade_plan(_upgrade_args(tmp_path, install_root=REPO_ROOT))

    assert pending_plan["status"] == "pending"
    assert pending_plan["compatibilityStatus"] == "pending"
    assert pending_plan["lifecycleStatus"] == "ready_to_apply"
    assert noop_plan["status"] == "noop"
    assert noop_plan["compatibilityStatus"] == "noop"
    assert noop_plan["lifecycleStatus"] == "no_changes_needed"
    assert {pending_plan["lifecycleStatus"], noop_plan["lifecycleStatus"]} <= _consumer_statuses("upgrade")


def test_upgrade_lifecycle_status_maps_workflow_boundaries() -> None:
    upgrade = _load_upgrade_module()

    assert upgrade._upgrade_lifecycle_status("pending") == "ready_to_apply"
    assert upgrade._upgrade_lifecycle_status("noop") == "no_changes_needed"
    assert upgrade._upgrade_lifecycle_status("applied") == "applied"
    assert upgrade._upgrade_lifecycle_status("blocked") == "manual_review_needed"
    assert upgrade._upgrade_lifecycle_status("failed") == "manual_review_needed"
    assert upgrade._upgrade_lifecycle_status("skipped") == "no_changes_needed"
    assert upgrade._upgrade_lifecycle_status("surprise") == "manual_review_needed"


def test_rejected_lifecycle_status_values_are_authority_derived() -> None:
    rejected = _rejected_lifecycle_status_values()

    assert {"fresh", "stale", "refresh", "fixed", "ready", "noop"} <= rejected
    assert not rejected.intersection(_canonical_statuses())


def test_app_lifecycle_status_surfaces_do_not_emit_rejected_values(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    project = tmp_path / "project"
    home = tmp_path / "home"
    current = tmp_path / "current"
    outdated = tmp_path / "outdated"
    project.mkdir()
    _write_current_app_home(current)
    _write_current_app_home(outdated, version="old")

    doctor_statuses = [
        upgrade.build_doctor_status(
            current,
            root_source="explicit --install-root",
            source_root=REPO_ROOT,
            home=home,
            project=project,
            expected_version="current",
            probe_cli=False,
        ),
        upgrade.build_doctor_status(
            outdated,
            root_source="explicit --install-root",
            source_root=REPO_ROOT,
            home=home,
            project=project,
            expected_version="current",
            probe_cli=False,
        ),
        upgrade.build_doctor_status(
            tmp_path / "missing",
            root_source="default app home",
            source_root=REPO_ROOT,
            home=home,
            project=project,
            expected_version="current",
            probe_cli=False,
        ),
    ]
    upgrade_plan_statuses = {
        upgrade.build_upgrade_plan(_upgrade_args(tmp_path, install_root=tmp_path / "app-home"))["lifecycleStatus"],
        upgrade.build_upgrade_plan(_upgrade_args(tmp_path, install_root=REPO_ROOT))["lifecycleStatus"],
        *(upgrade._upgrade_lifecycle_status(status) for status in upgrade.STATUSES),
    }
    observed_statuses = (
        {status["status"] for status in doctor_statuses}
        | {signal["status"] for status in doctor_statuses for signal in status["signals"]}
        | upgrade_plan_statuses
    )

    assert observed_statuses <= _canonical_statuses()
    assert not observed_statuses.intersection(_rejected_lifecycle_status_values())
    assert {status["status"] for status in doctor_statuses} <= _consumer_statuses("doctor")
    assert upgrade_plan_statuses <= _consumer_statuses("upgrade")


def test_rejected_words_remain_allowed_outside_status_metadata() -> None:
    authority = _authority()
    upgrade = _load_upgrade_module()

    assert "fresh" in authority["compatibility_boundary"]
    assert "stale" in authority["compatibility_boundary"]
    assert "refresh" in authority["operation_verbs"]
    assert "agentera stats refresh" in authority["operation_verbs"]["refresh"]["scope"]
    assert "noop" in upgrade.STATUSES
    assert "fixed" in upgrade.PLAIN_STATUS.values()
    assert "ready to fix" in upgrade.PLAIN_STATUS.values()


def test_apply_upgrade_path_updates_public_lifecycle_metadata(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    args = _upgrade_args(tmp_path, install_root=tmp_path / "app-home", yes=True)
    plan = upgrade.build_upgrade_plan(args)

    assert plan["status"] == "pending"
    assert plan["lifecycleStatus"] == "ready_to_apply"

    upgrade.apply_upgrade_plan(plan, args)
    public = upgrade._public_plan(plan)

    assert public["status"] == "applied"
    assert public["compatibilityStatus"] == "applied"
    assert public["lifecycleStatus"] == "applied"
    assert public["lifecycleStatus"] in _consumer_statuses("upgrade")
    assert "installRoot" not in public


def test_blocked_upgrade_path_has_public_manual_review_lifecycle_metadata(tmp_path: Path) -> None:
    upgrade = _load_upgrade_module()
    app_home = tmp_path / "unsafe-app-home"
    app_home.mkdir()
    (app_home / "not-agentera.txt").write_text("user data\n", encoding="utf-8")

    plan = upgrade.build_upgrade_plan(_upgrade_args(tmp_path, install_root=app_home))
    public = upgrade._public_plan(plan)

    assert public["status"] == "blocked"
    assert public["compatibilityStatus"] == "blocked"
    assert public["lifecycleStatus"] == "manual_review_needed"
    assert public["lifecycleStatus"] in _consumer_statuses("upgrade")


def test_hej_capability_context_consumes_canonical_app_status() -> None:
    source = (REPO_ROOT / "scripts" / "agentera").read_text(encoding="utf-8")

    assert 'bundle.get("status") != "fresh"' not in source
    assert 'bundle.get("status") != "up_to_date"' in source


def test_vocabulary_docs_delegate_app_lifecycle_authority_to_yaml() -> None:
    vocabulary = (REPO_ROOT / "references" / "cli" / "vocabulary.md").read_text(encoding="utf-8")
    section = vocabulary.split("### App lifecycle status vocabulary", 1)[1].split(
        "## Evaluation and evidence grammar", 1
    )[0]

    assert "references/cli/app-lifecycle-vocabulary.yaml" in section
    assert "machine-readable authority" in section
    assert "| Concept | Canonical status |" not in section
    assert "| Verb | Only means |" not in section


def test_app_lifecycle_authority_declares_docs_delegation_contract() -> None:
    delegation = _authority()["docs_delegation"]

    assert delegation == {
        "document": "references/cli/vocabulary.md",
        "required_anchor": "App lifecycle status vocabulary",
        "authority_path": "references/cli/app-lifecycle-vocabulary.yaml",
        "must_not_duplicate_large_table": True,
    }
