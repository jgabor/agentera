"""Suite usage analytics: detect skill invocations from a Section 21 corpus.

Task 1 (committed) landed marker detection, conversation grouping, and
intro/exit pairing. Task 2 (this file's current scope) layers two things
on top:

1. **Trigger classification** — each invocation is tagged ``slash`` or
   ``natural`` based on the user turn that immediately precedes the
   introduction marker within the same conversation.
2. **Project scoping** — a ``--project PATH`` flag scopes the analysis to
   one project's records; without the flag the analysis spans every
   project in the corpus and exposes a per-project breakdown alongside
   the cross-project totals.

Output surfaces (USAGE.md, stdout summary, --json) remain out of scope
and belong to Task 3. The CLI extension here exists so tests can exercise
the new behavior end-to-end.

Marker format (per SPEC.md sections 5 + 12)::

    ─── <glyph> <skillname> · <word> ───

`<glyph>` is a single character (e.g. ⧉, ≡, ⛶). `<skillname>` is lowercase
ending in ``era``. `<word>` is either a phase label (any word) for an
introduction or an exit status (``complete``, ``flagged``, ``stuck``,
``waiting``).

Usage::

    python3 scripts/usage_stats.py --corpus path/to/corpus.json
    python3 scripts/usage_stats.py --corpus corpus.json --project agentera
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from pprint import pprint
from typing import Iterable

# ---------------------------------------------------------------------------
# Marker grammar
# ---------------------------------------------------------------------------

EXIT_STATUSES: frozenset[str] = frozenset({"complete", "flagged", "stuck", "waiting"})

# Trigger classification labels. Stored on each Invocation so downstream
# Task 3 surfaces (USAGE.md, stdout, JSON) can render slash-vs-NL splits.
TRIGGER_SLASH = "slash"
TRIGGER_NATURAL = "natural"

# Divider runs of U+2500 (one or more), padded by spaces, around the body.
# Body = "<glyph> <skillname> · <word>" where:
#   - glyph: any single non-space character (skills define their own glyph)
#   - skillname: lowercase letters ending in "era"
#   - separator: U+00B7 middle dot, padded
#   - word: an arbitrary phase label or an exit status, lowercase letters
_MARKER_RE = re.compile(
    r"─{2,}\s+"                # leading divider run (>=2 dashes)
    r"(?P<glyph>\S)\s+"             # single-character skill glyph
    r"(?P<skill>[a-z]+era)\s+"      # skill name ending in "era"
    r"·\s+"                    # middle dot separator
    r"(?P<word>[a-z]+(?:\s+\d+)?)"  # phase word, optionally trailing number
    r"\s+─{2,}"                # trailing divider run
)


@dataclass(frozen=True)
class Marker:
    """One workflow marker parsed from an assistant turn."""

    kind: str              # "intro" or "exit"
    skill: str             # lowercase skill name
    glyph: str             # single character glyph
    word: str              # phase word for intro, or exit status for exit
    line: str              # the matched substring (for debugging)


@dataclass
class Invocation:
    """One paired (or orphaned) skill invocation within a conversation."""

    skill: str
    glyph: str
    intro_word: str                          # the phase word at introduction
    intro_source_id: str                     # source_id of the intro turn
    intro_timestamp: str                     # timestamp of the intro turn
    completed: bool                          # True if a matching exit was found
    exit_status: str | None = None           # one of EXIT_STATUSES, or None
    exit_source_id: str | None = None
    exit_timestamp: str | None = None
    # Task 2 additions: trigger phrasing + project scoping context.
    trigger: str = TRIGGER_NATURAL           # one of TRIGGER_SLASH / TRIGGER_NATURAL
    project_id: str = ""                     # project this invocation came from


# ---------------------------------------------------------------------------
# Marker detection
# ---------------------------------------------------------------------------


def find_markers(text: str) -> list[Marker]:
    """Return every well-formed workflow marker in ``text``.

    A marker is classified as an exit if its `word` is in EXIT_STATUSES,
    otherwise it is treated as an introduction (any phase label is allowed
    per SPEC; e.g. ``planning``, ``audit``, ``cycle``, ``cycle 5``).
    """
    if not text:
        return []
    markers: list[Marker] = []
    for match in _MARKER_RE.finditer(text):
        word = match.group("word")
        kind = "exit" if word in EXIT_STATUSES else "intro"
        markers.append(
            Marker(
                kind=kind,
                skill=match.group("skill"),
                glyph=match.group("glyph"),
                word=word,
                line=match.group(0),
            )
        )
    return markers


# ---------------------------------------------------------------------------
# Conversation turn predicate + grouping
# ---------------------------------------------------------------------------


def is_assistant_conversation_turn(record: dict) -> bool:
    """True iff this record is a conversation_turn from the assistant.

    User turns are excluded because they may quote markers in pasted text;
    only the agent's own narration counts as a real invocation.
    """
    if not isinstance(record, dict):
        return False
    if record.get("source_kind") != "conversation_turn":
        return False
    data = record.get("data")
    if not isinstance(data, dict):
        return False
    return data.get("actor") == "assistant"


def group_by_conversation(records: Iterable[dict]) -> dict[str, list[dict]]:
    """Group assistant conversation turns by ``source_id`` (one bucket per
    record), then sort each bucket by ``timestamp``.

    Section 21 records carry no guaranteed order. The corpus envelope assigns
    a stable ``source_id`` per logical record; we treat that as the
    conversation key for grouping. Within a bucket we sort by ISO 8601
    timestamp, falling back to original list order on ties.
    """
    buckets: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        if not is_assistant_conversation_turn(record):
            continue
        sid = record.get("source_id")
        if not isinstance(sid, str):
            continue
        buckets[sid].append(record)
    for sid, items in buckets.items():
        items.sort(key=lambda r: r.get("timestamp", ""))
    return dict(buckets)


# ---------------------------------------------------------------------------
# Pairing walker
# ---------------------------------------------------------------------------


def pair_invocations(turns: Iterable[dict]) -> list[Invocation]:
    """Walk assistant turns in order and pair intros with exits per skill.

    Algorithm: maintain a per-skill FIFO queue of unmatched introductions.
    When an exit for that skill appears, dequeue the oldest unmatched intro
    and mark the invocation as completed with that exit's status. Any intros
    still queued at the end of the conversation are emitted as incomplete
    invocations.

    Markers are processed in document order within each turn, then in
    timestamp order across turns. This preserves the rule that nested
    invocations (intro_a, intro_b, exit_b, exit_a) match correctly.
    """
    pending: dict[str, list[Invocation]] = defaultdict(list)
    completed: list[Invocation] = []
    for turn in turns:
        sid = turn.get("source_id", "")
        ts = turn.get("timestamp", "")
        text = ((turn.get("data") or {}).get("content") or "")
        for marker in find_markers(text):
            if marker.kind == "intro":
                pending[marker.skill].append(
                    Invocation(
                        skill=marker.skill,
                        glyph=marker.glyph,
                        intro_word=marker.word,
                        intro_source_id=sid,
                        intro_timestamp=ts,
                        completed=False,
                    )
                )
            else:
                queue = pending.get(marker.skill)
                if not queue:
                    # Orphan exit (no matching intro). Ignore: not a counted
                    # invocation, just stray output.
                    continue
                # Match against the most recent unmatched intro for this
                # skill so nested invocations of the same skill pair LIFO.
                inv = queue.pop()
                inv.completed = True
                inv.exit_status = marker.word
                inv.exit_source_id = sid
                inv.exit_timestamp = ts
                completed.append(inv)
    # Emit leftover intros as incomplete invocations.
    incomplete: list[Invocation] = []
    for queue in pending.values():
        incomplete.extend(queue)
    # Stable sort by intro timestamp so the result reflects appearance order.
    return sorted(
        completed + incomplete,
        key=lambda inv: (inv.intro_timestamp, inv.intro_source_id),
    )


# ---------------------------------------------------------------------------
# Trigger classification
# ---------------------------------------------------------------------------
#
# Two slash-command runtime conventions are recognized. Anything else falls
# through to natural-language. Codex / Copilot are intentionally out of
# scope for this task (per the plan's Task 2 acceptance) and are documented
# here so future work knows where to extend.
#
#   1. **Claude Code**: the user turn wraps the slash command in a
#      ``<command-name>/X</command-name>`` tag (sometimes accompanied by
#      ``<command-message>`` and ``<command-args>`` siblings). The same
#      runtime also accepts a bare line beginning with ``/skillname``
#      followed by whitespace or end-of-line.
#
#   2. **OpenCode**: the user turn carries the slash invocation as a plain
#      line whose first non-whitespace characters match
#      ``/skillname(\s|$)``. There is no XML wrapping. We treat any user
#      turn whose first non-whitespace line matches that shape as
#      slash-triggered.
#
# Future runtimes (Codex, Copilot, others) can extend this by adding a
# new pattern and listing it in the comment above; the classifier function
# returns slash on the first match and natural otherwise.

# Claude Code XML tag form: <command-name>/anything</command-name>.
_CLAUDE_CODE_XML_RE = re.compile(
    r"<command-name>\s*/[A-Za-z0-9._:-]+\s*</command-name>",
)

# Bare slash form, e.g. ``/realisera`` or ``/realisera arg`` as the first
# non-whitespace token on a line. Covers both Claude Code (when the user
# types the slash directly) and OpenCode (which never uses XML wrapping).
_BARE_SLASH_RE = re.compile(
    r"(?m)^\s*/[A-Za-z0-9._:-]+(?:\s|$)",
)


def classify_trigger(user_turn_text: str | None) -> str:
    """Return ``TRIGGER_SLASH`` if the user turn carries a slash signature.

    Falls back to ``TRIGGER_NATURAL`` when no signature is present (the
    common case for free-form prompts) or when the preceding user turn is
    missing entirely (the conversation opened with the assistant for some
    reason — defensive default, not a real corpus shape).

    Recognized signatures: Claude Code ``<command-name>`` XML tag, and the
    bare ``/skillname`` shape used by both Claude Code and OpenCode.
    """
    if not user_turn_text:
        return TRIGGER_NATURAL
    if _CLAUDE_CODE_XML_RE.search(user_turn_text):
        return TRIGGER_SLASH
    if _BARE_SLASH_RE.search(user_turn_text):
        return TRIGGER_SLASH
    return TRIGGER_NATURAL


# ---------------------------------------------------------------------------
# Project scoping
# ---------------------------------------------------------------------------
#
# Section 21 records carry a ``project_id`` field (a derived short name
# such as ``agentera`` or ``jg-go`` for Claude Code, or ``"global"`` for
# non-project-scoped data). The Claude Code adapter derives this from the
# project's directory path via ``project_name_from_dir``.
#
# ``--project PATH`` accepts either the short project_id directly (e.g.
# ``--project agentera``) or a longer filesystem-style path whose final
# component is the project name (e.g. ``--project /home/me/git/agentera``).
# The match is a substring check in either direction so both forms work
# without the caller knowing which encoding the corpus uses. This is
# documented at the CLI flag and re-stated here so callers do not have to
# guess: substring matching against ``project_id`` is the contract.


def _project_match(record_project_id: str, requested: str) -> bool:
    """True iff ``record_project_id`` matches the user-supplied filter.

    Uses bidirectional substring matching so a short id like ``agentera``
    matches a long path like ``/home/me/git/agentera`` and vice versa.
    Empty record ids never match (they would otherwise spuriously match
    any non-empty filter via the substring rule).
    """
    if not record_project_id or not requested:
        return False
    return record_project_id in requested or requested in record_project_id


def filter_records_by_project(
    records: Iterable[dict], requested: str | None
) -> list[dict]:
    """Return only records whose ``project_id`` matches ``requested``.

    When ``requested`` is None (the cross-project default), all records
    pass through unchanged. When supplied, records without a
    ``project_id`` field or with a non-matching value are dropped.
    """
    if requested is None:
        return list(records)
    out: list[dict] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        pid = record.get("project_id", "")
        if isinstance(pid, str) and _project_match(pid, requested):
            out.append(record)
    return out


# ---------------------------------------------------------------------------
# Preceding-user-turn lookup
# ---------------------------------------------------------------------------
#
# Pair_invocations runs over assistant-only turns. To classify a trigger
# we need the user turn that immediately precedes the assistant turn that
# carried the introduction marker — within the same conversation. We build
# a per-conversation timeline of user turns once and binary-search-style
# walk it per invocation. Linear scans are fine in practice (corpora are
# small and conversations are bounded) so we keep the implementation
# straightforward.


def _user_turns_by_conversation(records: Iterable[dict]) -> dict[str, list[dict]]:
    """Group user conversation turns by source_id, sorted by timestamp."""
    buckets: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        if not isinstance(record, dict):
            continue
        if record.get("source_kind") != "conversation_turn":
            continue
        data = record.get("data")
        if not isinstance(data, dict):
            continue
        if data.get("actor") != "user":
            continue
        sid = record.get("source_id")
        if not isinstance(sid, str):
            continue
        buckets[sid].append(record)
    for items in buckets.values():
        items.sort(key=lambda r: r.get("timestamp", ""))
    return dict(buckets)


def _preceding_user_turn(
    user_turns: list[dict], assistant_timestamp: str
) -> dict | None:
    """Return the latest user turn strictly before ``assistant_timestamp``."""
    candidate: dict | None = None
    for turn in user_turns:
        ts = turn.get("timestamp", "")
        if ts < assistant_timestamp:
            candidate = turn
        else:
            break
    return candidate


# ---------------------------------------------------------------------------
# Top-level orchestrator
# ---------------------------------------------------------------------------


@dataclass
class CorpusAnalysis:
    """Aggregated invocation analysis. Output surfaces are not yet attached.

    Task 1 exposed the pipeline; Task 2 adds trigger classification, the
    project filter, and a per-project breakdown alongside the cross-project
    totals. Output surfaces (USAGE.md / stdout / JSON) come in Task 3.

    ``project_filter`` is the value of the ``--project`` flag (None when
    unset). When None, ``per_project`` is populated so Task 3 can render
    cross-project totals plus per-project subtotals; when set, the filter
    is already applied to ``invocations`` and ``per_project`` is left
    empty (the global ``skills`` dict already reflects the single project).
    """

    invocations: list[Invocation] = field(default_factory=list)
    skills: dict[str, dict[str, int]] = field(default_factory=dict)
    project_filter: str | None = None
    per_project: dict[str, dict[str, dict[str, int]]] = field(default_factory=dict)


def _empty_skill_bucket() -> dict[str, int]:
    """Per-skill counter shape. Kept in one place so Task 3 stays in sync."""
    return {
        "total": 0,
        "completed": 0,
        "incomplete": 0,
        "trigger_slash": 0,
        "trigger_natural": 0,
    }


def _accumulate(bucket: dict[str, int], inv: Invocation) -> None:
    """Fold one invocation into a per-skill counter bucket."""
    bucket["total"] += 1
    bucket["completed" if inv.completed else "incomplete"] += 1
    bucket["trigger_slash" if inv.trigger == TRIGGER_SLASH else "trigger_natural"] += 1


def analyze_corpus(
    corpus: dict, project_filter: str | None = None
) -> CorpusAnalysis:
    """Run the full pipeline against a Section 21 corpus envelope.

    When ``project_filter`` is set, only records whose ``project_id``
    matches the filter contribute to the analysis (substring match in
    either direction; see ``_project_match``). When ``project_filter`` is
    None, every project in the corpus contributes and the result carries a
    ``per_project`` breakdown alongside the cross-project ``skills`` total.
    """
    raw_records = corpus.get("records", []) if isinstance(corpus, dict) else []
    records = filter_records_by_project(raw_records, project_filter)

    # Build user-turn timelines once: classification needs the latest user
    # turn strictly before each assistant turn that carried an intro marker.
    user_turns_by_conv = _user_turns_by_conversation(records)

    grouped = group_by_conversation(records)
    invocations: list[Invocation] = []
    for sid, turns in grouped.items():
        # Map intro_timestamp -> project_id for fast post-pairing tagging.
        # All assistant turns within a conversation share the same source_id
        # but each turn carries its own project_id (they should agree, but we
        # do not assume — we attach per-invocation rather than per-conversation).
        ts_to_project = {
            t.get("timestamp", ""): str(t.get("project_id", ""))
            for t in turns
        }
        for inv in pair_invocations(turns):
            inv.project_id = ts_to_project.get(inv.intro_timestamp, "")
            preceding = _preceding_user_turn(
                user_turns_by_conv.get(sid, []), inv.intro_timestamp
            )
            preceding_text = ""
            if preceding is not None:
                data = preceding.get("data") or {}
                preceding_text = data.get("content") or ""
            inv.trigger = classify_trigger(preceding_text)
            invocations.append(inv)

    invocations.sort(
        key=lambda inv: (inv.intro_timestamp, inv.intro_source_id, inv.skill)
    )

    skills: dict[str, dict[str, int]] = defaultdict(_empty_skill_bucket)
    per_project: dict[str, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(_empty_skill_bucket)
    )
    for inv in invocations:
        _accumulate(skills[inv.skill], inv)
        # Per-project breakdown only matters in cross-project mode; when the
        # caller filtered to a single project, ``skills`` already reflects it.
        if project_filter is None and inv.project_id:
            _accumulate(per_project[inv.project_id][inv.skill], inv)

    # Convert nested defaultdicts to plain dicts so JSON serialization in
    # Task 3 stays predictable. defaultdict round-trips fine but plain
    # dicts make tests easier to read.
    per_project_plain: dict[str, dict[str, dict[str, int]]] = {
        pid: {skill: dict(counts) for skill, counts in skill_map.items()}
        for pid, skill_map in per_project.items()
    }

    return CorpusAnalysis(
        invocations=invocations,
        skills={k: dict(v) for k, v in skills.items()},
        project_filter=project_filter,
        per_project=per_project_plain,
    )


# ---------------------------------------------------------------------------
# Minimal CLI (debug-only)
# ---------------------------------------------------------------------------


def _read_corpus(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="usage_stats",
        description="Detect skill invocations, pair them with exit signals, "
                    "and classify trigger phrasing (Tasks 1 + 2 pipeline; "
                    "USAGE.md / stdout / JSON surfaces land in Task 3).",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help="Path to a Section 21 corpus.json envelope.",
    )
    parser.add_argument(
        "--project",
        type=str,
        default=None,
        help=(
            "Scope analysis to a single project. Accepts either a short "
            "project_id (e.g. 'agentera') or a path-like value whose final "
            "component matches a project_id (substring match either way). "
            "Default: cross-project analysis with a per-project breakdown."
        ),
    )
    args = parser.parse_args(argv)
    corpus = _read_corpus(args.corpus)
    analysis = analyze_corpus(corpus, project_filter=args.project)
    pprint(
        {
            "project_filter": analysis.project_filter,
            "skills": analysis.skills,
            "per_project": analysis.per_project,
            "invocations": [vars(inv) for inv in analysis.invocations],
        },
        stream=sys.stdout,
        sort_dicts=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
