#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Self-audit checks for artifact writing conventions (SPEC §24).

Three functions implement the mandatory pre-write gate: verbosity drift,
abstraction creep, and filler accumulation. Advisory only — report but
do not block writes.
"""

# Known drift risk: §24 banned verbosity patterns are hardcoded.
# When patterns change in SPEC.md §24, update _BANNED_PATTERNS below.
# Deferred: extract from SPEC.md via generate_contracts.py --schema (§24 extension).

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Per-entry token budgets (SPEC.md §4 Token budgets table)
# If an artifact has no explicit per-entry budget, use full-file budget / 5.
# ---------------------------------------------------------------------------

_FULL_FILE_BUDGETS: dict[str, int] = {
    "PROGRESS.md": 3000,
    "EXPERIMENTS.md": 2500,
    "HEALTH.md": 2000,
    "DECISIONS.md": 5000,
    "TODO.md": 5000,
    "CHANGELOG.md": 5000,
    "PLAN.md": 2500,
    "VISION.md": 1500,
    "DESIGN.md": 2000,
    "DOCS.md": 2000,
}

_PER_ENTRY_BUDGETS: dict[str, int] = {
    "PROGRESS.md": 500,
    "EXPERIMENTS.md": 300,
    "HEALTH.md": 150,
    "DECISIONS.md": 200,
    "TODO.md": 100,
    "CHANGELOG.md": 300,
    "PLAN.md": 100,
}

# ---------------------------------------------------------------------------
# Concrete anchor patterns (SPEC.md §24 Check 2 — Abstraction creep)
# ---------------------------------------------------------------------------

_FILE_PATH_RE = re.compile(
    r"\b(?:[a-zA-Z0-9_\-./]+/)+[a-zA-Z0-9_\-.]+\.[a-zA-Z]{1,10}\b"
)

_LINE_NUMBER_RE = re.compile(r":\d{2,}\b")

_COMMIT_HASH_RE = re.compile(r"\b[0-9a-fA-F]{7,}\b")

_METRIC_VALUE_RE = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:ms|s|MB|GB|KB|%|rps|rpm|ops|words|lines|files|items|cycles)\b"
)

_BACKTICK_IDENTIFIER_RE = re.compile(r"`[^`]+`")

_QUOTED_TEXT_RE = re.compile(r"""[^"]*"[^"]+"[^"]*""")


# ---------------------------------------------------------------------------
# Banned verbosity patterns (SPEC.md §24 Banned verbosity patterns table)
# ---------------------------------------------------------------------------

_BANNED_PATTERNS: list[tuple[str, str]] = [
    # (canonical name, case-insensitive regex)
    ("meta-commentary about writing", r"Here\s+is\s+the\b"),
    ("meta-commentary about writing", r"I\s+have\s+updated\b"),
    ("meta-commentary about writing", r"I[’']ve\s+written\b"),
    ("hedging qualifiers", r"It\s+seems\s+like\b"),
    ("hedging qualifiers", r"It\s+appears\s+that\b"),
    ("hedging qualifiers", r"\bPossibly\b"),
    ("redundant transitions", r"Moving\s+on\s+to\b"),
    ("redundant transitions", r"Now\s+let[’']s\s+look\s+at\b"),
    ("self-referential process narration", r"I\s+am\s+now\b"),
    ("self-referential process narration", r"The\s+agent\s+is\s+checking\b"),
    ("filler introductions", r"Based\s+on\s+my\s+analysis\b"),
    ("filler introductions", r"After\s+careful\s+consideration\b"),
    ("summary preambles", r"\bIn\s+summary\b"),
    ("summary preambles", r"\bTo\s+recap\b"),
    ("summary preambles", r"\bOverall\b"),
    ("excessive justification", r"I\s+chose\s+this\s+approach\s+because\b"),
]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def check_verbosity(
    text: str,
    artifact: str,
    budgets: dict[str, int] | None = None,
) -> tuple[bool, str]:
    """Check entry word count against the §4 per-entry budget.

    Args:
        text: The artifact entry text.
        artifact: Canonical artifact name (e.g. ``"PROGRESS.md"``).
        budgets: Optional budget overrides. Falls back to built-in
            per-entry budgets with a full-file/5 default for artifacts
            without an explicit per-entry budget.

    Returns:
        ``(True, "")`` if word count is within budget.
        ``(False, reason)`` with a verbosity drift message otherwise.
    """
    word_count = len(text.split())

    if budgets is None:
        budgets = _PER_ENTRY_BUDGETS

    per_entry_budget = budgets.get(artifact)
    if per_entry_budget is None:
        full_budget = _FULL_FILE_BUDGETS.get(artifact)
        if full_budget is not None:
            per_entry_budget = full_budget // 5
        else:
            per_entry_budget = 500  # generous default for unknown artifacts

    if word_count <= per_entry_budget:
        return (True, "")

    return (
        False,
        f"verbosity drift: {word_count} words exceeds {per_entry_budget} budget",
    )


def check_abstraction(text: str) -> tuple[bool, str]:
    """Scan for at least one concrete anchor in the text.

    Looks for: file path, line number, commit hash, metric value,
    backtick-enclosed identifier, or direct quote.

    Returns:
        ``(True, anchor)`` if at least one anchor is found.
        ``(False, reason)`` with an abstraction creep message otherwise.
    """
    match = _FILE_PATH_RE.search(text)
    if match:
        return (True, match.group(0))

    match = _LINE_NUMBER_RE.search(text)
    if match:
        return (True, match.group(0))

    match = _COMMIT_HASH_RE.search(text)
    if match:
        return (True, match.group(0))

    match = _METRIC_VALUE_RE.search(text)
    if match:
        return (True, match.group(0))

    match = _BACKTICK_IDENTIFIER_RE.search(text)
    if match:
        return (True, match.group(0))

    match = _QUOTED_TEXT_RE.search(text)
    if match:
        return (True, match.group(0))

    return (False, "abstraction creep: no concrete anchor")


def check_filler(text: str) -> tuple[bool, str]:
    """Scan for banned verbosity patterns from §24.

    Returns:
        ``(True, "")`` if no banned patterns are found.
        ``(False, reason)`` listing matched pattern names otherwise.
    """
    matched: list[str] = []
    for name, pattern in _BANNED_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            if name not in matched:
                matched.append(name)

    if not matched:
        return (True, "")

    return (False, "filler: " + ", ".join(matched))
