"""Tests for hooks/cursor_session_start.py install-root resolution."""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_cursor_session_start() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "cursor_session_start",
        REPO_ROOT / "hooks" / "cursor_session_start.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_setup_root(root: Path) -> None:
    for entry in ("scripts/validate_capability.py", "hooks", "skills", "skills/agentera/SKILL.md"):
        target = root / entry
        if "." in target.name:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture\n", encoding="utf-8")
        else:
            target.mkdir(parents=True, exist_ok=True)
    helper = root / "hooks" / "validate_artifact.py"
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_text("fixture\n", encoding="utf-8")


@pytest.fixture(scope="module")
def cursor_session_start():
    return _load_cursor_session_start()


class TestResolveInstallRoot:
    def test_prefers_agentera_home_env(self, cursor_session_start, tmp_path, monkeypatch):
        managed = tmp_path / "managed"
        _write_setup_root(managed)
        monkeypatch.delenv("AGENTERA_HOME", raising=False)
        monkeypatch.setenv("AGENTERA_HOME", str(managed))

        resolved = cursor_session_start._resolve_install_root(tmp_path / "project")

        assert resolved == managed.resolve()

    def test_walks_up_from_project_cwd(self, cursor_session_start, tmp_path, monkeypatch):
        managed = tmp_path / "checkout"
        _write_setup_root(managed)
        project = managed / "apps" / "demo"
        project.mkdir(parents=True)
        monkeypatch.delenv("AGENTERA_HOME", raising=False)

        resolved = cursor_session_start._resolve_install_root(project)

        assert resolved == managed.resolve()

    def test_falls_back_to_plugin_root_when_env_and_walk_miss(
        self,
        cursor_session_start,
        tmp_path,
        monkeypatch,
    ):
        unrelated = tmp_path / "unrelated-project"
        unrelated.mkdir()
        monkeypatch.delenv("AGENTERA_HOME", raising=False)

        resolved = cursor_session_start._resolve_install_root(unrelated)

        assert resolved == cursor_session_start.PLUGIN_ROOT.resolve()

    def test_invalid_agentera_home_does_not_block_plugin_fallback(
        self,
        cursor_session_start,
        tmp_path,
        monkeypatch,
    ):
        unrelated = tmp_path / "unrelated-project"
        unrelated.mkdir()
        monkeypatch.setenv("AGENTERA_HOME", str(tmp_path / "missing"))

        resolved = cursor_session_start._resolve_install_root(unrelated)

        assert resolved == cursor_session_start.PLUGIN_ROOT.resolve()


class TestMain:
    def test_exports_agentera_home_via_plugin_fallback(
        self,
        cursor_session_start,
        tmp_path,
        monkeypatch,
    ):
        unrelated = tmp_path / "workspace"
        unrelated.mkdir()
        monkeypatch.delenv("AGENTERA_HOME", raising=False)
        monkeypatch.setattr(
            "sys.stdin",
            io.StringIO(json.dumps({"cwd": str(unrelated)})),
        )

        captured = io.StringIO()
        monkeypatch.setattr("sys.stdout", captured)

        assert cursor_session_start.main() == 0

        payload = json.loads(captured.getvalue())
        assert payload["env"]["AGENTERA_HOME"] == str(cursor_session_start.PLUGIN_ROOT.resolve())

    def test_exports_agentera_home_from_walk_up_checkout(
        self,
        cursor_session_start,
        tmp_path,
        monkeypatch,
    ):
        managed = tmp_path / "checkout"
        _write_setup_root(managed)
        project = managed / "service"
        project.mkdir()
        monkeypatch.delenv("AGENTERA_HOME", raising=False)
        monkeypatch.setattr(
            "sys.stdin",
            io.StringIO(json.dumps({"cwd": str(project)})),
        )

        captured = io.StringIO()
        monkeypatch.setattr("sys.stdout", captured)

        assert cursor_session_start.main() == 0

        payload = json.loads(captured.getvalue())
        assert payload["env"]["AGENTERA_HOME"] == str(managed.resolve())
