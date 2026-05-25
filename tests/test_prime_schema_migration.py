"""Task 2 coverage: prime default briefing, schema command, and deprecation aliases."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

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


def _write_bundle_with_commands(root: Path, *, commands: tuple[str, ...]) -> None:
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    parser_lines = [
        "#!/usr/bin/env python3",
        "import argparse",
        "parser = argparse.ArgumentParser(prog='agentera')",
        "sub = parser.add_subparsers(dest='command')",
    ]
    for name in commands:
        parser_lines.append(f"sub.add_parser({name!r})")
    parser_lines.append("parser.parse_args()")
    script = scripts / "agentera"
    script.write_text("\n".join(parser_lines) + "\n", encoding="utf-8")
    script.chmod(0o755)
    (root / "skills" / "agentera").mkdir(parents=True)
    (root / "skills" / "agentera" / "SKILL.md").write_text(
        '---\nname: agentera\nversion: "2.6.0"\n---\n',
        encoding="utf-8",
    )
    (root / "registry.json").write_text(
        json.dumps({"skills": [{"name": "agentera", "version": "2.6.0"}]}),
        encoding="utf-8",
    )
    (root / ".agentera-bundle.json").write_text(
        json.dumps({"schemaVersion": "agentera.bundle.v1", "version": "2.6.0"}),
        encoding="utf-8",
    )


class TestPrimeDefaultBriefing:
    def test_prime_default_text_emits_orientation_briefing(self):
        r = _run("prime")

        assert r.returncode == 0, r.stderr
        assert "agentera prime" in r.stdout
        assert "app_home: status=" in r.stdout
        assert "next_action:" in r.stdout
        assert "source_contract:" in r.stdout

    def test_prime_default_json_emits_orientation_envelope(self):
        r = _run("prime", "--format", "json")

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "prime"
        assert data["status"] == "ok"
        assert "app_home" in data
        assert "health" in data
        assert "plan" in data
        assert "attention" in data
        assert "next_action" in data
        assert "source_contract" in data

    def test_prime_guidance_prints_static_prose(self):
        r = _run("prime", "--guidance")

        assert r.returncode == 0, r.stderr
        assert "agentera priming guide" in r.stdout
        assert "agentera prime --guidance" in r.stdout

    def test_prime_context_json_unchanged(self):
        r = _run("prime", "--context", "planera", "--format", "json")

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "prime"
        assert "capability_context" in data
        assert "app_home" not in data


class TestSchemaCommand:
    def test_schema_json_returns_runtime_introspection(self):
        r = _run("schema", "--format", "json")

        assert r.returncode == 0, r.stderr
        data = json.loads(r.stdout)
        assert data["schemaVersion"] == "agentera.schema.v1"
        assert data["command"] == "schema"
        assert data["status"] == "ok"
        assert "commands" in data
        assert "artifact_schemas" in data
        assert "doctor" in data
        command_names = {entry["name"] for entry in data["commands"]}
        assert {"prime", "schema", "doctor", "upgrade", "planera"}.issubset(command_names)

    def test_schema_yaml_is_parseable(self):
        r = _run("schema", "--format", "yaml")

        assert r.returncode == 0, r.stderr
        data = yaml.safe_load(r.stdout)
        assert data["command"] == "schema"
        assert data["status"] == "ok"


class TestDeprecationAliases:
    def test_hej_prints_deprecation_and_delegates_to_prime(self):
        r = _run("hej")

        assert r.returncode == 0, r.stderr
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in r.stderr
        assert "agentera prime" in r.stdout
        assert "next_action:" in r.stdout

    def test_hej_json_delegates_with_prime_command(self):
        r = _run("hej", "--format", "json")

        assert r.returncode == 0, r.stderr
        assert "Deprecation: agentera hej is deprecated; use agentera prime" in r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "prime"

    def test_describe_prints_deprecation_and_delegates_to_schema(self):
        r = _run("describe", "--format", "json")

        assert r.returncode == 0, r.stderr
        assert "Deprecation: agentera describe is deprecated; use agentera schema" in r.stderr
        data = json.loads(r.stdout)
        assert data["command"] == "schema"
        assert data["schemaVersion"] == "agentera.schema.v1"


class TestDoctorExpectCommandDefault:
    def test_doctor_defaults_to_prime_expected_command(self, tmp_path: Path):
        install_root = tmp_path / "home" / ".agents" / "agentera"
        _write_bundle_with_commands(install_root, commands=("hej", "query"))

        r = subprocess.run(
            [sys.executable, CLI, "doctor", "--install-root", str(install_root), "--expected-version", "2.6.0", "--json"],
            capture_output=True,
            text=True,
            cwd=tmp_path,
            env={
                **os.environ,
                "HOME": str(tmp_path / "home"),
                "AGENTERA_HOME": str(REPO_ROOT),
                "AGENTERA_BOOTSTRAP_SOURCE_ROOT": str(REPO_ROOT),
            },
        )

        assert r.returncode == 1, r.stderr
        payload = json.loads(r.stdout)
        missing_command_signals = [
            signal for signal in payload["signals"] if signal["kind"] == "missing_command"
        ]
        assert missing_command_signals
        assert missing_command_signals[0]["missingCommands"] == ["prime"]
