#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Idempotently inject ``AGENTERA_HOME`` into Codex's shell-tool environment.

Codex propagates env vars into shell-tool subprocesses via the
``[shell_environment_policy].set`` table in ``~/.codex/config.toml`` (see
``ShellEnvironmentPolicyToml`` in the openai/codex config schema). This
helper writes (or refuses to overwrite) that one key so users do not
have to hand-edit TOML on every install root change.

Three structural branches drive the write logic; each maps to one
TOML state and one line-based mutation:

1. **File absent**: write a fresh config containing only the
   ``[shell_environment_policy]`` section with the ``set`` inline-table.
2. **Section present, ``set`` key absent**: insert a ``set = { ... }``
   line immediately after the section header. Every other table is
   left byte-identical.
3. **Section present, ``set`` present**:
   a. ``set.AGENTERA_HOME`` already at the desired value → exit 0
      no-op, file byte-identical.
   b. ``set`` exists with sibling keys but no ``AGENTERA_HOME`` →
      refuse without ``--force`` (print diff, exit non-zero, write
      nothing). With ``--force`` merge ``AGENTERA_HOME`` alongside
      the existing keys, preserving sibling keys and inline order.

The install root is verified against four canonical sibling entries
(``scripts/validate_capability.py``, ``hooks/``, ``skills/``, ``skills/agentera/SKILL.md``)
before any write. Auto-detection walks up from this script's location.
``--install-root PATH`` overrides detection; ``--config-file PATH``
overrides the TOML target (tests use this to avoid touching the real
``~/.codex/config.toml``).

Usage::

    uv run scripts/setup_codex.py
    uv run scripts/setup_codex.py --install-root /opt/agentera
    uv run scripts/setup_codex.py --dry-run
    uv run scripts/setup_codex.py --force
    uv run scripts/setup_codex.py --config-file /tmp/config.toml

Exit codes:

    0  no change needed (idempotent re-run) or change applied
    1  --dry-run detected a pending change (mirrors validate_capability.py)
    2  error: bad install root, conflict without --force, missing
       config target directory the helper cannot create, etc.
"""

from __future__ import annotations

import argparse
import difflib
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import NamedTuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Canonical entries that prove a directory is an agentera install root.
# Verified before any write so users cannot wire AGENTERA_HOME at a path
# that does not actually contain the suite.
CANONICAL_ENTRIES: tuple[str, ...] = (
    "scripts/validate_capability.py",
    "hooks",
    "skills",
    "skills/agentera/SKILL.md",
)

# The single key the helper manages. Any other env var is the user's.
MANAGED_KEY = "AGENTERA_HOME"

# TOML section we write to. Codex's documented mechanism for shell-tool
# env propagation. Other tables in the file are not touched.
SECTION_NAME = "shell_environment_policy"

# Default config target.
DEFAULT_CONFIG_PATH = Path.home() / ".codex" / "config.toml"

# Env-var fallbacks for auto-detection. Checked in order before the
# script-location walk-up so an explicit override always wins.
ENV_FALLBACKS: tuple[str, ...] = ("AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT")

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
    stays cheap and survives partial installs honestly: a directory
    with only ``SPEC.md`` is still rejected.
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

    Returns ``None`` when neither walk-up nor env vars produce a
    verifiable root; callers translate this to an actionable error.
    """
    # Env-var fallbacks first: an explicit override always wins so users
    # who deliberately set AGENTERA_HOME do not get surprised by a
    # walk-up landing on a stale clone elsewhere on disk.
    for var in ENV_FALLBACKS:
        candidate = os.environ.get(var)
        if candidate:
            path = Path(candidate).expanduser().resolve()
            if not verify_install_root(path):
                return path

    if start is None:
        start = Path(__file__).resolve().parent

    current = start.resolve()
    # Walk up until we hit the filesystem root. The `parents` attribute
    # plus `current` itself covers every ancestor exactly once.
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
# TOML state classification
# ---------------------------------------------------------------------------


