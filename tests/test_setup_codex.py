"""Tests for scripts/setup_codex.py.

Proportionality budget (per PLAN.md Task 1 AC8 + SPEC Section 17):
at most 12 cases, expanded along the six TOML structural branches
plus the install-root and dry-run gates the helper enforces.

Branch coverage map:

| Branch                                    | Covered by                          |
| ----------------------------------------- | ----------------------------------- |
| 1. absent file                            | test_branch1_fresh_write            |
| 2. section absent                         | test_branch2_section_absent_appends |
| 3. section without set                    | test_branch3_section_without_set    |
| 4. section + set at desired value         | test_branch4_noop_byte_identical    |
| 5. section + set with conflicts (no force)| test_branch5_conflict_refuses       |
| 6. section + set with conflicts (--force) | test_branch6_force_merges           |

Plus four behavioral gates (12 cases total):

- install-root verification (AC5)         test_install_root_invalid_rejected
- auto-detect failure (AC6)               test_auto_detect_failure_message
- dry-run on pending change (AC7)         test_dry_run_pending_exits_1
- dry-run on no-op (AC7)                  test_dry_run_noop_exits_0
- v2 --enable-agents compatibility no-op  test_enable_agents_is_v2_noop

(test_branch4 also asserts byte-identical re-run — AC2.)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "setup_codex.py"


@pytest.fixture(scope="module")
def setup_codex() -> ModuleType:
    """Load scripts/setup_codex.py as a module for direct function calls."""
    spec = importlib.util.spec_from_file_location("setup_codex", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["setup_codex"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def install_root() -> Path:
    """Repo root: it is a verifiable agentera install (passes the lint)."""
    return REPO_ROOT


def _run(setup_codex: ModuleType, *args: str) -> int:
    """Invoke main() with argv and return the exit code."""
    return setup_codex.main(list(args))


# ---------------------------------------------------------------------------
# TOML structural branches (6)
# ---------------------------------------------------------------------------


def test_branch1_fresh_write(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 1: absent file → fresh write with only [shell_environment_policy]."""
    target = tmp_path / "config.toml"
    assert not target.exists()

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
    )
    assert rc == 0, capsys.readouterr()
    assert target.exists()

    text = target.read_text(encoding="utf-8")
    # File contains only the managed section. We assert structural shape
    # (header + set line + AGENTERA_HOME at install_root) rather than
    # exact bytes so the emitter can evolve without breaking the test.
    assert "[shell_environment_policy]" in text
    assert "set = {" in text
    assert f'AGENTERA_HOME = "{install_root}"' in text
    # No other tables introduced.
    assert text.count("[") == 1


def test_branch2_section_absent_appends(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 2: file exists with other tables, no section → append, others byte-identical."""
    target = tmp_path / "config.toml"
    pre_existing = (
        '[unrelated]\n'
        'name = "keep me"\n'
        'count = 42\n'
    )
    target.write_text(pre_existing, encoding="utf-8")

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
    )
    assert rc == 0, capsys.readouterr()

    text = target.read_text(encoding="utf-8")
    # Pre-existing table preserved verbatim.
    assert pre_existing in text
    # New section appended with the managed key.
    assert "[shell_environment_policy]" in text
    assert f'AGENTERA_HOME = "{install_root}"' in text


def test_branch3_section_without_set(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 3: section exists without `set` → insert set line, other tables byte-identical."""
    target = tmp_path / "config.toml"
    pre_existing = (
        '[shell_environment_policy]\n'
        'inherit = "core"\n'
        '\n'
        '[other]\n'
        'value = 1\n'
    )
    target.write_text(pre_existing, encoding="utf-8")

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
    )
    assert rc == 0, capsys.readouterr()

    text = target.read_text(encoding="utf-8")
    # The `inherit` sibling key inside the section is preserved.
    assert 'inherit = "core"' in text
    # The `[other]` table is preserved byte-identically.
    assert "[other]\nvalue = 1\n" in text
    # The set line was inserted.
    assert f'set = {{ AGENTERA_HOME = "{install_root}" }}' in text
    # The set line sits immediately after the section header (no other
    # content slipped between them).
    section_idx = text.index("[shell_environment_policy]")
    set_idx = text.index("set = {", section_idx)
    between = text[section_idx:set_idx]
    # Only header line + its newline between header and set line.
    assert between.count("\n") == 1


