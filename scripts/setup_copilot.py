#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Idempotently inject ``AGENTERA_HOME`` into the user's shell rc file.

Copilot CLI inherits its environment from the surrounding shell, so the
documented mechanism for wiring ``AGENTERA_HOME`` is an ``export`` line
in the user's per-shell rc (``~/.bashrc``, ``~/.zshrc``,
``~/.config/fish/config.fish``). This helper writes (or re-points) that
single managed line so users do not have to hand-edit shell configs on
every install root change.

Three shell branches drive the write logic; each maps to a rc target
and an export syntax:

1. **bash** (``$SHELL`` ends in ``/bash``) → ``~/.bashrc``,
   ``export AGENTERA_HOME=...`` syntax.
2. **zsh** (``$SHELL`` ends in ``/zsh``) → ``~/.zshrc``,
   ``export AGENTERA_HOME=...`` syntax.
3. **fish** (``$SHELL`` ends in ``/fish``) → ``~/.config/fish/config.fish``,
   ``set -x AGENTERA_HOME ...`` syntax.
4. **anything else** → exit non-zero with a printable bash one-liner the
   user can adapt for their shell.

Idempotency anchors on a marker comment line
(``# agentera: AGENTERA_HOME (managed)``) followed by the export line.
Three rc states are handled:

- **No marker present**: append a fresh marker block at EOF.
  - Special case: if the rc contains a *bare* ``export AGENTERA_HOME=...``
    line that the user wrote by hand (no marker), the helper still
    appends its own managed block but prints a notice that the bare
    line was left untouched (the user owns it).
- **Marker present at desired value**: exit 0 no-op, file byte-identical.
- **Marker present at different value**: rewrite the line *immediately
  after* the marker comment in place; every other line in the rc is
  preserved byte-identically.

The install root is verified against four canonical sibling entries
(``scripts/validate_spec.py``, ``hooks/``, ``skills/``, ``SPEC.md``)
before any write. Auto-detection walks up from this script's location.
``--install-root PATH`` overrides detection; ``--rc-file PATH``
overrides the rc target (tests use this to avoid touching the real
shell rc) and forces syntax based on file extension (``.fish`` → fish,
otherwise export).

Usage::

    python3 scripts/setup_copilot.py
    python3 scripts/setup_copilot.py --install-root /opt/agentera
    python3 scripts/setup_copilot.py --dry-run
    python3 scripts/setup_copilot.py --rc-file /tmp/myrc

Exit codes:

    0  no change needed (idempotent re-run) or change applied
    1  --dry-run detected a pending change (mirrors validate_spec.py)
    2  error: bad install root, unsupported shell without --rc-file,
       missing rc target directory the helper cannot create, etc.
"""

from __future__ import annotations

import argparse
import difflib
import os
import sys
from pathlib import Path
from typing import NamedTuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Canonical entries that prove a directory is an agentera install root.
# Verified before any write so users cannot wire AGENTERA_HOME at a path
# that does not actually contain the suite.
CANONICAL_ENTRIES: tuple[str, ...] = (
    "scripts/validate_spec.py",
    "hooks",
    "skills",
    "SPEC.md",
)

# The single env var the helper manages. Any other env var in the rc is
# the user's; we never touch unrelated lines.
MANAGED_KEY = "AGENTERA_HOME"

# Marker comment that uniquely identifies our managed block. Idempotency
# anchors on this string so re-runs find and update the next line
# without parsing shell syntax. The literal "(managed)" suffix telegraphs
# ownership to humans reading their rc by hand.
MARKER_COMMENT = f"# agentera: {MANAGED_KEY} (managed)"

# Env-var fallbacks for install-root auto-detection. Checked in order
# before the script-location walk-up so an explicit override always wins.
ENV_FALLBACKS: tuple[str, ...] = ("AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT")

# Per-shell rc paths. Resolved from $HOME at call time so tests can
# override via tmp_path-style HOME monkeypatching.
def _bash_rc() -> Path:
    return Path.home() / ".bashrc"


def _zsh_rc() -> Path:
    return Path.home() / ".zshrc"


def _fish_rc() -> Path:
    return Path.home() / ".config" / "fish" / "config.fish"


# Shell name → (rc-path resolver, syntax label). The syntax label is
# consumed by the line emitter to produce the right export form.
SHELL_TABLE: dict[str, tuple[type(_bash_rc), str]] = {
    "bash": (_bash_rc, "export"),
    "zsh": (_zsh_rc, "export"),
    "fish": (_fish_rc, "fish"),
}


# ---------------------------------------------------------------------------
# Install-root resolution
# ---------------------------------------------------------------------------


class InstallRootError(RuntimeError):
    """Raised when the install root cannot be resolved or fails verification.

    Carries a user-facing message naming the missing canonical entries
    (or the auto-detection failure) so the operator sees the fix in
    one step.
    """


def verify_install_root(root: Path) -> list[str]:
    """Return the list of canonical entries missing from ``root``.

    Empty list means ``root`` is a valid agentera install. The check is
    a presence-only test on each canonical sibling (no parsing) so it
    stays cheap and survives partial installs honestly.
    """
    missing: list[str] = []
    for entry in CANONICAL_ENTRIES:
        if not (root / entry).exists():
            missing.append(entry)
    return missing


def auto_detect_install_root(start: Path | None = None) -> Path | None:
    """Walk up from ``start`` looking for a directory with all canonical entries.

    ``start`` defaults to this script's parent (the ``scripts/`` directory),
    which means the most common case (running from a normal clone) returns
    the repo root on the first iteration. Falls back to environment
    variables (``AGENTERA_HOME``, ``CLAUDE_PLUGIN_ROOT``) when the walk
    yields no match.
    """
    for var in ENV_FALLBACKS:
        candidate = os.environ.get(var)
        if candidate:
            path = Path(candidate).expanduser().resolve()
            if not verify_install_root(path):
                return path

    if start is None:
        start = Path(__file__).resolve().parent

    current = start.resolve()
    for candidate in (current, *current.parents):
        if not verify_install_root(candidate):
            return candidate
    return None


def resolve_install_root(explicit: str | None) -> Path:
    """Translate ``--install-root`` (or auto-detection) into a verified path.

    Raises ``InstallRootError`` with a tailored message in two distinct
    failure modes: explicit path missing canonical entries, or
    auto-detection finding no valid root.
    """
    if explicit is not None:
        root = Path(explicit).expanduser().resolve()
        missing = verify_install_root(root)
        if missing:
            raise InstallRootError(
                f"--install-root {root} is not a valid agentera install: "
                f"missing canonical entries: {', '.join(missing)}"
            )
        return root

    detected = auto_detect_install_root()
    if detected is None:
        raise InstallRootError(
            "could not auto-detect agentera install root. "
            "Pass --install-root PATH where PATH contains "
            f"{', '.join(CANONICAL_ENTRIES)}."
        )
    return detected


# ---------------------------------------------------------------------------
# Shell detection
# ---------------------------------------------------------------------------


class ShellTarget(NamedTuple):
    """Resolved (rc_path, syntax) pair for the active shell.

    Attributes:
        name: Detected shell basename (``bash``, ``zsh``, ``fish``, or
            the raw basename for unsupported shells).
        rc_path: Absolute path to the rc file we should modify.
        syntax: Either ``"export"`` (bash/zsh) or ``"fish"``. Drives the
            line emitter.
    """

    name: str
    rc_path: Path
    syntax: str


class UnsupportedShellError(RuntimeError):
    """Raised when ``$SHELL`` resolves to a shell we cannot wire automatically.

    Carries the detected shell name so the CLI can print actionable
    guidance (a bash one-liner the user can adapt).
    """

    def __init__(self, shell_name: str) -> None:
        super().__init__(shell_name)
        self.shell_name = shell_name


def detect_shell(env: dict[str, str] | None = None) -> ShellTarget:
    """Inspect ``$SHELL`` and return the matching rc target.

    ``env`` defaults to ``os.environ``; tests inject a custom mapping.
    Raises ``UnsupportedShellError`` for any shell not in ``SHELL_TABLE``
    so the CLI can print guidance instead of silently writing nothing.
    """
    source = env if env is not None else os.environ
    shell_path = source.get("SHELL", "")
    # We deliberately use basename rather than substring matching so a
    # user with /opt/bash-exotic/bin/zsh still routes to zsh.
    basename = Path(shell_path).name if shell_path else ""

    if basename in SHELL_TABLE:
        rc_resolver, syntax = SHELL_TABLE[basename]
        return ShellTarget(name=basename, rc_path=rc_resolver(), syntax=syntax)

    raise UnsupportedShellError(basename or "(unset $SHELL)")


def resolve_rc_target(
    explicit_rc: Path | None, env: dict[str, str] | None = None
) -> ShellTarget:
    """Return the (rc_path, syntax) pair to write to.

    ``--rc-file PATH`` bypasses ``$SHELL`` detection entirely. Syntax is
    inferred from the file path: ``.fish`` extension → fish syntax,
    everything else → export syntax. This matches the AC8 contract.
    """
    if explicit_rc is not None:
        rc_path = explicit_rc.expanduser().resolve()
        # Path-based syntax inference. We match on suffix, then on the
        # parent directory name (``fish/config.fish`` is the canonical
        # fish layout), to avoid surprising users who passed a custom
        # name without an extension.
        if rc_path.suffix == ".fish" or "fish" in rc_path.parts:
            syntax = "fish"
        else:
            syntax = "export"
        return ShellTarget(name="custom", rc_path=rc_path, syntax=syntax)

    return detect_shell(env)


# ---------------------------------------------------------------------------
# Line emission
# ---------------------------------------------------------------------------


def _quote_for_shell(value: str, syntax: str) -> str:
    """Quote ``value`` so it survives the target shell's parser.

    Both ``export`` (bash/zsh) and ``fish`` accept double-quoted strings
    with backslash escaping for literal backslash and double-quote.
    Filesystem paths effectively never contain control characters, so a
    minimal escape set is sufficient and stays readable.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def emit_export_line(install_root: Path, syntax: str) -> str:
    """Render the single export line for the marker block (no terminator)."""
    quoted = _quote_for_shell(str(install_root), syntax)
    if syntax == "fish":
        return f"set -x {MANAGED_KEY} {quoted}"
    # bash/zsh: ``export NAME=value`` is the universal portable form.
    return f"export {MANAGED_KEY}={quoted}"


def render_marker_block(install_root: Path, syntax: str) -> str:
    """Return the two-line marker block (comment + export), newline-terminated.

    Used both for fresh appends and for rendering the would-be diff in
    dry-run mode.
    """
    return f"{MARKER_COMMENT}\n{emit_export_line(install_root, syntax)}\n"


# ---------------------------------------------------------------------------
# RC-state classification + line-based mutation
# ---------------------------------------------------------------------------


class RcState(NamedTuple):
    """Classification of the current rc file's state.

    Attributes:
        marker_present: True iff our marker comment exists on its own line.
        marker_idx: Zero-based line index of the marker comment, or -1.
        export_after_marker: The export-line text immediately following
            the marker (rstripped), or "" if marker_present is False or
            the marker is the last line.
        bare_export_present: True iff there is at least one
            ``AGENTERA_HOME``-mentioning line that is *not* part of our
            managed block (i.e. user-written line we must not touch).
    """

    marker_present: bool
    marker_idx: int
    export_after_marker: str
    bare_export_present: bool


def classify_rc(text: str) -> RcState:
    """Inspect rc ``text`` and report the structural state we care about.

    Marker detection matches the literal ``MARKER_COMMENT`` after
    rstripping whitespace, anywhere in the file. The line immediately
    following (if any) is treated as the managed export line regardless
    of its content; this lets the helper rewrite that single line in
    place even if a user manually changed the value.

    "Bare export" detection scans for any line containing
    ``AGENTERA_HOME`` outside our two-line managed block. We are
    deliberately permissive here (``grep``-style substring match): the
    goal is to *notice* user-owned lines so we can warn, not to parse
    shell syntax.
    """
    if not text:
        return RcState(
            marker_present=False,
            marker_idx=-1,
            export_after_marker="",
            bare_export_present=False,
        )

    lines = text.splitlines()
    marker_idx = -1
    for idx, line in enumerate(lines):
        if line.rstrip() == MARKER_COMMENT:
            marker_idx = idx
            break

    if marker_idx == -1:
        bare = any(MANAGED_KEY in line for line in lines)
        return RcState(
            marker_present=False,
            marker_idx=-1,
            export_after_marker="",
            bare_export_present=bare,
        )

    export_after = ""
    if marker_idx + 1 < len(lines):
        export_after = lines[marker_idx + 1].rstrip()

    # "Bare" lines are AGENTERA_HOME mentions outside the managed two-line
    # block (marker line + one line after). Flagged so the user is told
    # we are leaving their hand-written line alone.
    managed_indices = {marker_idx, marker_idx + 1}
    bare = any(
        MANAGED_KEY in line
        for idx, line in enumerate(lines)
        if idx not in managed_indices
    )
    return RcState(
        marker_present=True,
        marker_idx=marker_idx,
        export_after_marker=export_after,
        bare_export_present=bare,
    )


def append_marker_block(text: str, install_root: Path, syntax: str) -> str:
    """Append a fresh marker block to ``text``, normalizing trailing newlines.

    Ensures exactly one blank line between any pre-existing content and
    the new block so the rc stays human-readable. An empty input gets no
    leading blank line.
    """
    block = render_marker_block(install_root, syntax)
    if not text:
        return block
    prefix = text
    if not prefix.endswith("\n"):
        prefix = prefix + "\n"
    if not prefix.endswith("\n\n"):
        prefix = prefix + "\n"
    return prefix + block


def rewrite_export_line(text: str, marker_idx: int, install_root: Path, syntax: str) -> str:
    """Replace the line immediately after ``marker_idx`` with a fresh export.

    Preserves every other byte in ``text`` including the marker comment
    itself, all preceding lines, and all trailing lines. Line endings
    are preserved per-line via ``splitlines(keepends=True)``.

    Special case: if the marker happens to be the last line in the file
    (no export line followed it), we *insert* the export line after the
    marker rather than overwriting whatever happens to be at EOF.
    """
    lines_with_ends = text.splitlines(keepends=True)

    # Determine the terminator the marker line used; default to "\n".
    marker_with_end = lines_with_ends[marker_idx]
    if marker_with_end.endswith("\r\n"):
        terminator = "\r\n"
    elif marker_with_end.endswith("\n"):
        terminator = "\n"
    else:
        terminator = "\n"
        # Marker line had no terminator (file ended mid-line). Add one
        # so the new export line starts cleanly on the next line.
        lines_with_ends[marker_idx] = marker_with_end + terminator

    new_export = emit_export_line(install_root, syntax) + terminator

    if marker_idx + 1 >= len(lines_with_ends):
        # Marker is the last line: append the export line.
        new_lines = lines_with_ends + [new_export]
    else:
        # Replace the line immediately after the marker.
        new_lines = (
            lines_with_ends[: marker_idx + 1]
            + [new_export]
            + lines_with_ends[marker_idx + 2 :]
        )
    return "".join(new_lines)


# ---------------------------------------------------------------------------
# Top-level decision: read state, compute desired text, classify outcome
# ---------------------------------------------------------------------------


class Outcome(NamedTuple):
    """Result of the planning pass before any I/O.

    Attributes:
        action: One of "noop", "fresh", "rewrite". The CLI dispatches
            on this.
        new_text: The full file text after the would-be change. Same as
            ``current_text`` for "noop".
        message: Human-facing summary line printed to stdout/stderr.
        diff: Unified diff (current vs new_text). Empty for "noop".
        notice: Optional secondary message (e.g. the "bare export line
            was left untouched" warning); empty when not applicable.
    """

    action: str
    new_text: str
    message: str
    diff: str
    notice: str


def plan_change(
    current_text: str | None,
    install_root: Path,
    syntax: str,
) -> Outcome:
    """Inspect ``current_text`` and decide which write path applies.

    ``current_text`` is None when the rc file does not exist; the empty
    string is treated identically (an empty rc is legal).

    Returns an ``Outcome`` describing what would happen. No I/O is
    performed.
    """
    desired_export = emit_export_line(install_root, syntax)

    if current_text is None or current_text == "":
        new_text = render_marker_block(install_root, syntax)
        diff = _unified_diff("", new_text)
        return Outcome(
            action="fresh",
            new_text=new_text,
            message=(
                f"would create rc with marker block "
                f"({MANAGED_KEY}={install_root})"
            ),
            diff=diff,
            notice="",
        )

    state = classify_rc(current_text)

    if state.marker_present:
        if state.export_after_marker == desired_export:
            return Outcome(
                action="noop",
                new_text=current_text,
                message=(
                    f"{MANAGED_KEY} marker block already at {install_root}; "
                    "nothing to do"
                ),
                diff="",
                notice="",
            )
        new_text = rewrite_export_line(
            current_text, state.marker_idx, install_root, syntax
        )
        diff = _unified_diff(current_text, new_text)
        return Outcome(
            action="rewrite",
            new_text=new_text,
            message=(
                f"would update marker block's export line to "
                f"{MANAGED_KEY}={install_root}"
            ),
            diff=diff,
            notice="",
        )

    # Marker absent → append a fresh block. If a bare export was found
    # (user-written), append the warning so the user knows we did not
    # touch their line.
    new_text = append_marker_block(current_text, install_root, syntax)
    diff = _unified_diff(current_text, new_text)
    notice = ""
    if state.bare_export_present:
        notice = (
            f"notice: an existing {MANAGED_KEY} mention was left untouched "
            "(no managed marker comment); your hand-written line is "
            "preserved and the new managed block was appended below it."
        )
    return Outcome(
        action="fresh",
        new_text=new_text,
        message=(
            f"would append marker block ({MANAGED_KEY}={install_root})"
        ),
        diff=diff,
        notice=notice,
    )


def _unified_diff(before: str, after: str) -> str:
    """Pretty unified diff between two text blobs."""
    diff_lines = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile="rc (current)",
        tofile="rc (proposed)",
        n=3,
    )
    return "".join(diff_lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_text_or_none(path: Path) -> str | None:
    """Return the file's text or None when it does not exist."""
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _print_unsupported_guidance(shell_name: str) -> None:
    """Tell the user what to paste manually for an unsupported shell."""
    print(
        f"unsupported shell: {shell_name}",
        file=sys.stderr,
    )
    print(
        "Adapt this bash one-liner for your shell's rc file:",
        file=sys.stderr,
    )
    print(
        f'  echo \'{MARKER_COMMENT}\' >> ~/.your_shell_rc && '
        f'echo \'export {MANAGED_KEY}=<install-root>\' >> ~/.your_shell_rc',
        file=sys.stderr,
    )
    print(
        "Or pass --rc-file PATH to write to a specific file regardless "
        "of $SHELL detection.",
        file=sys.stderr,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="setup_copilot",
        description=(
            f"Idempotently set {MANAGED_KEY} in the user's shell rc file "
            "(~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish) so "
            "Copilot CLI inherits AGENTERA_HOME from the surrounding "
            "shell. Safe to re-run; preserves all unrelated lines."
        ),
    )
    parser.add_argument(
        "--install-root",
        type=str,
        default=None,
        help=(
            "Path to the agentera install root. Must contain "
            f"{', '.join(CANONICAL_ENTRIES)}. Default: auto-detect from this "
            "script's location, then fall back to AGENTERA_HOME or "
            "CLAUDE_PLUGIN_ROOT env vars."
        ),
    )
    parser.add_argument(
        "--rc-file",
        type=Path,
        default=None,
        help=(
            "Path to a specific rc file to modify. Bypasses $SHELL "
            "detection. Syntax is inferred from the path: ``.fish`` "
            "extension or a path containing ``fish/`` → fish syntax; "
            "anything else → export syntax."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Print the would-be diff without writing. Exits 1 when a "
            "change would occur, 0 when no change is needed."
        ),
    )
    args = parser.parse_args(argv)

    # Step 1: resolve and verify install root.
    try:
        install_root = resolve_install_root(args.install_root)
    except InstallRootError as err:
        print(str(err), file=sys.stderr)
        return 2

    # Step 2: resolve rc target (--rc-file beats $SHELL detection).
    try:
        target = resolve_rc_target(args.rc_file)
    except UnsupportedShellError as err:
        _print_unsupported_guidance(err.shell_name)
        return 2

    # Plan tightening from critic review: print the resolved rc target
    # *before* any write so users can Ctrl-C if it points somewhere
    # unexpected (e.g. wrong shell detected, --rc-file typo).
    print(
        f"target: {target.rc_path} (shell={target.name}, syntax={target.syntax})"
    )

    # Step 3: read current rc (None if absent).
    try:
        current_text = _read_text_or_none(target.rc_path)
    except OSError as err:
        print(f"error reading {target.rc_path}: {err}", file=sys.stderr)
        return 2

    # Step 4: plan the change.
    outcome = plan_change(current_text, install_root, target.syntax)

    # Step 5: dispatch on the outcome.
    if outcome.action == "noop":
        print(outcome.message)
        return 0

    if args.dry_run:
        print(outcome.message)
        if outcome.diff:
            sys.stdout.write(outcome.diff)
            if not outcome.diff.endswith("\n"):
                print()
        if outcome.notice:
            print(outcome.notice)
        return 1

    # Real write path. Ensure parent directory exists (fish's
    # ~/.config/fish/ is the common case).
    try:
        target.rc_path.parent.mkdir(parents=True, exist_ok=True)
        target.rc_path.write_text(outcome.new_text, encoding="utf-8")
    except OSError as err:
        print(f"error writing {target.rc_path}: {err}", file=sys.stderr)
        return 2

    print(f"wrote {target.rc_path}: {outcome.message.replace('would ', '')}")
    if outcome.notice:
        print(outcome.notice)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
