#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""End-to-end smoke harness for the Codex and Copilot setup helpers.

Mirrors ``scripts/smoke_opencode_bootstrap.mjs``: temp directory setup,
env-var snapshot/restore in a try/finally, sequential numbered test
cases with fail-fast, ``PASS:`` / ``FAIL:`` output, exit 0 / exit 1.

The harness exercises both helpers as black boxes via ``subprocess`` so
the assertions match what a real user observes: stdout/stderr text,
exit codes, file contents, byte-identity of unrelated lines. No helper
internals are imported; if a helper is refactored, the harness still
catches behavioral regressions.

Coverage (11 sequential cases, within the 10-12 AC6 budget):

    Codex helper (5 cases):
      1. Fresh-write to absent ~/.codex/config.toml
      2. Idempotent re-run (byte-identical, exit 0)
      3. Sibling-key preservation (insert under existing
         [shell_environment_policy] without `set`, every other table
         and unrelated section text byte-identical)
      4. Conflict refusal without --force (sibling keys present)
      5. Dry-run on absent config (exit 1, file never created)

    Copilot helper (4 cases):
      6. bash branch (~/.bashrc, export syntax)
      7. zsh branch (~/.zshrc, export syntax)
      8. fish branch (~/.config/fish/config.fish, set -x syntax)
      9. unsupported-shell branch (csh, exit 2, guidance printed)

    Cross-cutting (2 cases):
     10. Both helpers reject a bogus --install-root with named
         missing canonical entries (shared contract)
     11. Both helpers' --dry-run on an idempotent target exits 0
         (no pending change → no spurious exit 1)

Run from the repo root::

    uv run scripts/smoke_setup_helpers.py

Exits 0 with ``PASS: all smoke checks passed`` on success, 1 with
``FAIL: <reason>`` on the first failure (fail-fast).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CODEX_HELPER = REPO_ROOT / "scripts" / "setup_codex.py"
COPILOT_HELPER = REPO_ROOT / "scripts" / "setup_copilot.py"


# ---------------------------------------------------------------------------
# Output protocol — mirrors smoke_opencode_bootstrap.mjs
# ---------------------------------------------------------------------------


def fail(reason: str) -> None:
    """Print ``FAIL: <reason>`` to stdout and exit 1.

    stdout (not stderr) so the AC4 protocol "stdout ends with FAIL"
    holds; ``smoke_opencode_bootstrap.mjs`` sends FAIL to stderr but the
    plan AC explicitly anchors the protocol on stdout.
    """
    print(f"FAIL: {reason}")
    sys.exit(1)


def assert_true(condition: bool, reason: str) -> None:
    if not condition:
        fail(reason)


# ---------------------------------------------------------------------------
# Subprocess helper
# ---------------------------------------------------------------------------