class TomlState(NamedTuple):
    """Classification of the current ``[shell_environment_policy]`` state.

    Attributes:
        section_present: True iff the section header exists at all.
        set_present: True iff the section contains a ``set`` key.
        set_table: The parsed ``set`` table (empty dict when set_present
            is False).
    """

    section_present: bool
    set_present: bool
    set_table: dict[str, str]


def classify_toml(text: str) -> TomlState:
    """Parse ``text`` as TOML and report the structural state we care about.

    Uses stdlib ``tomllib`` (read-only) for parsing. Only the
    ``[shell_environment_policy]`` table and its ``set`` sub-key are
    inspected; every other table is irrelevant to this helper.

    Raises ``tomllib.TOMLDecodeError`` for malformed input; the caller
    surfaces the parse error to the user rather than swallowing it,
    since the helper cannot safely modify a file it cannot parse.
    """
    if not text.strip():
        return TomlState(section_present=False, set_present=False, set_table={})

    parsed = tomllib.loads(text)
    section = parsed.get(SECTION_NAME)
    if not isinstance(section, dict):
        return TomlState(section_present=False, set_present=False, set_table={})

    set_value = section.get("set")
    if not isinstance(set_value, dict):
        return TomlState(section_present=True, set_present=False, set_table={})

    # Coerce values to str: tomllib returns mixed types, but the Codex
    # contract expects string env values. Non-string sibling values
    # (rare but legal) are preserved as repr-form for diff display only.
    coerced: dict[str, str] = {}
    for key, value in set_value.items():
        coerced[str(key)] = value if isinstance(value, str) else repr(value)
    return TomlState(section_present=True, set_present=True, set_table=coerced)


# ---------------------------------------------------------------------------
# TOML emission helpers
# ---------------------------------------------------------------------------
#
# Stdlib has no TOML writer (tomllib is read-only as of 3.11). We hand-
# roll a minimal emitter for the one shape this helper produces: a
# ``set = { key = "value", ... }`` inline table whose values are all
# plain strings. The emitter quotes via TOML basic-string rules
# (backslash and double-quote escaping), which is correct for every
# realistic install-root path.


