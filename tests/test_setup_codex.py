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
import json
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


def _codex_config(tmp_path: Path) -> Path:
    path = tmp_path / ".codex" / "config.toml"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _write_current_descriptors(setup_codex: ModuleType, install_root: Path, agents_dir: Path) -> None:
    changes = setup_codex.plan_agent_descriptor_changes(install_root, agents_dir, force=False)
    setup_codex.write_agent_descriptor_changes(changes)


# ---------------------------------------------------------------------------
# TOML structural branches (6)
# ---------------------------------------------------------------------------


def test_branch1_fresh_write(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 1: absent file → fresh write with shell env, agent limits, descriptors."""
    target = _codex_config(tmp_path)
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
    # File contains only the managed sections. We assert structural shape
    # (header + set line + AGENTERA_HOME at install_root) rather than
    # exact bytes so the emitter can evolve without breaking the test.
    assert "[shell_environment_policy]" in text
    assert "set = {" in text
    assert f'AGENTERA_HOME = "{install_root}"' in text
    assert "[agents]" in text
    assert "max_threads" not in text
    assert "max_depth = 1" in text
    assert "[features.multi_agent_v2]" in text
    assert "max_concurrent_threads_per_session = 6" in text
    assert "[agents." not in text

    agents_dir = target.parent / "agents"
    for name in setup_codex.CAPABILITY_AGENT_NAMES:
        descriptor = agents_dir / f"{name}.toml"
        assert descriptor.is_file()
        descriptor_text = descriptor.read_text(encoding="utf-8")
        assert "# agentera_managed: true" in descriptor_text
        assert f"capabilities/{name}/instructions.md" in descriptor_text
        if name in ("realisera", "optimera", "orkestrera", "profilera"):
            assert "You have full file write, file edit, and shell execution tools available" in descriptor_text
        elif name in ("hej", "inspirera"):
            assert "You are a read-only agent — do not write files or execute shell commands" in descriptor_text
        else:
            assert "You have file write and file edit tools available to create or update files, but shell execution is disabled" in descriptor_text


def test_branch2_section_absent_appends(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Branch 2: file exists with other tables, no section → append, others byte-identical."""
    target = _codex_config(tmp_path)
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
    target = _codex_config(tmp_path)
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
    target = _codex_config(tmp_path)
    pre_existing = (
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
        '\n'
        '[agents]\n'
        'max_depth = 1\n'
        '\n'
        '[features.multi_agent_v2]\n'
        'max_concurrent_threads_per_session = 6\n'
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
    target = _codex_config(tmp_path)
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
    target = _codex_config(tmp_path)
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
    target = _codex_config(tmp_path)

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

    target = _codex_config(tmp_path)
    rc = _run(setup_codex, "--config-file", str(target))
    err = capsys.readouterr().err
    assert rc == 2
    assert "--install-root" in err
    assert not target.exists()


def test_dry_run_pending_exits_1(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """AC7: --dry-run with a pending change writes nothing and exits 1."""
    target = _codex_config(tmp_path)
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
    target = _codex_config(tmp_path)
    pre_existing = (
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
        '\n'
        '[agents]\n'
        'max_depth = 1\n'
        '\n'
        '[features.multi_agent_v2]\n'
        'max_concurrent_threads_per_session = 6\n'
    )
    target.write_text(pre_existing, encoding="utf-8")
    _write_current_descriptors(setup_codex, install_root, target.parent / "agents")
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
    """Agentera v2 installs descriptor files; --enable-agents must not write v1 config paths."""
    target = _codex_config(tmp_path)

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


def test_nonstandard_config_file_requires_explicit_agents_dir(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    target = tmp_path / "isolated-config.toml"

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
        "--dry-run",
    )
    out = capsys.readouterr()
    assert rc == 2
    assert "--agents-dir" in out.err
    assert not target.exists()

    agents_dir = tmp_path / "explicit-agents"
    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
        "--agents-dir",
        str(agents_dir),
    )
    out = capsys.readouterr()
    assert rc == 0, out
    assert target.exists()
    assert (agents_dir / "realisera.toml").is_file()


def test_codex_hook_trust_uses_exact_resolved_command(setup_codex: ModuleType, tmp_path: Path):
    hooks_path = tmp_path / ".codex" / "hooks.json"
    command = f'uv run "{tmp_path / "agentera" / "app" / "hooks" / "validate_artifact.py"}"'

    rendered = setup_codex.render_codex_hooks_config(command)
    entries = setup_codex.codex_hook_state_entries(hooks_path, command=command)
    rendered_payload = json.loads(rendered)
    rendered_command = rendered_payload["hooks"]["PreToolUse"][0]["hooks"][0]["command"]

    assert rendered_command == command
    assert "${AGENTERA_HOME}" not in rendered
    assert f"{hooks_path.resolve()}:pre_tool_use:0:0" in entries
    assert entries[f"{hooks_path.resolve()}:pre_tool_use:0:0"] == setup_codex.codex_hook_trusted_hash(
        "pre_tool_use",
        setup_codex.CODEX_HOOK_MATCHER,
        command=command,
    )


def test_codex_plugin_hook_trust_uses_plugin_source_when_enabled(setup_codex: ModuleType, install_root: Path):
    current = (
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
    )

    assert setup_codex.codex_plugin_hooks_enabled(current)
    outcome = setup_codex.plan_change(current, install_root, force=False, plugin_hooks=True)

    assert outcome.action == "insert"
    assert "hooks = true" in outcome.new_text
    assert "plugin_hooks = true" in outcome.new_text
    assert "agentera@agentera:hooks/codex-plugin-hooks.json:pre_tool_use:0:0" in outcome.new_text
    assert "agentera@agentera:hooks/codex-plugin-hooks.json:post_tool_use:0:0" in outcome.new_text
    assert "${PLUGIN_ROOT}/hooks/validate_artifact.py" not in outcome.new_text
    assert setup_codex.codex_hook_trusted_hash(
        "pre_tool_use",
        setup_codex.CODEX_HOOK_MATCHER,
        command=setup_codex.CODEX_PLUGIN_HOOK_COMMAND,
    ) in outcome.new_text


def test_codex_plugin_hook_trust_retires_copied_hook_trust(setup_codex: ModuleType, install_root: Path, tmp_path: Path):
    hooks_file = tmp_path / "hooks.json"
    hooks_content = setup_codex.render_codex_hooks_config(setup_codex.CODEX_HOOK_COMMAND)
    hooks_file.write_text(hooks_content, encoding="utf-8")
    
    current = (
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
        '\n'
        '[hooks.state]\n'
        f'"{hooks_file}:pre_tool_use:0:0" = {{ trusted_hash = "abc", enabled = true }}\n'
        f'"{hooks_file}:post_tool_use:0:0" = {{ trusted_hash = "def", enabled = true }}\n'
        '"some_other_hook:pre_tool_use:0:0" = { trusted_hash = "xyz", enabled = true }\n'
    )
    
    outcome = setup_codex.plan_change(current, install_root, force=False, hooks_path=hooks_file, plugin_hooks=True)
    
    assert f'"{hooks_file}:pre_tool_use:0:0"' not in outcome.new_text
    assert f'"{hooks_file}:post_tool_use:0:0"' not in outcome.new_text
    assert '"some_other_hook:pre_tool_use:0:0"' in outcome.new_text


def test_codex_multi_agent_v2_regression_max_threads_removed(setup_codex: ModuleType, install_root: Path):
    current = (
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
        '\n'
        '[agents]\n'
        'max_threads = 12\n'
        'max_depth = 1\n'
    )
    outcome = setup_codex.plan_change(current, install_root, force=False)
    assert "max_threads" not in outcome.new_text
    assert "[features.multi_agent_v2]" in outcome.new_text
    assert "max_concurrent_threads_per_session = 12" in outcome.new_text


def test_codex_multi_agent_v2_preserves_existing_limit_without_legacy_max_threads(
    setup_codex: ModuleType,
    install_root: Path,
):
    current = (
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
        '\n'
        '[agents]\n'
        'max_depth = 1\n'
        '\n'
        '[features.multi_agent_v2]\n'
        'max_concurrent_threads_per_session = 12\n'
    )
    outcome = setup_codex.plan_change(current, install_root, force=False)
    assert outcome.action == "noop"
    assert "max_concurrent_threads_per_session = 12" in outcome.new_text
    assert "max_concurrent_threads_per_session = 6" not in outcome.new_text


def test_codex_plugin_hook_trust_preserves_user_owned_copied_hook_trust(
    setup_codex: ModuleType,
    install_root: Path,
    tmp_path: Path,
):
    hooks_file = tmp_path / "hooks.json"
    mixed = json.loads(setup_codex.render_codex_hooks_config(setup_codex.CODEX_HOOK_COMMAND))
    mixed["hooks"]["UserPromptSubmit"] = [{"hooks": [{"type": "command", "command": "echo user"}]}]
    hooks_file.write_text(json.dumps(mixed, indent=2) + "\n", encoding="utf-8")

    current = (
        '[plugins."agentera@agentera"]\n'
        'enabled = true\n'
        '\n'
        '[shell_environment_policy]\n'
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
        '\n'
        '[hooks.state]\n'
        f'"{hooks_file}:pre_tool_use:0:0" = {{ trusted_hash = "abc", enabled = true }}\n'
    )

    outcome = setup_codex.plan_change(current, install_root, force=False, hooks_path=hooks_file, plugin_hooks=True)

    assert f'"{hooks_file}:pre_tool_use:0:0"' in outcome.new_text


def test_misplaced_section_level_home_normalizes_without_force(
    setup_codex: ModuleType, tmp_path: Path, install_root: Path, capsys
):
    """Codex subtable migration: section-level AGENTERA_HOME + empty .set subtable."""
    target = _codex_config(tmp_path)
    pre_existing = (
        "[shell_environment_policy]\n"
        f'AGENTERA_HOME = "{install_root}"\n'
        "\n"
        "[shell_environment_policy.set]\n"
        "\n"
        "[agents]\n"
        "max_depth = 1\n"
    )
    target.write_text(pre_existing, encoding="utf-8")

    rc = _run(
        setup_codex,
        "--install-root",
        str(install_root),
        "--config-file",
        str(target),
    )
    out = capsys.readouterr()
    assert rc == 0, out

    import tomllib

    text = target.read_text(encoding="utf-8")
    assert "AGENTERA_HOME =" in text
    assert "[shell_environment_policy.set]" not in text
    assert f'set = {{ AGENTERA_HOME = "{install_root}" }}' in text
    parsed = tomllib.loads(text)
    policy = parsed["shell_environment_policy"]
    assert policy["set"]["AGENTERA_HOME"] == str(install_root)
    assert policy.get("AGENTERA_HOME") is None


def test_codex_managed_home_configured_requires_set_path(
    setup_codex: ModuleType, install_root: Path,
):
    misplaced = (
        "[shell_environment_policy]\n"
        f'AGENTERA_HOME = "{install_root}"\n'
        "\n"
        "[shell_environment_policy.set]\n"
    )
    canonical = (
        "[shell_environment_policy]\n"
        f'set = {{ AGENTERA_HOME = "{install_root}" }}\n'
    )
    assert not setup_codex.codex_managed_home_configured(misplaced)
    assert setup_codex.codex_managed_home_configured(canonical)
