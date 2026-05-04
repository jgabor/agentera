"""Tests for scripts/setup_copilot.py.

Proportionality budget (per PLAN.md Task 2 AC10 + SPEC Section 17):
at most 12 cases, expanded along the four shell-detection branches
(bash, zsh, fish, unsupported) and the three rc-state branches
(no marker, marker at desired value, marker at different value, plus
the bare-export edge case the helper must notice).

Branch coverage map:

| Branch                                       | Covered by                          |
| -------------------------------------------- | ----------------------------------- |
| Shell 1: bash → ~/.bashrc, export syntax     | test_shell_bash_creates_bashrc      |
| Shell 2: zsh → ~/.zshrc, export syntax       | test_shell_zsh_creates_zshrc        |
| Shell 3: fish → fish/config.fish, set -x     | test_shell_fish_creates_config_fish |
| Shell 4: unsupported → exit 2 + guidance     | test_shell_unsupported_exits_with_help |
| RC state: marker at desired value (no-op)    | test_rc_marker_at_desired_value_noop |
| RC state: marker at different value (update) | test_rc_marker_at_different_value_updated |
| RC state: bare export without marker         | test_rc_bare_export_left_untouched  |

Plus four behavioral gates (11 cases total, under 12-case budget):

- --rc-file overrides $SHELL detection (AC8)  test_rc_file_override_infers_syntax
- --dry-run on pending change (AC9)           test_dry_run_pending_exits_1
- --dry-run on no-op (AC9)                    test_dry_run_noop_exits_0
- --install-root validation (shared with T1)  test_install_root_invalid_rejected
"""

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
    """Repo root: it is a verifiable agentera install (passes the lint)."""
    return REPO_ROOT


@pytest.fixture
def fake_home(tmp_path: Path, monkeypatch) -> Path:
    """Redirect Path.home() to an isolated tmp directory.

    The shell-detection tests rely on the helper resolving rc paths
    relative to $HOME; pytest's tmp_path fixture combined with monkey-
    patching HOME guarantees no test ever touches the real ~/.bashrc.
    """
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def _run(setup_copilot: ModuleType, *args: str) -> int:
    """Invoke main() with argv and return the exit code."""
    return setup_copilot.main(list(args))


# ---------------------------------------------------------------------------
# Shell-detection branches (4)
# ---------------------------------------------------------------------------


