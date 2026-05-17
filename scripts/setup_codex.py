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
have to hand-edit TOML when the Agentera directory changes.

Three structural branches drive the write logic; each maps to one
TOML state and one line-based mutation:

1. **File absent**: write a fresh config containing the
   ``[shell_environment_policy]`` section with the ``set`` inline-table and
   bounded ``[agents]`` settings.
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

The Agentera directory is verified against four canonical sibling entries
(``scripts/validate_capability.py``, ``hooks/``, ``skills/``, ``skills/agentera/SKILL.md``)
before any write. Auto-detection walks up from this script's location.
``--install-root PATH`` overrides detection; ``--config-file PATH``
overrides the TOML target (tests use this to avoid touching the real
``~/.codex/config.toml``). It also installs Agentera-managed runtime-native
capability descriptors under the documented Codex agent directory for personal
or project config files, or under ``--agents-dir`` for nonstandard config paths.

Usage::

    uv run scripts/setup_codex.py
    uv run scripts/setup_codex.py --install-root /opt/agentera
    uv run scripts/setup_codex.py --dry-run
    uv run scripts/setup_codex.py --force
    uv run scripts/setup_codex.py --config-file /tmp/config.toml --agents-dir /tmp/codex-agents

Exit codes:

    0  no change needed (idempotent re-run) or change applied
    1  --dry-run detected a pending change (mirrors validate_capability.py)
    2  error: bad Agentera directory, conflict without --force, missing
       config target directory the helper cannot create, etc.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import NamedTuple

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import install_root as install_root_module

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Shared setup evidence used by scripts/install_root.py. Kept as a public alias
# for older direct imports; root classification itself is delegated below.
CANONICAL_ENTRIES: tuple[str, ...] = install_root_module.SETUP_EVIDENCE

# The single key the helper manages. Any other env var is the user's.
MANAGED_KEY = "AGENTERA_HOME"

# TOML section we write to. Codex's documented mechanism for shell-tool
# env propagation. Other tables in the file are not touched.
SECTION_NAME = "shell_environment_policy"

# Default config target.
DEFAULT_CONFIG_PATH = Path.home() / ".codex" / "config.toml"

# Runtime-native subagent dispatch uses descriptor files under ~/.codex/agents
# plus one bounded [agents] table. We never write legacy [agents.<name>] blocks.
DEFAULT_AGENT_LIMITS = {"max_threads": 6, "max_depth": 1}
CAPABILITY_AGENT_NAMES: tuple[str, ...] = (
    "hej",
    "visionera",
    "resonera",
    "inspirera",
    "planera",
    "realisera",
    "optimera",
    "inspektera",
    "dokumentera",
    "profilera",
    "visualisera",
    "orkestrera",
)

# Env-var fallbacks for auto-detection. Checked in order before the
# script-location walk-up so an explicit override always wins.
ENV_FALLBACKS: tuple[str, ...] = ("AGENTERA_HOME", "CLAUDE_PLUGIN_ROOT")

# Codex user hooks are discovered from hooks.json, but current Codex requires
# user-sourced hook handlers to be trusted through [hooks.state] before they run.
CODEX_HOOK_COMMAND = 'uv run "${AGENTERA_HOME}/hooks/validate_artifact.py"'
CODEX_HOOK_MATCHER = "^apply_patch$"
CODEX_HOOK_TIMEOUT = 10
CODEX_HOOK_STATUS_MESSAGE = "validating artifact"

# ---------------------------------------------------------------------------
# Install-root resolution
# ---------------------------------------------------------------------------


class InstallRootError(RuntimeError):
    """Raised when the Agentera directory cannot be resolved or fails verification.

    Carries a user-facing message naming the missing canonical entries
    (or the auto-detection failure) so the operator sees the fix in
    one step.
    """


