"""Task 3 coverage: state, report, and check namespace parsers with delegation."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = str(REPO_ROOT / "scripts" / "agentera")


def _run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    run_env = {
        **os.environ,
        "PROFILERA_PROFILE_DIR": str((cwd or REPO_ROOT) / ".xdg" / "agentera"),
    }
    if env:
        run_env.update(env)
    return subprocess.run(
        [sys.executable, CLI, *args],
        capture_output=True,
        text=True,
        cwd=cwd or REPO_ROOT,
        env=run_env,
    )


class TestStateNamespace:
    def test_state_plan_json_matches_legacy_plan_envelope(self):
        legacy = _run("plan", "--format", "json")
        canonical = _run("state", "plan", "--format", "json")

        assert legacy.returncode == 0, legacy.stderr
        assert canonical.returncode == 0, canonical.stderr
        assert json.loads(canonical.stdout) == json.loads(legacy.stdout)

    def test_state_plan_json_includes_source_contract(self):
        r = _run("state", "plan", "--format", "json")

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "plan"
        assert "source_contract" in data

    def test_plan_prints_deprecation_and_delegates(self):
        r = _run("plan", "--format", "json")

        assert r.returncode == 0, r.stderr
        assert "Deprecation: agentera plan is deprecated; use agentera state plan" in r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "plan"


class TestReportNamespace:
    def test_report_missing_corpus_matches_stats_behavior(self, tmp_path: Path):
        profile_dir = tmp_path / "profile"
        profile_dir.mkdir()
        extra_env = {
            "PROFILERA_PROFILE_DIR": str(profile_dir),
            "AGENTERA_USAGE_DIR": str(tmp_path / "usage"),
        }

        stats = _run("stats", env=extra_env)
        report = _run("report", env=extra_env)

        assert stats.returncode == report.returncode == 2
        assert "stats data missing" in stats.stderr
        assert "stats data missing" in report.stderr
        assert "Plain stats does not read local runtime history." in report.stderr
        assert "Deprecation: agentera stats is deprecated; use agentera report" in stats.stderr
        assert "Deprecation:" not in report.stderr

    def test_report_refresh_dry_run_matches_stats_refresh(self, tmp_path: Path):
        profile_dir = tmp_path / "profile"
        profile_dir.mkdir()

        stats = _run(
            "stats",
            "refresh",
            "--dry-run",
            "--format",
            "json",
            env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(tmp_path / "usage")},
        )
        report = _run(
            "report",
            "refresh",
            "--dry-run",
            "--format",
            "json",
            env={"PROFILERA_PROFILE_DIR": str(profile_dir), "AGENTERA_USAGE_DIR": str(tmp_path / "usage")},
        )

        assert stats.returncode == report.returncode == 0
        assert json.loads(stats.stdout) == json.loads(report.stdout)

    def test_report_refresh_requires_local_history_consent(self):
        stats = _run("stats", "refresh")
        report = _run("report", "refresh")

        assert stats.returncode == report.returncode == 2
        assert "agentera stats refresh --dry-run" in stats.stderr
        assert stats.stderr.split("Error: ", 1)[-1] == report.stderr.split("Error: ", 1)[-1]

    def test_stats_prints_deprecation(self):
        r = _run("stats")

        assert r.returncode == 2
        assert "Deprecation: agentera stats is deprecated; use agentera report" in r.stderr


class TestCheckNamespace:
    def test_check_validate_capability_hej_delegates(self):
        legacy = _run("validate", "capability", "hej", "--format", "json")
        canonical = _run("check", "validate", "capability", "hej", "--format", "json")

        assert legacy.returncode == canonical.returncode == 0
        assert json.loads(legacy.stdout) == json.loads(canonical.stdout)

    def test_check_verify_smoke_installed_skills_delegates(self):
        legacy = _run("verify", "smoke", "installed-skills", "--format", "json")
        canonical = _run("check", "verify", "smoke", "installed-skills", "--format", "json")

        assert legacy.returncode == canonical.returncode
        assert json.loads(legacy.stdout) == json.loads(canonical.stdout)

    def test_check_compact_default_matches_gate(self):
        gate = _run("gate", "--format", "json")
        compact = _run("check", "compact", "--format", "json")

        assert gate.returncode == compact.returncode
        assert json.loads(gate.stdout) == json.loads(compact.stdout)
        payload = json.loads(compact.stdout)
        assert payload["command"] == "gate"
        assert payload["gate"] == "compaction"

    def test_validate_and_gate_print_deprecation(self):
        validate = _run("validate", "capability", "hej", "--format", "json")
        gate = _run("gate", "--format", "json")

        assert "Deprecation: agentera validate is deprecated; use agentera check validate" in validate.stderr
        assert "Deprecation: agentera gate is deprecated; use agentera check compact" in gate.stderr
