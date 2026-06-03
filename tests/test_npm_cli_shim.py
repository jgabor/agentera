"""Tests for the npm CLI shim in packages/cli (Node resolver + bin entry)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
CLI_ROOT = REPO_ROOT / "packages/cli"
BIN = CLI_ROOT / "bin" / "agentera.mjs"
NODE = shutil.which("node")


pytestmark = pytest.mark.skipif(NODE is None, reason="node is required for npm CLI shim tests")

_RESOLVE_SNIPPET = """
import { resolveBackend } from './lib/resolve.mjs';
const cwd = process.env.TEST_CWD ?? process.cwd();
const env = { ...process.env };
delete env.TEST_CWD;
console.log(JSON.stringify(resolveBackend({
  cwd,
  env,
  gitRef: process.env.TEST_GIT_REF ?? 'v2.7.7',
})));
"""


def _resolve_backend(
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    git_ref: str = "v2.7.7",
) -> dict:
    merged = {**os.environ, **(env or {}), "TEST_CWD": str(cwd), "TEST_GIT_REF": git_ref}
    proc = subprocess.run(
        [NODE, "--input-type=module", "-e", _RESOLVE_SNIPPET],
        cwd=CLI_ROOT,
        env=merged,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout.strip())


def _touch_script(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env true\n", encoding="utf-8")
    path.chmod(0o755)


@pytest.fixture
def isolated(tmp_path: Path):
    """Empty tree with no repo scripts/agentera."""
    return tmp_path


def test_find_repo_root_from_repository():
    backend = _resolve_backend(cwd=REPO_ROOT)
    if backend["kind"] == "repo":
        assert backend["repoRoot"] == str(REPO_ROOT)
    elif backend["kind"] == "app-home":
        pytest.skip("AGENTERA_HOME is set in environment")
    else:
        assert backend["kind"] in {"uvx", "none"}


def test_app_home_precedes_repo(tmp_path: Path, isolated: Path):
    home = isolated / "home"
    _touch_script(home / "app" / "scripts" / "agentera")
    backend = _resolve_backend(
        cwd=REPO_ROOT,
        env={"AGENTERA_HOME": str(home), "PATH": os.environ.get("PATH", "")},
    )
    assert backend["kind"] == "app-home"
    assert backend["scriptPath"] == str(home / "app" / "scripts" / "agentera")


def test_repo_when_no_app_home(isolated: Path):
    checkout = isolated / "checkout"
    _touch_script(checkout / "scripts" / "agentera")
    path_entries = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]
    if not any(Path(p, "uv").exists() for p in path_entries):
        fake_bin = isolated / "bin"
        fake_bin.mkdir()
        (fake_bin / "uv").write_text("#!/bin/sh\ntrue\n", encoding="utf-8")
        (fake_bin / "uv").chmod(0o755)
        path_env = f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}"
    else:
        path_env = os.environ.get("PATH", "")
    backend = _resolve_backend(
        cwd=checkout,
        env={"PATH": path_env},
    )
    assert backend["kind"] == "repo"
    assert backend["repoRoot"] == str(checkout.resolve())


def test_uvx_when_uv_present_without_repo(isolated: Path):
    fake_bin = isolated / "bin"
    fake_bin.mkdir()
    (fake_bin / "uv").write_text("#!/bin/sh\ntrue\n", encoding="utf-8")
    (fake_bin / "uv").chmod(0o755)
    backend = _resolve_backend(
        cwd=isolated,
        env={"PATH": str(fake_bin)},
    )
    assert backend["kind"] == "uvx"
    assert backend["gitRef"] == "v2.7.7"


def test_none_when_no_uv_and_no_scripts(isolated: Path):
    backend = _resolve_backend(cwd=isolated, env={"PATH": ""})
    assert backend["kind"] == "none"
    assert "uv" in (backend.get("reason") or "").lower()


def test_bin_version_smoke():
    proc = subprocess.run(
        [NODE, str(BIN), "--version"],
        cwd=CLI_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "agentera npm shim 0.0.0" in proc.stdout
    assert "suite 2.7.7" in proc.stdout


def test_bin_help_smoke():
    proc = subprocess.run(
        [NODE, str(BIN), "--help"],
        cwd=CLI_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert "Delegates to the Agentera Python CLI" in proc.stdout


def test_bin_install_help_without_backend(isolated: Path):
    env = {k: v for k, v in os.environ.items() if k != "AGENTERA_HOME"}
    env["PATH"] = ""
    proc = subprocess.run(
        [NODE, str(BIN), "prime"],
        cwd=isolated,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 1
    assert "npm CLI shim" in proc.stderr
    assert "npx skills add" in proc.stderr
