"""Task 6 closeout: consolidated namespace migration test coverage."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = str(REPO_ROOT / "scripts" / "agentera")

STATE_ROUTINES = ("progress", "health", "todo", "docs", "decisions", "objective", "experiments")


def _run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    run_env = {
        **os.environ,
        "PROFILERA_PROFILE_DIR": str(REPO_ROOT / ".xdg" / "agentera"),
    }
    if env:
        run_env.update(env)
    return subprocess.run(
        [sys.executable, CLI, *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=run_env,
    )


class TestStateNamespaceCloseout:
    @pytest.mark.parametrize("routine", STATE_ROUTINES)
    def test_state_routine_json_matches_legacy_alias(self, routine: str):
        legacy = _run(routine, "--format", "json")
        canonical = _run("state", routine, "--format", "json")

        assert legacy.returncode == canonical.returncode == 0, legacy.stderr or canonical.stderr
        assert json.loads(canonical.stdout) == json.loads(legacy.stdout)

    def test_state_query_list_artifacts_matches_legacy_query(self):
        legacy = _run("query", "--list-artifacts", "--format", "json")
        canonical = _run("state", "query", "--list-artifacts", "--format", "json")

        assert legacy.returncode == canonical.returncode == 0
        assert json.loads(canonical.stdout) == json.loads(legacy.stdout)


class TestCheckNamespaceCloseout:
    def test_check_lint_matches_legacy_lint(self):
        args = (
            "lint",
            "--artifact",
            "PROGRESS.md",
            "--text",
            "# Progress",
            "--format",
            "json",
        )
        legacy = _run(*args)
        canonical = _run("check", *args)

        assert legacy.returncode == canonical.returncode
        assert json.loads(canonical.stdout) == json.loads(legacy.stdout)

    def test_check_validate_descriptors_matches_legacy(self):
        legacy = _run("validate", "descriptors", "--format", "json")
        canonical = _run("check", "validate", "descriptors", "--format", "json")

        assert legacy.returncode == canonical.returncode == 0
        assert json.loads(canonical.stdout) == json.loads(legacy.stdout)


class TestSchemaAndPrimeCloseout:
    def test_schema_json_is_canonical_discovery_surface(self):
        result = _run("schema", "--format", "json")

        assert result.returncode == 0, result.stderr
        payload = json.loads(result.stdout)
        assert payload["command"] == "schema"
        assert payload["schemaVersion"] == "agentera.schema.v1"

    def test_describe_alias_delegates_to_schema(self):
        result = _run("describe", "--format", "json")

        assert result.returncode == 0, result.stderr
        assert "Deprecation: agentera describe is deprecated; use agentera schema" in result.stderr
        assert json.loads(result.stdout)["command"] == "schema"

    def test_prime_default_json_matches_hej_alias(self):
        prime = _run("prime", "--format", "json")
        hej = _run("hej", "--format", "json")

        assert prime.returncode == hej.returncode == 0
        prime_payload = json.loads(prime.stdout)
        hej_payload = json.loads(hej.stdout)
        assert prime_payload["command"] == "prime"
        assert hej_payload["command"] == "hej"
        prime_payload["command"] = "hej"
        prime_payload["source_contract"]["access"] = prime_payload["source_contract"]["access"].replace("normal prime", "normal hej")
        prime_payload["source_contract"]["render"] = prime_payload["source_contract"]["render"].replace("prime orientation", "hej")
        assert prime_payload == hej_payload
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in hej.stderr
