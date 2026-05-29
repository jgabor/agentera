#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Shared progress-commit and git-ancestry logic for Agentera.

One implementation of the commit-hash regex, git subprocess wrapper, cycle
``commit`` token parser, HEAD-ancestor classifier, cycle-commit rewrite, and the
pure backfill computation. The ``agentera check backfill`` CLI command consumes
this module so the logic lives in exactly one place.

The module imports only the Python standard library plus the sibling
``yaml_mapping`` wrapper, so it is safe to import from the hook layer (no
third-party dependency beyond the sanctioned pyyaml wrapper).
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from yaml_mapping import load_yaml_mapping

COMMIT_HASH_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


def git_run(args: list[str], cwd: Path | str) -> subprocess.CompletedProcess[str] | None:
    """Run ``git`` in ``cwd``; return ``None`` if git cannot be invoked."""
    try:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def commit_token(value: Any) -> str | None:
    """Leading verifiable git hash in a cycle ``commit`` value, else ``None``.

    ``pending``, ``N/A …`` and non-hash free text are exempt (return ``None``),
    as are non-string values.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    token = text.split()[0]
    low = token.lower()
    if low == "pending" or low.startswith("n/a"):
        return None
    return token if COMMIT_HASH_RE.match(token) else None


def ancestor_state(token: str, cwd: Path | str) -> str:
    """Classify ``token`` relative to HEAD.

    One of ``ancestor`` (already in history), ``stale`` (resolves but not an
    ancestor of HEAD), ``unknown`` (not a commit object here), or
    ``unavailable`` (git/HEAD missing).
    """
    head = git_run(["rev-parse", "--verify", "--quiet", "HEAD"], cwd)
    if head is None or head.returncode != 0:
        return "unavailable"
    exists = git_run(["rev-parse", "--verify", "--quiet", f"{token}^{{commit}}"], cwd)
    if exists is None:
        return "unavailable"
    if exists.returncode != 0:
        return "unknown"
    ancestor = git_run(["merge-base", "--is-ancestor", token, "HEAD"], cwd)
    if ancestor is None:
        return "unavailable"
    if ancestor.returncode == 0:
        return "ancestor"
    if ancestor.returncode == 1:
        return "stale"
    return "unavailable"


def rewrite_cycle_commits(text: str, changes: dict[int, str]) -> str:
    """Replace the ``commit:`` field of specific cycles, preserving the rest.

    ``changes`` maps cycle number to the new ``commit`` value. Only entries in
    the top-level ``cycles:`` list are touched; comments, ordering, quoting, and
    every other field are left exactly as authored. Multi-line commit scalars
    (a hash wrapped with a subject across several deeper-indented lines) are
    replaced wholesale, dropping their continuation lines.
    """
    if not changes:
        return text
    number_re = re.compile(r"^-\s+number:\s*(\d+)\s*$")
    list_item_re = re.compile(r"^-\s")
    commit_re = re.compile(r"^(\s+)commit:\s*.*$")
    top_key_re = re.compile(r"^[A-Za-z_]")
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    in_cycles = False
    current: int | None = None
    i = 0
    total = len(lines)
    while i < total:
        line = lines[i]
        body = line.rstrip("\n")
        if top_key_re.match(body):
            in_cycles = body.startswith("cycles:")
            current = None
            out.append(line)
            i += 1
            continue
        if in_cycles:
            number_match = number_re.match(body)
            if number_match:
                current = int(number_match.group(1))
                out.append(line)
                i += 1
                continue
            if list_item_re.match(body):
                current = None
                out.append(line)
                i += 1
                continue
            commit_match = commit_re.match(body)
            if commit_match and current in changes:
                indent = commit_match.group(1)
                key_indent = len(indent)
                newline = "\n" if line.endswith("\n") else ""
                out.append(f"{indent}commit: {changes[current]}{newline}")
                i += 1
                while i < total:
                    cont = lines[i].rstrip("\n")
                    if not cont.strip():
                        break
                    leading = len(cont) - len(cont.lstrip(" "))
                    if leading > key_indent and not list_item_re.match(cont):
                        i += 1
                        continue
                    break
                current = None
                continue
        out.append(line)
        i += 1
    return "".join(out)


@dataclass(frozen=True)
class BackfillResult:
    """Outcome of a pure backfill computation.

    ``status`` and ``exit_code`` mirror the observable CLI contract
    (``clean``/``action-needed``/``fixed``/``error``/``noop`` and exit codes
    0/1/2). ``operations`` and ``changes`` describe the per-cycle classification
    and the cycle→value rewrites the caller should apply when ``status`` is
    ``fixed``. ``message`` is set only for noop/error explanations.
    """

    status: str
    exit_code: int
    operations: list[dict[str, Any]]
    changes: dict[int, str]
    message: str | None = None


def compute_backfill(
    text: str,
    *,
    mode: str = "check",
    target_commit: str | None = None,
    target_cycle: int | None = None,
    cwd: Path | str = ".",
) -> BackfillResult:
    """Classify progress cycle commits and decide the backfill outcome.

    Pure with respect to the artifact: it parses ``text`` and inspects git
    ancestry but never reads or writes the progress file. The caller performs
    file I/O and applies :func:`rewrite_cycle_commits` when ``status`` is
    ``fixed``.
    """
    try:
        data = load_yaml_mapping(text)
    except Exception as exc:  # noqa: BLE001 - mirror CLI: any load failure is an error
        return BackfillResult("error", 2, [], {}, f"cannot parse progress artifact: {exc}")
    cycles = data.get("cycles") if isinstance(data, dict) else None
    if not isinstance(cycles, list):
        return BackfillResult("noop", 0, [], {}, "progress artifact has no cycles list")

    if ancestor_state("HEAD", cwd) == "unavailable":
        return BackfillResult(
            "noop", 0, [], {}, "git HEAD unavailable; cannot verify commit ancestry"
        )

    full_cycles = [
        (c["number"], c.get("commit"))
        for c in cycles
        if isinstance(c, dict) and isinstance(c.get("number"), int)
    ]

    target_token: str | None = None
    if target_commit:
        target_token = target_commit.strip().split()[0] if target_commit.strip() else ""
        state = ancestor_state(target_token, cwd) if target_token else "unknown"
        if state != "ancestor":
            return BackfillResult(
                "error",
                2,
                [],
                {},
                f"refusing to backfill commit '{target_commit}': it is {state} relative to HEAD. "
                "Backfill only a commit already in HEAD's history; commit the product change first, "
                "then backfill from a later commit (never amend to backfill).",
            )
        known = {n for n, _ in full_cycles}
        if target_cycle is not None and target_cycle not in known:
            return BackfillResult(
                "error", 2, [], {}, f"cycle {target_cycle} not found in progress cycles"
            )
        if target_cycle is None:
            target_cycle = next(
                (
                    n
                    for n, cv in full_cycles
                    if commit_token(cv) is None
                    or ancestor_state(commit_token(cv) or "", cwd) == "stale"
                ),
                None,
            )
        if target_cycle is None:
            return BackfillResult(
                "noop",
                0,
                [],
                {},
                "no pending or stale cycle to backfill; pass --cycle N to target one",
            )

    changes: dict[int, str] = {}
    operations: list[dict[str, Any]] = []
    for number, commit_value in full_cycles:
        if number == target_cycle and target_token:
            action, state = "set-commit", "ancestor"
            if commit_token(commit_value) == target_token:
                action, state = "none", "ancestor"
            else:
                changes[number] = target_token
            operations.append(
                {"cycle": number, "commit": target_token, "state": state, "action": action}
            )
            continue
        token = commit_token(commit_value)
        if token is None:
            operations.append(
                {"cycle": number, "commit": commit_value, "state": "exempt", "action": "none"}
            )
            continue
        state = ancestor_state(token, cwd)
        if state == "stale":
            changes[number] = "pending"
            operations.append(
                {"cycle": number, "commit": token, "state": "stale", "action": "reset-to-pending"}
            )
        else:
            operations.append({"cycle": number, "commit": token, "state": state, "action": "none"})

    sorted_changes = {n: v for n, v in sorted(changes.items(), reverse=True)}
    if not changes:
        return BackfillResult("clean", 0, operations, sorted_changes)
    if mode == "fix":
        return BackfillResult("fixed", 0, operations, sorted_changes)
    return BackfillResult("action-needed", 1, operations, sorted_changes)


def validate_progress_commits(content: str, cwd: Path | str = ".") -> list[str]:
    """Flag progress cycle ``commit`` hashes that are not ancestors of HEAD.

    A cycle ``commit`` must be ``pending``, ``N/A …``, or a commit that already
    exists in HEAD's history. A hash that resolves in the repository but is not
    an ancestor of HEAD is reported as a violation. Unknown hashes (different
    clone, shallow history) and non-git contexts are not flagged, to avoid false
    positives. YAML load failures and non-mapping roots return no commit
    violations (structural errors are reported separately by the validator).
    """
    try:
        data = load_yaml_mapping(content)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    cycles = data.get("cycles")
    if not isinstance(cycles, list):
        return []
    if ancestor_state("HEAD", cwd) == "unavailable":
        return []
    violations: list[str] = []
    for entry in cycles:
        if not isinstance(entry, dict):
            continue
        raw = entry.get("commit")
        if not isinstance(raw, str):
            continue
        token = commit_token(raw)
        if token is None:
            continue
        if ancestor_state(token, cwd) == "stale":
            number = entry.get("number", "?")
            violations.append(
                f"progress: cycle {number} commit '{token}' is not an ancestor of HEAD "
                "(stale or self-referential); set it to `pending` or run "
                "`agentera check backfill --mode fix`, then forward-fill the product commit "
                "(never amend to backfill)"
            )
    return violations
