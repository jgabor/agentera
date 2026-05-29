from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"


def _run_cli(project: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=project,
        capture_output=True,
        text=True,
    )


def _write_docs_mapping(project, state_dir="state"):
    (project / ".agentera").mkdir(exist_ok=True)
    (project / ".agentera" / "docs.yaml").write_text(
        "mapping:\n"
        "- artifact: TODO.md\n"
        f"  path: {state_dir}/TODO.md\n"
        "- artifact: PROGRESS.md\n"
        f"  path: {state_dir}/progress.yaml\n"
        "- artifact: DECISIONS.md\n"
        f"  path: {state_dir}/decisions.yaml\n"
        "- artifact: HEALTH.md\n"
        f"  path: {state_dir}/health.yaml\n"
        "- artifact: VISION.md\n"
        f"  path: {state_dir}/vision.yaml\n",
        encoding="utf-8",
    )


def _progress_cycle(number):
    return {
        "number": number,
        "timestamp": f"2026-05-{number:02d} 10:00",
        "type": "fix",
        "phase": "build",
        "what": f"Implemented cycle {number}",
        "commit": "N/A",
        "context": {"intent": "test fixture"},
    }


def _decision(number):
    return {
        "number": number,
        "date": f"2026-05-{number:02d}",
        "question": f"Question {number}?",
        "context": f"Context {number}",
        "alternatives": [
            {"name": "Keep", "status": "chosen"},
            {"name": "Skip", "status": "rejected"},
        ],
        "choice": f"Choice {number}",
        "reasoning": f"Reasoning {number}",
        "confidence": "firm",
        "feeds_into": f"PLAN.md#DEC-{number}",
        "satisfaction": {
            "state": "user_confirmed_satisfied",
            "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
        },
    }