_BASIC_STRING_ESCAPE = {
    "\\": "\\\\",
    '"': '\\"',
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _toml_basic_string(value: str) -> str:
    """Quote a string per TOML basic-string rules.

    Handles the escape sequences enumerated in the TOML 1.0 spec. We do
    not emit literal strings (single-quoted) because basic strings are
    universally readable and our values (filesystem paths) never
    contain characters that would benefit from literal-string syntax.
    """
    escaped_chars: list[str] = []
    for char in value:
        if char in _BASIC_STRING_ESCAPE:
            escaped_chars.append(_BASIC_STRING_ESCAPE[char])
        elif ord(char) < 0x20:
            escaped_chars.append(f"\\u{ord(char):04X}")
        else:
            escaped_chars.append(char)
    return '"' + "".join(escaped_chars) + '"'


def emit_set_inline_table(pairs: dict[str, str]) -> str:
    """Render an inline-table value for a ``set = { ... }`` line.

    Preserves insertion order so a merge under ``--force`` keeps
    sibling keys in their original positions and appends
    ``AGENTERA_HOME`` only when it was not already present.
    """
    rendered = ", ".join(
        f"{key} = {_toml_basic_string(value)}" for key, value in pairs.items()
    )
    return "{ " + rendered + " }" if pairs else "{ }"


def render_fresh_config(install_root: Path) -> str:
    """Return the full text of a fresh ``~/.codex/config.toml``.

    Used when the file does not exist. Contains only the
    ``[shell_environment_policy]`` section with the managed key, plus a
    trailing newline so editors do not flag the file as missing-EOL.
    """
    set_value = emit_set_inline_table({MANAGED_KEY: str(install_root)})
    return (
        f"[{SECTION_NAME}]\n"
        f"set = {set_value}\n"
    )


# ---------------------------------------------------------------------------
# Line-based mutation helpers
# ---------------------------------------------------------------------------
#
# Two surgical mutations preserve every other byte in the file:
#
# 1. ``insert_set_line``: inserts ``set = { AGENTERA_HOME = "..." }``
#    immediately after the ``[shell_environment_policy]`` header line.
#    Used when the section exists but lacks a ``set`` key.
#
# 2. ``rewrite_set_line``: replaces the existing ``set = ...`` line
#    (which may span multiple physical lines if the user wrote a
#    multi-line table — we detect this conservatively and refuse if
#    the structure is too complex). Used by the ``--force`` merge path.
#
# Both helpers operate on the original text's line splits so they do
# not normalize line endings or strip trailing whitespace from
# unrelated lines.

# Match a ``[section.name]`` header line, anchored to start-of-line
# after optional whitespace. We do not match dotted-key extensions
# like ``[shell_environment_policy.set]`` because Codex's schema does
# not document that form for this section.
_SECTION_HEADER_RE = re.compile(
    r"^\s*\[\s*" + re.escape(SECTION_NAME) + r"\s*\]\s*$"
)

# Match a ``set = ...`` line within the target section. The value
# portion is captured loosely; we only use this regex to find the line
# and to do a last-resort same-line check, never to parse the value
# (tomllib already gave us the parsed structure).
_SET_LINE_RE = re.compile(r"^\s*set\s*=\s*")


def find_section_header_index(lines: list[str]) -> int | None:
    """Return the zero-based index of the section header line, or None."""
    for idx, line in enumerate(lines):
        if _SECTION_HEADER_RE.match(line):
            return idx
    return None


def find_set_line_index(lines: list[str], section_idx: int) -> int | None:
    """Return the index of the ``set = ...`` line within the section.

    Searches from ``section_idx + 1`` until the next section header or
    EOF. Returns None when no ``set`` line is present in the section
    (the common case for the ``set`` insertion branch).
    """
    for idx in range(section_idx + 1, len(lines)):
        line = lines[idx]
        if _SECTION_HEADER_RE.match(line):
            return None
        # Match any other ``[xxx]`` header too, not just ours, so we
        # bail out at table boundaries.
        if re.match(r"^\s*\[", line):
            return None
        if _SET_LINE_RE.match(line):
            return idx
    return None


def insert_set_line(text: str, install_root: Path) -> str:
    """Insert ``set = { AGENTERA_HOME = "..." }`` after the section header.

    Preserves every other byte in ``text``. Splits on lines, inserts
    one new line immediately after the header, and rejoins. The
    rejoined text uses the original line separators (``splitlines``
    drops them, so we explicitly preserve them by appending the
    correct terminator on every line).
    """
    # We need to preserve original newline characters (LF vs CRLF). Using
    # ``splitlines(keepends=True)`` gives us each line with its terminator
    # intact; the inserted line uses the same terminator as the header
    # line so mixed-terminator files stay consistent within their region.
    lines_with_ends = text.splitlines(keepends=True)
    plain_lines = [line.rstrip("\r\n") for line in lines_with_ends]

    section_idx = find_section_header_index(plain_lines)
    if section_idx is None:
        raise ValueError(
            f"insert_set_line called but [{SECTION_NAME}] header not found"
        )

    # Determine the terminator the header used; default to "\n" if the
    # header line is the last line and has no terminator (edge case for
    # a file ending mid-line, which TOML itself permits).
    header_with_end = lines_with_ends[section_idx]
    if header_with_end.endswith("\r\n"):
        terminator = "\r\n"
    elif header_with_end.endswith("\n"):
        terminator = "\n"
    else:
        terminator = "\n"

    set_value = emit_set_inline_table({MANAGED_KEY: str(install_root)})
    inserted_line = f"set = {set_value}{terminator}"

    new_lines = (
        lines_with_ends[: section_idx + 1]
        + [inserted_line]
        + lines_with_ends[section_idx + 1 :]
    )
    return "".join(new_lines)


def rewrite_set_line(text: str, merged_pairs: dict[str, str]) -> str:
    """Replace the existing ``set = ...`` line with a merged inline table.

    Used by the ``--force`` merge path. Refuses (raises ValueError)
    when the existing ``set`` value spans multiple physical lines,
    because preserving formatting in that shape would require a real
    TOML round-trip we cannot offer. Users with multi-line ``set``
    tables get the diff-and-refuse path even under ``--force``.
    """
    lines_with_ends = text.splitlines(keepends=True)
    plain_lines = [line.rstrip("\r\n") for line in lines_with_ends]

    section_idx = find_section_header_index(plain_lines)
    if section_idx is None:
        raise ValueError(
            f"rewrite_set_line called but [{SECTION_NAME}] header not found"
        )

    set_idx = find_set_line_index(plain_lines, section_idx)
    if set_idx is None:
        raise ValueError(
            f"rewrite_set_line called but no set line found in [{SECTION_NAME}]"
        )

    set_line = plain_lines[set_idx]
    # Heuristic refusal: if the same line does not contain a closing
    # brace, the user wrote a multi-line inline table or a multi-line
    # standard table layout. We bail rather than risk corrupting it.
    if "{" in set_line and "}" not in set_line:
        raise ValueError(
            "existing set value spans multiple lines; cannot safely merge"
        )

    set_line_with_end = lines_with_ends[set_idx]
    if set_line_with_end.endswith("\r\n"):
        terminator = "\r\n"
    elif set_line_with_end.endswith("\n"):
        terminator = "\n"
    else:
        terminator = ""

    set_value = emit_set_inline_table(merged_pairs)
    new_line = f"set = {set_value}{terminator}"

    new_lines = (
        lines_with_ends[:set_idx]
        + [new_line]
        + lines_with_ends[set_idx + 1 :]
    )
    return "".join(new_lines)


# ---------------------------------------------------------------------------
# Top-level decision: read state, compute desired text, classify outcome
# ---------------------------------------------------------------------------


class Outcome(NamedTuple):
    """Result of the planning pass before any I/O.

    Attributes:
        action: One of "noop", "fresh", "insert", "force-merge",
            "conflict". The CLI dispatches on this.
        new_text: The full file text after the would-be change. Empty
            string for "conflict" (no safe write text exists).
        message: Human-facing summary line printed to stdout/stderr.
        diff: Unified diff (current vs new_text). Empty for "noop".
    """

    action: str
    new_text: str
    message: str
    diff: str


def plan_change(
    current_text: str | None,
    install_root: Path,
    *,
    force: bool,
) -> Outcome:
    """Inspect ``current_text`` and decide which write path applies.

    ``current_text`` is None when the file does not exist; the empty
    string is treated identically (TOML allows empty configs).

    Returns an ``Outcome`` describing what would happen. No I/O is
    performed; the caller is responsible for writing (or not) based on
    the action label.
    """
    desired_path = str(install_root)

    # Branch 1: file absent (or empty) → write fresh config.
    if current_text is None or not current_text.strip():
        new_text = render_fresh_config(install_root)
        diff = _unified_diff("", new_text)
        return Outcome(
            action="fresh",
            new_text=new_text,
            message=(
                f"would write fresh config with "
                f"{SECTION_NAME}.set.{MANAGED_KEY} = {desired_path}"
            ),
            diff=diff,
        )

    state = classify_toml(current_text)

    # Branch 2: section absent → append a fresh section at EOF.
    if not state.section_present:
        # Ensure clean separation from any preceding content. We append
        # a blank line between the existing content and the new section
        # only when the existing text does not already end with one.
        prefix = current_text
        if not prefix.endswith("\n"):
            prefix = prefix + "\n"
        if not prefix.endswith("\n\n"):
            prefix = prefix + "\n"
        new_text = prefix + render_fresh_config(install_root)
        diff = _unified_diff(current_text, new_text)
        return Outcome(
            action="fresh",
            new_text=new_text,
            message=(
                f"would append [{SECTION_NAME}] section with "
                f"{MANAGED_KEY} = {desired_path}"
            ),
            diff=diff,
        )

    # Branch 3a: section present, no set key → insert set line.
    if not state.set_present:
        new_text = insert_set_line(current_text, install_root)
        diff = _unified_diff(current_text, new_text)
        return Outcome(
            action="insert",
            new_text=new_text,
            message=(
                f"would insert set = {{ {MANAGED_KEY} = {desired_path} }} "
                f"into [{SECTION_NAME}]"
            ),
            diff=diff,
        )

    # Branch 3b: section + set + AGENTERA_HOME at correct value → noop.
    current_value = state.set_table.get(MANAGED_KEY)
    if current_value == desired_path:
        return Outcome(
            action="noop",
            new_text=current_text,
            message=(
                f"{MANAGED_KEY} already set to {desired_path}; nothing to do"
            ),
            diff="",
        )

    # Branch 3c: section + set, AGENTERA_HOME at wrong value or missing
    # alongside sibling keys → either merge (--force) or conflict.
    siblings = {k: v for k, v in state.set_table.items() if k != MANAGED_KEY}
    merged = dict(state.set_table)
    merged[MANAGED_KEY] = desired_path

    # Special-case: AGENTERA_HOME present at a different value with no
    # other sibling keys. This is a pure value update and is safe to do
    # without --force; the user owns the section already.
    if MANAGED_KEY in state.set_table and not siblings:
        try:
            new_text = rewrite_set_line(current_text, merged)
        except ValueError as exc:
            return Outcome(
                action="conflict",
                new_text="",
                message=(
                    f"{MANAGED_KEY} present but cannot be safely updated: {exc}. "
                    "Edit ~/.codex/config.toml manually."
                ),
                diff="",
            )
        diff = _unified_diff(current_text, new_text)
        return Outcome(
            action="insert",
            new_text=new_text,
            message=(
                f"would update {MANAGED_KEY} from "
                f"{state.set_table[MANAGED_KEY]} to {desired_path}"
            ),
            diff=diff,
        )

    # Sibling keys exist. Without --force, refuse.
    if not force:
        # Build a conceptual diff: current set table → would-be merged.
        proposed_diff_text = _conflict_diff_text(state.set_table, merged)
        return Outcome(
            action="conflict",
            new_text="",
            message=(
                f"[{SECTION_NAME}].set has sibling keys "
                f"({', '.join(sorted(siblings))}). Re-run with --force "
                f"to merge {MANAGED_KEY} = {desired_path} alongside them."
            ),
            diff=proposed_diff_text,
        )

    # --force: merge AGENTERA_HOME alongside existing sibling keys.
    try:
        new_text = rewrite_set_line(current_text, merged)
    except ValueError as exc:
        return Outcome(
            action="conflict",
            new_text="",
            message=(
                f"--force requested but cannot safely merge: {exc}. "
                "Edit ~/.codex/config.toml manually."
            ),
            diff="",
        )
    diff = _unified_diff(current_text, new_text)
    return Outcome(
        action="force-merge",
        new_text=new_text,
        message=(
            f"would merge {MANAGED_KEY} = {desired_path} into existing set "
            f"(siblings preserved: {', '.join(sorted(siblings))})"
        ),
        diff=diff,
    )


def _unified_diff(before: str, after: str) -> str:
    """Pretty unified diff between two text blobs."""
    diff_lines = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile="config.toml (current)",
        tofile="config.toml (proposed)",
        n=3,
    )
    return "".join(diff_lines)


