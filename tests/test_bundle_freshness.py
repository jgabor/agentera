"""Regression tests for self-healing Agentera doctor guidance."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
CLI = REPO_ROOT / "scripts" / "agentera"


def _run(
    *args: str,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    effective_env = dict(os.environ)
    effective_env["AGENTERA_HOME"] = str(REPO_ROOT)
    effective_env["AGENTERA_BOOTSTRAP_SOURCE_ROOT"] = str(REPO_ROOT)
    effective_env.setdefault("SHELL", "/bin/bash")
    if env:
        effective_env.update(env)
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=cwd or REPO_ROOT,
        env=effective_env,
        text=True,
        capture_output=True,
        check=False,
    )


def _write_stale_bundle(root: Path, *, body: str | None = None, version: str = "2.0.3") -> None:
    scripts = root / "scripts"
    scripts.mkdir(parents=True)
    script = scripts / "agentera"
    script.write_text(
        body
        or (
            "#!/usr/bin/env python3\n"
            "import argparse\n"
            "parser = argparse.ArgumentParser(prog='agentera')\n"
            "sub = parser.add_subparsers(dest='command')\n"
            "sub.add_parser('prime')\n"
            "sub.add_parser('query')\n"
            "sub.add_parser('upgrade')\n"
            "parser.parse_args()\n"
        ),
        encoding="utf-8",
    )
    script.chmod(0o755)
    (root / "skills" / "agentera").mkdir(parents=True)
    (root / "skills" / "agentera" / "SKILL.md").write_text(
        "---\nname: agentera\nversion: \"2.0.3\"\n---\n",
        encoding="utf-8",
    )
    (root / "registry.json").write_text(
        json.dumps({"skills": [{"name": "agentera", "version": version}]}),
        encoding="utf-8",
    )
    (root / ".agentera-bundle.json").write_text(
        json.dumps({"schemaVersion": "agentera.bundle.v1", "version": version}),
        encoding="utf-8",
    )


def test_doctor_reports_legacy_bundle_root_migration_required_with_exact_commands(tmp_path: Path) -> None:
    install_root = tmp_path / "home" / ".agents" / "agentera"
    _write_stale_bundle(install_root)

    result = _run("doctor", "--install-root", str(install_root), "--json")

    assert result.returncode == 1, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "migration_required"
    assert payload["appHome"] == str(install_root)
    assert "installRoot" not in payload
    assert payload["managedAppRoot"] == str(install_root / "app")
    assert payload["userDataRoot"] == str(install_root)
    assert payload["activeBundleRoot"] == str(install_root)
    assert payload["authoritativeRoot"] == str(install_root / "app")
    assert payload["skillRoot"] == str(install_root / "skills" / "agentera")
    assert payload["runtimeRoot"]
    kinds = {signal["kind"] for signal in payload["signals"]}
    assert "migration_required" in kinds
    assert "version_mismatch" in kinds
    assert "missing_command" in kinds
    assert any("hej" in signal.get("missingCommands", []) for signal in payload["signals"])
    assert payload["dryRunCommand"] == (
        "uvx --from git+https://github.com/jgabor/agentera agentera upgrade "
        f"--only bundle --install-root {install_root} --dry-run"
    )
    assert payload["applyCommand"] == (
        "uvx --from git+https://github.com/jgabor/agentera agentera upgrade "
        f"--only bundle --install-root {install_root} --yes"
    )
    assert payload["approval"] == f"approve app refresh for {install_root}"
    assert payload["retryCommand"].endswith(f"{install_root}/scripts/agentera hej")


def test_doctor_reports_coherent_app_and_runtime_roots_without_migration_warning(tmp_path: Path) -> None:
    app_home = tmp_path / "home" / ".agents" / "agentera"
    managed_app = app_home / "app"
    _write_stale_bundle(
        managed_app,
        body=(
            "#!/usr/bin/env python3\n"
            "import argparse\n"
            "parser = argparse.ArgumentParser(prog='agentera')\n"
            "sub = parser.add_subparsers(dest='command')\n"
            "sub.add_parser('hej')\n"
            "parser.parse_args()\n"
        ),
        version="2.3.0",
    )

    result = _run("doctor", "--install-root", str(app_home), "--expected-version", "2.3.0", "--json")

    assert result.returncode == 0, result.stdout
    payload = json.loads(result.stdout)
    assert payload["status"] == "fresh"
    assert payload["appHome"] == str(app_home)
    assert payload["managedAppRoot"] == str(managed_app)
    assert payload["activeBundleRoot"] == str(managed_app)
    assert payload["authoritativeRoot"] == str(managed_app)
    assert payload["skillRoot"] == str(managed_app / "skills" / "agentera")
    assert payload["runtimeRoot"]
    kinds = {signal["kind"] for signal in payload["signals"]}
    assert "migration_required" not in kinds
    assert "split_root" not in kinds


def test_doctor_blocks_unmanaged_or_invalid_agentera_home(tmp_path: Path) -> None:
    unmanaged = tmp_path / "not-agentera"
    unmanaged.mkdir()
    (unmanaged / "README.txt").write_text("user-owned directory\n", encoding="utf-8")

    result = _run(
        "doctor",
        "--json",
        "--home",
        str(tmp_path / "home"),
        env={"AGENTERA_HOME": str(unmanaged)},
    )

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["appHomeSource"] == "AGENTERA_HOME"
    assert "installRootSource" not in payload
    assert payload["dryRunCommand"] is None
    assert payload["applyCommand"] is None
    assert payload["signals"][0]["kind"] == "unmanaged_install_root"

    missing = tmp_path / "missing-agentera"
    result = _run(
        "doctor",
        "--json",
        "--home",
        str(tmp_path / "home"),
        env={"AGENTERA_HOME": str(missing)},
    )

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["signals"][0]["kind"] == "invalid_install_root"
    assert not missing.exists()

    invalid = tmp_path / "partial-agentera"
    (invalid / "skills" / "agentera").mkdir(parents=True)
    (invalid / "skills" / "agentera" / "SKILL.md").write_text("---\nname: agentera\n---\n", encoding="utf-8")
    before = sorted(path.relative_to(invalid) for path in invalid.rglob("*"))
    result = _run(
        "doctor",
        "--json",
        "--home",
        str(tmp_path / "home"),
        env={"AGENTERA_HOME": str(invalid)},
    )

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["rootStatus"] == "invalid"
    assert payload["signals"][0]["kind"] == "invalid_bundle"
    assert payload["dryRunCommand"] is None
    assert payload["applyCommand"] is None
    assert sorted(path.relative_to(invalid) for path in invalid.rglob("*")) == before


def test_doctor_targets_default_root_when_agentera_home_is_unset(tmp_path: Path) -> None:
    home = tmp_path / "home"
    env = {"AGENTERA_HOME": "", "XDG_DATA_HOME": str(home / ".local" / "share")}

    result = _run("doctor", "--json", "--home", str(home), env=env)

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    expected_root = home / ".local" / "share" / "agentera"
    assert payload["status"] == "stale"
    assert payload["appHome"] == str(expected_root)
    assert payload["appHomeSource"] == "default app home"
    assert "installRoot" not in payload
    assert "installRootSource" not in payload
    assert payload["signals"][0]["kind"] == "missing_bundle"
    assert f"--install-root {expected_root}" in payload["dryRunCommand"]
    assert not expected_root.exists()


def test_stale_bundle_refresh_dry_run_then_apply_preserves_install_root(tmp_path: Path) -> None:
    install_root = tmp_path / "home" / ".agents" / "agentera"
    _write_stale_bundle(install_root)
    stale_text = (install_root / "scripts" / "agentera").read_text(encoding="utf-8")
    before_preview = sorted(path.relative_to(install_root) for path in install_root.rglob("*"))

    preview = _run(
        "upgrade",
        "--only",
        "bundle",
        "--install-root",
        str(install_root),
        "--dry-run",
        "--json",
    )

    assert preview.returncode == 1, preview.stderr
    preview_payload = json.loads(preview.stdout)
    assert preview_payload["appHome"] == str(install_root)
    assert "installRoot" not in preview_payload
    assert preview_payload["phases"][0]["status"] == "pending"
    items = {item["action"]: item for item in preview_payload["phases"][0]["items"]}
    assert items["install-bundle"]["target"] == str(install_root / "app")
    assert items["migrate-app-home"]["appHome"] == str(install_root)
    assert items["migrate-app-home"]["managedAppRoot"] == str(install_root / "app")
    assert (install_root / "scripts" / "agentera").read_text(encoding="utf-8") == stale_text
    assert not (install_root / "app").exists()
    assert sorted(path.relative_to(install_root) for path in install_root.rglob("*")) == before_preview

    apply = _run(
        "upgrade",
        "--only",
        "bundle",
        "--install-root",
        str(install_root),
        "--yes",
        "--json",
    )

    assert apply.returncode == 0, apply.stderr
    apply_payload = json.loads(apply.stdout)
    assert apply_payload["appHome"] == str(install_root)
    assert "installRoot" not in apply_payload
    assert apply_payload["status"] == "applied"
    assert (install_root / "app" / "scripts" / "agentera").is_file()
    assert (install_root / "app" / "skills" / "agentera" / "SKILL.md").is_file()
    assert not (install_root / "scripts" / "agentera").exists()
    assert not (install_root / "skills" / "agentera" / "SKILL.md").exists()

    second_apply = _run(
        "upgrade",
        "--only",
        "bundle",
        "--install-root",
        str(install_root),
        "--yes",
        "--json",
    )

    assert second_apply.returncode == 0, second_apply.stderr
    second_payload = json.loads(second_apply.stdout)
    assert second_payload["status"] == "noop"
    assert len(list(install_root.glob("app/app"))) == 0

    status = _run("doctor", "--install-root", str(install_root), "--json")
    assert status.returncode == 0, status.stdout
    status_payload = json.loads(status.stdout)
    assert status_payload["status"] == "fresh"
    assert status_payload["activeBundleRoot"] == str(install_root / "app")
    assert "migration_required" not in {signal["kind"] for signal in status_payload["signals"]}

    retry = subprocess.run(
        ["uv", "run", str(install_root / "app" / "scripts" / "agentera"), "hej"],
        cwd=REPO_ROOT,
        env={**os.environ, "AGENTERA_HOME": str(install_root)},
        text=True,
        capture_output=True,
        check=False,
    )
    assert retry.returncode == 0, retry.stderr
    assert "source_contract:" in retry.stdout
    assert "render=caller-owned README-style hej dashboard" in retry.stdout


def test_bundle_upgrade_missing_root_dry_run_writes_nothing(tmp_path: Path) -> None:
    install_root = tmp_path / "home" / ".agents" / "agentera"

    preview = _run(
        "upgrade",
        "--only",
        "bundle",
        "--install-root",
        str(install_root),
        "--dry-run",
        "--json",
    )

    assert preview.returncode == 1, preview.stderr
    payload = json.loads(preview.stdout)
    assert payload["appHome"] == str(install_root)
    assert "installRoot" not in payload
    assert payload["status"] == "pending"
    assert payload["phases"][0]["status"] == "pending"
    assert not install_root.exists()


def test_doctor_reports_pre_argparse_cli_failures_as_status_signals(tmp_path: Path) -> None:
    install_root = tmp_path / "home" / ".agents" / "agentera"
    _write_stale_bundle(
        install_root,
        body="#!/usr/bin/env python3\nraise RuntimeError('wrong support module')\n",
        version="2.1.1",
    )

    result = _run("doctor", "--install-root", str(install_root), "--json")

    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["status"] == "migration_required"
    signal = next(signal for signal in payload["signals"] if signal["kind"] == "cli_probe_failed")
    assert signal["kind"] == "cli_probe_failed"
    assert signal["returnCode"] != 0
    assert "wrong support module" in "\n".join(signal["stderrTail"])


def test_bundle_status_is_not_exposed_as_a_compatibility_alias() -> None:
    help_result = _run("--help")
    assert help_result.returncode == 0
    assert "doctor" in help_result.stdout
    assert "bundle-status" not in help_result.stdout

    result = _run("bundle-status", "--json")

    assert result.returncode == 2
    assert "invalid choice" in result.stderr
    assert "bundle-status" in result.stderr