def run_helper(
    script: Path,
    args: list[str],
    *,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Invoke a helper script as a subprocess and capture text output.

    ``env`` overrides the process environment entirely (not merged) so
    each test case sees only the variables it sets. ``HOME`` and
    ``SHELL`` are the two the harness rotates per case.
    """
    cmd = [sys.executable, str(script), *args]
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def base_env(home: Path, shell: str | None = None) -> dict[str, str]:
    """Build a minimal env dict for a test case.

    Includes ``PATH`` (so ``sys.executable`` can find Python sub-deps if
    any), ``HOME`` pointed at the case's tmp dir, and optionally
    ``SHELL``. Deliberately omits ``AGENTERA_HOME`` and
    ``CLAUDE_PLUGIN_ROOT`` so the helper's auto-detect walk-up resolves
    from the script location (which is the live repo root) rather than
    from a leaked env var.
    """
    env: dict[str, str] = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
    }
    if shell is not None:
        env["SHELL"] = shell
    return env


# ---------------------------------------------------------------------------
# Snapshot / restore for the few env vars the harness touches
# ---------------------------------------------------------------------------

ORIGINAL_HOME = os.environ.get("HOME")
ORIGINAL_SHELL = os.environ.get("SHELL")
ORIGINAL_AGENTERA_HOME = os.environ.get("AGENTERA_HOME")
ORIGINAL_CLAUDE_PLUGIN_ROOT = os.environ.get("CLAUDE_PLUGIN_ROOT")


def restore_env() -> None:
    """Restore the four env vars the harness might mutate.

    Invoked from the top-level ``finally`` block. Subprocesses inherit
    only what we pass via ``env=``, so this is belt-and-suspenders for
    the harness's own process.
    """
    for name, original in (
        ("HOME", ORIGINAL_HOME),
        ("SHELL", ORIGINAL_SHELL),
        ("AGENTERA_HOME", ORIGINAL_AGENTERA_HOME),
        ("CLAUDE_PLUGIN_ROOT", ORIGINAL_CLAUDE_PLUGIN_ROOT),
    ):
        if original is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = original


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    tmpdir: Path | None = None
    try:
        tmpdir = Path(tempfile.mkdtemp(prefix="agentera-setup-smoke-"))

        # =====================================================================
        # Codex helper cases
        # =====================================================================

        # --- Test 1: fresh-write to absent ~/.codex/config.toml ---
        codex_home_1 = tmpdir / "codex_case_1"
        codex_home_1.mkdir()
        config_1 = codex_home_1 / ".codex" / "config.toml"
        result = run_helper(
            CODEX_HELPER,
            ["--config-file", str(config_1)],
            env=base_env(codex_home_1),
        )
        assert_true(
            result.returncode == 0,
            f"Codex fresh-write should exit 0, got {result.returncode} "
            f"(stderr={result.stderr.strip()})",
        )
        assert_true(
            config_1.exists(),
            "Codex fresh-write should create the config file",
        )
        parsed = tomllib.loads(config_1.read_text(encoding="utf-8"))
        assert_true(
            parsed.get("shell_environment_policy", {})
            .get("set", {})
            .get("AGENTERA_HOME")
            == str(REPO_ROOT),
            "Codex fresh-write should set AGENTERA_HOME to the repo root",
        )

        # --- Test 2: idempotent re-run (byte-identical, exit 0) ---
        before = config_1.read_bytes()
        result = run_helper(
            CODEX_HELPER,
            ["--config-file", str(config_1)],
            env=base_env(codex_home_1),
        )
        assert_true(
            result.returncode == 0,
            f"Codex idempotent re-run should exit 0, got {result.returncode}",
        )
        assert_true(
            "nothing to do" in result.stdout,
            f"Codex idempotent re-run should print 'nothing to do', "
            f"got stdout={result.stdout.strip()}",
        )
        after = config_1.read_bytes()
        assert_true(
            before == after,
            "Codex idempotent re-run should leave the config byte-identical",
        )

        # --- Test 3: sibling-section preservation (insert under existing
        # [shell_environment_policy] without `set`, every other table and
        # surrounding text byte-identical) ---
        codex_home_3 = tmpdir / "codex_case_3"
        codex_home_3.mkdir()
        config_3 = codex_home_3 / ".codex" / "config.toml"
        config_3.parent.mkdir(parents=True, exist_ok=True)
        original_text = (
            "[unrelated]\n"
            'name = "keep me"\n'
            'value = "preserve"\n'
            "\n"
            "[shell_environment_policy]\n"
            'inherit = "core"\n'
            "\n"
            "[other_table]\n"
            "flag = true\n"
        )
        config_3.write_text(original_text, encoding="utf-8")
        result = run_helper(
            CODEX_HELPER,
            ["--config-file", str(config_3)],
            env=base_env(codex_home_3),
        )
        assert_true(
            result.returncode == 0,
            f"Codex insert-into-existing-section should exit 0, "
            f"got {result.returncode} (stderr={result.stderr.strip()})",
        )
        new_text = config_3.read_text(encoding="utf-8")
        # Every original line must still be present in the new text.
        for original_line in original_text.splitlines():
            if not original_line.strip():
                continue
            assert_true(
                original_line in new_text,
                f"Codex insert should preserve line {original_line!r} "
                f"in modified config",
            )
        # And the parsed TOML must carry both unrelated tables and the new key.
        parsed = tomllib.loads(new_text)
        assert_true(
            parsed.get("unrelated", {}).get("name") == "keep me",
            "Codex insert should preserve [unrelated] table verbatim",
        )
        assert_true(
            parsed.get("other_table", {}).get("flag") is True,
            "Codex insert should preserve [other_table] table verbatim",
        )
        assert_true(
            parsed.get("shell_environment_policy", {}).get("inherit") == "core",
            "Codex insert should preserve sibling 'inherit' key in target section",
        )
        assert_true(
            parsed.get("shell_environment_policy", {})
            .get("set", {})
            .get("AGENTERA_HOME")
            == str(REPO_ROOT),
            "Codex insert should add AGENTERA_HOME under target section",
        )

        # --- Test 4: conflict refusal without --force (sibling set keys
        # present, AGENTERA_HOME absent) ---
        codex_home_4 = tmpdir / "codex_case_4"
        codex_home_4.mkdir()
        config_4 = codex_home_4 / ".codex" / "config.toml"
        config_4.parent.mkdir(parents=True, exist_ok=True)
        conflict_text = (
            "[shell_environment_policy]\n"
            'set = { LANG = "en_US.UTF-8", PATH = "/usr/bin" }\n'
        )
        config_4.write_text(conflict_text, encoding="utf-8")
        before_conflict = config_4.read_bytes()
        result = run_helper(
            CODEX_HELPER,
            ["--config-file", str(config_4)],
            env=base_env(codex_home_4),
        )
        assert_true(
            result.returncode != 0,
            f"Codex conflict without --force should exit non-zero, "
            f"got {result.returncode}",
        )
        assert_true(
            "sibling keys" in result.stderr or "--force" in result.stderr,
            f"Codex conflict should mention sibling keys / --force, "
            f"got stderr={result.stderr.strip()}",
        )
        after_conflict = config_4.read_bytes()
        assert_true(
            before_conflict == after_conflict,
            "Codex conflict refusal must not modify the config file",
        )

        # --- Test 5: dry-run on absent config (exit 1, file never created) ---
        codex_home_5 = tmpdir / "codex_case_5"
        codex_home_5.mkdir()
        config_5 = codex_home_5 / ".codex" / "config.toml"
        result = run_helper(
            CODEX_HELPER,
            ["--config-file", str(config_5), "--dry-run"],
            env=base_env(codex_home_5),
        )
        assert_true(
            result.returncode == 1,
            f"Codex dry-run on absent config should exit 1, "
            f"got {result.returncode}",
        )
        assert_true(
            not config_5.exists(),
            "Codex dry-run must not create the config file",
        )

        # =====================================================================
        # Copilot helper cases
        # =====================================================================

        # --- Test 6: bash branch (~/.bashrc, export syntax) ---
        copilot_home_6 = tmpdir / "copilot_case_6"
        copilot_home_6.mkdir()
        bashrc = copilot_home_6 / ".bashrc"
        result = run_helper(
            COPILOT_HELPER,
            [],
            env=base_env(copilot_home_6, shell="/bin/bash"),
        )
        assert_true(
            result.returncode == 0,
            f"Copilot bash branch should exit 0, got {result.returncode} "
            f"(stderr={result.stderr.strip()})",
        )
        assert_true(
            bashrc.exists(),
            "Copilot bash branch should create ~/.bashrc",
        )
        bashrc_text = bashrc.read_text(encoding="utf-8")
        assert_true(
            "# agentera: AGENTERA_HOME (managed)" in bashrc_text,
            "Copilot bash branch should write the managed marker comment",
        )
        assert_true(
            f'export AGENTERA_HOME="{REPO_ROOT}"' in bashrc_text,
            f"Copilot bash branch should write export line, "
            f"got {bashrc_text!r}",
        )

        # --- Test 7: zsh branch (~/.zshrc, export syntax) ---
        copilot_home_7 = tmpdir / "copilot_case_7"
        copilot_home_7.mkdir()
        zshrc = copilot_home_7 / ".zshrc"
        result = run_helper(
            COPILOT_HELPER,
            [],
            env=base_env(copilot_home_7, shell="/usr/bin/zsh"),
        )
        assert_true(
            result.returncode == 0,
            f"Copilot zsh branch should exit 0, got {result.returncode}",
        )
        assert_true(
            zshrc.exists(),
            "Copilot zsh branch should create ~/.zshrc",
        )
        zshrc_text = zshrc.read_text(encoding="utf-8")
        assert_true(
            "# agentera: AGENTERA_HOME (managed)" in zshrc_text
            and f'export AGENTERA_HOME="{REPO_ROOT}"' in zshrc_text,
            "Copilot zsh branch should write managed block with export syntax",
        )
        # The bash rc file must NOT be created in this tmp HOME (would
        # mean shell detection misrouted).
        assert_true(
            not (copilot_home_7 / ".bashrc").exists(),
            "Copilot zsh branch must not create ~/.bashrc",
        )

        # --- Test 8: fish branch (~/.config/fish/config.fish, set -x syntax) ---
        copilot_home_8 = tmpdir / "copilot_case_8"
        copilot_home_8.mkdir()
        fishrc = copilot_home_8 / ".config" / "fish" / "config.fish"
        result = run_helper(
            COPILOT_HELPER,
            [],
            env=base_env(copilot_home_8, shell="/usr/local/bin/fish"),
        )
        assert_true(
            result.returncode == 0,
            f"Copilot fish branch should exit 0, got {result.returncode} "
            f"(stderr={result.stderr.strip()})",
        )
        assert_true(
            fishrc.exists(),
            "Copilot fish branch should create ~/.config/fish/config.fish "
            "(parent dir auto-created)",
        )
        fishrc_text = fishrc.read_text(encoding="utf-8")
        assert_true(
            "# agentera: AGENTERA_HOME (managed)" in fishrc_text,
            "Copilot fish branch should write the managed marker comment",
        )
        assert_true(
            f'set -x AGENTERA_HOME "{REPO_ROOT}"' in fishrc_text,
            f"Copilot fish branch should use 'set -x' syntax, "
            f"got {fishrc_text!r}",
        )

        # --- Test 9: unsupported-shell branch (csh, exit 2, guidance) ---
        copilot_home_9 = tmpdir / "copilot_case_9"
        copilot_home_9.mkdir()
        result = run_helper(
            COPILOT_HELPER,
            [],
            env=base_env(copilot_home_9, shell="/bin/csh"),
        )
        assert_true(
            result.returncode == 2,
            f"Copilot unsupported-shell branch should exit 2, "
            f"got {result.returncode}",
        )
        assert_true(
            "csh" in result.stderr,
            f"Copilot unsupported-shell stderr should name the shell, "
            f"got stderr={result.stderr.strip()}",
        )
        assert_true(
            "--rc-file" in result.stderr,
            "Copilot unsupported-shell stderr should mention --rc-file "
            "escape hatch",
        )

        # =====================================================================
        # Cross-cutting cases
        # =====================================================================

        # --- Test 10: both helpers reject bogus --install-root ---
        bogus_root = tmpdir / "bogus_install_root"
        bogus_root.mkdir()
        # Codex
        codex_home_10 = tmpdir / "codex_case_10"
        codex_home_10.mkdir()
        result = run_helper(
            CODEX_HELPER,
            [
                "--install-root",
                str(bogus_root),
                "--config-file",
                str(codex_home_10 / "config.toml"),
            ],
            env=base_env(codex_home_10),
        )
        assert_true(
            result.returncode != 0,
            "Codex helper should reject a bogus --install-root",
        )
        assert_true(
            "missing canonical entries" in result.stderr,
            f"Codex helper should name missing canonical entries, "
            f"got stderr={result.stderr.strip()}",
        )
        # Copilot
        copilot_home_10 = tmpdir / "copilot_case_10"
        copilot_home_10.mkdir()
        result = run_helper(
            COPILOT_HELPER,
            [
                "--install-root",
                str(bogus_root),
                "--rc-file",
                str(copilot_home_10 / "myrc"),
            ],
            env=base_env(copilot_home_10, shell="/bin/bash"),
        )
        assert_true(
            result.returncode != 0,
            "Copilot helper should reject a bogus --install-root",
        )
        assert_true(
            "missing canonical entries" in result.stderr,
            f"Copilot helper should name missing canonical entries, "
            f"got stderr={result.stderr.strip()}",
        )

        # --- Test 11: both helpers' --dry-run on idempotent target exits 0 ---
        # (validator-style convention: change pending → exit 1,
        # no change → exit 0; verifies the dry-run gate respects no-op)
        # Codex: re-use config_1 from Test 1, which is already at the
        # desired value.
        result = run_helper(
            CODEX_HELPER,
            ["--config-file", str(config_1), "--dry-run"],
            env=base_env(codex_home_1),
        )
        assert_true(
            result.returncode == 0,
            f"Codex --dry-run on idempotent config should exit 0, "
            f"got {result.returncode}",
        )
        # Copilot: re-run case 6 helper against the same bashrc.
        result = run_helper(
            COPILOT_HELPER,
            ["--dry-run"],
            env=base_env(copilot_home_6, shell="/bin/bash"),
        )
        assert_true(
            result.returncode == 0,
            f"Copilot --dry-run on idempotent rc should exit 0, "
            f"got {result.returncode}",
        )

        print("PASS: all smoke checks passed")
        return 0
    finally:
        restore_env()
        if tmpdir is not None and tmpdir.exists():
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
