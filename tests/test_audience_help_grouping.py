"""Task 4 coverage: audience-grouped help and preserved top-level routing."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = str(REPO_ROOT / "scripts" / "agentera")


def _run(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, CLI, *args],
        capture_output=True,
        text=True,
        cwd=cwd or REPO_ROOT,
        env={
            **os.environ,
            "PROFILERA_PROFILE_DIR": str((cwd or REPO_ROOT) / ".xdg" / "agentera"),
        },
    )


def _command_choices(help_text: str) -> set[str]:
    match = re.search(r"\{([^}]+)\}", help_text, re.DOTALL)
    assert match is not None, help_text
    return {choice.strip() for choice in match.group(1).replace("\n", "").split(",")}


CAPABILITY_ROUTING_NAMES = {
    "visionera",
    "resonera",
    "inspirera",
    "planera",
    "realisera",
    "optimera",
    "inspektera",
    "dokumentera",
    "profilera",
    "visualisera",
    "orkestrera",
}


class TestAudienceGroupedHelp:
    def test_root_help_groups_commands_by_audience(self):
        result = _run("--help")

        assert result.returncode == 0, result.stderr
        assert "Agent commands:" in result.stdout
        assert "User commands:" in result.stdout
        assert "Maintainer commands:" in result.stdout
        assert "prime" in result.stdout
        assert "state" in result.stdout
        assert "report" in result.stdout
        assert "check" in result.stdout
        assert "hej" not in result.stdout

    def test_root_help_lists_prime_not_hej_in_usage(self):
        result = _run("--help")
        choices = _command_choices(result.stdout)

        assert "prime" in choices
        assert "hej" not in choices
        assert choices == {
            "prime",
            "schema",
            "state",
            *CAPABILITY_ROUTING_NAMES,
            "upgrade",
            "doctor",
            "report",
            "check",
        }

    def test_hej_remains_hidden_deprecation_alias(self):
        result = _run("hej")

        assert result.returncode == 0, result.stderr
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in result.stderr
        assert "agentera prime" in result.stdout


class TestPreservedTopLevelCommands:
    @pytest.mark.parametrize("capability", sorted(CAPABILITY_ROUTING_NAMES))
    def test_capability_routing_guidance_unchanged(self, capability: str):
        result = _run(capability)

        assert result.returncode == 0, result.stderr
        assert f"capability: {capability}" in result.stdout
        assert f"invoke: /agentera {capability}" in result.stdout

    def test_upgrade_help_and_json_shape_unchanged(self):
        help_result = _run("upgrade", "--help")
        dry_run = _run("upgrade", "--dry-run", "--json")

        assert help_result.returncode == 0, help_result.stderr
        assert "--dry-run" in help_result.stdout
        assert "--yes" in help_result.stdout
        assert dry_run.returncode in {0, 1}, dry_run.stderr
        payload = json.loads(dry_run.stdout)
        assert payload["status"] in {"planned", "applied", "noop", "migration_needed", "pending"}
        assert "appHome" in payload

    def test_doctor_help_and_json_shape_unchanged(self):
        help_result = _run("doctor", "--help")
        status = _run("doctor", "--json")

        assert help_result.returncode == 0, help_result.stderr
        assert "--expect-command" in help_result.stdout
        assert "--json" in help_result.stdout
        assert status.returncode in {0, 1}, status.stderr
        payload = json.loads(status.stdout)
        assert "signals" in payload
        assert "appHome" in payload
