"""Tests for diagnostic-only scripts/setup_copilot.py."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "setup_copilot.py"


@pytest.fixture(scope="module")
def setup_copilot() -> ModuleType:
    """Load scripts/setup_copilot.py as a module for direct function calls."""
    spec = importlib.util.spec_from_file_location("setup_copilot", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["setup_copilot"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def install_root() -> Path:
    return REPO_ROOT


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def _run(setup_copilot: ModuleType, *args: str) -> int:
    return setup_copilot.main(list(args))


@pytest.mark.parametrize(
    ("shell", "relative_target"),
    [
        ("/bin/bash", ".bashrc"),
        ("/usr/bin/zsh", ".zshrc"),
        ("/usr/local/bin/fish", ".config/fish/config.fish"),
    ],
)
def test_supported_shell_targets_are_diagnostic_only(
    setup_copilot: ModuleType,
    fake_home: Path,
    install_root: Path,
    monkeypatch,
    capsys,
    shell: str,
    relative_target: str,
) -> None:
    monkeypatch.setenv("SHELL", shell)
    target = fake_home / relative_target

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()

    assert rc == 0, out
    assert not target.exists()
    assert "Agentera will not edit shell startup files" in out.out
    assert "AGENTERA_HOME" in out.out


def test_existing_legacy_marker_block_is_left_byte_identical(
    setup_copilot: ModuleType,
    fake_home: Path,
    install_root: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("SHELL", "/bin/bash")
    target = fake_home / ".bashrc"
    pre_existing = (
        "# user setup\n"
        "# agentera: AGENTERA_HOME (managed)\n"
        "export AGENTERA_HOME=\"/old/stale/path\"\n"
        "alias ll=\"ls -la\"\n"
    )
    target.write_text(pre_existing, encoding="utf-8")
    before = target.read_bytes()

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()

    assert rc == 0, out
    assert target.read_bytes() == before
    assert "Legacy Agentera shell startup line detected" in out.out
    assert "cleanup is a user-owned manual boundary" in out.out


def test_existing_bare_agentera_line_is_left_byte_identical(
    setup_copilot: ModuleType,
    tmp_path: Path,
    install_root: Path,
    capsys,
) -> None:
    target = tmp_path / "custom.rc"
    pre_existing = "export AGENTERA_HOME=\"/user/wrote/this\"\n"
    target.write_text(pre_existing, encoding="utf-8")
    before = target.read_bytes()

    rc = _run(
        setup_copilot,
        "--install-root",
        str(install_root),
        "--rc-file",
        str(target),
        "--dry-run",
    )
    out = capsys.readouterr()

    assert rc == 0, out
    assert target.read_bytes() == before
    assert "Legacy Agentera shell startup line detected" not in out.out
    assert "No Agentera shell startup line was detected" in out.out


def test_rc_file_override_is_inspection_only(
    setup_copilot: ModuleType,
    tmp_path: Path,
    install_root: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("SHELL", "/bin/bash")
    target = tmp_path / "custom.fish"

    rc = _run(setup_copilot, "--install-root", str(install_root), "--rc-file", str(target))
    out = capsys.readouterr()

    assert rc == 0, out
    assert not target.exists()
    assert f"target: {target}" in out.out
    assert "syntax=fish" in out.out


def test_unsupported_shell_prints_per_invocation_guidance(
    setup_copilot: ModuleType,
    fake_home: Path,
    install_root: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setenv("SHELL", "/bin/csh")

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()

    assert rc == 0, out
    assert not (fake_home / ".bashrc").exists()
    assert "csh" in out.err
    assert "Agentera will not edit shell startup files" in out.err
    assert "AGENTERA_HOME=<agentera-directory> copilot" in out.err


def test_install_root_invalid_rejected(
    setup_copilot: ModuleType,
    tmp_path: Path,
    capsys,
) -> None:
    bogus_root = tmp_path / "not-an-install"
    bogus_root.mkdir()
    target = tmp_path / "rc"

    rc = _run(
        setup_copilot,
        "--install-root",
        str(bogus_root),
        "--rc-file",
        str(target),
    )
    err = capsys.readouterr().err
    assert rc == 2
    assert "scripts/validate_capability.py" in err
    assert "skills/agentera/SKILL.md" in err
    assert not target.exists()
