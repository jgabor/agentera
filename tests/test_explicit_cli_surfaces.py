from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"
VALIDATOR = REPO_ROOT / "hooks" / "validate_artifact.py"


def _run_cli(project: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=project,
        capture_output=True,
        text=True,
    )


def _run_validator(project: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), *args],
        cwd=project,
        capture_output=True,
        text=True,
    )


def _write_docs_mapping(project: Path, state_dir: str = "state") -> None:
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
        "- artifact: SESSION.md\n"
        f"  path: {state_dir}/session.yaml\n",
        encoding="utf-8",
    )


def _cycle(number: int) -> dict:
    return {
        "number": number,
        "timestamp": f"2026-05-{number:02d} 10:00",
        "type": "fix",
        "phase": "build",
        "what": f"Implemented fixture cycle {number}",
        "commit": "N/A",
        "context": {"intent": "exercise explicit CLI surface"},
    }


def _write_compaction_project(project: Path, progress_cycles: int) -> None:
    _write_docs_mapping(project)
    state = project / "state"
    state.mkdir()
    (state / "TODO.md").write_text("# TODO\n", encoding="utf-8")
    (state / "progress.yaml").write_text(
        yaml.safe_dump({"cycles": [_cycle(i) for i in range(progress_cycles, 0, -1)], "archive": []}, sort_keys=False),
        encoding="utf-8",
    )
    (state / "decisions.yaml").write_text("decisions:\n- number: 1\narchive: []\n", encoding="utf-8")
    (state / "health.yaml").write_text("audits:\n- number: 1\narchive: []\n", encoding="utf-8")
    (state / "session.yaml").write_text("bookmarks:\n- timestamp: '2026-05-14 10:00'\narchive: []\n", encoding="utf-8")


def test_compact_json_check_reports_over_limit_and_mapped_path(tmp_path: Path):
    _write_compaction_project(tmp_path, progress_cycles=11)

    result = _run_cli(tmp_path, "compact", "--format", "json")
    payload = json.loads(result.stdout)
    progress = next(op for op in payload["operations"] if op["artifact"] == "PROGRESS.md")

    assert result.returncode == 1
    assert payload["status"] == "fail"
    assert payload["summary"]["over_limit_count"] == 1
    assert "agentera compact --mode fix" in payload["summary"]["guidance"]
    assert progress["action"] == "over_limit"
    assert progress["active_count"] == 11
    assert progress["over_limit_count"] == 1
    assert progress["path"] == str(tmp_path / "state" / "progress.yaml")
    assert "uv run scripts/agentera compact --mode check --format json" in payload["summary"]["guidance"]
    assert "uv run scripts/agentera compact --mode fix --format json" in payload["summary"]["guidance"]


def test_gate_json_fails_over_limit_without_mutation_and_names_safe_commands(tmp_path: Path):
    _write_compaction_project(tmp_path, progress_cycles=11)
    progress_path = tmp_path / "state" / "progress.yaml"
    before = progress_path.read_text(encoding="utf-8")

    result = _run_cli(tmp_path, "gate", "--format", "json")
    payload = json.loads(result.stdout)
    progress = next(op for op in payload["operations"] if op["artifact"] == "PROGRESS.md")

    assert result.returncode == 1
    assert payload["command"] == "gate"
    assert payload["gate"] == "compaction"
    assert payload["status"] == "fail"
    assert progress["action"] == "over_limit"
    assert progress["path"] == str(progress_path)
    assert progress_path.read_text(encoding="utf-8") == before
    assert "Over-limit compactable artifacts: PROGRESS.md" in payload["summary"]["guidance"]
    assert "uv run scripts/agentera compact --mode check --format json" in payload["summary"]["guidance"]
    assert "uv run scripts/agentera compact --mode fix --format json" in payload["summary"]["guidance"]


def test_gate_text_passes_when_compactable_artifacts_are_in_bounds(tmp_path: Path):
    _write_compaction_project(tmp_path, progress_cycles=10)

    result = _run_cli(tmp_path, "gate")

    assert result.returncode == 0
    assert "status=pass" in result.stdout
    assert "over_limit:0" in result.stdout
    assert "No repair needed" in result.stdout


def test_compact_text_check_reports_in_bounds_with_guidance(tmp_path: Path):
    _write_compaction_project(tmp_path, progress_cycles=10)

    result = _run_cli(tmp_path, "compact")

    assert result.returncode == 0
    assert "status=pass" in result.stdout
    assert "over_limit:0" in result.stdout
    assert "No repair needed" in result.stdout


def test_compact_fix_compacts_isolated_fixture_only(tmp_path: Path):
    _write_compaction_project(tmp_path, progress_cycles=12)

    result = _run_cli(tmp_path, "compact", "--mode", "fix", "--format", "json")
    payload = json.loads(result.stdout)
    progress = next(op for op in payload["operations"] if op["artifact"] == "PROGRESS.md")

    assert result.returncode == 0
    assert payload["status"] == "pass"
    assert progress["action"] == "compacted"
    assert progress["result"]["active_after"] == 10


def test_explicit_validator_valid_file_passes_and_reports_provided_path(tmp_path: Path):
    artifact = tmp_path / "custom-progress.yaml"
    artifact.write_text(yaml.safe_dump({"cycles": [_cycle(1)]}, sort_keys=False), encoding="utf-8")

    result = _run_validator(tmp_path, "--artifact", "PROGRESS.md", "--file", str(artifact), "--format", "json")
    payload = json.loads(result.stdout)

    assert result.returncode == 0
    assert payload["status"] == "pass"
    assert payload["file"] == str(artifact)
    assert payload["path_source"] == "provided"


def test_explicit_validator_invalid_file_fails_truthfully(tmp_path: Path):
    artifact = tmp_path / "bad-progress.yaml"
    artifact.write_text("cycles:\n- number: 1\n", encoding="utf-8")

    result = _run_validator(tmp_path, "--artifact", "PROGRESS.md", "--file", str(artifact))

    assert result.returncode == 2
    assert "status=fail" in result.stdout
    assert "missing required field" in result.stderr


def test_explicit_validator_uses_docs_mapped_default_when_file_omitted(tmp_path: Path):
    _write_docs_mapping(tmp_path)
    state = tmp_path / "state"
    state.mkdir()
    mapped = state / "progress.yaml"
    mapped.write_text(yaml.safe_dump({"cycles": [_cycle(1)]}, sort_keys=False), encoding="utf-8")

    result = _run_validator(tmp_path, "--artifact", "PROGRESS.md", "--format", "json")
    payload = json.loads(result.stdout)

    assert result.returncode == 0
    assert payload["status"] == "pass"
    assert payload["file"] == str(mapped)
    assert payload["docs_mapped_default"] == str(mapped)
    assert payload["path_source"] == "docs_mapped_default"


def test_repository_gate_is_wired_into_commit_push_and_ci_automation():
    lefthook = (REPO_ROOT / ".lefthook.yml").read_text(encoding="utf-8")
    ci = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert lefthook.count("uv run scripts/agentera gate") >= 2
    assert "pre-commit:" in lefthook
    assert "pre-push:" in lefthook
    assert "Repository gates" in ci
    assert "uv run scripts/agentera gate" in ci