def verify_install_root(root: Path) -> list[str]:
    """Return setup evidence missing from ``root`` via the shared classifier.

    Empty list means ``root`` is a valid Agentera directory. The check is
    delegated to ``scripts/install_root.py`` so caller behavior follows the
    install-root Interface rather than local canonical-entry rules.
    """
    classification = install_root_module.classify_resolved_root(root, source="explicit")
    if classification.kind == "managed_fresh":
        return []
    return [entry for entry in install_root_module.SETUP_EVIDENCE if not (root / entry).exists()]


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
        classification = install_root_module.classify_resolved_root(root, source="explicit")
        if classification.kind != "managed_fresh":
            missing = verify_install_root(root)
            raise InstallRootError(
                f"--install-root {root} is not a valid Agentera directory: "
                f"missing canonical entries: {', '.join(missing)}"
            )
        return root

    detected = auto_detect_install_root()
    if detected is None:
        raise InstallRootError(
            "could not auto-detect the Agentera directory. "
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


def render_agents_config_section() -> str:
    return "[agents]\n" + "\n".join(
        f"{key} = {value}" for key, value in DEFAULT_AGENT_LIMITS.items()
    ) + "\n"


def render_fresh_config(install_root: Path) -> str:
    """Return the full text of a fresh ``~/.codex/config.toml``.

    Used when the file does not exist. Contains the managed
    ``[shell_environment_policy]`` key and bounded ``[agents]`` settings, plus
    a trailing newline so editors do not flag the file as missing-EOL.
    """
    set_value = emit_set_inline_table({MANAGED_KEY: str(install_root)})
    return f"[{SECTION_NAME}]\nset = {set_value}\n\n{render_agents_config_section()}"


def codex_hook_trusted_hash(
    event_label: str,
    matcher: str | None,
    command: str = CODEX_HOOK_COMMAND,
    timeout: int = CODEX_HOOK_TIMEOUT,
    status_message: str | None = CODEX_HOOK_STATUS_MESSAGE,
) -> str:
    """Mirror Codex's normalized command-hook trust hash.

    Codex hashes the TOML-shaped hook identity after converting it to
    canonical JSON. Optional TOML fields that are absent must be omitted here;
    serializing them as JSON null produces a different hash and leaves the hook
    discovered-but-untrusted.
    """
    handler: dict[str, object] = {
        "type": "command",
        "command": command,
        "timeout": timeout,
        "async": False,
    }
    if status_message is not None:
        handler["statusMessage"] = status_message
    identity: dict[str, object] = {
        "event_name": event_label,
        "hooks": [handler],
    }
    if matcher is not None:
        identity["matcher"] = matcher
    payload = json.dumps(
        identity,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def codex_hook_state_entries(hooks_path: Path) -> dict[str, str]:
    """Return required [hooks.state] entries for the installed hooks.json."""
    hooks_path = hooks_path.expanduser().resolve()
    return {
        f"{hooks_path}:pre_tool_use:0:0": codex_hook_trusted_hash(
            "pre_tool_use",
            CODEX_HOOK_MATCHER,
        ),
        f"{hooks_path}:post_tool_use:0:0": codex_hook_trusted_hash(
            "post_tool_use",
            CODEX_HOOK_MATCHER,
        ),
    }


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


def _table_header_re(table: str) -> re.Pattern[str]:
    dotted = r"\s*\.\s*".join(re.escape(part) for part in table.split("."))
    return re.compile(r"^\s*\[\s*" + dotted + r"\s*\]\s*$")


def _find_table_header_index(lines: list[str], table: str) -> int | None:
    pattern = _table_header_re(table)
    for idx, line in enumerate(lines):
        if pattern.match(line):
            return idx
    return None


def _line_terminator(line_with_end: str) -> str:
    if line_with_end.endswith("\r\n"):
        return "\r\n"
    if line_with_end.endswith("\n"):
        return "\n"
    return "\n"


def _find_table_key_index(lines: list[str], table_idx: int, key_literal: str) -> int | None:
    key_re = re.compile(r"^\s*" + re.escape(key_literal) + r"\s*=")
    for idx in range(table_idx + 1, len(lines)):
        line = lines[idx]
        if re.match(r"^\s*\[", line):
            return None
        if key_re.match(line):
            return idx
    return None


def _insert_table_key_line(text: str, table: str, line: str) -> str:
    lines_with_ends = text.splitlines(keepends=True)
    plain_lines = [line_text.rstrip("\r\n") for line_text in lines_with_ends]
    table_idx = _find_table_header_index(plain_lines, table)
    if table_idx is None:
        raise ValueError(f"[{table}] header not found")
    terminator = _line_terminator(lines_with_ends[table_idx])
    return "".join(
        lines_with_ends[: table_idx + 1]
        + [line + terminator]
        + lines_with_ends[table_idx + 1 :]
    )


def _replace_table_key_line(text: str, table: str, key_literal: str, line: str) -> str:
    lines_with_ends = text.splitlines(keepends=True)
    plain_lines = [line_text.rstrip("\r\n") for line_text in lines_with_ends]
    table_idx = _find_table_header_index(plain_lines, table)
    if table_idx is None:
        raise ValueError(f"[{table}] header not found")
    key_idx = _find_table_key_index(plain_lines, table_idx, key_literal)
    if key_idx is None:
        raise ValueError(f"{key_literal} not found in [{table}]")
    if "{" in plain_lines[key_idx] and "}" not in plain_lines[key_idx]:
        raise ValueError(f"{key_literal} spans multiple lines in [{table}]")
    terminator = _line_terminator(lines_with_ends[key_idx])
    return "".join(
        lines_with_ends[:key_idx]
        + [line + terminator]
        + lines_with_ends[key_idx + 1 :]
    )


def _append_table(text: str, table: str, lines: list[str]) -> str:
    prefix = text
    if not prefix.endswith("\n"):
        prefix += "\n"
    if not prefix.endswith("\n\n"):
        prefix += "\n"
    return prefix + f"[{table}]\n" + "\n".join(lines) + "\n"


def _ensure_features_hooks_enabled(text: str) -> str:
    parsed = tomllib.loads(text) if text.strip() else {}
    features = parsed.get("features")
    if isinstance(features, dict) and features.get("hooks") is True:
        return text

    lines = [line.rstrip("\r\n") for line in text.splitlines(keepends=True)]
    table_idx = _find_table_header_index(lines, "features")
    if table_idx is None:
        if isinstance(features, dict):
            raise ValueError("[features] uses an unsupported inline or dotted-table form")
        return _append_table(text, "features", ["hooks = true"])

    key_idx = _find_table_key_index(lines, table_idx, "hooks")
    if key_idx is None:
        return _insert_table_key_line(text, "features", "hooks = true")
    return _replace_table_key_line(text, "features", "hooks", "hooks = true")


def _ensure_codex_agent_limits(text: str) -> str:
    parsed = tomllib.loads(text) if text.strip() else {}
    agents = parsed.get("agents")
    if isinstance(agents, dict) and all(agents.get(key) == value for key, value in DEFAULT_AGENT_LIMITS.items()):
        return text

    lines = [line.rstrip("\r\n") for line in text.splitlines(keepends=True)]
    table_idx = _find_table_header_index(lines, "agents")
    if table_idx is None:
        if isinstance(agents, dict) and agents:
            raise ValueError("[agents] uses an unsupported inline or child-table-only form")
        return _append_table(
            text,
            "agents",
            [f"{key} = {value}" for key, value in DEFAULT_AGENT_LIMITS.items()],
        )

    for key, value in DEFAULT_AGENT_LIMITS.items():
        line = f"{key} = {value}"
        lines = [line_text.rstrip("\r\n") for line_text in text.splitlines(keepends=True)]
        table_idx = _find_table_header_index(lines, "agents")
        if table_idx is None:
            raise ValueError("[agents] header disappeared during update")
        if _find_table_key_index(lines, table_idx, key) is None:
            text = _insert_table_key_line(text, "agents", line)
        else:
            text = _replace_table_key_line(text, "agents", key, line)
    return text


def _hook_state_line(key: str, trusted_hash: str) -> str:
    return (
        f"{_toml_basic_string(key)} = "
        f"{{ trusted_hash = {_toml_basic_string(trusted_hash)}, enabled = true }}"
    )


def _ensure_codex_hook_state(text: str, hooks_path: Path) -> str:
    entries = codex_hook_state_entries(hooks_path)
    parsed = tomllib.loads(text) if text.strip() else {}
    state = parsed.get("hooks", {}).get("state", {}) if isinstance(parsed.get("hooks"), dict) else {}
    if not isinstance(state, dict):
        state = {}

    if all(
        isinstance(state.get(key), dict)
        and state[key].get("trusted_hash") == trusted_hash
        and state[key].get("enabled") is True
        for key, trusted_hash in entries.items()
    ):
        return text

    lines = [line.rstrip("\r\n") for line in text.splitlines(keepends=True)]
    table_idx = _find_table_header_index(lines, "hooks.state")
    if table_idx is None:
        if state:
            raise ValueError("[hooks.state] uses an unsupported inline or dotted-table form")
        return _append_table(
            text,
            "hooks.state",
            [_hook_state_line(key, trusted_hash) for key, trusted_hash in entries.items()],
        )

    for key, trusted_hash in entries.items():
        key_literal = _toml_basic_string(key)
        line = _hook_state_line(key, trusted_hash)
        lines = [line_text.rstrip("\r\n") for line_text in text.splitlines(keepends=True)]
        table_idx = _find_table_header_index(lines, "hooks.state")
        if table_idx is None:
            raise ValueError("[hooks.state] header disappeared during update")
        if _find_table_key_index(lines, table_idx, key_literal) is None:
            text = _insert_table_key_line(text, "hooks.state", line)
        else:
            text = _replace_table_key_line(text, "hooks.state", key_literal, line)
    return text


def ensure_codex_hook_trust(text: str, hooks_path: Path) -> str:
    """Ensure Codex will execute the installed Agentera apply_patch hooks."""
    return _ensure_codex_hook_state(_ensure_features_hooks_enabled(text), hooks_path)


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


def _with_codex_hook_trust(
    outcome: Outcome,
    before_text: str | None,
    hooks_path: Path | None,
) -> Outcome:
    if outcome.action == "conflict":
        return outcome

    before = before_text or ""
    try:
        new_text = _ensure_codex_agent_limits(outcome.new_text)
    except ValueError as exc:
        return Outcome(
            action="conflict",
            new_text="",
            message=f"cannot safely update Codex agent dispatch settings: {exc}",
            diff="",
        )

    if new_text != outcome.new_text:
        action = outcome.action if outcome.action != "noop" else "insert"
        message = (
            "would configure Codex agent dispatch limits"
            if outcome.action == "noop"
            else f"{outcome.message}; would configure Codex agent dispatch limits"
        )
        outcome = Outcome(
            action=action,
            new_text=new_text,
            message=message,
            diff=_unified_diff(before, new_text),
        )

    if hooks_path is None:
        return outcome

    try:
        new_text = ensure_codex_hook_trust(outcome.new_text, hooks_path)
    except ValueError as exc:
        return Outcome(
            action="conflict",
            new_text="",
            message=f"cannot safely update Codex hook trust state: {exc}",
            diff="",
        )

    if new_text == outcome.new_text:
        return outcome

    action = outcome.action if outcome.action != "noop" else "insert"
    if outcome.action == "noop":
        message = "would trust Codex apply_patch hooks in config.toml"
    else:
        message = f"{outcome.message}; would trust Codex apply_patch hooks"
    return Outcome(
        action=action,
        new_text=new_text,
        message=message,
        diff=_unified_diff(before, new_text),
    )


def plan_change(
    current_text: str | None,
    install_root: Path,
    *,
    force: bool,
    hooks_path: Path | None = None,
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
        return _with_codex_hook_trust(Outcome(
            action="fresh",
            new_text=new_text,
            message=(
                f"would write fresh config with "
                f"{SECTION_NAME}.set.{MANAGED_KEY} = {desired_path}"
            ),
            diff=diff,
        ), current_text, hooks_path)

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
        return _with_codex_hook_trust(Outcome(
            action="fresh",
            new_text=new_text,
            message=(
                f"would append [{SECTION_NAME}] section with "
                f"{MANAGED_KEY} = {desired_path}"
            ),
            diff=diff,
        ), current_text, hooks_path)

    # Branch 3a: section present, no set key → insert set line.
    if not state.set_present:
        new_text = insert_set_line(current_text, install_root)
        diff = _unified_diff(current_text, new_text)
        return _with_codex_hook_trust(Outcome(
            action="insert",
            new_text=new_text,
            message=(
                f"would insert set = {{ {MANAGED_KEY} = {desired_path} }} "
                f"into [{SECTION_NAME}]"
            ),
            diff=diff,
        ), current_text, hooks_path)

    # Branch 3b: section + set + AGENTERA_HOME at correct value → noop.
    current_value = state.set_table.get(MANAGED_KEY)
    if current_value == desired_path:
        return _with_codex_hook_trust(Outcome(
            action="noop",
            new_text=current_text,
            message=(
                f"{MANAGED_KEY} already set to {desired_path}; nothing to do"
            ),
            diff="",
        ), current_text, hooks_path)

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
        return _with_codex_hook_trust(Outcome(
            action="insert",
            new_text=new_text,
            message=(
                f"would update {MANAGED_KEY} from "
                f"{state.set_table[MANAGED_KEY]} to {desired_path}"
            ),
            diff=diff,
        ), current_text, hooks_path)

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
    return _with_codex_hook_trust(Outcome(
        action="force-merge",
        new_text=new_text,
        message=(
            f"would merge {MANAGED_KEY} = {desired_path} into existing set "
            f"(siblings preserved: {', '.join(sorted(siblings))})"
        ),
        diff=diff,
    ), current_text, hooks_path)


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


class AgentDescriptorChange(NamedTuple):
    action: str
    name: str
    source: Path
    target: Path
    message: str
    content: str


def codex_agent_source_dir(install_root: Path) -> Path:
    candidates = (
        install_root / "app" / "skills" / "agentera" / "agents",
        install_root / "skills" / "agentera" / "agents",
    )
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return candidates[0]


def default_agents_dir_for_config(config_path: Path) -> Path:
    expanded = config_path.expanduser()
    if expanded.name == "config.toml" and expanded.parent.name == ".codex":
        return expanded.parent / "agents"
    raise ValueError(
        "Codex agent descriptors can be inferred only for documented config layouts: "
        "~/.codex/config.toml or <project>/.codex/config.toml. "
        "Pass --agents-dir for nonstandard --config-file paths."
    )


def _codex_descriptor_managed(text: str) -> bool:
    return any(
        line.strip() == "# agentera_managed: true"
        for line in text.splitlines()[:5]
    )


def plan_agent_descriptor_changes(
    install_root: Path,
    agents_dir: Path,
    *,
    force: bool,
) -> list[AgentDescriptorChange]:
    source_dir = codex_agent_source_dir(install_root)
    changes: list[AgentDescriptorChange] = []
    for name in CAPABILITY_AGENT_NAMES:
        source = source_dir / f"{name}.toml"
        target = agents_dir / f"{name}.toml"
        try:
            source_text = source.read_text(encoding="utf-8")
        except OSError:
            changes.append(AgentDescriptorChange("blocked", name, source, target, "source descriptor is missing", ""))
            continue

        if not target.exists():
            changes.append(AgentDescriptorChange("pending", name, source, target, "would install Codex agent descriptor", source_text))
            continue
        if not target.is_file():
            changes.append(AgentDescriptorChange("blocked", name, source, target, "target exists but is not a regular file", source_text))
            continue

        try:
            target_text = target.read_text(encoding="utf-8")
        except OSError as exc:
            changes.append(AgentDescriptorChange("blocked", name, source, target, f"cannot read target descriptor: {exc}", source_text))
            continue

        if target_text == source_text:
            changes.append(AgentDescriptorChange("noop", name, source, target, "Codex agent descriptor is current", source_text))
        elif force or _codex_descriptor_managed(target_text):
            changes.append(AgentDescriptorChange("pending", name, source, target, "would refresh Codex agent descriptor", source_text))
        else:
            changes.append(AgentDescriptorChange("blocked", name, source, target, "target exists without Agentera ownership proof; treating it as user-owned", source_text))
    return changes


def write_agent_descriptor_changes(changes: list[AgentDescriptorChange]) -> None:
    for change in changes:
        if change.action != "pending":
            continue
        change.target.parent.mkdir(parents=True, exist_ok=True)
        change.target.write_text(change.content, encoding="utf-8")


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
            "Path to the Agentera directory. Must contain "
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
        "--agents-dir",
        type=Path,
        default=None,
        help=(
            "Directory for Codex runtime-native agent descriptors. "
            "Default: ~/.codex/agents for personal config or .codex/agents "
            "for project config; required with nonstandard --config-file paths."
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
            "Deprecated compatibility flag. Agentera v2 installs Codex "
            "runtime-native descriptor files, so this flag no longer writes "
            "[agents.*] config blocks."
        ),
    )
    args = parser.parse_args(argv)

    # Step 1: resolve and verify the Agentera directory.
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

    # Step 4: plan the AGENTERA_HOME change and runtime-native descriptors.
    outcome = plan_change(current_text, install_root, force=args.force)
    try:
        agents_dir = args.agents_dir or default_agents_dir_for_config(config_path)
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    descriptor_changes = plan_agent_descriptor_changes(install_root, agents_dir, force=args.force)
    pending_descriptors = [change for change in descriptor_changes if change.action == "pending"]
    blocked_descriptors = [change for change in descriptor_changes if change.action == "blocked"]

    # Step 4b: v1 used this flag to write per-skill [agents.*] entries.
    # In v2 descriptor files live under ~/.codex/agents, so the flag remains a
    # no-op for config blocks while normal descriptor installation continues.
    if args.enable_agents:
        print(
            "--enable-agents is deprecated in Agentera v2; no [agents.*] "
            "blocks will be written; runtime-native descriptor files are managed separately.",
            file=sys.stderr,
        )

    # Step 5: dispatch on the outcome.
    if outcome.action == "conflict":
        print(outcome.message, file=sys.stderr)
        if outcome.diff:
            print(outcome.diff, file=sys.stderr)
        return 2

    if blocked_descriptors:
        for change in blocked_descriptors:
            print(f"error: {change.target}: {change.message}", file=sys.stderr)
        return 2

    if outcome.action == "noop" and not pending_descriptors:
        print(outcome.message)
        return 0

    # Pending change: write or print depending on --dry-run.
    if args.dry_run:
        print(outcome.message)
        if outcome.diff:
            sys.stdout.write(outcome.diff)
            if not outcome.diff.endswith("\n"):
                print()
        for change in pending_descriptors:
            print(f"{change.message}: {change.target}")
        return 1

    # Real write path. Ensure parent directories exist.
    try:
        if outcome.action != "noop":
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(outcome.new_text, encoding="utf-8")
        write_agent_descriptor_changes(pending_descriptors)
    except OSError as err:
        print(f"error writing Codex setup targets: {err}", file=sys.stderr)
        return 2

    if outcome.action != "noop":
        print(f"wrote {config_path}: {outcome.message.replace('would ', '')}")
    else:
        print(outcome.message)
    for change in pending_descriptors:
        print(f"wrote {change.target}: {change.message.replace('would ', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
