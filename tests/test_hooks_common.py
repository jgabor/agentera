"""Tests for hooks.common session and compaction policy helpers."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOKS_DIR = REPO_ROOT / "hooks"

if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))


@pytest.fixture(scope="module")
def common():
    spec = importlib.util.spec_from_file_location("hooks_common", HOOKS_DIR / "common.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def session_stop():
    spec = importlib.util.spec_from_file_location("session_stop", HOOKS_DIR / "session_stop.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_resolve_session_path_matches_between_session_hooks(common, session_stop, tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTERA_HOME", str(tmp_path / "agentera-home"))
    spec = importlib.util.spec_from_file_location("session_start", HOOKS_DIR / "session_start.py")
    session_start = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(session_start)

    expected = common.resolve_session_path(tmp_path)
    assert session_start.resolve_session_path(tmp_path) == expected
    assert session_stop.resolve_session_path(tmp_path) == expected


def test_compact_session_bookmark_entries_matches_session_stop_alias(common, session_stop):
    entries = [
        {"timestamp": f"2026-04-{i:02d} 10:00", "artifacts": ["PLAN.md"], "summary": f"Entry {i}", "kind": "full"}
        for i in range(1, 13)
    ]
    assert common.compact_session_bookmark_entries(entries) == session_stop.compact_entries(entries)


def test_post_merge_check_bare_resets_poisoned_config(tmp_path, monkeypatch):
    import os
    import subprocess

    script = HOOKS_DIR / "post-merge-check-bare.sh"
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.chdir(repo)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "/dev/null")
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", "/dev/null")
    git_env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}

    subprocess.run(
        ["git", "init", "-b", "main"],
        check=True,
        capture_output=True,
        env=git_env,
    )
    subprocess.run(["git", "config", "user.email", "t@t.com"], check=True)
    subprocess.run(["git", "config", "user.name", "T"], check=True)
    subprocess.run(["git", "config", "core.bare", "true"], check=True)
    subprocess.run(["bash", str(script)], check=True)
    bare = subprocess.run(
        ["git", "config", "--bool", "core.bare"],
        check=True,
        capture_output=True,
        text=True,
    )
    assert bare.stdout.strip() == "false"


def test_apply_retention_caps_enforces_total_limit(common):
    full = [{"kind": "full", "n": i} for i in range(15)]
    archive = [{"kind": "oneline", "n": i} for i in range(50)]
    result = common.apply_retention_caps(full, archive)
    assert len(result) == common.MAX_TOTAL_ENTRIES
    assert sum(1 for entry in result if entry["kind"] == "full") == common.MAX_FULL_ENTRIES
