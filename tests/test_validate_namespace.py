from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"
CAPABILITY_VALIDATOR = REPO_ROOT / "scripts" / "validate_capability.py"
ARTIFACT_VALIDATOR = REPO_ROOT / "hooks" / "validate_artifact.py"
HEJ_CAPABILITY = REPO_ROOT / "skills" / "agentera" / "capabilities" / "hej"


def _run_cli(*args: str, cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def _run_capability_validator(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CAPABILITY_VALIDATOR), *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def _run_artifact_validator(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ARTIFACT_VALIDATOR), *args],
        cwd=project,
        text=True,
        capture_output=True,
        check=False,
    )


def _write_valid_progress(path: Path) -> None:
    path.write_text(
        yaml.safe_dump(
            {
                "cycles": [
                    {
                        "number": 1,
                        "timestamp": "2026-05-15 10:00",
                        "type": "feat",
                        "phase": "build",
                        "what": "Implemented validate namespace fixture",
                        "commit": "pending",
                        "context": {"intent": "exercise validate namespace"},
                    }
                ]
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )


def test_validate_capability_text_matches_direct_validator() -> None:
    namespace = _run_cli("validate", "capability", "hej")
    direct = _run_capability_validator(str(HEJ_CAPABILITY))

    assert namespace.returncode == direct.returncode == 0
    assert namespace.stdout == direct.stdout
    assert namespace.stderr == direct.stderr == ""
    assert "PASS: capability directory is valid" in namespace.stdout


def test_validate_capability_json_reports_successful_delegated_validation() -> None:
    result = _run_cli("validate", "capability", "hej", "--format", "json")
    payload = json.loads(result.stdout)

    assert result.returncode == 0
    assert payload["command"] == "validate"
    assert payload["status"] == "pass"
    assert payload["target_family"] == "capability"
    assert payload["target"] == "hej"
    assert payload["path"] == str(HEJ_CAPABILITY)
    assert payload["violations"] == []
    assert payload["engine"]["exit_code"] == 0
    assert "PASS: capability directory is valid" in payload["engine"]["stdout"]


def test_validate_artifact_json_matches_direct_validator_payload(tmp_path: Path) -> None:
    progress = tmp_path / "progress.yaml"
    _write_valid_progress(progress)

    namespace = _run_cli(
        "validate",
        "artifact",
        "--artifact",
        "PROGRESS.md",
        "--file",
        str(progress),
        "--format",
        "json",
        cwd=tmp_path,
    )
    direct = _run_artifact_validator(
        tmp_path,
        "--artifact",
        "PROGRESS.md",
        "--file",
        str(progress),
        "--format",
        "json",
    )
    namespace_payload = json.loads(namespace.stdout)
    direct_payload = json.loads(direct.stdout)

    assert namespace.returncode == direct.returncode == 0
    assert namespace_payload["command"] == "validate"
    assert namespace_payload["target_family"] == "artifact"
    assert namespace_payload["target"] == "PROGRESS.md"
    assert namespace_payload["engine"] == {"command": "validate-artifact", "exit_code": 0}
    for key in ("status", "artifact", "file", "path_source", "violations"):
        assert namespace_payload[key] == direct_payload[key]
    assert namespace_payload["status"] == "pass"
    assert namespace_payload["violations"] == []


def test_validate_invalid_capability_target_names_valid_values_syntax_and_example() -> None:
    result = _run_cli("validate", "capability", "notreal", "--format", "json")

    assert result.returncode == 2
    assert result.stdout == ""
    assert "unsupported capability target 'notreal'" in result.stderr
    assert "valid capability names: hej, visionera, resonera" in result.stderr
    assert "Syntax: agentera validate capability <capability-or-path> [--format text|json]" in result.stderr
    assert "Example: agentera validate capability hej" in result.stderr


def test_validate_help_discovers_namespace_without_renaming_targets() -> None:
    root_help = _run_cli("--help")
    validate_help = _run_cli("validate", "--help")
    artifact_help = _run_cli("validate", "artifact", "--help")
    descriptors_help = _run_cli("validate", "descriptors", "--help")

    assert root_help.returncode == validate_help.returncode == artifact_help.returncode == descriptors_help.returncode == 0
    assert "validate" in root_help.stdout
    assert "Validate capabilities, artifacts, or descriptors" in root_help.stdout
    assert "agentera validate capability hej" in validate_help.stdout
    assert "agentera validate artifact --artifact" in validate_help.stdout
    assert "agentera validate descriptors" in validate_help.stdout
    assert "PLAN.md --file .agentera/plan.yaml --format json" in validate_help.stdout
    assert "capability" in validate_help.stdout
    assert "artifact" in validate_help.stdout
    assert "descriptors" in validate_help.stdout
    assert "PROGRESS.md" in artifact_help.stdout
    assert "PLAN.md" in artifact_help.stdout
    assert "OpenCode" in descriptors_help.stdout


def test_validate_descriptors_json_reports_runtime_descriptor_parity() -> None:
    result = _run_cli("validate", "descriptors", "--format", "json")
    payload = json.loads(result.stdout)

    assert result.returncode == 0
    assert payload["command"] == "validate"
    assert payload["status"] == "pass"
    assert payload["target_family"] == "descriptors"
    assert payload["target"] == "agent-descriptors"
    assert payload["summary"] == {"passed": 24, "failed": 0}
    assert payload["violations"] == []
    assert {(check["runtime"], check["capability"]) for check in payload["checks"]} >= {
        ("codex", "realisera"),
        ("opencode", "realisera"),
        ("codex", "orkestrera"),
        ("opencode", "orkestrera"),
    }