def test_shell_bash_creates_bashrc(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC1: $SHELL=/bin/bash with no ~/.bashrc → helper creates the marker block."""
    monkeypatch.setenv("SHELL", "/bin/bash")
    target = fake_home / ".bashrc"
    assert not target.exists()

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()
    assert rc == 0, out
    assert target.exists()

    text = target.read_text(encoding="utf-8")
    assert "# agentera: AGENTERA_HOME (managed)" in text
    assert f'export AGENTERA_HOME="{install_root}"' in text


def test_shell_zsh_creates_zshrc(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC2: $SHELL ending in zsh → writes the same block to ~/.zshrc."""
    monkeypatch.setenv("SHELL", "/usr/bin/zsh")
    target = fake_home / ".zshrc"
    assert not target.exists()

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()
    assert rc == 0, out
    assert target.exists()

    text = target.read_text(encoding="utf-8")
    assert "# agentera: AGENTERA_HOME (managed)" in text
    assert f'export AGENTERA_HOME="{install_root}"' in text
    # Bash rc untouched.
    assert not (fake_home / ".bashrc").exists()


def test_shell_fish_creates_config_fish(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC3: $SHELL ending in fish → writes set -x syntax to fish config."""
    monkeypatch.setenv("SHELL", "/usr/bin/fish")
    target = fake_home / ".config" / "fish" / "config.fish"
    assert not target.exists()

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()
    assert rc == 0, out
    assert target.exists()

    text = target.read_text(encoding="utf-8")
    assert "# agentera: AGENTERA_HOME (managed)" in text
    # fish syntax: ``set -x NAME value`` not ``export NAME=value``.
    assert f'set -x AGENTERA_HOME "{install_root}"' in text
    assert "export AGENTERA_HOME" not in text


def test_shell_unsupported_exits_with_help(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC4: unsupported $SHELL → exit non-zero, prints shell name + bash one-liner."""
    monkeypatch.setenv("SHELL", "/bin/csh")

    rc = _run(setup_copilot, "--install-root", str(install_root))
    err = capsys.readouterr().err
    assert rc == 2
    # Detected shell name surfaced for diagnosis.
    assert "csh" in err
    # Bash one-liner the user can adapt.
    assert "echo" in err
    assert "AGENTERA_HOME" in err
    # Suggest the --rc-file escape hatch.
    assert "--rc-file" in err


# ---------------------------------------------------------------------------
# RC-state branches (3)
# ---------------------------------------------------------------------------


def test_rc_marker_at_desired_value_noop(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC5: marker block already at desired value → exit 0, byte-identical."""
    monkeypatch.setenv("SHELL", "/bin/bash")
    target = fake_home / ".bashrc"
    pre_existing = (
        '# my own setup\n'
        'alias ll="ls -la"\n'
        '\n'
        '# agentera: AGENTERA_HOME (managed)\n'
        f'export AGENTERA_HOME="{install_root}"\n'
    )
    target.write_text(pre_existing, encoding="utf-8")
    before_bytes = target.read_bytes()

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()
    assert rc == 0, out
    assert "nothing to do" in out.out

    after_bytes = target.read_bytes()
    assert before_bytes == after_bytes


def test_rc_marker_at_different_value_updated(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC6: marker at different value → line after marker rewritten in place; siblings byte-identical."""
    monkeypatch.setenv("SHELL", "/bin/bash")
    target = fake_home / ".bashrc"
    pre_existing = (
        '# user line A\n'
        'alias ll="ls -la"\n'
        '\n'
        '# agentera: AGENTERA_HOME (managed)\n'
        'export AGENTERA_HOME="/old/stale/path"\n'
        '\n'
        '# user line B\n'
        'export PATH="$HOME/bin:$PATH"\n'
    )
    target.write_text(pre_existing, encoding="utf-8")

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()
    assert rc == 0, out

    text = target.read_text(encoding="utf-8")
    # The managed line was rewritten to the new install root.
    assert f'export AGENTERA_HOME="{install_root}"' in text
    assert "/old/stale/path" not in text
    # Every other user-owned line preserved verbatim.
    assert '# user line A\n' in text
    assert 'alias ll="ls -la"\n' in text
    assert '# user line B\n' in text
    assert 'export PATH="$HOME/bin:$PATH"\n' in text
    # Marker comment itself preserved (not duplicated).
    assert text.count("# agentera: AGENTERA_HOME (managed)") == 1


def test_rc_bare_export_left_untouched(
    setup_copilot: ModuleType, fake_home: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC7: bare export without marker → managed block appended; bare line untouched; notice printed."""
    monkeypatch.setenv("SHELL", "/bin/bash")
    target = fake_home / ".bashrc"
    bare_line = 'export AGENTERA_HOME="/user/wrote/this/by/hand"\n'
    pre_existing = '# user setup\n' + bare_line

    target.write_text(pre_existing, encoding="utf-8")

    rc = _run(setup_copilot, "--install-root", str(install_root))
    out = capsys.readouterr()
    assert rc == 0, out

    text = target.read_text(encoding="utf-8")
    # The user's bare line is preserved verbatim — we never edited it.
    assert bare_line in text
    # Our managed block was appended below.
    assert "# agentera: AGENTERA_HOME (managed)" in text
    assert f'export AGENTERA_HOME="{install_root}"' in text
    # Notice telling the user we left their hand-written line alone.
    assert "left untouched" in out.out


# ---------------------------------------------------------------------------
# Behavioral gates (4)
# ---------------------------------------------------------------------------


def test_rc_file_override_infers_syntax(
    setup_copilot: ModuleType, tmp_path: Path, install_root: Path,
    monkeypatch, capsys,
):
    """AC8: --rc-file PATH bypasses $SHELL; .fish path → fish syntax, otherwise export."""
    # Even with $SHELL=/bin/bash, --rc-file pointing at a .fish path
    # should produce fish syntax. Inverse: a generic path with bash $SHELL
    # produces export. We assert both halves of the inference rule.
    monkeypatch.setenv("SHELL", "/bin/bash")

    fish_target = tmp_path / "custom.fish"
    rc_fish = _run(
        setup_copilot,
        "--install-root", str(install_root),
        "--rc-file", str(fish_target),
    )
    assert rc_fish == 0, capsys.readouterr()
    fish_text = fish_target.read_text(encoding="utf-8")
    assert f'set -x AGENTERA_HOME "{install_root}"' in fish_text

    # Same $SHELL=bash, but a .rc path → export syntax (the default).
    monkeypatch.setenv("SHELL", "/usr/bin/zsh")  # change shell; should be ignored
    plain_target = tmp_path / "custom.rc"
    rc_plain = _run(
        setup_copilot,
        "--install-root", str(install_root),
        "--rc-file", str(plain_target),
    )
    assert rc_plain == 0, capsys.readouterr()
    plain_text = plain_target.read_text(encoding="utf-8")
    assert f'export AGENTERA_HOME="{install_root}"' in plain_text


def test_dry_run_pending_exits_1(
    setup_copilot: ModuleType, tmp_path: Path, install_root: Path, capsys,
):
    """AC9: --dry-run with a pending change writes nothing and exits 1."""
    target = tmp_path / "fresh.rc"
    assert not target.exists()

    rc = _run(
        setup_copilot,
        "--install-root", str(install_root),
        "--rc-file", str(target),
        "--dry-run",
    )
    out = capsys.readouterr()
    assert rc == 1, out
    assert "would" in out.out.lower()
    # File never created.
    assert not target.exists()


def test_dry_run_noop_exits_0(
    setup_copilot: ModuleType, tmp_path: Path, install_root: Path, capsys,
):
    """AC9: --dry-run when no change is needed exits 0."""
    target = tmp_path / "stable.rc"
    pre_existing = (
        '# agentera: AGENTERA_HOME (managed)\n'
        f'export AGENTERA_HOME="{install_root}"\n'
    )
    target.write_text(pre_existing, encoding="utf-8")
    before_bytes = target.read_bytes()

    rc = _run(
        setup_copilot,
        "--install-root", str(install_root),
        "--rc-file", str(target),
        "--dry-run",
    )
    out = capsys.readouterr()
    assert rc == 0, out
    assert target.read_bytes() == before_bytes


def test_install_root_invalid_rejected(
    setup_copilot: ModuleType, tmp_path: Path, capsys,
):
    """--install-root path missing canonical entries exits non-zero with names (shared T1 contract)."""
    bogus_root = tmp_path / "not-an-install"
    bogus_root.mkdir()
    target = tmp_path / "rc"

    rc = _run(
        setup_copilot,
        "--install-root", str(bogus_root),
        "--rc-file", str(target),
    )
    err = capsys.readouterr().err
    assert rc == 2
    assert "scripts/validate_capability.py" in err
    assert "skills/agentera/SKILL.md" in err
    assert not target.exists()