def test_branch4_noop_byte_identical(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 4: AGENTERA_HOME already at desired value → exit 0, byte-identical (AC2)."""
    target = tmp_path / "config.toml"
    pre_existing = (
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
    )
    target.write_text(pre_existing, encoding="utf-8")
    before_bytes = target.read_bytes()

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
    )
    out = capsys.readouterr()
    assert rc == 0, out
    assert "already set" in out.out

    after_bytes = target.read_bytes()
    assert before_bytes == after_bytes


def test_branch5_conflict_refuses(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 5: sibling keys without AGENTERA_HOME → exit non-zero, no write."""
    target = tmp_path / "config.toml"
    pre_existing = (
        '[shell_environment_policy]\n'
        'set = { LANG = "en_US.UTF-8", PATH = "/usr/bin" }\n'
    )
    target.write_text(pre_existing, encoding="utf-8")
    before_bytes = target.read_bytes()

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
    )
    out = capsys.readouterr()
    assert rc == 2, out
    # Diff (or proposed merge) shown to stderr so user sees the change.
    assert "LANG" in out.err
    assert "AGENTERA_HOME" in out.err
    # File untouched.
    assert target.read_bytes() == before_bytes


def test_branch6_force_merges(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 6: --force merges AGENTERA_HOME alongside sibling keys; siblings preserved."""
    target = tmp_path / "config.toml"
    pre_existing = (
        '[shell_environment_policy]\n'
        'set = { LANG = "en_US.UTF-8", PATH = "/usr/bin" }\n'
    )
    target.write_text(pre_existing, encoding="utf-8")

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
        "--force",
    )
    out = capsys.readouterr()
    assert rc == 0, out

    text = target.read_text(encoding="utf-8")
    # Sibling keys preserved.
    assert 'LANG = "en_US.UTF-8"' in text
    assert 'PATH = "/usr/bin"' in text
    # Managed key merged in.
    assert f'AGENTERA_HOME = "{install_root}"' in text
    # Re-parse with tomllib to confirm structural validity.
    import tomllib

    parsed = tomllib.loads(text)
    set_table = parsed["shell_environment_policy"]["set"]
    assert set_table["AGENTERA_HOME"] == str(install_root)
    assert set_table["LANG"] == "en_US.UTF-8"
    assert set_table["PATH"] == "/usr/bin"


# ---------------------------------------------------------------------------
# Behavioral gates (4)
# ---------------------------------------------------------------------------


def test_install_root_invalid_rejected(
    setup_codex: ModuleType, tmp_path: Path, capsys
):
    """AC5: --install-root path missing canonical entries exits non-zero with names."""
    bogus_root = tmp_path / "not-an-install"
    bogus_root.mkdir()
    target = tmp_path / "config.toml"

    rc = _run(
        setup_codex,
        "--install-root",
        str(bogus_root),
        "--config-file",
        str(target),
    )
    err = capsys.readouterr().err
    assert rc == 2
    # The error message must enumerate at least one missing canonical
    # entry so the user sees what's wrong.
    assert "scripts/validate_capability.py" in err
    assert "skills/agentera/SKILL.md" in err
    # Nothing written.
    assert not target.exists()


def test_auto_detect_failure_message(
    setup_codex: ModuleType, tmp_path: Path, monkeypatch, capsys
):
    """AC6: auto-detect with no valid candidates and no env fallbacks exits with guidance."""
    # Strip env-var fallbacks so the helper cannot use them.
    monkeypatch.delenv("AGENTERA_HOME", raising=False)
    monkeypatch.delenv("CLAUDE_PLUGIN_ROOT", raising=False)
    # Stub auto-detection to None so the resolver hits the "no valid
    # root" branch deterministically (the real walk-up would otherwise
    # find the live agentera repo because the script lives under it).
    monkeypatch.setattr(setup_codex, "auto_detect_install_root", lambda: None)

    target = tmp_path / "config.toml"
    rc = _run(setup_codex, "--config-file", str(target))
    err = capsys.readouterr().err
    assert rc == 2
    assert "--install-root" in err
    assert not target.exists()


def test_dry_run_pending_exits_1(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """AC7: --dry-run with a pending change writes nothing and exits 1."""
    target = tmp_path / "config.toml"
    assert not target.exists()

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
        "--dry-run",
    )
    out = capsys.readouterr()
    assert rc == 1, out
    # Diff (or "would write" message) printed to stdout.
    assert "would" in out.out.lower()
    # File never created.
    assert not target.exists()


def test_dry_run_noop_exits_0(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """AC7: --dry-run when no change is needed exits 0."""
    target = tmp_path / "config.toml"
    pre_existing = (
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
    )
    target.write_text(pre_existing, encoding="utf-8")
    before_bytes = target.read_bytes()

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
        "--dry-run",
    )
    out = capsys.readouterr()
    assert rc == 0, out
    # File untouched.
    assert target.read_bytes() == before_bytes


def test_enable_agents_is_v2_noop(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Agentera v2 exposes one bundled skill; --enable-agents must not write v1 paths."""
    target = tmp_path / "config.toml"

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
        "--enable-agents",
    )
    out = capsys.readouterr()
    assert rc == 0, out
    assert "--enable-agents is deprecated in Agentera v2" in out.err

    text = target.read_text(encoding="utf-8")
    assert f'AGENTERA_HOME = "{install_root}"' in text
    assert "[agents." not in text
    assert "skills/hej" not in text