def _conflict_diff_text(
    current_table: dict[str, str], merged_table: dict[str, str]
) -> str:
    """Render a human-readable side-by-side for the conflict path.

    The actual file diff would require constructing the full new text,
    which the conflict path explicitly refuses to do. Instead we show
    the inline-table comparison so the user sees exactly which keys
    are present and which would be added.
    """
    current_inline = emit_set_inline_table(current_table)
    merged_inline = emit_set_inline_table(merged_table)
    return (
        f"current:  set = {current_inline}\n"
        f"proposed: set = {merged_inline}\n"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_text_or_none(path: Path) -> str | None:
    """Return the file's text or None when it does not exist."""
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="setup_codex",
        description=(
            "Idempotently set [shell_environment_policy].set.AGENTERA_HOME "
            "in ~/.codex/config.toml so Codex propagates AGENTERA_HOME into "
            "every shell-tool subprocess. Safe to re-run; refuses to "
            "overwrite conflicting sibling keys without --force."
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
        "--config-file",
        type=Path,
        default=DEFAULT_CONFIG_PATH,
        help=(
            "Path to the Codex config TOML to modify. "
            f"Default: {DEFAULT_CONFIG_PATH}"
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
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Merge AGENTERA_HOME alongside existing sibling keys in "
            "[shell_environment_policy].set instead of refusing. Has no "
            "effect when there are no sibling keys."
        ),
    )
    parser.add_argument(
        "--enable-agents",
        action="store_true",
        help=(
            "Deprecated compatibility flag. Agentera v2 is exposed to Codex "
            "as one bundled $agentera skill through plugin metadata, so this "
            "flag no longer writes [agents.*] config blocks."
        ),
    )
    args = parser.parse_args(argv)

    # Step 1: resolve and verify install root.
    try:
        install_root = resolve_install_root(args.install_root)
    except InstallRootError as err:
        print(str(err), file=sys.stderr)
        return 2

    # Step 2: read current config (None if absent).
    config_path: Path = args.config_file
    try:
        current_text = _read_text_or_none(config_path)
    except OSError as err:
        print(f"error reading {config_path}: {err}", file=sys.stderr)
        return 2

    # Step 3: parse-check existing content. We refuse to write to a
    # malformed file rather than risk silently dropping unrelated
    # tables; the user must repair it first.
    if current_text is not None and current_text.strip():
        try:
            tomllib.loads(current_text)
        except tomllib.TOMLDecodeError as err:
            print(
                f"error: {config_path} is not valid TOML ({err}). "
                "Repair it manually before running this helper.",
                file=sys.stderr,
            )
            return 2

    # Step 4: plan the AGENTERA_HOME change.
    outcome = plan_change(current_text, install_root, force=args.force)

    # Step 4b: v1 used this flag to write per-skill [agents.*] entries.
    # In v2 those paths do not exist; Codex sees one bundled $agentera
    # skill through plugin metadata, so the compatibility flag is a no-op.
    if args.enable_agents:
        print(
            "--enable-agents is deprecated in Agentera v2; no [agents.*] "
            "blocks will be written.",
            file=sys.stderr,
        )

    # Step 5: dispatch on the outcome.
    if outcome.action == "noop":
        print(outcome.message)
        return 0

    if outcome.action == "conflict":
        print(outcome.message, file=sys.stderr)
        if outcome.diff:
            print(outcome.diff, file=sys.stderr)
        return 2

    # Pending change: write or print depending on --dry-run.
    if args.dry_run:
        print(outcome.message)
        if outcome.diff:
            sys.stdout.write(outcome.diff)
            if not outcome.diff.endswith("\n"):
                print()
        return 1

    # Real write path. Ensure parent directory exists.
    try:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(outcome.new_text, encoding="utf-8")
    except OSError as err:
        print(f"error writing {config_path}: {err}", file=sys.stderr)
        return 2

    print(f"wrote {config_path}: {outcome.message.replace('would ', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