def test_compaction_status_counts_mapped_compactable_artifacts(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    (project / "state").mkdir()
    (project / "state" / "TODO.md").write_text(
        "# TODO\n\n"
        "## Resolved\n\n"
        "- [x] Full item\n"
        "  detail\n"
        "- [x] ~~Archived item~~\n",
        encoding="utf-8",
    )
    (project / "state" / "progress.yaml").write_text(
        "cycles:\n" + "\n".join("- number: %d" % i for i in range(12)) + "\narchive:\n- summary: old\n",
        encoding="utf-8",
    )
    (project / "state" / "decisions.yaml").write_text("decisions:\n- number: 1\narchive: []\n", encoding="utf-8")
    (project / "state" / "health.yaml").write_text("audits: []\narchive:\n- summary: old\n", encoding="utf-8")

    statuses = {status.artifact: status for status in compaction.compute_compaction_status(project)}

    assert statuses["TODO.md#Resolved"].classification == "compactable"
    assert statuses["TODO.md#Resolved"].active_count == 1
    assert statuses["TODO.md#Resolved"].archive_count == 1
    assert statuses["PROGRESS.md"].active_count == 12
    assert statuses["PROGRESS.md"].archive_count == 1
    assert statuses["PROGRESS.md"].total_count == 13
    assert statuses["PROGRESS.md"].over_limit_count == 2
    assert statuses["DECISIONS.md"].over_limit_count == 0
    assert statuses["HEALTH.md"].archive_count == 1


def test_compaction_status_classifies_non_compactable_and_protected_without_mutation(compaction, tmp_path):
    project = tmp_path
    optimera = project / ".agentera" / "optimera" / "speed"
    optimera.mkdir(parents=True)
    experiments = optimera / "experiments.yaml"
    experiments.write_text(
        "experiments:\n" + "\n".join("- number: %d" % i for i in range(11)) + "\narchive: []\n",
        encoding="utf-8",
    )
    originals = {}
    for name in ["CHANGELOG.md", "DESIGN.md"]:
        path = project / name
        path.write_text(f"# {name}\n", encoding="utf-8")
        originals[path] = path.read_text(encoding="utf-8")
    for name in ["plan", "docs", "vision"]:
        path = project / ".agentera" / f"{name}.yaml"
        path.write_text(f"{name}: value\n", encoding="utf-8")
        originals[path] = path.read_text(encoding="utf-8")
    originals[experiments] = experiments.read_text(encoding="utf-8")

    statuses = compaction.compute_compaction_status(project)
    by_artifact = {status.artifact: status for status in statuses if status.artifact != "EXPERIMENTS.md"}
    experiment_status = next(status for status in statuses if status.artifact == "EXPERIMENTS.md")

    assert by_artifact["CHANGELOG.md"].classification == "exempt"
    assert by_artifact["PLAN.md"].classification == "unsupported"
    assert by_artifact["DOCS.md"].classification == "unsupported"
    assert by_artifact["VISION.md"].classification == "protected"
    assert by_artifact["DESIGN.md"].classification == "unsupported"
    assert experiment_status.classification == "protected"
    assert experiment_status.active_count == 11
    assert experiment_status.over_limit_count == 1
    for path, text in originals.items():
        assert path.read_text(encoding="utf-8") == text


def test_check_mode_reports_over_limit_without_mutation(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")

    over_full = {"cycles": [_progress_cycle(i) for i in range(1, 12)], "archive": []}
    over_archive = {
        "decisions": [],
        "archive": [
            {
                "summary": f"Decision {i} (2026-04-01): old",
                "satisfaction": {
                    "state": "user_confirmed_satisfied",
                    "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
                },
            }
            for i in range(1, 42)
        ],
    }
    over_total = {
        "audits": [{"number": i} for i in range(1, 11)],
        "archive": [{"summary": f"Audit {i} (2026-04-01): old"} for i in range(1, 42)],
    }
    fixtures = {
        state / "progress.yaml": over_full,
        state / "decisions.yaml": over_archive,
        state / "health.yaml": over_total,
    }
    for path, data in fixtures.items():
        path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    originals = {path: path.read_text(encoding="utf-8") for path in fixtures}

    operations = {op.status.artifact: op for op in compaction.run_compaction(project, mode="check")}

    assert operations["PROGRESS.md"].action == "over_limit"
    assert operations["PROGRESS.md"].status.active_count == 11
    assert operations["DECISIONS.md"].action == "over_limit"
    assert operations["DECISIONS.md"].status.archive_count == 41
    assert operations["HEALTH.md"].action == "over_limit"
    assert operations["HEALTH.md"].status.total_count == 51
    for path, original in originals.items():
        assert path.read_text(encoding="utf-8") == original


def test_fix_mode_compacts_yaml_artifact_and_preserves_top_level_metadata(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    for name in ["decisions", "health"]:
        (state / f"{name}.yaml").write_text(f"{name if name != 'health' else 'audits'}: []\narchive: []\n", encoding="utf-8")

    before = {
        "meta": {"owner": "realisera"},
        "mapping": [{"artifact": "kept", "path": "unchanged"}],
        "protected_state": {"do_not_touch": True},
        "cycles": [_progress_cycle(i) for i in range(1, 61)],
        "archive": [{"summary": f"Cycle {i} (2026-04-01): archived"} for i in range(1, 6)],
    }
    protected_top_level = {key: copy.deepcopy(before[key]) for key in ("meta", "mapping", "protected_state")}
    progress_path = state / "progress.yaml"
    progress_path.write_text(yaml.safe_dump(before, sort_keys=False), encoding="utf-8")

    operations = {op.status.artifact: op for op in compaction.run_compaction(project, mode="fix")}
    after = yaml.safe_load(progress_path.read_text(encoding="utf-8"))
    progress_status = {status.artifact: status for status in compaction.compute_compaction_status(project)}["PROGRESS.md"]

    assert operations["PROGRESS.md"].action == "compacted"
    assert operations["PROGRESS.md"].changed is True
    assert len(after["cycles"]) == 10
    assert len(after["archive"]) == 40
    assert progress_status.over_limit_count == 0
    assert after["cycles"] == [_progress_cycle(i) for i in range(60, 50, -1)]
    for key, value in protected_top_level.items():
        assert after[key] == value


def test_fix_mode_compacts_todo_resolved_one_line_overflow(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    todo_path = state / "TODO.md"
    todo_path.write_text(
        "# TODO\n\n"
        "## Resolved\n\n"
        + "\n".join(f"- [x] [fix:2.2.2] Resolved item {i}" for i in range(53, 0, -1))
        + "\n",
        encoding="utf-8",
    )
    for name in ["progress", "decisions", "health"]:
        key = {"progress": "cycles", "decisions": "decisions", "health": "audits"}[name]
        (state / f"{name}.yaml").write_text(f"{key}: []\narchive: []\n", encoding="utf-8")

    check_ops = {op.status.artifact: op for op in compaction.run_compaction(project, mode="check")}
    fix_ops = {op.status.artifact: op for op in compaction.run_compaction(project, mode="fix")}
    after_status = {status.artifact: status for status in compaction.compute_compaction_status(project)}[
        "TODO.md#Resolved"
    ]

    assert check_ops["TODO.md#Resolved"].action == "over_limit"
    assert check_ops["TODO.md#Resolved"].status.archive_count == 53
    assert fix_ops["TODO.md#Resolved"].action == "compacted"
    assert fix_ops["TODO.md#Resolved"].result.oneline_after == 40
    assert after_status.active_count == 0
    assert after_status.archive_count == 40
    assert after_status.total_count == 40
    assert after_status.over_limit_count == 0


def test_decision_compaction_retains_schema_allowed_outcome_fields(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("cycles: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")
    unrelated_paths = [state / "progress.yaml", state / "health.yaml", state / "TODO.md"]
    unrelated_originals = {path: path.read_text(encoding="utf-8") for path in unrelated_paths}
    decisions_path = state / "decisions.yaml"
    decisions_path.write_text(
        yaml.safe_dump({"decisions": [_decision(i) for i in range(1, 13)], "archive": []}, sort_keys=False),
        encoding="utf-8",
    )

    operations = {op.status.artifact: op for op in compaction.run_compaction(project, mode="fix")}
    after = yaml.safe_load(decisions_path.read_text(encoding="utf-8"))

    assert operations["DECISIONS.md"].action == "compacted"
    assert [entry["number"] for entry in after["decisions"]] == [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    assert after["archive"] == [
        {
            "summary": "Decision 2 (2026-05-02): Choice 2",
            "number": 2,
            "date": "2026-05-02",
            "choice": "Choice 2",
            "feeds_into": "PLAN.md#DEC-2",
            "outcome": "Choice 2",
            "satisfaction": {
                "state": "user_confirmed_satisfied",
                "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
            },
        },
        {
            "summary": "Decision 1 (2026-05-01): Choice 1",
            "number": 1,
            "date": "2026-05-01",
            "choice": "Choice 1",
            "feeds_into": "PLAN.md#DEC-1",
            "outcome": "Choice 1",
            "satisfaction": {
                "state": "user_confirmed_satisfied",
                "user_confirmation": {"confirmed_by": "Jonathan", "confirmed_at": "2026-05-15"},
            },
        },
    ]
    for path, original in unrelated_originals.items():
        assert path.read_text(encoding="utf-8") == original


def test_decision_compaction_keeps_review_needed_active_entries_full(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("cycles: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")
    decisions = [_decision(i) for i in range(1, 13)]
    decisions[0]["satisfaction"] = {"state": "open"}
    decisions[1]["satisfaction"] = {"state": "provisionally_satisfied", "evidence": "local test evidence"}
    decisions_path = state / "decisions.yaml"
    decisions_path.write_text(yaml.safe_dump({"decisions": decisions, "archive": []}, sort_keys=False), encoding="utf-8")

    operations = {op.status.artifact: op for op in compaction.run_compaction(project, mode="fix")}
    after = yaml.safe_load(decisions_path.read_text(encoding="utf-8"))

    assert operations["DECISIONS.md"].action == "compacted"
    assert [entry["number"] for entry in after["decisions"]] == [1, 2, 5, 6, 7, 8, 9, 10, 11, 12]
    assert {entry["number"] for entry in after["archive"]} == {3, 4}
    assert all(entry["number"] not in {1, 2} for entry in after["archive"])
    assert after["decisions"][0]["satisfaction"] == {"state": "open"}
    assert after["decisions"][1]["satisfaction"] == {
        "state": "provisionally_satisfied",
        "evidence": "local test evidence",
    }


def test_decision_protected_overflow_reports_review_pressure_without_mutation(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("cycles: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")
    decisions_path = state / "decisions.yaml"
    decisions = [_decision(i) for i in range(1, 12)]
    for entry in decisions:
        entry["satisfaction"] = {"state": "open"}
    decisions_path.write_text(yaml.safe_dump({"decisions": decisions, "archive": []}, sort_keys=False), encoding="utf-8")
    original = decisions_path.read_text(encoding="utf-8")

    check_ops = {op.status.artifact: op for op in compaction.run_compaction(project, mode="check")}
    fix_ops = {op.status.artifact: op for op in compaction.run_compaction(project, mode="fix")}

    assert check_ops["DECISIONS.md"].action == "protected_overflow"
    assert check_ops["DECISIONS.md"].message == "protected-overflow review pressure by 1"
    assert check_ops["DECISIONS.md"].status.protected_overflow_count == 1
    assert fix_ops["DECISIONS.md"].action == "protected_overflow"
    assert decisions_path.read_text(encoding="utf-8") == original


def test_decision_compaction_requires_review_before_dropping_legacy_archive(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("cycles: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")
    decisions_path = state / "decisions.yaml"
    decisions_path.write_text(
        yaml.safe_dump(
            {
                "decisions": [],
                "archive": [
                    {"summary": f"Decision {i} (2026-04-01): archived"}
                    for i in range(1, 42)
                ],
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    original = decisions_path.read_text(encoding="utf-8")

    operations = {op.status.artifact: op for op in compaction.run_compaction(project, mode="fix")}

    assert operations["DECISIONS.md"].action == "protected_overflow"
    assert "protected-overflow review pressure" in operations["DECISIONS.md"].message
    assert decisions_path.read_text(encoding="utf-8") == original


def test_fix_mode_reports_missing_and_protected_without_blocking_compactable(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text(
        yaml.safe_dump({"cycles": [_progress_cycle(i) for i in range(1, 12)], "archive": []}, sort_keys=False),
        encoding="utf-8",
    )
    (state / "vision.yaml").write_text("personas: []\n", encoding="utf-8")
    experiments = project / ".agentera" / "optimera" / "speed" / "experiments.yaml"
    experiments.parent.mkdir(parents=True)
    experiments.write_text("experiments:\n- number: 1\narchive: []\n", encoding="utf-8")

    operations = compaction.run_compaction(project, mode="fix")
    by_artifact = {op.status.artifact: op for op in operations if op.status.artifact != "EXPERIMENTS.md"}
    experiment_op = next(op for op in operations if op.status.artifact == "EXPERIMENTS.md")
    statuses = {status.artifact: status for status in compaction.compute_compaction_status(project)}

    assert by_artifact["PROGRESS.md"].action == "compacted"
    assert statuses["PROGRESS.md"].over_limit_count == 0
    assert by_artifact["DECISIONS.md"].action == "missing"
    assert by_artifact["HEALTH.md"].action == "missing"
    assert by_artifact["VISION.md"].action == "skipped"
    assert experiment_op.action == "skipped"
    assert experiments.read_text(encoding="utf-8") == "experiments:\n- number: 1\narchive: []\n"


def test_compute_compaction_status_error_on_non_mapping_yaml_root(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("- not a mapping\n", encoding="utf-8")
    (state / "decisions.yaml").write_text("decisions:\n- number: 1\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")

    statuses = {status.artifact: status for status in compaction.compute_compaction_status(project)}

    assert statuses["PROGRESS.md"].classification == "error"
    assert statuses["PROGRESS.md"].active_count is None
    assert statuses["PROGRESS.md"].archive_count is None
    assert "mapping" in statuses["PROGRESS.md"].reason.lower()
    assert statuses["DECISIONS.md"].classification == "compactable"
    assert statuses["HEALTH.md"].classification == "compactable"


def test_compute_compaction_status_error_on_corrupt_experiments_yaml(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("cycles: []\narchive: []\n", encoding="utf-8")
    (state / "decisions.yaml").write_text("decisions: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")
    experiments = project / ".agentera" / "optimera" / "speed" / "experiments.yaml"
    experiments.parent.mkdir(parents=True)
    experiments.write_text("scalar root\n", encoding="utf-8")

    statuses = {status.artifact: status for status in compaction.compute_compaction_status(project)}

    assert statuses["EXPERIMENTS.md"].classification == "error"
    assert statuses["EXPERIMENTS.md"].active_count is None
    assert "mapping" in statuses["EXPERIMENTS.md"].reason.lower()
    assert statuses["PROGRESS.md"].classification == "compactable"


def test_check_mode_reports_yaml_error_without_mutation(compaction, tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    progress_path = state / "progress.yaml"
    progress_path.write_text("- not a mapping\n", encoding="utf-8")
    (state / "decisions.yaml").write_text("decisions: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")
    original = progress_path.read_text(encoding="utf-8")

    operations = {op.status.artifact: op for op in compaction.run_compaction(project, mode="check")}

    assert operations["PROGRESS.md"].action == "error"
    assert operations["PROGRESS.md"].status.classification == "error"
    assert "mapping" in operations["PROGRESS.md"].message.lower()
    assert operations["DECISIONS.md"].action == "ok"
    assert progress_path.read_text(encoding="utf-8") == original


def test_compact_check_cli_reports_yaml_error_without_traceback(tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("- not a mapping\n", encoding="utf-8")
    (state / "decisions.yaml").write_text("decisions: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")

    result = _run_cli(project, "compact", "--mode", "check", "--format", "json")
    payload = json.loads(result.stdout)
    progress = next(op for op in payload["operations"] if op["artifact"] == "PROGRESS.md")

    assert result.returncode == 2
    assert "Traceback" not in result.stderr
    assert "Traceback" not in result.stdout
    assert payload["status"] == "fail"
    assert payload["summary"]["error_count"] == 1
    assert progress["action"] == "error"
    assert progress["classification"] == "error"
    assert "mapping" in progress["message"].lower()


def test_gate_cli_reports_yaml_error_without_traceback(tmp_path):
    project = tmp_path
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text("- not a mapping\n", encoding="utf-8")
    (state / "decisions.yaml").write_text("decisions: []\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits: []\narchive: []\n", encoding="utf-8")

    result = _run_cli(project, "gate", "--format", "json")
    payload = json.loads(result.stdout)
    progress = next(op for op in payload["operations"] if op["artifact"] == "PROGRESS.md")

    assert result.returncode == 2
    assert "Traceback" not in result.stderr
    assert "Traceback" not in result.stdout
    assert payload["command"] == "gate"
    assert payload["status"] == "fail"
    assert progress["action"] == "error"
    assert progress["classification"] == "error"
    assert "mapping" in progress["message"].lower()
