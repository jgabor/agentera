from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"
SCRIPTS = REPO_ROOT / "scripts"
SEMANTIC_FIXTURE = REPO_ROOT / "fixtures" / "semantic" / "hej-bare-message.md"


def _run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def _run_python_script(script: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / script), *args],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_verify_smoke_text_output_reports_success_and_safe_default() -> None:
    result = _run_cli("check", "verify", "smoke", "installed-skills")

    assert result.returncode == 0, result.stderr
    assert "verify smoke installed-skills: pass (engine_exit=0)" in result.stdout
    assert "scripts/smoke_installed_skills.py" in result.stdout
    assert "safety=offline" in result.stdout
    assert "real npx not attempted" in result.stdout
    assert result.stderr == ""


def test_verify_eval_json_output_reports_bounded_dry_run_success() -> None:
    result = _run_cli("verify", "eval", "skills", "--format", "json")
    payload = json.loads(result.stdout)

    assert result.returncode == 0, result.stderr
    assert payload["command"] == "verify"
    assert payload["status"] == "pass"
    assert payload["family"] == "eval"
    assert payload["target"] == "skills"
    assert payload["format"] == "json"
    assert payload["engine"]["exit_code"] == 0
    assert payload["engine"]["command"][-7:] == [
        "--parallel",
        "1",
        "--timeout",
        "120",
        "--runtime",
        "claude",
        "--dry-run",
    ]
    assert "eval_skills.py" in payload["engine"]["command"][1]
    assert payload["diagnostics"]["line_limit"] == 20
    assert payload["safety"]["mode"] == "dry-run"
    assert payload["safety"]["live"] is False
    assert payload["safety"]["long_running_default"] is False
    assert any('\"mode\": \"dry-run\"' in line for line in payload["diagnostics"]["stdout"])


def test_verify_semantic_json_requires_explicit_fixture_and_passes_offline() -> None:
    result = _run_cli("verify", "eval", "semantic", str(SEMANTIC_FIXTURE), "--format", "json")
    payload = json.loads(result.stdout)

    assert result.returncode == 0, result.stderr
    assert payload["status"] == "pass"
    assert payload["family"] == "eval"
    assert payload["target"] == "semantic"
    assert payload["engine"]["command"][1].endswith("scripts/semantic_eval.py")
    assert str(SEMANTIC_FIXTURE) in payload["engine"]["command"]
    assert payload["safety"] == {
        "mode": "offline-fixtures",
        "summary": "requires explicit fixture path(s) and never invokes model runtimes",
        "live": False,
        "long_running_default": False,
    }


def test_verify_invalid_input_feedback_lists_valid_values_syntax_and_examples() -> None:
    cases = [
        (
            ("verify", "bogus", "installed-skills"),
            "unsupported verify family 'bogus'",
            "valid families: smoke, eval",
            "Syntax: agentera verify <family> <target> [--format text|json] [target options]",
            "agentera verify smoke installed-skills; agentera verify eval skills --format json",
        ),
        (
            ("verify", "smoke", "nope"),
            "unsupported verify target 'nope' for family 'smoke'",
            "valid targets: installed-skills, live-hosts, setup-helpers, opencode-bootstrap",
            "Syntax: agentera verify smoke <target> [--format text|json] [target options]",
            "Example: agentera verify smoke installed-skills --format json",
        ),
        (
            ("verify", "eval", "skills", "--format", "xml"),
            "unsupported verify format 'xml'",
            "valid formats: text, json",
            "Syntax: agentera verify <family> <target> --format text|json [target options]",
            "Example: agentera verify smoke installed-skills --format json",
        ),
        (
            ("verify", "eval", "semantic", "--format", "json"),
            "semantic verify requires explicit fixture path(s)",
            "Valid targets for eval: skills, semantic",
            "Syntax: agentera verify eval semantic <fixture> [<fixture>...] [--format text|json]",
            "Example: agentera verify eval semantic fixtures/semantic/hej-bare-message.md --format json",
        ),
    ]

    for args, reason, valid_values, syntax, example in cases:
        result = _run_cli(*args)

        assert result.returncode == 2
        assert result.stdout == ""
        assert reason in result.stderr
        assert valid_values in result.stderr
        assert syntax in result.stderr
        assert example in result.stderr


def test_verify_safety_boundaries_reject_unconfirmed_live_and_runtime_conflicts() -> None:
    live = _run_cli("verify", "smoke", "live-hosts", "--live", "--format", "json")
    eval_conflict = _run_cli("verify", "eval", "skills", "--run", "--dry-run", "--format", "json")

    assert live.returncode == 2
    assert "unsafe live-host verify request requires explicit non-interactive consent" in live.stderr
    assert "Safe default: omit --live" in live.stderr
    assert "Valid opt-in flags: --live --yes" in live.stderr
    assert "Example: agentera verify smoke live-hosts --live --yes --format json" in live.stderr
    assert eval_conflict.returncode == 2
    assert "combines --run and --dry-run" in eval_conflict.stderr
    assert "Safe default: omit --run" in eval_conflict.stderr
    assert "Example: agentera verify eval skills --dry-run --format json" in eval_conflict.stderr


def test_verify_help_discovers_namespace_without_renaming_smoke_or_eval_vocabulary() -> None:
    root_help = _run_cli("--help")
    verify_help = _run_cli("verify", "--help")
    check_help = _run_cli("check", "verify", "--help")

    assert root_help.returncode == verify_help.returncode == check_help.returncode == 0
    assert "check" in root_help.stdout
    assert "agentera verify smoke installed-skills" in verify_help.stdout
    assert "agentera check verify smoke installed-skills" in check_help.stdout
    assert "agentera verify eval skills --format json" in verify_help.stdout
    assert "Gate family: smoke or eval" in verify_help.stdout
    assert "--live" in verify_help.stdout
    assert "--yes" in verify_help.stdout
    assert "--run" in verify_help.stdout
    assert "--dry-run" in verify_help.stdout


def test_verify_preserves_direct_smoke_and_eval_script_compatibility() -> None:
    direct_eval = _run_python_script("eval_skills.py", "--dry-run", "--runtime", "claude")
    direct_semantic = _run_python_script("semantic_eval.py", str(SEMANTIC_FIXTURE))
    direct_installed = _run_python_script("smoke_installed_skills.py")
    direct_live_hosts = _run_python_script("smoke_live_hosts.py")
    direct_setup = _run_python_script("smoke_setup_helpers.py")

    assert direct_eval.returncode == 0, direct_eval.stderr
    assert '\"mode\": \"dry-run\"' in direct_eval.stdout
    assert direct_semantic.returncode == 0, direct_semantic.stderr
    assert '\"status\": \"pass\"' in direct_semantic.stdout
    assert direct_installed.returncode == 0, direct_installed.stderr
    assert "PASS: installed skill package smoke checked" in direct_installed.stdout
    assert direct_live_hosts.returncode == 0, direct_live_hosts.stderr
    assert "PASS: all smoke checks passed" in direct_live_hosts.stdout
    assert direct_setup.returncode == 0, direct_setup.stderr
    assert "PASS: all smoke checks passed" in direct_setup.stdout


def test_opencode_bootstrap_direct_script_remains_bounded_when_available() -> None:
    if shutil.which("node") is None:
        pytest.skip("node is required for the direct OpenCode bootstrap smoke script")

    result = subprocess.run(
        ["node", str(SCRIPTS / "smoke_opencode_bootstrap.mjs")],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    output = result.stdout + result.stderr
    assert result.returncode in {0, 1}
    assert len(output.splitlines()) <= 20
    assert "OpenCode skills not found" in output or "PASS:" in output
